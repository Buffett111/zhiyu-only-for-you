import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { SendOptions } from 'pg-boss';
import type { Digest, Fundamentals, FinancialReport, Market, TaiwanMarket, MarketSnapshot, NewsItem, ProviderResult, Quote, Security } from '../shared/types.js';
import { internationalSessionDate, regionOf } from '../shared/markets.js';
import * as upstream from './providers/index.js';
import { createContentJobs, type ContentProviders } from './content-jobs';

export const QUEUES = ['market.sync', 'international.sync', 'news.sync', 'history.backfill', 'digest.generate', 'fundamentals.sync'] as const;
export const GLOBAL_JOB_KEY = 'global';
export type QueueName = typeof QUEUES[number];
export interface CalendarDay { date: string; name: string; closed: boolean; }
export interface JobProviders extends ContentProviders {
  fetchMarketSnapshot(market: TaiwanMarket): Promise<MarketSnapshot>;
  fetchSecurityCatalog?(market: TaiwanMarket): Promise<Security[]>;
  fetchInternationalHistory?(security: Security, now?: Date, years?: number): Promise<ProviderResult<Quote>>;
  fetchFundamentals(securities: Security[]): Promise<ProviderResult<Fundamentals>>;
  fetchNews(securities: Security[]): Promise<ProviderResult<NewsItem>>;
  fetchHistory(security: Security, month: string): Promise<ProviderResult<Quote>>;
  fetchTradingCalendar?(year: number): Promise<ProviderResult<CalendarDay>>;
}
export interface JobOutcome { source: string; status: 'success' | 'partial' | 'error' | 'skipped'; count: number; warnings: string[]; }
type Queryable = Pick<PoolClient, 'query'>;

// Taiwan does not observe daylight saving time. Keep date calculations independent of server timezone.
export function taipeiParts(now = new Date()) {
  const local = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return { date: local.toISOString().slice(0, 10), hour: local.getUTCHours(), minute: local.getUTCMinutes(), weekday: local.getUTCDay() };
}
export function addDays(date: string, amount: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + amount * 86400000).toISOString().slice(0, 10);
}
export function latestDigestDate(now = new Date()): string {
  const local = taipeiParts(now);
  return local.hour * 60 + local.minute >= 20 * 60 + 30 ? local.date : addDays(local.date, -1);
}
export function expectedSessionDate(now: Date, closedDates: ReadonlySet<string> = new Set(), openDates: ReadonlySet<string> = new Set()): string {
  const local = taipeiParts(now);
  let date = local.hour * 60 + local.minute >= 16 * 60 + 30 ? local.date : addDays(local.date, -1);
  for (let i = 0; i < 370; i++) {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    if ((openDates.has(date) || weekday !== 0 && weekday !== 6) && !closedDates.has(date)) return date;
    date = addDays(date, -1);
  }
  throw new Error('休市日曆超出可判讀範圍');
}
export function historyMonths(now = new Date(), years = 10): string[] {
  if (![5,10,20].includes(years)) throw new Error('Unsupported history horizon');
  const { date } = taipeiParts(now);
  const start = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  return Array.from({ length: years * 12 + 1 }, (_, index) => new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - index, 1)).toISOString().slice(0, 7));
}
export async function historyYears(client: Queryable, securityId: string): Promise<number> {
  return (await client.query('SELECT years FROM history_targets WHERE security_id=$1',[securityId])).rows[0]?.years ?? 10;
}
export function fundamentalFingerprint(value: Fundamentals): string {
  // asOf is an observation timestamp, not a financial change. Field order must be stable.
  return createHash('sha256').update(JSON.stringify([
    value.securityId, value.revenuePeriod, value.earningsPeriod, value.basis,
    value.revenue, value.revenueYoy, value.eps, value.grossMargin, value.operatingMargin,
    value.unit, value.availability,
  ])).digest('hex');
}
export function preserveLatestFundamentals(previous: Fundamentals | undefined, incoming: Fundamentals): Fundamentals {
  if (!previous || previous.availability !== 'available' || ['not_applicable', 'unsupported'].includes(incoming.availability)) return incoming;
  if (incoming.availability === 'missing') return previous;
  const preserveRevenue = previous.revenuePeriod && (!incoming.revenuePeriod || previous.revenuePeriod > incoming.revenuePeriod);
  const preserveEarnings = previous.earningsPeriod && (!incoming.earningsPeriod || previous.earningsPeriod > incoming.earningsPeriod);
  return { ...incoming,
    ...(preserveRevenue ? { revenuePeriod: previous.revenuePeriod, revenue: previous.revenue, revenueYoy: previous.revenueYoy } : {}),
    ...(preserveEarnings ? { earningsPeriod: previous.earningsPeriod, eps: previous.eps, grossMargin: previous.grossMargin, operatingMargin: previous.operatingMargin, basis: previous.basis } : {}),
    asOf: previous.asOf > incoming.asOf ? previous.asOf : incoming.asOf,
  };
}
export function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : '資料來源同步失敗')
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[database]')
    .replace(/https?:\/\/[^\s]+/gi, '[source URL]')
    .replace(/(?:token|password|secret|authorization)\s*[:=]\s*\S+/gi, '[redacted]')
    .slice(0, 500);
}
function securityRow(row: Record<string, unknown>): Security {
  return { id: String(row.id), symbol: String(row.symbol), name: String(row.name), market: row.market as Market,
    assetType: row.asset_type as Security['assetType'], currency: row.currency as Security['currency'], sector: row.sector as string | undefined,
    aliases: row.aliases as string[], sourceUrl: String(row.source_url), active: Boolean(row.active),listedAt:row.listed_at ? String(row.listed_at) : undefined };
}
export async function trackedSecurities(db: Queryable): Promise<Security[]> {
  const result = await db.query(`SELECT DISTINCT s.* FROM securities s JOIN watchlist w ON w.security_id=s.id
    JOIN users u ON u.id=w.user_id AND NOT u.disabled
    JOIN user_modules m ON m.user_id=u.id AND m.module_id='finance' AND m.enabled
    WHERE s.active ORDER BY s.id`);
  return result.rows.map(securityRow);
}
async function transaction<T>(client: PoolClient, work: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try { const result = await work(); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
}
async function withLock<T>(pool: Pool, key: string, work: (client: PoolClient) => Promise<T>): Promise<T | null> {
  const client = await pool.connect();
  let locked = false;
  try {
    const result = await client.query('SELECT pg_try_advisory_lock(hashtext(current_schema()),hashtext($1)) AS locked', [`zhiyu:${key}`]);
    locked = result.rows[0]?.locked === true;
    return locked ? await work(client) : null;
  } finally {
    try { if (locked) await client.query('SELECT pg_advisory_unlock(hashtext(current_schema()),hashtext($1))', [`zhiyu:${key}`]); }
    finally { client.release(); }
  }
}
async function beginSource(db: Queryable, id: string, name: string): Promise<void> {
  await db.query(`INSERT INTO source_runs(id,name,status,last_attempt) VALUES($1,$2,'pending',now())
    ON CONFLICT(id) DO UPDATE SET name=$2,status='pending',last_attempt=now(),error=NULL`, [id, name]);
}
async function endSource(db: Queryable, outcome: JobOutcome, dataDate?: string): Promise<void> {
  await db.query(`UPDATE source_runs SET status=$2,count=$3,error=$4,
    data_date=COALESCE($5::date,data_date),last_success=CASE WHEN $2 IN ('success','partial') THEN now() ELSE last_success END
    WHERE id=$1`, [outcome.source, outcome.status, outcome.count, outcome.warnings.join('；').slice(0, 1800) || null, dataDate ?? null]);
}
async function markDone(db: Queryable, key: string, now = new Date()): Promise<void> {
  await db.query(`INSERT INTO scheduler_state(key,value) VALUES($1,$2::jsonb)
    ON CONFLICT(key) DO UPDATE SET value=$2::jsonb,updated_at=now()`, [key, JSON.stringify({ completedAt: now.toISOString() })]);
}
async function upsertQuote(db: Queryable, quote: Quote, dataset: 'snapshot' | 'history'): Promise<void> {
  await db.query(`INSERT INTO quotes(security_id,date,data,fetched_at) VALUES($1,$2,$3::jsonb,$4)
    ON CONFLICT(security_id,date) DO UPDATE SET data=$3::jsonb,fetched_at=$4
    WHERE (EXCLUDED.data->>'dataset'='snapshot' AND COALESCE(quotes.data->>'dataset','snapshot')='history')
       OR (COALESCE(quotes.data->>'dataset','snapshot')=EXCLUDED.data->>'dataset' AND quotes.fetched_at <= EXCLUDED.fetched_at)`,
    [quote.securityId, quote.date, JSON.stringify({ ...quote, dataset }), quote.fetchedAt]);
}

export interface DigestInput {
  date: string; now: Date; expectedDate: string;
  securities: Security[]; quotes: Quote[]; news: NewsItem[];
  financialUpdates: Fundamentals[]; sourceWarnings: string[]; reports?: FinancialReport[];
}
export function buildDigest(input: DigestInput): Digest {
  const latest = new Map<string, Quote>();
  const securitiesById = new Map(input.securities.map(security => [security.id, security]));
  for (const quote of input.quotes) {
    const security = securitiesById.get(quote.securityId);
    if (security && regionOf(security.market) !== 'TW' && quote.date > internationalSessionDate(security.market, new Date(`${input.date}T20:30:00+08:00`))) continue;
    if (quote.date <= input.date && (!latest.has(quote.securityId) || latest.get(quote.securityId)!.date < quote.date)) latest.set(quote.securityId, quote);
  }
  const ids = new Set(input.securities.map(security => security.id));
  let up = 0, down = 0, unchanged = 0, missing = 0;
  const items: Digest['items'] = [];
  for (const security of input.securities) {
    const quote = latest.get(security.id);
    const expectedDate = regionOf(security.market) === 'TW' ? input.expectedDate : internationalSessionDate(security.market, new Date(`${input.date}T20:30:00+08:00`));
    const currency = security.currency === 'TWD' ? '元' : security.currency;
    if (!quote || quote.date < expectedDate || quote.close === null || quote.change === null || quote.status !== 'traded') {
      missing++;
      items.push({ securityId: security.id, title: `${security.symbol} ${security.name}`, body: !quote ? '尚無可用日行情。' :
        quote.date < expectedDate ? `最新行情為 ${quote.date}；尚待 ${expectedDate} 來源更新或休市確認。` :
          quote.status === 'suspended' ? `${quote.date} 暫停交易。` : quote.status === 'no_trade' ? `${quote.date} 無成交。` : `${quote.date} 部分行情欄位缺漏。` });
    } else {
      if (quote.change > 0) up++; else if (quote.change < 0) down++; else unchanged++;
      items.push({ securityId: security.id, title: `${security.symbol} ${security.name}`,
        body: `${quote.date} 收盤 ${quote.close.toLocaleString('zh-TW')} ${currency}，${quote.change > 0 ? '+' : ''}${quote.change.toLocaleString('zh-TW', { maximumFractionDigits: 4 })} ${currency}${quote.changePercent === null ? '' : `（${quote.changePercent > 0 ? '+' : ''}${quote.changePercent.toFixed(2)}%）`}。${quote.adjustment === 'split_adjusted' ? 'Yahoo 拆股調整價格，不含股息報酬。' : ''}` });
    }
  }
  const seenNews = new Set<string>();
  for (const item of [...input.news].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))) {
    if (seenNews.has(item.id) || item.matchType === 'market' || (item.datePrecision === 'day' ? item.publishedDate : taipeiParts(new Date(item.publishedAt)).date) !== input.date) continue;
    const securityId = item.securityIds.find(id => ids.has(id));
    if (!securityId) continue;
    seenNews.add(item.id);
    items.push({ securityId, title: `${item.kind === 'announcement' ? '公告' : item.matchType === 'provider' ? '來源關聯新聞' : '新聞'}｜${item.title}`, body: `${item.source} · ${item.datePrecision === 'day' ? item.publishedDate : item.publishedAt}${item.matchType === 'provider' ? '（由來源關聯至此標的，非公司公告）' : ''}`, url: item.url });
  }
  for (const update of input.financialUpdates) {
    if (!ids.has(update.securityId) || update.availability !== 'available') continue;
    items.push({ securityId: update.securityId, title: '財務資料更新', body: [
      update.revenuePeriod ? `${update.revenuePeriod} 月營收${update.revenue === null ? '待補' : ` ${update.revenue.toLocaleString('zh-TW')} ${update.unit}`}` : '',
      update.earningsPeriod ? `${update.earningsPeriod}（${update.basis === 'cumulative' ? '累計' : update.basis === 'annual' ? '年度' : '單季'}）EPS ${update.eps ?? '待補'}` : '',
    ].filter(Boolean).join('；'), url: update.sourceUrl });
  }
  for (const report of input.reports ?? []) if (ids.has(report.securityId)) items.push({ securityId: report.securityId, title: `${report.basis === 'quarter' ? '季度' : '年度'}財報更新`, body: `期末 ${report.periodEnd}，營收 ${report.revenue === null ? '待補' : report.revenue.toLocaleString('zh-TW')} ${report.currency}，EPS ${report.eps ?? '待補'} ${report.currency}／股。`, url: report.sourceUrl });
  const warnings = [...new Set(input.sourceWarnings)];
  if (input.securities.some(security => regionOf(security.market) !== 'TW')) items.push({ title: '國際資料說明', body: '依各市場已完成交易日整理；財報採來源報告幣別與季度／年度期間。新聞保留原文，可按需翻譯；完整休市日曆與官方公告尚未接通。' });
  if (warnings.length) items.push({ title: '資料更新狀態', body: warnings.join('；') });
  const tracked = input.securities.length;
  const partial = missing > 0 || warnings.length > 0;
  return { date: input.date, generatedAt: input.now.toISOString(), title: `${input.date.slice(5).replace('-', '/')} 每日摘要`,
    summary: tracked ? `追蹤 ${tracked} 檔：${up} 檔上漲、${down} 檔下跌、${unchanged} 檔持平${missing ? `，${missing} 檔資料待確認` : ''}。${partial ? '部分資料尚未齊備。' : ''}` : '加入你關心的股票，下一份摘要會整理它們的變化。',
    tracked, up, down, unchanged, missing, items, partial, read: false };
}

export function createJobHandlers(pool: Pool, providers: JobProviders = upstream) {
  let calendarCache: { year: number; loadedAt: number; dates: Set<string>; openDates: Set<string> } | undefined;
  async function tradingCalendar(now: Date) {
    const year = Number(taipeiParts(now).date.slice(0, 4));
    if (calendarCache?.year === year && now.getTime() - calendarCache.loadedAt < 86400000) return calendarCache;
    const key = `calendar:${year}`;
    const stored = await pool.query('SELECT value FROM scheduler_state WHERE key=$1', [key]);
    const previous: string[] = stored.rows[0]?.value?.dates ?? [];
    let dates = previous;
    let openDates: string[] = stored.rows[0]?.value?.openDates ?? [];
    try {
      if (providers.fetchTradingCalendar) {
        const result = await providers.fetchTradingCalendar(year);
        if (result.items.length) {
          dates = result.items.filter(day => day.closed).map(day => day.date);
          openDates = result.items.filter(day => !day.closed).map(day => day.date);
          await pool.query(`INSERT INTO scheduler_state(key,value) VALUES($1,$2::jsonb)
            ON CONFLICT(key) DO UPDATE SET value=$2::jsonb,updated_at=now()`, [key, JSON.stringify({ dates, openDates, fetchedAt: now.toISOString(), warnings: result.warnings })]);
        }
      }
    } catch { /* A calendar outage must not transform an unknown weekday into a claimed holiday. */ }
    calendarCache = { year, loadedAt: now.getTime(), dates: new Set(dates), openDates: new Set(openDates) };
    return calendarCache;
  }
  async function syncMarket(now = new Date()): Promise<JobOutcome[]> {
    const calendar = await tradingCalendar(now);
    const expected = expectedSessionDate(now, calendar.dates, calendar.openDates);
    const outcomes: JobOutcome[] = [];
    for (const market of ['TWSE', 'TPEx'] as const) {
      const source = `market.${market}`;
      const result = await withLock(pool, source, async client => {
        await beginSource(client, source, `${market} 每日行情`);
        try {
          const tracked = (await trackedSecurities(client)).filter(security => security.market === market);
          const catalogOnly = !tracked.length && !!providers.fetchSecurityCatalog;
          const snapshot = catalogOnly ? { securities: await providers.fetchSecurityCatalog!(market), quotes: [] as Quote[], dataDate: '', warnings: [] as string[] } : await providers.fetchMarketSnapshot(market);
          const warnings = [...snapshot.warnings];
          if (!snapshot.securities.length || !catalogOnly && !snapshot.quotes.length) throw new Error('官方來源未提供可用的股票與行情資料');
          if (snapshot.quotes.some(quote => !snapshot.securities.some(security => security.id === quote.securityId))) throw new Error('行情與股票目錄不一致');
          if (!catalogOnly && snapshot.dataDate < expected) warnings.push(`最新官方資料 ${snapshot.dataDate}，尚待 ${expected} 更新或休市確認`);
          await transaction(client, async () => {
            for (const security of snapshot.securities) {
              await client.query(`INSERT INTO securities(id,symbol,name,market,asset_type,currency,sector,aliases,source_url,active,listed_at)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)
                ON CONFLICT(id) DO UPDATE SET name=$3,asset_type=$5,sector=$7,aliases=$8::jsonb,source_url=$9,active=$10,listed_at=COALESCE($11,securities.listed_at),updated_at=now()`,
              [security.id, security.symbol, security.name, security.market, security.assetType, security.currency, security.sector ?? null, JSON.stringify(security.aliases), security.sourceUrl, security.active ?? true,security.listedAt ?? null]);
            }
            // The provider returns the complete official ISIN catalog, not just today's traded symbols.
            await client.query('UPDATE securities SET active=false,updated_at=now() WHERE market=$1 AND active AND NOT(id=ANY($2::text[]))',
              [market, snapshot.securities.map(security => security.id)]);
            const wanted = new Set((await trackedSecurities(client)).map(security => security.id));
            for (const quote of snapshot.quotes) if (wanted.has(quote.securityId)) await upsertQuote(client, quote, 'snapshot');
          });
          const outcome: JobOutcome = { source, status: warnings.length ? 'partial' : 'success', count: snapshot.quotes.filter(quote => tracked.some(security => security.id === quote.securityId)).length, warnings };
          await endSource(client, outcome, snapshot.dataDate || undefined);
          return outcome;
        } catch (error) {
          const outcome: JobOutcome = { source, status: 'error', count: 0, warnings: [safeError(error)] };
          await endSource(client, outcome); return outcome;
        }
      });
      outcomes.push(result ?? { source, status: 'skipped', count: 0, warnings: ['已有同步工作執行中'] });
    }
    if (outcomes.every(outcome => outcome.status === 'success')) await markDone(pool, 'market.sync', now);
    return outcomes;
  }
  async function syncFundamentals(now = new Date()): Promise<JobOutcome> {
    const source = 'fundamentals';
    return await withLock(pool, source, async client => {
      await beginSource(client, source, '官方月營收與財報');
      try {
        const tracked = (await trackedSecurities(client)).filter(security => regionOf(security.market) === 'TW');
        const result = tracked.length ? await providers.fetchFundamentals(tracked) : { items: [], warnings: [] };
        await transaction(client, async () => {
          for (const incoming of result.items) {
            if (!tracked.some(security => security.id === incoming.securityId)) continue;
            const previous = await client.query('SELECT data FROM fundamentals WHERE security_id=$1', [incoming.securityId]);
            const item = preserveLatestFundamentals(previous.rows[0]?.data, incoming);
            const changed = !previous.rows[0] || fundamentalFingerprint(previous.rows[0].data) !== fundamentalFingerprint(item);
            await client.query(`INSERT INTO fundamentals(security_id,data) VALUES($1,$2::jsonb)
              ON CONFLICT(security_id) DO UPDATE SET data=$2::jsonb,updated_at=now()`, [item.securityId, JSON.stringify(item)]);
            if (changed) await client.query(`INSERT INTO fundamental_versions(security_id,fingerprint,data,observed_at)
              VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(security_id,fingerprint) DO UPDATE SET data=$3::jsonb,observed_at=$4`,
              [item.securityId, fundamentalFingerprint(item), JSON.stringify(item), now]);
          }
        });
        // Status is shared by all users. It must not disclose another user's private watchlist symbols.
        const warnings = [...new Set(result.warnings.map(warning => {
          let sanitized = warning;
          for (const security of tracked) for (const privateLabel of [security.symbol, security.name, ...security.aliases]) {
            if (privateLabel.length >= 2) sanitized = sanitized.replaceAll(privateLabel, '追蹤標的');
          }
          return sanitized;
        }))];
        const missing = tracked.filter(security => !result.items.some(item => item.securityId === security.id && item.availability !== 'missing'));
        if (missing.length) warnings.push(`${missing.length} 檔基本面資料待補`);
        const outcome: JobOutcome = { source, status: warnings.length ? 'partial' : 'success', count: result.items.length, warnings };
        await endSource(client, outcome, result.dataDate);
        if (outcome.status === 'success') await markDone(client, 'fundamentals.sync', now);
        return outcome;
      } catch (error) {
        const outcome: JobOutcome = { source, status: 'error', count: 0, warnings: [safeError(error)] };
        await endSource(client, outcome); return outcome;
      }
    }) ?? { source, status: 'skipped', count: 0, warnings: ['已有同步工作執行中'] };
  }
  async function syncNews(now = new Date()): Promise<JobOutcome> {
    const source = 'news';
    return await withLock(pool, source, async client => {
      await beginSource(client, source, '中央社新聞與公司公告');
      try {
        const tracked = (await trackedSecurities(client)).filter(security => regionOf(security.market) === 'TW');
        const fetched = tracked.length ? await providers.fetchNews(tracked) : { items: [], warnings: [], dataDate: undefined };
        const result = { ...fetched, items: fetched.items.filter(item => item.securityIds.some(id => tracked.some(security => security.id === id))) };
        await transaction(client, async () => {
          for (const item of result.items) {
            await client.query(`INSERT INTO news(id,data,published_at) VALUES($1,$2::jsonb,$3)
              ON CONFLICT(id) DO UPDATE SET data=jsonb_set(
                EXCLUDED.data || jsonb_build_object('matchType', CASE WHEN news.data->>'matchType'='exact' OR EXCLUDED.data->>'matchType'='exact' THEN 'exact' ELSE 'market' END),
                '{securityIds}', (SELECT COALESCE(jsonb_agg(DISTINCT value),'[]'::jsonb)
                  FROM jsonb_array_elements(COALESCE(news.data->'securityIds','[]'::jsonb) || COALESCE(EXCLUDED.data->'securityIds','[]'::jsonb)) AS related(value))),
                published_at=$3`, [item.id, JSON.stringify(item), item.publishedAt]);
          }
        });
        const outcome: JobOutcome = { source, status: result.warnings.length ? 'partial' : 'success', count: result.items.length, warnings: result.warnings };
        await endSource(client, outcome, result.dataDate);
        if (outcome.status === 'success') await markDone(client, 'news.sync', now);
        return outcome;
      } catch (error) {
        const outcome: JobOutcome = { source, status: 'error', count: 0, warnings: [safeError(error)] };
        await endSource(client, outcome); return outcome;
      }
    }) ?? { source, status: 'skipped', count: 0, warnings: ['已有同步工作執行中'] };
  }
  async function backfillHistory(securityId?: string, month?: string, now = new Date()): Promise<JobOutcome[]> {
    if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('歷史月份格式錯誤');
    const tracked = (await trackedSecurities(pool)).filter(security => regionOf(security.market) === 'TW' && (!securityId || security.id === securityId));
    const outcomes: JobOutcome[] = [];
    for (const security of tracked) {
      for (const requestedMonth of month ? [month] : historyMonths(now, await historyYears(pool,security.id))) {
        if (security.listedAt && requestedMonth < security.listedAt.slice(0,7)) continue;
        const active = await pool.query(`SELECT 1 FROM watchlist w JOIN users u ON u.id=w.user_id AND NOT u.disabled
          JOIN user_modules m ON m.user_id=u.id AND m.module_id='finance' AND m.enabled WHERE w.security_id=$1 LIMIT 1`, [security.id]);
        if (!active.rows.length) break;
        const source = `history:${security.id}:${requestedMonth}`;
        const outcome = await withLock(pool, source, async client => {
          const previous = await client.query('SELECT status,last_attempt FROM history_progress WHERE security_id=$1 AND month=$2', [security.id, requestedMonth]);
          // Completed past months are immutable. Refresh the open month once per Taipei day.
          if (previous.rows[0]?.status === 'complete' && (requestedMonth !== taipeiParts(now).date.slice(0, 7) || taipeiParts(new Date(previous.rows[0].last_attempt)).date === taipeiParts(now).date)) {
            return { source, status: 'skipped' as const, count: 0, warnings: [] };
          }
          if (previous.rows[0]?.status === 'partial' && now.getTime()-new Date(previous.rows[0].last_attempt).getTime()<7*86400000) return { source,status:'skipped' as const,count:0,warnings:[] };
          await client.query(`INSERT INTO history_progress(security_id,month,status,last_attempt) VALUES($1,$2,'pending',$3)
            ON CONFLICT(security_id,month) DO UPDATE SET status='pending',last_attempt=$3,error=NULL`, [security.id, requestedMonth, now]);
          try {
            const result = await providers.fetchHistory(security, requestedMonth);
            const quotes = result.items.filter(quote => quote.securityId === security.id && quote.date.startsWith(requestedMonth));
            const warnings = [...result.warnings];
            if (!quotes.length) warnings.push('此月份無可取得的歷史資料；未宣稱完整涵蓋');
            await transaction(client, async () => {
              for (const quote of quotes) await upsertQuote(client, quote, 'history');
              await client.query('UPDATE history_progress SET status=$3,error=$4 WHERE security_id=$1 AND month=$2',
                [security.id, requestedMonth, warnings.length ? 'partial' : 'complete', warnings.join('；') || null]);
            });
            return { source, status: warnings.length ? 'partial' as const : 'success' as const, count: quotes.length, warnings };
          } catch (error) {
            const message = safeError(error);
            await client.query("UPDATE history_progress SET status='error',error=$3 WHERE security_id=$1 AND month=$2", [security.id, requestedMonth, message]);
            return { source, status: 'error' as const, count: 0, warnings: [message] };
          }
        });
        outcomes.push(outcome ?? { source, status: 'skipped', count: 0, warnings: ['已有同步工作執行中'] });
      }
    }
    return outcomes;
  }
  async function generateDigests(now = new Date(), date = latestDigestDate(now)): Promise<number> {
    const value = await withLock(pool, 'digest.generate', async client => {
      const digestTime = new Date(`${date}T20:30:00+08:00`);
      const calendar = await tradingCalendar(digestTime);
      const expectedDate = expectedSessionDate(digestTime, calendar.dates, calendar.openDates);
      const users = await client.query(`SELECT u.id FROM users u JOIN user_modules m ON m.user_id=u.id
        WHERE NOT u.disabled AND m.module_id='finance' AND m.enabled`);
      const sourceResult = await client.query('SELECT id,name,status,error FROM source_runs');
      const start = `${date}T00:00:00+08:00`, end = `${addDays(date, 1)}T00:00:00+08:00`;
      const news = (await client.query("SELECT data FROM news WHERE (data->>'datePrecision'='day' AND data->>'publishedDate'=$3) OR (COALESCE(data->>'datePrecision','minute') <> 'day' AND published_at >= $1 AND published_at < $2) ORDER BY published_at DESC", [start, end, date])).rows.map(row => row.data as NewsItem);
      let count = 0;
      for (const user of users.rows) {
        await transaction(client, async () => {
          // A concurrent user deletion/module disable must not recreate their private digest.
          const enabled = await client.query(`SELECT u.id FROM users u JOIN user_modules m ON m.user_id=u.id
            WHERE u.id=$1 AND NOT u.disabled AND m.module_id='finance' AND m.enabled FOR SHARE OF u,m`, [user.id]);
          if (!enabled.rows.length) return;
          const securities = (await client.query('SELECT s.* FROM securities s JOIN watchlist w ON w.security_id=s.id WHERE w.user_id=$1', [user.id])).rows.map(securityRow);
          const ids = securities.map(security => security.id);
          const quotes = (await client.query(`SELECT data FROM quotes
            WHERE security_id=ANY($1::text[]) AND date <= $2 AND date >= $3 ORDER BY security_id,date DESC`, [ids, date, addDays(date, -30)])).rows.map(row => row.data as Quote);
          const financialUpdates = (await client.query(`SELECT DISTINCT ON(security_id) data FROM fundamental_versions
            WHERE security_id=ANY($1::text[]) AND observed_at >= $2 AND observed_at < $3
            ORDER BY security_id,observed_at DESC`, [ids, start, end])).rows.map(row => row.data as Fundamentals);
          const relevantSourceIds = new Set([...(securities.some(security => regionOf(security.market) === 'TW') ? ['news', 'fundamentals'] : []), ...securities.map(security => regionOf(security.market) === 'TW' ? `market.${security.market}` : `yahoo.${regionOf(security.market)}`)]);
          for (const security of securities.filter(security => regionOf(security.market)!=='TW')) { relevantSourceIds.add(`content.${regionOf(security.market)}.news`); if (security.assetType==='stock') relevantSourceIds.add(`content.${regionOf(security.market)}.financials`); }
          const reports = providers.fetchInternationalFinancials ? (await client.query(`SELECT DISTINCT ON(security_id,basis) data FROM financial_reports WHERE security_id=ANY($1::text[]) AND observed_at >= $2 AND observed_at < $3 ORDER BY security_id,basis,period_end DESC`, [ids,start,end])).rows.map(row=>row.data as FinancialReport) : [];
          const sourceWarnings = sourceResult.rows.filter(row => relevantSourceIds.has(row.id) && row.status !== 'success').map(row => `${row.name}：${row.error || '資料尚未更新'}`);
          if (ids.length) {
            for (const source of relevantSourceIds) if (!sourceResult.rows.some(row => row.id === source)) sourceWarnings.push(`${source} 尚未完成首次同步`);
          }
          const digest = buildDigest({ date, now, expectedDate, securities, quotes, news, financialUpdates, reports, sourceWarnings: ids.length ? sourceWarnings : [] });
          await client.query(`INSERT INTO digests(user_id,date,data) VALUES($1,$2,$3::jsonb)
            ON CONFLICT(user_id,date) DO UPDATE SET data=$3::jsonb,updated_at=now()`, [user.id, date, JSON.stringify(digest)]);
          count++;
        });
      }
      await markDone(client, 'digest.generate', now);
      return count;
    });
    return value ?? 0;
  }
  async function syncInternational(now = new Date()): Promise<JobOutcome[]> {
    if (!providers.fetchInternationalHistory) return [];
    return await withLock(pool, 'yahoo.sync', async client => {
      const tracked = (await trackedSecurities(client)).filter(security => regionOf(security.market) !== 'TW');
      const outcomes: JobOutcome[] = [];
      for (const region of ['US', 'JP'] as const) {
        const source = `yahoo.${region}`;
        const selected = tracked.filter(security => regionOf(security.market) === region);
        if (!selected.length) continue;
        const due: Security[] = [];
        for (const security of selected) {
          const months = historyMonths(now,await historyYears(client,security.id));
          const horizonAttempted = (await client.query('SELECT 1 FROM history_progress WHERE security_id=$1 AND month=$2',[security.id,months.at(-1)])).rowCount;
          const latest = await client.query('SELECT date,fetched_at FROM quotes WHERE security_id=$1 ORDER BY date DESC LIMIT 1', [security.id]);
          const progress = await client.query('SELECT last_attempt FROM history_progress WHERE security_id=$1 ORDER BY last_attempt DESC LIMIT 1', [security.id]);
          const attempt = progress.rows[0]?.last_attempt;
          if (horizonAttempted && attempt && now.getTime() - new Date(attempt).getTime() < 3600_000) continue;
          if (horizonAttempted && latest.rows[0]?.date >= internationalSessionDate(security.market, now) && now.getTime() - new Date(latest.rows[0].fetched_at).getTime() < 86400_000) continue;
          due.push(security);
        }
        if (!due.length) { outcomes.push({ source, status: 'skipped', count: 0, warnings: [] }); continue; }
        await beginSource(client, source, `Yahoo ${region === 'US' ? '美股' : '日股'}收盤與日線`);
        const warnings: string[] = []; let count = 0;
        for (const security of due) {
          // Recheck enabled ownership before every actual source request.
          if (!(await trackedSecurities(client)).some(item => item.id === security.id)) continue;
          const month = taipeiParts(now).date.slice(0, 7);
          const years = await historyYears(client,security.id);
          const firstMonth = historyMonths(now,years).at(-1)!;
          await client.query(`INSERT INTO history_progress(security_id,month,status,last_attempt) VALUES($1,$2,'pending',$3)
            ON CONFLICT(security_id,month) DO UPDATE SET status='pending',last_attempt=$3,error=NULL`, [security.id, month, now]);
          await client.query(`INSERT INTO history_progress(security_id,month,status,last_attempt) VALUES($1,$2,'pending',$3)
            ON CONFLICT(security_id,month) DO UPDATE SET status='pending',last_attempt=$3,error=NULL`, [security.id,firstMonth,now]);
          try {
            const result = await providers.fetchInternationalHistory!(security, now, years);
            if (!result.items.length || result.items.some(item => item.securityId !== security.id)) throw new Error('Yahoo 回傳資料與請求標的不一致。');
            await transaction(client, async () => {
              // Replace the whole window atomically so a newly applied split cannot mix price bases.
              const from = result.items[0].date, to = result.items.at(-1)!.date;
              await client.query('DELETE FROM quotes WHERE security_id=$1 AND date >= $2 AND date <= $3', [security.id, from, to]);
              for (const quote of result.items) await upsertQuote(client, quote, 'history');
              for (const requestedMonth of historyMonths(now,years)) {
                const available = result.items.some(item => item.date.startsWith(requestedMonth));
                await client.query(`INSERT INTO history_progress(security_id,month,status,last_attempt,error) VALUES($1,$2,$3,$4,$5)
                  ON CONFLICT(security_id,month) DO UPDATE SET status=$3,last_attempt=$4,error=$5`, [security.id, requestedMonth, available && !result.warnings.length ? 'complete' : 'partial', now, available ? null : '此月份無可取得資料']);
              }
            });
            count += result.items.length;
            if (result.warnings.length) warnings.push(...result.warnings);
            if (!result.dataDate || result.dataDate < internationalSessionDate(security.market, now)) warnings.push('部分標的尚待最新交易日資料或休市確認。');
          } catch (error) {
            const message = safeError(error);
            warnings.push(message);
            await client.query("UPDATE history_progress SET status='error',error=$3 WHERE security_id=$1 AND month=ANY($2::text[])", [security.id, [month,firstMonth], message]);
            if (/HTTP (401|403|429)|要求暫停/.test(message)) break;
          }
        }
        const dates = await client.query('SELECT min(latest) AS date FROM (SELECT max(date) AS latest FROM quotes WHERE security_id=ANY($1::text[]) GROUP BY security_id) q', [selected.map(security => security.id)]);
        const outcome: JobOutcome = { source, status: warnings.length ? count ? 'partial' : 'error' : 'success', count, warnings: [...new Set(warnings)] };
        await endSource(client, outcome, dates.rows[0]?.date || undefined); outcomes.push(outcome);
      }
      return outcomes;
    }) ?? [{ source: 'yahoo', status: 'skipped', count: 0, warnings: [] }];
  }
  return { syncMarket, syncInternational, syncFundamentals, syncNews, backfillHistory, generateDigests, ...createContentJobs(pool, providers) };
}

export interface HistoryQueue { send(name: string, data: object, options: SendOptions): Promise<unknown>; }
export async function enqueueHistory(boss: HistoryQueue, securityId: string, now = new Date(), years = 10, listedAt?: string): Promise<void> {
  if (!securityId.startsWith('TWSE:') && !securityId.startsWith('TPEx:')) {
    await boss.send('international.sync', {}, { singletonKey: GLOBAL_JOB_KEY, retryLimit: 0 });
    return;
  }
  for (const month of historyMonths(now,years)) {
    if (listedAt && month < listedAt.slice(0,7)) continue;
    await boss.send('history.backfill', { securityId, month }, { singletonKey: `${securityId}:${month}`, singletonSeconds: 3600, retryLimit: 2, retryDelay: 120, retryBackoff: true });
  }
}
export function catchupNeeded(completedAt: Partial<Record<QueueName, string>>, now = new Date()): QueueName[] {
  const needed: QueueName[] = [];
  const marketAt = completedAt['market.sync'];
  if (!marketAt || expectedSessionDate(new Date(marketAt)) < expectedSessionDate(now)) needed.push('market.sync');
  const newsAt = completedAt['news.sync'];
  if (!newsAt || now.getTime() - Date.parse(newsAt) >= 3600000) needed.push('news.sync');
  const digestAt = completedAt['digest.generate'];
  if (!digestAt || latestDigestDate(new Date(digestAt)) < latestDigestDate(now)) needed.push('digest.generate');
  return needed;
}
