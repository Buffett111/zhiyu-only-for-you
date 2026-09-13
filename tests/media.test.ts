import 'dotenv/config';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { zipSync,strToU8 } from 'fflate';
import { parseMediaImport } from '../server/media/import';
import { classifyMediaTitles } from '../server/media/analysis';
import { buildApp } from '../server/app';
import { loadConfig } from '../server/config';
import { migrate } from '../server/db';
const watchedAt=new Date(Date.now()-86400000).toISOString();
const watch=(id='abcdefghijk',title='Watched A lesson')=>({title,titleUrl:`https://www.youtube.com/watch?v=${id}`,time:watchedAt,subtitles:[{name:'Learning Channel'}],products:['YouTube']});
const takeout=Buffer.from(JSON.stringify([watch(),watch(),watch('bcdefghijkl','已觀看 音樂分享')]));
const portable=()=>zipSync({
 'manifest.json':strToU8(JSON.stringify({format:'urtube-portable-export',formatVersion:1})),
 'account.json':strToU8(JSON.stringify({googleEmail:'excluded@example.org'})),
 'data/search-events.json':strToU8(JSON.stringify([{query:'private search not imported'}])),
 'data/watch-events.json':strToU8(JSON.stringify([{activity_id:'a',video_id:'abcdefghijk',raw_title:'A lesson',watched_at:watchedAt,channel_title:'Learning Channel',actual_watched_seconds:45}])),
 'data/activity-records.json':strToU8(JSON.stringify([{id:'a',occurred_precision:'exact'}])),
 'data/videos.json':strToU8(JSON.stringify([{video_id:'abcdefghijk',duration_seconds:7200}])),
 'data/personal-taxonomy-runs.json':strToU8(JSON.stringify([{taxonomy_version:1,status:'active'},{taxonomy_version:2,status:'candidate'}])),
 'data/personal-taxonomy.json':strToU8(JSON.stringify([{id:1,taxonomy_version:1,name:'知識'},{id:2,taxonomy_version:2,name:'不應採用'}])),
 'data/personal-topic-assignments.json':strToU8(JSON.stringify([{video_id:'abcdefghijk',topic_id:1,decision:'accepted'},{video_id:'abcdefghijk',topic_id:2,decision:'accepted'}]))
});
describe('urTube and Takeout interoperability',()=>{
 it('deduplicates exact watch events and supports localized titles without invented duration',()=>{
  const result=parseMediaImport(takeout);expect(result.events).toHaveLength(2);expect(result.skipped).toBe(1);expect(result.events[1].title).toBe('音樂分享');expect(result.events[0].actualSeconds).toBeNull();
  expect(parseMediaImport(Buffer.concat([Buffer.from('\uFEFF'),takeout])).events).toHaveLength(2);
 });
 it('imports active urTube classifications and measured duration while excluding unrelated private data',()=>{
  const result=parseMediaImport(portable());expect(result.events[0]).toMatchObject({actualSeconds:45,topics:['知識'],topicSource:'urTube'});expect(JSON.stringify(result)).not.toContain('excluded@example.org');expect(JSON.stringify(result)).not.toContain('private search');
 });
 it('parses Takeout HTML Taipei timestamps and blocks traversal ZIPs and unsupported versions',()=>{
  const html='<div class="outer-cell"><div class="content-cell">Watched <a href="https://www.youtube.com/watch?v=abcdefghijk">A lesson</a><br>2026年9月4日 晚上9:45:27 CST</div></div>';
  expect(parseMediaImport(Buffer.from(html)).events[0].watchedAt).toBe('2026-09-04T13:45:27.000Z');
  expect(()=>parseMediaImport(zipSync({'../watch-history.json':strToU8('[]')}))).toThrow('安全');
  expect(()=>parseMediaImport(zipSync({'manifest.json':strToU8('{"format":"urtube-portable-export","formatVersion":99}')}))).toThrow('版本');
  expect(()=>parseMediaImport(Buffer.from('[{"title":"Searched for private","time":"2026-09-04T10:00:00Z"}]'))).toThrow('觀看紀錄');
 });
 it('rejects AI IDs outside the input and sends only the supplied video descriptions',async()=>{
  const fetcher=vi.fn(async(_url:unknown,init:any)=>{
   const body=JSON.parse(init.body);expect(body).toMatchObject({model:'gpt-5.6-luna',store:false});expect(JSON.parse(body.input)).toEqual({videos:[{id:'abcdefghijk',title:'Lesson',channel:'Learning'}]});
   return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"videos":[{"id":"wrong","topics":["科技"]}]}'}]}]});
  });
  await expect(classifyMediaTitles('unit-test-key',[{id:'abcdefghijk',title:'Lesson',channel:'Learning'}],fetcher as typeof fetch)).rejects.toThrow('引用');
 });
});

const schema=`zhiyu_media_test_${randomUUID().replaceAll('-','')}`;
const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`});
const config=loadConfig({APP_MODE:'development',DATABASE_URL:process.env.DATABASE_URL,OPENAI_API_KEY:'unit-test-key',AI_DAILY_REQUEST_LIMIT:'2'});
const headers={origin:'http://127.0.0.1:5173','content-type':'application/json'};
const binary={...headers,'content-type':'application/octet-stream'};
const settings={enabled:true,configVersion:1,config:{},widgets:['overview','channels','topics','history']};
const classifier=vi.fn(async(_key:string,videos:{id:string;title:string;channel:string|null}[])=>({videos:videos.map(v=>({id:v.id,topics:['科技' as const]})),usage:{inputTokens:100,outputTokens:100}}));
let app:Awaited<ReturnType<typeof buildApp>>;
beforeAll(async()=>{await admin.query(`CREATE SCHEMA "${schema}"`);await migrate(pool);app=await buildApp({pool,config,logger:false,mediaClassifier:classifier,verifyIdentity:async request=>({email:request.headers['x-person']==='b'?'bob@example.org':'alice@example.org',displayName:'Fixture',role:'member'})});});
afterAll(async()=>{await app?.close();await pool.end();if(!/^zhiyu_media_test_[a-f0-9]{32}$/.test(schema))throw new Error('Unsafe schema');await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();});
describe('private media module on PostgreSQL',()=>{
 it('starts disabled, persists module order and restricts import origin',async()=>{
  expect((await app.inject({url:'/api/v1/media/summary',headers})).statusCode).toBe(409);
  const enabled=await app.inject({method:'PUT',url:'/api/v1/modules/media',headers,payload:settings});expect(enabled.statusCode).toBe(200);expect(enabled.json().widgets).toEqual(settings.widgets);
  const bad=await app.inject({method:'POST',url:'/api/v1/media/import',headers:{...binary,origin:'https://evil.example'},payload:takeout});expect(bad.statusCode).toBe(403);
 });
 it('merges repeated sources, preserves classification, and reports measured time only',async()=>{
  const first=await app.inject({method:'POST',url:'/api/v1/media/import',headers:binary,payload:takeout});expect(first.statusCode,first.body).toBe(200);expect(first.json().inserted).toBe(2);
  expect((await app.inject({method:'POST',url:'/api/v1/media/import',headers:binary,payload:takeout})).json().repeated).toBe(true);
  expect((await app.inject({method:'POST',url:'/api/v1/media/import',headers:binary,payload:Buffer.from(portable())})).statusCode).toBe(200);
  const summary=(await app.inject({url:'/api/v1/media/summary?range=all',headers})).json();expect(summary).toMatchObject({total:2,selected:2,recordedSeconds:45,timedEvents:1,classifiedEvents:1});expect(summary.topics[0].name).toBe('知識');
 });
 it('isolates a second user even with forged user parameters and exports a reimportable archive',async()=>{
  await app.inject({method:'PUT',url:'/api/v1/modules/media',headers:{...headers,'x-person':'b'},payload:settings});
  expect((await app.inject({url:'/api/v1/media/summary?range=all&userId=alice',headers:{...headers,'x-person':'b'}})).json().total).toBe(0);
  expect((await app.inject({url:'/api/v1/media/history?range=all',headers:{...headers,'x-person':'b'}})).json().items).toEqual([]);
  const exported=await app.inject({url:'/api/v1/media/export',headers});expect(exported.statusCode,exported.body).toBe(200);expect(exported.headers['cache-control']).toContain('no-store');expect(parseMediaImport(Buffer.from(exported.body)).events).toHaveLength(2);
 });
 it('classifies only pending titles, saves results and preserves imported topics',async()=>{
  const result=await app.inject({method:'POST',url:'/api/v1/media/classify',headers,payload:{confirm:true}});expect(result.statusCode,result.body).toBe(200);expect(result.json().classified).toBe(1);
  expect(classifier.mock.calls[0][1]).toEqual([{id:'bcdefghijkl',title:'音樂分享',channel:'Learning Channel'}]);
  const summary=(await app.inject({url:'/api/v1/media/summary?range=all',headers})).json();expect(summary.classifiedEvents).toBe(2);expect(summary.topics.map((t:any)=>t.name).sort()).toEqual(['知識','科技']);
 });
 it('clears only own data and does not let a late AI response recreate deleted records',async()=>{
  const alice=(await app.inject({url:'/api/v1/me',headers})).json();
  await pool.query('DELETE FROM media_ai_state WHERE user_id=$1',[alice.id]);await pool.query("UPDATE media_events SET topics='[]',topic_source=NULL WHERE user_id=$1",[alice.id]);
  let release!:()=>void;let entered!:()=>void;const reached=new Promise<void>(r=>entered=r);const paused=new Promise<void>(r=>release=r);
  classifier.mockImplementationOnce(async(_key,videos)=>{entered();await paused;return {videos:videos.map(v=>({id:v.id,topics:['科技' as const]})),usage:{inputTokens:100,outputTokens:100}};});
  const pending=app.inject({method:'POST',url:'/api/v1/media/classify',headers,payload:{confirm:true}}).then(r=>r);await reached;
  const cleared=await app.inject({method:'POST',url:'/api/v1/media/clear',headers,payload:{confirm:true}});expect(cleared.statusCode).toBe(200);release();expect((await pending).statusCode).toBe(424);
  expect((await pool.query('SELECT count(*)::int count FROM media_classifications WHERE user_id=$1',[alice.id])).rows[0].count).toBe(0);
  expect((await app.inject({url:'/api/v1/media/summary?range=all',headers})).json().total).toBe(0);
 });
 it('exports bounded reimportable parts without crossing account boundaries',async()=>{
  const bob=(await app.inject({url:'/api/v1/me',headers:{...headers,'x-person':'b'}})).json();
  await pool.query("INSERT INTO media_events(user_id,event_id,video_id,title,watched_at,source) SELECT $1,'partition-'||n,'abcdefghijk','Synthetic archive',now()-make_interval(secs=>n),'fixture' FROM generate_series(1,5001) n",[bob.id]);
  const part1=await app.inject({url:'/api/v1/media/export?part=1',headers:{...headers,'x-person':'b'}});
  const part2=await app.inject({url:'/api/v1/media/export?part=2',headers:{...headers,'x-person':'b'}});
  expect(parseMediaImport(Buffer.from(part1.body)).events).toHaveLength(5000);expect(parseMediaImport(Buffer.from(part2.body)).events).toHaveLength(1);
  expect((await app.inject({url:'/api/v1/media/export?part=0',headers})).statusCode).toBe(400);
  expect((await app.inject({url:'/api/v1/media/export?part=1',headers})).json().events).toEqual([]);
 });

});
