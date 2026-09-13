import { SITE,ORIGINS,MAX_QUEUE,eventKey,mergeQueue,acknowledge,videoId } from './core.js';
const BRIDGE=`${SITE}/extension-sync.html`;
let mutation=Promise.resolve(),ticking=null;
const read=async()=>({queue:[],paused:true,history:{},...(await chrome.storage.local.get('state')).state});
function change(fn){const task=mutation.then(async()=>{const s=await read();const result=await fn(s);await chrome.storage.local.set({state:s});return result;});mutation=task.catch(()=>{});return task;}
async function session(){return chrome.storage.session.get(['bridgeTab','connectTab','connectExpires','historyTab']);}
const youtubeSender=sender=>!sender.tab?.incognito&&['https://www.youtube.com','https://m.youtube.com'].includes(new URL(sender.url||'https://invalid').origin)&&sender.frameId===0;
const bridgeSender=sender=>sender.frameId===0&&sender.url?.split('?')[0]===BRIDGE&&!sender.tab?.incognito;
const popupSender=sender=>sender.id===chrome.runtime.id&&!sender.tab&&sender.url===chrome.runtime.getURL('popup.html');
async function setError(error){await change(s=>{s.error=String(error).slice(0,250);});}
async function permissions(){return chrome.permissions.contains({origins:ORIGINS});}
async function prepare(){await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});await chrome.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});if(!await chrome.alarms.get('sync'))await chrome.alarms.create('sync',{periodInMinutes:1});
  if(await permissions()){
    const scripts=await chrome.scripting.getRegisteredContentScripts();if(!scripts.some(s=>s.id==='youtube-capture')){
      await chrome.scripting.registerContentScripts([{id:'youtube-capture',matches:ORIGINS,js:['history-dom.js','youtube.js'],runAt:'document_idle',persistAcrossSessions:true}]);
      for(const tab of await chrome.tabs.query({url:ORIGINS}))if(!tab.incognito)await chrome.scripting.executeScript({target:{tabId:tab.id},files:['history-dom.js','youtube.js']}).catch(()=>{});
    }
  }
}
async function bridge(active=false){const ids=await session();if(ids.bridgeTab){try{const tab=await chrome.tabs.get(ids.bridgeTab);if(active)await chrome.tabs.update(tab.id,{active:true});return tab.id;}catch{}}
  const tab=await chrome.tabs.create({url:BRIDGE,active});await chrome.storage.session.set({bridgeTab:tab.id});return tab.id;
}
async function sendBridge(action,body){const id=await bridge();try{if((await chrome.tabs.get(id)).url!==BRIDGE)throw Error('請在知隅連接分頁完成登入；登入後會自動續傳。');const result=await chrome.tabs.sendMessage(id,{type:'bridge-request',action,body});if(!result?.ok)throw Object.assign(Error(result?.error||'等待知隅登入分頁。'),{status:result?.status});return result.data;}catch(e){throw Object.assign(Error(e.message?.includes('Receiving end')?'請在知隅連接分頁完成登入；登入後會自動續傳。':e.message),{status:e.status});}}
async function connect(){if(!await permissions())throw Error('請先授權 YouTube 網站存取。');await prepare();const s=await read();if(s.binding)throw Error('請先解除目前帳號的綁定。');const tab=await chrome.tabs.create({url:BRIDGE,active:true});await chrome.storage.session.set({bridgeTab:tab.id,connectTab:tab.id,connectExpires:Date.now()+15*60000});}
async function beginHistory(full=false,active=false){const s=await read();if(!s.binding||s.paused||!await permissions())return;
  const ids=await session();if(ids.historyTab){try{await chrome.tabs.get(ids.historyTab);if(active)await chrome.tabs.update(ids.historyTab,{active:true});return;}catch{}}
  await change(v=>{v.history={...v.history,status:'正在開啟 YouTube 觀看紀錄頁',running:true,full:full||!v.history.fullComplete,scanId:crypto.randomUUID(),startedAt:Date.now()};});
  const tab=await chrome.tabs.create({url:'https://www.youtube.com/feed/history',active});await chrome.storage.session.set({historyTab:tab.id});
}
async function tick(){if(ticking)return ticking;ticking=(async()=>{
  await prepare();let s=await read();if(s.paused||!s.binding||!await permissions()||s.retryAt>Date.now())return;
  if(s.queue.length){const binding=s.binding,items=s.queue.slice(0,200);try{await sendBridge('sync',{deviceId:binding.deviceId,token:binding.token,events:items});await change(current=>{if(current.binding?.deviceId!==binding.deviceId)return;current.queue=acknowledge(current.queue,items);current.lastSync=new Date().toISOString();current.error='';current.retryAt=0;});}catch(e){await change(v=>{v.error=e.message;v.retryAt=Date.now()+(e.status===429?60000:15000);if([400,403,409].includes(e.status))v.paused=true;});return;}}
  s=await read();if(s.binding&&!s.paused&&(!s.history.lastRun||Date.now()-s.history.lastRun>86400000))await beginHistory(!s.history.fullComplete,false);
})().catch(e=>setError(e.message)).finally(()=>ticking=null);return ticking;}

async function handle(message,sender){
  if(sender.id!==chrome.runtime.id)throw Error('來源不明。');
  if(popupSender(sender)){
    if(message.type==='status'){const s=await read();return {bound:Boolean(s.binding),account:s.binding?.account,paused:s.paused,pending:s.queue.length,lastSync:s.lastSync,error:s.error,historyStatus:s.history.status};}
    if(message.type==='connect'){await connect();return {ok:true};}
    if(message.type==='sync'){await bridge(true);void tick();return {ok:true};}
    if(message.type==='history'){await change(s=>{s.history.lastRun=0;s.history.fullComplete=false;});await beginHistory(true,true);return {ok:true};}
    if(message.type==='pause'){await change(s=>{s.paused=!s.paused;s.error='';});void tick();return {ok:true};}
    if(message.type==='disconnect'){
      const s=await read();await change(v=>{v.paused=true;v.binding=null;v.queue=[];v.history={};v.error='已解除本機綁定。若主機離線，請稍後在網站撤銷裝置。';});
      if(s.binding)try{await sendBridge('revoke',{deviceId:s.binding.deviceId});}catch{}
      await chrome.permissions.remove({origins:ORIGINS});await chrome.scripting.unregisterContentScripts({ids:['youtube-capture']}).catch(()=>{});return {ok:true};
    }
  }
  if(bridgeSender(sender)){
    const ids=await session();if(sender.tab.id!==ids.bridgeTab)throw Error('不是目前的連接分頁。');
    if(message.type==='bridge-ready'){const s=await read();void tick();return {bound:Boolean(s.binding),connect:ids.connectTab===sender.tab.id&&ids.connectExpires>Date.now()&&!s.binding};}
    if(message.type==='paired'){
      if(ids.connectTab!==sender.tab.id||ids.connectExpires<Date.now())throw Error('連接已逾時，請從擴充功能重試。');
      const d=message.data;if(!/^[a-f0-9]{64}$/.test(d?.token??'')||!d?.deviceId||!d?.userId)throw Error('連接格式無效。');
      await change(s=>{if(s.binding)throw Error('已有綁定，請先解除。');s.binding=d;s.queue=[];s.paused=false;s.history={};s.error='';});await chrome.storage.session.remove(['connectTab','connectExpires']);await beginHistory(true,true);void tick();return {ok:true};
    }
  }
  if(youtubeSender(sender)){
    const s=await read(),ids=await session();
    if(message.type==='capture-state')return {enabled:!!s.binding&&!s.paused&&await permissions(),deviceId:s.binding?.deviceId,scan:sender.tab.id===ids.historyTab?{id:s.history.scanId,full:s.history.full,cutoff:s.history.lastCompletedAt?new Date(s.history.lastCompletedAt-2*86400000).toISOString().slice(0,10):null}:null};
    if(message.type==='capture'){
      if(!s.binding||s.paused||message.deviceId!==s.binding.deviceId||!await permissions())return {ok:false,error:'已暫停或解除綁定。'};
      if(!Array.isArray(message.events)||message.events.length>200)throw Error('批次大小不正確。');
      if(message.kind==='history'&&sender.tab.id!==ids.historyTab)throw Error('不是擷取中的歷史頁。');
      if(message.kind!=='history'&&message.events.some(e=>e.videoId!==videoId(sender.url)))throw Error('影片不符合目前分頁。');
      await change(current=>{if(current.paused||current.binding?.deviceId!==message.deviceId)throw Error('已停止同步。');current.queue=mergeQueue(current.queue,message.events);});
      if(message.kind==='history')await change(current=>{if(current.history.scanId!==message.scanId)return;current.history={...current.history,oldest:message.oldest||current.history.oldest,status:`擷取中 · 最早已讀 ${message.oldest||'確認日期中'} · 待同步 ${current.queue.length} 筆`};});
      void tick();return {ok:true,pending:(await read()).queue.length};
    }
    if(message.type==='history-done'&&sender.tab.id===ids.historyTab){
      await change(current=>{if(current.history.scanId!==message.scanId)return;const complete=['history-start','cutoff'].includes(message.reason);current.history={...current.history,running:false,lastRun:Date.now(),lastCompletedAt:complete?Date.now():current.history.lastCompletedAt,fullComplete:message.reason==='history-start'?true:current.history.fullComplete,status:complete?`歷史擷取完成 · 最早 ${message.oldest||'未提供'}`:`擷取未完成（${message.reason}）· 最早 ${message.oldest||'未提供'}；可按重新回補續抓`};});
      await chrome.storage.session.remove('historyTab');return {ok:true};
    }
  }
  throw Error('不允許這個操作。');
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{void handle(message,sender).then(reply).catch(e=>reply({ok:false,error:e.message}));return true;});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='sync')void tick();});
chrome.runtime.onStartup.addListener(()=>void tick());
chrome.runtime.onInstalled.addListener(()=>void prepare());
chrome.permissions.onRemoved.addListener(()=>void change(s=>{s.paused=true;s.error='YouTube 權限已撤銷，停止擷取與同步。';}));
chrome.tabs.onRemoved.addListener(id=>void(async()=>{const ids=await session();if(id===ids.historyTab){await chrome.storage.session.remove('historyTab');await change(s=>{s.history.running=false;s.history.status=`擷取分頁已關閉 · 最早 ${s.history.oldest||'未提供'}；下次將重新載入並去重續抓`;s.history.lastRun=Date.now();});}if(id===ids.bridgeTab)await chrome.storage.session.remove('bridgeTab');})());
void prepare();
