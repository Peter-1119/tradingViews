# 開發任務:StockCard — 桌面透明股票圖表小卡片(Desktop Chart Widget)

> 這份 prompt 請直接交給 Claude Code / Cursor 等 AI 編程工具,作為完整開發規格。
> 請一次讀完整份規格再開始動工,依「開發順序建議」分階段實作,每階段完成後可執行驗證。

---

## 1. 專案目標

做一個 Windows 桌面小工具:以「無邊框、半透明、可置頂的小卡片」形式,即時顯示加密貨幣行情線圖(類似桌寵/YouTube 迷你視窗的存在感,不佔版面、不搶焦點)。

- 技術棧:**Electron + TradingView Lightweight Charts(請使用 v5 系列)+ Binance 公開行情 API**
- 語言:HTML / CSS / JavaScript(不用 TypeScript 也可以,但檔案要模組化,不要全塞在一個檔案)
- 平台:優先 Windows 10/11,程式碼盡量不要寫死平台專屬邏輯
- 不需要:交易功能、技術指標(MA/RSI 等)、登入帳號。**這些是明確的 Non-goals,不要做。**

## 2. 執行環境(開發者已具備)

- Node.js(LTS)與 npm 已安裝
- 用 `npm init` 起專案,依賴:`electron`、`lightweight-charts`、`electron-store`(設定持久化)、開發打包用 `electron-builder`
- 圖表庫**必須用 npm 安裝的 lightweight-charts 本地檔案**,不要用 CDN(打包後要能離線啟動殼層,只有行情需要網路)

## 3. 核心架構

```
stock-card/
├─ package.json
├─ main/                  # Electron 主行程
│  ├─ main.js             # app 生命週期、單一實例鎖
│  ├─ windows.js          # 視窗/卡片管理(兩種模式)
│  ├─ tray.js             # 系統托盤選單
│  ├─ shortcuts.js        # 全域快捷鍵
│  └─ store.js            # electron-store 設定持久化
├─ preload/
│  └─ preload.js          # contextBridge 暴露 IPC API
└─ renderer/
   ├─ card.html / card.js / card.css      # 單張圖表卡片頁面
   ├─ board.html / board.js               # 多卡片同視窗(Board 模式)頁面
   ├─ chart.js            # lightweight-charts 封裝(建圖、換型態、餵資料)
   ├─ datafeed/
   │  ├─ provider.js      # DataProvider 抽象介面
   │  └─ binance.js       # Binance 實作(REST 回補 + WebSocket 即時)
   └─ ui/                 # 設定面板、symbol 搜尋等元件
```

安全設定必須遵守:`contextIsolation: true`、`nodeIntegration: false`、所有主行程能力經 preload 的 `contextBridge` 暴露白名單 API。Renderer 直接用瀏覽器原生 `WebSocket` 與 `fetch` 連 Binance(不需經主行程轉發)。

## 4. 視窗與卡片行為(重點功能)

### 4.1 兩種顯示模式,可於托盤選單切換,切換後卡片設定(symbol、週期、圖型、透明度)必須保留

1. **Float 模式(預設)**:每張圖 = 一個獨立的無邊框浮動視窗,可各自拖到螢幕任何角落、各自調大小與透明度。
2. **Board 模式**:單一無邊框透明視窗,內部用 CSS Grid 排列多張卡片,卡片可在格線內拖曳排序、單張移除;整個視窗可拖曳移動與縮放。

### 4.2 每個卡片視窗的 BrowserWindow 設定

```js
{
  frame: false,
  transparent: true,
  backgroundColor: '#00000000',
  alwaysOnTop: true,          // 可由使用者切換
  resizable: true,
  skipTaskbar: true,          // 不佔工作列,由托盤管理
  minWidth: 220, minHeight: 140,
  webPreferences: { preload, contextIsolation: true, nodeIntegration: false }
}
```

已知 Electron 陷阱,請務必處理:

- 透明視窗在 Windows 上不能 maximize,不要提供最大化。
- 拖曳:卡片頂部標題列區域用 `-webkit-app-region: drag`;所有按鈕、滑桿、下拉選單、圖表區域必須標 `-webkit-app-region: no-drag`,否則點不到。圖表區不可設 drag,否則 crosshair 互動全失效。
- **滑鼠穿透模式**:`win.setIgnoreMouseEvents(true, { forward: true })`。開啟穿透時,監聽 renderer 的 `mouseenter/mouseleave`(透過 IPC)讓「解除穿透」的小按鈕仍可點;並提供全域快捷鍵強制解除,避免使用者把自己鎖在外面。
- 視窗縮放時用 `ResizeObserver` 呼叫 chart 的 `applyOptions({ width, height })` 或 `autoSize: true`。

### 4.3 卡片 UI(半透明玻璃卡片風格)

- 卡片本體:圓角、深色 `rgba` 背景 + `backdrop-filter: blur()`(若效能差可關閉 blur 僅留 rgba)。
- **透明度調整**:每張卡片獨立一個 10%–100% 滑桿,調整的是卡片背景 rgba 的 alpha;文字與線圖保持完全不透明(可另提供「整體透明度」進階選項,用 `win.setOpacity()`,兩者分開)。
- 標題列(hover 才浮現,平時隱藏以極簡化):symbol 名稱、現價、24h 漲跌 %(漲綠跌紅或可切換紅漲綠跌)、設定齒輪、關閉鈕、置頂圖釘、穿透鎖。
- 設定面板(齒輪展開,或右鍵選單):
  - Symbol 搜尋(自動完成,資料來自 Binance `exchangeInfo`,快取到本地)
  - 週期:1m / 5m / 15m / 1h / 4h / 1d
  - **圖型切換:Candlestick(K 線)/ Line(收盤價折線)/ Area(面積)** — 這是必要功能
  - 透明度滑桿、成交量副圖開關(預設關)、置頂開關
- 空狀態、載入中狀態、斷線狀態(卡片角落一個小紅點 + tooltip,不要彈窗打擾)。

### 4.4 托盤與快捷鍵

- 系統托盤:新增卡片、切換 Float/Board 模式、顯示/隱藏全部、全部置頂開關、開機自動啟動開關、結束程式。
- 全域快捷鍵(可在設定中改):`Ctrl+Alt+S` 顯示/隱藏全部卡片;`Ctrl+Alt+C` 切換滑鼠穿透。
- `app.requestSingleInstanceLock()` 防止重複開啟。

## 5. 圖表層(lightweight-charts v5)

**注意版本:v5 的 API 與 v4 不同**,建立 series 是 `chart.addSeries(CandlestickSeries, options)` 這種形式(`addCandlestickSeries()` 是 v4 舊寫法,不要用)。實作前先看 node_modules 內型別或官方文件確認。

- `createChart(container, { layout: { background: { color: 'transparent' }, textColor: ... }, autoSize: true })` — 圖表背景必須 transparent,透明度才會由卡片 CSS 控制。
- 深色主題配色,格線淡化(低 alpha),時間軸/價格軸字體縮小以適合小卡片。
- 圖型切換的做法:移除舊 series、建立新 series、把已快取的 K 線資料轉換後 `setData()` 餵入(candle → line 時取 close)。資料快取在 datafeed 層,切換圖型不重新打 API。
- 即時更新用 `series.update(bar)`:同一根未收盤的 K 線重複 update,收盤(`k.x === true`)後下一筆自動成為新 bar。
- 視窗隱藏時暫停渲染更新(仍收資料入快取),顯示時再一次補上,省 CPU。

## 6. 資料層(Binance,免費、免 API key)

TradingView 本身不提供公開資料 API,lightweight-charts 只負責畫圖、資料自備;因此行情一律走 Binance 公開端點(現貨):

- **歷史回補(REST)**:`GET https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=500` → 轉成 `{ time: openTime/1000, open, high, low, close }`(lightweight-charts 用秒級 UNIX time)。
- **即時(WebSocket)**:`wss://stream.binance.com:9443/stream?streams=btcusdt@kline_1m/ethusdt@kline_1m`(combined stream,**全部卡片共用一條連線**,新增/移除卡片用 `SUBSCRIBE`/`UNSUBSCRIBE` 訊息動態調整,不要一張卡開一條連線)。
- kline 事件的 `k` 物件:`t`(開盤時間)、`o/h/l/c/v`、`x`(該根是否已收盤)。
- 24h 漲跌:訂閱 `{symbol}@miniTicker` 或啟動時打一次 `GET /api/v3/ticker/24hr?symbol=...` 之後用 miniTicker 更新。
- Symbol 清單:`GET /api/v3/exchangeInfo` 取 `status === 'TRADING'` 的交易對,快取 24 小時。
- **連線韌性(必做)**:Binance 會在連線滿 24 小時左右主動斷線,且會發 ping(需回 pong,瀏覽器原生 WebSocket 會自動處理 pong,但仍要處理 close):
  - 斷線後指數退避重連(1s → 2s → 4s → 上限 30s),重連成功後重新訂閱所有 stream,並用 REST 回補斷線期間缺的 K 線再接回即時流。
  - 卡片右上角顯示連線狀態小點(綠=即時、黃=重連中、紅=斷線)。
- **DataProvider 抽象介面(必做)**:`getHistory(symbol, interval, limit)`、`subscribe(symbol, interval, onBar)`、`unsubscribe(...)`、`searchSymbols(query)`、`getTicker(symbol)`。Binance 是第一個實作;介面設計要讓日後能加第二個 provider(例如台股、Yahoo Finance)而不動到 UI 與圖表層。

## 7. 設定持久化(electron-store)

儲存並於重啟時完整還原:

```json
{
  "mode": "float",
  "cards": [
    {
      "id": "uuid",
      "symbol": "BTCUSDT",
      "interval": "1m",
      "chartType": "candlestick",
      "cardOpacity": 0.75,
      "windowOpacity": 1,
      "showVolume": false,
      "alwaysOnTop": true,
      "bounds": { "x": 1560, "y": 820, "width": 320, "height": 200 }
    }
  ],
  "board": { "bounds": {}, "columns": 2 },
  "shortcuts": { "toggleShow": "Ctrl+Alt+S", "toggleClickThrough": "Ctrl+Alt+C" },
  "upDownColor": "greenUp",
  "launchAtStartup": false
}
```

- 位置/大小變動用 debounce(500ms)寫入。
- 還原時檢查 bounds 是否還在任一螢幕範圍內(螢幕配置變了要拉回可見區域)。

## 8. 打包

- `electron-builder` 出 Windows NSIS 安裝檔 + portable 版。
- `npm start` 開發執行、`npm run dist` 打包。
- App icon 用簡單的燭台圖示即可(可先用 placeholder)。

## 9. 開發順序建議(每階段可獨立驗證)

1. **殼層**:單一張無邊框透明卡片視窗 + 假資料靜態 K 線圖,確認拖曳、縮放、透明度滑桿、置頂都正常。
2. **資料**:接 Binance REST 回補 + WS 即時流,單卡 BTCUSDT 1m 即時跳動;做斷線重連。
3. **卡片功能**:symbol 搜尋、週期切換、圖型切換(K 線/折線/面積)、24h 漲跌顯示、成交量開關。
4. **多卡 Float 模式** + 共用 WS 連線 + 設定持久化還原。
5. **Board 模式** + 模式切換保留設定。
6. **托盤、全域快捷鍵、滑鼠穿透、開機啟動、打包。**

## 10. 驗收標準(全部要通過)

- [ ] 啟動後還原上次所有卡片的位置、大小、symbol、週期、圖型、透明度
- [ ] 卡片無瀏覽器/OS 外框,背景半透明可調,文字與線圖清晰不透明
- [ ] K 線即時跳動(1m 週期下,最後一根隨每秒成交變化),切到折線/面積後資料連續、即時更新不中斷
- [ ] 同時開 4 張以上卡片仍只有一條 WebSocket 連線,CPU 佔用低(閒置 < 個位數 %)
- [ ] 手動斷網 30 秒再恢復:自動重連、缺的 K 線補齊、無殘留錯誤彈窗
- [ ] 滑鼠穿透開啟時點擊會穿到桌面,快捷鍵可解除
- [ ] Float ↔ Board 模式來回切換,卡片設定不遺失
- [ ] 關閉單張卡片、全部隱藏/顯示、托盤結束程式皆正常,無殭屍行程

## 11. Non-goals(明確不要做)

- 技術指標(MA、RSI、MACD…)、繪圖工具、警報通知
- 任何下單/交易/API key 相關功能
- 抓取 TradingView 網站的私有數據(違反其服務條款,不做)
- macOS/Linux 打包(程式碼保持可移植即可)