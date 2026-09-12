import { describe, it, expect, vi } from 'vitest';
import worker from '../edge/worker';
describe('Cloudflare ingress', () => {
  it('rejects unauthenticated requests before reaching the local origin', async () => {
    const fetch = vi.fn(); const response = await worker.fetch(new Request('https://example.workers.dev/api/v1/bootstrap'), { ASSETS: { fetch }, PRIVATE_API: { fetch } });
    expect(response.status).toBe(401); expect(fetch).not.toHaveBeenCalled();
  });
  it('never forwards cookies and protects private responses from cache', async () => {
    const fetch = vi.fn(async (r: Request) => { expect(r.url).toBe('http://localhost:3001/api/v1/me'); expect(r.headers.get('cookie')).toBeNull(); expect(r.headers.get('x-zhiyu-edge')).toBe('1'); return Response.json({ ok: true }); });
    const response = await worker.fetch(new Request('https://example.workers.dev/api/v1/me', { headers: { 'cf-access-jwt-assertion': 'validated-by-origin', cookie: 'private=secret' } }), { ASSETS: { fetch }, PRIVATE_API: { fetch } });
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it('shows an offline state when the origin is unavailable', async () => {
    const fetch = vi.fn(async () => { throw new Error('host offline'); });
    const response = await worker.fetch(new Request('https://example.workers.dev/api/v1/me', { headers: { 'cf-access-jwt-assertion': 'token' } }), { ASSETS: { fetch }, PRIVATE_API: { fetch } });
    expect(response.status).toBe(503); expect(await response.text()).toContain('離線');
  });
});
