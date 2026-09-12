import { spawn, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createDecipheriv, scryptSync } from 'node:crypto';
import { resolve } from 'node:path';
const [file, target] = process.argv.slice(2);
if (!file || !target || !/^zhiyu_restore_[a-zA-Z0-9_]+$/.test(target)) throw new Error('Usage: npm run db:restore -- <backup.json> zhiyu_restore_<new_name> (只還原到新資料庫)');
const passphrase = process.env.BACKUP_PASSPHRASE;
if (!passphrase) throw new Error('需要原備份的 BACKUP_PASSPHRASE');
const container = process.env.PG_CONTAINER || 'zhiyu-db';
if (!/^[a-zA-Z0-9_-]+$/.test(container)) throw new Error('Invalid PG_CONTAINER');
const envelope = JSON.parse(await readFile(resolve(file), 'utf8'));
if (envelope.format !== 'zhiyu-backup-v1') throw new Error('不支援的備份格式');
let dump: Buffer;
try {
  const decipher = createDecipheriv('aes-256-gcm', scryptSync(passphrase, Buffer.from(envelope.salt, 'base64'), 32), Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  dump = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
} catch { throw new Error('備份驗證失敗：密語不符或備份檔已損壞。'); }
if (dump.subarray(0, 5).toString() !== 'PGDMP') throw new Error('備份內容不是 PostgreSQL dump');
const created = spawnSync('docker', ['exec', container, 'createdb', '-U', 'zhiyu', target], { windowsHide: true, stdio: 'pipe' });
if (created.status !== 0) throw new Error('無法建立新還原資料庫；若名稱已存在，請換一個新名稱。');
await new Promise<void>((resolvePromise, reject) => {
  const child = spawn('docker', ['exec', '-i', container, 'pg_restore', '-U', 'zhiyu', '-d', target, '--no-owner', '--exit-on-error'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.on('error', reject); child.stdout.resume(); child.stderr.resume();
  child.stdin.on('error', reject); child.stdin.end(dump);
  child.on('close', code => code === 0 ? resolvePromise() : reject(new Error('還原失敗，新建資料庫保留供檢查；正式資料庫未受影響。')));
});
console.log(`已還原至 ${target}。正式資料庫保持原狀，核對後才能切換 DATABASE_URL。`);
