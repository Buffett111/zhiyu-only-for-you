import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import type { MediaEvent } from '../../shared/media';
import { parseHtml, parseWatchActivities } from './takeout';
export const MAX_MEDIA_BYTES=50*1024*1024;
const MAX_EXPANDED_BYTES=200*1024*1024;
export class MediaError extends Error { constructor(message:string,public statusCode=400){super(message);this.name='MediaError';} }
const text=(value:unknown,max=500)=>typeof value==='string'?value.trim().slice(0,max):'';
const array=(value:unknown):Record<string,any>[]=>{if(!Array.isArray(value)||value.length>500000)throw new MediaError('匯入內容必須是有效的紀錄陣列，單檔最多 50 萬列。');return value.filter(v=>v&&typeof v==='object');};
const json=(bytes:Uint8Array)=>{try{return JSON.parse(Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/,''));}catch{throw new MediaError('無法讀取 JSON，請使用原始匯出檔。');}};
const videoId=(value:unknown)=>typeof value==='string'&&/^[a-zA-Z0-9_-]{11}$/.test(value)?value:null;
function event(input:Omit<MediaEvent,'eventId'>):MediaEvent|null{
  const time=new Date(input.watchedAt);
  if(!Number.isFinite(time.getTime())||time.getTime()<Date.UTC(2005,0,1)||time.getTime()>Date.now()+86400000||!input.title)return null;
  const watchedAt=time.toISOString(),id=videoId(input.videoId);
  const eventId=createHash('sha256').update(JSON.stringify([id??input.title,watchedAt,input.precision])).digest('hex');
  const seconds=input.actualSeconds;
  return {...input,videoId:id,watchedAt,eventId,actualSeconds:typeof seconds==='number'&&Number.isFinite(seconds)&&seconds>=0&&seconds<=86400?Math.round(seconds):null};
}
export function parseMediaImport(bytes:Uint8Array):{events:MediaEvent[];source:string;skipped:number;hash:string}{
  if(!bytes.length||bytes.length>MAX_MEDIA_BYTES)throw new MediaError('檔案大小須在 50 MB 以內。');
  let files:Record<string,Uint8Array>;
  if(bytes[0]===0x50&&bytes[1]===0x4b){
    let expanded=0,count=0;
    try{files=unzipSync(bytes,{filter(file){
      if(++count>2000||file.name.startsWith('/')||file.name.includes('\\')||file.name.split('/').includes('..'))throw new MediaError('ZIP 結構不安全或檔案數過多。');
      const name=file.name.toLowerCase();
      const wanted=['manifest.json','data/watch-events.json','data/activity-records.json','data/videos.json','data/personal-taxonomy.json','data/personal-taxonomy-runs.json','data/personal-topic-assignments.json'].includes(name)||/(^|\/)watch-history\.(json|html)$/.test(name)||/(^|\/)my activity\/youtube\/myactivity\.(json|html)$/.test(name);
      if(!wanted)return false;
      expanded+=file.originalSize;
      if(!Number.isSafeInteger(expanded)||expanded>MAX_EXPANDED_BYTES)throw new MediaError('解壓縮後資料超過 200 MB 上限，請分批匯出。');
      return true;
    }});}catch(error){if(error instanceof MediaError)throw error;throw new MediaError('ZIP 無法解析，請確認匯出已完成。');}
    if(Object.values(files).reduce((n,b)=>n+b.length,0)>MAX_EXPANDED_BYTES)throw new MediaError('解壓縮後資料過大。');
  }else{
    const start=Buffer.from(bytes.subarray(0,100)).toString('utf8').replace(/^\uFEFF/,'').trimStart();
    files={[start.startsWith('<')?'watch-history.html':'watch-history.json']:bytes};
  }
  const rawFile=files['watch-history.json'];
  if(rawFile){const exported=json(rawFile);if(exported?.format==='zhiyu-media-export'){
    if(exported.version!==1)throw new MediaError('不支援這個知隅匯出版本。');
    const rows=array(exported.events);const events=rows.map(row=>event({videoId:videoId(row.videoId),title:text(row.title),channel:text(row.channel,160)||null,watchedAt:text(row.watchedAt,80),actualSeconds:row.actualSeconds,precision:row.precision==='day'?'day':'exact',topics:Array.isArray(row.topics)?row.topics.filter((t:unknown)=>typeof t==='string').slice(0,3).map((t:string)=>t.slice(0,80)):[],topicSource:text(row.topicSource,80)||null,source:'知隅匯出'})).filter((v):v is MediaEvent=>Boolean(v));
    if(!events.length||events.length>200000)throw new MediaError('知隅匯出檔需包含 1 至 20 萬筆有效紀錄。');
    const unique=[...new Map(events.map(item=>[item.eventId,item])).values()];return {events:unique,source:'知隅匯出',skipped:rows.length-unique.length,hash:createHash('sha256').update(bytes).digest('hex')};
  }}
  const events:MediaEvent[]=[];let seen=0;let source='YouTube Takeout';
  if(files['manifest.json']){
    const manifest=json(files['manifest.json']);
    if(manifest?.format!=='urtube-portable-export'||manifest?.formatVersion!==1)throw new MediaError('不支援這個 urTube 匯出版本。');
    if(!files['data/watch-events.json'])throw new MediaError('urTube 匯出檔缺少觀看紀錄。');
    source='urTube';
    const read=(name:string)=>files[name]?array(json(files[name])):[];
    const precisions=new Map(read('data/activity-records.json').map(row=>[row.id,row.occurred_precision]));
    const videos=new Map(read('data/videos.json').map(v=>[v.video_id,v]));
    const runs=read('data/personal-taxonomy-runs.json');
    const active=runs.filter(r=>r.status==='active').sort((a,b)=>Number(b.taxonomy_version)-Number(a.taxonomy_version))[0]?.taxonomy_version;
    const definitions=read('data/personal-taxonomy.json');
    const version=active??(!runs.length?definitions.reduce((latest,t)=>Math.max(latest,Number(t.taxonomy_version)||0),0):null);
    const topics=new Map(definitions.filter(t=>t.taxonomy_version===version).map(t=>[t.id,text(t.name,80)]));
    const assignments=new Map<string,string[]>();
    for(const row of read('data/personal-topic-assignments.json')){
      if((row.decision&&row.decision!=='accepted')||!topics.has(row.topic_id))continue;
      const list=assignments.get(row.video_id)??[];
      const label=topics.get(row.topic_id)!;
      if(label&&!list.includes(label)&&list.length<3)list.push(label);
      assignments.set(row.video_id,list);
    }
    for(const row of read('data/watch-events.json')){
      seen++;if(row.activity_type&&row.activity_type!=='video')continue;
      const video=videos.get(row.video_id);
      const labels=assignments.get(row.video_id)??[];
      const parsed=event({videoId:videoId(row.video_id),title:text(row.raw_title)||text(video?.title)||'無法取得影片名稱',channel:text(row.channel_title,160)||text(video?.channel_title,160)||null,watchedAt:text(row.watched_at,80),actualSeconds:row.actual_watched_seconds,precision:precisions.get(row.activity_id)==='day'?'day':'exact',topics:labels,topicSource:labels.length?'urTube':null,source});
      if(parsed)events.push(parsed);
    }
  }else{
    for(const [name,content] of Object.entries(files)){
      if(!/watch-history\.(json|html)$|myactivity\.(json|html)$/i.test(name))continue;
      let raw:Record<string,any>[];
      try{raw=name.endsWith('.html')?array(parseHtml(content,name)):array(json(content));}catch(error){if(error instanceof MediaError)throw error;throw new MediaError('Takeout HTML 的日期或格式無法辨識，請改用 JSON 匯出。');}
      seen+=raw.length;
      for(const row of parseWatchActivities(raw)){
        if(row.activityType!=='video')continue;
        const parsed=event({videoId:row.videoId,title:row.title.slice(0,500),channel:row.channelTitle?.slice(0,160)??null,watchedAt:row.watchedAt,actualSeconds:null,precision:'exact',topics:[],topicSource:null,source});
        if(parsed)events.push(parsed);
      }
    }
  }
  if(events.length>200000)throw new MediaError('單次最多匯入 20 萬筆觀看紀錄，請分批匯出。');
  if(!events.length)throw new MediaError('找不到可辨識的 YouTube 觀看紀錄；搜尋紀錄不屬於觀看資料。');
  const unique=[...new Map(events.map(item=>[item.eventId,item])).values()];
  return {events:unique,source,skipped:seen-unique.length,hash:createHash('sha256').update(bytes).digest('hex')};
}
