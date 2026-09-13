import YahooFinance from 'yahoo-finance2';
import type { ChartResultArray } from 'yahoo-finance2/modules/chart';
import type { Market, ProviderResult, Quote, Region, Security } from '../../shared/types.js';
import { exchangeDate, regionOf, timeZoneOf } from '../../shared/markets.js';
import { retryAfterMilliseconds } from './http.js';

const allowedHosts = new Set(['query1.finance.yahoo.com', 'query2.finance.yahoo.com', 'finance.yahoo.com', 'consent.yahoo.com', 'guce.yahoo.com']);
const exchanges: Record<string, Market> = { NMS: 'NASDAQ', NGM: 'NASDAQ', NCM: 'NASDAQ', NYQ: 'NYSE', PCX: 'NYSEARCA', ASE: 'NYSEAMERICAN', BTS: 'CBOE', BATS: 'CBOE', JPX: 'TSE' };
export class YahooUnavailable extends Error { constructor(message = 'Yahoo 行情暫時無法取得，請稍後再試。') { super(message); this.name = 'YahooUnavailable'; } }
export function yahooSymbol(security: Security): string {
  if (regionOf(security.market) === 'TW') throw new Error('台股使用交易所來源');
  return security.market === 'TSE' ? `${security.symbol}.T` : security.symbol;
}
export function assertYahooSymbol(symbol: string): void {
  if (!/^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(symbol)) throw new Error('無效的股票代號');
}
const silent = () => {};

/** One instance per process; never log Yahoo cookies, crumb, raw errors or query strings. */
export function createYahooClient(transport: typeof fetch = fetch, inspectBody?: (url: URL, body: Uint8Array) => void) {
  let blockedUntil = 0;
  const guardedFetch: typeof fetch = async (input, init) => {
    if (Date.now() < blockedUntil) throw new YahooUnavailable('Yahoo 要求暫停請求，稍後再試。');
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !allowedHosts.has(url.hostname)) throw new YahooUnavailable('來源目的地未通過檢查。');
    let response: Response;
    try { response = await transport(input, { ...init, redirect: 'manual', signal: AbortSignal.timeout(20_000) }); }
    catch { throw new YahooUnavailable(); }
    if ([401, 403, 429].includes(response.status)) {
      const delay = Math.max(response.status === 429 ? 60_000 : 3_600_000, retryAfterMilliseconds(response.headers.get('retry-after')));
      blockedUntil = Date.now() + delay;
      await response.body?.cancel();
      throw new YahooUnavailable(`Yahoo HTTP ${response.status}，已暫停此來源，稍後再試。`);
    }
    if (!response.ok && ![301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel(); throw new YahooUnavailable(`Yahoo HTTP ${response.status}，保留上次資料。`);
    }
    // Bound response memory before handing data to the package's schema validator.
    if (Number(response.headers.get('content-length')) > 8_000_000) { await response.body?.cancel(); throw new YahooUnavailable('Yahoo 回應過大。'); }
    const chunks: Uint8Array[] = []; let length = 0;
    const reader = response.body?.getReader();
    if (reader) for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      length += chunk.value.length;
      if (length > 8_000_000) { await reader.cancel(); throw new YahooUnavailable('Yahoo 回應過大。'); }
      chunks.push(chunk.value);
    }
    const body = chunks.length ? Buffer.concat(chunks) : null;
    if (body && response.ok) inspectBody?.(url, body);
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  return new YahooFinance({ fetch: guardedFetch, versionCheck: false, queue: { concurrency: 1, interval: 3000 },
    logger: { info: silent, warn: silent, error: silent, debug: silent, dir: silent }, validation: { logErrors: false }, suppressNotices: ['yahooSurvey'] });
}
// The library drops reporting currency and zero values when transforming statements.
// Keep the bounded source response only until the corresponding call is normalized.
const financialResponses = new Map<string, unknown>();
const client = createYahooClient(fetch, (url, body) => {
  if (!url.pathname.startsWith('/ws/fundamentals-timeseries/')) return;
  const symbol = decodeURIComponent(url.pathname.split('/').at(-1)!);
  const type = url.searchParams.get('type')?.startsWith('annual') ? 'annual' : 'quarterly';
  if (financialResponses.size > 100) financialResponses.clear();
  financialResponses.set(`${symbol}:${type}`, JSON.parse(new TextDecoder().decode(body)));
});
export async function yahooFinancialSource(symbol: string, type: 'annual' | 'quarterly', now = new Date()): Promise<unknown> {
  assertYahooSymbol(symbol);
  const key = `${symbol}:${type}`; financialResponses.delete(key);
  // Request a decade; Yahoo may return a shorter window. Preserve every returned period.
  const from = new Date(now); from.setUTCFullYear(from.getUTCFullYear() - 10);
  try {
    await client.fundamentalsTimeSeries(symbol, { period1: from, period2: now, type, module: 'all' });
    const raw = financialResponses.get(key); if (!raw) throw new YahooUnavailable('Yahoo 財報回應缺少原始幣別資料。');
    return raw;
  } catch (error) { throw error instanceof YahooUnavailable ? error : new YahooUnavailable('Yahoo 財報暫時無法取得，保留上次資料。'); }
  finally { financialResponses.delete(key); }
}
export async function yahooNewsSource(symbol: string) {
  assertYahooSymbol(symbol);
  try { return (await client.search(symbol, { quotesCount: 0, newsCount: 20, enableFuzzyQuery: false })).news; }
  catch (error) { throw error instanceof YahooUnavailable ? error : new YahooUnavailable('Yahoo 新聞暫時無法取得，保留上次資料。'); }
}
const lookupCache = new Map<string, { expires: number; promise: Promise<Security[]> }>();

export function securityFromYahoo(row: { symbol?: string; exchange?: string; quoteType?: string; shortname?: string; longname?: string }, region: Exclude<Region, 'TW'>): Security | null {
  if (!row.symbol || !row.exchange || !['EQUITY', 'ETF'].includes(row.quoteType ?? '')) return null;
  const market = exchanges[row.exchange];
  if (!market || regionOf(market) !== region) return null;
  try { assertYahooSymbol(row.symbol); } catch { return null; }
  if (region === 'JP' && !/^[A-Z0-9]{4}\.T$/.test(row.symbol)) return null;
  if (region === 'US' && row.symbol.includes('.')) return null;
  const symbol = region === 'JP' ? row.symbol.slice(0, -2) : row.symbol;
  const name = row.longname || row.shortname || symbol;
  return { id: `${market}:${symbol}`, symbol, name, market, assetType: row.quoteType === 'ETF' ? 'etf' : 'stock', currency: region === 'JP' ? 'JPY' : 'USD', aliases: [...new Set([name, row.shortname].filter((v): v is string => Boolean(v)))], sourceUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(row.symbol)}/`, active: true };
}

export async function searchYahoo(query: string, region: Exclude<Region, 'TW'>): Promise<Security[]> {
  const normalized = query.trim();
  if (!normalized || normalized.length > 80) return [];
  const search = region === 'JP' && /^[a-z0-9]{4}$/i.test(normalized) ? `${normalized.toUpperCase()}.T` : normalized;
  const key = `${region}:${search.toUpperCase()}`;
  const cached = lookupCache.get(key); if (cached && cached.expires > Date.now()) return cached.promise;
  if (lookupCache.size >= 200) lookupCache.delete(lookupCache.keys().next().value!);
  const promise = client.search(search, { quotesCount: 25, newsCount: 0 }).then(result => result.quotes.map(row => row.isYahooFinance ? securityFromYahoo(row, region) : null).filter((s): s is Security => s !== null)).catch(error => {
    lookupCache.delete(key); throw error instanceof YahooUnavailable ? error : new YahooUnavailable('Yahoo 搜尋暫時無法取得，請稍後再試。');
  });
  lookupCache.set(key, { expires: Date.now() + 600_000, promise });
  return promise;
}

const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const price = (value: unknown): number | null => { const n = finite(value); return n === null || n <= 0 ? null : Math.round(n * 1_000_000) / 1_000_000; };
export function normalizeYahooHistory(security: Security, data: ChartResultArray, now = new Date()): ProviderResult<Quote> {
  const timezone = timeZoneOf(security.market), symbol = yahooSymbol(security);
  if (data.meta.symbol !== symbol || data.meta.currency !== security.currency || data.meta.exchangeTimezoneName !== timezone || exchanges[data.meta.exchangeName] !== security.market || data.meta.instrumentType !== (security.assetType === 'etf' ? 'ETF' : 'EQUITY')) throw new YahooUnavailable('Yahoo 回傳的標的、市場、幣別或商品類型不一致。');
  const today = exchangeDate(now, timezone);
  const regular = data.meta.currentTradingPeriod?.regular;
  const closedToday = regular && exchangeDate(new Date(regular.end), timezone) === today && now.getTime() >= new Date(regular.end).getTime() + 30 * 60_000;
  const byDate = new Map<string, Quote>(); const warnings: string[] = [];
  for (const bar of data.quotes) {
    const date = exchangeDate(new Date(bar.date), timezone);
    if (date > today || date === today && !closedToday) continue; // An intraday bar is never an EOD close.
    const close = price(bar.close), open = price(bar.open), high = price(bar.high), low = price(bar.low);
    const volume = finite(bar.volume);
    if (close === null || volume !== null && volume < 0 || high !== null && low !== null && high < low || close !== null && high !== null && close > high + 0.00001 || close !== null && low !== null && close < low - 0.00001) { warnings.push('部分日線欄位無效，已略過。'); continue; }
    byDate.set(date, { securityId: security.id, date, open, high, low, close, volume, change: null, changePercent: null, source: security.sourceUrl, fetchedAt: now.toISOString(), priceType: 'eod', adjustment: 'split_adjusted', dataset: 'history', volumePrecision: 'shares', status: volume === 0 ? 'no_trade' : 'traded' });
  }
  const items = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (let i = 1; i < items.length; i++) {
    const previous = items[i - 1].close;
    if (previous && items[i].close !== null && items[i].status === 'traded') {
      const ratio = items[i].close! / previous;
      if (ratio > 4 || ratio < 0.25) {
        // Flag, never guess a correction: this can be a corporate action or bad source data.
        items[i].qualityWarning = '價格出現大幅跳點，拆股調整或來源資料待核對。';
        warnings.push('歷史價格出現大幅跳點，可能涉及拆股調整；原值保留，異常日漲跌不計算。');
        continue;
      }
      const change = items[i].close! - previous;
      items[i].change = Math.round(change * 1_000_000) / 1_000_000;
      items[i].changePercent = change / previous * 100;
    }
  }
  if (!items.length) throw new YahooUnavailable('Yahoo 尚無已完成交易日的可用行情。');
  return { items, dataDate: items.at(-1)!.date, warnings: [...new Set(warnings)] };
}

export async function fetchInternationalHistory(security: Security, now = new Date(), years = 10): Promise<ProviderResult<Quote>> {
  if (![5,10,20].includes(years)) throw new Error('Unsupported history horizon');
  const symbol = yahooSymbol(security); assertYahooSymbol(symbol);
  // Refresh the entire requested window together; past split adjustments can change.
  const from = new Date(now); from.setUTCFullYear(from.getUTCFullYear() - years); from.setUTCDate(from.getUTCDate() - 7);
  try { return normalizeYahooHistory(security, await client.chart(symbol, { period1: from, period2: now, interval: '1d', includePrePost: false, events: 'div|split', return: 'array' }), now); }
  catch (error) { throw error instanceof YahooUnavailable ? error : new YahooUnavailable('Yahoo 日線格式或連線異常，保留上次資料。'); }
}
