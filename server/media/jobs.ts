import type { Pool } from 'pg';
import type { Config } from '../config';
import { enrichMediaMetadata } from './metadata';
import { classifyChannels } from './channels';
import { enrichChannelIcons } from './icons';

export type MediaJobKind='metadata'|'icons'|'classify';
export async function processMedia(pool:Pool,config:Config,kind?:MediaJobKind):Promise<void>{
 if(!kind){await Promise.all([processMedia(pool,config,'metadata'),processMedia(pool,config,'icons'),processMedia(pool,config,'classify')]);return;}
 const lock=`zhiyu.media.${kind}`;
 const lease=await pool.connect();
 try{
  if(!(await lease.query('SELECT pg_try_advisory_lock(hashtext($1)) ok',[lock])).rows[0].ok)return;
  const users=(await pool.query("SELECT user_id FROM user_modules WHERE module_id='media' AND enabled AND EXISTS(SELECT 1 FROM media_events WHERE media_events.user_id=user_modules.user_id) ORDER BY user_id")).rows;
  for(const row of users){
   try{
    if(kind==='metadata')await enrichMediaMetadata(pool,row.user_id,undefined,config.mediaMetadataBatchSize??180,config.mediaMetadataConcurrency??6);
    else if(kind==='icons')await enrichChannelIcons(pool,row.user_id);
    else await classifyChannels(pool,config,row.user_id);
   }catch{ /* Disabled/cleared users are checked next pass; no private payloads in logs. */ }
  }
 }finally{await lease.query('SELECT pg_advisory_unlock(hashtext($1))',[lock]);lease.release();}
}
