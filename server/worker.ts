import { PgBoss } from 'pg-boss';
import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { catchupNeeded, createJobHandlers, enqueueHistory, GLOBAL_JOB_KEY, QUEUES, safeError, trackedSecurities, type JobOutcome, type QueueName } from './jobs.js';
import { pruneMarketCache } from './content-jobs';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const jobs = createJobHandlers(pool);
const once = process.argv.includes('--once');
let boss: PgBoss | undefined;
let stopping = false;

function report(outcomes: JobOutcome | JobOutcome[]) {
  for (const item of Array.isArray(outcomes) ? outcomes : [outcomes]) {
    console.info(JSON.stringify({ event: 'source-sync', ...item }));
  }
}
function requireRetry(outcomes: JobOutcome[]) {
  const failed = outcomes.filter(outcome => outcome.status === 'error' || outcome.status === 'skipped' && outcome.warnings.length ||
    outcome.source.startsWith('market.') && outcome.status === 'partial' && outcome.warnings.some(warning => warning.includes('尚待')));
  if (failed.length) throw new Error(`來源尚未就緒：${failed.map(item => item.source).join('、')}；將依有限重試策略重試`);
}
async function enqueueTrackedHistory() {
  if (!boss) return;
  for (const security of await trackedSecurities(pool)) await enqueueHistory(boss, security.id);
}
async function digestPipeline() {
  // Save an honest partial digest even if one upstream is unavailable. A later retry updates the same row.
  const outcomes = [...await jobs.syncMarket(), ...await jobs.syncInternational(), ...await jobs.syncContent(), await jobs.syncFundamentals(), await jobs.syncNews()];
  report(outcomes);
  const count = await jobs.generateDigests();
  console.info(JSON.stringify({ event: 'digest-generated', count }));
  await enqueueTrackedHistory();
  await pruneMarketCache(pool);
  requireRetry(outcomes);
}
async function shutdown() {
  if (stopping) return;
  stopping = true;
  // Let PostgreSQL finish current transactions before disconnecting; killed jobs are recovered by pg-boss.
  if (boss) await boss.stop({ graceful: true, timeout: 30000 });
  await pool.end();
}

async function main() {
  await migrate(pool);
  if (once) {
    const outcomes = [...await jobs.syncMarket(), ...await jobs.syncInternational(), ...await jobs.syncContent(), await jobs.syncFundamentals(), await jobs.syncNews()];
    report(outcomes);
    const history = await jobs.backfillHistory();
    report(history);
    const digests = await jobs.generateDigests();
    const all = [...outcomes, ...history];
    console.info(JSON.stringify({ event: 'sync-finished', digests, partial: all.some(item => item.status === 'partial'), failed: all.filter(item => item.status === 'error').length }));
    if (all.some(item => item.status === 'error')) process.exitCode = 1;
    await shutdown();
    return;
  }
  boss = new PgBoss({ connectionString: config.databaseUrl, application_name: 'zhiyu-worker' });
  boss.on('error', error => console.error(JSON.stringify({ event: 'queue-error', message: safeError(error) })));
  await boss.start();
  for (const name of QUEUES) {
    await boss.createQueue(name, { policy: name === 'digest.generate' ? 'stately' : 'exclusive', retryLimit: name === 'international.sync' ? 0 : 2, retryDelay: 120, retryBackoff: true, expireInSeconds: 3600 });
  }
  await boss.work('market.sync', { batchSize: 1 }, async () => {
    const outcomes = await jobs.syncMarket(); report(outcomes);
    await enqueueTrackedHistory(); requireRetry(outcomes);
  });
  await boss.work('news.sync', { batchSize: 1 }, async () => {
    report(await jobs.syncContent());
    const outcome = await jobs.syncNews(); report(outcome); requireRetry([outcome]);
  });
  await boss.work('international.sync', { batchSize: 1 }, async () => {
    const outcomes = [...await jobs.syncInternational(), ...await jobs.syncContent()]; report(outcomes);
    if (outcomes.some(outcome => outcome.count > 0)) await jobs.generateDigests();
  });
  await boss.work('fundamentals.sync', { batchSize: 1 }, async () => {
    const outcome = await jobs.syncFundamentals(); report(outcome); requireRetry([outcome]);
  });
  await boss.work<{ securityId?: string; month?: string }>('history.backfill', { batchSize: 1 }, async ([job]) => {
    const outcomes = await jobs.backfillHistory(job.data.securityId, job.data.month);
    report(outcomes); requireRetry(outcomes);
  });
  await boss.work('digest.generate', { batchSize: 1 }, digestPipeline);
  const scheduleOptions = { tz: 'Asia/Taipei', singletonKey: GLOBAL_JOB_KEY, retryLimit: 2, retryDelay: 120, retryBackoff: true };
  await boss.schedule('market.sync', '30 16 * * 1-5', {}, scheduleOptions);
  // Hourly recovery check, while the handler caches completed sessions and limits retries.
  await boss.schedule('international.sync', '10 * * * *', {}, { ...scheduleOptions, retryLimit: 0 });
  await boss.schedule('news.sync', '0 * * * *', {}, scheduleOptions);
  await boss.schedule('digest.generate', '30 20 * * *', {}, scheduleOptions);

  const state = await pool.query('SELECT key,value FROM scheduler_state WHERE key=ANY($1::text[])', [QUEUES]);
  const completedAt: Partial<Record<QueueName, string>> = Object.fromEntries(state.rows.map(row => [row.key, row.value.completedAt]));
  const catchup = catchupNeeded(completedAt);
  // Digest refresh includes market/news work. Coalesce those on restart to avoid duplicate upstream calls.
  for (const name of catchup.includes('digest.generate') ? ['digest.generate'] : catchup) {
    await boss.send(name, {}, { singletonKey: GLOBAL_JOB_KEY });
  }
  await enqueueTrackedHistory();
  console.info(JSON.stringify({ event: 'worker-ready', timezone: 'Asia/Taipei', catchup }));
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
}

main().catch(async error => {
  console.error(JSON.stringify({ event: 'worker-failed', message: safeError(error) }));
  process.exitCode = 1;
  await shutdown().catch(() => {});
});
