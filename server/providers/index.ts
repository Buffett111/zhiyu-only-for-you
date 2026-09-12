import type { Fundamentals, Market, MarketSnapshot, NewsItem, ProviderResult, Quote, Security } from '../../shared/types.js';
import { officialJson, officialText } from './http.js';
import { enrichSecurities, field, financialApplicability, parseAnnouncements, parseCnaRss, parseDate, parseFundamental, parseHistory, parseIsin, parseQuote, rows, stripHtml, symbolOf, text, type Row } from './parsers.js';

export const SOURCES = {
  TWSE: {
    quotes: 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
    companies: 'https://openapi.twse.com.tw/v1/opendata/t187ap03_L',
    isin: 'https://isin.twse.com.tw/isin/C_public.jsp?strMode=2',
    revenue: 'https://openapi.twse.com.tw/v1/opendata/t187ap05_L',
    earnings: 'https://openapi.twse.com.tw/v1/opendata/t187ap06_L_ci',
    announcements: 'https://openapi.twse.com.tw/v1/opendata/t187ap04_L',
  },
  TPEx: {
    quotes: 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes',
    companies: 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O',
    isin: 'https://isin.twse.com.tw/isin/C_public.jsp?strMode=4',
    revenue: 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O',
    earnings: 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap06_O_ci',
    announcements: 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O',
  },
  cna: ['https://feeds.feedburner.com/rsscna/finance', 'https://feeds.feedburner.com/rsscna/technology'],
  calendar: 'https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule',
} as const;

const errorMessage = (reason: unknown): string => reason instanceof Error ? reason.message : '未知資料來源錯誤';
const unique = <T extends { id: string }>(items: T[]): T[] => [...new Map(items.map(item => [item.id, item])).values()];
const maxDate = (dates: string[]): string | undefined => dates.filter(Boolean).sort().at(-1);

export async function fetchMarketSnapshot(market: Market): Promise<MarketSnapshot> {
  const source = SOURCES[market];
  if (!source) throw new Error('不支援的交易所');
  const responses = await Promise.allSettled([
    officialJson(source.quotes).then(rows),
    officialText(source.isin, 'big5').then(html => parseIsin(html, market, source.isin)),
    officialJson(source.companies).then(rows),
  ] as const);
  const [quoteResult, isinResult, companyResult] = responses;
  if (quoteResult.status === 'rejected') throw new Error(`${market} 收盤行情失敗：${errorMessage(quoteResult.reason)}`);
  if (isinResult.status === 'rejected') throw new Error(`${market} 商品分類失敗：${errorMessage(isinResult.reason)}`);
  const warnings: string[] = [];
  if (companyResult.status === 'rejected') warnings.push(`${source.companies}：${errorMessage(companyResult.reason)}`);
  const securities = enrichSecurities(isinResult.value, companyResult.status === 'fulfilled' ? companyResult.value : []);
  const lookup = new Map(securities.map(security => [security.symbol, security]));
  const fetchedAt = new Date().toISOString();
  const quotes: Quote[] = [];
  let invalidDates = 0;
  for (const row of quoteResult.value) {
    const security = lookup.get(symbolOf(row));
    if (!security) continue; // warrants, ETNs and preferred shares are outside v1.
    const quote = parseQuote(row, security, source.quotes, fetchedAt);
    if (quote) quotes.push({ ...quote, dataset: 'snapshot' } as Quote & { dataset: 'snapshot' }); else invalidDates++;
  }
  const dataDate = maxDate(quotes.map(quote => quote.date));
  if (!dataDate) throw new Error(`${market} 行情沒有可驗證的交易日期，未寫入任何推定日期`);
  if (invalidDates) warnings.push(`${market} 有 ${invalidDates} 筆行情缺少有效交易日期，已略過`);
  if (new Set(quotes.map(quote => quote.date)).size > 1) warnings.push(`${market} 來源含多個交易日期，保留每筆實際日期`);
  return { securities, quotes, dataDate, warnings };
}

/** Fetch bulk statements once per represented market; expose only requested securities. */
export async function fetchFundamentals(securities: Security[]): Promise<ProviderResult<Fundamentals>> {
  const output: Fundamentals[] = [];
  const warnings: string[] = [];
  for (const market of ['TWSE', 'TPEx'] as const) {
    const selected = unique(securities).filter(security => security.market === market);
    if (!selected.length) continue;
    const source = SOURCES[market];
    let revenue: Row[] = [], earnings: Row[] = [];
    if (selected.some(security => financialApplicability(security) === 'missing')) {
      const responses = await Promise.allSettled([officialJson(source.revenue).then(rows), officialJson(source.earnings).then(rows)]);
      if (responses[0].status === 'fulfilled') revenue = responses[0].value;
      else warnings.push(`${source.revenue}：${errorMessage(responses[0].reason)}`);
      if (responses[1].status === 'fulfilled') earnings = responses[1].value;
      else warnings.push(`${source.earnings}：${errorMessage(responses[1].reason)}`);
    }
    const revenueLookup = new Map(revenue.map(row => [symbolOf(row), row]));
    const earningsLookup = new Map(earnings.map(row => [symbolOf(row), row]));
    for (const security of selected) {
      const revenueRow = revenueLookup.get(security.symbol), earningsRow = earningsLookup.get(security.symbol);
      const item: Fundamentals & { sourceUrls: string[]; fetchedAt: string } = {
        ...parseFundamental(security, revenueRow, earningsRow, financialApplicability(security) !== 'missing' ? security.sourceUrl : earningsRow ? source.earnings : source.revenue),
        sourceUrls: [...(revenueRow ? [source.revenue] : []), ...(earningsRow ? [source.earnings] : [])], fetchedAt: new Date().toISOString(),
      };
      if (financialApplicability(security) === 'missing') {
        if (!revenueRow) warnings.push(`${security.symbol} 官方月營收來源尚無資料`);
        if (!earningsRow) warnings.push(`${security.symbol} 官方一般業損益表尚無資料，特殊行業財報不推算`);
      }
      output.push(item);
    }
  }
  return { items: output, dataDate: maxDate(output.map(item => item.asOf)), warnings };
}

export function historyUrl(security: Security, month: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !parseDate(`${month}-01`) || !/^[A-Z0-9]{4,8}$/.test(security.symbol)) throw new Error('無效的股票代號或歷史月份');
  if (security.market === 'TWSE') {
    const url = new URL('https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY');
    url.search = new URLSearchParams({ date: `${month.replace('-', '')}01`, stockNo: security.symbol, response: 'json' }).toString();
    return url.href;
  }
  if (security.market !== 'TPEx') throw new Error('不支援的交易所');
  const url = new URL('https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock');
  url.search = new URLSearchParams({ code: security.symbol, date: `${month.replace('-', '/')}/01`, response: 'json' }).toString();
  return url.href;
}

export async function fetchHistory(security: Security, month: string): Promise<ProviderResult<Quote>> {
  const url = historyUrl(security, month);
  try {
    const payload = await officialJson(url);
    if (payload && typeof payload === 'object' && /查無資料|沒有符合條件的資料|無符合資料|no data/i.test(text((payload as Row).stat))) {
      return { items: [], warnings: [`${security.symbol} ${month} 官方回覆查無資料，可能尚未掛牌；保留此資料缺口`] };
    }
    const items = parseHistory(payload, security, month, url, new Date().toISOString());
    return { items, dataDate: maxDate(items.map(quote => quote.date)), warnings: items.length ? [] : [`${security.symbol} ${month} 官方歷史行情沒有資料，可能尚未掛牌或未成交；保留此資料缺口`] };
  } catch (error) { throw new Error(`${url}：${errorMessage(error)}`); }
}

export async function fetchAnnouncements(securities: Security[]): Promise<ProviderResult<NewsItem>> {
  const items: NewsItem[] = [], warnings: string[] = [];
  for (const market of ['TWSE', 'TPEx'] as const) {
    if (!securities.some(security => security.market === market)) continue;
    const url = SOURCES[market].announcements;
    try {
      const raw = rows(await officialJson(url));
      const parsed = parseAnnouncements(raw, securities, market, url);
      const relevantSymbols = new Set(securities.filter(security => security.market === market).map(security => security.symbol));
      const relevant = raw.filter(row => relevantSymbols.has(symbolOf(row))).length;
      if (relevant > parsed.length) warnings.push(`${market} 有 ${relevant - parsed.length} 筆公告缺少有效發言日期、時間或標題，已略過`);
      items.push(...parsed);
    } catch (error) { warnings.push(`${url}：${errorMessage(error)}`); }
  }
  return { items: unique(items), dataDate: maxDate(items.map(item => item.publishedAt.slice(0, 10))), warnings };
}

/** Titles, publisher timestamps and original links only; article bodies/images are never fetched. */
export async function fetchNews(securities: Security[]): Promise<ProviderResult<NewsItem>> {
  const items: NewsItem[] = [], warnings: string[] = [];
  const responses = await Promise.allSettled(SOURCES.cna.map(async url => parseCnaRss(await officialText(url), securities)));
  responses.forEach((response, index) => {
    if (response.status === 'fulfilled') {
      items.push(...response.value);
      if (!response.value.length) warnings.push(`${SOURCES.cna[index]} 沒有可驗證日期及原文連結的標題`);
      else {
        const newest = Math.max(...response.value.map(item => Date.parse(item.publishedAt)));
        if (Date.now() - newest > 72 * 60 * 60 * 1000) warnings.push(`${SOURCES.cna[index]} 最新發稿已超過 72 小時，RSS 可能尚未更新`);
      }
    } else warnings.push(`${SOURCES.cna[index]}：${errorMessage(response.reason)}`);
  });
  const announcements = await fetchAnnouncements(securities);
  items.push(...announcements.items); warnings.push(...announcements.warnings);
  return { items: unique(items).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)), dataDate: maxDate(items.map(item => item.publishedAt.slice(0, 10))), warnings };
}

export interface TradingCalendarDay { date: string; name: string; closed: boolean }
export function parseTradingCalendar(input: Row[], year: number): ProviderResult<TradingCalendarDay> {
  const items: TradingCalendarDay[] = [], warnings: string[] = [];
  for (const row of input) {
    const date = parseDate(field(row, 'Date', '日期'));
    if (!date?.startsWith(`${year}-`)) continue;
    const name = text(field(row, 'Name', '名稱'));
    const description = stripHtml(text(field(row, 'Description', '說明')));
    if (/開始交易|最後交易/.test(`${name} ${description}`)) items.push({ date, name, closed: false });
    else if (/放假|補假|無交易|休市/.test(`${name} ${description}`)) items.push({ date, name, closed: true });
    else warnings.push(`${date} ${name}：交易日曆無法辨識是否休市`);
  }
  if (!items.length) warnings.push(`官方日曆未提供 ${year} 年資料，無法確認休市日`);
  return { items, warnings };
}
/** Official feed is current-year only; never invent a requested year's calendar. */
export async function fetchTradingCalendar(year: number): Promise<ProviderResult<TradingCalendarDay>> {
  if (!Number.isInteger(year) || year < 1912 || year > 9999) throw new Error('無效年份');
  try { return parseTradingCalendar(rows(await officialJson(SOURCES.calendar)), year); }
  catch (error) { return { items: [], warnings: [`${SOURCES.calendar}：${errorMessage(error)}`] }; }
}
