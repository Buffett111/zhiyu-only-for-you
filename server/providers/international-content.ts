import { createHash } from 'node:crypto';
import type { SearchNews } from 'yahoo-finance2/modules/search';
import type { FinancialReport, NewsItem, ProviderResult, Security } from '../../shared/types';
import { exchangeDate } from '../../shared/markets';
import { yahooFinancialSource, yahooNewsSource, yahooSymbol, YahooUnavailable } from './yahoo';
import { officialText } from './http';

type Row = Record<string, any>;
const record = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const datePattern = /^20\d{2}-\d{2}-\d{2}$/;
const numeric = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const metrics = ['TotalRevenue','GrossProfit','OperatingIncome','NetIncome','DilutedEPS','BasicEPS','TotalAssets','TotalLiabilitiesNetMinorityInterest','StockholdersEquity','OperatingCashFlow','FreeCashFlow'] as const;

/** Normalize original reported values: the package transformer omits currency and zero. */
export function parseFinancialReports(raw: unknown, security: Security, basis: 'quarter' | 'annual', now = new Date()): ProviderResult<FinancialReport> {
  const source = record(record(raw).timeseries), symbol = yahooSymbol(security);
  if (!Array.isArray(source.result) || source.error) throw new YahooUnavailable('Yahoo 財報格式無法辨識。');
  const byDate = new Map<string, { currency: string; values: Row; invalid: boolean }>();
  const prefix = basis === 'quarter' ? 'quarterly' : 'annual', period = basis === 'quarter' ? '3M' : '12M';
  const warnings: string[] = [];
  for (const value of source.result) {
    const series = record(value), meta = record(series.meta);
    if (!Array.isArray(meta.symbol) || !meta.symbol.includes(symbol)) throw new YahooUnavailable('Yahoo 財報標的與請求不一致。');
    for (const metric of metrics) {
      const key = prefix + metric;
      if (!Array.isArray(series[key])) continue;
      for (const value of series[key]) {
        const point = record(value), date = String(point.asOfDate ?? ''), currency = String(point.currencyCode ?? '');
        if (!datePattern.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date || date > now.toISOString().slice(0,10) || point.periodType !== period) continue;
        if (!/^[A-Z]{3}$/.test(currency)) { warnings.push('部分財報缺少報告幣別，已略過。'); continue; }
        const existing = byDate.get(date) ?? { currency, values: {}, invalid: false };
        if (existing.currency !== currency) existing.invalid = true;
        const number = numeric(record(point.reportedValue).raw);
        if (number !== null) existing.values[metric] = number;
        byDate.set(date, existing);
      }
    }
  }
  const items: FinancialReport[] = [];
  for (const [periodEnd, row] of byDate) {
    if (row.invalid) { warnings.push('同一期財報的幣別不一致，已略過。'); continue; }
    const get = (key: string) => numeric(row.values[key]);
    if (!Object.keys(row.values).length) continue;
    const revenue = get('TotalRevenue'), grossProfit = get('GrossProfit'), operatingIncome = get('OperatingIncome');
    const diluted = get('DilutedEPS'), basic = get('BasicEPS');
    items.push({ securityId: security.id, periodEnd, basis, currency: row.currency, revenue, grossProfit, operatingIncome,
      netIncome: get('NetIncome'), eps: diluted ?? basic, epsType: diluted !== null ? 'diluted' : basic !== null ? 'basic' : null,
      grossMargin: revenue && grossProfit !== null ? grossProfit / revenue * 100 : null,
      operatingMargin: revenue && operatingIncome !== null ? operatingIncome / revenue * 100 : null,
      totalAssets: get('TotalAssets'), totalLiabilities: get('TotalLiabilitiesNetMinorityInterest'), totalEquity: get('StockholdersEquity'),
      operatingCashFlow: get('OperatingCashFlow'), freeCashFlow: get('FreeCashFlow'),
      sourceUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/financials/`, fetchedAt: now.toISOString() });
  }
  items.sort((a,b) => b.periodEnd.localeCompare(a.periodEnd));
  return { items: items.slice(0, basis === 'quarter' ? 5 : 3), dataDate: items[0]?.periodEnd, warnings: [...new Set(warnings)] };
}
export async function fetchInternationalFinancials(security: Security, now = new Date()): Promise<ProviderResult<FinancialReport>> {
  if (security.assetType === 'etf') return { items: [], warnings: [] };
  const items: FinancialReport[] = [], warnings: string[] = [];
  for (const basis of ['quarter','annual'] as const) {
    try { const result = parseFinancialReports(await yahooFinancialSource(yahooSymbol(security), basis === 'quarter' ? 'quarterly' : 'annual', now), security, basis, now); items.push(...result.items); warnings.push(...result.warnings); }
    catch (error) { warnings.push(error instanceof YahooUnavailable ? error.message : 'Yahoo 財報取得失敗。'); if (/HTTP (401|403|429)|要求暫停/.test(warnings.at(-1)!)) break; }
  }
  if (!items.length) warnings.push('來源尚未提供可用財報。');
  return { items, dataDate: items.map(row => row.periodEnd).sort().at(-1), warnings: [...new Set(warnings)] };
}

function safeLink(value: string): string | null {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export function parseYahooNews(rows: SearchNews[], security: Security, now = new Date()): NewsItem[] {
  const symbol = yahooSymbol(security);
  return rows.flatMap(row => {
    const url = safeLink(row.link), time = new Date(row.providerPublishTime).getTime();
    // Global Yahoo sometimes returns general headlines for unmatched symbols.
    if (!row.relatedTickers?.includes(symbol) || !url || !row.title || !Number.isFinite(time) || time > now.getTime() + 300000 || time < now.getTime() - 90 * 86400000) return [];
    return [{ id: `yahoo:${createHash('sha256').update(row.uuid || url).digest('hex').slice(0,32)}`, title: row.title.slice(0,700), url,
      publishedAt: new Date(time).toISOString(), source: row.publisher || 'Yahoo Finance', kind: 'news' as const,
      securityIds: [security.id], matchType: 'provider' as const, language: 'en', sourcePage: security.sourceUrl }];
  }).slice(0,20);
}

function japanNewsDate(value: string, now: Date): { iso: string; day: string; precision: 'day' | 'minute' } | null {
  const today = exchangeDate(now, 'Asia/Tokyo');
  let date = today, time = '00:00', precision: 'day' | 'minute' = 'day';
  const day = /^(?:(20\d{2})\/)?(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}:\d{2}))?$/.exec(value);
  if (day) {
    let year = day[1] ?? today.slice(0,4);
    date = `${year}-${day[2].padStart(2,'0')}-${day[3].padStart(2,'0')}`;
    if (!day[1] && date > today) { year = String(Number(year)-1); date = `${year}${date.slice(4)}`; }
    if (day[4]) { time = day[4].padStart(5,'0'); precision = 'minute'; }
  } else if (/^\d{1,2}:\d{2}$/.test(value)) { time = value.padStart(5,'0'); precision = 'minute'; }
  else return null;
  const milliseconds = Date.parse(`${date}T${time}:00+09:00`);
  if (!Number.isFinite(milliseconds) || milliseconds > now.getTime()+300000 || milliseconds < now.getTime()-90*86400000) return null;
  return { iso: new Date(milliseconds).toISOString(), day: date, precision };
}
/** Read serialized public page data as JSON; never execute remote scripts. */
export function parseJapanNews(html: string, security: Security, now = new Date()): ProviderResult<NewsItem> {
  const symbol = yahooSymbol(security), candidates: Row[] = [];
  for (const match of html.matchAll(/self\.__next_f\.push\((\[1,"(?:\\.|[^"\\])*"\])\)/g)) {
    let decoded: string; try { decoded = JSON.parse(match[1])[1]; } catch { continue; }
    for (const line of decoded.split('\n')) {
      const colon = line.indexOf(':'); if (colon < 0) continue;
      let root: unknown; try { root = JSON.parse(line.slice(colon+1)); } catch { continue; }
      const stack: unknown[] = [root]; let visited = 0;
      while (stack.length && ++visited < 50000) {
        const node = stack.pop();
        if (Array.isArray(node)) stack.push(...node);
        else if (node && typeof node === 'object') {
          const row = record(node);
          if (record(record(row.priceBoard).board).codeWithMarketExtension === symbol && Array.isArray(record(row.newsTopics).articles)) candidates.push(row);
          stack.push(...Object.values(row));
        }
      }
    }
  }
  if (!candidates.length) throw new YahooUnavailable('Yahoo Japan 個股新聞格式已變更，保留上次資料。');
  const items = new Map<string, NewsItem>(); const warnings: string[] = [];
  for (const candidate of candidates) for (const article of candidate.newsTopics.articles) {
    const row = record(article), date = japanNewsDate(String(row.createTime ?? ''), now);
    if (!date || typeof row.headline !== 'string' || !/^\/news\/detail\/[a-f0-9]+$/.test(row.link ?? '')) { warnings.push('部分日文新聞缺少可辨識的日期或連結。'); continue; }
    const url = `https://finance.yahoo.co.jp${row.link}`, id = `yahoojp:${row.link.split('/').at(-1)}`;
    items.set(id, { id, title: row.headline.slice(0,700), url, publishedAt: date.iso, publishedDate: date.day,
      datePrecision: date.precision, source: row.mediaName || 'Yahoo Japan', kind: 'news', securityIds: [security.id],
      matchType: 'provider', language: 'ja', sourcePage: `https://finance.yahoo.co.jp/quote/${symbol}/news`, paid: row.isPaidArticle === true });
  }
  return { items: [...items.values()].slice(0,30), warnings: [...new Set(warnings)] };
}
export async function fetchInternationalNews(security: Security, now = new Date()): Promise<ProviderResult<NewsItem>> {
  if (security.market === 'TSE') return parseJapanNews(await officialText(`https://finance.yahoo.co.jp/quote/${yahooSymbol(security)}/news`), security, now);
  return { items: parseYahooNews(await yahooNewsSource(yahooSymbol(security)), security, now), warnings: [] };
}
