import type { Pool } from 'pg';
import type { Config } from '../config';
import { enrichMediaMetadata } from './metadata';
import { classifyChannels } from './channels';
import { enrichChannelIcons } from './icons';

export async function processMedia(pool:Pool,config:Config){
 const lease=await pool.connect();
 try{
  if(!(await lease.query("SELECT pg_try_advisory_lock(hashtext('zhiyu.media.enrich')) ok")).rows[0].ok)return;
  const users=(await pool.query("SELECT user_id FROM user_modules WHERE module_id='media' AND enabled AND EXISTS(SELECT 1 FROM media_events WHERE media_events.user_id=user_modules.user_id) ORDER BY user_id")).rows;
  for(const row of users){
   // Independent providers: slow YouTube metadata must not delay ready AI work.
   // Keep one wave per minute, with bounded parallelism inside each provider.
   const results=await Promise.allSettled([enrichMediaMetadata(pool,row.user_id),enrichChannelIcons(pool,row.user_id),classifyChannels(pool,config,row.user_id)]);
   for(const result of results)if(result.status==='rejected'){ /* Retry next pass; never log private payloads. */ }
  }
 }finally{await lease.query("SELECT pg_advisory_unlock(hashtext('zhiyu.media.enrich'))");lease.release();}
}
