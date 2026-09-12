import { describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { FastifyRequest } from 'fastify';
import { loadConfig } from '../server/config';
import { createIdentityVerifier } from '../server/auth';
const production = { APP_MODE: 'production', DATABASE_URL: 'postgresql://localhost/unused', PUBLIC_ORIGIN: 'https://zhiyu.example.workers.dev', ACCESS_TEAM_DOMAIN: 'test.cloudflareaccess.com', ACCESS_AUD: 'expected-audience', ALLOWED_EMAILS: 'owner@example.org,friend@example.org', ADMIN_EMAILS: 'owner@example.org' };
describe('production authentication', () => {
  it('fails closed when production is missing its access settings', () => { expect(() => loadConfig({ DATABASE_URL: 'postgresql://localhost/unused' })).toThrow(); });
  it('prevents a local development identity from being exposed on a public bind or edge', async () => {
    expect(() => loadConfig({ APP_MODE: 'development', DATABASE_URL: 'x', HOST: '0.0.0.0' })).toThrow();
    const verify = createIdentityVerifier(loadConfig({ APP_MODE: 'development', DATABASE_URL: 'x' }));
    await expect(verify({ headers: { 'x-zhiyu-edge': '1' } } as unknown as FastifyRequest)).rejects.toMatchObject({ statusCode: 503 });
  });
  it('validates signature, expiration, audience and invitation instead of trusting email headers', async () => {
    const config = loadConfig(production);
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = { ...await exportJWK(publicKey), kid: 'unit-test', alg: 'RS256' };
    const verify = createIdentityVerifier(config, createLocalJWKSet({ keys: [jwk] }));
    const token = async (email: string, aud = config.accessAud, exp: number | string = '1h') => new SignJWT({ email }).setProtectedHeader({ alg: 'RS256', kid: 'unit-test' }).setIssuer('https://test.cloudflareaccess.com').setSubject('subject').setAudience(aud).setIssuedAt().setExpirationTime(exp).sign(privateKey);
    const request = (value?: string) => ({ headers: { 'cf-access-authenticated-user-email': 'owner@example.org', ...(value ? { 'cf-access-jwt-assertion': value } : {}) } } as unknown as FastifyRequest);
    await expect(verify(request())).rejects.toMatchObject({ statusCode: 401 });
    await expect(verify(request(await token('owner@example.org')))).resolves.toMatchObject({ email: 'owner@example.org', role: 'admin' });
    await expect(verify(request(await token('friend@example.org')))).resolves.toMatchObject({ role: 'member' });
    await expect(verify(request(await token('stranger@example.org')))).rejects.toMatchObject({ statusCode: 403 });
    await expect(verify(request(await token('owner@example.org', 'wrong-audience')))).rejects.toMatchObject({ statusCode: 401 });
    await expect(verify(request(await token('owner@example.org', config.accessAud, 1)))).rejects.toMatchObject({ statusCode: 401 });
    await expect(verify(request('not.a.signature'))).rejects.toMatchObject({ statusCode: 401 });
  });
});
