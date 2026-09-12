# Cloudflare 免費子網域＋本機服務

## 前置條件

本機需已通過 `npm run build`、`npm test`、`npm run sync`。Cloudflare 帳號由站長本人登入，使用自己的 Zero Trust、Access 與 Tunnel 設定。Workers VPC 目前仍是 Open Beta，僅 Beta 期間免費；免費 Workers 有每日請求與 CPU 限額。

官方依據：

- [Workers VPC 入門](https://developers.cloudflare.com/workers-vpc/get-started/)
- [Workers VPC 計費](https://developers.cloudflare.com/workers-vpc/reference/pricing/)
- [workers.dev 網址](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
- [Access Email One-time PIN](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)

## 設定步驟

1. `npx wrangler login`，在瀏覽器由本人完成授權；`npx wrangler whoami` 應能讀取帳號。在本機 `.env` 設定 `CLOUDFLARE_ACCOUNT_ID` 與 `ADMIN_EMAILS`。這些帳號資料不寫入公開設定檔。
2. Cloudflare Workers VPC 建立專用 Tunnel，按頁面指示在本機啟動 cloudflared。Token 是秘密，不貼進 README 或 Git。
3. 建立單一 HTTP VPC Service，目標使用 IPv4 `127.0.0.1`、HTTP port `3001`，並選擇專案 Tunnel。API 保持綁定 `127.0.0.1`；不要改成 `localhost`，以免解析為 IPv6 `::1` 而連不到 IPv4 服務，也不要開放整個區域網路或資料庫。
4. 執行 `npm run cf:prepare -- --service-id <VPC Service UUID>`，將 PRIVATE_API binding 寫入被 Git 忽略的 `wrangler.local.jsonc`。也可先在 `.env` 設定 `CLOUDFLARE_VPC_SERVICE_ID`，再執行 `npm run cf:prepare`。公開的 `wrangler.jsonc` 只保留通用預設。
5. 為預定的 `zhiyu.<account>.workers.dev` 建立 Access application（保護完整 host/path），啟用 Email One-time PIN，allow policy 只列指定受邀 Email；沒有 Bypass/Everyone policy。複製 application AUD 與 team domain。
6. 修改本機 `.env`：APP_MODE=production；PUBLIC_ORIGIN=完整 HTTPS 網址（無尾端斜線）；ACCESS_TEAM_DOMAIN=xxx.cloudflareaccess.com；ACCESS_AUD=指定 AUD；ALLOWED_EMAILS=逗號分隔名單；ADMIN_EMAILS=其中的站長帳號。HOST 保持127.0.0.1。
7. 重啟 API 與 worker：`npm start`、`npm run worker`。開發環境身分不能經公開入口使用；設定不完整會停止啟動。
8. `npm run build`、`npm run cf:check`、`npm run cf:deploy`。檢查與部署命令皆優先使用 `wrangler.local.jsonc`，不存在時使用通用設定。`cf:check` 僅打包與乾跑，可在尚未填妥正式登入設定時使用；實際部署仍要求正式登入與 VPC binding 設定。preview_urls 預設關閉，若日後開啟，亦須套相同 Access 限制。
9. 從手機行動網路驗證 Email 登入、私人清單、Origin、退出登入與斷線畫面。

API 缺乏 Access JWT 或本機 VPC 尚未設定時會拒絕，不會回退到本機開發帳號。VPC 需 cloudflared 2025.7.0+ 與 outbound UDP7844/QUIC；網路限制無法突破時應調整部署方案，不能改用公開開發模式或 Quick Tunnel 作替代。

`scripts/cloudflare-provision.ts` 可讀取自己的帳號資源並保存檢查結果至 `.cache`；只有明確傳入 `--apply` 才會建立本專案資源。它從 `.env` 讀取帳號與管理員名單，使用 `CLOUDFLARE_API_TOKEN` 或既有 Wrangler 登入，並依 XDG／APPDATA／使用者家目錄尋找設定，不含特定使用者的帳號或路徑。

Wrangler 登入成功不代表 OAuth 具備完整 Access 權限。本次設定曾出現 Access 列表空白，但控制台已有應用程式，且讀取該應用程式回傳 403。遇到這類情況應從 Cloudflare 控制台核對既有資源及權限，保留 `.cache/cloudflare-state.json` 中已確認的應用程式 ID；不要僅因 API 列表空白就重跑 `--apply` 或刪除狀態檔。需要 API 操作時，使用具備該操作所需 Access 權限的憑證。

## 日常使用

Windows 重啟後先啟動 Docker Desktop，再於專案目錄執行 `powershell -File scripts/start-services.ps1`。它會啟動資料庫、API、背景工作與已設定的 cloudflared，記錄在 `.cache`，重複執行不會啟動重複程序。需保留 `.env`、`wrangler.local.jsonc`、`.cache/cloudflare-state.json` 及 `.cache/zhiyu-tunnel-token.txt`，這些檔案不分享或提交 Git。可用 `scripts/start-local.ps1` 啟動本機開發預覽。此版本接受關機／睡眠停機，不更改 Windows 電源或安全設定。

增刪親友：同時更新 Access allow policy 與 ALLOWED_EMAILS，重啟 API。移除 ALLOWED_EMAILS 後即使舊 JWT 尚未到期也無法使用。帳號資料不自動刪除；私人清單可由本人在設定頁匯出／刪除。

## 備份與還原

在 `.env` 設定獨立 BACKUP_PASSPHRASE（至少16字元），執行 `npm run db:backup`。備份使用 PostgreSQL custom dump，再以 scrypt + AES-256-GCM 加密。備份與密語應分開保存於另一裝置。

`npm run db:restore -- <備份檔> zhiyu_restore_<名稱>` 只還原到全新資料庫，不清空正式資料。核對記錄筆數與清單後，站長可在停機時明確切換 DATABASE_URL。錯誤密語或損壞備份在建立還原 DB 前就會拒絕。

## 信任邊界

資料庫存在本機，Cloudflare 仍處理 TLS 與登入流量；這不是對主機管理者或 Cloudflare 的端到端隱藏。資料庫／備份含有私人資訊；不要公開資料卷、.env、備份或 PostgreSQL 埠。
