// Content-axis definitions adapted from urTube's governed channel-tag policy.
// Fetch whole public lists; never send a user's channel list to the curator.
import { createHash } from 'node:crypto';
import { youtubeChannelUrl } from './metadata';
export const CONTENT_GROUPS=[
 {key:'news',name:'新聞',query:'tagid=13'},
 {key:'editorial',name:'個人社論',query:'tagid=1&not=2,9,10,12,13,33,36,81'},
 {key:'editorialShows',name:'社論節目',query:'tagid=1,9'}
] as const;
export const CHANNEL_TAG_SOURCE='https://urtubeapi.analysis.tw/api/channels_list.php';
type Snapshot={fetchedAt:string;sourceTime:string;version:string;groups:{name:string;keys:Set<string>}[]};
let cached:Snapshot|null=null,pending:Promise<Snapshot>|null=null,retryAfter=0;
export function channelTagKey(value:string){try{const path=decodeURIComponent(new URL(value).pathname);return path.startsWith('/@')?path.toLowerCase():path;}catch{return value;}}
export async function loadContentTags(request:typeof fetch=fetch):Promise<Snapshot>{
 const lists=await Promise.all(CONTENT_GROUPS.map(async group=>{
  const r=await request(`${CHANNEL_TAG_SOURCE}?${group.query}`,{signal:AbortSignal.timeout(15000),redirect:'error'});
  if(!r.ok)throw Error('Channel source unavailable');const d=await r.json() as any;
  if(!Array.isArray(d.result)||typeof d.time!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(d.time)||!Number.isFinite(Date.parse(d.time.replace(' ','T')+'+08:00')))throw Error('Invalid source timestamp');
  const keys=new Set<string>();
  for(const row of d.result){if(!/^UC[A-Za-z0-9_-]{22}$/.test(row?.youtube_id))throw Error('Invalid channel ID');keys.add(channelTagKey(`https://www.youtube.com/channel/${row.youtube_id}`));
   if(typeof row.customUrl==='string'&&row.customUrl.startsWith('@')){const url=youtubeChannelUrl(`https://www.youtube.com/${row.customUrl}`);if(url)keys.add(channelTagKey(url));}
  }
  return {name:group.name,keys,time:d.time};
 }));
 return {fetchedAt:new Date().toISOString(),sourceTime:lists.map(l=>l.time).sort().at(-1)!,version:'sha256:'+createHash('sha256').update(lists.flatMap(l=>[...l.keys].sort().map(k=>`${l.name}:${k}`)).join('\n')).digest('hex').slice(0,12),groups:lists};
}
export async function contentTags():Promise<Snapshot|null>{
 if(cached&&Date.now()-Date.parse(cached.fetchedAt)<6*3600000)return cached;
 if(Date.now()<retryAfter)return null;
 pending??=loadContentTags().then(s=>cached=s).finally(()=>pending=null);
 try{return await pending;}catch{retryAfter=Date.now()+60000;return null;}
}
