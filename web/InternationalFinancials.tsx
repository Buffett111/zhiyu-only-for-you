import { useEffect, useState } from 'react';
import type { ContentProgress, FinancialReport, Security } from '../shared/types';
import { translationLink, type TranslationTarget } from '../shared/translation';

export function InternationalFinancials({ security, reports, progress, target }: { security: Security; reports: FinancialReport[]; progress?: ContentProgress; target: TranslationTarget }) {
 const [basis,setBasis] = useState<'quarter'|'annual'>('quarter'), [period,setPeriod] = useState('');
 useEffect(()=>{ setBasis(reports.some(row=>row.basis==='quarter') ? 'quarter' : 'annual'); setPeriod(''); },[security.id]);
 const available = reports.filter(row=>row.basis===basis).sort((a,b)=>b.periodEnd.localeCompare(a.periodEnd));
 const report = available.find(row=>row.periodEnd===period) ?? available[0];
 const amount = (value: number|null) => value === null ? '—' : (value/1000000).toLocaleString('zh-TW',{maximumFractionDigits:2});
 const number = (value: number|null) => value === null ? '—' : value.toLocaleString('zh-TW',{maximumFractionDigits:2});
 return <div className="international-financials">
  <div className="fundamentals-company"><strong>{security.name}</strong><span>{security.symbol}</span></div>
  <div className="tabs report-tabs"><button aria-pressed={basis==='quarter'} className={basis==='quarter'?'active':''} onClick={()=>{setBasis('quarter');setPeriod('');}}>季度</button><button aria-pressed={basis==='annual'} className={basis==='annual'?'active':''} onClick={()=>{setBasis('annual');setPeriod('');}}>年度</button></div>
  {progress && ['error','partial'].includes(progress.status) && <p className="inline-error">{progress.error || '部分財報資料待補'}{reports.length>0 && ' 以下保留已取得資料。'}</p>}
  {!report ? <div className="financial-empty"><h3>{progress?.status==='error'?'財報來源暫時無法取得':'財報資料準備中'}</h3><p>加入追蹤後會下載來源可提供的季度及年度報表；缺項不補成零。</p></div> : <>
   <label className="report-period">財報期末<select aria-label="財報期末" value={report.periodEnd} onChange={event=>setPeriod(event.target.value)}>{available.map(row=><option key={row.periodEnd} value={row.periodEnd}>{row.periodEnd}</option>)}</select></label>
   <p className="report-unit">金額：{report.currency} 百萬；EPS：{report.currency}／股</p>
   <p className="report-unit">損益、現金流為截至 {report.periodEnd} 的 {basis==='quarter'?'3':'12'} 個月；資產負債為期末值。</p>
   <table className="financial-table"><tbody>
    <tr className="financial-section"><th colSpan={2}>損益表</th></tr>
    {([['營收',report.revenue],['毛利',report.grossProfit],['營業利益',report.operatingIncome],['淨利',report.netIncome]] as const).map(([label,value])=><tr key={label}><th>{label}</th><td>{amount(value)}</td></tr>)}
    <tr><th>{report.epsType==='basic'?'基本':'稀釋'}每股盈餘 EPS</th><td>{number(report.eps)}</td></tr>
    <tr><th>毛利率</th><td>{number(report.grossMargin)}{report.grossMargin!==null&&'%'}</td></tr>
    <tr><th>營業利益率</th><td>{number(report.operatingMargin)}{report.operatingMargin!==null&&'%'}</td></tr>
    <tr className="financial-section"><th colSpan={2}>資產負債表</th></tr>
    {([['總資產',report.totalAssets],['總負債（不含非控制權益）',report.totalLiabilities],['股東權益',report.totalEquity]] as const).map(([label,value])=><tr key={label}><th>{label}</th><td>{amount(value)}</td></tr>)}
    <tr className="financial-section"><th colSpan={2}>現金流量表</th></tr>
    <tr><th>營業現金流</th><td>{amount(report.operatingCashFlow)}</td></tr><tr><th>自由現金流</th><td>{amount(report.freeCashFlow)}</td></tr>
   </tbody></table>
   <p className="report-unit">「—」代表來源缺項。幣別依財報來源，可能與掛牌交易幣別不同；毛利率與營益率由同一期數值計算。</p>
   <div className="translation-links"><a href={report.sourceUrl} target="_blank" rel="noopener noreferrer">Yahoo 財報原文 ↗</a><a href={translationLink(report.sourceUrl,target,'website')} target="_blank" rel="noopener noreferrer">Google 翻譯原文 ↗</a></div>
   <p className="report-unit">取得於 {new Date(report.fetchedAt).toLocaleDateString('zh-TW',{timeZone:'Asia/Taipei'})}</p>
  </>}
 </div>;
}
