**English** | [繁體中文](CHANGELOG.zh-TW.md)

# Changelog

What changed, newest first, grouped by when it landed. The app has not been versioned beyond 1.0.0 yet, so entries are dated; the commit history has the details.

## Unreleased

- Documentation reorganised: a short README, a user guide and design notes under `docs/`, every page in English and Traditional Chinese, CONTRIBUTING and this changelog.
- `npm run shots` remakes every documentation screenshot from a throwaway profile on the paper account.
- **Liquidations**: liquidations on Binance, Bybit and OKX marked on the bars that had the coin's largest (▼ longs forced out, ▲ shorts), recorded for every perpetual on screen; and on the right, an estimate of where the leverage opened in the last 30 days would be liquidated, with the nearest big pool each side named.
- **Long / short pane in context**: the share long instead of the raw ratio by default, the crowd's 7-day baseline and band, and bars for how much more (amber) or less (blue) long the crowd is than the 24h price change explains. The raw ratio stays as a unit in the menu.

## 2026-11-06

- **Long / short ratio pane**: the crowd's account ratio and the top traders' position ratio, on one linear scale with a line at 1.0. Perpetuals only.

## 2026-11-05

- **Stock and commodity perpetuals**: Binance's TradFi perpetuals (US stocks, ETFs, HK and Korean stocks, gold, oil, FX) appear in the perp search with a tag, and can be charted and traded. The order ticket says when the US market is closed and names the asset as TradFi on the confirm button.
- Stock perpetuals pair with their tokenized stock on spot (`SNDKUSDT` ↔ `SNDKBUSDT`).

## 2026-11-02 – 11-03

- **CVD pane**: taker buys minus taker sells, summed from the first bar or from each UTC midnight.
- **Order walls**: big resting orders drawn at their price from when they appeared, on one market's book or both, and marked when pulled before price got there.

## 2026-10-29 – 10-31

- **Big orders and the position read**: the top 0.5–0.01% of a coin's own taker orders as bubbles, and bars tagged as longs or shorts opening or closing from ΔOI and the taker side.
- **RSI and MACD panes**, computed as recursive filters and matching TradingView's.
- **Mini chart and ticker**: `Alt+M` / `Alt+T` shrink a card out of the way.
- **Split orders**: a limit order sent as up to ten equal orders at one price, to drag apart.
- **Fill notifications** when a resting order fills or a TP / SL triggers, even with no card on that symbol.
- A card can still be moved when Windows loses its title-bar drag region.

## 2026-10-25 – 10-28

- **English interface**, on by default, with Chinese one setting away.
- Watchlist of ten on `Alt+1` … `Alt+0`, reordered by dragging.
- **Volume alerts**: the same bell, clicked on the volume bars.
- Colours for levels, trend lines and rectangles; a switch to hide drawings without deleting them.
- The order ticket can size orders in coins as well as USDT.
- Higher-timeframe overlay in 1h, 4h, 1d or 1w, fifty candles of it.
- A clock to the second in the title bar; weekdays on the time axis.
- Volume drawn overlaid by default, in taker split or candle colours; zoom out to a tenth of a pixel a bar.
- Bars a quiet stream skipped are filled in, and a silent socket is replaced.
- **Shortcuts & tips window** (`F1`).
- Renamed to **TapeCard**, keeping its data folder.

## 2026-10-14 – 10-20

- **Paper trading**: a local account with your own balance, real fees, funding, slippage and liquidation, a journal and CSV export, replaying the time the app was closed.
- **Trend lines**; `Shift` straightens them; `Esc` returns to the cursor.
- Position reversal split into a two-press market button and a limit button, falling back to close-then-open when the margin can't take one order.
- Volume split into taker buys and sells, with thin volume marked.
- **Footprint chart**: taker sells and buys at each price inside each candle.
- Funding and the long / short ratios in the order ticket.
- Cached open-interest history re-checked against the exchange's corrections.

## 2026-10-08 – 10-13

- **Trading Binance USDⓈ-M perpetuals from the card**: order ticket, positions, TP / SL, testnet by default.
- Self-generated Ed25519 / RSA keys; leverage per symbol on the Binance account.
- Drag orders and TP / SL to reprice, restoring a stop that fails to move; reduce-only orders.
- Position bar docked under the chart; one-press reversal; a default order amount.
- **Price alerts** that fire with the cards hidden; the live price always shown; one-press view reset.
- **Fixed range volume profiles**; finer, two-tone rows for every profile.
- Previous day's, week's and month's opens.

## 2026-09-26 – 10-05

- **Open interest** shown and recorded on perpetual cards.
- Volume and OI panes toggled from the toolbar.
- **Range alerts**: where the price sits in its 4H / 24H / 72H volume distribution, per watchlist symbol, with a master switch and per-symbol switches.
- Highest and lowest price on screen tagged.
- **Opens and highs / lows** of the day, week and month, anchored to UTC, New York, London, or the NYSE or LSE open.
- `--trace-windows` to diagnose a card that vanishes; a pinned card comes back on top when clicked.

## 2026-09-23 – 09-25

- TradingView-style crosshair: free by default, `Ctrl` snaps to OHLC.
- Horizontal levels, Shift-drag measure, Fibonacci retracements, rectangles, `Ctrl+Z` undo, and a toolbar to hold them.
- Chart times in a chosen time zone.
- **Session volume profile**: per 4H session, visible range or today.
- **Bar cache on disk**, chunked by month or year, with history backfilled as you scroll.
- Higher-timeframe overlay drawn inside the chart.
- Price axis scaling, free panning and a reset button.
- **Watchlist** in the title bar.
- **Spot and USDⓈ-M perpetual** on one card, one click apart.
- Cards minimized from outside come back; always-on-top restored when Windows strips it.

## 2026-08-24 – 08-31

- **First version (StockCard)**: transparent, frameless, always-on-top desktop chart cards for Binance spot, in Float and Board modes, with one WebSocket for every card.
- Trades streamed for 100ms price updates, and a status dot when the feed drops.
- Fixes for a card vanishing, a crash on exit and lost always-on-top.
