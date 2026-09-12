/** Real Yahoo -> isolated PostgreSQL -> API/browser check. Never writes to public. */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { chromium, expect, type Browser, type Page } from '@playwright/test';
import { createPool, migrate } from '../server/db';
import { loadConfig } from '../server/config';
import { buildApp } from '../server/app';
import { createJobHandlers, latestDigestDate, safeError, type JobProviders } from '../server/jobs';
import { fetchInternationalHistory } from '../server/providers/yahoo';
import type { Security, WatchlistEntry, Quote } from '../shared/types';

const samples = [{ region: 'US', query: 'AAPL', id: 'NASDAQ:AAPL', currency: 'USD', type: 'stock' },
  { region: 'US', query: 'SPY', id: 'NYSEARCA:SPY', currency: 'USD', type: 'etf' },
  { region: 'JP', query: '7203', id: 'TSE:7203', currency: 'JPY', type: 'stock' },
  { region: 'JP', query: '1306', id: 'TSE:1306', currency: 'JPY', type: 'etf' }] as const;
const schema = `yahoo_verify_${randomUUID().replaceAll('-', '')}`;
const url = new URL(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '');
const admin = createPool(url.href);
url.searchParams.set('options', `-c search_path=${schema}`);
const pool = createPool(url.href);
const base = 'http://127.0.0.1:3003';
const config = loadConfig({ APP_MODE: 'development', DATABASE_URL: url.href, PUBLIC_ORIGIN: base, PORT: '3003' });
let app: Awaited<ReturnType<typeof buildApp>> | undefined, browser: Browser | undefined, page: Page | undefined, created = false;
const calls: string[] = [], queued: string[] = [], errors: string[] = [];
const providers: JobProviders = {
  fetchInternationalHistory: async (security, now) => { calls.push(security.id); return fetchInternationalHistory(security, now); },
  fetchMarketSnapshot: async () => { throw new Error('Unexpected Taiwan request'); },
  fetchHistory: async () => { throw new Error('Unexpected Taiwan request'); },
  fetchNews: async () => ({ items: [], warnings: [] }), fetchFundamentals: async () => ({ items: [], warnings: [] })
};
const report: Record<string, unknown> = { verifiedAt: new Date().toISOString(), isolatedSchema: true, ok: false, cleanedUp: false };
try {
  await admin.query(`CREATE SCHEMA "${schema}"`); created = true;
  await migrate(pool); await migrate(pool);
  assert.equal((await pool.query('SELECT current_schema() AS name')).rows[0].name, schema);
  app = await buildApp({ pool, config, logger: false, queue: { send: async name => { queued.push(name); } },
    verifyIdentity: async request => ({ email: request.headers['x-person'] === 'b' ? 'yahoo-b@example.invalid' : 'yahoo-a@example.invalid', displayName: '行情驗證', role: 'member' }) });
  const headers = { origin: base, 'content-type': 'application/json' };
  for (const sample of samples) {
    const response: { statusCode: number; json<T>(): T } = await app.inject({ url: `/api/v1/finance/securities?region=${sample.region}&q=${sample.query}` });
    assert.equal(response.statusCode, 200, 'Live Yahoo search failed');
    const security = response.json<Security[]>().find(item => item.id === sample.id);
    assert.equal(security?.currency, sample.currency); assert.equal(security?.assetType, sample.type);
  }
  if (process.argv.includes('--ui')) {
    await app.listen({ host: '127.0.0.1', port: 3003 });
    browser = await chromium.launch({ headless: true, ...(process.env.QA_CHROME_PATH ? { executablePath: process.env.QA_CHROME_PATH } : { channel: 'chrome' }) });
    page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    for (const sample of samples) {
      await page.getByRole('button', { name: '新增追蹤', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: sample.region === 'US' ? '美股' : '日股', exact: true }).click();
      await dialog.getByRole('textbox', { name: '搜尋股票名稱或代號' }).fill(sample.query);
      const result = dialog.locator('.search-result').filter({ hasText: sample.query }).first();
      await expect(result).toBeVisible({ timeout: 15000 }); await result.click();
      await dialog.locator('.form-field input').fill('三市場驗證');
      await dialog.getByRole('button', { name: '加入追蹤', exact: true }).click();
      await expect(dialog).toHaveCount(0);
    }
  } else {
    for (const sample of samples) assert.equal((await app.inject({ method: 'PUT', url: `/api/v1/finance/watchlist/${encodeURIComponent(sample.id)}`, headers, payload: { held: false, interested: true, group: '三市場驗證' } })).statusCode, 200);
  }
  assert.equal(queued.filter(name => name === 'international.sync').length, 4);
  assert.equal(queued.filter(name => name === 'history.backfill').length, 0);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/finance/watchlist/NASDAQ%3AAAPL', headers: { ...headers, 'x-person': 'b' }, payload: { held: true, interested: true, group: 'B' } })).statusCode, 200);
  const now = new Date(), jobs = createJobHandlers(pool, providers);
  report.sources = await jobs.syncInternational(now);
  assert.deepEqual(new Set(calls), new Set(samples.map(sample => sample.id))); assert.equal(calls.length, 4);
  const entries = (await app.inject({ url: '/api/v1/finance/watchlist' })).json<WatchlistEntry[]>();
  report.samples = [];
  for (const sample of samples) {
    const entry = entries.find(item => item.securityId === sample.id)!;
    assert.equal(entry.security.currency, sample.currency); assert.equal(entry.quote?.adjustment, 'split_adjusted');
    const history: { quotes: Quote[]; coverage: { from: string; to: string } } = (await app.inject({ url: `/api/v1/finance/securities/${encodeURIComponent(sample.id)}/history?range=1y` })).json();
    assert.ok(history.quotes.length > 150, `${sample.id} history unexpectedly short`);
    assert.equal(new Set(history.quotes.map((q: { date: string }) => q.date)).size, history.quotes.length);
    const detail: { fundamentals: { availability: string } } = (await app.inject({ url: `/api/v1/finance/securities/${encodeURIComponent(sample.id)}` })).json();
    assert.equal(detail.fundamentals.availability, sample.type === 'etf' ? 'not_applicable' : 'unsupported');
    (report.samples as unknown[]).push({ id: sample.id, currency: sample.currency, bars: history.quotes.length, from: history.coverage.from, to: history.coverage.to });
  }
  await createJobHandlers(pool, providers).syncInternational(new Date(now.getTime() + 1000));
  assert.equal(calls.length, 4, 'Restart duplicated a source request');
  const digestDate = latestDigestDate(now);
  await jobs.generateDigests(now, digestDate); await jobs.generateDigests(now, digestDate);
  const digests = (await pool.query('SELECT data FROM digests')).rows;
  assert.equal(digests.length, 2); assert.deepEqual(digests.map(row => row.data.tracked).sort(), [1, 4]);
  const b = (await app.inject({ url: '/api/v1/finance/watchlist?userId=someone-else', headers: { 'x-person': 'b' } })).json<WatchlistEntry[]>();
  assert.deepEqual(b.map(entry => entry.securityId), ['NASDAQ:AAPL']);
  if (page && browser) {
    await mkdir('.cache', { recursive: true });
    await page.reload();
    const markets = page.locator('[aria-label="追蹤市場"]');
    await markets.getByRole('button', { name: '日股', exact: true }).click();
    await expect(page.locator('.watchlist-table tbody tr')).toHaveCount(2);
    await page.locator('.security-cell').filter({ hasText: '7203' }).click();
    await expect(page.locator('.chart-card')).toContainText('JPY');
    await expect(page.locator('.chart-card')).toContainText('拆股調整');
    await expect(page.locator('.fundamentals-card')).toContainText('尚未');
    await expect(page.locator('.news-card')).toContainText('尚未');
    await page.locator('.security-cell').filter({ hasText: '1306' }).click();
    await expect(page.getByRole('heading', { name: '用適合 ETF 的方式觀察' })).toBeVisible();
    await page.getByRole('button', { name: '1年', exact: true }).click();
    await expect(page.locator('.chart-card svg[role="img"]')).toBeVisible();
    await page.screenshot({ path: '.cache/qa-yahoo-desktop.png', fullPage: true });
    await markets.getByRole('button', { name: '美股', exact: true }).click();
    await expect(page.locator('.watchlist-table tbody tr')).toHaveCount(2);
    await page.locator('.security-cell').filter({ hasText: 'AAPL' }).click();
    await expect(page.locator('.chart-card')).toContainText('USD');
    await markets.getByRole('button', { name: '台股', exact: true }).click();
    await expect(page.locator('.watchlist-table tbody tr')).toHaveCount(0);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.locator('.chart-card')).not.toContainText('AAPL');
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    mobile.on('pageerror', error => errors.push(error.message)); await mobile.goto(base);
    await expect(mobile.locator('.watchlist-table tbody tr')).toHaveCount(4);
    assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await mobile.screenshot({ path: '.cache/qa-yahoo-mobile.png', fullPage: true });
    const other = await browser.newPage({ extraHTTPHeaders: { 'x-person': 'b' } }); await other.goto(base);
    await expect(other.locator('.watchlist-table tbody tr')).toHaveCount(1);
    await expect(other.locator('.watchlist-table')).toContainText('AAPL');
    assert.deepEqual(errors, []); report.ui = { desktop: 1440, mobile: 390, crossDevice: true, separateAccounts: true, runtimeErrors: 0 };
  }
  report.providerCalls = calls.length; report.uniqueDigests = digests.length; report.ok = true;
} catch (error) { report.error = safeError(error); process.exitCode = 1; }
finally {
  await browser?.close(); await app?.close(); await pool.end();
  try { if (created) { assert.match(schema, /^yahoo_verify_[a-f0-9]{32}$/); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } report.cleanedUp = true; }
  finally { await admin.end(); }
}
console.log(JSON.stringify(report, null, 2));
