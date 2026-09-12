import { PgBoss } from 'pg-boss';
import { loadConfig } from './config';
import { createPool, migrate } from './db';
import { buildApp } from './app';
const config = loadConfig();
const pool = createPool(config.databaseUrl);
await migrate(pool);
const boss = new PgBoss({ connectionString: config.databaseUrl });
boss.on('error', () => console.error('背景工作佇列連線失敗。'));
await boss.start();
for (const name of ['market.sync', 'news.sync', 'history.backfill', 'digest.generate', 'fundamentals.sync']) await boss.createQueue(name, { policy: name === 'digest.generate' ? 'stately' : 'exclusive', retryLimit: 2, retryDelay: 120, retryBackoff: true, expireInSeconds: 3600 });
const app = await buildApp({ pool, config, queue: boss });
await app.listen({ host: config.host, port: config.port });
console.log(`知隅 API 已啟動 (${config.mode})：http://${config.host}:${config.port}`);
let closing = false;
async function close() { if (closing) return; closing = true; await app.close(); await boss.stop(); await pool.end(); }
process.on('SIGINT', () => { void close(); }); process.on('SIGTERM', () => { void close(); });
