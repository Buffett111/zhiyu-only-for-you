import { SITE,ORIGINS } from './core.js';
const $=id=>document.getElementById(id);
$('open').href=`${SITE}/?module=media`;
async function command(type){const result=await chrome.runtime.sendMessage({type});if(!result?.ok)throw Error(result?.error||'操作失敗');await refresh();}
async function refresh(){const s=await chrome.runtime.sendMessage({type:'status'});$('consent').hidden=Boolean(s.bound);$('controls').hidden=!s.bound;$('pause').textContent=s.paused?'恢復同步':'暫停同步';$('status').textContent=[s.account?`已連接：${s.account}`:'尚未連接知隅',s.paused?'同步已暫停':s.bound?'自動同步中':'',`待同步 ${s.pending??0} 筆`,s.lastSync?`上次同步：${new Date(s.lastSync).toLocaleString()}`:'',s.historyStatus||'',s.error||''].filter(Boolean).join('\n');}
for(const [id,type] of [['sync','sync'],['history','history'],['pause','pause'],['disconnect','disconnect']])$(id).onclick=()=>void command(type).catch(e=>$('status').textContent=e.message);
$('connect').onclick=async()=>{try{const granted=await chrome.permissions.request({origins:ORIGINS});if(!granted)throw Error('尚未授權，不會讀取或同步紀錄。');await command('connect');}catch(e){$('status').textContent=e.message;}};
void refresh();
