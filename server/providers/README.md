# 官方資料介接

首次驗證：2026-09-12（台北時間）。資料僅透過核准的 HTTPS 端點讀取；不爬取財報狗，不使用未授權即時報價。

Node 整合驗證已於 **2026-09-13 00:14 台北時間** 通過：TWSE 1,324 個有效目錄標的／1,320 筆行情；TPEx 1,011 個目錄標的／1,005 筆行情，資料日均為 2026-09-11。四個樣本最新日與八月各 21 筆歷史行情全部通過；2330、6488 最新月營收與累計季報可用，兩檔 ETF 正確不適用；CNA 兩來源共 40 則標題；交易日曆 24 個休市標記及 3 個特別開市標記。所有來源警示為空。

重跑：`npm exec -- tsx --use-system-ca scripts/verify-sources.ts --month=2026-08`。本機 Node 內建 CA 清單無法驗證 TPEx 的憑證鏈，而 Windows 系統信任庫可驗證；啟動旗標 `--use-system-ca` 使用系統憑證並維持 TLS 驗證。未使用 `NODE_TLS_REJECT_UNAUTHORIZED=0`、略過驗證或改用 HTTP。

隔離資料庫整合驗證亦於 **2026-09-13 00:24 台北時間** 通過：`npm exec -- tsx --use-system-ca scripts/verify-pipeline.ts --month=2026-08`。兩個暫存使用者有 5 筆私人追蹤、4 個共同市場標的；2,325 筆最新行情加 84 筆歷史行情共用儲存。重新啟動跳過已完成的 4 個歷史月份；每日摘要重跑後仍只有每人一份，已讀狀態與使用者資料隔離均通過。測試使用獨立隨機 schema，完成後確認刪除；未改動應用程式資料。執行前兩次曾遇 TPEx socket 中斷，測試如實失敗並清理，第三次完整成功。

|資料|來源與驗證結果|
|---|---|
|上市最新行情|TWSE OpenAPI `/v1/exchangeReport/STOCK_DAY_ALL`，實際樣本含 ROC `Date=1150911`、`Code`、`TradeVolume`、OHLC、`Change`。|
|上櫃最新行情|TPEx OpenAPI **`/openapi/v1`** `/tpex_mainboard_daily_close_quotes`，樣本含 `Date=1150911`、`SecuritiesCompanyCode`、`TradingShares`、OHLC。舊的省略 `/v1` 路徑回傳 404，不使用。|
|商品分類|TWSE ISIN `C_public.jsp?strMode=2`（上市）及 `strMode=4`（上櫃），Big5 編碼，依「股票」「創新板」「ETF」類別，排除權證、ETN、特別股、TDR、REIT。創新板的市場欄為「上市臺灣創新板」。已核對 2330、0050、6488、00679B。舊 JSP 刻意未加 `</html>`，以實際結尾「掛牌日以正式公告為準」及結束 table 檢查完整性。|
|公司與別名|TWSE `t187ap03_L`、TPEx `mopsfin_t187ap03_O`。只保留官方簡稱、全名、移除公司法律後綴後的名稱；群組同名不作為個股匹配證據。|
|月營收|TWSE `t187ap05_L`、TPEx `mopsfin_t187ap05_O`。實際樣本 `資料年月=11508`，營收單位千元。|
|一般業損益表|TWSE `t187ap06_L_ci`、TPEx `mopsfin_t187ap06_O_ci`。樣本年度 115、季別 2，EPS/比率是 1–6 月累計，不能稱作單季。ETF 不適用，金融業暫不支援。|
|公司重大訊息|TWSE `t187ap04_L`、TPEx `mopsfin_t187ap04_O`；使用發言日期與台北時間，依交易所和公司代號匹配。連結指向實際官方資料來源。只存標題，不儲存全文說明。|
|CNA 新聞|[中央社官方 RSS 頁](https://www.cna.com.tw/about/rss.aspx)列出的 finance / technology FeedBurner RSS 均已讀取驗證。只保留標題、原文 URL、發稿時間並註明「中央通訊社」；限目前個人／親友的非商業使用範圍。|
|交易日曆|TWSE `/v1/holidaySchedule/holidaySchedule`，驗證了目前年度開休市標記。最後交易日／開始交易日不是休市日。來源不提供指定年查詢，其他年度明確回報缺口。|

## 歷史資料驗證

已對 2026 年 8 月的四個商品類型各執行一次官方查詢，全部成功且日期欄為 ROC 日期：

- 上市股票 2330、上市 ETF 0050：`https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY`，`date=20260801`，各 21 個交易日。
- 上櫃股票 6488、上櫃 ETF 00679B：`https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock`，`date=2026/08/01`，成功回傳月資料表。
- TWSE 歷史量是「成交股數」；**TPEx 歷史量是「成交張數」，轉成股數時乘 1,000，仍受原始張數精度限制**。TPEx 最新行情的 `TradingShares` 則已是股數。
- 價格皆未還原，不是含息總報酬。掛牌前／來源無資料的月份保留缺口；不填造交易日、成交量或價格。

## 流量與錯誤語義

同一主機一次一請求，完成後至少間隔 3 秒，每次 20 秒逾時，上限 20 MiB。禁止重導向。僅遇 socket 中斷／連線重設時，對原本相同的 GET 做一次間隔 3 秒的重試，並記錄主機與錯誤代碼。403 暫停該主機至少一小時；429 至少一分鐘並尊重更長的 `Retry-After`。HTTP 拒絕與 TLS 驗證失敗不立即重試；不輪替代理、不改網址繞過存取限制。

商品分類或行情日期不可驗證時，市場同步失敗而非寫入推定資料。歷史行情網路／解析錯誤會拋出供工作佇列有限重試；官方明確查無資料則回傳空值與警示。新聞、財報各來源錯誤記錄在 `warnings`，其他已成功來源仍可保存。新聞 RSS 與每日公告只覆蓋來源當下提供的窗口，長時間停機後不能宣稱完整補回所有消息。

非商業條件和資料授權應在擴大使用範圍時重新檢查：[TWSE OpenAPI](https://openapi.twse.com.tw/)、[TPEx OpenAPI](https://www.tpex.org.tw/openapi/)、[CNA RSS 使用規範](https://www.cna.com.tw/about/rss.aspx)。

