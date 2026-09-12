import type { ModuleDefinition, ModuleState } from './types';
export const financeModule: ModuleDefinition = { id: 'finance', name: '財經', description: '追蹤台股、美股與日股，每天留意你關心的市場變化。', version: '1.2.0', configVersion: 1, icon: 'chart', routes: ['/finance'], jobs: ['market.sync', 'international.sync', 'news.sync', 'history.backfill', 'digest.generate', 'fundamentals.sync'], widgets: [
  { id: 'digest', name: '每日摘要', description: '把追蹤標的今天的變化，整理成一份閱讀筆記。' },
  { id: 'watchlist', name: '我的追蹤', description: '持有與感興趣的股票、ETF，集中在這裡。' },
  { id: 'chart', name: '價格走勢', description: '日收盤走勢與成交量，查看近一年的變化。' },
  { id: 'news', name: '新聞與公告', description: '閱讀相關新聞與公司公告，附上原始出處。' },
  { id: 'fundamentals', name: '公司基本面', description: '台股月營收、美日季度與年度財報，保留來源幣別及期間。' }
] };
export const modules: ModuleDefinition[] = [financeModule];
export function defaultModuleState(): ModuleState { return { moduleId: 'finance', enabled: true, configVersion: 1, config: {}, widgets: financeModule.widgets.map(w => w.id) }; }
export function migrateModuleState(state: ModuleState): ModuleState {
  if (state.moduleId !== 'finance') throw new Error('Unknown module');
  if (state.configVersion > financeModule.configVersion) throw new Error('Unsupported future module configuration');
  const valid = new Set(financeModule.widgets.map(w => w.id));
  return { ...state, configVersion: 1, config: state.config || {}, widgets: [...new Set((state.widgets || defaultModuleState().widgets).filter(w => valid.has(w)))] };
}
