/** Read-only live contract smoke test. Never uses private watchlists or writes to the database. */
import { fetchFundamentals, fetchHistory, fetchMarketSnapshot, fetchNews, fetchTradingCalendar } from '../server/providers/index.js';
import type { Security } from '../shared/types.js';

function previousTaipeiMonth(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  const year = Number(parts.find(part => part.type === 'year')!.value), month = Number(parts.find(part => part.type === 'month')!.value);
  const date = new Date(Date.UTC(year, month - 2, 1));
  return date.toISOString().slice(0, 7);
}
const arg = process.argv.find(value => value.startsWith('--month='));
const month = arg?.slice('--month='.length) ?? previousTaipeiMonth();
if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Use --month=YYYY-MM');
const samples = [
  { market: 'TWSE' as const, symbol: '2330', type: 'stock' },
  { market: 'TWSE' as const, symbol: '0050', type: 'etf' },
  { market: 'TPEx' as const, symbol: '6488', type: 'stock' },
  { market: 'TPEx' as const, symbol: '00679B', type: 'etf' },
];
const selected: Security[] = [];
const report: Record<string, unknown> = { verifiedAt: new Date().toISOString(), month, snapshots: [], history: [] };
let failed = false;
for (const market of ['TWSE', 'TPEx'] as const) {
  const snapshot = await fetchMarketSnapshot(market);
  const observed = samples.filter(sample => sample.market === market).map(sample => {
    const security = snapshot.securities.find(security => security.symbol === sample.symbol);
    if (!security || security.assetType !== sample.type) throw new Error(`${market}:${sample.symbol} authoritative classification mismatch`);
    selected.push(security);
    const quote = snapshot.quotes.find(quote => quote.securityId === security.id);
    if (!quote || quote.date !== snapshot.dataDate || quote.dataset !== 'snapshot') throw new Error(`${security.id} latest quote missing or date mismatch`);
    return { securityId: security.id, assetType: security.assetType, quoteDate: quote.date, volumePrecision: quote.volumePrecision, classificationSource: security.sourceUrl, quoteSource: quote.source };
  });
  (report.snapshots as unknown[]).push({ market, dataDate: snapshot.dataDate, securities: snapshot.securities.length, quotes: snapshot.quotes.length, observed, warnings: snapshot.warnings });
  failed ||= snapshot.warnings.length > 0;
}
for (const security of selected) {
  const history = await fetchHistory(security, month);
  if (!history.items.length) failed = true;
  if (history.items.some(quote => !quote.date.startsWith(month) || quote.dataset !== 'history' || (quote.volume !== null && quote.volume < 0))) throw new Error(`${security.id} history contract mismatch`);
  (report.history as unknown[]).push({ securityId: security.id, count: history.items.length, from: history.items.at(0)?.date, to: history.items.at(-1)?.date, volumePrecision: history.items.at(0)?.volumePrecision, source: history.items.at(0)?.source, warnings: history.warnings });
  failed ||= history.warnings.length > 0;
}
const fundamentals = await fetchFundamentals(selected);
report.fundamentals = { items: fundamentals.items.map(item => ({ securityId: item.securityId, availability: item.availability, revenuePeriod: item.revenuePeriod, earningsPeriod: item.earningsPeriod, basis: item.basis, asOf: item.asOf, sourceUrls: item.sourceUrls })), warnings: fundamentals.warnings };
failed ||= fundamentals.warnings.length > 0;
const news = await fetchNews(selected);
report.news = { count: news.items.filter(item => item.kind === 'news').length, announcementCount: news.items.filter(item => item.kind === 'announcement').length, exactMatches: news.items.filter(item => item.matchType === 'exact').length, newest: news.items[0]?.publishedAt, warnings: news.warnings };
failed ||= news.warnings.length > 0;
const year = Number(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Taipei', year: 'numeric' }).format(new Date()));
const calendar = await fetchTradingCalendar(year);
report.calendar = { year, closed: calendar.items.filter(item => item.closed).length, specialOpen: calendar.items.filter(item => !item.closed).length, warnings: calendar.warnings };
failed ||= calendar.warnings.length > 0;
report.ok = !failed;
console.log(JSON.stringify(report, null, 2));
if (failed) process.exitCode = 1;
