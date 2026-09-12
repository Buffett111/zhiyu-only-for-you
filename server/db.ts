import pg, { type Pool } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
pg.types.setTypeParser(1082, value => value);
export const createPool = (databaseUrl: string): Pool => new pg.Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('zhiyu.migrations'))");
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const dir = new URL('./migrations/', import.meta.url);
    for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
      if ((await client.query('SELECT 1 FROM schema_migrations WHERE version=$1', [file])).rowCount) continue;
      await client.query('BEGIN');
      try { await client.query(await readFile(new URL(file, dir), 'utf8')); await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [file]); await client.query('COMMIT'); }
      catch (error) { await client.query('ROLLBACK'); throw error; }
    }
  } finally { await client.query("SELECT pg_advisory_unlock(hashtext('zhiyu.migrations'))").catch(() => {}); client.release(); }
}
