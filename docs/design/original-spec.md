**English** | [繁體中文](original-spec.zh-TW.md)

> **Historical document.** This is the original specification the project started from (August 2026). Several of its non-goals have since been built — trading, indicators (RSI, MACD, CVD) and more — so read it as history, not as a description of the current app. The current documentation is in [docs/README.md](../README.md).

# Development task: StockCard — transparent desktop stock chart card (Desktop Chart Widget)

> Give this prompt directly to an AI coding tool such as Claude Code / Cursor as the complete development spec.
> Read the whole spec before starting work, implement it in stages following the "Suggested development order", and make each stage runnable for verification when it is done.

---

## 1. Project goal

Build a Windows desktop widget: show live crypto price charts as "frameless, translucent, always-on-top small cards" (with the presence of a desktop pet / YouTube mini player: taking up no layout space and never stealing focus).

- Tech stack: **Electron + TradingView Lightweight Charts (use the v5 series) + Binance public market data API**
- Languages: HTML / CSS / JavaScript (TypeScript isn't required, but the files must be modular; don't cram everything into one file)
- Platform: Windows 10/11 first; avoid hard-coding platform-specific logic in the code where possible
- Not needed: trading features, technical indicators (MA/RSI, etc.), account login. **These are explicit non-goals; don't build them.**

## 2. Environment (already available to the developer)

- Node.js (LTS) and npm are installed
- Start the project with `npm init`; dependencies: `electron`, `lightweight-charts`, `electron-store` (settings persistence), and `electron-builder` for packaging in development
- The chart library **must be the local lightweight-charts files installed from npm**, not a CDN (after packaging the shell must start offline; only market data needs the network)

## 3. Core architecture

```
stock-card/
├─ package.json
├─ main/                  # Electron main process
│  ├─ main.js             # app lifecycle, single-instance lock
│  ├─ windows.js          # window/card management (two modes)
│  ├─ tray.js             # system tray menu
│  ├─ shortcuts.js        # global shortcuts
│  └─ store.js            # electron-store settings persistence
├─ preload/
│  └─ preload.js          # contextBridge exposes the IPC API
└─ renderer/
   ├─ card.html / card.js / card.css      # single chart card page
   ├─ board.html / board.js               # multiple cards in one window (Board mode) page
   ├─ chart.js            # lightweight-charts wrapper (create chart, switch type, feed data)
   ├─ datafeed/
   │  ├─ provider.js      # DataProvider abstract interface
   │  └─ binance.js       # Binance implementation (REST backfill + WebSocket live)
   └─ ui/                 # settings panel, symbol search and other components
```

Required security settings: `contextIsolation: true`, `nodeIntegration: false`, and all main process capabilities exposed as a whitelisted API through the preload's `contextBridge`. The renderer connects to Binance directly with the browser's native `WebSocket` and `fetch` (no relaying through the main process).

## 4. Window and card behavior (key features)

### 4.1 Two display modes, switchable from the tray menu; card settings (symbol, interval, chart type, opacity) must be kept across a switch

1. **Float mode (default)**: each chart = one independent frameless floating window, which can be dragged anywhere on screen and resized and given its own opacity individually.
2. **Board mode**: a single frameless transparent window that lays out multiple cards with CSS Grid inside; cards can be dragged to reorder within the grid and removed individually; the whole window can be dragged and resized.

### 4.2 BrowserWindow settings for each card window

```js
{
  frame: false,
  transparent: true,
  backgroundColor: '#00000000',
  alwaysOnTop: true,          // user-toggleable
  resizable: true,
  skipTaskbar: true,          // no taskbar entry, managed from the tray
  minWidth: 220, minHeight: 140,
  webPreferences: { preload, contextIsolation: true, nodeIntegration: false }
}
```

Known Electron pitfalls that must be handled:

- Transparent windows can't be maximized on Windows; don't offer maximize.
- Dragging: use `-webkit-app-region: drag` on the title bar area at the top of the card; every button, slider, dropdown and the chart area must be marked `-webkit-app-region: no-drag`, or they can't be clicked. The chart area must not be drag, or all crosshair interaction breaks.
- **Click-through mode**: `win.setIgnoreMouseEvents(true, { forward: true })`. While click-through is on, listen for the renderer's `mouseenter/mouseleave` (through IPC) so the small "turn off click-through" button stays clickable; also provide a global shortcut to force it off, so users can't lock themselves out.
- On window resize, use `ResizeObserver` to call the chart's `applyOptions({ width, height })`, or use `autoSize: true`.

### 4.3 Card UI (translucent glass card style)

- Card body: rounded corners, dark `rgba` background + `backdrop-filter: blur()` (if performance is poor, blur can be turned off, keeping only the rgba).
- **Opacity adjustment**: each card has its own 10%–100% slider, which adjusts the alpha of the card background rgba; text and chart lines stay fully opaque (an advanced "overall opacity" option using `win.setOpacity()` can be offered separately; the two are kept apart).
- Title bar (appears only on hover, hidden otherwise for minimalism): symbol name, current price, 24h change % (green up / red down, or switchable to red up / green down), settings gear, close button, always-on-top pin, click-through lock.
- Settings panel (opened with the gear, or a right-click menu):
  - Symbol search (autocomplete, data from Binance `exchangeInfo`, cached locally)
  - Interval: 1m / 5m / 15m / 1h / 4h / 1d
  - **Chart type switch: Candlestick / Line (close price line) / Area** — this is a required feature
  - Opacity slider, volume pane toggle (off by default), always-on-top toggle
- Empty state, loading state, disconnected state (a small red dot in the card corner + tooltip; no pop-ups to disturb the user).

### 4.4 Tray and shortcuts

- System tray: add card, switch Float/Board mode, show/hide all, always-on-top for all toggle, launch at startup toggle, quit.
- Global shortcuts (changeable in settings): `Ctrl+Alt+S` shows/hides all cards; `Ctrl+Alt+C` toggles click-through.
- `app.requestSingleInstanceLock()` prevents opening more than once.

## 5. Chart layer (lightweight-charts v5)

**Mind the version: the v5 API differs from v4.** Series are created in the form `chart.addSeries(CandlestickSeries, options)` (`addCandlestickSeries()` is the old v4 way; don't use it). Before implementing, check the types in node_modules or the official docs to confirm.

- `createChart(container, { layout: { background: { color: 'transparent' }, textColor: ... }, autoSize: true })` — the chart background must be transparent so that opacity is controlled by the card's CSS.
- Dark theme colors, faded grid lines (low alpha), smaller fonts on the time and price axes to suit a small card.
- How to switch chart type: remove the old series, create a new series, convert the cached kline data and feed it in with `setData()` (candle → line takes the close). Data is cached in the datafeed layer; switching chart type doesn't call the API again.
- Live updates use `series.update(bar)`: the same unclosed kline is updated repeatedly, and after it closes (`k.x === true`) the next message automatically becomes a new bar.
- Pause rendering updates while the window is hidden (still receiving data into the cache), and catch up in one go when it is shown, to save CPU.

## 6. Data layer (Binance, free, no API key)

TradingView itself offers no public data API, and lightweight-charts only draws charts, with data supplied by you; so market data always comes from Binance's public endpoints (spot):

- **History backfill (REST)**: `GET https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=500` → convert to `{ time: openTime/1000, open, high, low, close }` (lightweight-charts uses UNIX time in seconds).
- **Live (WebSocket)**: `wss://stream.binance.com:9443/stream?streams=btcusdt@kline_1m/ethusdt@kline_1m` (combined stream; **all cards share one connection**, and adding/removing cards adjusts it dynamically with `SUBSCRIBE`/`UNSUBSCRIBE` messages; don't open one connection per card).
- The kline event's `k` object: `t` (open time), `o/h/l/c/v`, `x` (whether the bar has closed).
- 24h change: subscribe to `{symbol}@miniTicker`, or call `GET /api/v3/ticker/24hr?symbol=...` once at startup and then update with miniTicker.
- Symbol list: `GET /api/v3/exchangeInfo`, taking the pairs with `status === 'TRADING'`, cached for 24 hours.
- **Connection resilience (required)**: Binance disconnects on its own after a connection has been up for about 24 hours, and sends pings (which need a pong; the browser's native WebSocket handles pong automatically, but close must still be handled):
  - After a disconnect, reconnect with exponential backoff (1s → 2s → 4s → capped at 30s); after reconnecting, resubscribe to all streams, and backfill the klines missed during the disconnect with REST before rejoining the live stream.
  - Show a small connection status dot in the card's top-right corner (green = live, yellow = reconnecting, red = disconnected).
- **DataProvider abstract interface (required)**: `getHistory(symbol, interval, limit)`, `subscribe(symbol, interval, onBar)`, `unsubscribe(...)`, `searchSymbols(query)`, `getTicker(symbol)`. Binance is the first implementation; the interface must be designed so a second provider (for example Taiwan stocks, Yahoo Finance) can be added later without touching the UI or chart layer.

## 7. Settings persistence (electron-store)

Save, and fully restore on restart:

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

- Write position/size changes with a debounce (500ms).
- On restore, check whether the bounds are still within any monitor (if the monitor layout changed, pull the card back into the visible area).

## 8. Packaging

- `electron-builder` produces a Windows NSIS installer + a portable build.
- `npm start` runs in development, `npm run dist` packages.
- A simple candlestick icon is enough for the app icon (a placeholder is fine at first).

## 9. Suggested development order (each stage verifiable on its own)

1. **Shell**: a single frameless transparent card window + a static candlestick chart with fake data; confirm dragging, resizing, the opacity slider and always-on-top all work.
2. **Data**: hook up Binance REST backfill + the live WS stream, a single BTCUSDT 1m card ticking live; implement reconnect on disconnect.
3. **Card features**: symbol search, interval switch, chart type switch (candlestick/line/area), 24h change display, volume toggle.
4. **Multi-card Float mode** + shared WS connection + settings persistence and restore.
5. **Board mode** + keeping settings across mode switches.
6. **Tray, global shortcuts, click-through, launch at startup, packaging.**

## 10. Acceptance criteria (all must pass)

- [ ] On startup, every card from last time is restored with its position, size, symbol, interval, chart type and opacity
- [ ] Cards have no browser/OS frame, the background is translucent and adjustable, and text and chart lines are sharp and opaque
- [ ] Candles tick live (on the 1m interval the last bar changes with every second's trades); after switching to line/area the data is continuous and live updates don't break
- [ ] With 4 or more cards open there is still only one WebSocket connection, and CPU usage is low (idle < single-digit %)
- [ ] Unplug the network manually for 30 seconds and restore it: reconnects automatically, the missing klines are filled in, no leftover error pop-ups
- [ ] With click-through on, clicks pass through to the desktop, and the shortcut turns it off
- [ ] Switching Float ↔ Board mode back and forth loses no card settings
- [ ] Closing a single card, hiding/showing all, and quitting from the tray all work, with no zombie processes

## 11. Non-goals (explicitly not to be built)

- Technical indicators (MA, RSI, MACD…), drawing tools, alert notifications
- Any order placement / trading / API key related features
- Scraping private data from the TradingView website (violates its terms of service; not done)
- macOS/Linux packaging (keeping the code portable is enough)
