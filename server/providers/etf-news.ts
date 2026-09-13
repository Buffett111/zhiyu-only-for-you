import { XMLParser } from 'fast-xml-parser';
import type { EtfHoldings, NewsItem, NewsRelation, ProviderResult, Security } from '../../shared/types';
import { officialText } from './http';
import { matchSecurities, newsId, parseDate, stripHtml } from './parsers';
import { parseStaticState } from './static-state';

export const holdingSymbols = ['0050', '0056', '006208'];
export function supportsEtfHoldings(s: Security) { return s.market === 'TWSE' && s.assetType === 'etf' && holdingSymbols.includes(s.symbol); }
export function parseYuantaHoldings(html: string, security: Security): EtfHoldings {
  const state = parseStaticState(html), fund = state.data?.[0]?.fundData, data = state.data?.[1]?.weightData;
  if (fund?.STK_CD !== security.symbol || data?.PCF?.fundid !== fund.FUND_ID) throw new Error('持股頁與請求基金不符');
  const asOf = parseDate(data.PCF.trandate);
  const holdings = data.FundWeights?.StockWeights?.map((row: any) => ({ symbol: String(row.code), name: String(row.name), weight: Number(row.weights) }));
  validateHoldings(holdings, asOf);
  return { securityId: security.id, asOf: asOf!, sourceUrl: `https://www.yuantaetfs.com/product/detail/${security.symbol}/ratio`, holdings,
    aliases: [fund.FUND_NAME, fund.FUND_SH_NAME, fund.STK_NAME].filter((x: unknown): x is string => typeof x === 'string' && x.length > 1) };
}
function validateHoldings(holdings: EtfHoldings['holdings'], date: string | null) {
  if (!date || !Array.isArray(holdings) || holdings.length < 10 || holdings.length > 500 ||
    holdings.some(h => !/^\d{4}$/.test(h.symbol) || !h.name || !Number.isFinite(h.weight) || h.weight < 0 || h.weight > 100) || new Set(holdings.map(h => h.symbol)).size !== holdings.length) throw new Error('官方持股日期或成分格式不符，保留上次資料');
}
export function parseFubonHoldings(html: string, security: Security): EtfHoldings {
  if (security.symbol !== '006208' || !/006208\s*富邦台50/.test(stripHtml(html))) throw new Error('富邦持股標的不符');
  const asOf = parseDate(stripHtml(html).match(/資料日期[：:]\s*(\d{4}\/\d{2}\/\d{2})/)?.[1]);
  const holdings = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].flatMap(match => {
    const cells = [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(cell => stripHtml(cell[1]).trim());
    return cells.length === 5 && /^\d{4}$/.test(cells[0]) ? [{ symbol: cells[0], name: cells[1], weight: Number(cells[4].replace(/[,％%]/g, '')) }] : [];
  });
  validateHoldings(holdings, asOf);
  return { securityId: security.id, asOf: asOf!, sourceUrl: 'https://websys.fsit.com.tw/FubonETF/Trade/Assets.aspx?stkId=006208', holdings, aliases: ['富邦台50', '富邦台灣采吉50基金'] };
}
export async function fetchEtfHoldings(security: Security): Promise<EtfHoldings> {
  if (!supportsEtfHoldings(security)) throw new Error('此 ETF 的官方持股來源尚未接入');
  return security.symbol === '006208' ? parseFubonHoldings(await officialText('https://websys.fsit.com.tw/FubonETF/Trade/Assets.aspx?stkId=006208'), security) :
    parseYuantaHoldings(await officialText(`https://www.yuantaetfs.com/product/detail/${security.symbol}/ratio`), security);
}
export function parseYuantaAnnouncements(html: string, securities: Security[], now = new Date()): NewsItem[] {
  const state = parseStaticState(html), groups = state.data?.find((x: any) => x.newsList)?.newsList;
  if (!Array.isArray(groups)) throw new Error('元大公告清單格式不符');
  return groups.flatMap((group: any) => (group.Announcement ?? []).flatMap((row: any) => {
    const title = typeof row.AnnouncementTitle === 'string' ? stripHtml(row.AnnouncementTitle) : '';
    const date = parseDate(row.AnnouncementDisplayDate), ids = matchSecurities(title, securities);
    if (!date || !ids.length || !/^[a-f\d-]{36}$/i.test(row.AnnouncementId)) return [];
    const time = Date.parse(`${date}T00:00:00+08:00`);
    if (time > now.getTime() || time < now.getTime() - 90 * 86400000) return [];
    const url = `https://www.yuantaetfs.com/news/announcement/${row.AnnouncementId}`;
    return [{ id: newsId([url]), title, url, publishedAt: new Date(time).toISOString(), publishedDate: date, datePrecision: 'day' as const, source: '元大投信', kind: 'announcement' as const, securityIds: ids, matchType: 'exact' as const }];
  }));
}
export async function fetchEtfAnnouncements(securities: Security[]): Promise<ProviderResult<NewsItem>> {
  const selected = securities.filter(s => s.market === 'TWSE' && ['0050', '0056'].includes(s.symbol));
  if (!selected.length) return { items: [], warnings: [] };
  return { items: parseYuantaAnnouncements(await officialText('https://www.yuantaetfs.com/news/announcement'), selected), warnings: [] };
}

export function parseGoogleNews(xml: string, securities: Security[], now = new Date()): NewsItem[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('RSS 不接受自訂實體');
  const channel = new XMLParser({ ignoreAttributes: false, parseTagValue: false }).parse(xml).rss?.channel;
  if (!channel) throw new Error('Google News RSS 格式錯誤');
  const input = channel.item ? Array.isArray(channel.item) ? channel.item : [channel.item] : [];
  return input.slice(0, 100).flatMap((row: any) => {
    const source = typeof row.source === 'object' ? row.source['#text'] : row.source;
    const title = stripHtml(String(row.title ?? ''));
    // Google also indexes discussion boards; those are not publisher news reports.
    if (/股市爆料同學會|\b(?:Dcard|PTT|Reddit)\b/i.test(title)) return [];
    const time = Date.parse(row.pubDate), url = String(row.link ?? '');
    let parsed: URL; try { parsed = new URL(url); } catch { return []; }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'news.google.com' || !/^\/rss\/articles\//.test(parsed.pathname) || parsed.username || parsed.password || parsed.port || !title || !Number.isFinite(time) || time > now.getTime() + 300000 || time < now.getTime() - 90 * 86400000) return [];
    const securityIds = matchSecurities(title, securities);
    return [{ id: newsId([url]), title, url, publishedAt: new Date(time).toISOString(), source: `${source || '出版者未提供'}（Google News）`, kind: 'news' as const, securityIds, matchType: securityIds.length ? 'exact' as const : 'market' as const }];
  });
}
export async function fetchRelatedNews(securities: Security[], tracked: Security[]): Promise<ProviderResult<NewsItem>> {
  const etfs = tracked.filter(s => s.assetType === 'etf');
  if (!etfs.length) return { items: [], warnings: [] };
  const queries = etfs.map(s => `"${s.symbol}" OR "${s.name}" when:30d`);
  const names = [...new Set(securities.filter(s => s.assetType === 'stock').map(s => s.name))];
  for (let i = 0; i < names.length; i += 12) queries.push(`(${names.slice(i, i + 12).map(n => `"${n}"`).join(' OR ')}) when:7d`);
  if (etfs.some(s => ['0050', '0056', '006208'].includes(s.symbol))) queries.push('台股 OR 加權指數 OR 台灣50 when:7d');
  if (etfs.some(s => s.symbol === '00924')) queries.push('美股 OR 標普500 OR S&P500 when:7d');
  const items: NewsItem[] = [], warnings: string[] = [];
  for (const q of queries) {
    const url = new URL('https://news.google.com/rss/search');
    url.search = new URLSearchParams({ q, hl: 'zh-TW', gl: 'TW', ceid: 'TW:zh-Hant' }).toString();
    try { items.push(...parseGoogleNews(await officialText(url.href), securities)); }
    catch (error) { warnings.push(error instanceof Error ? error.message : 'Google News 暫時無法取得'); break; }
  }
  return { items: [...new Map(items.map(item => [item.id, item])).values()], warnings };
}

export function relateEtfNews(item: NewsItem, tracked: Security[], snapshots: EtfHoldings[], catalog: Security[]): NewsItem {
  const direct = new Set(item.securityIds), relations: NewsRelation[] = [];
  for (const etf of tracked.filter(s => s.assetType === 'etf')) {
    if (direct.has(etf.id)) { relations.push({ securityId: etf.id, kind: 'direct' }); continue; }
    const holdings = snapshots.find(s => s.securityId === etf.id);
    const members = holdings?.holdings.flatMap(h => catalog.filter(s => s.symbol === h.symbol && s.assetType === 'stock' && direct.has(s.id)).map(s => ({ id: s.id, name: s.name }))) ?? [];
    if (members.length) relations.push({ securityId: etf.id, kind: 'constituent', via: members, holdingsDate: holdings!.asOf, holdingsSource: holdings!.sourceUrl });
    else if (item.kind === 'news' && (['0050', '0056', '006208'].includes(etf.symbol) && /台股|臺股|加權指數|台灣50|臺灣50/.test(item.title) || etf.symbol === '00924' && /美股|標普\s*500|S&P\s*500/i.test(item.title))) relations.push({ securityId: etf.id, kind: 'market' });
  }
  return { ...item, securityIds: [...new Set([...direct, ...relations.map(r => r.securityId)])], relations };
}

export function mergeNews(old: NewsItem | undefined, item: NewsItem): NewsItem {
  return { ...item, securityIds: [...new Set([...(old?.securityIds ?? []), ...item.securityIds])],
    relations: [...new Map([...(old?.relations ?? []), ...(item.relations ?? [])].map(r => [r.securityId, r])).values()] };
}
