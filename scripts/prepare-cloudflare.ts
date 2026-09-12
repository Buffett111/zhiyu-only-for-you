import 'dotenv/config';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
const args = process.argv.slice(2);
const get = (key: string) => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
const serviceId = z.uuid().safeParse(get('--service-id') || process.env.CLOUDFLARE_VPC_SERVICE_ID);
if (!serviceId.success) throw new Error('Usage: npm run cf:prepare -- --service-id <VPC service UUID>, or set CLOUDFLARE_VPC_SERVICE_ID in .env.');
// Keep public defaults reusable; account-specific bindings only live in the ignored local configuration.
const path = existsSync('wrangler.local.jsonc') ? 'wrangler.local.jsonc' : 'wrangler.jsonc';
const config = JSON.parse(await readFile(path, 'utf8'));
config.vpc_services = [{ binding: 'PRIVATE_API', service_id: serviceId.data }];
config.vars = { ...config.vars, API_ORIGIN: 'http://127.0.0.1:3001' };
await writeFile('wrangler.local.jsonc', JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
console.log('已更新本機專用的 VPC 設定；未執行部署。');
