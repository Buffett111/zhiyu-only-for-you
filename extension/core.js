export const SITE='https://zhiyu.example.invalid';
export const ORIGINS=['https://www.youtube.com/*','https://m.youtube.com/*'];
export const MAX_QUEUE=10000;
export function videoId(url){try{const u=new URL(url);if(!['https:','http:'].includes(u.protocol))return null;let id=null;if(['youtube.com','www.youtube.com','m.youtube.com','music.youtube.com'].includes(u.hostname))id=u.pathname==='/watch'?u.searchParams.get('v'):u.pathname.match(/^\/(?:shorts|live)\/([^/]+)/)?.[1];if(u.hostname==='youtu.be')id=u.pathname.slice(1);return /^[A-Za-z0-9_-]{11}$/.test(id??'')?id:null;}catch{return null;}}
export const eventKey=e=>`${e.videoId}|${e.watchedAt}|${e.precision}`;
const number=(n,max)=>Number.isFinite(n)&&n>=0&&n<=max?n:null;
export function normalizeEvent(value){
  if(!value||!/^[A-Za-z0-9_-]{11}$/.test(value.videoId??''))return null;
  const time=new Date(value.watchedAt);if(!Number.isFinite(+time)||+time<Date.UTC(2005,0,1)||+time>Date.now()+60000)return null;
  return {videoId:value.videoId,title:String(value.title||'YouTube 影片').slice(0,500),channel:typeof value.channel==='string'?value.channel.slice(0,160):null,watchedAt:time.toISOString(),actualSeconds:Number.isFinite(value.actualSeconds)?Math.max(0,Math.min(86400,Math.floor(value.actualSeconds))):null,precision:value.precision==='day'?'day':'exact',durationSeconds:number(value.durationSeconds,31536000)===null?null:Math.floor(value.durationSeconds),progressPercent:number(value.progressPercent,100),resumeSeconds:number(value.resumeSeconds,31536000)===null?null:Math.floor(value.resumeSeconds)};
}
export function mergeQueue(queue,incoming){
  const map=new Map(queue.map(e=>[eventKey(e),e]));
  for(const raw of incoming){const e=normalizeEvent(raw);if(!e)continue;const key=eventKey(e),old=map.get(key);if(!old&&map.size>=MAX_QUEUE)throw Error('本機待同步紀錄已滿；恢復知隅連線後會繼續回補。');map.set(key,old?{...e,channel:e.channel??old.channel,durationSeconds:e.durationSeconds??old.durationSeconds??null,progressPercent:e.progressPercent===null?old.progressPercent??null:Math.max(e.progressPercent,old.progressPercent??0),resumeSeconds:e.resumeSeconds===null?old.resumeSeconds??null:Math.max(e.resumeSeconds,old.resumeSeconds??0),actualSeconds:e.actualSeconds===null?old.actualSeconds:Math.max(e.actualSeconds,old.actualSeconds??0)}:e);}
  return [...map.values()];
}
export function acknowledge(queue,sent){const map=new Map(sent.map(e=>[eventKey(e),JSON.stringify(e)]));return queue.filter(e=>map.get(eventKey(e))!==JSON.stringify(e));}
