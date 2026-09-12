import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { FastifyRequest } from 'fastify';
import type { Config } from './config';
export class AccessError extends Error { constructor(public statusCode: number, message: string) { super(message); } }
export interface Identity { email: string; displayName: string; role: 'admin' | 'member'; }
export function createIdentityVerifier(config: Config, testKeys?: JWTVerifyGetKey) {
  const issuer = `https://${config.accessTeamDomain}`;
  const keys = config.mode === 'production' ? testKeys ?? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), { timeoutDuration: 5000 }) : null;
  return async (request: FastifyRequest): Promise<Identity> => {
    if (config.mode === 'development') {
      if (request.headers['x-zhiyu-edge'] || request.headers['cf-access-jwt-assertion']) throw new AccessError(503, '伺服器尚未設定正式登入。');
      return { email: config.devUserEmail.toLowerCase(), displayName: config.devUserName, role: 'admin' };
    }
    const assertion = request.headers['cf-access-jwt-assertion'];
    if (typeof assertion !== 'string' || !assertion) throw new AccessError(401, '請先登入知隅。');
    try {
      const { payload } = await jwtVerify(assertion, keys!, { issuer, audience: config.accessAud, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub', 'email'] });
      if (typeof payload.email !== 'string') throw new Error('Missing identity');
      const email = payload.email.toLowerCase();
      if (!config.allowedEmails.includes(email)) throw new AccessError(403, '這個帳號尚未受邀。');
      return { email, displayName: email.split('@')[0], role: config.adminEmails.includes(email) ? 'admin' : 'member' };
    } catch (error) { if (error instanceof AccessError) throw error; throw new AccessError(401, '登入已過期或驗證失敗，請重新登入。'); }
  };
}
