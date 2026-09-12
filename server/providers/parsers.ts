import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import type { Fundamentals, Market, NewsItem, Quote, Security } from '../../shared/types.js';

export type Row = Record<string, unknown>;
export function field(row: Row, ...names: string[]): unknown {
  for (const name of names) {
    const key = Object.keys(row).find(key => key.replace(/\s/g, '') === name.replace(/\s/g, ''));
    if (key !== undefined) return row[key];
  }
  return undefined;
}
export function text(value: unknown): string { return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''; }
export function numeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let source = text(value).replace(/<[^>]*>/g, '').replace(/[,\s%]/g, '').replace(/[−－]/g, '-').replace(/＋/g, '+');
  if (/^\([\d.]+\)$/.test(source)) source = `-${source.slice(1, -1)}`;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(source)) return null;
  const result = Number(source);
  return Number.isFinite(result) ? result : null;
}

/** Accepts Gregorian / ROC dates, but never normalizes invalid dates or guesses today. */
export function parseDate(value: unknown): string | null {
  const source = text(value).replace(/^民國/, '').replace(/[年月]/g, '/').replace(/日$/, '');
  let groups = source.match(/^(\d{2,4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!groups) groups = source.match(/^(\d{3,4})(\d{2})(\d{2})$/);
  if (!groups) return null;
  let year = Number(groups[1]);
  if (year < 1911) year += 1911;
  const month = Number(groups[2]), day = Number(groups[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1912 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
export function parseMonth(value: unknown): string | null {
  const raw = text(value);
  const match = raw.match(/^(\d{3,4})[-/]?(\d{2})$/);
  if (!match) return null;
  return parseDate(`${match[1]}/${match[2]}/01`)?.slice(0, 7) ?? null;
}
export function rows(payload: unknown): Row[] {
  if (!Array.isArray(payload) || !payload.every(row => row && typeof row === 'object' && !Array.isArray(row))) throw new Error('官方 API 的資料格式不符合預期');
  return payload as Row[];
}
export function symbolOf(row: Row): string { return text(field(row, '公司代號', 'Code', 'SecuritiesCompanyCode', '證券代號', '基金代號')); }
export function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, '').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

/** ISIN category headers are authoritative: code prefixes are not asset classifications. */
export function parseIsin(html: string, market: Market, sourceUrl: string): Security[] {
  // The official legacy JSP omits </html>; the table's terminal disclaimer is its actual completion marker.
  if (!/<\/table\s*>[\s\S]*掛牌日以正式公告為準/.test(html)) throw new Error(`${market} ISIN 文件不完整，拒絕更新商品目錄`);
  let category = '';
  const securities: Security[] = [];
  for (const match of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(cell => stripHtml(cell[1]));
    if (cells.length === 1 && /colspan\s*=/i.test(match[1])) { category = cells[0].trim(); continue; }
    if (!['股票', '創新板', 'ETF'].includes(category)) continue;
    if (cells.length < 6) throw new Error(`${market} ISIN 商品列格式不完整`);
    const first = cells[0].match(/^([A-Z0-9]{4,8})[\s　]+(.+)$/);
    const correctMarket = market === 'TWSE' ? cells[3] === '上市' || (category === '創新板' && cells[3] === '上市臺灣創新板') : cells[3] === '上櫃';
    if (!first || !correctMarket) throw new Error(`${market} ISIN 商品列無法辨識代號或市場`);
    const symbol = first[1], name = first[2].trim();
    securities.push({ id: `${market}:${symbol}`, symbol, name, market, assetType: category === 'ETF' ? 'etf' : 'stock', currency: 'TWD', sector: cells[4] || undefined, aliases: [name], sourceUrl, active: true });
  }
  if (!securities.some(item => item.assetType === 'stock') || !securities.some(item => item.assetType === 'etf')) throw new Error(`${market} ISIN 清單未完整提供股票與 ETF 分類`);
  if (new Set(securities.map(item => item.id)).size !== securities.length) throw new Error(`${market} ISIN 清單含重複代號`);
  return securities;
}

export function enrichSecurities(securities: Security[], companyRows: Row[]): Security[] {
  const companies = new Map(companyRows.map(row => [symbolOf(row), row]));
  return securities.map(security => {
    const row = companies.get(security.symbol);
    if (!row || security.assetType === 'etf') return security;
    const fullName = text(field(row, '公司名稱', 'CompanyName'));
    const businessName = fullName.replace(/股份有限公司$|有限公司$/, '');
    const abbreviation = text(field(row, '公司簡稱', 'CompanyAbbreviation'));
    const sector = text(field(row, '產業別', 'SecuritiesIndustryCode'));
    return { ...security, sector: security.sector || sector || undefined, aliases: [...new Set([security.name, fullName, businessName, abbreviation].filter(Boolean))] };
  });
}

export function parseQuote(row: Row, security: Security, source: string, fetchedAt: string): Quote | null {
  const date = parseDate(field(row, 'Date', '日期', '日 期'));
  if (!date) return null;
  const close = numeric(field(row, 'ClosingPrice', 'Close', '收盤價', '收盤'));
  const volumeInLots = field(row, '成交張數');
  const rawVolume = numeric(volumeInLots ?? field(row, 'TradeVolume', 'TradingShares', '成交股數'));
  const volume = rawVolume === null ? null : rawVolume * (volumeInLots !== undefined ? 1_000 : 1);
  const change = numeric(field(row, 'Change', '漲跌價差', '漲跌'));
  const previousClose = close !== null && change !== null ? close - change : null;
  const explicitStatus = text(field(row, '狀態', 'Status', '註記'));
  const quote: Quote & { volumePrecision: 'shares' | 'thousand_shares' } = {
    securityId: security.id, date, open: numeric(field(row, 'OpeningPrice', 'Open', '開盤價', '開盤')),
    high: numeric(field(row, 'HighestPrice', 'High', '最高價', '最高')), low: numeric(field(row, 'LowestPrice', 'Low', '最低價', '最低')),
    close, volume, change, changePercent: previousClose !== null && previousClose > 0 && change !== null ? (change / previousClose) * 100 : null,
    source, fetchedAt, priceType: 'eod', volumePrecision: volumeInLots !== undefined ? 'thousand_shares' : 'shares', status: /停止交易|停止買賣|暫停|suspend/i.test(explicitStatus) ? 'suspended' : volume === 0 || close === null ? 'no_trade' : 'traded',
  };
  return quote;
}

export function parseHistory(payload: unknown, security: Security, month: string, source: string, fetchedAt: string): Quote[] {
  if (!payload || typeof payload !== 'object') throw new Error('歷史行情格式錯誤');
  const body = payload as Row;
  if (text(body.stat).toLowerCase() !== 'ok') throw new Error(`歷史行情尚無資料：${text(body.stat).slice(0, 160) || '來源未回傳狀態'}`);
  const tables = Array.isArray(body.tables) ? body.tables as Row[] : [body];
  const table = tables.find(table => Array.isArray(table.fields) && (table.fields as unknown[]).some(value => /日\s*期/.test(text(value))));
  if (!table || !Array.isArray(table.fields) || !Array.isArray(table.data)) throw new Error('歷史行情缺少日期欄位');
  const fields = table.fields.map(text);
  const output = table.data.flatMap(raw => {
    if (!Array.isArray(raw)) return [];
    const row = Object.fromEntries(fields.map((name, index) => [name, raw[index]]));
    const quote = parseQuote(row, security, source, fetchedAt);
    if (!quote || !quote.date.startsWith(`${month}-`)) throw new Error('歷史行情日期不在請求月份內或無法辨識');
    return [{ ...quote, dataset: 'history' as const }];
  });
  return output.sort((a, b) => a.date.localeCompare(b.date));
}

export function financialApplicability(security: Security): Fundamentals['availability'] {
  if (security.assetType === 'etf') return 'not_applicable';
  if (/金融|金控|銀行|保險|證券|期貨/.test(security.sector ?? '') || ['17', '17A', '17B'].includes(security.sector ?? '')) return 'unsupported';
  return 'missing';
}

export function parseFundamental(security: Security, revenue: Row | undefined, earnings: Row | undefined, sourceUrl: string): Fundamentals {
  const applicability = financialApplicability(security);
  const output: Fundamentals = { securityId: security.id, asOf: '', revenuePeriod: null, earningsPeriod: null, basis: 'cumulative', revenue: null, revenueYoy: null, eps: null, grossMargin: null, operatingMargin: null, unit: '營收：新台幣千元；EPS：元／股；比率：%', sourceUrl, availability: applicability };
  if (applicability !== 'missing') return output;
  if (revenue) {
    output.revenuePeriod = parseMonth(field(revenue, '資料年月', 'YearMonth'));
    if (output.revenuePeriod) {
      output.revenue = numeric(field(revenue, '營業收入-當月營收'));
      output.revenueYoy = numeric(field(revenue, '營業收入-去年同月增減(%)'));
    }
    output.asOf = parseDate(field(revenue, '出表日期', 'Date')) ?? '';
  }
  if (earnings) {
    let year = numeric(field(earnings, '年度', 'Year'));
    const season = numeric(field(earnings, '季別', 'Season'));
    if (year !== null && year < 1911) year += 1911;
    if (year && season && Number.isInteger(season) && season >= 1 && season <= 4) {
      output.earningsPeriod = `${year} Q${season}（${season === 4 ? '全年' : `1–${season * 3}月累計`}）`;
      output.basis = season === 4 ? 'annual' : 'cumulative';
      output.eps = numeric(field(earnings, '基本每股盈餘（元）', '基本每股盈餘(元)'));
      const sales = numeric(field(earnings, '營業收入'));
      const gross = numeric(field(earnings, '營業毛利（毛損）淨額')) ?? numeric(field(earnings, '營業毛利（毛損）'));
      const operating = numeric(field(earnings, '營業利益（損失）'));
      output.grossMargin = sales !== null && sales > 0 && gross !== null ? gross / sales * 100 : null;
      output.operatingMargin = sales !== null && sales > 0 && operating !== null ? operating / sales * 100 : null;
    }
    const earningsDate = parseDate(field(earnings, '出表日期', 'Date')) ?? '';
    output.asOf = earningsDate > output.asOf ? earningsDate : output.asOf;
  }
  output.availability = [output.revenue, output.eps, output.grossMargin, output.operatingMargin].some(value => value !== null) ? 'available' : 'missing';
  return output;
}

// Common words / group names are deliberately not aliases. 長榮 does not establish either airline or shipping.
const AMBIGUOUS_NAMES = new Set(['長榮', '長榮航', '統一', '中華', '世界', '聯合', '大眾', '大同', '新光', '國泰', '富邦', '中信', '永豐', '台灣', '臺灣']);
export function matchSecurities(title: string, securities: Security[]): string[] {
  const normalized = title.normalize('NFKC');
  const ownership = new Map<string, Set<string>>();
  for (const security of securities) for (const alias of security.aliases) {
    const name = alias.normalize('NFKC').trim();
    if (name.length < 2 || AMBIGUOUS_NAMES.has(name)) continue;
    const owners = ownership.get(name) ?? new Set<string>(); owners.add(security.id); ownership.set(name, owners);
  }
  const ids = new Set<string>();
  for (const [name, owners] of ownership) {
    if (owners.size !== 1 || !normalized.includes(name)) continue;
    if (/^[a-z\d .&-]+$/i.test(name)) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!new RegExp(`(?:^|[^a-z\\d])${escaped}(?:$|[^a-z\\d])`, 'i').test(normalized)) continue;
    }
    ids.add([...owners][0]);
  }
  return [...ids];
}
export function newsId(parts: string[]): string { return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 32); }

export function parseCnaRss(xml: string, securities: Security[]): NewsItem[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('RSS 不接受自訂 XML 實體');
  const parsed = new XMLParser({ ignoreAttributes: false, parseTagValue: false, processEntities: true }).parse(xml);
  if (!parsed.rss?.channel) throw new Error('中央社 RSS 格式錯誤');
  const items = parsed.rss.channel.item ?? [];
  return (Array.isArray(items) ? items : [items]).flatMap((item: Row) => {
    const title = stripHtml(text(item.title));
    const url = text(item['feedburner:origLink']) || text(item.link);
    let parsedUrl: URL;
    try { parsedUrl = new URL(url); } catch { return []; }
    if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password || (parsedUrl.port && parsedUrl.port !== '443') || !['www.cna.com.tw', 'cna.com.tw'].includes(parsedUrl.hostname)) return [];
    const date = Date.parse(text(item.pubDate));
    if (!title || !Number.isFinite(date)) return [];
    const securityIds = matchSecurities(title, securities);
    return [{ id: newsId([url]), title, url, publishedAt: new Date(date).toISOString(), source: '中央通訊社', kind: 'news' as const, securityIds, matchType: securityIds.length ? 'exact' as const : 'market' as const }];
  });
}

export function parseAnnouncements(input: Row[], securities: Security[], market: Market, sourceUrl: string): NewsItem[] {
  const lookup = new Map(securities.filter(s => s.market === market).map(s => [s.symbol, s.id]));
  return input.flatMap(row => {
    const id = lookup.get(symbolOf(row));
    const date = parseDate(field(row, '發言日期'));
    const rawTime = text(field(row, '發言時間')).replace(/:/g, '').padStart(6, '0');
    const match = rawTime.match(/^(\d{2})(\d{2})(\d{2})$/);
    const title = text(field(row, '主旨')).replace(/\s+/g, ' ');
    if (!id || !date || !match || Number(match[1]) > 23 || Number(match[2]) > 59 || Number(match[3]) > 59 || !title) return [];
    const publishedAt = new Date(`${date}T${match[1]}:${match[2]}:${match[3]}+08:00`).toISOString();
    return [{ id: newsId([id, publishedAt, title]), title, url: sourceUrl, publishedAt, source: market === 'TWSE' ? '臺灣證券交易所／公開資訊觀測站' : '證券櫃檯買賣中心／公開資訊觀測站', kind: 'announcement' as const, securityIds: [id], matchType: 'exact' as const }];
  });
}
