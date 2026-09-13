import {createElement} from 'react';
import {it,expect} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {MediaTimeMetric} from '../web/MediaTimeMetric';

it('shows missing measurements as unavailable instead of zero hours',()=>{
 const html=renderToStaticMarkup(createElement(MediaTimeMetric,{summary:{recordedSeconds:null,timedEvents:0}}));
 expect(html).toContain('尚無實測資料');expect(html).toContain('<strong>—</strong>');expect(html).not.toContain('0.0');
});
it('distinguishes a measured zero from missing data and does not round short watches to zero',()=>{
 expect(renderToStaticMarkup(createElement(MediaTimeMetric,{summary:{recordedSeconds:0,timedEvents:1}}))).toContain('0 秒');
 const html=renderToStaticMarkup(createElement(MediaTimeMetric,{summary:{recordedSeconds:45,timedEvents:1}}));
 expect(html).toContain('&lt;0.1');expect(html).toContain('45 秒');
});
