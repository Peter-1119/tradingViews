[English](architecture.md) | **繁體中文**

# 架構

App 是怎麼組起來的：有哪些行程、每個檔案在哪裡，以及影響其他所有設計的兩個決定：一個持有全部連線的隱藏 hub 視窗，以及用 `app://` 而不是 `file://`。

## 行程

```
                   ┌────────────── 主行程 main ──────────────┐
                   │ 視窗、系統匣、快捷鍵、設定、            │
                   │ K 線 / 足跡快取、提醒、交易             │
                   └──┬─────────────┬───────────────────┬────┘
                 IPC  │             │ IPC               │ HTTPS（簽名的委託）
         ┌────────────┴───┐   ┌─────┴─────────┐         ▼
         │ 卡片視窗       │   │ hub（隱藏）   │     幣安 REST
         │ 圖表 + 介面    │   │ 所有連線      │
         └────────────────┘   └─────┬─────────┘
                                    │ WebSocket + REST（公開行情）
                                    ▼
                                  幣安
```

- **主行程**（`main/`）：視窗生命週期、系統匣與全域快捷鍵、設定檔、磁碟上的 K 線與足跡快取、提醒的送出，以及交易：金鑰、簽名、REST、使用者推送和模擬交易所。
- **Hub**（`renderer/hub.js`）：一個常駐、隱藏的 renderer，持有全部行情連線和所有背景工作（OI 輪詢、位置提醒、價格提醒、足跡、大單、掛單簿收集）。
- **卡片**（`renderer/card.js`、`renderer/board.js`）：Float 模式一張卡一個視窗，Board 模式全部在一個視窗。卡片只負責畫，資料透過 IPC 跟 hub 要。

## 為什麼有一個隱藏的 hub 視窗

兩個需求互相拉扯：renderer 要用瀏覽器原生的 `fetch` 和 `WebSocket` 連幣安，而且**不管開幾張卡都只有一條連線**。Float 模式下每張卡是獨立的 renderer 行程，卡片自己開 socket 就會變成一張卡一條連線。

所以連線放在一個隱藏的 renderer 裡，卡片透過它訂閱：

```
card --invoke--> main --send--> hub --(WebSocket)--> Binance
card <--send---- main <--send-- hub
```

現貨和永續在不同主機上，不可能共用一條 socket，所以規則是**每個市場最多一條**：沒有卡片在看永續時就不開永續那條，全部卡片都切到永續時現貨那條也會關掉。（掛單簿是例外：幣安的永續深度串流只在 `/public/stream` 上，所以掛單簿有自己的連線，見[資料來源](data-sources.zh-TW.md)。）stream 有參考計數，所以第二張同幣種的卡片、或大週期疊圖自己的訂閱，只是在既有連線上多一條 stream，不會多一條連線。實測開 4 張卡時 `Get-NetTCPConnection` 只看得到一條 9443 連線。

卡片全部隱藏或關掉時還要繼續跑的東西也都在 hub：價格與成交量提醒、常用清單的位置提醒、OI 記錄和成交通知。

## 為什麼用 `app://` 而不是 `file://`

Chromium 不允許從 `file://` 載入 ES module：它是 opaque origin，CORS 直接擋掉。常見解法 `webSecurity: false` 會把安全設定整個廢掉。所以註冊了一個 standard + secure 的 `app://` 協定（`main/protocol.js`）來服務 renderer：module import、secure context、WSS 都正常，而且 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true` 全部保留。畫面和主行程之間唯一的橋是 `preload/preload.js` 的白名單 API。

## 介面語言

程式裡保留中文原文當作鍵。`t('…')`（`renderer/i18n.js`；系統匣和通知用 `main/i18n.js`）到 `renderer/i18n/en.json` 查英文，查不到就顯示中文，所以缺翻譯也不會弄壞中文介面。`npm run check`（`scripts/check-i18n.mjs`）會檢查每個顯示用的中文字串都有包 `t()`、都有英文、`{佔位符}` 兩邊一致。新的鍵一律加在 `en.json` 最後面，既有的鍵不重新排序、不改寫。

## 檔案

```
main/                   Electron 主行程
  main.js               生命週期、單一實例鎖、所有 IPC
  windows.js            Float / Board 視窗、置頂、滑鼠穿透、顯示隱藏
  store.js              設定（electron-store）與螢幕範圍校正
  tray.js, shortcuts.js 系統匣選單、全域快捷鍵
  protocol.js           app:// 協定
  i18n.js               主行程文字的介面語言
  alerts.js             提醒的送出：卡片發光、Windows 通知、工作列閃爍
  bar-store.js          K 線快取：固定寬度二進位，依時間分檔
  footprint-store.js    足跡快取：每分鐘一個 gzip 段，只留最近 12 小時
  trading/
    rules.js            簽名、依交易所規則取整、強平估算
    client.js           幣安永續 REST
    stream.js           使用者推送
    vault.js            DPAPI 加密的金鑰
    service.js          交易狀態與下單流程，正式、測試網、模擬共用
    paper.js            模擬交易所，回應跟幣安 API 相同的呼叫
    paper-engine.js     模擬帳務：成交、手續費、資金費、強平、補算
preload/preload.js      contextBridge：畫面可以呼叫的白名單 API
renderer/
  hub.html / hub.js     隱藏視窗：所有連線與背景工作
  card.*, board.*       Float 模式的單卡頁面、Board 模式頁面
  cardview.js           卡片元件，兩種模式共用
  chart.js              Lightweight Charts v5 封裝
  guide.*, journal.*    快捷鍵與提示視窗（F1）、模擬交易紀錄視窗
  i18n.js, i18n/en.json t()：中文鍵 -> 英文
  datafeed/
    provider.js         DataProvider 介面
    binance.js          幣安：REST 回補、WebSocket 即時、重連、幣種對應
    remote.js           卡片端的 provider，透過 IPC 轉給 hub
    footprint-collector.js, sweep-collector.js, order-book.js
                        hub 端的收集器：足跡、大單、掛單牆
  *-primitive.js        畫在圖表裡的東西：斐波那契、矩形、趨勢線、
                        成交量分布、開盤價、掛單牆、大單、最新價…
  volume-pane.js, oscillator-pane.js   成交量、RSI / MACD / CVD 副圖
  indicators.js, cvd.js, volume-stats.js, volume-profile.js, footprint.js,
  flow-read.js, open-interest.js, long-short.js, sessions.js, position.js
                        上面那些背後的計算，不含繪圖
  alert-monitor.js, price-alert-monitor.js   hub 端的位置提醒、價格／成交量提醒
  ui/                   設定面板、幣種搜尋、工具列、常用清單、交易設定
  trade/                下單票、倉位列、委託線、反手面板、
                        多空傾向、傳統資產提示、環境標章
scripts/                測試、語法與翻譯檢查、圖示產生、vendor 同步、
                        README 截圖
```

## 換資料來源

`renderer/datafeed/provider.js` 定義了圖表和介面需要的東西：

```js
getHistory(symbol, interval, limit)   // -> Bar[]  { time(秒), open, high, low, close, volume, closed }
subscribe(subId, symbol, interval, { onBar, onTicker, onFunding })
unsubscribe(subId)
searchSymbols(query)                  // -> SymbolInfo[]
getTicker(symbol)                     // -> { symbol, last, changePercent, high, low, volume }
```

要從別的來源看台股或美股，就寫第二個實作，然後在 `renderer/hub.js` 換掉 `new BinanceProvider()`，圖表層與介面層不用動。（訂單流工具依賴主動買入量、aggTrades 這類只有幣安這種加密交易所才公開的資料，換來源時需要另外處理。）

## 測試

`npm test` 跑 `scripts/test-*.mjs` 的十一套測試，涵蓋斷線 / 重連 / 回補、K 線快取、下單規則與取整、模擬帳務、縮量排名、足跡圖、RSI / MACD 與整段重算的比對、CVD、多空比、訂單流、掛單牆和價格提醒等。全部都不連網路、不碰真實帳戶。`npm run check` 是全樹語法檢查加翻譯檢查。
