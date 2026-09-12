# 知隅｜Only for You

給自己與親友的個人資訊角落。財經模組支援台股、美股與日股的股票／ETF 收盤追蹤：私人自選清單、原幣日線與每天 20:30 的摘要。台股另有公司基本面與新聞公告；美日這兩項功能尚未接入。

美股與日股試用 `yahoo-finance2`，不用申請 API key 或付費；新增追蹤時補抓最近一年可取得的日線，每小時檢查已完成交易日。這是非官方介接，來源異常時保留舊行情並顯示提示。台股採交易所來源、未還原價格；Yahoo 使用拆股調整的 Close，不使用含股息調整的 Adj Close。

## 本機執行

需要 Node.js 24、Docker Desktop、npm。請在專案目錄執行：

```powershell
npm ci
npm run setup
docker compose up -d --wait db
npm run db:migrate
npm run sync
npm run dev
```

開啟 [本機網站](http://127.0.0.1:5173)。再開一個終端執行 `npm run worker`，讓排程在瀏覽器關閉後持續運作。本機開發身分固定為 `.env` 的 DEV_USER_EMAIL；不接受前端自填使用者 ID，也不能將開發模式透過公開 Tunnel 分享。

資料第一次同步後才有股票目錄。選取股票後，背景工作依月份補抓一年內可取得的歷史行情；新加入時圖表可能顯示「等待補抓」。沒有追蹤標的時，不捏造持股或價格。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 本機 API 與 Vite 前端 |
| `npm run worker` | 背景排程、重啟補抓 |
| `npm run sync` | 單次資料同步與摘要 |
| `npm run build` | TypeScript 檢查與正式前端建置 |
| `npm test` | 單元測試與真實 PostgreSQL 隔離 schema 整合測試 |
| `npm run db:backup` | 使用 `.env` 的 BACKUP_PASSPHRASE 建立 AES-256-GCM 加密備份 |
| `npm run db:restore -- backups/file.json zhiyu_restore_check` | 還原到全新資料庫，不覆寫正式資料 |
| `npm run cf:prepare -- --service-id <VPC service UUID>` | 將私人 binding 寫入被 Git 忽略的 `wrangler.local.jsonc` |
| `npm run cf:check` | 依本機設定執行 Worker 部署乾跑，不發布 |
| `npm run sources:verify -- --month=2026-08` | 四種標的的真實行情、歷史、財報與新聞驗證 |
| `npm exec -- tsx --use-system-ca scripts/verify-pipeline.ts --month=2026-08` | 真實來源與 PostgreSQL 整合驗證，僅寫入暫存隔離 schema |
| `npm exec -- tsx --use-system-ca scripts/verify-yahoo.ts --ui` | 四種美日標的的真實來源、帳號隔離、重啟去重與桌面／手機驗證；需要 Chrome，僅使用隔離 schema 與連接埠 3003 |
| `powershell -File scripts/start-services.ps1` | 啟動 API、背景排程與已設定的私有 Tunnel |

## 文件

- [部署、登入與帳號設定](docs/deployment.md)
- [架構與模組擴充契約](docs/architecture.md)
- [來源、授權與資料邊界](docs/data-sources.md)
- [美股、日股免費資料來源調研](docs/international-data-survey.md)
- [驗證紀錄](docs/verification.md)

本機版本已通過 75 項測試、正式建置與真實資料管線驗證；完整範圍見[驗證紀錄](docs/verification.md)。公開部署需自行設定 Cloudflare 帳號、Access 邀請名單及本機 Tunnel；程式庫不包含可共用的服務帳號或部署憑證。

`.env`、`wrangler.local.jsonc`、資料、執行紀錄與備份均排除於 Git。請另行保存備份密語；缺少密語便無法解密。共享此站給親友時，依部署文件啟用正式登入。
