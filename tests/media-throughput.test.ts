import 'dotenv/config';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {migrate} from '../server/db';
import {loadConfig} from '../server/config';
import {classifyChannels,setChannelAutomation,channelOverview,generateChannelLabels} from '../server/media/channels';
import {analyzeMedia} from '../server/media/analysis';
import {fetchChannelIcon,enrichChannelIcons,youtubeIconUrl} from '../server/media/icons';
import {MediaRateLimit,checkRateLimit} from '../server/media/ai-batches';
import {enrichMediaMetadata,YoutubeMetadataRateLimit} from '../server/media/metadata';
vi.mock('../server/media/channel-tags',async original=>({...await original<typeof import('../server/media/channel-tags')>(),contentTags:async()=>null}));
const schema=`zhiyu_throughput_test_${randomUUID().replaceAll('-','')}`;
const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`});
const config=loadConfig({APP_MODE:'development',DATABASE_URL:process.env.DATABASE_URL,OPENAI_API_KEY:'synthetic-key',AI_DAILY_REQUEST_LIMIT:'1000',MEDIA_CHANNEL_BATCH_SIZE:'2',MEDIA_VIDEO_BATCH_SIZE:'2',MEDIA_AI_CONCURRENCY:'3'});
beforeAll(async()=>{await admin.query(`CREATE SCHEMA "${schema}"`);await migrate(pool);});
afterAll(async()=>{await pool.end();if(!/^zhiyu_throughput_test_[a-f0-9]{32}$/.test(schema))throw Error('Unsafe schema');await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();});
const publicKey=(n:number)=>'https://www.youtube.com/channel/UC'+String(n).padStart(22,'a');
async function owner(count=7){
 const id=randomUUID();await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Fixture')",[id,`${id}@example.org`]);
 await pool.query("INSERT INTO user_modules(user_id,module_id) VALUES($1,'media')",[id]);
 for(let n=0;n<count;n++){
  const video=String(n).padStart(11,'v');
  await pool.query("INSERT INTO media_events(user_id,event_id,video_id,title,watched_at,source) VALUES($1,$2,$2,'Synthetic lesson',now()-interval '1 day','fixture')",[id,video]);
  await pool.query("INSERT INTO media_video_metadata(user_id,video_id,title,channel,channel_key,status) VALUES($1,$2,'Synthetic lesson','Fixture',$3,'ready')",[id,video,publicKey(n)]);
 }await setChannelAutomation(pool,id,true);return id;
}
const result=(samples:any[])=>({channels:samples.map(s=>({key:s.key,category:'科技' as const,confidence:.9,evidence:[]})),usage:{inputTokens:10,outputTokens:5}});
it('runs disjoint channel batches concurrently, excludes an overlapping wave, and saves successful peers',async()=>{
 const id=await owner();let release!:()=>void,entered!:()=>void;
 const barrier=new Promise<void>(r=>release=r),reached=new Promise<void>(r=>entered=r);let active=0,peak=0;
 const seen:string[]=[];const generate=vi.fn(async(_key:string,samples:any[])=>{
  active++;peak=Math.max(peak,active);seen.push(...samples.map(s=>s.key));if(active===3)entered();
  await barrier;active--;if(samples.some(s=>s.key===publicKey(2)))throw new MediaRateLimit(120);return result(samples);
 });
 const wave=classifyChannels(pool,config,id,generate);await reached;
 expect(await classifyChannels(pool,config,id,generate)).toBe(0);expect(peak).toBe(3);expect(new Set(seen).size).toBe(6);
 const state=(await channelOverview(pool,id,'all','','',0,'count',config)).processing;expect(state).toMatchObject({activeBatches:3,batchSize:2,concurrency:3,dailyBatches:3});
 release();expect(await wave).toBe(4);expect(generate).toHaveBeenCalledTimes(3);
 expect(await classifyChannels(pool,config,id,generate)).toBe(0); // persisted Retry-After
 await pool.query('UPDATE media_processing SET retry_after=now()-interval \'1 second\' WHERE user_id=$1',[id]);
 const retried:string[]=[];expect(await classifyChannels(pool,config,id,async(_key,samples)=>{retried.push(...samples.map(s=>s.key));return result(samples);})).toBe(3);
 expect(retried.sort()).toEqual([publicKey(2),publicKey(3),publicKey(6)].sort());
});
it('reserves partial capacity atomically across users and enforces per-user daily batch caps',async()=>{
 const [a,b]=await Promise.all([owner(),owner()]);
 const used=Number((await pool.query('SELECT sum(requests)::int n FROM ai_daily_usage')).rows[0].n);
 const generate=vi.fn(async(_key:string,samples:any[])=>result(samples));
 const totals=await Promise.all([classifyChannels(pool,{...config,aiDailyLimit:used+2},a,generate),classifyChannels(pool,{...config,aiDailyLimit:used+2},b,generate)]);
 expect(totals.reduce((a,b)=>a+b,0)).toBe(4);expect(generate).toHaveBeenCalledTimes(2);
 const c=await owner();const limited={...config,mediaAiDailyBatches:1};
 expect(await classifyChannels(pool,limited,c,generate)).toBe(2);expect(await classifyChannels(pool,limited,c,generate)).toBe(0);
});
it('withdrawal invalidates every in-flight batch while accounting for consumed tokens',async()=>{
 const id=await owner(6);let release!:()=>void,entered!:()=>void,calls=0;
 const barrier=new Promise<void>(r=>release=r),reached=new Promise<void>(r=>entered=r);
 const wave=classifyChannels(pool,config,id,async(_key,samples)=>{if(++calls===3)entered();await barrier;return result(samples);});await reached;
 await setChannelAutomation(pool,id,false);release();expect(await wave).toBe(0);
 expect((await pool.query('SELECT 1 FROM media_channel_labels WHERE user_id=$1',[id])).rowCount).toBe(0);
});
it('recovers a stale wave after restart without reclassifying saved channels',async()=>{
 const id=await owner(4);
 await pool.query("UPDATE media_processing SET status='pending',last_attempt=now()-interval '11 minutes' WHERE user_id=$1",[id]);
 expect(await classifyChannels(pool,config,id,async(_key,samples)=>result(samples))).toBe(4);
 expect(await classifyChannels(pool,config,id,vi.fn())).toBe(0);
});
it('parallelizes video classification and preserves successful batches when another fails',async()=>{
 const id=await owner(6);let entered!:()=>void,release!:()=>void,calls=0;
 const barrier=new Promise<void>(r=>release=r),reached=new Promise<void>(r=>entered=r);
 const wave=analyzeMedia(pool,config,id,async(_key,videos)=>{
  const n=++calls;if(calls===3)entered();await barrier;if(n===2)throw Error('fixture transient failure');
  return {videos:videos.map(v=>({id:v.id,topics:['科技' as const]})),usage:{inputTokens:20,outputTokens:10}};
 });await reached;
 await expect(analyzeMedia(pool,config,id,vi.fn())).rejects.toThrow('仍在處理');release();
 expect(await wave).toMatchObject({classified:4,failedBatches:1,usage:{inputTokens:40,outputTokens:20}});
 expect((await pool.query('SELECT 1 FROM media_classifications WHERE user_id=$1',[id])).rowCount).toBe(4);
});
it('scales output allowance for a larger batch and respects provider Retry-After without immediate replay',async()=>{
 const samples=Array.from({length:32},(_,n)=>({key:publicKey(n),name:'Fixture',videos:[{id:'abcdefghijk',title:'Synthetic lesson'}]}));
 const request=vi.fn(async(_url:any,init:any)=>{
  expect(JSON.parse(init.body).max_output_tokens).toBeGreaterThanOrEqual(10000);
  return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(result(samples))}]}]});
 });
 // strict output excludes the helper's accounting field
 request.mockImplementationOnce(async(_url,init)=>{expect(JSON.parse(init.body).max_output_tokens).toBe(12800);return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({channels:result(samples).channels})}]}]});});
 expect((await generateChannelLabels('fixture',samples,request)).channels).toHaveLength(32);
 expect(()=>checkRateLimit(new Response('',{status:429,headers:{'retry-after':'120'}}))).toThrow(MediaRateLimit);
});
it('fetches only public YouTube icons, bounds URLs, and accepts metadata with escaped query strings',async()=>{
 const request=vi.fn(async(_url:any,init:any)=>{expect(init.redirect).toBe('error');expect(init.headers).toBeUndefined();return new Response('<head><meta property="og:image" content="https://yt3.googleusercontent.com/fixture=s88?a=1&amp;b=2"></head>');});
 expect(await fetchChannelIcon(publicKey(1),request)).toBe('https://yt3.googleusercontent.com/fixture=s88?a=1&b=2');
 expect(youtubeIconUrl('https://yt3.ggpht.com.evil.example/x')).toBeNull();expect(youtubeIconUrl('http://yt3.ggpht.com/x')).toBeNull();
 await expect(fetchChannelIcon('https://evil.example/channel',request)).rejects.toThrow();expect(request).toHaveBeenCalledTimes(1);
});
it('finds channel icons after head and across streamed chunks',async()=>{
 const parts=['<head></head><body>'+'x'.repeat(10000),'<meta property="og:','image" content="https://yt3.ggpht.com/fixture=s900-c-k">'];
 const request=async()=>new Response(new ReadableStream({pull(controller){const part=parts.shift();if(part)controller.enqueue(new TextEncoder().encode(part));else controller.close();}}));
 expect(await fetchChannelIcon(publicKey(1),request)).toBe('https://yt3.ggpht.com/fixture=s88-c-k');
});
it('caches icons per saved channel, retries transient failures and never recreates cleared history',async()=>{
 const id=await owner(2),other=await owner(1);let calls=0;
 const get=vi.fn(async()=>{if(++calls===1)throw Error('transient');return 'https://yt3.ggpht.com/fixture=s88';});
 expect(await enrichChannelIcons(pool,id,get)).toEqual({ready:1,errors:1});await enrichChannelIcons(pool,id,get);expect(get).toHaveBeenCalledTimes(2);
 expect((await channelOverview(pool,id,'all')).items.filter(c=>c.iconUrl)).toHaveLength(1);
 expect((await channelOverview(pool,other,'all')).items[0].iconUrl).toBeNull();
 await pool.query("UPDATE media_channel_icons SET retry_after=now()-interval '1 second' WHERE user_id=$1",[id]);
 await enrichChannelIcons(pool,id,async()=>{await pool.query('DELETE FROM media_events WHERE user_id=$1',[id]);await pool.query('DELETE FROM media_channel_icons WHERE user_id=$1',[id]);return 'https://yt3.ggpht.com/fixture';});
 expect((await pool.query('SELECT 1 FROM media_channel_icons WHERE user_id=$1',[id])).rowCount).toBe(0);
});
it('uses six concurrent metadata lookups and continues past isolated video errors',async()=>{
 const id=await owner(18);let entered!:()=>void,release!:()=>void,active=0,peak=0,calls=0;
 const reached=new Promise<void>(r=>entered=r),barrier=new Promise<void>(r=>release=r);
 const task=enrichMediaMetadata(pool,id,async()=>{
  const n=++calls;peak=Math.max(peak,++active);if(calls===6)entered();await barrier;active--;
  if(n%3===0)throw Error('isolated bad metadata');
  return {status:'ready',title:'Fixture',channel:'Fixture',channelKey:publicKey(1)};
 },18,6);
 await reached;expect(peak).toBe(6);release();expect(await task).toEqual({ready:12,errors:6});expect(calls).toBe(18);
});
it('stops a rate-limited provider wave and persists a cooldown shared by accounts and icons',async()=>{
 const [a,b]=await Promise.all([owner(18),owner(2)]);
 const get=vi.fn(async()=>{throw new YoutubeMetadataRateLimit();});
 try{
  expect(await enrichMediaMetadata(pool,a,get,18,6)).toEqual({ready:0,errors:6});expect(get).toHaveBeenCalledTimes(6);
  const unused=vi.fn();expect(await enrichMediaMetadata(pool,b,unused)).toEqual({ready:0,errors:0});expect(unused).not.toHaveBeenCalled();
  expect(await enrichChannelIcons(pool,b,unused)).toEqual({ready:0,errors:0});expect(unused).not.toHaveBeenCalled();
 }finally{await pool.query("DELETE FROM scheduler_state WHERE key='media.youtube.cooldown'");}
});
