import 'dotenv/config';
import { beforeAll,afterAll,describe,it,expect,vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../server/db';
import { buildApp } from '../server/app';
import { loadConfig } from '../server/config';
import { importMedia } from '../server/media/service';
import { fetchVideoAuthor,enrichMediaMetadata,youtubeChannelUrl } from '../server/media/metadata';
import { channelOverview,classifyChannels,setChannelAutomation,generateChannelLabels } from '../server/media/channels';
import { loadContentTags } from '../server/media/channel-tags';
vi.mock('../server/media/channel-tags',async original=>({...await original<typeof import('../server/media/channel-tags')>(),contentTags:async()=>null}));
const schema=`zhiyu_channels_test_${randomUUID().replaceAll('-','')}`;
const admin=new pg.Pool({connectionString:process.env.DATABASE_URL}),pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`});
const config=loadConfig({APP_MODE:'development',DATABASE_URL:process.env.DATABASE_URL,OPENAI_API_KEY:'fixture-not-a-real-key'});
let app:Awaited<ReturnType<typeof buildApp>>,alice:string,bob:string;
const channelUrl='https://www.youtube.com/channel/UC'+'a'.repeat(22);
const headers={origin:'http://127.0.0.1:5173','content-type':'application/json'};
beforeAll(async()=>{await admin.query(`CREATE SCHEMA "${schema}"`);await migrate(pool);app=await buildApp({pool,config,logger:false,verifyIdentity:async req=>({email:req.headers['x-person']==='b'?'bob@example.org':'alice@example.org',displayName:'Fixture',role:'member'})});
 for(const who of ['a','b'])await app.inject({method:'PUT',url:'/api/v1/modules/media',headers:{...headers,'x-person':who},payload:{enabled:true,configVersion:1,config:{},widgets:['channels']}});
 alice=(await pool.query("SELECT id FROM users WHERE email='alice@example.org'")).rows[0].id;bob=(await pool.query("SELECT id FROM users WHERE email='bob@example.org'")).rows[0].id;
});
afterAll(async()=>{await app?.close();await pool.end();if(!/^zhiyu_channels_test_[a-f0-9]{32}$/.test(schema))throw Error('Unsafe schema');await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();});
const fixture=(ids:string[])=>Buffer.from(JSON.stringify({format:'zhiyu-media-export',version:1,events:ids.map((id,i)=>({videoId:id,title:'Synthetic programming lesson '+i,channel:null,watchedAt:new Date(Date.now()-(i+1)*86400000).toISOString(),actualSeconds:null,precision:'day'}))}));
describe('public metadata and inspectable channel classification',()=>{
 it('accepts only canonical YouTube author URLs and distinguishes unavailable from transient errors',async()=>{
  expect(youtubeChannelUrl('https://evil.example/@fixture')).toBeNull();expect(youtubeChannelUrl('https://www.youtube.com/@fixture?tracking=1')).toBe('https://www.youtube.com/@fixture');
  expect(await fetchVideoAuthor('abcdefghijk',async()=>new Response('',{status:404}))).toMatchObject({status:'unavailable'});
  await expect(fetchVideoAuthor('abcdefghijk',async()=>new Response('',{status:429}))).rejects.toThrow();
  await expect(fetchVideoAuthor('abcdefghijk',async()=>Response.json({title:'Fixture',author_name:'Fixture',author_url:'https://evil.example/@fixture'}))).rejects.toThrow();
 });
 it('requires verified source timestamps and joins the urTube curator by IDs or handles, not names',async()=>{
  const calls:string[]=[];const data=await loadContentTags(async input=>{calls.push(String(input));return Response.json({time:'2026-09-13 12:00:00',result:[{youtube_id:'UC'+'a'.repeat(22),customUrl:'@fixture',title:'Irrelevant display name'}]});});
  expect(calls).toHaveLength(3);expect(calls.every(s=>!s.includes('user'))).toBe(true);expect(data.groups[0].keys.has('/@fixture')).toBe(true);
  await expect(loadContentTags(async()=>Response.json({result:[]}))).rejects.toThrow();
 });
 it('resolves handle authors to stable channel IDs from public metadata',async()=>{
  const request=vi.fn(async(url:any)=>String(url).includes('/oembed?')?Response.json({title:'Public fixture',author_name:'Author',author_url:'https://www.youtube.com/@fixture'}):new Response('<meta itemprop="identifier" content="UC'+'a'.repeat(22)+'">'));
  expect((await fetchVideoAuthor('abcdefghijk',request)).channelKey).toBe(channelUrl);expect(request).toHaveBeenCalledTimes(2);
 });
 it('repairs saved channel names, caches verified metadata and keeps another account isolated',async()=>{
  await importMedia(pool,alice,fixture(['abcdefghijk','bcdefghijkl']));await importMedia(pool,bob,fixture(['abcdefghijk']));
  const get=vi.fn(async()=>({status:'ready' as const,title:'Synthetic programming lesson',channel:'Fixture author',channelKey:channelUrl}));
  expect(await enrichMediaMetadata(pool,alice,get)).toMatchObject({ready:2});await enrichMediaMetadata(pool,alice,get);expect(get).toHaveBeenCalledTimes(2);
  const a=await channelOverview(pool,alice,'all');expect(a).toMatchObject({identified:2,totalChannels:1,metadata:{ready:2}});expect(a.items[0].name).toBe('Fixture author');
  const b=await channelOverview(pool,bob,'all');expect(b.identified).toBe(0);expect(b.metadata.ready).toBe(0);
  expect((await app.inject({url:'/api/v1/media/channel?range=all&key='+encodeURIComponent(channelUrl),headers:{'x-person':'b'}})).statusCode).toBe(404);
 });
 it('downgrades invented evidence or low confidence to unknown; prompts contain no account or watch times',async()=>{
  const samples=[{key:channelUrl,name:'Fixture',videos:[{id:'abcdefghijk',title:'Synthetic programming lesson'}]}];
  const request=vi.fn(async(_u:any,init:any)=>{expect(init.body).not.toContain('watchedAt');expect(init.body).not.toContain('alice');return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({channels:[{key:samples[0].key,category:'科技' as const,confidence:.99,evidence:[{id:'abcdefghijk',quote:'not in title'}]}]})}]}]});});
  const r=await generateChannelLabels('fixture',samples,request);expect(r.channels[0]).toMatchObject({category:'無法判斷',evidence:[]});
 });
 it('requires opt-in, saves suggestions and corrections, restores originals, and denies other users writes',async()=>{
  const get=vi.fn(async(_key:string,samples:any[])=>({channels:samples.map(s=>({key:s.key,category:'科技' as const,confidence:.8,evidence:[{id:s.videos[0].id,title:s.videos[0].title,quote:'programming'}]})),usage:{inputTokens:100,outputTokens:30}}));
  expect(await classifyChannels(pool,config,alice,get)).toBe(0);expect(get).not.toHaveBeenCalled();await setChannelAutomation(pool,alice,true);
  expect(await classifyChannels(pool,config,alice,get)).toBe(1);expect(await classifyChannels(pool,config,alice,get)).toBe(0);expect(get).toHaveBeenCalledTimes(1);
  const key=channelUrl;expect((await channelOverview(pool,alice,'all','','科技')).items).toHaveLength(1);
  expect((await app.inject({method:'PUT',url:'/api/v1/media/channel-category',headers:{...headers,'x-person':'b'},payload:{key,category:'知識與教育'}})).statusCode).toBe(404);
  await app.inject({method:'PUT',url:'/api/v1/media/channel-category',headers,payload:{key,category:'知識與教育'}});expect((await channelOverview(pool,alice,'all')).items[0]).toMatchObject({category:'知識與教育',reviewed:true});
  await app.inject({method:'PUT',url:'/api/v1/media/channel-category',headers,payload:{key,category:null}});expect((await channelOverview(pool,alice,'all')).items[0]).toMatchObject({category:'科技',reviewed:false});
 });
 it('honors daily batch limits and drops in-flight suggestions after consent is withdrawn',async()=>{
  await enrichMediaMetadata(pool,bob,async()=>({status:'ready',title:'Fixture programming',channel:'Fixture',channelKey:'https://www.youtube.com/channel/UC'+'b'.repeat(22)}));await setChannelAutomation(pool,bob,true);
  await pool.query("UPDATE media_processing SET daily_batches=8,usage_day=(now() AT TIME ZONE 'Asia/Taipei')::date WHERE user_id=$1",[bob]);const unused=vi.fn();expect(await classifyChannels(pool,config,bob,unused)).toBe(0);expect(unused).not.toHaveBeenCalled();
  await pool.query('UPDATE media_processing SET daily_batches=0 WHERE user_id=$1',[bob]);
  await classifyChannels(pool,config,bob,async(_key,samples)=>{await setChannelAutomation(pool,bob,false);return {channels:samples.map(s=>({key:s.key,category:'科技' as const,confidence:.9,evidence:[]})),usage:{inputTokens:1,outputTokens:1}};});
  expect((await channelOverview(pool,bob,'all')).categorized).toBe(0);
 });
 it('clear removes metadata and classifications and prevents a late public lookup from recreating deleted history',async()=>{
  await pool.query("UPDATE media_video_metadata SET retry_after=now()-interval '1 hour' WHERE user_id=$1",[alice]);
  await enrichMediaMetadata(pool,alice,async()=>{await app.inject({method:'POST',url:'/api/v1/media/clear',headers,payload:{confirm:true}});return {status:'ready',title:'Fixture',channel:'Fixture',channelKey:channelUrl};});
  const a=await channelOverview(pool,alice,'all');expect(a.selected).toBe(0);expect(a.metadata.total).toBe(0);expect((await pool.query('SELECT 1 FROM media_video_metadata WHERE user_id=$1',[alice])).rowCount).toBe(0);expect(a.processing.autoClassify).toBe(false);
 });
});
