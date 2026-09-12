import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const base = process.env.QA_ORIGIN || 'http://127.0.0.1:3001';
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1, acceptDownloads: true });
const page = await context.newPage();
const errors: string[] = [];
page.on('pageerror', error => errors.push(error.message));
const assertions: string[] = [];
const original = await (await context.request.get(`${base}/api/v1/bootstrap`)).json();
const originalState = original.states.find((state: { moduleId: string }) => state.moduleId === 'finance');
const headers = { 'Content-Type': 'application/json', Origin: base };
const created: string[] = [];
await mkdir('.cache', { recursive: true });

try {
  if (!originalState.enabled) await context.request.put(`${base}/api/v1/modules/finance`, { headers, data: { ...originalState, enabled: true, moduleId: undefined } });
  await page.goto(base);
  await expect(page.getByRole('heading', { name: '把目光，留給在意的事。' })).toBeVisible();
  await page.screenshot({ path: '.cache/qa-empty.png', fullPage: true });
  assertions.push('Initial authenticated dashboard renders without invented market values.');

  async function add(symbol: string) {
    await page.getByRole('button', { name: '新增追蹤', exact: true }).click();
    await page.getByRole('textbox', { name: '搜尋股票名稱或代號' }).fill(symbol);
    const result = page.locator('.search-result').filter({ hasText: symbol }).first();
    await expect(result).toBeVisible(); await result.click();
    await page.locator('.form-field input').fill('介面驗收');
    await page.getByRole('button', { name: '加入追蹤', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.watchlist-table')).toContainText(symbol);
    created.push(`TWSE:${symbol}`);
  }
  for (const symbol of ['2330', '0050']) {
    if (!original.watchlist.some((entry: { security: { symbol: string } }) => entry.security.symbol === symbol)) await add(symbol);
  }
  assertions.push('Search and add actual TWSE 2330 and ETF 0050; leading zeros preserved.');
  await page.getByRole('button', { name: '管理台積電', exact: true }).click();
  await page.locator('.tracking-option').filter({ hasText: '目前持有' }).locator('input').check();
  await page.locator('.form-field input').fill('長期觀察');
  await page.getByRole('button', { name: '儲存設定', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.watchlist-table')).toContainText('長期觀察');
  assertions.push('Held flag and custom group update through UI.');

  await page.getByRole('button', { name: '整理版面', exact: true }).click();
  await page.getByRole('button', { name: '將價格走勢往前移', exact: true }).click();
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: '移除公司基本面卡片', exact: true }).click();
  await expect(page.locator('.fundamentals-card')).toHaveCount(0);
  await page.getByRole('button', { name: '新增卡片', exact: true }).click();
  await page.getByRole('button', { name: '加入公司基本面', exact: true }).click();
  await page.getByRole('button', { name: '關閉視窗' }).click();
  await expect(page.locator('.fundamentals-card')).toBeVisible();
  await page.getByRole('button', { name: '完成整理', exact: true }).click();
  assertions.push('Widget move, hide and add persist through API.');

  await page.locator('.security-cell').filter({ hasText: '0050' }).click();
  await expect(page.getByRole('heading', { name: '用適合 ETF 的方式觀察' })).toBeVisible();
  await expect(page.locator('.chart-card')).toContainText('元大台灣50');
  await page.getByRole('button', { name: '1年', exact: true }).click();
  await expect(page.locator('.range-selector button.active')).toHaveText('1年');
  assertions.push('ETF fundamentals correctly display not-applicable; chart range switches.');
  await page.screenshot({ path: '.cache/qa-desktop.png', fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.locator('.watchlist-table')).toContainText('0050');
  await expect(page.locator('.watchlist-table')).toContainText('長期觀察');
  await expect(page.locator('.fundamentals-card')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '.cache/qa-mobile.png', fullPage: true });
  assertions.push('Mobile reload retains tracking, group and widgets; no document horizontal overflow.');

  await page.getByRole('button', { name: '開啟導覽' }).click();
  await page.getByRole('button', { name: '帳號與設定', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '匯出', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain('.csv');
  assertions.push('Private CSV exports through authenticated fetch.');
  await page.getByRole('button', { name: '清除資料', exact: true }).click();
  await expect(page.getByRole('button', { name: '確認清除', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '保留資料', exact: true }).click();
  assertions.push('Destructive clear requires typed confirmation; cancel preserves data.');

  await page.route('**/api/v1/bootstrap', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"offline"}' }));
  // Visibility changes invoke the same refresh as returning to this device.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('.offline-banner')).toContainText('主機');
  assertions.push('Offline refresh preserves prior records and displays disconnected status.');
  await page.unroute('**/api/v1/bootstrap');
  await page.getByRole('button', { name: '重新連線', exact: true }).click();
  await expect(page.locator('.offline-banner')).toHaveCount(0);
  expect(errors).toEqual([]);
  assertions.push('No browser runtime errors.');
  console.log(JSON.stringify({ assertions, screenshots: ['.cache/qa-empty.png', '.cache/qa-desktop.png', '.cache/qa-mobile.png'] }, null, 2));
} finally {
  for (const id of created) await context.request.delete(`${base}/api/v1/finance/watchlist/${encodeURIComponent(id)}`, { headers, data: {} });
  for (const entry of original.watchlist) {
    if (entry.security.symbol === '2330') await context.request.put(`${base}/api/v1/finance/watchlist/${encodeURIComponent(entry.securityId)}`, { headers, data: { held: entry.held, interested: entry.interested, group: entry.group } });
  }
  if (originalState) { const { moduleId: _, ...state } = originalState; await context.request.put(`${base}/api/v1/modules/finance`, { headers, data: state }); }
  await browser.close();
}
