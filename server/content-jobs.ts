import type { Pool } from 'pg';
import type { FinancialReport, NewsItem, ProviderResult, Security } from '../shared/types';
import { regionOf } from '../shared/markets';

export interface ContentProviders {
 fetchInternationalFinancials?(security: Security, now?: Date): Promise<ProviderResult<FinancialReport>>;
 fetchInternationalNews?(security: Security, now?: Date): Promise<ProviderResult<NewsItem>>;
}
export interface ContentOutcome { source: string; status: 'success' | 'partial' | 'error' | 'skipped'; count: number; warnings: string[]; }
export function createContentJobs(pool: Pool, providers: ContentProviders) {
 async function syncContent(now = new Date()): Promise<ContentOutcome[]> {
  if (!providers.fetchInternationalFinancials && !providers.fetchInternationalNews) return [];
  const client = await pool.connect(); let locked = false;
  try {
   locked = (await client.query("SELECT pg_try_advisory_lock(hashtext(current_schema()),hashtext('zhiyu.content')) AS locked")).rows[0].locked;
   if (!locked) return [];
   const active = async () => (await client.query(`SELECT DISTINCT s.* FROM securities s JOIN watchlist w ON s.id=w.security_id
    JOIN users u ON u.id=w.user_id AND NOT u.disabled JOIN user_modules m ON m.user_id=u.id AND m.module_id='finance' AND m.enabled WHERE s.active`)).rows;
   const rows = (await active()).filter(row => !['TWSE','TPEx'].includes(row.market));
   const outcomes = new Map<string, ContentOutcome>();
   for (const row of rows) {
    const security: Security = { id: row.id, symbol: row.symbol, name: row.name, market: row.market, assetType: row.asset_type, currency: row.currency, aliases: row.aliases, sourceUrl: row.source_url, active: row.active };
    for (const kind of ['financials','news'] as const) {
     if (kind === 'financials' && (security.assetType === 'etf' || !providers.fetchInternationalFinancials) || kind === 'news' && !providers.fetchInternationalNews) continue;
     const progress = (await client.query('SELECT * FROM content_progress WHERE security_id=$1 AND kind=$2', [security.id, kind])).rows[0];
     const interval = kind === 'financials' && progress?.status === 'success' ? 86400000 : 3600000;
     if (progress && now.getTime()-new Date(progress.last_attempt).getTime() < interval) continue;
     if (!(await active()).some(row => row.id === security.id)) continue;
     const source = `content.${regionOf(security.market)}.${kind}`;
     const outcome = outcomes.get(source) ?? { source, status: 'success', count: 0, warnings: [] };
     outcomes.set(source, outcome);
     await client.query(`INSERT INTO content_progress(security_id,kind,status,last_attempt) VALUES($1,$2,'pending',$3)
      ON CONFLICT(security_id,kind) DO UPDATE SET status='pending',last_attempt=$3,error=NULL`, [security.id,kind,now]);
     try {
      const result = kind === 'financials' ? await providers.fetchInternationalFinancials!(security,now) : await providers.fetchInternationalNews!(security,now);
      if (!(await active()).some(row => row.id === security.id)) continue;
      await client.query('BEGIN');
      try {
       if (kind === 'financials') {
        for (const report of result.items as FinancialReport[]) {
         if (report.securityId !== security.id) throw new Error('mismatch');
         await client.query(`INSERT INTO financial_reports(security_id,period_end,basis,data,fetched_at,observed_at) VALUES($1,$2,$3,$4::jsonb,$5,$5)
          ON CONFLICT(security_id,period_end,basis) DO UPDATE SET data=$4::jsonb,fetched_at=$5,observed_at=CASE WHEN financial_reports.data-'fetchedAt' IS DISTINCT FROM $4::jsonb-'fetchedAt' THEN $5 ELSE financial_reports.observed_at END`, [security.id,report.periodEnd,report.basis,JSON.stringify(report),now]);
        }
        // An upstream rolling window must never erase the financial history already archived.
       } else {
        for (const item of result.items as NewsItem[]) {
         if (!item.securityIds.includes(security.id)) continue;
         // Merge public source associations when two tracked companies share a headline.
         const old = (await client.query('SELECT data FROM news WHERE id=$1', [item.id])).rows[0]?.data as NewsItem | undefined;
         const merged = { ...item, securityIds: [...new Set([...(old?.securityIds ?? []), security.id])] };
         await client.query(`INSERT INTO news(id,published_at,data) VALUES($1,$2,$3::jsonb) ON CONFLICT(id) DO UPDATE SET published_at=$2,data=$3::jsonb`, [item.id,item.publishedAt,JSON.stringify(merged)]);
        }
       }
       const status = result.warnings.length ? result.items.length ? 'partial' : 'error' : 'success';
       await client.query(`UPDATE content_progress SET status=$3,error=$4,last_success=CASE WHEN $3='error' THEN last_success ELSE $5 END WHERE security_id=$1 AND kind=$2`, [security.id,kind,status,result.warnings.join('；') || null,now]);
       await client.query('COMMIT');
       outcome.count += result.items.length; outcome.warnings.push(...result.warnings);
      } catch (error) { await client.query('ROLLBACK'); throw error; }
     } catch {
      const message = kind === 'financials' ? '部分追蹤標的的財報來源暫時無法取得，保留舊資料。' : '部分追蹤標的的新聞來源暫時無法取得，保留舊資料。';
      outcome.warnings.push(message);
      await client.query("UPDATE content_progress SET status='error',error=$3 WHERE security_id=$1 AND kind=$2", [security.id,kind,message]);
     }
    }
   }
   for (const outcome of outcomes.values()) {
    outcome.warnings = [...new Set(outcome.warnings)]; outcome.status = outcome.warnings.length ? outcome.count ? 'partial' : 'error' : 'success';
    const [,region,kind] = outcome.source.split('.'), name = `${region === 'JP' ? '日股' : '美股'}${kind === 'financials' ? '季度與年度財報' : '相關新聞'}`;
    await client.query(`INSERT INTO source_runs(id,name,status,last_attempt,last_success,count,error) VALUES($1,$2,$3,$4,CASE WHEN $3='error' THEN NULL ELSE $4::timestamptz END,$5,$6)
     ON CONFLICT(id) DO UPDATE SET name=$2,status=$3,last_attempt=$4,last_success=CASE WHEN $3='error' THEN source_runs.last_success ELSE $4 END,count=$5,error=$6`, [outcome.source,name,outcome.status,now,outcome.count,outcome.warnings.join('；') || null]);
   }
   return [...outcomes.values()];
  } finally {
   if (locked) await client.query("SELECT pg_advisory_unlock(hashtext(current_schema()),hashtext('zhiyu.content'))").catch(()=>{});
   client.release();
  }
 }
 return { syncContent };
}

/** Trim news caches; historical prices and financial statements are long-term archives. */
export async function pruneMarketCache(pool: Pool, now = new Date()): Promise<void> {
 // Untracking stops fetching. It does not discard compact price/financial history.
 await pool.query(`DELETE FROM news WHERE published_at < $1 OR id NOT IN (SELECT id FROM news ORDER BY published_at DESC,id LIMIT 5000)`, [new Date(now.getTime()-90*86400000)]);
}
