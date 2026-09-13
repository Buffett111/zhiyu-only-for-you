import type { ModuleDefinition, ModuleState } from './types';
export const financeModule: ModuleDefinition = { id: 'finance', name: '財經', description: '追蹤台股、美股與日股，每天留意你關心的市場變化。', version: '1.5.0', configVersion: 1, icon: 'chart', routes: ['/finance'], jobs: ['market.sync', 'international.sync', 'news.sync', 'history.backfill', 'digest.generate', 'fundamentals.sync'], widgets: [
  { id: 'digest', name: '每日摘要', description: '把追蹤標的今天的變化，整理成一份閱讀筆記。' },
  { id: 'watchlist', name: '我的追蹤', description: '持有與感興趣的股票、ETF，集中在這裡。' },
  { id: 'chart', name: '價格走勢', description: '日收盤走勢與成交量，查看近十年的變化與實際涵蓋期間。' },
  { id: 'news', name: '新聞與公告', description: '閱讀相關新聞與公司公告，附上原始出處。' },
  { id: 'fundamentals', name: '公司基本面', description: '台股月營收、美日季度與年度財報，保留來源幣別及期間。' }
] };
export const mediaModule: ModuleDefinition = {id:'media',name:'影音分析',description:'從 urTube 與 YouTube 觀看紀錄，回顧常看的頻道、主題與興趣變化。',version:'1.0.0',configVersion:1,icon:'video',routes:['/media'],jobs:[],widgets:[
  {id:'overview',name:'觀看概況',description:'觀看次數、影片與有紀錄的觀看時間。'},
  {id:'channels',name:'常看頻道',description:'比較不同時期常看的創作者。'},
  {id:'topics',name:'興趣主題',description:'沿用 urTube 分類，按需補充 AI 分析。'},
  {id:'history',name:'觀看紀錄',description:'搜尋自己的影片紀錄。'}
]};
export const modules: ModuleDefinition[] = [financeModule,mediaModule];
export function defaultModuleState(moduleId = 'finance'): ModuleState { const module=modules.find(item=>item.id===moduleId);if(!module)throw new Error('Unknown module');return { moduleId, enabled: moduleId==='finance', configVersion: module.configVersion, config: {}, widgets: module.widgets.map(w => w.id) }; }
export function migrateModuleState(state: ModuleState): ModuleState {
  const module=modules.find(item=>item.id===state.moduleId);
  if (!module) throw new Error('Unknown module');
  if (state.configVersion > module.configVersion) throw new Error('Unsupported future module configuration');
  const valid = new Set(module.widgets.map(w => w.id));
  return { ...state, configVersion: module.configVersion, config: state.config || {}, widgets: [...new Set((state.widgets || defaultModuleState(state.moduleId).widgets).filter(w => valid.has(w)))] };
}
