**English** | [繁體中文](architecture.zh-TW.md)

# Architecture

How the app is put together: the processes, where each file lives, and the two decisions that shape everything else, a hidden hub window that owns every connection and an `app://` protocol instead of `file://`.

## Processes

```
                   ┌───────────── main process ──────────────┐
                   │ windows, tray, shortcuts, settings,     │
                   │ bar / footprint cache, alerts, trading  │
                   └──┬─────────────┬───────────────────┬────┘
                 IPC  │             │ IPC               │ HTTPS (signed orders)
         ┌────────────┴───┐   ┌─────┴─────────┐         ▼
         │ card windows   │   │ hub (hidden)  │     Binance REST
         │ chart + UI     │   │ every socket  │
         └────────────────┘   └─────┬─────────┘
                                    │ WebSocket + REST (public market data)
                                    ▼
                                 Binance
```

- **Main** (`main/`): window lifecycle, the tray and global shortcuts, the settings file, the bar and footprint caches on disk, alert delivery, and trading: keys, signing, the REST client, the user data stream and the paper exchange.
- **Hub** (`renderer/hub.js`): a hidden, persistent renderer that owns every market-data connection and every background job (OI polling, range alerts, price alerts, footprint, big-order and order-book collection).
- **Cards** (`renderer/card.js`, `renderer/board.js`): one window per card in Float mode, one window for all of them in Board mode. They draw; they ask the hub for data over IPC.

## Why there is a hidden hub window

Two requirements pull against each other: the renderer should talk to Binance with the browser's own `fetch` and `WebSocket`, and there should be **one connection no matter how many cards are open**. In Float mode each card is a separate renderer process, so cards opening their own sockets would mean one connection per card.

So the connections live in a hidden renderer, and cards subscribe through it:

```
card --invoke--> main --send--> hub --(WebSocket)--> Binance
card <--send---- main <--send-- hub
```

Spot and perpetuals are on different hosts and can't share a socket, so the rule is **at most one per market**: the perp socket isn't opened while no card shows a perp, and the spot socket closes when every card has moved to perps. (Order books are the exception: Binance serves the perpetual depth stream only on `/public/stream`, so books have a socket of their own; see [Data sources](data-sources.md).) Streams are reference-counted, so a second card on the same symbol, or the higher-timeframe overlay's own subscription, adds a stream to the existing socket, not a connection. With four cards open, `Get-NetTCPConnection` shows one connection on 9443.

The hub is also where anything that must keep running with every card hidden or closed lives: price and volume alerts, range alerts on the watchlist, OI recording and fill notifications.

## Why `app://` and not `file://`

Chromium won't load ES modules from `file://`: it is an opaque origin and CORS blocks it. The usual workaround, `webSecurity: false`, throws away the security settings. So the renderer is served from a registered standard, secure `app://` protocol (`main/protocol.js`): module imports, a secure context and WSS all work, with `contextIsolation: true`, `nodeIntegration: false` and `sandbox: true` kept. The only bridge between page and main is the allowlisted API in `preload/preload.js`.

## Interface language

The Chinese source strings stay in the code as the keys. `t('…')` (`renderer/i18n.js`, `main/i18n.js` for the tray and notifications) looks the English up in `renderer/i18n/en.json` and falls back to the Chinese when a string is missing, so the Chinese interface can't be broken by a missing translation. `npm run check` (`scripts/check-i18n.mjs`) verifies that every displayed Chinese string goes through `t()`, has an English entry, and uses the same `{placeholders}` on both sides. New keys are appended to `en.json`; existing ones are never re-sorted or rewritten.

## Files

```
main/                   Electron main process
  main.js               lifecycle, single-instance lock, every IPC handler
  windows.js            Float / Board windows, always-on-top, click-through, show / hide
  store.js              settings (electron-store) and screen-bounds correction
  tray.js, shortcuts.js system tray menu, global shortcuts
  protocol.js           the app:// protocol
  i18n.js               interface language for main-process text
  alerts.js             alert delivery: card glow, Windows notification, taskbar flash
  bar-store.js          bar cache: fixed-width binary, chunked by time
  footprint-store.js    footprint cache: one gzip member per minute, last 12 hours
  trading/
    rules.js            signing, rounding to exchange rules, liquidation estimate
    client.js           Binance futures REST client
    stream.js           user data stream
    vault.js            DPAPI-encrypted keys
    service.js          trading state and order flow, shared by live, testnet and paper
    paper.js            the paper exchange, answering Binance's API
    paper-engine.js     paper bookkeeping: fills, fees, funding, liquidation, replay
preload/preload.js      contextBridge: the allowlisted API pages may call
renderer/
  hub.html / hub.js     hidden window: every socket and background job
  card.*, board.*       Float-mode card page, Board-mode page
  cardview.js           the card component, shared by both modes
  chart.js              Lightweight Charts v5 wrapper
  guide.*, journal.*    shortcuts & tips window (F1), paper-trading journal
  i18n.js, i18n/en.json t(): Chinese key -> English
  datafeed/
    provider.js         the DataProvider interface
    binance.js          Binance: REST backfill, WebSocket live data, reconnects, symbol mapping
    remote.js           the card-side provider, forwarding to the hub over IPC
    footprint-collector.js, sweep-collector.js, order-book.js
                        hub-side collectors: footprint, big orders, order-book walls
  *-primitive.js        things drawn inside the chart: Fib, rectangles, trend lines,
                        volume profiles, opens, walls, big orders, the live price, ...
  volume-pane.js, oscillator-pane.js   volume, RSI / MACD / CVD panes
  indicators.js, cvd.js, volume-stats.js, volume-profile.js, footprint.js,
  flow-read.js, open-interest.js, long-short.js, sessions.js, position.js
                        the arithmetic behind those, without drawing
  alert-monitor.js, price-alert-monitor.js   hub-side range and price / volume alerts
  ui/                   settings panel, symbol search, toolbar, watchlist, trading settings
  trade/                order ticket, position bar, order lines, reverse panel,
                        long / short bias, TradFi note, environment badge
scripts/                tests, syntax and i18n checks, icon generation, vendor sync,
                        README screenshots
```

## Changing the data source

`renderer/datafeed/provider.js` defines what the chart and UI need:

```js
getHistory(symbol, interval, limit)   // -> Bar[]  { time (sec), open, high, low, close, volume, closed }
subscribe(subId, symbol, interval, { onBar, onTicker, onFunding })
unsubscribe(subId)
searchSymbols(query)                  // -> SymbolInfo[]
getTicker(symbol)                     // -> { symbol, last, changePercent, high, low, volume }
```

To chart Taiwan or US stocks from another source, write a second implementation and swap `new BinanceProvider()` in `renderer/hub.js`; the chart and UI layers don't change. (The order-flow tools rely on data only Binance-style crypto venues publish, such as taker-buy volume and aggTrades, and would need their own source.)

## Tests

`npm test` runs eleven suites in `scripts/test-*.mjs`, covering among others disconnect / reconnect / backfill, the bar cache, trading rules and rounding, the paper engine, thin-volume ranking, the footprint, RSI / MACD against full recomputes, CVD, the long / short ratio, order flow, order walls and price alerts. None of them touch the network or a real account. `npm run check` is the syntax check of the whole tree plus the i18n check.
