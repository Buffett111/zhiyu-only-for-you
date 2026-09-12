import { loadConfig } from './config';
import { createPool, migrate } from './db';
const pool = createPool(loadConfig().databaseUrl);
try { await migrate(pool); console.log('資料庫已完成升級。'); } finally { await pool.end(); }
