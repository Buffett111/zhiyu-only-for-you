import { describe, expect, it, vi, afterEach } from 'vitest';
import type { Security } from '../shared/types.js';
import { assertOfficialUrl, officialText, retryAfterMilliseconds } from '../server/providers/http.js';
import { historyUrl, parseTradingCalendar } from '../server/providers/index.js';
import { enrichSecurities, matchSecurities, numeric, parseAnnouncements, parseCnaRss, parseDate, parseFundamental, parseHistory, parseIsin, parseMonth, parseQuote } from '../server/providers/parsers.js';

const stock: Security = { id: 'TWSE:2330', symbol: '2330', name: '台積電', market: 'TWSE', assetType: 'stock', currency: 'TWD', aliases: ['台積電', '台灣積體電路製造股份有限公司'], sourceUrl: 'https://isin.twse.com.tw/isin/C_public.jsp?strMode=2' };
const etf: Security = { ...stock, id: 'TPEx:00679B', symbol: '00679B', name: '元大美債20年', market: 'TPEx', assetType: 'etf', aliases: ['元大美債20年'] };
const fetched = '2026-09-12T00:00:00.000Z';

describe('official source numeric/date contracts', () => {
  it('preserves zero and normalizes commas and signed changes without inventing placeholders', () => {
    expect(numeric('0')).toBe(0); expect(numeric('1,234.50')).toBe(1234.5);
    expect(numeric('－0.20')).toBe(-0.2); expect(numeric('(15.1)')).toBe(-15.1);
    for (const value of ['', '--', 'N/A', '除權息', 'X0.1', undefined, Infinity]) expect(numeric(value)).toBeNull();
  });
  it('converts ROC dates and validates actual Gregorian calendar dates', () => {
    expect(parseDate('1150911')).toBe('2026-09-11'); expect(parseDate('115/9/1')).toBe('2026-09-01');
    expect(parseDate('20260803')).toBe('2026-08-03'); expect(parseMonth('11508')).toBe('2026-08');
    for (const value of ['1150230', '2026/13/01', '今天', '', undefined]) expect(parseDate(value)).toBeNull();
  });
  it('never substitutes fetchedAt for a missing trading date', () => {
    expect(parseQuote({ ClosingPrice: '100' }, stock, 'source', fetched)).toBeNull();
  });
  it('derives change percent from previous close and respects a zero volume', () => {
    const quote = parseQuote({ Date: '1150911', ClosingPrice: '110', Change: '10', TradeVolume: '0' }, stock, 'source', fetched)!;
    expect(quote.changePercent).toBe(10); expect(quote.status).toBe('no_trade'); expect(quote.volume).toBe(0);
    expect(parseQuote({ Date: '1150911', Close: '10', Change: '10' }, stock, 'source', fetched)!.changePercent).toBeNull();
  });
});

describe('authoritative security classification', () => {
  it('uses the ISIN category, preserving a leading-zero ETF and excluding warrants/ETN', () => {
    const row = (symbol: string, name: string) => `<tr><td>${symbol}　${name}</td><td>TW00</td><td>2020/01/01</td><td>上櫃</td><td></td><td>CFICODE</td></tr>`;
    const html = `<table><tr><td colspan=7>股票</td></tr>${row('6488', '環球晶')}<tr><td colspan=7>ETF</td></tr>${row('00679B', '元大美債20年')}<tr><td colspan=7>ETN</td></tr>${row('020099', '某ETN')}<tr><td colspan=7>上櫃認購(售)權證</td></tr>${row('700001', '權證')}</table><font color='red'><center>掛牌日以正式公告為準</center></font>`;
    const result = parseIsin(html, 'TPEx', 'source');
    expect(result.map(item => [item.symbol, item.assetType])).toEqual([['6488', 'stock'], ['00679B', 'etf']]);
    expect(result[0].listedAt).toBe('2020-01-01');
    expect(() => parseIsin('<html>Access denied</html>', 'TPEx', 'source')).toThrow();
    expect(() => parseIsin(html.replace('掛牌日以正式公告為準', ''), 'TPEx', 'source')).toThrow();
  });
  it('derives only verified business-name aliases from issuer master data', () => {
    const security = { ...stock, symbol: '2603', name: '長榮', aliases: ['長榮'] };
    const [enriched] = enrichSecurities([security], [{ 公司代號: '2603', 公司名稱: '長榮海運股份有限公司', 公司簡稱: '長榮' }]);
    expect(enriched.aliases).toContain('長榮海運'); expect(enriched.aliases).not.toContain('長榮航空');
  });
  it('recognizes the explicitly labeled Taiwan Innovation Board as TWSE stock', () => {
    const row = (symbol: string, name: string, market: string) => `<tr><td>${symbol}　${name}</td><td>TW00</td><td>2020/01/01</td><td>${market}</td><td>汽車工業</td><td>CFICODE</td></tr>`;
    const html = `<table><tr><td colspan=7>創新板</td></tr>${row('2258', '鴻華先進-創', '上市臺灣創新板')}<tr><td colspan=7>ETF</td></tr>${row('0050', '元大台灣50', '上市')}</table>掛牌日以正式公告為準`;
    expect(parseIsin(html, 'TWSE', 'source').map(item => [item.id, item.assetType])).toEqual([['TWSE:2258', 'stock'], ['TWSE:0050', 'etf']]);
  });
});

describe('history contracts', () => {
  it('converts OTC lots to shares while TWSE shares remain unchanged', () => {
    const payload = { stat: 'ok', tables: [{ fields: ['日 期', '成交張數', '成交仟元', '開盤', '最高', '最低', '收盤', '漲跌'], data: [['115/08/03', '34,093', '899,267', '26.34', '26.43', '26.31', '26.42', '-0.26']] }] };
    expect(parseHistory(payload, etf, '2026-08', 'official', fetched)[0]).toMatchObject({ volume: 34_093_000, volumePrecision: 'thousand_shares', dataset: 'history' });
    const twse = { stat: 'OK', fields: ['日期', '成交股數', '收盤價'], data: [['115/08/03', '1234', '100']] };
    expect(parseHistory(twse, stock, '2026-08', 'official', fetched)[0].volume).toBe(1234);
  });
  it('rejects rows outside requested month and non-OK upstream status', () => {
    expect(() => parseHistory({ stat: 'OK', fields: ['日期'], data: [['115/07/31']] }, stock, '2026-08', 'official', fetched)).toThrow();
    expect(() => parseHistory({ stat: '查無資料' }, stock, '2026-08', 'official', fetched)).toThrow();
  });
  it('preserves symbols in a fixed official historical route and rejects query injection', () => {
    expect(historyUrl(etf, '2026-08')).toContain('code=00679B');
    expect(() => historyUrl({ ...stock, symbol: '2330&url=evil' }, '2026-08')).toThrow();
    expect(() => historyUrl(stock, '2026-13')).toThrow();
  });
});

describe('fundamental applicability and period', () => {
  it('labels Q2 cumulative EPS and monthly revenue separately, preserving zero EPS', () => {
    const result = parseFundamental(stock, { 出表日期: '1150911', 資料年月: '11508', '營業收入-當月營收': '1,000', '營業收入-去年同月增減(%)': '0' }, { 年度: '115', 季別: '2', Date: '1150912', 營業收入: '200', '營業毛利（毛損）淨額': '80', '營業利益（損失）': '-20', '基本每股盈餘（元）': '0' }, 'source');
    expect(result.revenuePeriod).toBe('2026-08'); expect(result.earningsPeriod).toBe('2026 Q2（1–6月累計）');
    expect(result.basis).toBe('cumulative'); expect(result.eps).toBe(0); expect(result.grossMargin).toBe(40); expect(result.operatingMargin).toBe(-10);
    expect(result.revenue).toBe(1000); expect(result.asOf).toBe('2026-09-12');
  });
  it('never assigns corporate financial ratios to ETF/financial stocks', () => {
    expect(parseFundamental(etf, {}, {}, 'source').availability).toBe('not_applicable');
    expect(parseFundamental({ ...stock, sector: '金融保險業' }, {}, {}, 'source').availability).toBe('unsupported');
    const missing = parseFundamental(stock, undefined, undefined, 'source');
    expect(missing.availability).toBe('missing'); expect(missing.asOf).toBe(''); expect(missing.eps).toBeNull();
  });
  it('does not divide by zero revenue', () => {
    expect(parseFundamental(stock, undefined, { 年度: '115', 季別: '4', 營業收入: '0', '營業毛利（毛損）': '10' }, 'source').grossMargin).toBeNull();
  });
});

describe('headlines and announcement attribution', () => {
  it('avoids ambiguous group aliases and airline/aerospace prefix collisions', () => {
    const ship = { ...stock, id: 'TWSE:2603', name: '長榮', aliases: ['長榮', '長榮海運'] };
    const air = { ...stock, id: 'TWSE:2618', name: '長榮航', aliases: ['長榮航', '長榮航空'] };
    expect(matchSecurities('長榮集團展望', [ship, air])).toEqual([]);
    expect(matchSecurities('長榮航空營運動能', [ship, air])).toEqual(['TWSE:2618']);
    expect(matchSecurities('長榮航太接單', [air])).toEqual([]);
    expect(matchSecurities('台積電營收創高', [stock])).toEqual([stock.id]);
  });
  it('stores CNA title/link/date only and excludes unsafe article links', () => {
    const rss = `<rss><channel><item><title>台積電營收</title><link>https://www.cna.com.tw/news/afe/202609120020.aspx</link><pubDate>Sat, 12 Sep 2026 08:30:01 +0800</pubDate><description>Do not retain article content</description></item><item><title>惡意</title><link>javascript:alert(1)</link><pubDate>Sat, 12 Sep 2026 08:30:01 +0800</pubDate></item></channel></rss>`;
    const result = parseCnaRss(rss, [stock]);
    expect(result).toHaveLength(1); expect(result[0].publishedAt).toBe('2026-09-12T00:30:01.000Z');
    expect(JSON.stringify(result)).not.toContain('Do not retain'); expect(result[0].securityIds).toEqual([stock.id]);
    expect(() => parseCnaRss('<!DOCTYPE rss [<!ENTITY x "test">]><rss/>', [])).toThrow();
  });
  it('matches announcements by exact exchange+code and normalizes 5-digit time', () => {
    const parsed = parseAnnouncements([{ 公司代號: '2330', 發言日期: '1150911', 發言時間: '70004', '主旨 ': '財報公告' }], [stock], 'TWSE', 'source');
    expect(parsed[0].publishedAt).toBe('2026-09-10T23:00:04.000Z'); expect(parsed[0].kind).toBe('announcement');
    expect(parseAnnouncements([{ 公司代號: '2330', 發言日期: '1150911', 發言時間: '70004', 主旨: '公告' }], [stock], 'TPEx', 'source')).toEqual([]);
  });
});

describe('calendar and outbound protections', () => {
  it('distinguishes last-trading/start-trading dates from closed days', () => {
    const result = parseTradingCalendar([{ Date: '1150211', Name: '農曆春節前最後交易日', Description: '最後交易' }, { Date: '1150212', Name: '市場無交易，僅辦理結算交割作業' }, { Date: '1150925', Name: '中秋節', Description: '依規定放假1日。' }], 2026);
    expect(result.items.map(day => day.closed)).toEqual([false, true, true]);
    expect(parseTradingCalendar([{ Date: '1150925', Name: '中秋節', Description: '放假' }], 2025).warnings).not.toEqual([]);
  });
  it('rejects arbitrary hosts, internal addresses, non-HTTPS and alternate official routes', () => {
    expect(assertOfficialUrl('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL').hostname).toBe('openapi.twse.com.tw');
    for (const url of ['http://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', 'https://127.0.0.1/', 'https://evil.com/', 'https://www.twse.com.tw/other', 'https://user:password@openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL']) expect(() => assertOfficialUrl(url)).toThrow();
  });
  it('interprets both Retry-After formats without an immediate retry', () => {
    expect(retryAfterMilliseconds('120')).toBe(120_000);
    expect(retryAfterMilliseconds('Sat, 12 Sep 2026 01:00:00 GMT', Date.parse('2026-09-12T00:00:00Z'))).toBe(3_600_000);
  });
  it('stops a host after 403 without retrying through an alternate route', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(new Response('forbidden', { status: 403 }));
    vi.stubGlobal('fetch', fakeFetch);
    await expect(officialText('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL')).rejects.toThrow('403');
    await expect(officialText('https://openapi.twse.com.tw/v1/opendata/t187ap03_L')).rejects.toThrow('暫停');
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });
  it('explains certificate-chain failures without disabling verification', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed', { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } })));
    await expect(officialText('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes')).rejects.toThrow('--use-system-ca');
  });
  it('retries an interrupted idempotent GET once after the host pacing interval', async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fakeFetch = vi.fn().mockRejectedValueOnce(new Error('terminated', { cause: { code: 'UND_ERR_SOCKET' } })).mockResolvedValue(new Response('recovered'));
    vi.stubGlobal('fetch', fakeFetch);
    const result = officialText('https://feeds.feedburner.com/rsscna/finance');
    await vi.advanceTimersByTimeAsync(0);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('recovered');
    expect(fakeFetch).toHaveBeenCalledTimes(2);
    warning.mockRestore();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });
});
