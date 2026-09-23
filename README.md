# StockCard

桌面透明行情小卡片。無邊框、半透明、可置頂,即時顯示加密貨幣線圖。

**Electron 43 + TradingView Lightweight Charts v5 + Binance 公開行情 API**(免註冊、免 API key)

---

## 快速開始

```bash
npm install       # 同時把 lightweight-charts 複製到 renderer/vendor/
npm start         # 執行
npm run dev       # 執行並把 renderer 的 console 轉到終端機
npm test          # datafeed 的斷線 / 重連 / 回補測試
npm run check     # 全樹語法檢查
npm run dist      # 打包成 Windows 安裝檔 + 免安裝版 -> release/
```

第一次啟動會自動開一張 BTCUSDT 1 分 K 線卡片。

## 操作

| 動作 | 方式 |
| --- | --- |
| 移動卡片 | 拖曳卡片頂端(滑鼠移上去標題列才會浮現) |
| 調整大小 | 拖曳右下角的斜線把手 |
| 讀取價位 | 十字線跟著游標走,右側價格軸即時顯示游標所在價位 |
| 吸附到 OHLC | 按住 `Ctrl`,十字線會吸到**離游標最近的**開/高/低/收 —— 在 K 棒上方吸 high、下方吸 low |
| 加支撐壓力線 | 在圖上**雙擊**空白處。按著 `Ctrl` 雙擊會吸到最近的 OHLC |
| 移動 / 刪除線 | 拖曳線本身移動(按 `Ctrl` 吸附);**雙擊線本身**刪除 |
| 選工具 | 滑鼠移到卡片上，左側會浮出工具列（游標 / 水平線 / 量測）。再點一次同一個圖示可取消 |
| 量測區間 | 按住 `Shift` 拖曳,顯示價差、百分比、K 棒數與時間長度。加按 `Ctrl` 可吸到 OHLC |
| 關閉量測 | 放開後讀數會留著;點一下空白處或按 `Esc` 清除 |
| 畫斐波那契 | 工具列選斐波那契，在圖上拖曳畫出波段。拖兩端的圓點可調整，雙擊圓點刪除 |
| 成交量分布 | 點工具列的成交量分布圖示，右側彈出選單：關閉 / 每 4H 分段 / 可見範圍 / 本日 (UTC) |
| 4H 疊圖 | 工具列最下面的開關。把最近 10 根 4 小時 K 棒以半透明方塊疊在小週期圖上；未收盤的那根是虛線框，會跟著即時報價變形 |
| 開設定 | 齒輪鈕,或在卡片上按右鍵 |
| 關閉設定 | `Esc`、再按一次右鍵,或面板右上角 ✕ |
| 顯示/隱藏全部 | `Ctrl+Alt+S`,或左鍵點系統托盤圖示 |
| 切換滑鼠穿透 | `Ctrl+Alt+C`,或托盤選單 |
| 切換 Float / Board | 托盤選單 →「顯示模式」 |
| 新增 / 移除卡片 | 托盤選單,或 Board 模式標題列的 ＋ |

十字線的行為刻意對齊 TradingView:平常自由跟著游標,`Ctrl` 才啟動磁吸,且磁吸目標是最近的 OHLC 而不是只有收盤價(對應 lightweight-charts 的 `CrosshairMode.MagnetOHLC`)。要畫支撐壓力、對齊影線的時候用這個。

**時間顯示**預設跟著本機時區(設定面板 →「時間顯示」可切 本機 / 台北 / UTC)。Binance 的時間戳是 UTC epoch,lightweight-charts 預設也用 UTC 算,所以未設定前軸上會比台北慢 8 小時。這裡是改**格式化**而不是平移時間戳 —— 時間戳同時是 datafeed 回補去重(`lastBarTime`)和更新未收盤 K 棒的依據,平移它等於為了外觀去動資料層。唯一修不掉的是 `1d`:Binance 的日 K 本來就是 UTC 日界,在 UTC+8 下會標成 08:00,那是交易所的切分方式,不是顯示錯誤。

**4H 疊圖**只在 1m / 5m / 15m / 1h 下顯示 —— 在 4h 圖上那個方塊就是 K 棒本身。未收盤的那根由**兩條獨立的 4h 訂閱**馀養，而不是拿卡片自己的 K 棒去聚合：卡片可能在看 1m，500 根才 8 小時，而交易所自己的 4h K 棒本來就是權威值。hub 的 stream 是計數的，所以同一個幣別多一條訂閱只多一條 kline stream，不會多一條連線。

**歷史資料快取**：往左滾動到快碰到資料邊緣時，背景自動補更舊的 K 棒，先查本地再打 API，而且抓回來的都會寫進快取。檔案在 `userData/bars/{SYMBOL}/{interval}/{chunk}.bin`，固定寬度二進位，每筆 48 bytes（六個 float64：`time, open, high, low, close, volume`）。1m / 5m 按**月**分檔，其餘按**年** —— 回補的舊資料會寫進不同的檔案，所以每個檔永遠只會 append、內部永遠有序，**不需要全域排序，也不需要重寫整份歷史**。只寫已收盤的 K 棒：幣安回傳的最後一根永遠是未收盤的，快取它等於把半根 K 棒永久寫死。實測同一段區間：快取 7.4ms vs 網路 142ms（**19 倍**），內容完全一致。

**成交量分布**有三種模式，從工具列圖示的彈出選單切換：

| 模式 | 內容 |
| --- | --- |
| 每 4H 分段 | 每個 4H 區塊各自一組分布與 POC，放在自己的時間區塊內由左往右長。區塊對齊 UTC 0/4/8/12/16/20 點，跟交易所的 4h K 棒同一個邊界。只在 1h 以下的週期顯示 |
| 可見範圍 | 只算畫面上看得到的 K 棒，貼右邊畫，平移縮放時即時重算 |
| 本日 (UTC) | UTC 00:00 至今，貼右邊畫 |

三種都由圖表自己畫（series primitive），跟 K 棒同一幀，縮放卡片不會延遲。每 4H 模式用 5 分 K 棒建置：已收盤的區塊算一次就快取，進行中的那塊每分鐘更新。

**成交量分布**跟 TradingView 用同一種方法建置：載入該場次的 **1 分 K 棒**，把每根的量平均攤到它觸及的價格列上。他們官方文件明言這是估計值，不是 tick 級精確值。一天的 1 分 K 棒只要 **2 次 API 請求**；改用 aggTrades 逐筆資料的話 BTCUSDT 一天約 82 萬筆、需要 819 次請求，精確度的差距不值這個價錢。加密貨幣沒有交易時段，所以「場次」指的是交易所自己的日界，Binance 是 00:00 UTC。

**斐波那契**的錨點存的是 **{time, price}** 而不是 K 棒索引 —— 索引只在目前載入的資料範圍內才有意義，换個週期就指到別的 K 棒。回撤比例線橫跨整個圖表寬度，因為在這麼小的卡片上，你想知道的是「現在價格距離這些位置多遠」。

**工具列**的顯示規則跟標題列**完全相同** —— 滑鼠移到卡片上就浮出，移開就淡掉。刻意不做成「靠近左邊緣才展開」：這麼小的卡片不該有兩套喚出介面的規則，而且 45% 透明度下最外緣 20px 是最難瞄準的地方。工具列是疊在圖表上的，不佔版面寬度，閒置時成本是 0px。選了工具之後即使工具列淡掉，該工具的圖示仍會留著 —— 否則你會不知道自己還在繪製模式。**手勢在任何模式下都有效**（雙擊加線、`Shift` 拖曳量測），工具列只是讓沒背過手勢的人也找得到，這跟 TradingView 的分工一樣。

**量測工具**刻意做成手勢而不是工具列按鈕 —— TradingView 自己的快速量測也是 `Shift` 拖曳,而在這種尺寸的卡片上,手勢不佔任何畫面空間。量測框的兩個錨點存的是 logical(小數 K 棒索引)而不是像素,所以平移縮放時框會跟著 K 棒跑,而且在最右側那段沒有 K 棒的留白區也定位得到。

**支撐壓力線**依 **symbol** 儲存,不依卡片也不依週期。所以同一條線會出現在每一張同幣別的卡片上,而且 1 分、15 分、1 日切來切去都在 —— 水平價位本來就沒有時間錨點。相同價格的線會自動去重。

**兩種顯示模式**

- **Float**(預設):每張圖各自一個獨立浮動視窗,可分別擺到螢幕任何角落。
- **Board**:單一視窗、CSS Grid 排多張卡,拖曳卡片標題列可重新排序,右上角可調欄數。

兩種模式共用同一份卡片設定,來回切換不會遺失 symbol / 週期 / 圖型 / 透明度。

**滑鼠穿透**:開啟後點擊會直接穿到桌面。卡片右下角會出現「解除穿透」小鈕(滑鼠移上去就會恢復可點),按 `Ctrl+Alt+C` 也能強制解除,不會把自己鎖在外面。

## 架構

```
main/                 Electron 主行程
  main.js             生命週期、單一實例鎖、全部 IPC
  windows.js          Float / Board 視窗管理、置頂、穿透、顯示隱藏
  store.js            electron-store 設定持久化 + 螢幕範圍校正
  tray.js             系統托盤選單
  shortcuts.js        全域快捷鍵
  protocol.js         app:// 自訂協定
preload/preload.js    contextBridge 白名單 API
renderer/
  hub.html/js         隱藏視窗:全 App 唯一一條 WebSocket
  card.html/js        Float 模式單卡頁面
  board.html/js       Board 模式多卡頁面
  cardview.js         卡片元件(兩種模式共用)
  chart.js            lightweight-charts v5 封裝
  datafeed/
    provider.js       DataProvider 抽象介面
    binance.js        Binance 實作(REST 回補 + WS 即時 + 重連)
    remote.js         卡片端 Provider,透過 IPC 轉給 hub
  ui/                 設定面板、symbol 搜尋
scripts/              圖示產生、vendor 同步、語法檢查、datafeed 測試
```

### 兩個實作上的取捨

**1. 為什麼有一個隱藏的 hub 視窗**

規格同時要求「renderer 直接連 Binance」和「不管幾張卡都只有一條 WebSocket」。Float 模式下每張卡是獨立的 renderer 行程,卡片自己開 socket 就會變成一卡一條連線。

所以連線放在一個常駐隱藏的 renderer(`renderer/hub.js`)裡,卡片透過 IPC 跟它要資料:

```
card --invoke--> main --send--> hub --(WebSocket)--> Binance
card <--send---- main <--send-- hub
```

這樣既維持了「用瀏覽器原生 fetch / WebSocket」,又真的只有一條連線。實測開 4 張卡時 `Get-NetTCPConnection` 只看得到一條 9443 連線。

**2. 為什麼用 `app://` 而不是 `file://`**

Chromium 不允許從 `file://` 載入 ES module(來源是 opaque origin,CORS 直接擋掉)。常見的解法是 `webSecurity: false`,但那會把規格要求的安全設定整個廢掉。所以註冊了一個 standard + secure 的 `app://` 協定來服務 renderer,module import、secure context、WSS 都正常,而 `contextIsolation: true` / `nodeIntegration: false` / `sandbox: true` 全部保留。

## 資料來源

一律走 Binance 公開現貨端點:

- 歷史 K 線 `GET /api/v3/klines`(500 根)
- 即時 `wss://stream.binance.com:9443/stream` combined stream,`@kline_<interval>` + `@miniTicker` + `@aggTrade`
- 交易對清單 `GET /api/v3/exchangeInfo`,快取 24 小時
- 24h 漲跌:啟動打一次 `/ticker/24hr`,之後由 miniTicker 更新

**更新頻率**:Binance 的 `@kline_*` 固定每秒推一次,這是 K 棒官方數值的上限。為了讓價格跳得更即時,另外訂了逐筆的 `@aggTrade`,在兩次 kline 之間把成交價併進「正在形成的那根」的 close / high / low / volume。逐筆訊息在 hub 端以 **100ms** 為窗口合併(`LIVE_TICK_MS`),同一窗口內只有最後一筆會送出去,所以不論行情多熱,每張卡最多每秒 10 次重繪。kline 一到就立刻覆蓋回官方數值,誤差最多存活一秒。跨棒的那一刻不自己開新 K 棒,等 kline 來 roll。

**連線韌性**:斷線後 1s → 2s → 4s → … → 30s 指數退避重連;重連成功會重新訂閱全部 stream,並用 REST 補齊斷線期間缺的 K 線再接回即時流;另外會在 23 小時主動換一條連線,避開 Binance 24 小時強制斷線。卡片左上角小圓點顯示狀態(綠=即時、黃=重連中、紅=離線),不會跳任何錯誤視窗。

這些行為有測試涵蓋(`npm test`),不需要真的拔網路線也能驗證。

### 換資料來源

`renderer/datafeed/provider.js` 定義了介面:

```js
getHistory(symbol, interval, limit)   // -> Bar[]  { time(秒), open, high, low, close, volume, closed }
subscribe(subId, symbol, interval, { onBar, onTicker })
unsubscribe(subId)
searchSymbols(query)                  // -> SymbolInfo[]
getTicker(symbol)                     // -> { symbol, last, changePercent, high, low, volume }
```

要加台股 / 美股就寫第二個實作,然後在 `renderer/hub.js` 換掉 `new BinanceProvider()`。圖表層與 UI 層不用動。

## 設定檔

`%APPDATA%/stock-card/stock-card-config.json`。開發版與打包版共用同一份(asar 內的 `name` 一樣是 `stock-card`),所以 `npm start` 調好的卡片,裝起來的版本會直接沿用。

位置與大小的變動會 debounce 500ms 才寫入;啟動時會檢查存下來的座標是否還落在現有螢幕範圍內,螢幕配置變了會自動拉回可見區域。

## 已知限制

- **`backdrop-filter` 模糊不到桌面。** CSS 的 backdrop-filter 只能模糊「同一個網頁裡」的背景;透明視窗背後是桌面,不在網頁裡。要真正的毛玻璃必須呼叫 Windows DWM 的 acrylic API(原生層)。目前的半透明效果來自卡片背景的 rgba alpha,這也是透明度滑桿實際在調的東西。
- **透明視窗不能最大化**,這是 Windows 上的限制,所以沒有提供最大化。
- 卡片用 `skipTaskbar`,不會出現在工作列,一律由托盤管理。
- 「開機自動啟動」只在打包後的版本有效(開發模式下指向的會是 `electron.exe`)。
- 圖表左下角的 TradingView 標誌是 Lightweight Charts 的預設署名,保留著。

## 授權

本專案 MIT。圖表使用 [TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts)(Apache-2.0)。行情資料來自 Binance 公開 API;本專案不含任何交易、下單或帳號功能,也不抓取 TradingView 網站的私有資料。
