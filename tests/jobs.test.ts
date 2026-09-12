import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg, { type Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fundamentals, NewsItem, Quote, Security } from '../shared/types.js';
import { buildDigest, catchupNeeded, createJobHandlers, enqueueHistory, expectedSessionDate, fundamentalFingerprint, GLOBAL_JOB_KEY, historyMonths, latestDigestDate, preserveLatestFundamentals, safeError, taipeiParts, type JobProviders } from '../server/jobs.js';

const instant = new Date('2026-09-11T13:00:00Z'); // Friday, Taipei 21:00.
const security: Security = { id: 'TWSE:0050', symbol: '0050', name: '元大台灣50', market: 'TWSE', assetType: 'etf', currency: 'TWD', aliases: [], sourceUrl: 'https://www.twse.com.tw/' };
const company: Security = { ...security, id: 'TWSE:2330', symbol: '2330', name: '台積電', assetType: 'stock', aliases: ['台積電'] };
const quote: Quote = { securityId: security.id, date: '2026-09-11', open: 100, high: 102, low: 99, close: 101, volume: 1000, change: 1, changePercent: 1, source: 'TWSE', fetchedAt: instant.toISOString(), priceType: 'eod', status: 'traded' };
const financial: Fundamentals = { securityId: company.id, asOf: '2026-09-11', revenuePeriod: '2026-08', earningsPeriod: '2026-Q2', basis: 'cumulative', revenue: 100000, revenueYoy: 10, eps: 2.5, grossMargin: 20, operatingMargin: 10, unit: '新台幣千元', sourceUrl: 'https://mops.twse.com.tw/', availability: 'available' };
const news: NewsItem = { id: 'n1', title: '台積電公布新資料', url: 'https://www.cna.com.tw/news/example.aspx', publishedAt: instant.toISOString(), source: '中央社', kind: 'news', securityIds: [company.id], matchType: 'exact' };

describe('Taipei schedules and restart catch-up', () => {
  it('uses Taipei midnight independent of the host timezone', () => {
    expect(taipeiParts(new Date('2026-09-11T16:10:00Z'))).toEqual({ date: '2026-09-12', hour: 0, minute: 10, weekday: 6 });
  });
  it('does not expect the current session before the 16:30 update', () => {
    expect(expectedSessionDate(new Date('2026-09-14T08:29:00Z'))).toBe('2026-09-11');
    expect(expectedSessionDate(new Date('2026-09-14T08:30:00Z'))).toBe('2026-09-14');
  });
  it('skips known exchange holidays and weekends, but does not invent a weekday holiday', () => {
    expect(expectedSessionDate(new Date('2026-09-12T14:00:00Z'))).toBe('2026-09-11');
    expect(expectedSessionDate(new Date('2026-09-14T14:00:00Z'), new Set(['2026-09-14']))).toBe('2026-09-11');
    expect(expectedSessionDate(new Date('2026-09-14T14:00:00Z'))).toBe('2026-09-14');
  });
  it('coalesces a multi-day outage into the latest due digest only', () => {
    const restart = new Date('2026-09-14T10:00:00Z');
    expect(latestDigestDate(restart)).toBe('2026-09-13');
    expect(catchupNeeded({ 'digest.generate': instant.toISOString(), 'news.sync': instant.toISOString(), 'market.sync': instant.toISOString() }, restart))
      .toEqual(['market.sync', 'news.sync', 'digest.generate']);
    expect(catchupNeeded({ 'digest.generate': restart.toISOString(), 'news.sync': restart.toISOString(), 'market.sync': restart.toISOString() }, restart)).toEqual([]);
  });
  it('honors explicit weekend opening days while confirmed closures take priority', () => {
    const now = new Date('2026-09-12T14:00:00Z');
    const open = new Set(['2026-09-12']);
    expect(expectedSessionDate(now, new Set(), open)).toBe('2026-09-12');
    expect(expectedSessionDate(now, new Set(['2026-09-12']), open)).toBe('2026-09-11');
  });
  it('catches up the next daily summary at exactly 20:30', () => {
    expect(latestDigestDate(new Date('2026-09-14T12:29:59Z'))).toBe('2026-09-13');
    expect(latestDigestDate(new Date('2026-09-14T12:30:00Z'))).toBe('2026-09-14');
  });
  it('catches a missed 16:30 run even if startup already synced earlier that same morning', () => {
    const morning = '2026-09-14T01:00:00Z';
    const restart = new Date('2026-09-14T09:00:00Z');
    expect(catchupNeeded({ 'market.sync': morning, 'news.sync': restart.toISOString(), 'digest.generate': restart.toISOString() }, restart)).toEqual(['market.sync']);
  });
  it('requests thirteen calendar months to cover a rolling year', () => {
    const months = historyMonths(instant);
    expect(months).toHaveLength(13);
    expect(months[0]).toBe('2026-09');
    expect(months.at(-1)).toBe('2025-09');
    expect(new Set(months).size).toBe(13);
  });
});

describe('honest, private digest calculations', () => {
  const input = () => ({ date: '2026-09-11', now: instant, expectedDate: '2026-09-11', securities: [security], quotes: [quote], news: [], financialUpdates: [], sourceWarnings: [] });
  it('never counts a stale close as a current gain or no trade as unchanged', () => {
    const result = buildDigest({ ...input(), securities: [security, company], quotes: [{ ...quote, date: '2026-09-10' }, { ...quote, securityId: company.id, status: 'no_trade', change: 0, volume: 0 }] });
    expect(result).toMatchObject({ tracked: 2, up: 0, unchanged: 0, missing: 2, partial: true });
    expect(result.items[0].body).toContain('尚待');
    expect(result.items[1].body).toContain('無成交');
  });
  it('uses the latest quote on or before the requested date', () => {
    const result = buildDigest({ ...input(), quotes: [{ ...quote, date: '2026-09-14', change: -3 }, quote] });
    expect(result).toMatchObject({ up: 1, down: 0, missing: 0, partial: false });
  });
  it('filters another user’s securities and deduplicates exact article IDs', () => {
    const result = buildDigest({ ...input(), securities: [company], quotes: [{ ...quote, securityId: company.id }], news: [news, news, { ...news, id: 'other', securityIds: ['TPEx:6488'] }, { ...news, id: 'market', matchType: 'market' }, { ...news, id: 'old', publishedAt: '2026-09-10T13:00:00Z' }] });
    expect(result.items.filter(item => item.title.startsWith('新聞'))).toHaveLength(1);
    expect(result.items.some(item => item.securityId === 'TPEx:6488')).toBe(false);
  });
  it('marks source failures as partial even when prices are present', () => {
    expect(buildDigest({ ...input(), sourceWarnings: ['新聞來源更新失敗'] })).toMatchObject({ missing: 0, partial: true });
  });
  it('treats a changed financial period or value as a change, not a fetch date', () => {
    expect(fundamentalFingerprint(financial)).toBe(fundamentalFingerprint({ ...financial, asOf: '2026-09-12' }));
    expect(fundamentalFingerprint(financial)).not.toBe(fundamentalFingerprint({ ...financial, earningsPeriod: '2026-Q3' }));
    expect(fundamentalFingerprint(financial)).not.toBe(fundamentalFingerprint({ ...financial, eps: 2.6 }));
  });
  it('retains the last known financial period during missing or older upstream responses', () => {
    expect(preserveLatestFundamentals(financial, { ...financial, revenuePeriod: null, earningsPeriod: null, revenue: null, eps: null, asOf: '', availability: 'missing' })).toEqual(financial);
    expect(preserveLatestFundamentals(financial, { ...financial, revenuePeriod: '2026-09', revenue: 120000, earningsPeriod: null, eps: null })).toMatchObject({ revenuePeriod: '2026-09', revenue: 120000, earningsPeriod: '2026-Q2', eps: 2.5 });
    expect(preserveLatestFundamentals(financial, { ...financial, revenuePeriod: '2026-07', revenue: 80000 })).toMatchObject({ revenuePeriod: '2026-08', revenue: 100000 });
  });
  it('redacts credentials and upstream query parameters from diagnostic errors', () => {
    expect(safeError(new Error('Connection postgres://bob:secret@localhost/db failed https://host/?token=abc password=xyz'))).not.toMatch(/secret|abc|xyz|bob/);
  });
});

// These are real PostgreSQL tests. They create a random schema and never clear application tables.
const testUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
describe.skipIf(!testUrl)('PostgreSQL persistence, deduplication and restart recovery', () => {
  let pool: Pool;
  let admin: Pool;
  const schema = `jobs_test_${randomUUID().replaceAll('-', '')}`;
  const userA = '11111111-1111-4111-8111-111111111111';
  const userB = '22222222-2222-4222-8222-222222222222';
  const userC = '33333333-3333-4333-8333-333333333333';
  const providers: JobProviders = {
    fetchMarketSnapshot: vi.fn(async market => ({ securities: market === 'TWSE' ? [security, company] : [{ ...company, id: 'TPEx:6488', symbol: '6488', market: 'TPEx' as const }], quotes: market === 'TWSE' ? [quote, { ...quote, securityId: company.id }] : [{ ...quote, securityId: 'TPEx:6488' }], dataDate: '2026-09-11', warnings: [] })),
    fetchFundamentals: vi.fn(async () => ({ items: [financial], warnings: [] })),
    fetchNews: vi.fn(async () => ({ items: [news], warnings: [] })),
    fetchHistory: vi.fn(async () => ({ items: [quote], warnings: [] })),
    fetchTradingCalendar: vi.fn(async () => ({ items: [], warnings: [] })),
  };
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: testUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ connectionString: testUrl, options: `-c search_path=${schema},public`, max: 8 });
    await pool.query(await readFile(new URL('../server/migrations/001_initial.sql', import.meta.url), 'utf8'));
  });
  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); }
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    await pool.query('TRUNCATE users,securities,news,source_runs,scheduler_state CASCADE');
    await pool.query(`INSERT INTO users(id,email,display_name) VALUES($1,'a@example.invalid','A'),($2,'b@example.invalid','B'),($3,'c@example.invalid','C')`, [userA, userB, userC]);
    await pool.query(`INSERT INTO user_modules(user_id,module_id,enabled) VALUES($1,'finance',true),($2,'finance',true),($3,'finance',false)`, [userA, userB, userC]);
    await createJobHandlers(pool, providers).syncMarket(instant);
  });
  it('shares market rows across users and fetches the watchlist union once', async () => {
    await pool.query('INSERT INTO watchlist(user_id,security_id) VALUES($1,$4),($2,$4),($3,$5)', [userA, userB, userC, company.id, security.id]);
    const jobs = createJobHandlers(pool, providers);
    await jobs.syncFundamentals(instant);
    expect(providers.fetchFundamentals).toHaveBeenLastCalledWith([expect.objectContaining({ id: company.id })]);
    await jobs.syncMarket(instant);
    expect(Number((await pool.query('SELECT count(*) AS count FROM quotes')).rows[0].count)).toBe(3);
  });
  it('restarts without repeating completed historical months, preserving leading zero IDs', async () => {
    await pool.query('INSERT INTO watchlist(user_id,security_id) VALUES($1,$2)', [userA, security.id]);
    await createJobHandlers(pool, providers).backfillHistory(security.id, '2026-09', instant);
    await createJobHandlers(pool, providers).backfillHistory(security.id, '2026-09', instant);
    expect(providers.fetchHistory).toHaveBeenCalledTimes(1);
    expect((await pool.query('SELECT security_id,status FROM history_progress')).rows).toEqual([{ security_id: 'TWSE:0050', status: 'complete' }]);
  });
  it('deduplicates financial updates, news and daily digests, preserving read status', async () => {
    await pool.query('INSERT INTO watchlist(user_id,security_id) VALUES($1,$2)', [userA, company.id]);
    const jobs = createJobHandlers(pool, providers);
    await jobs.syncFundamentals(instant); await jobs.syncFundamentals(instant);
    await jobs.syncNews(instant); await jobs.syncNews(instant);
    await jobs.generateDigests(instant);
    await pool.query('UPDATE digests SET read_at=now() WHERE user_id=$1', [userA]);
    await createJobHandlers(pool, providers).generateDigests(instant);
    expect(Number((await pool.query('SELECT count(*) AS count FROM fundamental_versions')).rows[0].count)).toBe(1);
    expect(Number((await pool.query('SELECT count(*) AS count FROM news')).rows[0].count)).toBe(1);
    const result = await pool.query('SELECT user_id,data,read_at FROM digests ORDER BY user_id');
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].read_at).not.toBeNull();
    expect(result.rows[0].data.tracked).toBe(1);
    expect(result.rows[1].data.tracked).toBe(0);
    expect(result.rows[1].data.items).toEqual([]);
  });
  it('rolls back an invalid snapshot and keeps the preceding market data', async () => {
    const broken: JobProviders = { ...providers, fetchMarketSnapshot: async () => ({ securities: [{ ...company, name: 'should rollback' }], quotes: [{ ...quote, securityId: 'missing-security' }], dataDate: '2026-09-11', warnings: [] }) };
    const result = await createJobHandlers(pool, broken).syncMarket(instant);
    expect(result.every(item => item.status === 'error')).toBe(true);
    expect((await pool.query('SELECT name FROM securities WHERE id=$1', [company.id])).rows[0].name).toBe(company.name);
    expect(Number((await pool.query('SELECT count(*) AS count FROM quotes')).rows[0].count)).toBe(3);
  });
  it('never overwrites precise daily snapshot data with a later historical fetch', async () => {
    await pool.query('INSERT INTO watchlist(user_id,security_id) VALUES($1,$2)', [userA, security.id]);
    const historical: JobProviders = { ...providers, fetchHistory: async () => ({ items: [{ ...quote, fetchedAt: '2026-09-12T13:00:00Z', changePercent: null, volume: null }], warnings: [] }) };
    await createJobHandlers(pool, historical).backfillHistory(security.id, '2026-09', instant);
    expect((await pool.query('SELECT data FROM quotes WHERE security_id=$1', [security.id])).rows[0].data).toMatchObject({ volume: 1000, changePercent: 1, dataset: 'snapshot' });
  });
  it('retains an exact article association when a subsequent sync has a different watchlist union', async () => {
    await createJobHandlers(pool, providers).syncNews(instant);
    await createJobHandlers(pool, { ...providers, fetchNews: async () => ({ items: [{ ...news, securityIds: [], matchType: 'market' }], warnings: [] }) }).syncNews(instant);
    expect((await pool.query('SELECT data FROM news WHERE id=$1', [news.id])).rows[0].data).toMatchObject({ securityIds: [company.id], matchType: 'exact' });
  });
  it('coalesces per-month history jobs and retains one follow-up digest while the first is active', async () => {
    const boss = new PgBoss({ connectionString: testUrl, schema, schedule: false, supervise: false });
    try {
      await boss.start();
      await boss.createQueue('history.backfill', { policy: 'exclusive' });
      await enqueueHistory(boss, security.id, instant);
      await enqueueHistory(boss, security.id, instant);
      expect((await boss.findJobs('history.backfill')).length).toBe(13);
      await boss.createQueue('digest.generate', { policy: 'stately' });
      const first = await boss.send('digest.generate', {}, { singletonKey: GLOBAL_JOB_KEY });
      expect(first).not.toBeNull();
      expect(await boss.send('digest.generate', {}, { singletonKey: GLOBAL_JOB_KEY })).toBeNull();
      expect((await boss.fetch('digest.generate')).map(job => job.id)).toEqual([first]);
      const followup = await boss.send('digest.generate', {}, { singletonKey: GLOBAL_JOB_KEY });
      expect(followup).not.toBeNull();
      expect(await boss.send('digest.generate', {}, { singletonKey: GLOBAL_JOB_KEY })).toBeNull();
      expect(await boss.fetch('digest.generate')).toEqual([]);
      await boss.complete('digest.generate', first!);
      expect((await boss.fetch('digest.generate')).map(job => job.id)).toEqual([followup]);
    } finally { await boss.stop(); }
  });
});
import 'dotenv/config';
