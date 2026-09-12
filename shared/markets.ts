import type { Market, Region } from './types';

export const marketNames: Record<Market, string> = { TWSE: '上市', TPEx: '上櫃', NASDAQ: 'NASDAQ', NYSE: 'NYSE', NYSEARCA: 'NYSE Arca', NYSEAMERICAN: 'NYSE American', CBOE: 'Cboe', TSE: '東京' };
export const regionNames: Record<Region, string> = { TW: '台股', US: '美股', JP: '日股' };
export const regionOf = (market: Market): Region => market === 'TWSE' || market === 'TPEx' ? 'TW' : market === 'TSE' ? 'JP' : 'US';
export const timeZoneOf = (market: Market): string => ({ TW: 'Asia/Taipei', US: 'America/New_York', JP: 'Asia/Tokyo' })[regionOf(market)];
export const priceBasis = (market: Market): string => regionOf(market) === 'TW' ? '未還原價格' : '拆股調整價格';
export const exchangeDate = (now: Date, timeZone: string): string => new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

/** Weekday expectation only; a missing quote never establishes an exchange holiday. */
export function internationalSessionDate(market: Market, now: Date): string {
  const timeZone = timeZoneOf(market);
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const minutes = Number(parts.find(p => p.type === 'hour')!.value) * 60 + Number(parts.find(p => p.type === 'minute')!.value);
  let date = exchangeDate(now, timeZone);
  const cutoff = regionOf(market) === 'JP' ? 16 * 60 + 30 : 17 * 60 + 30;
  const previous = () => { date = new Date(Date.parse(`${date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10); };
  if (minutes < cutoff) previous();
  while ([0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay())) previous();
  return date;
}
