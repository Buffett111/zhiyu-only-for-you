import type { Pool } from 'pg';
import { z } from 'zod';
import { lockMedia } from './service';
import { load } from 'cheerio';

export function youtubeChannelUrl(value:unknown):string|null {
 if(typeof value!=='string')return null;
 try{const u=new URL(value);if(u.protocol!=='https:'||!['www.youtube.com','youtube.com','m.youtube.com'].includes(u.hostname)||u.username||u.password||u.port)return null;
  if(!/^\/(?:@[^/?#]+|channel\/UC[A-Za-z0-9_-]{22})\/?$/.test(u.pathname))return null;
  return `https://www.youtube.com${u.pathname.replace(/\/$/,'')}`;
 }catch{return null;}
}
const embed=z.object({title:z.string().min(1).max(5000),author_name:z.string().min(1).max(500),author_url:z.string()});
export class YoutubeMetadataRateLimit extends Error {}
const identities=new Map<string,Promise<string>>();
async function channelIdentity(url:string,request:typeof fetch){
 if(new URL(url).pathname.startsWith('/channel/'))return url;
 if(request===fetch&&identities.has(url))return identities.get(url)!;
 const task=(async()=>{
  const r=await request(url,{signal:AbortSignal.timeout(15000),redirect:'error'});if(r.status===429)throw new YoutubeMetadataRateLimit();if(!r.ok||!r.body)throw Error('Channel identity temporarily unavailable');
  const reader=r.body.getReader(),decoder=new TextDecoder();let length=0,tail='',id:string|undefined;
  try{while(true){const next=await reader.read();if(next.done)break;length+=next.value.length;if(length>8*1024*1024)throw Error('Channel metadata too large');
   tail+=decoder.decode(next.value,{stream:true});
   const tag=tail.match(/<meta\b[^>]*\bitemprop=["']identifier["'][^>]*>/i)?.[0];
   if(tag){id=load(tag)('meta[itemprop="identifier"]').attr('content');break;}
   tail=tail.slice(-4096);
  }}finally{await reader.cancel();}
  if(!/^UC[A-Za-z0-9_-]{22}$/.test(id??''))throw Error('Stable channel identity not found');
  return `https://www.youtube.com/channel/${id}`;
 })();
 if(request===fetch){if(identities.size>=2000)identities.delete(identities.keys().next().value!);identities.set(url,task);task.catch(()=>identities.delete(url));}
 return task;
}
export async function fetchVideoAuthor(videoId:string,request:typeof fetch=fetch){
 if(!/^[A-Za-z0-9_-]{11}$/.test(videoId))throw Error('Invalid video ID');
 const response=await request(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`,{signal:AbortSignal.timeout(15000),redirect:'error'});
 if([401,403,404,410].includes(response.status))return {status:'unavailable' as const,title:null,channel:null,channelKey:null};
 if(response.status===429)throw new YoutubeMetadataRateLimit();
 if(!response.ok)throw Error('YouTube metadata temporarily unavailable');
 const body=embed.parse(await response.json()),channelKey=youtubeChannelUrl(body.author_url);
 if(!channelKey)throw Error('Invalid YouTube channel URL');
 return {status:'ready' as const,title:body.title.slice(0,500),channel:body.author_name.slice(0,160),channelKey:await channelIdentity(channelKey,request)};
}
// Only enrich videos actually saved by an enabled user. No cookies, Google
// account, watch dates or other history are sent to the public oEmbed endpoint.
export async function enrichMediaMetadata(pool:Pool,userId:string,fetchAuthor=fetchVideoAuthor,limit=180,concurrency=6){
 // Persist a shared provider cooldown across restarts and accounts.
 if((await pool.query("SELECT 1 FROM scheduler_state WHERE key='media.youtube.cooldown' AND (value->>'until')::timestamptz>now() LIMIT 1")).rowCount)return {ready:0,errors:0};
 const pending=(await pool.query(`SELECT e.video_id FROM media_events e LEFT JOIN media_video_metadata m ON m.user_id=e.user_id AND m.video_id=e.video_id
 WHERE e.user_id=$1 AND e.video_id IS NOT NULL AND (m.video_id IS NULL OR m.retry_after<now())
 GROUP BY e.video_id,m.checked_at,m.channel_key ORDER BY CASE WHEN m.channel_key LIKE 'https://www.youtube.com/@%' THEN 0 ELSE 1 END,m.checked_at NULLS FIRST,count(*) DESC,max(e.watched_at) DESC LIMIT $2`,[userId,limit])).rows;
 let ready=0,errors=0;
 const started=Date.now();let consecutiveFailures=0;
 for(let start=0;start<pending.length;start+=concurrency){
  const results=await Promise.all(pending.slice(start,start+concurrency).map(async row=>{
   try{return {id:row.video_id,limited:false,...await fetchAuthor(row.video_id)};}catch(error){return {id:row.video_id,limited:error instanceof YoutubeMetadataRateLimit,status:'error' as const,title:null,channel:null,channelKey:null};}
  }));
  const client=await pool.connect();
  try{await client.query('BEGIN');await lockMedia(client,userId);
   for(const result of results){
    const saved=await client.query(`INSERT INTO media_video_metadata(user_id,video_id,title,channel,channel_key,status,retry_after)
      SELECT $1,$2,$3,$4,$5,$6,now()+make_interval(days=>$7,mins=>$8)
      WHERE EXISTS(SELECT 1 FROM media_events WHERE user_id=$1 AND video_id=$2)
      ON CONFLICT(user_id,video_id) DO UPDATE SET title=COALESCE(EXCLUDED.title,media_video_metadata.title),channel=COALESCE(EXCLUDED.channel,media_video_metadata.channel),channel_key=COALESCE(EXCLUDED.channel_key,media_video_metadata.channel_key),status=EXCLUDED.status,checked_at=now(),retry_after=EXCLUDED.retry_after RETURNING video_id`,
      [userId,result.id,result.title,result.channel,result.channelKey,result.status,result.status==='ready'?30:result.status==='unavailable'?7:0,result.status==='error'?30:0]);
    if(result.status==='ready'&&saved.rowCount){ready++;await client.query("UPDATE media_events SET channel=$3,title=CASE WHEN title='YouTube 影片' THEN $4 ELSE title END WHERE user_id=$1 AND video_id=$2 AND (channel IS DISTINCT FROM $3 OR title='YouTube 影片')",[userId,result.id,result.channel,result.title]);}
    if(result.status==='error')errors++;
   }
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  if(results.some(r=>r.limited)){
   await pool.query("INSERT INTO scheduler_state(key,value) VALUES('media.youtube.cooldown',jsonb_build_object('until',now()+interval '5 minutes')) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()");break;
  }
  consecutiveFailures=results.every(r=>r.status==='error')?consecutiveFailures+1:0;
  // Isolated unavailable videos must not stall the whole backlog. Stop on
  // sustained provider failures, and leave time for the next scheduled pass.
  if(consecutiveFailures>=2||Date.now()-started>240000)break;
 }
 return {ready,errors};
}
