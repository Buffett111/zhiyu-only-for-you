import 'dotenv/config';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadConfig } from '../server/config';
const dryRun = process.argv.includes('--dry-run');
const configPath = existsSync('wrangler.local.jsonc') ? 'wrangler.local.jsonc' : 'wrangler.jsonc';
const wrangler = JSON.parse(await readFile(configPath, 'utf8'));
if (!dryRun) {
  const config = loadConfig();
  if (config.mode !== 'production') throw new Error('部署前先依 docs/deployment.md 設定正式 Access 登入；目前仍是本機開發模式。');
  if (!wrangler.vpc_services?.some((binding: { binding: string; service_id: string }) => binding.binding === 'PRIVATE_API' && /^[a-f\d-]{36}$/i.test(binding.service_id))) throw new Error('請先執行 npm run cf:prepare 綁定 VPC Service。');
}
const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--config', configPath, ...(dryRun ? ['--dry-run'] : [])], {
  stdio: 'inherit', env: { ...process.env, WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH || resolve('.cache', 'wrangler-logs') },
});
if (result.error || result.signal) throw new Error('Wrangler did not finish successfully.');
process.exitCode = result.status ?? 1;
