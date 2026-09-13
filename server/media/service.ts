import type { Pool,PoolClient } from 'pg';
import type { MediaEvent,MediaSummary } from '../../shared/media';
import type { Config } from '../config';
import { MediaError, parseMediaImport } from './import';
export const MEDIA_RANGES=['28d','90d','365d','all'] as const;
export async function lockMedia(client:PoolClient,userId:string){
  const module=(await client.query("SELECT enabled FROM user_modules WHERE user_id=$1 AND module_id='media' FOR UPDATE",[userId])).rows[0];
  if(!module?.enabled)throw new MediaError('請先啟用影音分析模組。',409);
}
export async function importMedia(pool:Pool,userId:string,bytes:Uint8Array){
  const parsed=parseMediaImport(bytes),client=await pool.connect();
  try{
    await client.query('BEGIN');await lockMedia(client,userId);
    const previous=(await client.query('SELECT inserted,skipped FROM media_imports WHERE user_id=$1 AND hash=$2',[userId,parsed.hash])).rows[0];
    if(previous){await client.query('COMMIT');return {...previous,repeated:true,source:parsed.source};}
    const before=Number((await client.query('SELECT count(*) count FROM media_events WHERE user_id=$1',[userId])).rows[0].count);
    for(let offset=0;offset<parsed.events.length;offset+=2000){
      await client.query(`INSERT INTO media_events(user_id,event_id,video_id,title,channel,watched_at,actual_seconds,precision,topics,topic_source,source)
        SELECT $1,e->>'eventId',e->>'videoId',e->>'title',e->>'channel',(e->>'watchedAt')::timestamptz,(e->>'actualSeconds')::int,e->>'precision',e->'topics',e->>'topicSource',e->>'source' FROM jsonb_array_elements($2::jsonb) e
        ON CONFLICT(user_id,event_id) DO UPDATE SET title=EXCLUDED.title,channel=COALESCE(EXCLUDED.channel,media_events.channel),actual_seconds=COALESCE(EXCLUDED.actual_seconds,media_events.actual_seconds),
        topics=CASE WHEN jsonb_array_length(EXCLUDED.topics)>0 THEN EXCLUDED.topics ELSE media_events.topics END,topic_source=COALESCE(EXCLUDED.topic_source,media_events.topic_source)`,[userId,JSON.stringify(parsed.events.slice(offset,offset+2000))]);
    }
    // A day-only scan is superseded by an exact record of that video on the same Taipei day.
    await client.query(`DELETE FROM media_events coarse USING media_events exact WHERE coarse.user_id=$1 AND exact.user_id=coarse.user_id AND coarse.video_id=exact.video_id AND coarse.precision='day' AND exact.precision='exact' AND (coarse.watched_at AT TIME ZONE 'Asia/Taipei')::date=(exact.watched_at AT TIME ZONE 'Asia/Taipei')::date`,[userId]);
    await client.query(`UPDATE media_events e SET topics=c.topics,topic_source=c.model FROM media_classifications c WHERE e.user_id=$1 AND c.user_id=e.user_id AND c.video_id=e.video_id AND jsonb_array_length(e.topics)=0`,[userId]);
    const after=Number((await client.query('SELECT count(*) count FROM media_events WHERE user_id=$1',[userId])).rows[0].count);
    if(after>500000)throw new MediaError('每個帳號最多保存 50 萬筆觀看紀錄。');
    const inserted=Math.max(0,after-before),skipped=parsed.skipped+Math.max(0,parsed.events.length-inserted);
    await client.query('INSERT INTO media_imports(user_id,hash,source,inserted,skipped) VALUES($1,$2,$3,$4,$5)',[userId,parsed.hash,parsed.source,inserted,skipped]);
    await client.query('COMMIT');return {inserted,skipped,repeated:false,source:parsed.source};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function mediaSummary(pool:Pool,userId:string,range:typeof MEDIA_RANGES[number],config:Config):Promise<MediaSummary>{
  const days=range==='all'?null:Number(range.replace('d',''));
  const base=`user_id=$1 AND watched_at<=now() AND ($2::int IS NULL OR watched_at>=now()-make_interval(days=>$2))`;
  const [totals,counts,channels,topics,daily,hourly,imports,unclassified]=await Promise.all([
    pool.query('SELECT count(*)::int total,min(watched_at) AS first,max(watched_at) AS last FROM media_events WHERE user_id=$1',[userId]),
    pool.query(`SELECT count(*)::int selected,count(DISTINCT video_id)::int videos,count(DISTINCT (watched_at AT TIME ZONE 'Asia/Taipei')::date)::int days,sum(actual_seconds)::float8 seconds,count(actual_seconds)::int timed,count(*) FILTER(WHERE jsonb_array_length(topics)>0)::int classified FROM media_events WHERE ${base}`,[userId,days]),
    pool.query(`WITH selected AS (SELECT COALESCE(channel,'未提供頻道') name,count(*)::int count FROM media_events WHERE ${base} GROUP BY 1),prior AS (SELECT COALESCE(channel,'未提供頻道') name,count(*)::int count FROM media_events WHERE user_id=$1 AND $2::int IS NOT NULL AND watched_at<now()-make_interval(days=>$2) AND watched_at>=now()-make_interval(days=>$2*2) GROUP BY 1) SELECT s.*,COALESCE(p.count,0)::int previous FROM selected s LEFT JOIN prior p USING(name) ORDER BY s.count DESC,s.name LIMIT 20`,[userId,days]),
    pool.query(`SELECT t.name,count(DISTINCT event_id)::int count FROM media_events CROSS JOIN LATERAL jsonb_array_elements_text(topics) t(name) WHERE ${base} GROUP BY t.name ORDER BY count DESC,t.name LIMIT 30`,[userId,days]),
    pool.query(`SELECT to_char(date_trunc(CASE WHEN $2::int IS NULL OR $2>90 THEN 'month' ELSE 'day' END,watched_at AT TIME ZONE 'Asia/Taipei'),'YYYY-MM-DD') date,count(*)::int count FROM media_events WHERE ${base} GROUP BY 1 ORDER BY 1`,[userId,days]),
    pool.query(`SELECT extract(hour FROM watched_at AT TIME ZONE 'Asia/Taipei')::int AS "hour",count(*)::int count FROM media_events WHERE ${base} AND precision='exact' GROUP BY 1 ORDER BY 1`,[userId,days]),
    pool.query('SELECT source,inserted,skipped,imported_at FROM media_imports WHERE user_id=$1 ORDER BY imported_at DESC LIMIT 5',[userId]),
    pool.query("SELECT count(DISTINCT video_id)::int count FROM media_events WHERE user_id=$1 AND video_id IS NOT NULL AND jsonb_array_length(topics)=0",[userId])
  ]);
  const t=totals.rows[0],c=counts.rows[0];
  const rank=(rows:Record<string,any>[])=>rows.map(row=>({name:row.name,count:row.count,share:c.selected?row.count/c.selected:0,previousCount:row.previous??0}));
  return {range,total:t.total,selected:c.selected,uniqueVideos:c.videos,activeDays:c.days,recordedSeconds:c.seconds,timedEvents:c.timed,from:t.first?.toISOString()??null,to:t.last?.toISOString()??null,channels:rank(channels.rows),topics:rank(topics.rows),classifiedEvents:c.classified,daily:daily.rows,hourly:hourly.rows,imports:imports.rows.map(row=>({source:row.source,inserted:row.inserted,skipped:row.skipped,importedAt:row.imported_at.toISOString()})),aiEnabled:Boolean(config.openaiApiKey)&&(config.aiDailyLimit??40)>0,unclassifiedVideos:unclassified.rows[0].count};
}
export function mapMediaEvent(row:Record<string,any>):MediaEvent{return {eventId:row.event_id,videoId:row.video_id,title:row.title,channel:row.channel,watchedAt:row.watched_at.toISOString(),actualSeconds:row.actual_seconds,precision:row.precision,topics:row.topics,topicSource:row.topic_source,source:row.source};}
