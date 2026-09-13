import { Readable } from 'node:stream';
import type { FastifyInstance,FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Config } from '../config';
import { MAX_MEDIA_BYTES, MediaError } from './import';
import { importMedia, mapMediaEvent, MEDIA_RANGES, mediaSummary } from './service';
import { analyzeMedia, classifyMediaTitles } from './analysis';
import { registerMediaDevices } from './devices';
import { channelOverview,channelDetail,setChannelAutomation } from './channels';
import { CHANNEL_CATEGORIES } from '../../shared/media-channels';
import { lockMedia } from './service';
export function registerMediaRoutes(app:FastifyInstance,pool:Pool,config:Config,classify=classifyMediaTitles){
  registerMediaDevices(app,pool);
  const enabled=async(request:FastifyRequest)=>{if(!(await pool.query("SELECT 1 FROM user_modules WHERE user_id=$1 AND module_id='media' AND enabled",[request.zhiyuUser.id])).rowCount)throw new MediaError('請先啟用影音分析模組。',409);};
  app.addContentTypeParser('application/octet-stream',{parseAs:'buffer',bodyLimit:MAX_MEDIA_BYTES},(_request,body,done)=>done(null,body));
  app.post('/api/v1/media/import',{preHandler:enabled,bodyLimit:MAX_MEDIA_BYTES,config:{rateLimit:{max:3,timeWindow:'1 minute'}}},async request=>{
    if(!Buffer.isBuffer(request.body))throw new MediaError('請選擇 ZIP、JSON 或 HTML 匯出檔。');
    return importMedia(pool,request.zhiyuUser.id,request.body);
  });
  app.get('/api/v1/media/summary',{preHandler:enabled},async request=>{
    const input=z.object({range:z.enum(MEDIA_RANGES).default('90d')}).parse(request.query);
    return mediaSummary(pool,request.zhiyuUser.id,input.range,config);
  });
  app.get('/api/v1/media/history',{preHandler:enabled},async request=>{
    const input=z.object({q:z.string().max(120).default(''),page:z.coerce.number().int().min(0).max(10000).default(0),range:z.enum(MEDIA_RANGES).default('90d')}).parse(request.query);
    const days=input.range==='all'?null:Number(input.range.replace('d',''));
    const rows=await pool.query(`SELECT * FROM media_events WHERE user_id=$1 AND (strpos(lower(title),lower($2))>0 OR strpos(lower(COALESCE(channel,'')),lower($2))>0) AND watched_at<=now() AND ($4::int IS NULL OR watched_at>=now()-make_interval(days=>$4)) ORDER BY watched_at DESC,event_id LIMIT 51 OFFSET $3`,[request.zhiyuUser.id,input.q,input.page*50,days]);
    return {items:rows.rows.slice(0,50).map(mapMediaEvent),hasMore:rows.rows.length>50};
  });
  app.post('/api/v1/media/classify',{preHandler:enabled},async request=>{
    z.object({confirm:z.literal(true)}).strict().parse(request.body);
    return analyzeMedia(pool,config,request.zhiyuUser.id,classify);
  });
  app.get('/api/v1/media/channels',{preHandler:enabled},async request=>{
    const p=z.object({range:z.enum(MEDIA_RANGES).default('90d'),q:z.string().max(160).default(''),category:z.string().max(80).default(''),sort:z.enum(['count','time']).default('count'),page:z.coerce.number().int().min(0).max(25000).default(0)}).parse(request.query);
    return channelOverview(pool,request.zhiyuUser.id,p.range,p.q,p.category,p.page,p.sort);
  });
  app.get('/api/v1/media/channel',{preHandler:enabled},async request=>{
    const p=z.object({key:z.string().max(500),range:z.enum(MEDIA_RANGES).default('90d')}).parse(request.query);
    return channelDetail(pool,request.zhiyuUser.id,p.key,p.range);
  });
  app.put('/api/v1/media/channel-automation',{preHandler:enabled},async request=>{
    const p=z.object({enabled:z.boolean(),confirm:z.literal(true)}).strict().parse(request.body);
    if(p.enabled&&!config.openaiApiKey)throw new MediaError('站長尚未設定 OpenAI 金鑰。',424);
    await setChannelAutomation(pool,request.zhiyuUser.id,p.enabled);return {enabled:p.enabled};
  });
  app.put('/api/v1/media/channel-category',{preHandler:enabled},async request=>{
    const p=z.object({key:z.string().max(500),category:z.enum(CHANNEL_CATEGORIES).nullable()}).strict().parse(request.body);
    const client=await pool.connect();try{await client.query('BEGIN');await lockMedia(client,request.zhiyuUser.id);
      const result=await client.query('UPDATE media_channel_labels SET override_category=$3,reviewed_at=CASE WHEN $3::text IS NULL THEN NULL ELSE now() END WHERE user_id=$1 AND channel_key=$2 RETURNING channel_key',[request.zhiyuUser.id,p.key,p.category]);
      if(!result.rowCount)throw new MediaError('尚無可檢視的分類，請等候自動分類完成。',404);
      await client.query('COMMIT');return {updated:true};
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  });
  app.post('/api/v1/media/clear',async request=>{
    z.object({confirm:z.literal(true)}).strict().parse(request.body);
    const client=await pool.connect();try{await client.query('BEGIN');await client.query("SELECT 1 FROM user_modules WHERE user_id=$1 AND module_id='media' FOR UPDATE",[request.zhiyuUser.id]);for(const table of ['media_events','media_imports','media_classifications','media_ai_state','media_devices','media_video_metadata','media_channel_labels','media_processing'])await client.query(`DELETE FROM ${table} WHERE user_id=$1`,[request.zhiyuUser.id]);await client.query('COMMIT');return {deleted:true};}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  });
  app.get('/api/v1/media/export',async(request,reply)=>{
    const userId=request.zhiyuUser.id;
    const {part}=z.object({part:z.coerce.number().int().min(1).max(100).optional()}).parse(request.query);
    async function* chunks(){
      const client=await pool.connect();
      try{await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query('DECLARE media_export_cursor NO SCROLL CURSOR FOR SELECT * FROM media_events WHERE user_id=$1 ORDER BY watched_at,event_id LIMIT $2 OFFSET $3',[userId,part?5000:null,part?(part-1)*5000:0]);
        yield '{"format":"zhiyu-media-export","version":1,"events":[';let first=true;
        while(true){const rows=await client.query('FETCH 1000 FROM media_export_cursor');if(!rows.rowCount)break;for(const row of rows.rows){yield (first?'':',')+JSON.stringify(mapMediaEvent(row));first=false;}}
        yield ']}';await client.query('COMMIT');
      }finally{await client.query('ROLLBACK').catch(()=>{});client.release();}
    }
    return reply.header('Content-Disposition',`attachment; filename="zhiyu-media${part?`-${part}`:''}.json"`).type('application/json; charset=utf-8').send(Readable.from(chunks()));
  });
}
