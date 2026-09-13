import { z } from 'zod';
export interface Config {
  mode: 'development' | 'production'; databaseUrl: string; host: string; port: number;
  publicOrigin: string; devUserEmail: string; devUserName: string;
  accessTeamDomain: string; accessAud: string; allowedEmails: string[]; adminEmails: string[];
  openaiApiKey?: string; aiDailyLimit?: number;
  mediaChannelBatchSize?:number; mediaVideoBatchSize?:number; mediaAiConcurrency?:number; mediaAiDailyBatches?:number;
}
const emails = (value = '') => value.split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = z.enum(['development', 'production']).parse(env.APP_MODE ?? 'production');
  const host = env.HOST || '127.0.0.1';
  if (mode === 'development' && !['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Development mode must bind to loopback.');
  const publicOrigin = env.PUBLIC_ORIGIN || 'http://127.0.0.1:5173';
  const origin = new URL(publicOrigin);
  if (origin.origin !== publicOrigin) throw new Error('PUBLIC_ORIGIN must be an origin without a path or trailing slash.');
  const config: Config = {
    mode, host, port: z.coerce.number().int().min(1).max(65535).parse(env.PORT || '3001'),
    databaseUrl: z.string().min(1, 'DATABASE_URL is required; run npm run setup').parse(env.DATABASE_URL),
    publicOrigin, devUserEmail: z.email().parse(env.DEV_USER_EMAIL || 'local@zhiyu.invalid'),
    devUserName: env.DEV_USER_NAME || '我的知隅', accessTeamDomain: (env.ACCESS_TEAM_DOMAIN || '').replace(/^https:\/\//, '').replace(/\/$/, ''),
    accessAud: env.ACCESS_AUD || '', allowedEmails: emails(env.ALLOWED_EMAILS), adminEmails: emails(env.ADMIN_EMAILS),
    openaiApiKey: env.OPENAI_API_KEY?.trim() || undefined,
    aiDailyLimit: z.coerce.number().int().min(0).max(1000).parse(env.AI_DAILY_REQUEST_LIMIT ?? '40'),
    mediaChannelBatchSize:z.coerce.number().int().min(1).max(48).parse(env.MEDIA_CHANNEL_BATCH_SIZE ?? '32'),
    mediaVideoBatchSize:z.coerce.number().int().min(1).max(150).parse(env.MEDIA_VIDEO_BATCH_SIZE ?? '100'),
    mediaAiConcurrency:z.coerce.number().int().min(1).max(6).parse(env.MEDIA_AI_CONCURRENCY ?? '4'),
    mediaAiDailyBatches:z.coerce.number().int().min(0).max(1000).parse(env.MEDIA_AI_DAILY_BATCH_LIMIT ?? '200')
  };
  if (mode === 'production') {
    if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(config.accessTeamDomain) || !config.accessAud) throw new Error('Production requires ACCESS_TEAM_DOMAIN and ACCESS_AUD.');
    if (origin.protocol !== 'https:') throw new Error('Production requires HTTPS PUBLIC_ORIGIN.');
    if (!config.allowedEmails.length || !config.adminEmails.length) throw new Error('Production requires explicit ALLOWED_EMAILS and ADMIN_EMAILS.');
    for (const email of [...config.allowedEmails, ...config.adminEmails]) z.email().parse(email);
    if (config.adminEmails.some(email => !config.allowedEmails.includes(email))) throw new Error('Every admin must also be in ALLOWED_EMAILS.');
  }
  return config;
}
