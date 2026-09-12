# 資料來源與資料邊界

查證日期：2026-09-12/13。實際 adapter URL 固定於 server/providers/index.ts，向外連線白名單位於 http.ts。沒有使用財報狗內部 API 或擷取其付費內容。

美股與日股已接入 `server/providers/yahoo.ts`，使用 `yahoo-finance2@4.0.2` 的 search 與 chart；無須金鑰。其他免費 API 候選、涵蓋範圍及待驗證項目，另見[國際資料來源調研](international-data-survey.md)。

| 類型 | 來源 | 行為 |
| --- | --- | --- |
| 商品分類 | TWSE ISIN mode2/4、上市上櫃公司基本資料 | 按官方類別區分一般股票與ETF，保留前導零；略過權證、ETN及其他類型 |
| 收盤日行情 | TWSE STOCK_DAY_ALL；TPEx tpex_mainboard_daily_close_quotes | 日期取官方 Date，保留OHLC、股數、漲跌與來源 |
| 歷史日行情 | TWSE STOCK_DAY；TPEx tradingStock | 各股票、月份獨立補抓；最多最近13個月份涵蓋滚動一年 |
| 營收與損益 | TWSE/TPEx t187ap05、t187ap06 一般業 | 最新可得期別；單位新台幣千元、EPS元；季度標籤不等同單季數值，來源累計維持累計 |
| 重大訊息 | TWSE t187ap04_L；TPEx mopsfin_t187ap04_O | 公司代號精確匹配；附官方查詢連結 |
| 新聞 | 中央通訊社 finance/technology RSS | 只保留標題、日期、來源、原文連結；不抓全文或圖片 |
| 交易日曆 | TWSE holidaySchedule | 使用官方標示之年份；缺年資料時不推定節假日 |
| 美日搜尋與日線 | Yahoo Finance，透過 yahoo-finance2 | 僅股票與 ETF，按市場篩選；東京代號附 `.T`，幣別 USD／JPY；共用抓取已啟用模組使用者追蹤標的的聯集 |

TWSE歷史查詢：https://www.twse.com.tw/zh/trading/historical/stock-day.html

TPEx歷史查詢：https://www.tpex.org.tw/zh-tw/mainboard/trading/info/stock-pricing.html

政府開放資料顯名授權：https://data.gov.tw/license

中央社允許個人／非營利組織非商業用途之RSS：https://www.cna.com.tw/about/rss.aspx 。本專案依此作為私人親友非商業站；若對外商業化，先重新確認授權。

## 顯示規則

- 價格為盤後，非即時報價或含息總報酬。台股未還原；Yahoo Close 採拆股調整，不以 Adj Close 代替。每次原子更新一年的區間，避免區間內混用不同拆股基準。
- 美日依紐約／東京交易日期處理；當日日線須有已結束的交易時段及至少 30 分鐘緩衝。預期交易日依平日及市場時區判斷，美國夏令時間由 IANA 時區處理；尚無完整美日休市日曆，缺資料不自動判為休市。
- Yahoo 原始日線相鄰價格若超過四倍或低於四分之一，保留原價、標示品質疑點並不計算該日漲跌。這是異常提醒，不能證明所有其他價格正確，也不自動猜測拆股修正值。
- 上櫃歷史來源的「成交張數」乘1000轉為股數，有來源的千股精度；最新快照TradingShares是股數。不能用較粗歷史資料覆蓋精確快照。
- ETF 的公司 EPS、月營收不適用；金融業與不支援的特殊財報不硬套一般業公式。
- 缺值不寫成0。官方无成交／停牌與同步失敗維持不同狀態。
- 台股單日漲跌使用官方漲跌欄位；不拿未還原前後價格直接推算除權息或拆分當日報酬。
- 一年回補不保證每檔都有一年。新掛牌、來源缺口與限流會顯示實際資料期間。
- RSS／每日重大訊息只提供有限近況；停機期間已消失的消息無法保證回補。
- 新聞依名稱／確認別名精確匹配；公司名碰撞時避免關聯錯誤。未匹配消息不能推定與持股有關。

## 來源保護

每個host單工與至少3秒請求間距；20秒timeout；有限response size；只允許固定官方HTTPS目的地，不允許使用者提供URL。403/429尊重Retry-After並暫停該host；不換IP或繞過阻擋。背景狀態保留最後成功日期與錯誤，不把旧資料說成已更新。

Yahoo 另用每程序單工佇列、至少 3 秒間隔、20 秒 timeout、8 MB 上限及固定 Yahoo HTTPS 主機名單；401/403/429 暫停，搜尋快取 10 分鐘，相同標的嘗試至少間隔一小時。API 與背景工作為不同程序，這不是跨程序的全域限流器；適用少量個人追蹤。套件的 cookie／crumb 不寫入日誌或公開檔案。美日財報與新聞不使用台股來源冒充。

Yahoo 是非官方介接，並無本案使用的服務交付保證。[套件說明](https://github.com/gadicc/yahoo-finance2)及[Yahoo 條款](https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html)需與軟體授權分別看待；目前作個人試用，商業化前再確認資料展示及轉送權利。
