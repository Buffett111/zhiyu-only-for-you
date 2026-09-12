# 驗證紀錄

驗證日期：2026-09-13，Windows、Node.js 24、PostgreSQL 17。

## 已完成

- TypeScript 與 Vite 正式建置通過。
- 60 項測試通過，涵蓋 API、Access JWT、模組遷移、資料來源解析、工作去重與重啟補抓；資料庫測試使用隔離 schema。
- 真實資料源驗證：2330、0050、6488、00679B 最新行情日 2026-09-11；2026-08 各 21 個交易日（08-03 至 08-31）。
- 上市目錄 1,324 檔、上櫃目錄 1,011 檔；當日行情分別 1,320 與 1,005 筆。目錄筆數與有行情的筆數不必相同。
- 2330／6488 最新月營收為 2026-08、損益資料為 2026 年 Q2 累計；ETF 基本面標示不適用。
- CNA RSS 取得 40 個標題；官方日曆支援休市及特別開市標記。
- `npm run sync` 已完成一次完整實際同步，上市行情、上櫃行情、基本面與新聞四個來源狀態皆為 success。
- 390px 手機與 1440px 桌面瀏覽器完成新增、持有標記／分組修改、卡片排序／移除／加入、重新載入保存、CSV 匯出、清除確認與離線恢復；無 JavaScript 錯誤或橫向溢出。
- 所有 UI 測試使用的追蹤標的已移除，保留空白個人清單及預設版面。
- PostgreSQL 加密備份已還原到 `zhiyu_restore_verification_20260913`，核對 securities、quotes、fundamentals、news、users、watchlist、user_modules、digests 筆數一致。正式資料庫未被還原操作改動。

## 真實來源與隔離資料庫管線

`scripts/verify-pipeline.ts` 使用隨機 schema，排除 `public` 搜尋路徑，建立兩個暫存使用者；完成後刪除並確認該 schema 不存在。沒有讀寫正式使用者的私人清單。

| 驗證項目 | 實際結果 |
| --- | --- |
| 私人追蹤與共用抓取 | 2 個使用者、5 筆私人追蹤，共 4 個不同標的；基本面只以這 4 個標的的聯集抓取一次 |
| 股票目錄與行情 | 2,335 個目錄標的、2,325 筆最新行情、84 筆 2026-08 歷史行情，共 2,409 筆共用行情 |
| 財報與新聞 | 4 筆基本面：2 檔公司可用、2 檔 ETF 不適用；40 則新聞 |
| 重新啟動 | 4 個已完成的歷史月份全部跳過，未重抓或新增重複行情 |
| 每日摘要 | 重跑後仍只有 2 份摘要，各追蹤 3／2 檔，維持已讀狀態；每則個股項目均屬於該使用者的清單 |
| 清理 | 暫存 schema 已移除；正式資料未受測試改動 |

## 可重複執行

```powershell
npm test
npm run build
npm run sources:verify -- --month=2026-08
npm exec -- tsx --use-system-ca scripts/verify-pipeline.ts --month=2026-08
npm exec -- tsx scripts/qa-ui.ts
npm run cf:check
```

來源驗證是當時的真實結果，不保證外部服務之後永遠可用。TPEx 在驗證使用的 Windows 環境須啟用 Node 的 `--use-system-ca`，程式仍驗證 TLS 憑證。整合驗證曾遇兩次 TPEx socket 中斷，兩次皆記錄失敗並完成清理；後續完整驗證成功。相同 GET 的傳輸中斷最多立即重試一次且間隔至少 3 秒；HTTP 拒絕與 TLS 失敗不以此方式重試。

## Cloudflare 部署狀態

Worker 已完成部署；未登入存取 `/` 與 `/api/v1/bootstrap`，兩者皆回傳 HTTP 302 轉至 Access 登入，且使用 `Cache-Control: no-store`。這確認公開入口的登入保護已生效。

已通過 Email OTP 登入公開網站，讀取私人首頁；新增 TWSE 2330 至測試分組後，顯示 2026-09-11 收盤價 2,410 元，重新載入保留追蹤標的與分組，歷史行情回補進度已達 3 個月份。驗證完成後只移除該筆測試追蹤。直接呼叫本機 API，缺少 JWT 或使用偽造 JWT 均回傳 HTTP 401。

上述驗證涵蓋公開入口、Access 登入、本機 API 與資料庫的實際連線及清單新增／讀取／刪除；一年歷史資料是否完整仍以個股實際可取得的期間及回補進度為準。私人 binding 保留於被 Git 忽略的 `wrangler.local.jsonc`；公開程式庫不提供部署帳號、主機名稱或憑證，其他部署者仍須設定自己的帳號與網路。
