import type {MediaSummary} from '../shared/media';

export function MediaTimeMetric({summary}:{summary:Pick<MediaSummary,'recordedSeconds'|'timedEvents'>}){
 const seconds=summary.recordedSeconds;
 const value=seconds===null?'—':seconds>0&&seconds<360?'<0.1':(seconds/3600).toFixed(1);
 return <div><small>實測觀看時數</small><strong>{value}</strong><span>{seconds===null?'尚無實測資料':`${summary.timedEvents.toLocaleString('zh-TW')} 筆播放器計時 · ${seconds<3600?Math.round(seconds)+' 秒':(seconds/3600).toFixed(1)+' 小時'}`}</span></div>;
}
