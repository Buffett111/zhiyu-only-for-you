interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  PRIVATE_API?: { fetch(request: Request): Promise<Response> };
  API_ORIGIN?: string;
}
const jsonError = (error: string, status: number) => Response.json({ error }, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    // Access must protect both the production workers.dev hostname and preview URLs.
    // The origin validates the JWT cryptographically; this check also fails closed.
    const assertion = request.headers.get('cf-access-jwt-assertion');
    if (!assertion) return jsonError('請先透過 Cloudflare Access 登入。', 401);
    if (!env.PRIVATE_API) return jsonError('本機服務尚未連接。', 503);
    const origin = env.API_ORIGIN || 'http://localhost:3001';
    if (!/^http:\/\/(localhost|127\.0\.0\.1):3001$/.test(origin)) return jsonError('服務入口設定有誤。', 503);
    const headers = new Headers();
    for (const key of ['accept', 'content-type', 'origin', 'cf-access-jwt-assertion']) { const value = request.headers.get(key); if (value) headers.set(key, value); }
    headers.set('x-zhiyu-edge', '1');
    const target = new URL(url.pathname + url.search, origin);
    if (target.origin !== origin) return jsonError('無法處理此路徑。', 400);
    const forwarded = new Request(target, request);
    const isAnalysis = request.method === 'POST' && (/^\/api\/v1\/finance\/securities\/[^/]+\/news-analysis$/.test(url.pathname) || url.pathname === '/api/v1/media/classify' || url.pathname === '/api/v1/media/import');
    const proxy = new Request(forwarded, { headers, redirect: 'manual', signal: AbortSignal.timeout(isAnalysis || url.pathname === '/api/v1/media/export' ? 65000 : 12000) });
    try {
      const response = await env.PRIVATE_API.fetch(proxy);
      if (response.status >= 500) return jsonError('本機暫時離線，恢復連線後會自動補抓資料。', 503);
      const out = new Response(response.body, response);
      out.headers.set('Cache-Control', 'private, no-store, max-age=0');
      out.headers.set('Vary', 'Cookie, Cf-Access-Jwt-Assertion');
      out.headers.set('X-Content-Type-Options', 'nosniff');
      out.headers.delete('set-cookie');
      return out;
    } catch { return jsonError('本機暫時離線，恢復連線後會自動補抓資料。', 503); }
  }
};
