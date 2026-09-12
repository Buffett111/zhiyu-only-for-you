/** Only the official, reviewed feeds below can be contacted. Never accepts a user URL. */
const ALLOWED_PATHS: Record<string, RegExp> = {
  'finance.yahoo.co.jp': /^\/quote\/[A-Z0-9]{4}\.T\/news$/,
  'openapi.twse.com.tw': /^\/v1\/(?:exchangeReport\/STOCK_DAY_ALL|opendata\/t187ap(?:03_L|04_L|05_L|06_L_ci|47_L)|holidaySchedule\/holidaySchedule)$/,
  'www.tpex.org.tw': /^\/(?:openapi\/v1\/(?:tpex_mainboard_daily_close_quotes|mopsfin_t187ap(?:03_O|04_O|05_O|06_O_ci))|www\/zh-tw\/afterTrading\/tradingStock)$/,
  'www.twse.com.tw': /^\/rwd\/zh\/afterTrading\/STOCK_DAY$/,
  'isin.twse.com.tw': /^\/isin\/C_public\.jsp$/,
  'feeds.feedburner.com': /^\/rsscna\/(finance|technology)$/,
};
const queues = new Map<string, Promise<unknown>>();
const nextRequest = new Map<string, number>();
const blockedUntil = new Map<string, number>();
const MAX_BYTES = 20 * 1024 * 1024;

export function assertOfficialUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !ALLOWED_PATHS[url.hostname]?.test(url.pathname)) {
    throw new Error('資料來源不在核准的官方 HTTPS 清單中');
  }
  return url;
}

export function retryAfterMilliseconds(value: string | null, now = Date.now()): number {
  if (!value) return 60_000;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 60_000;
}

export async function officialText(value: string, encoding = 'utf-8'): Promise<string> {
  const url = assertOfficialUrl(value);
  const host = url.hostname;
  const previous = queues.get(host) ?? Promise.resolve();
  const request = previous.catch(() => {}).then(async () => {
    // Exactly one transport-only retry for this idempotent GET. HTTP denials and TLS failures never retry here.
    for (let attempt = 0; attempt < 2; attempt++) {
    if ((blockedUntil.get(host) ?? 0) > Date.now()) throw new Error(`${host} 要求暫停請求，稍後由排程重試`);
    const wait = Math.max(0, (nextRequest.get(host) ?? 0) - Date.now());
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json, application/rss+xml, text/html;q=0.8', 'user-agent': 'ZhiyuPersonalDashboard/0.1 (official open data; personal non-commercial use)' },
        signal: AbortSignal.timeout(20_000), redirect: 'error',
      });
      if (response.status === 403 || response.status === 429) {
        const pause = Math.max(response.status === 403 ? 3_600_000 : 60_000, retryAfterMilliseconds(response.headers.get('retry-after')));
        blockedUntil.set(host, Date.now() + pause);
        throw new Error(`${host} HTTP ${response.status}，已暫停此來源 ${Math.ceil(pause / 60_000)} 分鐘`);
      }
      if (!response.ok) throw new Error(`${host} HTTP ${response.status}`);
      if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error(`${host} 回應超過容量上限`);
      const chunks: Uint8Array[] = [];
      const reader = response.body?.getReader();
      if (!reader) throw new Error(`${host} 回應沒有內容`);
      let length = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > MAX_BYTES) { await reader.cancel(); throw new Error(`${host} 回應超過容量上限`); }
        chunks.push(chunk.value);
      }
      return new TextDecoder(encoding).decode(Buffer.concat(chunks));
    } catch (error) {
      const cause = error instanceof Error ? (error as Error & { cause?: { code?: string } }).cause?.code : undefined;
      const transient = ['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE'].includes(cause ?? '') || (error instanceof Error && error.message === 'terminated');
      if (transient && attempt === 0) {
        console.warn(JSON.stringify({ event: 'provider_transport_retry', host, code: cause ?? 'terminated', attempt: 1, waitMilliseconds: 3_000 }));
        continue;
      }
      if (cause === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || cause === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY') {
        throw new Error(`${host} TLS 憑證鏈無法以目前 Node 信任庫驗證；請以 Node --use-system-ca 使用系統憑證庫（保持 TLS 驗證）`);
      }
      if (error instanceof Error && (error.message === 'terminated' || error.message === 'fetch failed')) {
        throw new Error(`${host} 連線或回應傳輸中斷${cause && /^[A-Z0-9_]+$/.test(cause) ? `（${cause}）` : ''}，保留舊資料並由排程有限重試`);
      }
      throw error;
    } finally { nextRequest.set(host, Date.now() + 3_000); }
    }
    throw new Error(`${host} 傳輸重試已達上限`);
  });
  queues.set(host, request);
  return request;
}

export async function officialJson(url: string): Promise<unknown> {
  const text = await officialText(url);
  try { return JSON.parse(text); } catch { throw new Error(`${new URL(url).hostname} 回傳非 JSON，可能是來源格式變更或存取限制`); }
}
