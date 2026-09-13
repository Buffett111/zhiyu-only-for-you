(()=>{
  if(globalThis.zhiyuCaptureLoaded)return;globalThis.zhiyuCaptureLoaded=true;
  const send=message=>chrome.runtime.sendMessage(message);
  const history=globalThis.zhiyuYoutubeHistory;
  let settings={enabled:false},play=null,lastClock=performance.now(),lastMedia=0,scan=null,working=false;
  const banner=document.createElement('div');banner.style.cssText='position:fixed;right:18px;bottom:18px;max-width:350px;padding:15px;background:#edf2e5;color:#34482b;border:1px solid #aabb99;border-radius:12px;z-index:2147483647;font:13px/1.7 system-ui;box-shadow:0 4px 24px #0003;white-space:pre-line';
  function show(text){banner.textContent=`知隅 · YouTube 自動擷取\n${text}\n請保留此分頁；可在擴充功能暫停。`;if(!banner.isConnected)document.body.append(banner);}
  function currentId(){const u=new URL(location.href);const id=u.pathname==='/watch'?u.searchParams.get('v'):u.pathname.match(/^\/(?:shorts|live)\/([^/]+)/)?.[1];return /^[A-Za-z0-9_-]{11}$/.test(id??'')?id:null;}
  function title(){return (document.querySelector('ytd-watch-metadata h1, ytd-watch-flexy h1')?.textContent||document.title.replace(/\s*-\s*YouTube$/,'')||'YouTube 影片').trim().slice(0,500);}
  function channel(){return document.querySelector('ytd-watch-metadata ytd-channel-name a, #owner #channel-name a, ytd-reel-player-header-renderer #channel-name')?.textContent?.trim().slice(0,160)||null;}
  async function flushPlayback(){if(!play||play.seconds<5||Math.floor(play.seconds)<=play.sent)return;const active=play,seconds=Math.floor(active.seconds);const result=await send({type:'capture',kind:'playback',deviceId:active.deviceId,events:[{videoId:active.id,title:active.title,channel:active.channel,watchedAt:active.at,actualSeconds:seconds,precision:'exact'}]});if(result?.ok)active.sent=seconds;}
  async function playback(){
    const clock=performance.now(),elapsed=(clock-lastClock)/1000;lastClock=clock;
    if(!settings.enabled){play=null;lastMedia=0;return;}
    const id=currentId(),video=document.querySelector('video');
    if(play&&(play.id!==id||play.deviceId!==settings.deviceId)){await flushPlayback();play=null;lastMedia=0;}
    if(!id||!video)return;
    if(!play)play={id,at:new Date().toISOString(),seconds:0,sent:0,deviceId:settings.deviceId,title:title(),channel:channel()};
    const advance=video.currentTime-lastMedia;lastMedia=video.currentTime;
    const advertising=!!document.querySelector('.ad-showing,.ad-interrupting');
    if(!video.paused&&!video.ended&&!video.seeking&&video.readyState>=2&&!advertising&&advance>0&&advance<=elapsed*Math.max(1,video.playbackRate)+2&&elapsed>0&&elapsed<5)play.seconds=Math.min(86400,play.seconds+Math.min(elapsed,advance/Math.max(.1,video.playbackRate)));
    play.title=title();play.channel=channel();if(play.seconds-play.sent>=15||video.paused||video.ended)await flushPlayback();
  }
  async function done(reason){if(!scan)return;const finished=scan;scan=null;show(`${reason==='history-start'?'已讀到歷史起點':reason==='cutoff'?'近期新增紀錄已讀取':'擷取尚未完成：'+reason}\n最早已讀 ${finished.oldest||'未提供'} · ${finished.seen.size} 筆`);await send({type:'history-done',scanId:finished.id,reason,oldest:finished.oldest});}
  async function scanStep(){
    if(!settings.scan||!settings.enabled||location.pathname!=='/feed/history'){if(scan)show('擷取已暫停，恢復同步後繼續。');return;}
    if(!scan||scan.id!==settings.scan.id)scan={id:settings.scan.id,seen:new Set(),oldest:null,empty:0,started:Date.now(),lastAdvance:Date.now(),recovery:{lastAdvance:Date.now()},probeUp:false};
    const problem=history.historyPageProblem();if(problem){await done(problem);return;}
    const collected=history.collectProgress();
    const items=collected.filter(item=>item.watchedDate&&!scan.seen.has(`${item.videoId}|${item.watchedDate}`));
    if(items.length){
      for(let offset=0;offset<items.length;offset+=200){const part=items.slice(offset,offset+200);const oldest=part.reduce((at,item)=>!at||item.watchedDate<at?item.watchedDate:at,scan.oldest);
        const result=await send({type:'capture',kind:'history',scanId:scan.id,deviceId:settings.deviceId,oldest,events:part.map(item=>({videoId:item.videoId,title:item.title||'YouTube 影片',channel:item.channelTitle||null,watchedAt:history.dayTimestamp(item.watchedDate),actualSeconds:null,precision:'day',durationSeconds:item.durationSeconds,progressPercent:item.progressPercent,resumeSeconds:item.resumeSeconds}))});
        if(!result?.ok){show(`${result?.error||'等待主機同步'}\n最早已讀 ${scan.oldest||'未提供'}；會自動重試`);return;}
        for(const item of part)scan.seen.add(`${item.videoId}|${item.watchedDate}`);scan.oldest=oldest;scan.lastAdvance=Date.now();scan.empty=0;
      }
    }else scan.empty++;
    const recovery=history.recoveryStep(scan.recovery,{now:Date.now(),advanced:items.length>0,pending:history.historyCompletionReason()!=='history-start',hasItems:scan.seen.size>0,terminal:history.explicitHistoryEnd()});
    show(`已擷取 ${scan.seen.size} 筆 · 最早已讀 ${scan.oldest||'等待日期'}\n${recovery==='wait'||recovery==='probe'?`等待 YouTube 載入 · 已自動重試 ${scan.recovery.attempts||0} 次，將持續續抓`:`持續動態載入 HTML；本次${settings.scan.full?'完整歷史回補':'近期增量同步'}`}`);
    if(!settings.scan.full&&settings.scan.cutoff&&scan.oldest&&scan.oldest<settings.scan.cutoff){await done('cutoff');return;}
    if(recovery==='complete'){await done('history-start');return;}
    // Keep rendered DOM bounded while preserving page height and continuation loading.
    history.compactHistorySections(document,40);
    const continuation=[...document.querySelectorAll('ytd-continuation-item-renderer')].at(-1);
    if(recovery==='probe'){
      await send({type:'history-progress',scanId:scan.id,status:`等待 YouTube 載入 · 自動重試 ${scan.recovery.attempts} 次 · 最早 ${scan.oldest||'等待日期'} · 已擷取 ${scan.seen.size} 筆`});
      // Restrict clicks to continuation controls, never arbitrary history buttons.
      const retry=continuation?.querySelector('button:not([disabled]), [role="button"][tabindex="0"]');
      if(retry)retry.click();
      // Leave then re-enter the observer viewport on the next pulse. Repeated
      // scrollIntoView at exactly the same offset does not fire an intersection.
      window.scrollBy(0,-Math.max(800,window.innerHeight*1.5));scan.probeUp=true;return;
    }
    if(recovery==='wait'&&!scan.probeUp)return;
    scan.probeUp=false;
    if(continuation)continuation.scrollIntoView({block:'end'});else window.scrollTo(0,document.documentElement.scrollHeight);
  }
  async function pulse(){if(working)return;working=true;try{settings=await send({type:'capture-state'});await playback();await scanStep();}catch(e){if(scan)show('擴充功能暫時無法連線，請稍後或重新載入此頁。');}finally{working=false;}}
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')void flushPlayback().catch(()=>{});});
  document.addEventListener('yt-navigate-start',()=>void flushPlayback().catch(()=>{}));
  window.addEventListener('pagehide',()=>void flushPlayback().catch(()=>{}));
  setInterval(()=>void pulse(),2000);void pulse();
})();
