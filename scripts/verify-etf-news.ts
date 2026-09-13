/** Public sources -> disposable schema -> API and responsive UI. No production account writes. */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { chromium, expect, type Browser } from '@playwright/test';
import { createPool, migrate } from '../server/db';
import { buildApp } from '../server/app';
import { loadConfig } from '../server/config';
import { createJobHandlers } from '../server/jobs';
import { fetchSecurityCatalog } from '../server/providers';
import type { NewsItem } from '../shared/types';
const schema = `etf_verify_${randomUUID().replaceAll('-','')}`;
const url = new URL(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '');
const admin = createPool(url.href);url.searchParams.set('options',`-c search_path=${schema}`);
const pool=createPool(url.href),base='http://127.0.0.1:3004';
let app:Awaited<ReturnType<typeof buildApp>>|undefined,browser:Browser|undefined,created=false;
const report:Record<string,unknown>={ok:false};
try {
 await admin.query(`CREATE SCHEMA "${schema}"`);created=true;await migrate(pool);
 const catalog=await fetchSecurityCatalog('TWSE');
 for(const s of catalog)await pool.query('INSERT INTO securities(id,symbol,name,market,asset_type,currency,aliases,source_url) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)',[s.id,s.symbol,s.name,s.market,s.assetType,s.currency,JSON.stringify(s.aliases),s.sourceUrl]);
 app=await buildApp({pool,config:loadConfig({APP_MODE:'development',DATABASE_URL:url.href,PUBLIC_ORIGIN:base,PORT:'3004'}),logger:false,verifyIdentity:async req=>({email:req.headers['x-person']==='b'?'etf-b@example.invalid':'etf-a@example.invalid',displayName:'ETF 驗證',role:'member'})});
 for(const symbol of ['0050','0056','006208'])assert.equal((await app.inject({method:'PUT',url:`/api/v1/finance/watchlist/TWSE%3A${symbol}`,headers:{origin:base,'content-type':'application/json'},payload:{held:false,interested:true,group:'ETF 驗證'}})).statusCode,200);
 report.source=await createJobHandlers(pool).syncNews();
 report.holdings=(await pool.query("SELECT security_id,data->>'asOf' AS date,jsonb_array_length(data->'holdings') AS count,error FROM etf_holdings ORDER BY security_id")).rows;
 const counts:Record<string,number>={};
 for(const scope of ['direct','constituent','market']) {
  const response: {statusCode:number;json<T>():T}=await app.inject({url:`/api/v1/finance/news?securityId=TWSE%3A0050&kind=news&scope=${scope}`});assert.equal(response.statusCode,200);
  const items=response.json<NewsItem[]>();counts[scope]=items.length;assert.ok(items.length>0,`0050 ${scope} news missing`);
  assert.ok(items.every(item=>item.relations?.some(r=>r.securityId==='TWSE:0050'&&r.kind===scope)));
 }
 const announcements=(await app.inject({url:'/api/v1/finance/news?securityId=TWSE%3A0050&kind=announcement&scope=direct'})).json<NewsItem[]>();assert.ok(announcements.length>0);counts.fundAnnouncements=announcements.length;report.counts=counts;
 assert.equal(Number((await pool.query('SELECT count(*) FROM watchlist')).rows[0].count),3);
 assert.equal(Number((await pool.query('SELECT count(*) FROM quotes')).rows[0].count),0);
 assert.equal((await app.inject({url:'/api/v1/finance/news',headers:{'x-person':'b'}})).json().length,0);
 assert.equal((await app.inject({url:'/api/v1/finance/news?scope=invalid'})).statusCode,400);
 if(process.argv.includes('--ui')) {
  await app.listen({host:'127.0.0.1',port:3004});browser=await chromium.launch({channel:'chrome',headless:true});const errors:string[]=[];
  await mkdir('.cache',{recursive:true});
  for(const width of [1440,390]) {
   const page=await browser.newPage({viewport:{width,height:1000}});page.on('pageerror',e=>errors.push(e.message));await page.goto(base);
   const card=page.locator('.news-card');await expect(card).toContainText('50 檔');
   for(const label of ['ETF 本身','成分股','市場背景']) {await page.getByRole('button',{name:label,exact:true}).click();await expect(card.locator('.news-entry').first()).toBeVisible();await expect(card).toContainText(label==='成分股'?'涉及':label);}
   await card.getByRole('button',{name:'重大訊息',exact:true}).click();await page.getByRole('button',{name:'ETF 本身',exact:true}).click();await expect(card).toContainText('基金公告');await expect(card).toContainText('元大投信');
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   await card.screenshot({path:`.cache/qa-etf-news-${width}.png`});await page.close();
  }
  assert.deepEqual(errors,[]);report.ui={desktop:1440,mobile:390,errors:0};
 }
 report.ok=true;
} catch(error) {report.error=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally {await browser?.close();await app?.close();await pool.end();if(created){assert.match(schema,/^etf_verify_[a-f0-9]{32}$/);await admin.query(`DROP SCHEMA "${schema}" CASCADE`);}await admin.end();report.cleanedUp=true;}
console.log(JSON.stringify(report,null,2));
