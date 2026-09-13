# urTube 影音分析模組

在模組探索啟用「影音分析」，或由側邊欄進入。沿用知隅登入與個人版面設定，觀看紀錄、匯入紀錄及分類均保存於本機 PostgreSQL，依登入帳號隔離。主要入口為 Chrome 擴充功能，自動擷取 YouTube 觀看紀錄頁及之後的播放；檔案匯入保留作為備份相容方式。不包含交友配對。

## 自動擷取 YouTube HTML

網站提供擴充功能 ZIP。解壓縮後，在 Chrome 擴充功能管理頁開啟開發人員模式、載入未封裝項目；開啟擴充功能並按「授權並連接知隅」，允許 YouTube 網站存取，再於知隅連接分頁確認目前帳號。每個 Chrome 設定檔需分別安裝；手機可直接查看已同步結果。

擴充功能直接開啟已登入 YouTube 的 /feed/history 頁，持續捲動並解析新載入 HTML，辨識日期分組、影片與 Shorts。不使用 Chrome history API，沒有 Chrome 全站瀏覽歷史權限，也不把手動 Takeout 匯入當成日常流程。首次完整回補沒有固定一年或五年截止，會讀到來源實際提供的歷史起點；Google 已刪除、自動刪除或關閉紀錄的部分無法還原。

每批最多 200 筆，本機待傳佇列最多 10,000 筆；主機失聯或佇列滿時保留尚未確認的批次並暫停往下載入，恢復後續傳。頁面保留最近 40 個日期區段的內容，其餘以等高空白取代以限制 DOM 增長。只有來源分頁標記消失且多次穩定觀察後才標示歷史起點；停滯、未登入、無法辨識結構都標示未完成。完整掃描後每日執行近期增量，重疊兩天並去重。

最早已讀日期及執行狀態保存在擴充功能。若 Chrome／分頁關閉，已同步資料仍在主機，待傳紀錄留在 Chrome；重新回補會從最新頁重新載入、跳過已保存的重複事件，並非依靠不穩定的 YouTube 內部 continuation token 直接跳到舊頁。來源頁日期精度僅為一天，同影片同日合併成一筆，無法推論當天重看次數。新播放每 2 秒檢查播放器，約每累積 15 秒送入佇列，排除暫停、跳轉和可辨識的廣告；最後尚未送出的少量秒數可能在強制關閉頁面時遺失。

## 帳號綁定與撤銷

所有寫入仍須通過既有 Cloudflare Access。擴充功能透過專用知隅同源分頁發出請求，保留 HTTP Origin 與 Access 驗證，沒有新增公開匿名擷取入口。登入過期時提示重新登入，期間暫存資料。

後端同時驗證登入 user ID 與獨立裝置憑證，切換知隅登入帳號不會把舊佇列送進另一個人的資料庫。裝置憑證只存在擴充功能受信任儲存區，資料庫僅保存 SHA-256；網頁裝置列表不提供憑證。撤銷裝置與同步使用同一個模組鎖，清除影音資料也解除全部裝置，以避免稍後的同步重新建立已刪紀錄。最多連接 10 個瀏覽器。

擴充功能不讀取 Google Cookie 或登入憑證，不新增 AI 自動呼叫；取得的是該 YouTube 分頁目前登入帳號的內容，開始前請核對 YouTube 與知隅兩邊的帳號。安裝到共用 Chrome 設定檔時，應了解其中可能出現不同 YouTube 帳號的活動。

來源：[Chrome content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)、[選用權限](https://developer.chrome.com/docs/extensions/reference/api/permissions)，HTML 日期與內容解析參考 urTube MIT 程式碼。

## 匯入與匯出

- urTube Account 的 portable export ZIP v1：讀取觀看事件、影片中繼資料、日期精度與目前 active 版本的主題分類；不讀入帳號憑證、搜尋與社交資料。
- Google Takeout 的 YouTube 觀看紀錄：ZIP、原始 watch-history.json 或 HTML。支援常見多語系日期；無法辨識時會回報，建議改用 JSON。
- 知隅自己的影音 JSON 匯出，可重新匯入。

每次最多 50 MiB、20 萬筆觀看紀錄，選取的 ZIP 內容解壓縮後最多 200 MiB；帳號最多 50 萬筆。完全相同檔案以雜湊去重，事件依影片 ID、時間與精度去重。相同台北日期的精確事件會取代日期精度事件；來源沒有時間精度時，無法分辨同日重看次數。不同來源名稱不影響相同事件去重。

網站匯出以每卷最多 5,000 筆切分；資料較多時請依序下載所有分卷，重新匯入時亦逐卷操作。分卷期間請避免同時新增或清除紀錄。站長仍可透過標準加密資料庫備份取得完整一致快照。匯出的 JSON 本身未加密，請妥善保存。

## 分析與資料限制

提供近 28 天、90 天、一年及全部紀錄，期間以目前時間向前計算；舊資料可切換全部查看。卡片包含觀看次數、不同影片、活躍日期、觀看分布、頻道排行、主題與可搜尋的逐筆紀錄。卡片顯示與排序隨帳號同步。

時數只加總擴充功能實測秒數或 urTube 提供的 actual_watched_seconds。Takeout 通常不提供實際觀看時長，畫面會顯示缺值；不使用影片全長作為實際觀看時間。次數是匯出檔可辨識的事件數，不保證等於所有實際播放次數。主題可複選，占比可能超過 100%，分類描述影片內容而非觀看者的身份或立場。

## 按需 AI 分類

使用現有後端 OpenAI 設定，模型為 gpt-5.6-luna。每按一次最多分類 30 部尚未分類的影片，只傳送影片 ID、標題及頻道名稱，使用 Responses API、store:false；不傳送帳號或觀看時間。即使僅有標題，所選影片仍可能反映私人興趣，使用者應在閱讀畫面說明後自行啟動。結果按帳號保存，既有 urTube 主題保留。輸出必須完全對應輸入影片 ID，格式錯誤不寫入結果。

影音與財經新聞共用 AI_DAILY_REQUEST_LIMIT（預設全站每日 40 次），每批只占一次；瀏覽已存資料不呼叫 AI。錯誤亦消耗一次預留額度以防無限重試，並有等待時間。實際 tokens 記入 ai_daily_usage，費用依 token 用量計算，次數限制不是美元上限。此版未以私人觀看紀錄進行付費實測。

## API 與維護

所有路徑以 `/api/v1/media` 開頭：`POST /import` 接收 application/octet-stream；`GET /summary`、`GET /history` 支援 range；`POST /classify`、`POST /clear` 要求 `{confirm:true}`；`GET /export?part=1` 匯出指定卷，不帶 part 可串流匯出整份資料。私人回應禁止公開快取，寫入需同源驗證。API 不接受使用者指定資料擁有者。

資料庫遷移 007 新增 media_events、media_imports、media_classifications、media_ai_state。停用保留資料，清除只影響目前帳號；清除後尚未完成的 AI 工作不得重新建立資料。加密備份／還原沿用既有操作流程，包含全部影音表格。

來源：[urTube](https://github.com/skyhong2002/urtube.observe.tw)，參考提交 `5b2904401b1bb44a41d4095d16e57865211e8996`。日期解析部分依 MIT 授權改寫，詳見根目錄 THIRD_PARTY_NOTICES.md。

遷移 008 新增 media_devices；連接與同步 API 位於 /api/v1/media/devices、/api/v1/media/extension/sync，受既有登入與同源政策保護。npm run build 會依 PUBLIC_ORIGIN 產生專屬擴充功能 ZIP；打包過程不讀取或嵌入金鑰，未設定時使用保留測試網域。
