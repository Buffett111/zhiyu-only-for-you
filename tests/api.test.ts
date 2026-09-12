import 'dotenv/config';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { buildApp, historyWindow } from '../server/app';
import { migrate } from '../server/db';
import { loadConfig } from '../server/config';
import { AccessError } from '../server/auth';
const schema = `zhiyu_test_${randomUUID().replaceAll('-', '')}`;
const origin = 'https://unit.example.workers.dev';
const config = loadConfig({ APP_MODE: 'production', DATABASE_URL: process.env.DATABASE_URL, PUBLIC_ORIGIN: origin, ACCESS_TEAM_DOMAIN: 'unit.cloudflareaccess.com', ACCESS_AUD: 'unit', ALLOWED_EMAILS: 'alice@example.org,bob@example.org', ADMIN_EMAILS: 'alice@example.org' });
const admin = new pg.Pool({ connectionString: config.databaseUrl });
const pool = new pg.Pool({ connectionString: config.databaseUrl, options: `-c search_path=${schema},public` });
let app: Awaited<ReturnType<typeof buildApp>>;
const headers = (user = 'alice@example.org') => ({ 'x-test-user': user, origin, 'content-type': 'application/json' });
const payload = { held: true, interested: true, group: '長期觀察' };
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await migrate(pool);
  await pool.query("INSERT INTO securities(id,symbol,name,market,asset_type,source_url) VALUES ('TWSE:0050','0050','測試ETF','TWSE','etf','https://www.twse.com.tw/'),('TPEx:6488','6488','測試公司','TPEx','stock','https://www.tpex.org.tw/')");
  app = await buildApp({ pool, config, logger: false, verifyIdentity: async request => ({ email: String(request.headers['x-test-user'] || 'bob@example.org'), displayName: '測試帳號', role: request.headers['x-test-user'] === 'alice@example.org' ? 'admin' : 'member' }) });
});
afterAll(async () => { await app?.close(); await pool.end(); if (!/^zhiyu_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe test schema'); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); });
describe('real PostgreSQL API and user isolation', () => {
  it('authenticates encoded API prefixes using the matched route and prevents public caching', async () => {
    let checks = 0;
    const denied = await buildApp({ pool, config, logger: false, verifyIdentity: async () => { checks++; throw new AccessError(401, '請先登入。'); } });
    try {
      for (const url of ['/api/v1/sources', '/%61pi/v1/sources', '/a%70i/v1/sources']) {
        const response = await denied.inject({ url });
        expect(response.statusCode).toBe(401);
        expect(response.headers['cache-control']).toContain('no-store');
      }
      expect(checks).toBe(3);
    } finally { await denied.close(); }
  });
  it('persists across devices and ignores forged owner identifiers', async () => {
    const add = await app.inject({ method: 'PUT', url: '/api/v1/finance/watchlist/TWSE%3A0050', headers: headers(), payload });
    expect(add.statusCode).toBe(200);
    const first = await app.inject({ url: '/api/v1/bootstrap', headers: headers() });
    expect(first.headers['cache-control']).toContain('no-store');
    expect(first.json().watchlist[0].security.symbol).toBe('0050');
    const aliceId = first.json().user.id;
    const other = await app.inject({ url: `/api/v1/finance/watchlist?userId=${aliceId}`, headers: headers('bob@example.org') });
    expect(other.json()).toEqual([]);
    await app.inject({ method: 'DELETE', url: '/api/v1/finance/watchlist/TWSE%3A0050', headers: headers('bob@example.org') });
    const stillThere = await app.inject({ url: '/api/v1/finance/watchlist', headers: headers() });
    expect(stillThere.json()).toHaveLength(1);
    const update = await app.inject({ method: 'PUT', url: '/api/v1/finance/watchlist/TWSE%3A0050', headers: headers(), payload: { ...payload, userId: 'forged' } });
    expect(update.statusCode).toBe(400);
  });
  it('does not leak another user digest or permit CSRF', async () => {
    const user = (await app.inject({ url: '/api/v1/me', headers: headers() })).json();
    await pool.query("INSERT INTO digests(user_id,date,data) VALUES($1,'2026-09-11',$2)", [user.id, { date: '2026-09-11', title: 'Alice private', items: [] }]);
    await app.inject({ method: 'PUT', url: '/api/v1/finance/digests/2026-09-11/read', headers: headers('bob@example.org'), payload: {} });
    expect((await pool.query('SELECT read_at FROM digests WHERE user_id=$1', [user.id])).rows[0].read_at).toBeNull();
    const csrf = await app.inject({ method: 'PUT', url: '/api/v1/finance/watchlist/TWSE%3A0050', headers: { ...headers(), origin: 'https://evil.example' }, payload });
    expect(csrf.statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/sync', headers: headers('bob@example.org'), payload: {} })).statusCode).toBe(403);
  });
  it('disables finance without deleting the saved list and restores widget order', async () => {
    const state = { enabled: false, configVersion: 1, config: {}, widgets: ['news', 'watchlist'] };
    const disabled = await app.inject({ method: 'PUT', url: '/api/v1/modules/finance', headers: headers(), payload: state });
    expect(disabled.json()).toMatchObject(state);
    expect((await app.inject({ url: '/api/v1/finance/watchlist', headers: headers() })).statusCode).toBe(409);
    await app.inject({ method: 'PUT', url: '/api/v1/modules/finance', headers: headers(), payload: { ...state, enabled: true } });
    expect((await app.inject({ url: '/api/v1/bootstrap', headers: headers() })).json().watchlist).toHaveLength(1);
  });
  it('handles ETF financials and missing history without inventing data', async () => {
    const detail = (await app.inject({ url: '/api/v1/finance/securities/TWSE%3A0050', headers: headers() })).json();
    expect(detail.fundamentals.availability).toBe('not_applicable'); expect(detail.fundamentals.eps).toBeNull(); expect(detail.quote).toBeNull();
    const history = (await app.inject({ url: '/api/v1/finance/securities/TWSE%3A0050/history?range=1y', headers: headers() })).json();
    expect(history.quotes).toEqual([]); expect(history.coverage.partial).toBe(true);
  });
  it('does not claim complete history when requested months are missing, or leave failed history pending', async () => {
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date());
    const month = today.slice(0, 7);
    await pool.query("INSERT INTO history_progress(security_id,month,status) VALUES('TWSE:0050',$1,'error')", [month]);
    const failed = (await app.inject({ url: '/api/v1/finance/securities/TWSE%3A0050/history?range=1y', headers: headers() })).json();
    expect(failed.status).toBe('partial');
    await pool.query("UPDATE history_progress SET status='complete' WHERE security_id='TWSE:0050'");
    await pool.query("INSERT INTO quotes(security_id,date,data) VALUES('TWSE:0050',$1,$2)", [today, { securityId: 'TWSE:0050', date: today, close: 100 }]);
    const oneMonth = (await app.inject({ url: '/api/v1/finance/securities/TWSE%3A0050/history?range=1y', headers: headers() })).json();
    expect(oneMonth.status).toBe('partial'); expect(oneMonth.coverage.partial).toBe(true);
    expect(historyWindow('2026-03-31', '1m')).toEqual({ requestedFrom: '2026-02-28', months: ['2026-02', '2026-03'] });
    expect(historyWindow('2024-02-29', '1y').requestedFrom).toBe('2023-02-28');
  });
  it('exports safely and deletes only the authenticated user data', async () => {
    await app.inject({ method: 'PUT', url: '/api/v1/finance/watchlist/TPEx%3A6488', headers: headers('bob@example.org'), payload });
    await app.inject({ method: 'PUT', url: '/api/v1/finance/watchlist/TWSE%3A0050', headers: headers(), payload: { ...payload, group: '=1+1' } });
    const csv = await app.inject({ url: '/api/v1/finance/export.csv', headers: headers() });
    expect(csv.body).toContain("'0050"); expect(csv.body).toContain("'=1+1");
    expect((await app.inject({ method: 'POST', url: '/api/v1/me/delete-data', headers: headers(), payload: { confirm: true } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/v1/bootstrap', headers: headers() })).json().watchlist).toEqual([]);
    expect((await app.inject({ url: '/api/v1/bootstrap', headers: headers('bob@example.org') })).json().watchlist).toHaveLength(1);
  });
  it('does not recreate a watchlist entry when deletion wins against an already admitted save', async () => {
    await app.inject({ method: 'PUT', url: '/api/v1/modules/finance', headers: headers(), payload: { enabled: true, configVersion: 1, config: {}, widgets: ['watchlist'] } });
    const alice = (await app.inject({ url: '/api/v1/me', headers: headers() })).json();
    const blocker = await pool.connect();
    let locked = false;
    let pending: Promise<unknown> | undefined;
    try {
      await blocker.query('BEGIN');
      locked = true;
      const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      // Pause the PUT's security lookup after requireFinance accepted it. The
      // separate deletion request remains free to acquire the module lock.
      await blocker.query('LOCK TABLE securities IN ACCESS EXCLUSIVE MODE');
      const save = app.inject({ method: 'PUT', url: '/api/v1/finance/watchlist/TWSE%3A0050', headers: headers(), payload }).then(result => result);
      pending = save;
      let reachedLookup = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        const waiting = await pool.query("SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query='SELECT * FROM securities WHERE id=$1'", [blockerPid]);
        if (waiting.rowCount) { reachedLookup = true; break; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(reachedLookup).toBe(true);
      const deleted = await app.inject({ method: 'POST', url: '/api/v1/me/delete-data', headers: headers(), payload: { confirm: true } });
      expect(deleted.statusCode).toBe(200);
      await blocker.query('ROLLBACK');
      locked = false;
      expect((await save).statusCode).toBe(409);
      expect((await pool.query('SELECT 1 FROM watchlist WHERE user_id=$1', [alice.id])).rowCount).toBe(0);
      expect((await pool.query("SELECT enabled FROM user_modules WHERE user_id=$1 AND module_id='finance'", [alice.id])).rows[0].enabled).toBe(false);
    } finally {
      if (locked) await blocker.query('ROLLBACK');
      blocker.release();
      await pending;
    }
  });
});
