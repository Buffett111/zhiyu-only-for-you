# 架構與擴充契約

## 執行程序

- `web/`：React + Vite，Traditional Chinese responsive dashboard。所有私人資料僅存於目前頁面記憶體，沒有 localStorage 或 Service Worker 快取。
- `server/app.ts`：Fastify `/api/v1`，透過已驗證身分查詢私人資料。
- `server/worker.ts`：pg-boss 持久佇列與 Taipei 排程。和 API 共用 DB，但可獨立停止或重新啟動。
- `server/providers/`：台股官方來源與 Yahoo 美日來源各自的固定白名單、解析、交易日／數值單位正規化。
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

市場 Security ID 採 `TWSE:0050` / `TPEx:6488` / `NASDAQ:AAPL` / `TSE:7203`，不能把 symbol 當數字。`shared/markets.ts` 分開國別、交易所、幣別及 IANA 時區；東京的 `.T` 是 Yahoo adapter 格式，不混入內部代號。行情、公司資料及新聞是共用資料；watchlist、user_modules、digests 皆有 user_id 並以已驗證身分查詢。

Access JWT 驗证 issuer、audience、RS256 簽章、有效期與 email 邀請名單。不信任 email header 或 request body 裡的 userId。POST/PUT/DELETE 檢查 Origin + JSON Content-Type。私人 API 一律 `private, no-store`。管理員權限明確由 ADMIN_EMAILS 指定。

## 排程與復原

- 16:30 工作日讀官方行情，以官方交易日期及休市表核對，不把平日一概當已開市。
- 每小時新聞與重大訊息。
- 每小時第 10 分鐘檢查美日收盤；新增追蹤或重啟也可觸發。已抓取的市場交易日及最近嘗試時間由 PostgreSQL 去重，跨使用者只抓一次。
- 國際行情依各市場交易日期保存，20:30 摘要採當時已完成的市場交易日，隔天補抓不會將較晚美股收盤倒填成前一個台北晚間的行情。
- 每日 20:30 重新核對行情、財報與新聞，寫入每日摘要。
- 重啟只補最新應有摘要；資料來源可重試，history_progress 避免完整月份重抓。
- 每來源及月份有 PostgreSQL advisory lock；同股票共用行情；每位使用者＋摘要日期唯一。
- 停機遺漏的 RSS／即時公告不保證可完整回補；已取得資料與實際來源日期保持可見。

## API 概覽

`GET /api/v1/bootstrap` 返回用戶、模組、清單、摘要、来源狀態。核心路由 `/me`、`/modules/:id`、`/sources`。財經路由 `/finance/securities`、`/finance/securities/:id/history`、`/finance/watchlist/:id`、`/finance/news`、`/finance/digests`、`/finance/export.csv`。管理員 `/admin/sync` 僅入佇列。完整回應型別在 shared/types.ts。

搜尋為 `/api/v1/finance/securities?region=TW|US|JP&q=...`；省略 region 預設 TW，維持舊客戶端相容。國際搜尋只在非空查詢時呼叫來源，10 分鐘快取。002 遷移擴充市場並強制市場與幣別一致；財經模組升為 1.1.0，configVersion 維持 1，既有清單及卡片設定不重置。

## 財報、新聞與按需內容（1.2.0）

003 遷移加入 `financial_reports` 與 `content_progress`。`server/content-jobs.ts` 對已啟用追蹤聯集依種類檢查冷卻時間，單一資料庫鎖避免 API 觸發、排程及重啟重複抓取。既有 international.sync、news.sync 及摘要流程會呼叫它，不增加公開服務或帳戶需求。

報表主鍵為股票、期末日、quarter／annual；JSON 保留報告幣別、三表選定欄位及來源。`observed_at` 只在數值變更時更新，`fetched_at` 表示最近擷取，避免每日重抓相同財報被誤報成新財報。

國際搜尋不寫資料庫；加入清單才將已驗證、尚未過期的候選保存。`SecurityDetail` 新增可選的 financialReports／contentStatus；舊回應欄位保持相容。財經設定新增可選 translationTarget（zh-TW／en／ja），configVersion 仍為 1，舊帳號預設繁中。

翻譯入口由 `shared/translation.ts` 建立，前端只在點擊後開啟外部譯文。資料庫不保存翻譯全文。市場快取清理由 `pruneMarketCache` 執行，期限見資料來源文件；不刪除私人清單、設定或摘要。

長期分析修正：財報視為長期保存的結構化資料，取消每檔 5 季／3 年截斷及無人追蹤 30 天刪除；來源只回傳近期資料時，既存較早期別維持不變。Yahoo 每次查詢近十年且保存所有可得期別，實際不足十年時明確顯示涵蓋區間；仍僅抓取啟用追蹤聯集。此修改沿用 003 結構與既有設定，無須資料庫遷移。未保存到的舊資料無法僅靠修改保留規則恢復。

## 十年股價與較長歷史請求（1.3.0）

004 遷移新增 `history_targets` 及官方上市日期 `securities.listed_at`。新舊清單預設回補近十年，已保存股價不再由快取清理刪除；取消追蹤仍停止擷取。台股以 121 個月份涵蓋滾動十年，跳過官方已知上市日期之前的月份及已完成月份；空缺月份最多每七天再試。Yahoo 一次更新請求區間，既有近期一年資料不能阻止首次十年擴展，失敗仍保留舊行情與有限重試。

`GET /api/v1/finance/securities/:id/history?range=10y` 預設十年，也接受 `1m`、`3m`、`1y`、`3y`、`5y`、`20y`。它只讀資料庫，回傳實際涵蓋期間與缺項狀態，不因瀏覽而啟動下載。

`POST /api/v1/finance/securities/:id/history/request` 接受 JSON `{"years":20}`（允許 5、10、20）。使用者須通過登入、啟用財經模組，且該股票存在自己的追蹤清單。請求目標持久保存、只擴大既有目標，排入去重佇列；重啟後沿用，同股票的公開市場資料共用。此端點不接受任意來源 URL。取得較早資料後可用 `range=20y` 查詢，來源缺項不承諾補齊。

前端新增三、五、十年切換，預設十年；設定版本仍為 1，不重置既有模組卡片與私人清單。股票日線與財報的可取得期間分開顯示，十年股價不代表有十年財報。

## ETF 關聯消息（1.4.0）

005 遷移新增 `etf_holdings`，保存按需取得的官方持股快照與最後嘗試／成功時間。既有新聞排程展開成分股目錄，只用於新聞與公司公告配對，不改私人清單及行情排程。持股成功後每天檢查，失敗每小時重試，舊快照仍可查看。

NewsItem 新增可選 `relations`，按 ETF 記錄 direct／constituent／market，成分股關聯另帶公司名稱、持股日期及來源。跨使用者共用文章保留既有關聯；舊新聞未帶 relations 仍相容。`GET /api/v1/finance/news` 新增可選 `scope=all|direct|constituent|market`，在查詢上限之前篩選，省略維持原本全部結果；無 securityId 時仍限定本人追蹤聯集。單檔回應新增可選 etfContext，揭露持股与基金公告接入範圍。設定版本維持 1，模組升級不重置卡片與清單。
