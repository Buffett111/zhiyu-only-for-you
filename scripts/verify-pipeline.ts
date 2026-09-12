/** Real-source PostgreSQL smoke test. All writes stay inside a fresh, disposable schema. */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg, { type Pool } from 'pg';
import type { Digest } from '../shared/types.js';
import { createJobHandlers, latestDigestDate, safeError, type JobOutcome, type JobProviders } from '../server/jobs.js';
import * as official from '../server/providers/index.js';

pg.types.setTypeParser(1082, value => value);
const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error('Set TEST_DATABASE_URL or DATABASE_URL before running the isolated pipeline check.');
const month = process.argv.find(value => value.startsWith('--month='))?.slice('--month='.length) ?? '2026-08';
if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Use --month=YYYY-MM.');
const schema = `pipeline_verify_${randomUUID().replaceAll('-', '')}`;
assert.match(schema, /^pipeline_verify_[a-f0-9]{32}$/);
const admin = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000 });
let pool: Pool | undefined;
let created = false;
const now = new Date();
const digestDate = latestDigestDate(now);
const userA = randomUUID(), userB = randomUUID();
const sampleIds = ['TWSE:2330', 'TWSE:0050', 'TPEx:6488', 'TPEx:00679B'];
const userSelections = new Map<string, Set<string>>([
  [userA, new Set(['TWSE:2330', 'TWSE:0050', 'TPEx:6488'])],
  [userB, new Set(['TWSE:2330', 'TPEx:00679B'])],
]);
const calls = { snapshots: 0, fundamentals: 0, news: 0, history: 0, calendar: 0 };
let fundamentalUnion = 0;
const providers: JobProviders = {
  fetchMarketSnapshot: async market => { calls.snapshots++; return official.fetchMarketSnapshot(market); },
  fetchFundamentals: async securities => {
    calls.fundamentals++; fundamentalUnion = securities.length;
    assert.deepEqual(new Set(securities.map(security => security.id)), new Set(sampleIds), 'Fundamental fetch must use the distinct four-security watchlist union.');
    return official.fetchFundamentals(securities);
  },
  fetchNews: async securities => { calls.news++; return official.fetchNews(securities); },
  fetchHistory: async (security, requestedMonth) => {
    assert.ok(sampleIds.includes(security.id), 'History requested an unexpected security.');
    assert.equal(requestedMonth, month, 'History escaped the explicitly requested month.');
    calls.history++; return official.fetchHistory(security, requestedMonth);
  },
  fetchTradingCalendar: async year => { calls.calendar++; return official.fetchTradingCalendar(year); },
};
const report: Record<string, unknown> = { verifiedAt: now.toISOString(), month, digestDate, isolatedSchema: true, ok: false, cleanedUp: false };
function requireSuccess(outcomes: JobOutcome[], stage: string): void {
  const failures = outcomes.filter(outcome => outcome.status !== 'success');
  if (failures.length) throw new Error(`${stage}: ${failures.map(outcome => `${outcome.status}: ${outcome.warnings.join('; ')}`).join(' | ')}`);
}

try {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  // Exclude public from search_path so an absent fixture table cannot resolve to production data.
  pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 4, connectionTimeoutMillis: 5_000 });
  assert.equal((await pool.query('SELECT current_schema() AS name')).rows[0].name, schema);
  await pool.query(await readFile(new URL('../server/migrations/001_initial.sql', import.meta.url), 'utf8'));
  await pool.query(`INSERT INTO users(id,email,display_name) VALUES($1,'pipeline-a@example.invalid','Pipeline A'),($2,'pipeline-b@example.invalid','Pipeline B')`, [userA, userB]);
  await pool.query(`INSERT INTO user_modules(user_id,module_id,enabled) VALUES($1,'finance',true),($2,'finance',true)`, [userA, userB]);
  const jobs = createJobHandlers(pool, providers);

  const market = await jobs.syncMarket(now);
  requireSuccess(market, 'market');
  assert.equal(market.length, 2);
  const catalog = await pool.query('SELECT id,asset_type,active FROM securities WHERE id=ANY($1::text[])', [sampleIds]);
  assert.equal(catalog.rowCount, 4, 'Official catalog must contain all four sample securities.');
  assert.ok(catalog.rows.every(row => row.active));
  assert.equal(catalog.rows.find(row => row.id === 'TWSE:0050')?.asset_type, 'etf');
  assert.equal(catalog.rows.find(row => row.id === 'TPEx:00679B')?.asset_type, 'etf');
  let snapshotCount = Number((await pool.query('SELECT count(*) AS count FROM quotes')).rows[0].count);
  assert.equal(snapshotCount, market.reduce((sum, outcome) => sum + outcome.count, 0));
  assert.equal(snapshotCount, 0, 'No private selection exists yet; market prices must not be persisted.');

  await pool.query(`INSERT INTO watchlist(user_id,security_id,held,interested,group_name) VALUES
    ($1,'TWSE:2330',true,true,'驗證持有'),($1,'TWSE:0050',false,true,'驗證觀察'),($1,'TPEx:6488',true,false,'驗證持有'),
    ($2,'TWSE:2330',false,true,'驗證觀察'),($2,'TPEx:00679B',true,true,'驗證持有')`, [userA, userB]);
  const ownership = (await pool.query('SELECT count(*) AS entries,count(DISTINCT security_id) AS securities FROM watchlist')).rows[0];
  assert.equal(Number(ownership.entries), 5); assert.equal(Number(ownership.securities), 4);
  requireSuccess(await jobs.syncMarket(now), 'selected market');
  snapshotCount = Number((await pool.query('SELECT count(*) AS count FROM quotes')).rows[0].count);
  assert.equal(snapshotCount, 4, 'Persist only the four selected securities, not the whole market.');

  const fundamentals = await jobs.syncFundamentals(now);
  requireSuccess([fundamentals], 'fundamentals');
  const financialRows = (await pool.query('SELECT data FROM fundamentals')).rows;
  assert.equal(financialRows.length, 4);
  assert.equal(financialRows.filter(row => row.data.availability === 'available').length, 2);
  assert.equal(financialRows.filter(row => row.data.availability === 'not_applicable').length, 2);
  assert.ok(financialRows.filter(row => row.data.availability === 'available').every(row => row.data.basis === 'cumulative' || row.data.basis === 'annual'));
  const news = await jobs.syncNews(now);
  requireSuccess([news], 'news');

  const history = await jobs.backfillHistory(undefined, month, now);
  requireSuccess(history, 'history');
  assert.equal(history.length, 4); assert.equal(calls.history, 4);
  const historyCount = Number((await pool.query("SELECT count(*) AS count FROM quotes WHERE data->>'dataset'='history'")).rows[0].count);
  assert.equal(historyCount, history.reduce((sum, outcome) => sum + outcome.count, 0));
  const afterCount = Number((await pool.query('SELECT count(*) AS count FROM quotes')).rows[0].count);
  assert.equal(afterCount, snapshotCount + historyCount, 'Shared quotes must not be duplicated per user.');
  const restarted = createJobHandlers(pool, providers);
  const replay = await restarted.backfillHistory(undefined, month, now);
  assert.equal(replay.length, 4); assert.ok(replay.every(outcome => outcome.status === 'skipped'));
  assert.equal(calls.history, 4, 'Completed historical months must not fetch again after restart.');
  assert.equal(Number((await pool.query('SELECT count(*) AS count FROM quotes')).rows[0].count), afterCount);

  assert.equal(await jobs.generateDigests(now, digestDate), 2);
  await pool.query('UPDATE digests SET read_at=$2 WHERE user_id=$1 AND date=$3', [userA, now, digestDate]);
  assert.equal(await restarted.generateDigests(now, digestDate), 2);
  const digests = (await pool.query('SELECT user_id,date,data,read_at FROM digests')).rows;
  assert.equal(digests.length, 2, 'Repeated generation must retain one digest per user/date.');
  for (const row of digests) {
    const ownIds = userSelections.get(row.user_id)!;
    const digest = row.data as Digest;
    assert.equal(row.date, digestDate); assert.equal(digest.tracked, ownIds.size);
    assert.ok(digest.items.every(item => !item.securityId || ownIds.has(item.securityId)), 'Digest contains another user’s tracked security.');
  }
  assert.ok(digests.find(row => row.user_id === userA)!.read_at !== null, 'Regeneration cleared read state.');
  assert.equal(digests.find(row => row.user_id === userB)!.read_at, null);
  const statuses = (await pool.query('SELECT id,status,count FROM source_runs ORDER BY id')).rows;
  assert.ok(statuses.every(row => row.status === 'success'));
  report.ok = true;
  report.metrics = {
    users: 2, privateWatchlistEntries: 5, distinctTrackedSecurities: 4,
    catalogSecurities: Number((await pool.query('SELECT count(*) AS count FROM securities')).rows[0].count),
    snapshotQuotes: snapshotCount, historicalQuotes: historyCount, sharedQuotes: afterCount,
    historyMonthsCompleted: history.length, historyReplaySkipped: replay.length,
    fundamentalFetchUnion: fundamentalUnion, fundamentalsAvailable: 2, etfsNotApplicable: 2,
    newsItems: news.count, uniqueDigests: digests.length, digestTrackedCounts: [3, 2],
    readStatePreserved: true, digestUserIsolation: true, providerCalls: calls,
  };
  report.sources = statuses;
} catch (error) {
  report.error = safeError(error);
  process.exitCode = 1;
} finally {
  if (pool) {
    try { await pool.end(); }
    catch (error) { report.ok = false; report.poolCloseError = safeError(error); process.exitCode = 1; }
  }
  try {
    if (created) {
      assert.match(schema, /^pipeline_verify_[a-f0-9]{32}$/);
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      assert.equal(Number((await admin.query('SELECT count(*) AS count FROM pg_namespace WHERE nspname=$1', [schema])).rows[0].count), 0);
    }
    report.cleanedUp = true;
  } catch (error) {
    report.ok = false; report.cleanupError = safeError(error); process.exitCode = 1;
  } finally { await admin.end(); }
}
console.log(JSON.stringify(report, null, 2));
