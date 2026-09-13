import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { parse } from 'dotenv';
import { homedir } from 'node:os';

// Inspect the exact index, not the working directory. Secret values never appear in diagnostics.
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
if (!files.length) throw new Error('Nothing staged; stage the intended public files first.');
const env = parse(await readFile('.env').catch(() => Buffer.from('')));
const example = files.includes('.env.example') ? parse(execFileSync('git', ['show', ':.env.example'], { encoding: 'utf8' })) : {};
// Only the documented, reserved-domain development identity is a public default.
// Never exempt passwords/tokens just because somebody also copied them into the example.
const isPublicDefault = (key: string, value: string) => key === 'DEV_USER_EMAIL' && value === example[key] && /^[^\s@]+@(?:[a-z\d-]+\.)*invalid$/i.test(value);
const privateValues = Object.entries(env).filter(([key, value]) => /SECRET|API_KEY|PASSWORD|PASSPHRASE|TOKEN|DATABASE_URL|EMAIL|ACCOUNT_ID|TEAM_DOMAIN|ACCESS_AUD|VPC_SERVICE_ID/.test(key) && !isPublicDefault(key, value))
  .flatMap(([key, value]) => (key.endsWith('EMAILS') ? value.split(',') : [value]).map(value => [key, value.trim()] as const)).filter(([, value]) => value.length >= 8);
const local = JSON.parse(await readFile('wrangler.local.jsonc', 'utf8').catch(() => '{}')) as { vpc_services?: { service_id?: string }[] };
for (const binding of local.vpc_services ?? []) if (binding.service_id) privateValues.push(['local VPC service binding', binding.service_id]);
const credentials = [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/, /\bsk-(?:proj-)?[A-Za-z0-9_-]{30,}\b/];
const forbidden = /(^|\/)(\.env(?:\..*)?|\.dev\.vars(?:\..*)?|\.cache|\.wrangler|\.cloudflare|\.secrets|secrets|credentials|backups|data|node_modules|dist|test-results|coverage)(\/|$)|wrangler\.(?:.*\.)?local\.jsonc$|(?:-token\.txt|\.credentials\.json|\.sql\.gz)$|\.(?:pem|p12|pfx|key|kdbx|age|gpg|enc|token|dump|backup|sqlite|sqlite3|db|log)$/i;
const failures: { file: string; reason: string }[] = [];
for (const file of files) {
  if (forbidden.test(file) && !['.env.example', '.dev.vars.example'].includes(file)) failures.push({ file, reason: 'private or generated path' });
  const text = execFileSync('git', ['show', `:${file}`], { encoding: 'utf8', maxBuffer: 10_000_000 });
  if (credentials.some(pattern => pattern.test(text))) failures.push({ file, reason: 'credential-shaped content' });
  if (privateValues.some(([, value]) => text.includes(value))) failures.push({ file, reason: 'matches private local configuration' });
  if (text.replace(/[\\/]+/g, '/').toLowerCase().includes(homedir().replace(/[\\/]+/g, '/').toLowerCase())) failures.push({ file, reason: 'contains a personal home-directory path' });
}
if (failures.length) { console.error(JSON.stringify({ passed: false, failures })); process.exitCode = 1; }
else console.log(JSON.stringify({ passed: true, stagedFiles: files.length, checks: ['private paths', 'credential patterns', 'local secret and account values including the example', 'personal home directory'], publicDefaultsExcluded: ['documented reserved-domain DEV_USER_EMAIL'] }));
