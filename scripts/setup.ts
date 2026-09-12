import { access, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
try { await access('.env'); console.log('.env 已存在，保留原設定。'); }
catch {
  const password = randomBytes(24).toString('hex');
  await writeFile('.env', `APP_MODE=development\nHOST=127.0.0.1\nPORT=3001\nDATABASE_URL=postgresql://zhiyu:${password}@127.0.0.1:54329/zhiyu\nPOSTGRES_PASSWORD=${password}\nDEV_USER_EMAIL=local@zhiyu.invalid\nDEV_USER_NAME=我的知隅\nPUBLIC_ORIGIN=http://127.0.0.1:5173\nACCESS_TEAM_DOMAIN=\nACCESS_AUD=\nALLOWED_EMAILS=\nADMIN_EMAILS=\nPG_CONTAINER=zhiyu-db\nBACKUP_PASSPHRASE=${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
  console.log('已建立本機 .env 與隨機資料庫密碼；未輸出任何秘密。');
}
