import type { PoolClient } from 'pg';
import type { Config } from '../config';

export const mediaAiSettings=(config:Partial<Config>={})=>({
 channelBatchSize:config.mediaChannelBatchSize??32,videoBatchSize:config.mediaVideoBatchSize??100,
 concurrency:config.mediaAiConcurrency??4,dailyLimit:config.mediaAiDailyBatches??200
});
export function chunks<T>(items:T[],size:number):T[][]{
 const result:T[][]=[];for(let i=0;i<items.length;i+=size)result.push(items.slice(i,i+size));return result;
}
// Reserve a whole wave atomically, including partial capacity near the daily
// limit. The caller holds its user lease in the same transaction.
export async function reserveBatches(c:PoolClient,day:string,limit:number,wanted:number){
 await c.query('INSERT INTO ai_daily_usage(day,requests) VALUES($1,0) ON CONFLICT DO NOTHING',[day]);
 const current=(await c.query('SELECT requests FROM ai_daily_usage WHERE day=$1 FOR UPDATE',[day])).rows[0].requests;
 const count=Math.max(0,Math.min(wanted,limit-current));
 if(count)await c.query('UPDATE ai_daily_usage SET requests=requests+$2 WHERE day=$1',[day,count]);
 return count;
}
// Do not immediately replay a possibly billed request. Save the provider's
// Retry-After as a cooldown for the next worker pass instead.
export class MediaRateLimit extends Error {
 constructor(public retrySeconds:number){super('OpenAI 暫時限流，將降低頻率後續做。');}
}
export function checkRateLimit(response:Response){
 if(response.status!==429)return;
 const raw=response.headers.get('retry-after');
 const seconds=raw?(Number.isFinite(Number(raw))?Number(raw):(Date.parse(raw)-Date.now())/1000):60;
 throw new MediaRateLimit(Math.min(3600,Math.max(60,Number.isFinite(seconds)?seconds:60)));
}
