# 官方來源與資料邊界

查證日期：2026-09-12/13。實際 adapter URL 固定於 server/providers/index.ts，向外連線白名單位於 http.ts。沒有使用財報狗內部 API 或擷取其付費內容。

美股與日股候選、免費 API 額度、涵蓋範圍及待驗證項目，另見[國際資料來源調研](international-data-survey.md)；目前正式 adapter 仍為下列台股來源。

| 類型 | 來源 | 行為 |
| --- | --- | --- |
| 商品分類 | TWSE ISIN mode2/4、上市上櫃公司基本資料 | 按官方類別區分一般股票與ETF，保留前導零；略過權證、ETN及其他類型 |
| 收盤日行情 | TWSE STOCK_DAY_ALL；TPEx tpex_mainboard_daily_close_quotes | 日期取官方 Date，保留OHLC、股數、漲跌與來源 |
| 歷史日行情 | TWSE STOCK_DAY；TPEx tradingStock | 各股票、月份獨立補抓；最多最近13個月份涵蓋滚動一年 |
| 營收與損益 | TWSE/TPEx t187ap05、t187ap06 一般業 | 最新可得期別；單位新台幣千元、EPS元；季度標籤不等同單季數值，來源累計維持累計 |
| 重大訊息 | TWSE t187ap04_L；TPEx mopsfin_t187ap04_O | 公司代號精確匹配；附官方查詢連結 |
| 新聞 | 中央通訊社 finance/technology RSS | 只保留標題、日期、來源、原文連結；不抓全文或圖片 |
| 交易日曆 | TWSE holidaySchedule | 使用官方標示之年份；缺年資料時不推定節假日 |

TWSE歷史查詢：https://www.twse.com.tw/zh/trading/historical/stock-day.html

TPEx歷史查詢：https://www.tpex.org.tw/zh-tw/mainboard/trading/info/stock-pricing.html

政府開放資料顯名授權：https://data.gov.tw/license

中央社允許個人／非營利組織非商業用途之RSS：https://www.cna.com.tw/about/rss.aspx 。本專案依此作為私人親友非商業站；若對外商業化，先重新確認授權。

## 顯示規則

- 價格為盤後、未還原價格，不是即時報價或含息總報酬。
- 上櫃歷史來源的「成交張數」乘1000轉為股數，有來源的千股精度；最新快照TradingShares是股數。不能用較粗歷史資料覆蓋精確快照。
- ETF 的公司 EPS、月營收不適用；金融業與不支援的特殊財報不硬套一般業公式。
- 缺值不寫成0。官方无成交／停牌與同步失敗維持不同狀態。
- 台股單日漲跌使用官方漲跌欄位；不拿未還原前後價格直接推算除權息或拆分當日報酬。
- 一年回補不保證每檔都有一年。新掛牌、來源缺口與限流會顯示實際資料期間。
- RSS／每日重大訊息只提供有限近況；停機期間已消失的消息無法保證回補。
- 新聞依名稱／確認別名精確匹配；公司名碰撞時避免關聯錯誤。未匹配消息不能推定與持股有關。

## 來源保護

每個host單工與至少3秒請求間距；20秒timeout；有限response size；只允許固定官方HTTPS目的地，不允許使用者提供URL。403/429尊重Retry-After並暫停該host；不換IP或繞過阻擋。背景狀態保留最後成功日期與錯誤，不把旧資料說成已更新。
