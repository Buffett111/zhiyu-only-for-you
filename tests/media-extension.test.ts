import 'dotenv/config';
import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import pg from 'pg';
import { buildApp } from '../server/app';
import { loadConfig } from '../server/config';
import { migrate } from '../server/db';
// Browser extension modules are plain JavaScript, executed unchanged in Chrome.
// @ts-expect-error no TypeScript declaration for the packaged extension module
import { mergeQueue,acknowledge,videoId } from '../extension/core.js';

const timestamp=new Date(Date.now()-86400000).toISOString();
const event={videoId:'abcdefghijk',title:'Synthetic lesson',channel:'Fixture channel',watchedAt:timestamp,actualSeconds:null as number|null,precision:'exact'};
describe('extension queue and YouTube HTML',()=>{
 it('accepts only YouTube video URLs and keeps newer playback updates during acknowledgements',()=>{
  expect(videoId('https://evil-youtube.com/watch?v=abcdefghijk')).toBeNull();expect(videoId('https://www.youtube.com/results?search_query=private')).toBeNull();expect(videoId('https://www.youtube.com/watch?v=abcdefghijk&list=private')).toBe('abcdefghijk');
  const before=mergeQueue([], [event]);const after=mergeQueue(before,[{...event,actualSeconds:45}]);expect(acknowledge(after,before)).toHaveLength(1);expect(mergeQueue(after,[{...event,actualSeconds:10}])[0].actualSeconds).toBe(45);expect(acknowledge(after,after)).toEqual([]);
 });
 it('does not request broad Chrome history permissions or arbitrary website access',async()=>{
  const manifest=JSON.parse(await readFile('extension/manifest.json','utf8'));expect(manifest.permissions).not.toContain('history');expect(manifest.optional_permissions).toBeUndefined();expect(manifest.optional_host_permissions).toEqual(['https://www.youtube.com/*','https://m.youtube.com/*']);expect(manifest.content_scripts[0].matches).toEqual(['https://zhiyu.example.invalid/extension-sync.html*']);expect(JSON.parse(await readFile('wrangler.jsonc','utf8')).assets.html_handling).toBe('none');
 });
 it('dynamically collects years of dated HTML and Shorts, and never treats a stalled continuation as completion',async()=>{
  const section=(day:string,id:string,short=false)=>`<ytd-item-section-renderer><h2 id="title">${day}</h2><${short?'ytm-shorts-lockup-view-model':'yt-lockup-view-model'}><h3><a href="https://www.youtube.com/${short?'shorts/'+id:'watch?v='+id}">Synthetic video</a></h3><a href="/@fixture">Fixture channel</a></${short?'ytm-shorts-lockup-view-model':'yt-lockup-view-model'}></ytd-item-section-renderer>`;
  const dom=new JSDOM(`<body>${section('2020年3月2日','abcdefghijk')}<ytd-continuation-item-renderer></ytd-continuation-item-renderer></body>`,{url:'https://www.youtube.com/feed/history',runScripts:'outside-only'});
  const w=dom.window as any;const calls:any[]=[];let finished=false;let pulse!:()=>void;
  w.setInterval=(fn:()=>void)=>{pulse=fn;return 1;};w.scrollTo=()=>{};w.HTMLElement.prototype.scrollIntoView=()=>{};
  w.chrome={runtime:{sendMessage:async(message:any)=>{calls.push(message);if(message.type==='history-done')finished=true;if(message.type==='capture-state')return {enabled:true,deviceId:'fixture',scan:finished?null:{id:'scan',full:true}};return {ok:true};}}};
  w.eval(await readFile('extension/history-dom.js','utf8'));w.eval(await readFile('extension/youtube.js','utf8'));
  const settle=()=>new Promise<void>(r=>setImmediate(r));await settle();
  for(let i=0;i<18;i++){pulse();await settle();}
  expect(calls.filter(c=>c.type==='history-done')).toHaveLength(0);
  w.document.querySelector('ytd-continuation-item-renderer').insertAdjacentHTML('beforebegin',section('2009年5月4日','bcdefghijkl',true));
  expect(w.zhiyuYoutubeHistory.collectProgress().map((e:any)=>e.videoId)).toEqual(['abcdefghijk','bcdefghijkl']);
  pulse();await settle();w.document.querySelector('ytd-continuation-item-renderer').remove();
  for(let i=0;i<16;i++){pulse();await settle();}
  const events=calls.filter(c=>c.type==='capture').flatMap(c=>c.events);expect(events).toHaveLength(2);expect(events[1]).toMatchObject({videoId:'bcdefghijkl',precision:'day',actualSeconds:null,watchedAt:'2009-05-04T04:00:00.000Z'});expect(calls.find(c=>c.type==='history-done')).toMatchObject({reason:'history-start',oldest:'2009-05-04'});dom.window.close();
 });
});

const schema=`zhiyu_extension_test_${randomUUID().replaceAll('-','')}`;
const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`});
let app:Awaited<ReturnType<typeof buildApp>>;
const headers={origin:'http://127.0.0.1:5173','content-type':'application/json'};
let binding:{deviceId:string;token:string;userId:string};
beforeAll(async()=>{await admin.query(`CREATE SCHEMA "${schema}"`);await migrate(pool);app=await buildApp({pool,config:loadConfig({APP_MODE:'development',DATABASE_URL:process.env.DATABASE_URL}),logger:false,verifyIdentity:async req=>({email:req.headers['x-person']==='b'?'bob@example.org':'alice@example.org',displayName:'Fixture',role:'member'})});});
afterAll(async()=>{await app?.close();await pool.end();if(!/^zhiyu_extension_test_[a-f0-9]{32}$/.test(schema))throw Error('Unsafe schema');await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();});
const enable=(extra={})=>app.inject({method:'PUT',url:'/api/v1/modules/media',headers:{...headers,...extra},payload:{enabled:true,configVersion:1,config:{},widgets:['overview']}});
const sync=(extra={},events=[event])=>app.inject({method:'POST',url:'/api/v1/media/extension/sync',headers:{...headers,...extra},payload:{deviceId:binding.deviceId,token:binding.token,events}});
describe('authenticated extension device binding',()=>{
 it('requires consent, enabled module and same-origin login; never lists device credentials',async()=>{
  expect((await app.inject({method:'POST',url:'/api/v1/media/devices',headers,payload:{confirm:true,label:'Fixture'}})).statusCode).toBe(409);
  await enable();expect((await app.inject({method:'POST',url:'/api/v1/media/devices',headers,payload:{label:'Fixture'}})).statusCode).toBe(400);
  const response=await app.inject({method:'POST',url:'/api/v1/media/devices',headers,payload:{confirm:true,label:'Fixture'}});expect(response.statusCode).toBe(200);binding=response.json();
  const list=await app.inject({url:'/api/v1/media/devices',headers});expect(list.body).not.toContain(binding.token);expect(list.body).not.toContain('token_hash');expect(list.headers['cache-control']).toContain('no-store');
  expect((await sync({origin:'https://www.youtube.com'})).statusCode).toBe(403);
 });
 it('rejects account switches, forged owner parameters and incorrect device tokens',async()=>{
  await enable({'x-person':'b'});expect((await sync({'x-person':'b'})).statusCode).toBe(403);
  const bad=await app.inject({method:'POST',url:'/api/v1/media/extension/sync',headers,payload:{deviceId:binding.deviceId,token:'0'.repeat(64),events:[event]}});expect(bad.statusCode).toBe(403);
  const forged=await app.inject({method:'POST',url:'/api/v1/media/extension/sync',headers,payload:{deviceId:binding.deviceId,token:binding.token,userId:'other',events:[event]}});expect(forged.statusCode).toBe(400);
  expect((await app.inject({method:'POST',url:`/api/v1/media/devices/${binding.deviceId}/revoke`,headers:{...headers,'x-person':'b'},payload:{confirm:true}})).statusCode).toBe(404);
 });
 it('deduplicates retried chunks, preserves maximum measured duration and does not grow import-file logs',async()=>{
  expect((await sync()).statusCode).toBe(200);expect((await sync()).json().inserted).toBe(0);
  await sync({},[{...event,actualSeconds:45} as typeof event]);await sync({},[{...event,actualSeconds:20} as typeof event]);
  const summary=(await app.inject({url:'/api/v1/media/summary?range=all',headers})).json();expect(summary).toMatchObject({total:1,recordedSeconds:45});expect(summary.imports).toHaveLength(0);
 });
 it('rejects late writes after device revocation and after clearing all media data',async()=>{
  expect((await app.inject({method:'POST',url:`/api/v1/media/devices/${binding.deviceId}/revoke`,headers,payload:{confirm:true}})).statusCode).toBe(200);expect((await sync()).statusCode).toBe(403);
  binding=(await app.inject({method:'POST',url:'/api/v1/media/devices',headers,payload:{confirm:true,label:'Fixture 2'}})).json();
  await app.inject({method:'POST',url:'/api/v1/media/clear',headers,payload:{confirm:true}});expect((await sync()).statusCode).toBe(403);expect((await app.inject({url:'/api/v1/media/summary?range=all',headers})).json().total).toBe(0);
 });
});
