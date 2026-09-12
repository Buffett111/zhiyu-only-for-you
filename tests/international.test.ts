import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChartResultArray } from 'yahoo-finance2/modules/chart';
import type { Security, Quote } from '../shared/types';
import { internationalSessionDate } from '../shared/markets';
import { createYahooClient, normalizeYahooHistory, securityFromYahoo } from '../server/providers/yahoo';
import { createPool, migrate } from '../server/db';
import { buildApp } from '../server/app';
import { loadConfig } from '../server/config';
import { buildDigest, createJobHandlers, enqueueHistory, type JobProviders } from '../server/jobs';

const now = new Date('2026-09-12T05:00:00Z');
const us: Security = { id: 'NASDAQ:AAPL', symbol: 'AAPL', name: 'Apple', market: 'NASDAQ', currency: 'USD', assetType: 'stock', aliases: [], sourceUrl: 'https://finance.yahoo.com/quote/AAPL/', active: true };
const jp: Security = { ...us, id: 'TSE:1306', symbol: '1306', name: 'TOPIX ETF', market: 'TSE', currency: 'JPY', assetType: 'etf', sourceUrl: 'https://finance.yahoo.com/quote/1306.T/' };
const quote = (security: Security, date = '2026-09-11'): Quote => ({ securityId: security.id, date, open: 100, high: 102, low: 99, close: 101, volume: 12345, change: 1, changePercent: 1, source: security.sourceUrl, fetchedAt: now.toISOString(), priceType: 'eod', adjustment: 'split_adjusted', dataset: 'history', status: 'traded' });
const chart = (security: Security): ChartResultArray => ({ meta: { symbol: security.market === 'TSE' ? `${security.symbol}.T` : security.symbol, currency: security.currency, exchangeName: security.market === 'TSE' ? 'JPX' : 'NMS', exchangeTimezoneName: security.market === 'TSE' ? 'Asia/Tokyo' : 'America/New_York', instrumentType: security.assetType === 'etf' ? 'ETF' : 'EQUITY' }, quotes: [{ date: new Date('2026-09-10T13:30:00Z'), open: 100, high: 102, low: 99, close: 100, volume: 1000, adjclose: 90 }, { date: new Date('2026-09-11T13:30:00Z'), open: 100, high: 102, low: 99, close: 101, volume: 2000, adjclose: 91 }] } as ChartResultArray);

describe('Yahoo symbol, price and transport boundaries', () => {
  it('keeps Japan leading zeros and distinguishes ADRs, ETFs and unsupported instruments', () => {
    expect(securityFromYahoo({ symbol: '0130.T', exchange: 'JPX', quoteType: 'ETF' }, 'JP')).toMatchObject({ id: 'TSE:0130', symbol: '0130', currency: 'JPY', assetType: 'etf' });
    expect(securityFromYahoo({ symbol: '130A.T', exchange: 'JPX', quoteType: 'EQUITY' }, 'JP')?.symbol).toBe('130A');
    expect(securityFromYahoo({ symbol: 'TM', exchange: 'NYQ', quoteType: 'EQUITY' }, 'JP')).toBeNull();
    expect(securityFromYahoo({ symbol: 'AAPL', exchange: 'NMS', quoteType: 'OPTION' }, 'US')).toBeNull();
    expect(securityFromYahoo({ symbol: 'BRK-B', exchange: 'NYQ', quoteType: 'EQUITY' }, 'US')?.symbol).toBe('BRK-B');
  });
  it('preserves split-adjusted close without silently substituting dividend-adjusted prices', () => {
    const result = normalizeYahooHistory(us, chart(us), now);
    expect(result.items[0]).toMatchObject({ close: 100, change: null, adjustment: 'split_adjusted' });
    expect(result.items[1]).toMatchObject({ close: 101, change: 1, changePercent: 1, date: '2026-09-11' });
  });
  it('rejects mismatched currency instead of labeling USD prices JPY', () => {
    const value = chart(jp); value.meta.currency = 'USD';
    expect(() => normalizeYahooHistory(jp, value, now)).toThrow('幣別');
  });
  it('excludes today during trading and during the delay grace period', () => {
    const value = chart(us);
    value.meta.currentTradingPeriod = { regular: { start: new Date('2026-09-11T13:30:00Z'), end: new Date('2026-09-11T20:00:00Z'), gmtoffset: -14400, timezone: 'EDT' } } as ChartResultArray['meta']['currentTradingPeriod'];
    expect(normalizeYahooHistory(us, value, new Date('2026-09-11T18:00:00Z')).items).toHaveLength(1);
    expect(normalizeYahooHistory(us, value, new Date('2026-09-11T20:29:00Z')).items).toHaveLength(1);
    expect(normalizeYahooHistory(us, value, new Date('2026-09-11T20:30:00Z')).items).toHaveLength(2);
  });
  it('does not turn missing closes into zero or interpolate missing rows', () => {
    const value = chart(us); value.quotes[0].close = null;
    const result = normalizeYahooHistory(us, value, now);
    expect(result.items).toHaveLength(1); expect(result.items[0].change).toBeNull(); expect(result.warnings).not.toHaveLength(0);
  });
  it('uses New York daylight saving and the Japan clock for session expectations', () => {
    expect(internationalSessionDate('NASDAQ', new Date('2026-09-11T21:29:00Z'))).toBe('2026-09-10');
    expect(internationalSessionDate('NASDAQ', new Date('2026-09-11T21:30:00Z'))).toBe('2026-09-11');
    expect(internationalSessionDate('NASDAQ', new Date('2026-12-11T22:29:00Z'))).toBe('2026-12-10');
    expect(internationalSessionDate('TSE', new Date('2026-09-11T07:30:00Z'))).toBe('2026-09-11');
  });
  it('retains extreme source prices but flags the discontinuity and withholds a misleading daily return', () => {
    const value = chart(us); value.quotes[1] = { ...value.quotes[1], open: 10, high: 11, low: 9, close: 10 };
    const result = normalizeYahooHistory(us, value, now);
    expect(result.items[1]).toMatchObject({ close: 10, change: null, changePercent: null });
    expect(result.items[1].qualityWarning).toContain('待核對'); expect(result.warnings).not.toHaveLength(0);
  });
  it('stops after a 429 without changing hosts or exposing raw response content', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('PRIVATE-UPSTREAM-CONTENT', { status: 429, headers: { 'retry-after': '300' } }));
    const client = createYahooClient(transport);
    await expect(client.chart('AAPL', { period1: '2026-09-01' })).rejects.toThrow('HTTP 429');
    await expect(client.chart('MSFT', { period1: '2026-09-01' })).rejects.toThrow('暫停');
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('does not write a later US session into the prior Taipei evening digest', () => {
    const result = buildDigest({ date: '2026-09-11', now, expectedDate: '2026-09-11', securities: [us], quotes: [quote(us), quote(us, '2026-09-10')], news: [], financialUpdates: [], sourceWarnings: [] });
    expect(result.items[0].body).toContain('2026-09-10'); expect(result.items[0].body).toContain('USD'); expect(result.missing).toBe(0);
  });
  it('queues one international refresh instead of thirteen Taiwan history queries', async () => {
    const send = vi.fn().mockResolvedValue('job'); await enqueueHistory({ send }, jp.id, now);
    expect(send).toHaveBeenCalledTimes(1); expect(send.mock.calls[0][0]).toBe('international.sync');
  });
});

describe('international API and PostgreSQL integration', () => {
  const schema = `international_test_${randomUUID().replaceAll('-', '')}`;
  const admin = createPool(process.env.DATABASE_URL!);
  const url = new URL(process.env.DATABASE_URL!); url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = createPool(url.href);
  const origin = 'https://test.example.workers.dev';
  const config = loadConfig({ APP_MODE: 'development', DATABASE_URL: url.href, PUBLIC_ORIGIN: origin });
  const userA = randomUUID(), userB = randomUUID();
  let app: Awaited<ReturnType<typeof buildApp>>;
  const yahooSearch = vi.fn(async () => [us]);
  const fetchHistory = vi.fn(async (security: Security) => ({ items: [quote(security, '2026-09-10'), quote(security)], dataDate: '2026-09-11', warnings: [] }));
  const providers: JobProviders = { fetchInternationalHistory: fetchHistory, fetchMarketSnapshot: async () => { throw new Error('Taiwan must not be called'); }, fetchHistory: async () => { throw new Error('Taiwan must not be called'); }, fetchFundamentals: async () => ({ items: [], warnings: [] }), fetchNews: async () => ({ items: [], warnings: [] }) };
  beforeAll(async () => { await admin.query(`CREATE SCHEMA "${schema}"`); await migrate(pool); app = await buildApp({ pool, config, logger: false, yahooSearch, verifyIdentity: async request => ({ email: request.headers['x-person'] === 'a' ? 'a@example.org' : 'b@example.org', displayName: 'test', role: 'member' }) }); });
  beforeEach(async () => {
    await pool.query('TRUNCATE users,securities,watchlist,user_modules,quotes,history_progress,source_runs,digests,fundamentals,fundamental_versions,scheduler_state CASCADE');
    for (const [id, email] of [[userA, 'a@example.org'], [userB, 'b@example.org']]) { await pool.query('INSERT INTO users(id,email,display_name) VALUES($1,$2,$2)', [id, email]); await pool.query("INSERT INTO user_modules(user_id,module_id) VALUES($1,'finance')", [id]); }
    for (const security of [us, jp]) await pool.query('INSERT INTO securities(id,symbol,name,market,asset_type,currency,source_url) VALUES($1,$2,$3,$4,$5,$6,$7)', [security.id, security.symbol, security.name, security.market, security.assetType, security.currency, security.sourceUrl]);
    fetchHistory.mockClear(); yahooSearch.mockClear();
  });
  afterAll(async () => { await app?.close(); await pool.end(); if (!/^international_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe schema'); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); });
  it('migrates existing schemas idempotently and rejects a wrong currency', async () => { await migrate(pool); await expect(pool.query("UPDATE securities SET currency='TWD' WHERE id='NASDAQ:AAPL'")).rejects.toThrow(); });
  it('searches only the requested market and represents unavailable fundamentals honestly', async () => {
    expect((await app.inject({ url: '/api/v1/finance/securities?region=US&q=AAPL' })).json()[0]).toMatchObject({ id: us.id, currency: 'USD' });
    expect((await app.inject({ url: '/api/v1/finance/securities?region=TW&q=AAPL' })).json()).toEqual([]);
    expect((await app.inject({ url: '/api/v1/finance/securities?region=US' })).json()).toEqual([]);
    expect(yahooSearch).toHaveBeenCalledTimes(1);
    expect((await app.inject({ url: '/api/v1/finance/securities/NASDAQ%3AAAPL' })).json().fundamentals.availability).toBe('unsupported');
    expect((await app.inject({ url: '/api/v1/finance/securities/TSE%3A1306' })).json().fundamentals.availability).toBe('not_applicable');
  });
  it('persists USD tracking across reloads without leaking it to another account', async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/v1/finance/watchlist/NASDAQ%3AAAPL', headers: { 'x-person': 'a', origin, 'content-type': 'application/json' }, payload: { held: true, interested: true, group: 'US' } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/v1/finance/watchlist', headers: { 'x-person': 'a' } })).json()[0]).toMatchObject({ held: true, group: 'US', security: { currency: 'USD' } });
    expect((await app.inject({ url: `/api/v1/finance/watchlist?userId=${userA}` })).json()).toEqual([]);
  });
  it('fetches a shared symbol once and keeps its source values after a restart', async () => {
    for (const userId of [userA, userB]) await pool.query('INSERT INTO watchlist(user_id,security_id) VALUES($1,$2)', [userId, us.id]);
    await createJobHandlers(pool, providers).syncInternational(now);
    await createJobHandlers(pool, providers).syncInternational(new Date(now.getTime() + 5000));
    expect(fetchHistory).toHaveBeenCalledTimes(1);
    expect(Number((await pool.query('SELECT count(*) FROM quotes')).rows[0].count)).toBe(2);
    expect((await pool.query('SELECT data FROM quotes LIMIT 1')).rows[0].data.adjustment).toBe('split_adjusted');
  });
  it('retains quotes when Yahoo fails and does not poll disabled modules', async () => {
    await pool.query('INSERT INTO watchlist(user_id,security_id) VALUES($1,$2)', [userA, us.id]);
    await createJobHandlers(pool, providers).syncInternational(now);
    const broken: JobProviders = { ...providers, fetchInternationalHistory: async () => { throw new Error('Yahoo HTTP 429'); } };
    await createJobHandlers(pool, broken).syncInternational(new Date('2026-09-15T01:00:00Z'));
    expect(Number((await pool.query('SELECT count(*) FROM quotes')).rows[0].count)).toBe(2);
    expect((await pool.query("SELECT status FROM source_runs WHERE id='yahoo.US'")).rows[0].status).toBe('error');
    await pool.query('UPDATE user_modules SET enabled=false'); fetchHistory.mockClear();
    await createJobHandlers(pool, providers).syncInternational(new Date('2026-09-16T01:00:00Z')); expect(fetchHistory).not.toHaveBeenCalled();
  });
});
