import { createHash,randomBytes,randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { importMedia,lockMedia } from './service';
import { MediaError } from './import';

const credentials=z.object({deviceId:z.uuid(),token:z.string().regex(/^[a-f0-9]{64}$/)});
const event=z.object({videoId:z.string().regex(/^[A-Za-z0-9_-]{11}$/),title:z.string().trim().min(1).max(500),channel:z.string().max(160).nullable(),watchedAt:z.iso.datetime(),actualSeconds:z.number().int().min(0).max(86400).nullable(),precision:z.enum(['day','exact'])}).strict();
const hash=(token:string)=>createHash('sha256').update(token).digest('hex');
export function registerMediaDevices(app:FastifyInstance,pool:Pool){
  app.get('/api/v1/media/devices',async request=>({devices:(await pool.query('SELECT id,label,created_at AS "createdAt",last_sync AS "lastSync",revoked_at AS "revokedAt" FROM media_devices WHERE user_id=$1 ORDER BY created_at DESC',[request.zhiyuUser.id])).rows}));
  app.post('/api/v1/media/devices',{config:{rateLimit:{max:10,timeWindow:'1 hour'}}},async request=>{
    const input=z.object({confirm:z.literal(true),label:z.string().trim().min(1).max(60)}).strict().parse(request.body);
    const client=await pool.connect(),id=randomUUID(),token=randomBytes(32).toString('hex');
    try{await client.query('BEGIN');await lockMedia(client,request.zhiyuUser.id);
      if(Number((await client.query('SELECT count(*) n FROM media_devices WHERE user_id=$1 AND revoked_at IS NULL',[request.zhiyuUser.id])).rows[0].n)>=10)throw new MediaError('最多連接 10 個瀏覽器，請先解除不使用的裝置。',409);
      await client.query('INSERT INTO media_devices(id,user_id,label,token_hash) VALUES($1,$2,$3,$4)',[id,request.zhiyuUser.id,input.label,hash(token)]);await client.query('COMMIT');
      return {deviceId:id,token,userId:request.zhiyuUser.id,account:request.zhiyuUser.email};
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  });
  app.post('/api/v1/media/devices/:id/revoke',async request=>{
    const {id}=z.object({id:z.uuid()}).parse(request.params);z.object({confirm:z.literal(true)}).strict().parse(request.body);
    const client=await pool.connect();try{await client.query('BEGIN');await client.query("SELECT 1 FROM user_modules WHERE user_id=$1 AND module_id='media' FOR UPDATE",[request.zhiyuUser.id]);
      const result=await client.query('UPDATE media_devices SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND user_id=$2 RETURNING id',[id,request.zhiyuUser.id]);if(!result.rowCount)throw new MediaError('找不到這個裝置。',404);await client.query('COMMIT');return {revoked:true};
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  });
  app.post('/api/v1/media/extension/sync',{bodyLimit:1024*1024,config:{rateLimit:{max:30,timeWindow:'1 minute'}}},async request=>{
    const input=credentials.extend({events:z.array(event).min(1).max(200)}).strict().parse(request.body);
    return importMedia(pool,request.zhiyuUser.id,Buffer.from(JSON.stringify({format:'zhiyu-media-export',version:1,events:input.events})),{
      source:'YouTube 擴充功能',trackImport:false,guard:async client=>{
        const valid=await client.query('UPDATE media_devices SET last_sync=now() WHERE id=$1 AND user_id=$2 AND token_hash=$3 AND revoked_at IS NULL RETURNING id',[input.deviceId,request.zhiyuUser.id,hash(input.token)]);
        if(!valid.rowCount)throw new MediaError('瀏覽器綁定已撤銷或登入帳號不同，請重新連接。',403);
      }
    });
  });
}
