import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { parseFinancialReports, parseJapanNews, parseYahooNews } from '../server/providers/international-content';
import { translationLink } from '../shared/translation';
import { createContentJobs, pruneMarketCache } from '../server/content-jobs';
import { createPool, migrate } from '../server/db';
import { buildApp } from '../server/app';
import { loadConfig } from '../server/config';
import { buildDigest } from '../server/jobs';
import type { Security, FinancialReport, NewsItem } from '../shared/types';
import type { SearchNews } from 'yahoo-finance2/modules/search';

const now = new Date('2026-09-13T01:00:00Z');
const us: Security = {id:'NASDAQ:AAPL',symbol:'AAPL',name:'Apple',market:'NASDAQ',currency:'USD',assetType:'stock',aliases:[],sourceUrl:'https://finance.yahoo.com/quote/AAPL/',active:true};
const jp: Security = {...us,id:'TSE:7203',symbol:'7203',name:'Toyota',market:'TSE',currency:'JPY',sourceUrl:'https://finance.yahoo.co.jp/quote/7203.T/news'};
const raw = (currency='USD', values: Record<string,number>={TotalRevenue:100,GrossProfit:0,OperatingIncome:10,DilutedEPS:0,TotalAssets:500,OperatingCashFlow:-20}) => ({timeseries:{result:Object.entries(values).map(([metric,value])=>({meta:{symbol:['AAPL'],type:[`quarterly${metric}`]},[`quarterly${metric}`]:[{asOfDate:'2026-06-30',periodType:'3M',currencyCode:currency,reportedValue:{raw:value}}]}))}});
const report = parseFinancialReports(raw(),us,'quarter',now).items[0];
const article: NewsItem = {id:'test-news',title:'Apple quarterly results',url:'https://finance.yahoo.com/news/example',publishedAt:now.toISOString(),source:'Example',kind:'news',securityIds:[us.id],matchType:'provider',language:'en'};
function japanHtml(code='7203.T',time='9/11') {
 const data = {priceBoard:{board:{codeWithMarketExtension:code}},newsTopics:{articles:[{headline:'トヨタのニュース',link:'/news/detail/abc123',createTime:time,mediaName:'Example',isPaidArticle:true}]}};
 return `<script>self.__next_f.push(${JSON.stringify([1,`a:${JSON.stringify(data)}\n`])})</script>`;
}
describe('financial statements, source news and translation boundaries',()=>{
 it.each([['quarter','quarterly','3M',24],['annual','annual','12M',10]] as const)('keeps all available %s periods beyond the former cap', (basis,prefix,periodType,count)=>{
  const points=Array.from({length:count},(_,i)=>({asOfDate:basis==='annual'?`${2016+i}-12-31`:`${2020+Math.floor(i/4)}-${['03-31','06-30','09-30','12-31'][i%4]}`,periodType,currencyCode:'USD',reportedValue:{raw:i}}));
  const data={timeseries:{result:[{meta:{symbol:['AAPL']},[`${prefix}TotalRevenue`]:points}]}};
  expect(parseFinancialReports(data,us,basis,now).items).toHaveLength(count);
 });
 it('preserves zero EPS and gross profit, negative cash flow and original reporting currency',()=>{
  const result=parseFinancialReports(raw('JPY'),us,'quarter',now);
  expect(result.items[0]).toMatchObject({currency:'JPY',eps:0,epsType:'diluted',grossProfit:0,grossMargin:0,operatingMargin:10,operatingCashFlow:-20,totalAssets:500,totalLiabilities:null});
 });
 it('rejects mixed currencies within one reporting period',()=>{
  const data=raw();const points=data.timeseries.result[1].quarterlyGrossProfit;if(Array.isArray(points))points[0].currencyCode='JPY';
  const result=parseFinancialReports(data,us,'quarter',now);expect(result.items).toEqual([]);expect(result.warnings.join('')).toContain('幣別');
 });
 it('does not mislabel an annual or future statement as a current quarter',()=>{
  const data=raw();for(const series of data.timeseries.result) for(const [key,points] of Object.entries(series))if(key.startsWith('quarterly')&&Array.isArray(points))points[0].periodType='12M';
  expect(parseFinancialReports(data,us,'quarter',now).items).toEqual([]);
  expect(parseFinancialReports(raw(),us,'quarter',new Date('2026-01-01'))).toMatchObject({items:[]});
 });
 it('rejects a different symbol without guessing from the trading currency',()=>{
  expect(()=>parseFinancialReports(raw(),jp,'quarter',now)).toThrow('標的');
 });
 it('requires an explicit provider ticker association for global news',()=>{
  const base={uuid:'1',title:'Headline',link:'https://finance.yahoo.com/news/item',publisher:'Example',providerPublishTime:now,type:'STORY'} as SearchNews;
  const result=parseYahooNews([{...base,relatedTickers:['MSFT']},{...base,uuid:'2',relatedTickers:['AAPL']}],us,now);
  expect(result).toHaveLength(1);expect(result[0]).toMatchObject({matchType:'provider',securityIds:[us.id]});
  expect(parseYahooNews([{...base,relatedTickers:['AAPL'],link:'javascript:alert(1)'}],us,now)).toEqual([]);
 });
 it('parses Japanese page data without inventing publication minutes or removing paid labels',()=>{
  expect(parseJapanNews(japanHtml(),jp,now).items[0]).toMatchObject({publishedDate:'2026-09-11',datePrecision:'day',language:'ja',paid:true,matchType:'provider'});
  expect(()=>parseJapanNews(japanHtml('6758.T'),jp,now)).toThrow('格式');
 });
 it('handles the Japanese news year boundary without treating old stories as this year',()=>{
  expect(parseJapanNews(japanHtml('7203.T','12/31'),jp,new Date('2026-01-02T02:00:00Z')).items[0].publishedDate).toBe('2025-12-31');
 });
 it('keeps translation opt-in links correctly encoded and rejects non-HTTPS sources',()=>{
  const url=new URL(translationLink('日文 & English?','zh-TW'));
  expect(url.searchParams.get('text')).toBe('日文 & English?');expect(url.searchParams.get('tl')).toBe('zh-TW');
  expect(new URL(translationLink(article.url,'en','website')).searchParams.get('u')).toBe(article.url);
  expect(()=>translationLink('javascript:alert(1)','ja','website')).toThrow();
 });
 it('uses the published Japanese date in digests and labels source association explicitly',()=>{
  const item=parseJapanNews(japanHtml(),jp,now).items[0];
  const digest=buildDigest({date:'2026-09-11',now,expectedDate:'2026-09-11',securities:[jp],quotes:[],financialUpdates:[],sourceWarnings:[],news:[item]});
  expect(digest.items.some(item=>item.title.startsWith('來源關聯新聞'))).toBe(true);
 });
});

describe('on-demand content, saved preferences and bounded public cache',()=>{
 const schema=`content_test_${randomUUID().replaceAll('-','')}`, admin=createPool(process.env.DATABASE_URL!);
 const url=new URL(process.env.DATABASE_URL!);url.searchParams.set('options',`-c search_path=${schema}`);const pool=createPool(url.href);
 const origin='http://127.0.0.1:3003';let app: Awaited<ReturnType<typeof buildApp>>;
 const headers={origin,'content-type':'application/json','x-person':'a'};
 const financials=vi.fn(async()=>({items:[report],warnings:[]})),news=vi.fn(async()=>({items:[article],warnings:[]}));
 const providers={fetchInternationalFinancials:financials,fetchInternationalNews:news};
 beforeAll(async()=>{await admin.query(`CREATE SCHEMA "${schema}"`);await migrate(pool);app=await buildApp({pool,config:loadConfig({APP_MODE:'development',DATABASE_URL:url.href,PUBLIC_ORIGIN:origin}),logger:false,yahooSearch:async()=>[us],verifyIdentity:async request=>({email:request.headers['x-person']==='a'?'a@example.invalid':'b@example.invalid',displayName:'Test',role:'member'})});});
 beforeEach(async()=>{await pool.query('TRUNCATE users,securities,news,source_runs CASCADE');financials.mockClear();news.mockClear();});
 afterAll(async()=>{await app?.close();await pool.end();if(!/^content_test_[a-f0-9]{32}$/.test(schema))throw new Error('Unsafe schema');await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();});
 const search=()=>app.inject({url:'/api/v1/finance/securities?region=US&q=AAPL',headers});
 const add=(person='a')=>app.inject({method:'PUT',url:'/api/v1/finance/watchlist/NASDAQ%3AAAPL',headers:{...headers,'x-person':person},payload:{held:false,interested:true,group:'Test'}});
 it('keeps search out of the database and calls content sources only after a saved selection',async()=>{
  expect((await search()).statusCode).toBe(200);
  expect(Number((await pool.query('SELECT count(*) FROM securities')).rows[0].count)).toBe(0);
  await createContentJobs(pool,providers).syncContent(now);expect(financials).not.toHaveBeenCalled();expect(news).not.toHaveBeenCalled();
  expect((await add()).statusCode).toBe(200);expect(financials).not.toHaveBeenCalled();
  await createContentJobs(pool,providers).syncContent(now);expect(financials).toHaveBeenCalledTimes(1);expect(news).toHaveBeenCalledTimes(1);
  expect((await app.inject({url:'/api/v1/finance/securities/NASDAQ%3AAAPL',headers})).json().financialReports[0].eps).toBe(0);
 });
 it('coalesces two users, concurrent workers and restart replays',async()=>{
  await search();await add();await add('b');
  await Promise.all([createContentJobs(pool,providers).syncContent(now),createContentJobs(pool,providers).syncContent(now)]);
  await createContentJobs(pool,providers).syncContent(now);
  expect(financials).toHaveBeenCalledTimes(1);expect(news).toHaveBeenCalledTimes(1);
 });
 it('retains earlier reports on errors and stops fetching after module disable',async()=>{
  await search();await add();await createContentJobs(pool,providers).syncContent(now);
  await createContentJobs(pool,{fetchInternationalFinancials:async()=>{throw new Error('failure');}}).syncContent(new Date(now.getTime()+86400000));
  expect(Number((await pool.query('SELECT count(*) FROM financial_reports')).rows[0].count)).toBe(1);
  await pool.query('UPDATE user_modules SET enabled=false');await createContentJobs(pool,providers).syncContent(new Date(now.getTime()+172800000));
  expect(financials).toHaveBeenCalledTimes(1);
 });
 it('does not announce unchanged statements as newly updated every day',async()=>{
  await search();await add();await createContentJobs(pool,providers).syncContent(now);
  await createContentJobs(pool,providers).syncContent(new Date(now.getTime()+86400000));
  const row=(await pool.query('SELECT observed_at,fetched_at FROM financial_reports')).rows[0];
  expect(new Date(row.observed_at).toISOString()).toBe(now.toISOString());expect(new Date(row.fetched_at).getTime()).toBe(now.getTime()+86400000);
 });
 it('persists translation preferences across devices without changing another account',async()=>{
  const initial=(await app.inject({url:'/api/v1/bootstrap',headers})).json().states[0];const {moduleId,...state}=initial;
  expect((await app.inject({method:'PUT',url:'/api/v1/modules/finance',headers,payload:{...state,config:{translationTarget:'ja'}}})).statusCode).toBe(200);
  expect((await app.inject({url:'/api/v1/bootstrap',headers})).json().states[0].config.translationTarget).toBe('ja');
  expect((await app.inject({url:'/api/v1/bootstrap'})).json().states[0].config.translationTarget).toBeUndefined();
 });
 it('preserves old tracked prices and financial archives while cleaning transient caches',async()=>{
  await search();await add();await createContentJobs(pool,providers).syncContent(now);
  await pool.query("INSERT INTO quotes(security_id,date,data,fetched_at) VALUES($1,'2024-01-01','{}','2024-01-01')",[us.id]);
  await pruneMarketCache(pool,now);
  expect(Number((await pool.query('SELECT count(*) FROM quotes')).rows[0].count)).toBe(1);
  expect(Number((await pool.query('SELECT count(*) FROM watchlist')).rows[0].count)).toBe(1);
  expect(Number((await pool.query('SELECT count(*) FROM financial_reports')).rows[0].count)).toBe(1);
  await pool.query("UPDATE financial_reports SET fetched_at='2024-01-01'");
  await pool.query('UPDATE user_modules SET enabled=false');await pruneMarketCache(pool,now);
  expect(Number((await pool.query('SELECT count(*) FROM quotes')).rows[0].count)).toBe(1);
  expect(Number((await pool.query('SELECT count(*) FROM financial_reports')).rows[0].count)).toBe(1);
  expect(Number((await pool.query('SELECT count(*) FROM watchlist')).rows[0].count)).toBe(1);
 });
 it('retains older archive periods when later source responses contain only recent statements',async()=>{
  await search();await add();
  const archive: FinancialReport[]=Array.from({length:10},(_,i)=>({...report,basis:'annual',periodEnd:`${2016+i}-12-31`}));
  archive.push(...Array.from({length:24},(_,i)=>({...report,periodEnd:`${2020+Math.floor(i/4)}-${['03-31','06-30','09-30','12-31'][i%4]}`})));
  await createContentJobs(pool,{fetchInternationalFinancials:async()=>({items:archive,warnings:[]})}).syncContent(now);
  await createContentJobs(pool,providers).syncContent(new Date(now.getTime()+86400000));
  await pruneMarketCache(pool,new Date(now.getTime()+86400000));
  const stored=(await app.inject({url:'/api/v1/finance/securities/NASDAQ%3AAAPL',headers})).json().financialReports;
  expect(stored).toHaveLength(35);
  expect(stored.some((r:FinancialReport)=>r.periodEnd==='2016-12-31')).toBe(true);
 });
});
