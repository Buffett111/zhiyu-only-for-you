import { describe, expect, it } from 'vitest';
import { parseStaticState } from '../server/providers/static-state';
import { mergeNews, parseGoogleNews, parseYuantaAnnouncements, parseYuantaHoldings, relateEtfNews } from '../server/providers/etf-news';
import { matchSecurities } from '../server/providers/parsers';
import type { EtfHoldings, NewsItem, Security } from '../shared/types';
const etf: Security = {id:'TWSE:0050',symbol:'0050',name:'元大台灣50',market:'TWSE',currency:'TWD',assetType:'etf',aliases:['元大台灣卓越50證券投資信託基金'],sourceUrl:''};
const company: Security = {...etf,id:'TWSE:2330',symbol:'2330',name:'台積電',aliases:['台積電'],assetType:'stock'};
const holdings: EtfHoldings = {securityId:etf.id,asOf:'2026-09-11',sourceUrl:'https://www.yuantaetfs.com/product/detail/0050/ratio',aliases:[],holdings:[{symbol:'2330',name:'台積電',weight:57}]};
const news: NewsItem = {id:'one',title:'台積電公布重大訊息',url:'https://example.org/story',publishedAt:'2026-09-12T00:00:00Z',source:'test',kind:'announcement',securityIds:[company.id],matchType:'exact'};
const page = (value: object) => `<script>window.__NUXT__=(function(){return ${JSON.stringify(value)}}());</script>`;
describe('ETF news and official holdings',()=>{
 it('associates a constituent announcement without calling it the fund announcement',()=>{
  const result=relateEtfNews(news,[etf],[holdings],[company]);
  expect(result.securityIds).toEqual([company.id,etf.id]);
  expect(result.relations).toEqual([{securityId:etf.id,kind:'constituent',via:[{id:company.id,name:company.name}],holdingsDate:holdings.asOf,holdingsSource:holdings.sourceUrl}]);
  expect(relateEtfNews(news,[etf],[],[company]).securityIds).not.toContain(etf.id);
 });
 it('labels market context only for the relevant exposure and never for an announcement',()=>{
  const us={...etf,id:'TWSE:00924',symbol:'00924'};
  const item={...news,title:'台股加權指數上漲',kind:'news' as const,securityIds:[],matchType:'market' as const};
  expect(relateEtfNews(item,[etf,us],[],[]).relations).toEqual([{securityId:etf.id,kind:'market'}]);
  expect(relateEtfNews({...item,kind:'announcement'},[etf],[],[]).relations).toEqual([]);
  expect(relateEtfNews({...item,title:'雞蛋與食品安全'},[etf],[],[]).securityIds).toEqual([]);
 });
 it('matches ETF codes without losing leading zeros or colliding with extended codes',()=>{
  expect(matchSecurities('0050 與元大臺灣50',[etf])).toEqual([etf.id]);
  expect(matchSecurities('00500 與 10050',[etf])).toEqual([]);
 });
 it('validates the complete holding list and requested fund identity',()=>{
  const data={data:[{fundData:{STK_CD:'0050',FUND_ID:'1066',FUND_NAME:etf.aliases[0]}},{weightData:{PCF:{fundid:'1066',trandate:'20260911'},FundWeights:{StockWeights:Array.from({length:50},(_,i)=>({code:String(2300+i),name:'公司'+i,weights:2}))}}}]};
  expect(parseYuantaHoldings(page(data),etf).holdings).toHaveLength(50);
  expect(()=>parseYuantaHoldings(page(data),{...etf,symbol:'0056'})).toThrow();
 });
 it('reads literal state and local table assignments but rejects executable payloads',()=>{
  expect(parseStaticState('<script>window.__NUXT__=(function(a,b){a[0]={name:b};return {data:a}}(Array(1),"test"));</script>').data[0].name).toBe('test');
  for(const code of ['(function(){return fetch("https://example.org")}())','(function(a){a.__proto__={polluted:true};return a}({}))','(function(){return {x:(()=>1)()}}())']) expect(()=>parseStaticState(`<script>window.__NUXT__=${code};</script>`)).toThrow();
  expect(({} as any).polluted).toBeUndefined();
 });
 it('keeps dates and original issuer links, excluding older unrelated announcements',()=>{
  const rows=[{AnnouncementId:'11111111-1111-1111-1111-111111111111',AnnouncementTitle:etf.aliases[0]+'配息',AnnouncementDisplayDate:'2026/07/17'}, {AnnouncementId:'22222222-2222-2222-2222-222222222222',AnnouncementTitle:'其他基金',AnnouncementDisplayDate:'2026/09/11'}];
  const items=parseYuantaAnnouncements(page({data:[{newsList:[{Announcement:rows}]}]}),[etf],new Date('2026-09-13'));
  expect(items).toHaveLength(1);expect(items[0]).toMatchObject({datePrecision:'day',publishedDate:'2026-07-17',source:'元大投信',securityIds:[etf.id]});
  expect(items[0].url).toContain('/news/announcement/11111111');
 });
 it('uses publisher attribution, strips content and rejects unsafe RSS links',()=>{
  const xml='<rss><channel><item><title>0050 配息 - 媒體</title><link>https://news.google.com/rss/articles/abc</link><pubDate>Sat, 12 Sep 2026 08:30:01 +0800</pubDate><source url="https://example.org">媒體</source><description>不要保存全文</description></item><item><title>0050</title><link>javascript:alert(1)</link><pubDate>Sat, 12 Sep 2026 08:30:01 +0800</pubDate></item></channel></rss>';
  const items=parseGoogleNews(xml,[etf],new Date('2026-09-13'));expect(items).toHaveLength(1);expect(items[0].source).toBe('媒體（Google News）');expect(JSON.stringify(items)).not.toContain('不要保存全文');
  expect(parseGoogleNews(xml.replace('0050 配息 - 媒體','0050 明天會漲嗎？ - 股市爆料同學會'),[etf],new Date('2026-09-13'))).toEqual([]);
 });
 it('preserves associations when shared articles are refreshed for another account',()=>{
  const linked=relateEtfNews(news,[etf],[holdings],[company]);const merged=mergeNews(linked,news);
  expect(merged.securityIds).toContain(etf.id);expect(merged.relations?.[0].kind).toBe('constituent');
 });
});
