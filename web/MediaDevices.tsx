import { useEffect,useRef,useState } from 'react';
import { Download,RefreshCw,ShieldCheck } from 'lucide-react';
type Device={id:string;label:string;createdAt:string;lastSync:string|null;revokedAt:string|null};
export function MediaDevices({onSync}:{onSync:()=>void}){
  const [devices,setDevices]=useState<Device[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState('');
  const callback=useRef(onSync);callback.current=onSync;
  const last=useRef('');
  async function refresh(){const response=await fetch('/api/v1/media/devices',{credentials:'same-origin',cache:'no-store'});if(!response.ok)throw Error('無法讀取連接裝置。');const body=await response.json();setDevices(body.devices);const signature=JSON.stringify(body.devices.map((d:Device)=>[d.id,d.lastSync,d.revokedAt]));if(last.current&&last.current!==signature)callback.current();last.current=signature;}
  useEffect(()=>{let active=true;const poll=()=>{if(active)void refresh().catch(e=>{if(active)setError(e.message);});};poll();const timer=window.setInterval(poll,15000);return()=>{active=false;window.clearInterval(timer);};},[]);
  async function revoke(id:string){setBusy(id);setError('');try{const response=await fetch(`/api/v1/media/devices/${id}/revoke`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:true})});if(!response.ok)throw Error('解除連接失敗，請稍後再試。');await refresh();}catch(e){setError((e as Error).message);}finally{setBusy('');}}
  const connected=devices.filter(device=>!device.revokedAt);
  return <section className="card media-extension"><div className="media-extension-title"><div><span className="eyebrow">YOUTUBE CAPTURE</span><h2>YouTube 自動同步</h2><p>授權一次，自動開啟觀看紀錄頁、持續載入 HTML，回補多年歷史並同步新觀看。</p></div><a className="button primary" href="/downloads/zhiyu-youtube-extension.zip" download><Download size={17}/>下載 Chrome 擴充功能</a></div>
    <details open={connected.length===0}><summary>{connected.length?'安裝其他裝置／更新擴充功能':'連接 Chrome 擴充功能'}</summary><ol className="media-setup"><li><strong>安裝擴充功能</strong><span>下載並解壓縮 ZIP，在 Chrome 的擴充功能管理頁開啟「開發人員模式」，選「載入未封裝項目」及解壓縮後的資料夾。</span></li><li><strong>授權並確認帳號</strong><span>開啟「知隅 YouTube Capture」，按「授權並連接知隅」，允許 YouTube 存取，再確認保存資料的知隅帳號。</span></li><li><strong>自動擷取歷史</strong><span>擴充功能會開啟 YouTube 觀看紀錄分頁。請確認 YouTube 帳號正確並保留分頁；它會持續捲動、分批保存，直到來源沒有更多紀錄。</span></li></ol></details>
    <p className="media-note"><ShieldCheck size={13}/> 只存 YouTube 影片紀錄，不讀 Chrome 全站瀏覽歷史。數年回補可能需要較長時間；載入緩慢會自動重試；關閉擷取分頁後，可重新回補並去重。手機可查看已同步結果；擷取需桌面 Chrome 執行。</p>
    <div className="media-card-heading"><h3>已連接的瀏覽器 · {connected.length}</h3><button className="text-button" onClick={()=>void refresh().catch(e=>setError(e.message))}><RefreshCw size={13}/>重新整理</button></div>
    {connected.length?<ul className="media-device-list">{connected.map(device=><li key={device.id}><div><strong>{device.label}</strong><small>最後同步：{device.lastSync?new Date(device.lastSync).toLocaleString('zh-TW'):'等待首次擷取'}</small></div><button className="button secondary" disabled={Boolean(busy)} onClick={()=>void revoke(device.id)}>解除連接</button></li>)}</ul>:<p className="media-empty">尚未連接擴充功能。完成上方步驟後，即可自動擷取，不需要手動匯入檔案。</p>}
    {error&&<p className="inline-error" role="alert">{error}</p>}
  </section>;
}
