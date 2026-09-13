import { load } from 'cheerio';
import type { Pool } from 'pg';
import { youtubeChannelUrl } from './metadata';
import { lockMedia } from './service';

export function youtubeIconUrl(value:unknown):string|null{
 if(typeof value!=='string'||value.length>2048)return null;
 try{const u=new URL(value);
  return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&['yt3.ggpht.com','yt3.googleusercontent.com'].includes(u.hostname)?u.href:null;
 }catch{return null;}
}
export async function fetchChannelIcon(channel:string,request:typeof fetch=fetch):Promise<string|null>{
 const url=youtubeChannelUrl(channel);if(!url)throw Error('Invalid channel');
 const response=await request(url,{redirect:'error',signal:AbortSignal.timeout(15000)});
 if([404,410].includes(response.status))return null;
 if(!response.ok||!response.body)throw Error('Public channel image temporarily unavailable');
 const reader=response.body.getReader(),decoder=new TextDecoder();let html='',size=0;
 try{while(true){const next=await reader.read();if(next.done)break;
  size+=next.value.byteLength;if(size>8*1024*1024)throw Error('Channel page too large');
  html+=decoder.decode(next.value,{stream:true});
  const tags=html.match(/<meta\b[^>]*(?:property=["']og:image["']|itemprop=["']image["'])[^>]*>/gi)??[];
  for(const tag of tags){const icon=youtubeIconUrl(load(tag)('meta').attr('content'));if(icon)return icon.replace(/=s\d+(?=-|$)/,'=s88');}
  // YouTube emits channel metadata after </head>. Keep scanning the bounded
  // stream, retaining enough tail for a meta element spanning two chunks.
  html=html.slice(-8192);
 }}finally{await reader.cancel();}
 return null;
}
export async function enrichChannelIcons(pool:Pool,userId:string,getIcon=fetchChannelIcon,limit=60){
 const pending=(await pool.query(`SELECT m.channel_key FROM media_video_metadata m
 LEFT JOIN media_channel_icons i ON i.user_id=m.user_id AND i.channel_key=m.channel_key
 WHERE m.user_id=$1 AND m.channel_key LIKE 'https://www.youtube.com/channel/%'
 AND (i.channel_key IS NULL OR i.retry_after<now())
 AND EXISTS(SELECT 1 FROM media_events e WHERE e.user_id=m.user_id AND e.video_id=m.video_id)
 GROUP BY m.channel_key,i.checked_at ORDER BY i.checked_at NULLS FIRST,count(*) DESC,m.channel_key LIMIT $2`,[userId,limit])).rows;
 let ready=0,errors=0;
 for(let start=0;start<pending.length;start+=3){
  const results=await Promise.all(pending.slice(start,start+3).map(async row=>{
   try{return {key:row.channel_key,icon:youtubeIconUrl(await getIcon(row.channel_key)),error:false};}
   catch{return {key:row.channel_key,icon:null,error:true};}
  }));
  const c=await pool.connect();try{await c.query('BEGIN');await lockMedia(c,userId);
   for(const r of results){
    const saved=await c.query(`INSERT INTO media_channel_icons(user_id,channel_key,icon_url,retry_after)
     SELECT $1,$2,$3,now()+make_interval(hours=>$4)
     WHERE EXISTS(SELECT 1 FROM media_video_metadata m JOIN media_events e ON e.user_id=m.user_id AND e.video_id=m.video_id WHERE m.user_id=$1 AND m.channel_key=$2)
     ON CONFLICT(user_id,channel_key) DO UPDATE SET icon_url=COALESCE(EXCLUDED.icon_url,media_channel_icons.icon_url),checked_at=now(),retry_after=EXCLUDED.retry_after RETURNING channel_key`,
     [userId,r.key,r.icon,r.error?1:r.icon?720:24]);
    if(r.icon&&saved.rowCount)ready++;if(r.error)errors++;
   }await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  if(errors>=3)break;
 }
 return {ready,errors};
}
