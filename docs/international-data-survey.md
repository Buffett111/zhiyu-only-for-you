# 美股、日股免費資料來源調研

查證日期：2026-09-13。目標是個人網站、少量追蹤標的、收盤資料優先，避免讓每位使用者付費或申請金鑰。

依使用者決定，現已試用 **yahoo-finance2** 接入美股、日股搜尋與收盤日線，不需要新帳戶、API key 或訂閱。AAPL、SPY、7203.T、1306.T 已通過真實資料與隔離資料庫管線驗證；其他供應商仍為文件調研，未做全面價格交叉核對。以下比較保留供之後更換來源參考。

實測也發現來源品質限制：1306.T 在 2026-03-30、03-31 的 Yahoo 歷史價約為前後交易日的十分之一。發行商公告確認 2026-04-01 生效的 1 拆 10，時間相近，但未據此擅自改寫價格。網站保留來源原值，對大幅跳點顯示待核對提示，異常邊界日不計算漲跌。[NEXT FUNDS 官方分割公告](https://nextfunds.jp/news/2026/pd_260330a.html)

## 原調研候選與後續方向

- **美股行情：優先實測 Massive Stocks Basic 免費版**，適合少量標的的收盤與歷史日線；Alpaca、Alpha Vantage 為備選。先驗證站長個人使用，不能把個人方案直接視為親友共用資料授權。
- **美股財報／申報：優先 SEC EDGAR 官方 API**，免費且不用金鑰；不必為公開申報資料額外購買聚合服務。
- **日股歷史：J-Quants Free 是清楚可用的官方選項**，但排除最近 12 週，無法支援最新收盤追蹤。
- **日股財報／申報：優先研究金融廳 EDINET API v2**。它補足基本面與文件來源，不能代替股價，也不等於所有即時重大訊息。
- **日股最新價格：本次尚未確認兼具免費、正式 API、可供親友共用的來源**。保留 Yahoo／yfinance 作個人研究候選，但不能承諾它是有穩定交付保證的正式免費 API。

這個排序依據下列文件與本案需求推導；沒有以「免費」推論低品質，也沒有以「資料可下載」推論可任意轉送。未收費的親友網站仍可能落在供應商的第三方展示範圍。

## 美股價格與歷史

| 來源 | 免費功能與額度 | 適合程度及已知限制 |
| --- | --- | --- |
| **Massive（原 Polygon）Stocks Basic** | 美國股票 EOD；2 年歷史；5 次／分鐘；需 key。Custom Bars 端點明列 Basic 可用 | 個人收盤追蹤首選實測。免費不含 snapshot、逐筆成交／報價與 Flat Files；收盤更新時點仍需實測。[方案](https://www.massive.com/stocks)、[日線端點](https://massive.com/docs/rest/stocks/aggregates/custom-bars) |
| **Alpaca Basic** | 200 次／分鐘、歷史自 2016 年；免費即時為 IEX；需帳戶與 key | IEX 是部分市場，不應把其成交量當成全美市場量。官方歷史資料 FAQ 與 Paper Only 說明對 SIP 權利有落差，不能保證新免費帳戶可用延遲 SIP。[資料方案](https://docs.alpaca.markets/us/docs/about-market-data-api)、[FAQ](https://docs.alpaca.markets/us/docs/market-data-faq)、[Paper Trading](https://docs.alpaca.markets/us/docs/paper-trading) |
| **Alpha Vantage** | 25 次／日；免費日線 compact 為最近 100 筆；需 key | 少量標的可行，但約一年日線不能只靠 100 筆；full 歷史與美股即時／15 分鐘延遲方案有付費限制。日本本地掛牌覆蓋未驗證。[免費額度](https://www.alphavantage.co/support/)、[端點文件](https://www.alphavantage.co/documentation/) |
| **Twelve Data Basic** | 8 credits／分鐘、800／日；需 key | 額度看似足夠，但官方標示內部非展示用途，需逐項核對端點、feed 與使用方式。東京頁不能證明免費日本日線可用。[方案](https://twelvedata.com/pricing)、[東京資料集](https://twelvedata.com/exchanges/xjpx) |
| **EODHD Free** | 20 次／日、1 年歷史；免費範圍限美國交易所；需 key | 可作小型美股收盤測試，不列為已驗證的免費日股來源。[免費範圍](https://eodhd.com/)、[demo 限制](https://eodhd.com/financial-apis/quick-start-with-our-financial-data-apis) |
| **Marketstack Free** | 100 次／月、1 年 EOD、HTTPS、非商業用途；需 key | 額度較小；每個 symbol 個別消耗額度，合併請求不代表只算一次。東京股票是否在免費 EOD 權限內尚未證實。[方案](https://marketstack.com/pricing)、[計次規則](https://marketstack.com/faq) |
| **Tiingo Starter** | EOD 歷史；500 個代號／月、50 次／小時、1,000 次／日、1GB／月；歷史最長 30 年以上，依標的而異；需 key | 有用的個人查詢候選，但免費條款禁止永久存檔，只允許暫時記憶體／非持久快取；無法直接套用本站 PostgreSQL 累積歷史。[方案](https://www.tiingo.com/about/pricing)、[EOD 文件](https://www.tiingo.com/documentation/end-of-day)、[保存規範](https://api.tiingo.com/tos/) |
| **Finnhub Free** | 最新價格 `/quote` 與股票目錄；quote 不含成交量；需 key | 歷史 `/stock/candle` 為 Premium，不能獨自完成一年 OHLCV。常見的 60 次／分鐘僅找到廠商舊答覆，本次未從現行方案頁重驗；quote 的完整市場 feed 也未確認。[文件](https://finnhub.io/docs/api/quote)、[舊額度答覆](https://github.com/finnhubio/Finnhub-API/issues/122) |
| **FMP Basic** | 250 次／日、500MB／30 日；方案表列 5 年歷史；需 key | Chart Light／OHLCV 等多個端點限 AAPL、TSLA、AMZN 加 84 檔，不能推論任意股票免費；展示／轉送另有協議要求。適合有限原型。[逐項方案權限](https://site.financialmodelingprep.com/developer/docs/pricing)、[EOD 端點](https://site.financialmodelingprep.com/developer/docs/stable/historical-price-eod-light) |

Massive 的 `adjusted=true` 預設值代表拆股調整，不包含股息；`adjusted=false` 才能按其規格解讀為未還原。免費個人條款允許自身非商業展示；本次未核實親友共用與永久資料庫保存的具體範圍。不能把沒有找到明文禁止，寫成已取得所有用途授權。[欄位定義](https://massive.com/docs/rest/stocks/aggregates/custom-bars)、[市場資料條款](https://massive.com/legal/market-data-terms-of-service)

Marketstack FAQ 同時出現 1,000 與 100 次／月的文字，本案採現行價格表的 **100 次**。以每月 22 個交易日、每檔每天 1 次計算，4 檔需要 88 次，5 檔需要 110 次，尚未計入搜尋、回補與重試；因此不適合大量每日追蹤。[價格表](https://marketstack.com/pricing)、[FAQ](https://marketstack.com/faq)

Alpaca 可建立 Paper Only 帳戶，不必開立真實交易帳戶或入金，但其官方說明限制 API 資料再散布；Finnhub 的個人條款亦限制向第三方提供資料或衍生結果。免費帳戶可用性與親友共用權利要分開核對。[Alpaca 帳戶](https://docs.alpaca.markets/us/docs/paper-trading)、[Alpaca 再散布](https://alpaca.markets/support/redistribute-alpaca-api)、[Finnhub 條款](https://finnhub.io/terms-of-service)

## 日股價格與歷史

| 來源 | 日股實際範圍 | 本案判斷 |
| --- | --- | --- |
| **JPX J-Quants Free** | 東證日 OHLC、量與財務摘要；2 年歷史但排除最近 **12 週**；5 次／分鐘；需 key | 適合歷史研究；畫面必須呈現真正資料日期，不能稱為最新收盤。[官方方案](https://jpx-jquants.com/en)、[日線規格](https://jpx-jquants.com/en/spec/eq-bars-daily) |
| **Yahoo Finance／yfinance** | Yahoo 官方覆蓋表列東京 `.T`、20 分鐘延遲；社群工具提供歷史資料介接 | 非官方 API，無 Yahoo API 交付保證；技術上可列個人研究候選，不能直接沿用到親友共用網站。[Yahoo 覆蓋與限制](https://help.yahoo.com/kb/SLN2310.html)、[yfinance 專案](https://github.com/ranaroussi/yfinance) |
| **Alpha Vantage** | 官網有 global equities 說明，但本次沒有找到明確的東京市場支援表或日本代號例子 | 未驗證；不得自行假設 `7203.T` 可用，也不能以 Toyota 美股 ADR 當作日股原股。[文件](https://www.alphavantage.co/documentation/) |
| **Twelve Data** | 東京頁列 Pro+／Venture+，目前列出的端點為名錄、基本面、分析，沒有 `/quote` 或 `/time_series`；Delay 為「—」 | 即使頁面有 Toyota 試用標的，也不證明有東京 OHLC；不能推薦為已確認的免費日股行情。[東京頁](https://twelvedata.com/exchanges/xjpx) |
| **EODHD／Marketstack** | EODHD 免費限定美國；Marketstack 全球宣傳不等同免費東京行情權限 | 前者不符合免費日股；後者保留待驗證。[EODHD](https://eodhd.com/)、[Marketstack](https://marketstack.com/pricing) |

J-Quants 的個人服務不允許向第三方提供原始資料或持續提供資料分析，即使非商業也有限制。它允許某些每人自行訂閱、各自使用的應用，但明文不允許營運者伺服器代存／轉送；因此「把每人的 key 放到本站共用後端」不能直接解決問題。單一站長本人使用和親友共用應分開評估。[使用 FAQ](https://jpx-jquants.com/en/help/usage)

付費資訊僅作差異說明，不是本階段採購建議：J-Quants Light 為含稅 ¥1,650／月、5 年歷史、60 次／分鐘，可取得近期資料；日線約 16:30 日本時間更新但不保證準時，資料更正會覆寫舊值。付費個人方案仍不等於多人展示授權。[方案](https://jpx-jquants.com/en)、[更新與更正](https://jpx-jquants.com/en/spec/data-update)

另一條官方路徑是 **三菱 UFJ eSmart 的 kabuステーション API**：Professional／Premium 符合条件時免費，但需要日本券商帳戶，開戶不接受非日本居民；後續方案資格包含帳戶及成交條件。API 需同一台 Windows 電腦保持終端登入，可取當日行情，沒有確認可回補一年日線的端點。再配信、共同使用與跨終端轉載另有限制，因此只列為已有合資格帳戶者的同機個人選項，不符合本站低負擔、跨裝置共用目標。[API 與免費条件](https://kabu.com/item/kabustation_api/default.html)、[方案條件](https://kabu.com/tool/kabustation/default.html)、[開戶資格](https://kabu.com/apply/flow/kojinflow-bk.html)、[執行 FAQ](https://kabucom.github.io/kabusapi/ptal/faq.html)、[使用規定](https://kabu.com/pdf/Gmkpdf/service/kabustationapiuserpolicy.pdf)

## 免費官方財報與申報資料

| 市場／來源 | 能取得什麼 | 金鑰、更新與整合注意 |
| --- | --- | --- |
| **美國 SEC EDGAR** | 公司提交文件、10-K／10-Q 等申報、XBRL companyfacts／companyconcept | 公開資料 API 無需帳戶或 key；隨申報更新，有夜間批次檔；不提供股票價格。[官方 API](https://www.sec.gov/search-filings/edgar-application-programming-interfaces) |
| **日本金融廳 EDINET v2** | 按日申報清單、文件與 XBRL，包含法定財務申報 | 需註冊並取得 key，沒有列訂閱費；v2 規格於 2026 年 6 月更新。不能替代最新股價或完整即時重大訊息。[官方說明](https://disclosure2.edinet-fsa.go.jp/week0020.aspx)、[v2 規格](https://disclosure2dl.edinet-fsa.go.jp/guide/static/disclosure/download/ESE140206.pdf) |

SEC 限制所有機器合計每使用者最多 10 次／秒，需可識別的 User-Agent，且不支援前端 CORS；應由後端低頻抓取並處理同一申報的單位、期間及更正版本。這比由每個瀏覽器重複呼叫適合本案。[開發者規範](https://www.sec.gov/about/developer-resources)、[API 格式與期間](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)

EDINET 現行條款引用 PDL1.0，要求出處與加工標示，另有第三方權利及排除項目；自動取得 API 已提供的資料應使用 API。官方沒有在此次可讀條款中承諾固定數字的呼叫額度，不能寫成無限量。應保守限速、避免短時間大量存取，並追蹤更正與撤回。[利用規約](https://disclosure2dl.edinet-fsa.go.jp/guide/static/disclosure/WZEK0030.html)、[政府對公開閱覽及 API 的說明](https://www.fsa.go.jp/common/budget/kourituka/03_h31/process/03_r01_08.pdf)

## Yahoo、Stooq、Nasdaq Data Link 的位置

- **Yahoo／yfinance**：程式開源不代表資料也同樣開放。Yahoo 明示不可再散布其財經資料；yfinance 說明自身非官方、主要供研究與教育，資料使用仍依 Yahoo 條款。Yahoo 網頁行情延遲不等同社群介面的 SLA。[Yahoo](https://help.yahoo.com/kb/SLN2310.html)、[yfinance](https://github.com/ranaroussi/yfinance)
- **價格調整不能混淆**：Yahoo 歷史頁的 Close 已包含拆股調整，Adj Close 再包含股息／資本利得分配；因此 yfinance 的 `auto_adjust=False` 仍不能直接標成「未還原價格」。其 `history()` 預設 `auto_adjust=True`，整合前須明確設定與記錄。[歷史欄位](https://finance.yahoo.com/quote/AMZN/history/)、[工具文件](https://ranaroussi.github.io/yfinance/reference/yfinance.price_history.html)
- **Yahoo 官方 CSV**：瀏覽器下載目前需要 Gold，不能把 yfinance 的非官方取用方式說成 Yahoo 提供免費正式 CSV API。[下載說明](https://help.yahoo.com/kb/account/download-historical-data-yahoo-finance-sln2311.html)
- **Stooq**：官方頁在本次查核出現 JavaScript 驗證，因此未完成現行接口、日股覆蓋、價格調整方式與使用條件查證；沒有繞過驗證，不列為已驗證可用來源。[官方網站](https://stooq.com/)
- **Nasdaq Data Link**：現行文件將 QuoteMedia EOD 列為 Premium；舊版文件仍出現免費 WIKI，不足以證明持續更新。免費 SF1 樣本限部分公司 2012–2018 年度資料，不是最新完整資料。[現行文件](https://docs.data.nasdaq.com/docs/data-organization)、[SF1 樣本](https://data.nasdaq.com/databases/SF1)

## 接入前的資料驗證

「可靠來源」和「實際回傳正確」是兩件需要分別確認的事。後續用免費帳戶實測時，至少完成：

1. **商品識別**：各市場選普通股與 ETF；美股另測有特殊符號的股別，日本另測英數代號。保存交易所、供應商代號與商品種類，避免 ADR 與原股混用。
2. **日期與行情範圍**：對照最近一個完整交易日及一個歷史月份。確認是 IEX、整合市場還是其他 feed；盤前／盤後是否包含。相同價格不能證明成交量範圍也相同。
3. **價格調整**：核對至少一個拆股／除息案例，分開保存 raw、split-adjusted、split-and-distribution-adjusted（拆股及股息／資本利得分配調整）語意；調整後價格不直接等同已計算的含息報酬指標，也不能接續不同調整基準形成假漲跌。
4. **期間、幣別與單位**：美股使用 America/New_York 並處理夏令時間，日股使用 Asia/Tokyo；價格保留 USD／JPY，不預設換成 TWD。財報依申報單位及期間處理，不套台股月營收模板。
5. **缺漏與更正**：休市、未成交、無權限、額度耗盡、來源故障分開呈現；缺值不填零。保留抓取時間和交易日期，針對近期資料重查更正。
6. **核對證據**：記錄供應商、方案、端點、實測時間、樣本、差異及可接受原因；交叉比對來源需有可比的交易時段、feed 與調整規則，否則差異不能直接判為錯誤。

## 對目前架構的影響

以下是待實作設計，尚未修改正式網站資料模型或排程：

- 把地區 TW／US／JP 與交易所分開，加入貨幣、交易所時區及不同供應商的 symbol 對應。
- 每個 adapter 宣告可用功能：目錄、收盤、日線、財報、新聞、申報；將「來源未設定」「方案不支援」「暫時失敗」分開。
- 依市場交易日及供應商更新時間排程；同一份市場資料僅在允許的範圍內共用抓取，私人清單與摘要仍獨立。
- 允許站長設定一次的 key 只放後端環境設定，前端與公開 Git 不包含 key。供應商僅授權個人時，不因技術上能代理就開放其他帳戶查看。
- 免費額度由後端統一管理，達上限即停止並顯示最後成功資料，不自動升級或開通超額扣款。每日追蹤優先於舊歷史回補。
- UI 附來源、實際交易日期、延遲與調整方式；ETF 不套公司財報。資料未驗證前，不宣稱已支援該市場的完整行情。

現有台股 adapter、正式站與排程在這次調研中未變更。
