import './news-analysis.css';
import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Sparkles } from 'lucide-react';
import type { AnalysisPoint, NewsAnalysisState, NewsScope } from '../shared/types';

export function NewsAnalysisPanel({ securityId, kind, scope }: { securityId: string; kind: 'news'|'announcement'; scope: NewsScope }) {
  const [state,setState]=useState<NewsAnalysisState|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const alive=useRef(true);
  const path=`/api/v1/finance/securities/${encodeURIComponent(securityId)}/news-analysis`;
  async function load(method:'GET'|'POST',signal?:AbortSignal) {
    const response=await fetch(method==='GET'?`${path}?kind=${kind}&scope=${scope}`:path,{method,credentials:'same-origin',cache:'no-store',signal,...(method==='POST'?{headers:{'Content-Type':'application/json'},body:JSON.stringify({kind,scope})}:{})});
    if (!(response.headers.get('content-type')??'').includes('application/json')) throw new Error('無法取得 AI 分析，請確認登入或連線狀態。');
    const body=await response.json();
    if(!response.ok)throw new Error(body.error??'AI 分析暫時無法使用。');
    return body as NewsAnalysisState;
  }
  useEffect(()=>{
    alive.current=true;
    const controller=new AbortController();
    void load('GET',controller.signal).then(value=>setState(value)).catch(err=>{if(!controller.signal.aborted)setError(err.message);});
    return ()=>{alive.current=false;controller.abort();};
  },[securityId,kind,scope]);
  useEffect(()=>{
    if(state?.status!=='pending')return;
    const controller=new AbortController();
    const timer=window.setInterval(()=>{void load('GET',controller.signal).then(value=>setState(value)).catch(err=>{if(!controller.signal.aborted)setError(err.message);});},3000);
    return ()=>{window.clearInterval(timer);controller.abort();};
  },[state?.status,securityId,kind,scope]);
  async function generate(){
    setBusy(true);setError('');
    try{const next=await load('POST');if(alive.current)setState(next);}
    catch(err){if(alive.current)setError(err instanceof Error?err.message:'分析未完成。');}
    finally{if(alive.current)setBusy(false);}
  }
  const analysis=state?.analysis;
  const waiting=busy||state?.status==='pending';
  const point=(item:AnalysisPoint,index:number)=><li key={index}>{item.text}<span className="ai-citations">{item.sourceIds.map(id=>{const source=analysis?.sources.find(s=>s.id===id);return source?<a key={id} href={source.url} target="_blank" rel="noopener noreferrer" title={`${source.source}｜${source.title}`}>[{id.slice(1)}]</a>:null;})}</span></li>;
  return <div className="ai-news-panel" aria-busy={waiting}>
    <div className="ai-news-heading"><strong><Sparkles size={17}/> AI 摘要與分析</strong><button type="button" onClick={()=>void generate()} disabled={!state?.enabled||waiting||!state.selectedCount}>{waiting?<><LoaderCircle size={14} className="spin"/> 分析中…</>:analysis?'檢查並更新摘要':'產生摘要'}</button></div>
    <p className="ai-news-note">近 7 日・最多 30 則・以新聞標題分析，未讀取全文。只傳送公開新聞至 OpenAI；結果存入資料庫，相同內容共用快取。</p>
    {!state&& !error&&<p className="ai-news-note">讀取已保存的分析…</p>}
    {state&&!state.enabled&&<p className="ai-news-note">AI 服務尚未啟用，請站長檢查金鑰或每日額度設定。</p>}
    {state?.enabled&&!state.selectedCount&&<p className="ai-news-note">近七日此分類沒有可分析的消息。</p>}
    {(error||state?.error)&&<p role="alert" className="inline-error">{error||state?.error}</p>}
    {state?.stale&&<p className="ai-news-note">新聞內容已有變動，以下為先前保存的分析。</p>}
    {analysis&&<div className="ai-news-result">
      <ul className="ai-overview">{point(analysis.overview,0)}</ul>
      {([['報導重點',analysis.facts],['可能影響（推論）',analysis.implications],['待查證與觀察',analysis.watchpoints]] as const).map(([title,points])=>points.length>0&&<div key={title}><h4>{title}</h4><ul>{points.map(point)}</ul></div>)}
      <details><summary>查看本次 {analysis.sources.length} 則來源</summary><ol>{analysis.sources.map(source=><li key={source.id}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a><small>{source.source} · {new Date(source.publishedAt).toLocaleDateString('zh-TW')} · {({direct:'標的本身',constituent:'成分股',market:'市場背景'} as Record<string,string>)[source.relation]??source.relation}</small></li>)}</ol></details>
      <p className="ai-news-note">{analysis.model} · {new Date(analysis.generatedAt).toLocaleString('zh-TW')} · 輸入 {analysis.usage.inputTokens.toLocaleString()}／輸出 {analysis.usage.outputTokens.toLocaleString()} tokens<br/>AI 可能誤讀標題；請以原文及正式公告核實，不宜單憑此摘要做投資決策。</p>
    </div>}
  </div>;
}
