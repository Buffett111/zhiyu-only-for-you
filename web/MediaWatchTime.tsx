import type {MediaEvent} from '../shared/media';
import {formatMediaDuration,formatMediaProgress} from '../shared/media-time';

export function MediaWatchTime({item}:{item:Pick<MediaEvent,'actualSeconds'|'estimatedSeconds'|'durationSeconds'|'progressPercent'|'resumeSeconds'>}){
 const measured=item.actualSeconds!=null,estimated=item.estimatedSeconds!=null;
 const noPosition=!measured&&!estimated&&(item.progressPercent===0||item.resumeSeconds===0);
 return <small className="media-watch-time">{measured?`實測觀看 ${formatMediaDuration(item.actualSeconds)}`:estimated?`歷史進度推估 ${formatMediaDuration(item.estimatedSeconds)}`:'觀看時長未知'}{noPosition?' · 來源位置為 0，不能代表未觀看':''}{item.durationSeconds!=null&&item.durationSeconds>0?` · 影片長度 ${formatMediaDuration(item.durationSeconds)}`:''}{item.progressPercent!=null?` · 來源進度 ${formatMediaProgress(item.progressPercent)}`:''}</small>;
}
