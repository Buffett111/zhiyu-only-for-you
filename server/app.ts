import Fastify, { type FastifyRequest } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createIdentityVerifier, AccessError } from './auth';
import type { Identity } from './auth';
import type { Config } from './config';
import { modules, defaultModuleState, migrateModuleState, financeModule } from '../shared/modules';
import type { User, Security, ModuleState, SourceStatus, Quote, Fundamentals, Digest } from '../shared/types';
import { enqueueHistory, historyYears } from './jobs';
import { searchYahoo, YahooUnavailable } from './providers/yahoo';
import { regionOf, exchangeDate, timeZoneOf } from '../shared/markets';

declare module 'fastify' { interface FastifyRequest { zhiyuUser: User; } }
export interface JobQueue { send(name: string, data?: object, options?: object): Promise<unknown>; }
interface AppOptions { pool: Pool; config: Config; queue?: JobQueue; verifyIdentity?: (request: FastifyRequest) => Promise<Identity>; logger?: boolean; yahooSearch?: typeof searchYahoo; }
const dateOnly = (v: string | Date) => typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10);
const iso = (v: Date | string | null) => v ? new Date(v).toISOString() : null;
export function mapSecurity(row: Record<string, any>): Security {
  return { id: row.id, symbol: row.symbol, name: row.name, market: row.market, assetType: row.asset_type, currency: row.currency, sector: row.sector || undefined, aliases: row.aliases || [], sourceUrl: row.source_url, active: row.active,listedAt:row.listed_at || undefined };
}
function moduleState(row: Record<string, any>): ModuleState { return migrateModuleState({ moduleId: row.module_id, enabled: row.enabled, configVersion: row.config_version, config: row.config, widgets: row.widgets }); }
function missingFundamentals(security: Security): Fundamentals {
  if (regionOf(security.market) !== 'TW') return { securityId: security.id, asOf: '', revenuePeriod: null, earningsPeriod: null, basis: 'annual', revenue: null, revenueYoy: null, eps: null, grossMargin: null, operatingMargin: null, unit: security.currency, sourceUrl: security.sourceUrl, availability: security.assetType === 'etf' ? 'not_applicable' : 'unsupported' };
  return { securityId: security.id, asOf: '', revenuePeriod: null, earningsPeriod: null, basis: 'cumulative', revenue: null, revenueYoy: null, eps: null, grossMargin: null, operatingMargin: null, unit: '新台幣千元；EPS 為元', sourceUrl: security.sourceUrl, availability: security.assetType === 'etf' ? 'not_applicable' : /金融|保險|銀行|證券/.test(security.sector || '') ? 'unsupported' : 'missing' };
}
const watchSchema = z.object({ held: z.boolean(), interested: z.boolean(), group: z.string().trim().min(1).max(40).default('我的清單') }).strict();
const moduleSchema = z.object({ enabled: z.boolean(), configVersion: z.literal(1), config: z.object({ translationTarget: z.enum(['zh-TW','en','ja']).optional() }).strict().default({}), widgets: z.array(z.enum(financeModule.widgets.map(w => w.id) as [string, ...string[]])).max(5).refine(v => new Set(v).size === v.length, '卡片不能重複') }).strict();
function taipeiToday() { return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
export function historyWindow(today: string, range: '1m' | '3m' | '1y' | '3y' | '5y' | '10y' | '20y') {
  const monthsBack = { '1m': 1, '3m': 3, '1y': 12, '3y':36, '5y':60, '10y':120, '20y':240 }[range];
  const current = new Date(`${today}T00:00:00Z`);
  const from = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - monthsBack, 1));
  const lastDay = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0)).getUTCDate();
  from.setUTCDate(Math.min(current.getUTCDate(), lastDay));
  const months: string[] = [];
  for (let offset = 0; offset <= monthsBack; offset++) months.push(new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + offset, 1)).toISOString().slice(0, 7));
  return { requestedFrom: from.toISOString().slice(0, 10), months };
}

export async function buildApp({ pool, config, queue, verifyIdentity = createIdentityVerifier(config), logger = true, yahooSearch = searchYahoo }: AppOptions) {
  const app = Fastify({ logger: logger ? { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["cf-access-jwt-assertion"]', 'res.headers["set-cookie"]'] } : false, disableRequestLogging: true, bodyLimit: 16384, trustProxy: false });
  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"] } } });
  app.decorateRequest('zhiyuUser', null as unknown as User);
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: '輸入格式不正確，請檢查欄位。' });
    if (error instanceof AccessError) return reply.code(error.statusCode).send({ error: error.message });
    if (error instanceof YahooUnavailable) return reply.code(424).send({ error: error.message });
    const status = (error as {statusCode?: number}).statusCode;
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: status === 429 ? '操作太頻繁，請稍後再試。' : '無法處理此請求。' });
    request.log.error({ errorType: error instanceof Error ? error.name : 'Error', code: (error as any)?.code }, 'Request failed');
    return reply.code(503).send({ error: '服務暫時無法連線，請稍後再試。' });
  });
  app.addHook('onRequest', async (request, reply) => {
    // Fastify resolves percent-encoded static path characters before running hooks.
    // Classify the matched route so /%61pi/... cannot bypass API authentication.
    const routePath = request.routeOptions.url;
    if (!routePath?.startsWith('/api/') && !request.url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'private, no-store, max-age=0').header('Pragma', 'no-cache').header('Vary', 'Cookie, Cf-Access-Jwt-Assertion');
    if (config.mode === 'development') {
      const host = request.headers.host?.replace(/:\d+$/, '');
      if (host && !['localhost', '127.0.0.1', '[::1]'].includes(host)) throw new AccessError(403, '本機開發模式僅供這台電腦使用。');
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      const allowedOrigins = config.mode === 'development' ? [config.publicOrigin, 'http://127.0.0.1:3001', 'http://localhost:5173'] : [config.publicOrigin];
      if ((origin && !allowedOrigins.includes(origin)) || (!origin && config.mode === 'production')) throw new AccessError(403, '此操作必須從知隅網站發起。');
      if (!String(request.headers['content-type'] || '').startsWith('application/json')) throw new AccessError(415, '請使用 JSON 格式。');
    }
    if (routePath === '/api/health') return;
    const identity = await verifyIdentity(request);
    const result = await pool.query('INSERT INTO users(id,email,display_name,role) VALUES($1,$2,$3,$4) ON CONFLICT(email) DO UPDATE SET role=EXCLUDED.role RETURNING *', [randomUUID(), identity.email, identity.displayName, identity.role]);
    const row = result.rows[0];
    if (row.disabled) throw new AccessError(403, '帳號已停用。');
    request.zhiyuUser = { id: row.id, email: row.email, displayName: row.display_name, role: row.role };
    const initial = defaultModuleState();
    await pool.query('INSERT INTO user_modules(user_id,module_id,enabled,config_version,config,widgets) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING', [row.id, initial.moduleId, initial.enabled, initial.configVersion, initial.config, JSON.stringify(initial.widgets)]);
  });
  await app.register(rateLimit, { max: 180, timeWindow: '1 minute', hook: 'preHandler', keyGenerator: request => request.zhiyuUser?.id || request.ip });

  const getStates = async (userId: string) => (await pool.query('SELECT * FROM user_modules WHERE user_id=$1 ORDER BY module_id', [userId])).rows.map(moduleState);
  const watchlist = async (userId: string) => (await pool.query(`SELECT s.*,w.held,w.interested,w.group_name,w.created_at,q.data AS quote FROM watchlist w JOIN securities s ON s.id=w.security_id LEFT JOIN LATERAL (SELECT data FROM quotes WHERE security_id=s.id ORDER BY date DESC LIMIT 1) q ON true WHERE w.user_id=$1 ORDER BY w.created_at,s.symbol`, [userId])).rows.map(r => ({ securityId: r.id, held: r.held, interested: r.interested, group: r.group_name, createdAt: iso(r.created_at), security: mapSecurity(r), quote: r.quote || null }));
  const getSources = async (): Promise<SourceStatus[]> => (await pool.query('SELECT * FROM source_runs ORDER BY id')).rows.map(r => ({ id: r.id, name: r.name, status: r.status, lastAttempt: iso(r.last_attempt), lastSuccess: iso(r.last_success), dataDate: r.data_date ? dateOnly(r.data_date) : null, error: r.error, count: r.count }));
  const digest = (r: Record<string, any>): Digest => ({ ...r.data, date: dateOnly(r.date), read: Boolean(r.read_at) });
  const requireFinance = async (request: FastifyRequest) => {
    if (!(await pool.query("SELECT 1 FROM user_modules WHERE user_id=$1 AND module_id='finance' AND enabled", [request.zhiyuUser.id])).rowCount) throw new AccessError(409, '請先啟用財經模組。');
  };
  const getSecurity = async (id: string) => {
    const result = await pool.query('SELECT * FROM securities WHERE id=$1', [id]);
    if (!result.rowCount) throw new AccessError(404, '找不到這個標的。');
    return mapSecurity(result.rows[0]);
  };
  const selections = new Map<string, { security: Security; expires: number }>();
  const enqueue = async (name: string, data: object = {}, singletonKey?: string) => {
    if (!queue) throw new AccessError(503, '背景工作尚未啟動。');
    return queue.send(name, data, { singletonKey: singletonKey || 'global', retryLimit: 2, retryDelay: 60, retryBackoff: true });
  };
  app.get('/api/health', async (_request, reply) => {
    try { await pool.query('SELECT 1'); return { status: 'ok' }; }
    catch { return reply.code(503).send({ status: 'offline' }); }
  });
  app.get('/api/v1/me', async request => request.zhiyuUser);
  app.get('/api/v1/bootstrap', async request => {
    const userId = request.zhiyuUser.id;
    const [states, entries, sources, latest] = await Promise.all([getStates(userId), watchlist(userId), getSources(), pool.query('SELECT * FROM digests WHERE user_id=$1 ORDER BY date DESC LIMIT 1', [userId])]);
    return { user: request.zhiyuUser, modules, states, watchlist: entries, digest: latest.rowCount ? digest(latest.rows[0]) : null, sources, mode: config.mode };
  });
  app.get('/api/v1/modules', async request => ({ modules, states: await getStates(request.zhiyuUser.id) }));
  app.put<{ Params: { id: string } }>('/api/v1/modules/:id', async request => {
    if (request.params.id !== 'finance') throw new AccessError(404, '找不到這個模組。');
    const input = moduleSchema.parse(request.body);
    const previous = await pool.query('SELECT enabled FROM user_modules WHERE user_id=$1 AND module_id=$2', [request.zhiyuUser.id, request.params.id]);
    const result = await pool.query('UPDATE user_modules SET enabled=$3,config_version=$4,config=$5,widgets=$6 WHERE user_id=$1 AND module_id=$2 RETURNING *', [request.zhiyuUser.id, request.params.id, input.enabled, input.configVersion, input.config, JSON.stringify(input.widgets)]);
    if (input.enabled && !previous.rows[0]?.enabled && queue) {
      try { await enqueue('digest.generate'); } catch { /* Persistent scheduler catch-up retries after recovery. */ }
    }
    return moduleState(result.rows[0]);
  });
  app.get('/api/v1/sources', getSources);
  app.get<{ Querystring: { q?: string; region?: string } }>('/api/v1/finance/securities', { preHandler: requireFinance, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async request => {
    const q = z.string().trim().max(80).parse(request.query.q || '');
    const region = z.enum(['TW', 'US', 'JP']).parse(request.query.region || 'TW');
    if (region !== 'TW') {
      if (!q) return [];
      const securities = await yahooSearch(q, region);
      for (const security of securities) {
        if (regionOf(security.market) !== region) continue;
        if (selections.size >= 500) selections.delete(selections.keys().next().value!);
        selections.set(security.id, { security, expires: Date.now()+600000 });
      }
      return securities.filter(security => regionOf(security.market) === region);
    }
    const search = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const result = await pool.query("SELECT * FROM securities WHERE active AND market IN ('TWSE','TPEx') AND ($1='' OR symbol ILIKE $2 OR name ILIKE $2 OR aliases::text ILIKE $2) ORDER BY CASE WHEN symbol=$1 THEN 0 ELSE 1 END,symbol LIMIT 50", [q, search]);
    return result.rows.map(mapSecurity);
  });
  app.get('/api/v1/finance/watchlist', { preHandler: requireFinance }, async request => watchlist(request.zhiyuUser.id));
  app.put<{ Params: { id: string } }>('/api/v1/finance/watchlist/:id', { preHandler: requireFinance }, async request => {
    const input = watchSchema.parse(request.body);
    const selection = selections.get(request.params.id);
    if (selection && selection.expires > Date.now()) {
      const s = selection.security;
      await pool.query(`INSERT INTO securities(id,symbol,name,market,asset_type,currency,aliases,source_url,active) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,true)
       ON CONFLICT(id) DO UPDATE SET name=$3,aliases=$7::jsonb,source_url=$8,active=true`, [s.id,s.symbol,s.name,s.market,s.assetType,s.currency,JSON.stringify(s.aliases),s.sourceUrl]);
    }
    await getSecurity(request.params.id);
    const client = await pool.connect();
    let inserted = false;
    try {
      await client.query('BEGIN');
      // Share the deletion/disable lock and recheck after waiting for it. A save
      // admitted before deletion must not recreate private data after deletion.
      const enabled = await client.query("SELECT enabled FROM user_modules WHERE user_id=$1 AND module_id='finance' FOR UPDATE", [request.zhiyuUser.id]);
      if (!enabled.rows[0]?.enabled) throw new AccessError(409, '請先啟用財經模組。');
      const saved = await client.query('INSERT INTO watchlist(user_id,security_id,held,interested,group_name) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,security_id) DO UPDATE SET held=EXCLUDED.held,interested=EXCLUDED.interested,group_name=EXCLUDED.group_name RETURNING (xmax=0) AS inserted', [request.zhiyuUser.id, request.params.id, input.held, input.interested, input.group]);
      inserted = Boolean(saved.rows[0]?.inserted);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    let queued = false;
    if (queue && inserted) {
      try { await enqueueHistory(queue, request.params.id,new Date(),await historyYears(pool,request.params.id),(await getSecurity(request.params.id)).listedAt); await enqueue('digest.generate'); queued = true; }
      catch { /* Watchlist remains saved; scheduler catch-up will retry. */ }
    }
    return { saved: true, queued };
  });
  app.delete<{ Params: { id: string } }>('/api/v1/finance/watchlist/:id', { preHandler: requireFinance }, async (request, reply) => {
    await pool.query('DELETE FROM watchlist WHERE user_id=$1 AND security_id=$2', [request.zhiyuUser.id, request.params.id]);
    return reply.code(204).send();
  });
  app.get<{ Params: { id: string } }>('/api/v1/finance/securities/:id', { preHandler: requireFinance }, async request => {
    const security = await getSecurity(request.params.id);
    const [q, f, n] = await Promise.all([pool.query('SELECT data FROM quotes WHERE security_id=$1 ORDER BY date DESC LIMIT 1', [security.id]), pool.query('SELECT data FROM fundamentals WHERE security_id=$1', [security.id]), pool.query("SELECT data FROM news WHERE data->'securityIds' ? $1 ORDER BY published_at DESC LIMIT 30", [security.id])]);
    const reports = await pool.query('SELECT data FROM financial_reports WHERE security_id=$1 ORDER BY period_end DESC,basis', [security.id]);
    const progress = await pool.query('SELECT * FROM content_progress WHERE security_id=$1 ORDER BY kind', [security.id]);
    return { security, quote: q.rows[0]?.data || null, fundamentals: security.assetType === 'etf' ? missingFundamentals(security) : f.rows[0]?.data || missingFundamentals(security), news: n.rows.map(r => r.data),
      financialReports: reports.rows.map(r => r.data), contentStatus: progress.rows.map(r => ({kind:r.kind,status:r.status,lastAttempt:iso(r.last_attempt),lastSuccess:iso(r.last_success),error:r.error})) };
  });
  app.post<{ Params: { id: string } }>('/api/v1/finance/securities/:id/history/request', { preHandler: requireFinance }, async request => {
    const {years}=z.object({years:z.union([z.literal(5),z.literal(10),z.literal(20)])}).strict().parse(request.body);
    if(!queue)throw new AccessError(503,'背景排程尚未連線，請稍後再試。');
    const client=await pool.connect();let target=years;
    try{
      await client.query('BEGIN');
      const module=(await client.query("SELECT enabled FROM user_modules WHERE user_id=$1 AND module_id='finance' FOR UPDATE",[request.zhiyuUser.id])).rows[0];
      if(!module?.enabled)throw new AccessError(409,'請先啟用財經模組。');
      if(!(await client.query('SELECT 1 FROM watchlist WHERE user_id=$1 AND security_id=$2',[request.zhiyuUser.id,request.params.id])).rowCount)throw new AccessError(404,'請先將此標的加入自己的追蹤清單。');
      target=(await client.query(`INSERT INTO history_targets(security_id,years) VALUES($1,$2) ON CONFLICT(security_id) DO UPDATE SET years=GREATEST(history_targets.years,EXCLUDED.years),updated_at=now() RETURNING years`,[request.params.id,years])).rows[0].years;
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    await enqueueHistory(queue,request.params.id,new Date(),target,(await getSecurity(request.params.id)).listedAt);
    return {queued:true,years:target};
  });
  app.get<{ Params: { id: string }; Querystring: { range?: string } }>('/api/v1/finance/securities/:id/history', { preHandler: requireFinance }, async request => {
    const security = await getSecurity(request.params.id);
    const range = z.enum(['1m', '3m', '1y', '3y','5y','10y','20y']).parse(request.query.range || '10y');
    const { requestedFrom, months } = historyWindow(exchangeDate(new Date(), timeZoneOf(security.market)), range);
    const rows = await pool.query('SELECT data FROM quotes WHERE security_id=$1 AND date >= $2 ORDER BY date', [request.params.id, requestedFrom]);
    const quotes: Quote[] = rows.rows.map(r => r.data);
    const progress = await pool.query('SELECT month,status FROM history_progress WHERE security_id=$1 AND month=ANY($2::text[])', [request.params.id, months]);
    const statuses = new Map<string, string>(progress.rows.map(r => [r.month, r.status]));
    const partial = quotes.length === 0 || months.some(month => statuses.get(month) !== 'complete');
    const attempted = progress.rows.some(r => ['complete', 'partial', 'error'].includes(r.status));
    return { quotes, coverage: { from: quotes[0]?.date || null, to: quotes.at(-1)?.date || null, requestedFrom, partial }, status: !quotes.length && !attempted ? 'pending' : partial ? 'partial' : 'ready' };
  });
  app.get<{ Querystring: { securityId?: string; kind?: string } }>('/api/v1/finance/news', { preHandler: requireFinance }, async request => {
    const input = z.object({ securityId: z.string().max(80).optional(), kind: z.enum(['news', 'announcement']).optional() }).parse(request.query);
    const rows = await pool.query("SELECT n.data FROM news n WHERE ($1::text IS NULL OR n.data->'securityIds' ? $1) AND ($2::text IS NULL OR n.data->>'kind'=$2) AND ($1::text IS NOT NULL OR EXISTS (SELECT 1 FROM watchlist w WHERE w.user_id=$3 AND n.data->'securityIds' ? w.security_id)) ORDER BY n.published_at DESC LIMIT 100", [input.securityId || null, input.kind || null, request.zhiyuUser.id]);
    return rows.rows.map(r => r.data);
  });
  app.get('/api/v1/finance/digests', { preHandler: requireFinance }, async request => (await pool.query('SELECT * FROM digests WHERE user_id=$1 ORDER BY date DESC LIMIT 30', [request.zhiyuUser.id])).rows.map(digest));
  app.put<{ Params: { date: string } }>('/api/v1/finance/digests/:date/read', { preHandler: requireFinance }, async request => {
    const date = z.iso.date().parse(request.params.date);
    await pool.query('UPDATE digests SET read_at=COALESCE(read_at,now()) WHERE user_id=$1 AND date=$2', [request.zhiyuUser.id, date]);
    return { saved: true };
  });
  app.get('/api/v1/finance/export.csv', async (request, reply) => {
    const entries = await watchlist(request.zhiyuUser.id);
    const cell = (v: unknown) => { let text = String(v ?? ''); if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; };
    const lines = [['市場', '代號', '名稱', '持有', '感興趣', '分組'], ...entries.map(w => [w.security.market, `'${w.security.symbol}`, w.security.name, w.held ? '是' : '否', w.interested ? '是' : '否', w.group])];
    return reply.header('Content-Disposition', 'attachment; filename="zhiyu-watchlist.csv"').type('text/csv; charset=utf-8').send('\uFEFF' + lines.map(row => row.map(cell).join(',')).join('\r\n'));
  });
  app.post('/api/v1/me/delete-data', async request => {
    z.object({ confirm: z.literal(true) }).strict().parse(request.body);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT 1 FROM user_modules WHERE user_id=$1 FOR UPDATE', [request.zhiyuUser.id]);
      await client.query('DELETE FROM watchlist WHERE user_id=$1', [request.zhiyuUser.id]);
      await client.query('DELETE FROM digests WHERE user_id=$1', [request.zhiyuUser.id]);
      await client.query("UPDATE user_modules SET enabled=false,config='{}',widgets='[]',config_version=1 WHERE user_id=$1", [request.zhiyuUser.id]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    return { deleted: true };
  });
  app.post('/api/v1/admin/sync', async request => {
    if (request.zhiyuUser.role !== 'admin') throw new AccessError(403, '只有管理員可以啟動同步。');
    await enqueue('digest.generate');
    return { queued: true };
  });
  if (existsSync(resolve('dist/index.html'))) {
    await app.register(fastifyStatic, { root: resolve('dist'), prefix: '/' });
    app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ error: '找不到這個 API。' }) : reply.type('text/html').sendFile('index.html'));
  } else app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: '找不到這個頁面。' }));
  return app;
}
