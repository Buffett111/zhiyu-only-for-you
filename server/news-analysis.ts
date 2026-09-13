import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Config } from './config';
import type { NewsAnalysis, NewsAnalysisState, NewsItem, NewsScope, Security } from '../shared/types';
import { AnalysisError, NEWS_MODEL, NEWS_PROMPT_VERSION, summarizeNews } from './providers/openai-news';

export interface AnalysisSelection { kind: 'news' | 'announcement'; scope: NewsScope; }
export function selectAnalysisSources(items: NewsItem[], securityId: string, scope: NewsScope): NewsAnalysis['sources'] {
  const relation = (item: NewsItem) => item.relations?.find(r => r.securityId === securityId)?.kind ?? 'direct';
  const seen = new Set<string>();
  const eligible = items.filter(item => {
    if (!item.securityIds.includes(securityId) || scope !== 'all' && relation(item) !== scope) return false;
    if (!/^https?:\/\//i.test(item.url) || seen.has(item.url) || item.title.length > 600) return false;
    seen.add(item.url); return true;
  });
  // Reserve space for each kind of ETF relationship so a busy constituent does not hide fund news.
  const chosen = scope === 'all' ? ['direct', 'constituent', 'market'].flatMap(kind => eligible.filter(item => relation(item) === kind).slice(0, 10)) : eligible.slice(0, 30);
  for (const item of eligible) if (chosen.length < 30 && !chosen.includes(item)) chosen.push(item);
  return chosen.sort((a,b) => b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id)).map((item,index) => ({ id: `N${index+1}`, title: item.title, url: item.url, source: item.source.slice(0,120), publishedAt: item.publishedAt, relation: relation(item) }));
}

export function createNewsAnalysisService(pool: Pool, config: Config, generate = summarizeNews) {
  async function input(security: Security, selection: AnalysisSelection) {
    // Seven days, finite input; only public market news is sent to OpenAI.
    const rows = await pool.query(`SELECT data FROM news WHERE data->'securityIds' ? $1 AND data->>'kind'=$2 AND published_at>=now()-interval '7 days' AND published_at<=now() ORDER BY published_at DESC,id LIMIT 500`, [security.id,selection.kind]);
    const items: NewsItem[] = rows.rows.map(row => row.data);
    const sources = selectAnalysisSources(items, security.id,selection.scope);
    const fingerprint = createHash('sha256').update(JSON.stringify({ model: NEWS_MODEL, version: NEWS_PROMPT_VERSION, security: { symbol:security.symbol,name:security.name,market:security.market,assetType:security.assetType }, selection,sources })).digest('hex');
    return { sources,fingerprint,availableCount: items.filter(item => selection.scope==='all' || (item.relations?.find(r=>r.securityId===security.id)?.kind??'direct')===selection.scope).length };
  }
  const keys = (security: Security, selection: AnalysisSelection) => [security.id, selection.kind, selection.scope];
  async function read(security: Security, selection: AnalysisSelection): Promise<NewsAnalysisState> {
    const current = await input(security,selection);
    const row = (await pool.query('SELECT * FROM news_analysis WHERE security_id=$1 AND kind=$2 AND scope=$3',keys(security,selection))).rows[0];
    const expired = row?.status==='pending' && Date.now()-new Date(row.last_attempt).getTime()>90000;
    return { enabled: Boolean(config.openaiApiKey) && (config.aiDailyLimit??40)>0, status: expired?'error':row?.status??'empty', analysis:row?.data??null, error:expired?'先前分析中斷，請重新產生。':row?.error??null, stale: Boolean(row?.data && row.fingerprint!==current.fingerprint),availableCount:current.availableCount,selectedCount:current.sources.length };
  }
  async function run(security: Security, selection: AnalysisSelection): Promise<NewsAnalysisState> {
    if (!config.openaiApiKey) throw new AnalysisError('站長尚未設定 OpenAI API 金鑰。');
    const current = await input(security,selection);
    if (!current.sources.length) throw new AnalysisError('近七日沒有此分類可供分析的新聞。');
    const attempt = randomUUID();
    const day = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Taipei'}).format(new Date());
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO news_analysis(security_id,kind,scope) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',keys(security,selection));
      const row = (await client.query('SELECT * FROM news_analysis WHERE security_id=$1 AND kind=$2 AND scope=$3 FOR UPDATE',keys(security,selection))).rows[0];
      // Release this reserved connection in finally before the cache read takes another one.
      if (row.data && row.fingerprint===current.fingerprint) { await client.query('COMMIT'); return read(security,selection); }
      const age = Date.now()-new Date(row.last_attempt??0).getTime();
      if (row.status==='pending' && age<90000) { await client.query('COMMIT'); return read(security,selection); }
      if (age < (row.status==='error'?300000:900000) && row.status!=='pending') throw new AnalysisError('這份分析剛更新或嘗試過，請稍後再產生，避免重複計費。',429);
      const budget = await client.query(`INSERT INTO ai_daily_usage(day,requests) SELECT $1,1 WHERE $2::int>0 ON CONFLICT(day) DO UPDATE SET requests=ai_daily_usage.requests+1 WHERE ai_daily_usage.requests<$2 RETURNING requests`,[day,config.aiDailyLimit??40]);
      if (!budget.rowCount) throw new AnalysisError('本站今日 AI 分析次數已達上限，既有分析仍可閱讀。',429);
      await client.query("UPDATE news_analysis SET status='pending',error=NULL,attempt_id=$4,last_attempt=now() WHERE security_id=$1 AND kind=$2 AND scope=$3",[...keys(security,selection),attempt]);
      await client.query('COMMIT');
    } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    try {
      const result = await generate(config.openaiApiKey,{symbol:security.symbol,name:security.name,market:security.market,assetType:security.assetType},current.sources);
      const dates = current.sources.map(source=>source.publishedAt).sort();
      const data: NewsAnalysis = { ...result.content, model: NEWS_MODEL, generatedAt:new Date().toISOString(),basis:'headlines',from:dates[0],to:dates.at(-1)!,sources:current.sources,usage:result.usage };
      await pool.query("UPDATE news_analysis SET data=$5,fingerprint=$6,status='ready',error=NULL WHERE security_id=$1 AND kind=$2 AND scope=$3 AND attempt_id=$4",[...keys(security,selection),attempt,data,current.fingerprint]);
      await pool.query('UPDATE ai_daily_usage SET input_tokens=input_tokens+$2,output_tokens=output_tokens+$3 WHERE day=$1',[day,result.usage.inputTokens,result.usage.outputTokens]);
    } catch(error) {
      const message = error instanceof AnalysisError?error.message:'AI 分析失敗，請稍後再試。';
      await pool.query("UPDATE news_analysis SET status='error',error=$5 WHERE security_id=$1 AND kind=$2 AND scope=$3 AND attempt_id=$4",[...keys(security,selection),attempt,message]);
      throw new AnalysisError(message);
    }
    return read(security,selection);
  }
  return {read,run};
}
