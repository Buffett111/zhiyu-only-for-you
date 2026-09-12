# 架構與擴充契約

## 執行程序

- `web/`：React + Vite，Traditional Chinese responsive dashboard。所有私人資料僅存於目前頁面記憶體，沒有 localStorage 或 Service Worker 快取。
- `server/app.ts`：Fastify `/api/v1`，透過已驗證身分查詢私人資料。
- `server/worker.ts`：pg-boss 持久佇列與 Taipei 排程。和 API 共用 DB，但可獨立停止或重新啟動。
- `server/providers/`：官方來源固定白名單、解析、ROC 日期／數值單位正規化。
- `edge/worker.ts`：靜態前端與狹窄 API 轉送器；只可透過指定 VPC Service 連到 localhost:3001。
- PostgreSQL：業務表、財報版本、行情、工作進度與 pg-boss 佇列；Docker 僅綁定本機 54329。

## 模組

`shared/modules.ts` 註冊受信任的編譯期模組。每個 module 定義 id、version、configVersion、widgets、routes、jobs。`user_modules` 保存個別用戶的 enabled/config/widgets。停用模組不刪除私人清單，排程只處理 active users + enabled finance 的追蹤聯集。

新增模組時：

1. 定義共用型別與 manifest、設定驗證和版本遷移。
2. 新增模組 API 與獨立業務表，透過 session 的 user ID 做 ownership 查詢。
3. 在前端註冊卡片與入口。
4. 需要背景更新時，註冊具冪等鍵的 pg-boss 工作。
5. 加上舊設定升級、停用保留資料、跨帳號無法讀寫的測試。

未知未來 configVersion 必須拒絕，不應靜默重設使用者配置。資料庫遷移放在 server/migrations，按檔名順序與 advisory lock 執行。

## 資料與權限

市場 Security ID 採 `TWSE:0050` / `TPEx:6488`，不能把 symbol 當數字。行情、公司資料及新聞是共用資料；watchlist、user_modules、digests 皆有 user_id 並以已驗證身分查詢。

Access JWT 驗证 issuer、audience、RS256 簽章、有效期與 email 邀請名單。不信任 email header 或 request body 裡的 userId。POST/PUT/DELETE 檢查 Origin + JSON Content-Type。私人 API 一律 `private, no-store`。管理員權限明確由 ADMIN_EMAILS 指定。

## 排程與復原

- 16:30 工作日讀官方行情，以官方交易日期及休市表核對，不把平日一概當已開市。
- 每小時新聞與重大訊息。
- 每日 20:30 重新核對行情、財報與新聞，寫入每日摘要。
- 重啟只補最新應有摘要；資料來源可重試，history_progress 避免完整月份重抓。
- 每來源及月份有 PostgreSQL advisory lock；同股票共用行情；每位使用者＋摘要日期唯一。
- 停機遺漏的 RSS／即時公告不保證可完整回補；已取得資料與實際來源日期保持可見。

## API 概覽

`GET /api/v1/bootstrap` 返回用戶、模組、清單、摘要、来源狀態。核心路由 `/me`、`/modules/:id`、`/sources`。財經路由 `/finance/securities`、`/finance/securities/:id/history`、`/finance/watchlist/:id`、`/finance/news`、`/finance/digests`、`/finance/export.csv`。管理員 `/admin/sync` 僅入佇列。完整回應型別在 shared/types.ts。
