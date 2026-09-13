// Runs only in the authenticated, same-origin bridge page. Never accepts page messages or arbitrary URLs.
(()=>{
  const status=document.getElementById('status');if(!status)return;
  const send=message=>chrome.runtime.sendMessage(message);
  async function api(path,body){const response=await fetch(`/api/v1/media/${path}`,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const isJson=(response.headers.get('content-type')||'').includes('application/json');const data=isJson?await response.json():{};if(!response.ok||!isJson)throw Object.assign(Error(data.error||'請重新登入知隅後再同步。'),{status:response.status});return data;}
  chrome.runtime.onMessage.addListener((message,sender,reply)=>{
    if(sender.id!==chrome.runtime.id||message.type!=='bridge-request')return;
    const run=async()=>{try{let data;if(message.action==='sync')data=await api('extension/sync',message.body);else if(message.action==='revoke')data=await api(`devices/${message.body.deviceId}/revoke`,{confirm:true});else throw Error('不支援的動作');reply({ok:true,data});}catch(e){reply({ok:false,error:e.message,status:e.status||0});}};void run();return true;
  });
  async function start(){const info=await send({type:'bridge-ready'});if(!info?.connect){status.textContent=info?.bound?'自動同步已連接。這個分頁可保留在背景，讓擴充功能透過目前登入安全同步。':'沒有待處理的連接，請從擴充功能開始。';return;}
    const response=await fetch('/api/v1/me',{cache:'no-store',credentials:'same-origin'});if(!response.ok)throw Error('請先登入知隅。');const me=await response.json();status.textContent=`即將連接：${me.email}`;document.getElementById('connect').hidden=false;
    document.getElementById('confirm').onclick=async()=>{const button=document.getElementById('confirm');button.disabled=true;try{const data=await api('devices',{confirm:true,label:document.getElementById('label').value.trim()||'我的 Chrome'});const result=await send({type:'paired',data});if(!result?.ok)throw Error(result?.error||'連接失敗');document.getElementById('connect').hidden=true;status.textContent='已連接。正在自動回補並同步 YouTube 紀錄，稍後可回到影音看板查看。';}catch(e){status.textContent=e.message;button.disabled=false;}};
  }
  void start().catch(e=>status.textContent=e.message);
})();
