import {createElement} from 'react';
import {it,expect} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {MediaTimeMetric} from '../web/MediaTimeMetric';
import {MediaWatchTime} from '../web/MediaWatchTime';
import {formatMediaDuration,formatMediaProgress} from '../shared/media-time';

it('shows missing measurements as unavailable instead of zero hours',()=>{
 const html=renderToStaticMarkup(createElement(MediaTimeMetric,{summary:{recordedSeconds:null,timedEvents:0}}));
 expect(html).toContain('尚無實測資料');expect(html).toContain('<strong>—</strong>');expect(html).not.toContain('0.0');
});
it('preserves seconds for short videos and minutes for short channel totals and ETAs',()=>{
 expect(formatMediaDuration(12)).toBe('12 秒');
 expect(formatMediaDuration(84)).toBe('1 分鐘 24 秒');
 expect(formatMediaDuration(60)).toBe('1 分鐘');
 expect(formatMediaDuration(3660)).toBe('1 小時 1 分鐘');
 expect(formatMediaDuration(.3)).toBe('不到 1 秒');
 expect(formatMediaDuration(null)).toBe('時長未知');
 expect(formatMediaDuration(0)).toBe('0 秒');
 expect(formatMediaProgress(.02)).toBe('<0.1%');
 expect(formatMediaProgress(.4)).toBe('0.4%');
});
it('does not render positive watch time or video length as zero minutes',()=>{
 const html=renderToStaticMarkup(createElement(MediaWatchTime,{item:{actualSeconds:null,estimatedSeconds:12,durationSeconds:27,progressPercent:.4,resumeSeconds:null}}));
 expect(html).toContain('推估 12 秒');expect(html).toContain('影片長度 27 秒');expect(html).toContain('0.4%');expect(html).not.toContain('0 分鐘');
});
it('explains a zero source position as unknown while preserving measured zero',()=>{
 const item={actualSeconds:null,estimatedSeconds:null,durationSeconds:600,progressPercent:0,resumeSeconds:0};
 const html=renderToStaticMarkup(createElement(MediaWatchTime,{item}));
 expect(html).toContain('觀看時長未知');expect(html).toContain('不能代表未觀看');expect(html).not.toContain('推估 0');
 expect(renderToStaticMarkup(createElement(MediaWatchTime,{item:{...item,actualSeconds:0,estimatedSeconds:0}}))).toContain('實測觀看 0 秒');
});
it('distinguishes a measured zero from missing data and does not round short watches to zero',()=>{
 expect(renderToStaticMarkup(createElement(MediaTimeMetric,{summary:{recordedSeconds:0,timedEvents:1}}))).toContain('0 秒');
 const html=renderToStaticMarkup(createElement(MediaTimeMetric,{summary:{recordedSeconds:45,timedEvents:1}}));
 expect(html).toContain('&lt;0.1');expect(html).toContain('45 秒');
});
