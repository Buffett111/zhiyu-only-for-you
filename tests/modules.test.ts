import { describe, it, expect } from 'vitest';
import { defaultModuleState, migrateModuleState } from '../shared/modules';
describe('module compatibility', () => {
  it('preserves user order, removes obsolete widgets and upgrades legacy config', () => {
    expect(migrateModuleState({ ...defaultModuleState(), configVersion: 0, widgets: ['news', 'chart', 'retired', 'news'], enabled: false })).toMatchObject({ enabled: false, configVersion: 1, widgets: ['news', 'chart'] });
  });
  it('does not silently reinterpret a future configuration', () => { expect(() => migrateModuleState({ ...defaultModuleState(), configVersion: 2 })).toThrow('future'); });
});
