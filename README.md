**English** | [繁體中文](README.zh-TW.md)

# TapeCard

*Formerly StockCard.* Crypto chart cards for short-term trading, run from the keyboard: transparent desktop ticker cards. Frameless, translucent, optionally always-on-top, showing live crypto charts, with one-click switching between spot and USDⓈ-M perpetual futures.

**Electron 43 + TradingView Lightweight Charts v5 + Binance public market data API** (no sign-up, no API key)

![A perpetual card: candles with the 4H overlay, opens, a trend line and levels, a paper long with its TP / SL and a resting limit order, the volume split into taker buys and sells, and the toolbar on the left](docs/images/overview.png)

| Order ticket | Footprint |
| --- | --- |
| ![The order ticket: limit price, amount, TP / SL with their PnL, funding and the long/short ratio, estimated liquidation](docs/images/order-ticket.png) | ![Footprint: taker sells and buys per price inside each 1m candle, the POC boxed, delta along the bottom](docs/images/footprint.png) |

**Interface language:** the app starts in English. To switch to Traditional Chinese, open a card's settings (gear icon) and, in "Global settings", set the "語言 Language" row to "中文"; the windows reload. The UI labels quoted below are the English ones; the original Chinese label is given in parentheses where it helps.

---

## Quick start

```bash
npm install       # also copies lightweight-charts into renderer/vendor/
npm start         # run
npm run dev       # run, piping the renderer console to the terminal
npm test          # tests: datafeed (disconnect / reconnect / backfill), bar cache, trading rules,
                  # paper engine, thin-volume ranking, footprint
npm run check     # syntax check of the whole tree + i18n check (scripts/check-i18n.mjs)
npm run dist      # build a Windows installer + portable build -> release/
```

On first launch a BTCUSDT 1-minute candlestick card opens automatically.

## Shortcuts & tips

Press **`F1`** on any card (or the **?** in its title bar, or tray menu → "Shortcuts & tips") for a one-page cheat sheet of every key and gesture, grouped by what you are doing: reading the chart, drawing, symbols & alerts, trading and windows. Type to filter it. The two global shortcuts show as you have set them.

![The shortcuts & tips window](docs/images/guide.png)

The ones worth learning first:

| Keys | Does |
| --- | --- |
| `Alt+1` … `Alt+0` | Switch to watchlist entry 1–10 |
| Double-click the chart | Add a horizontal line (`Ctrl` snaps to OHLC) |
| `Shift` + drag | Measure price, % and time |
| `Alt+A` | Price alert at the cursor |
| `Alt+R` | Reset the view to the latest bar |
| `Alt+H` | Hide / show all drawings |
| `Alt+M` / `Alt+T` | Shrink the card to a mini chart / to the price alone (again to restore) |
| `Ctrl+Z` | Undo a drawing change |
| `Esc` | Back to the cursor; cancels a drag or a half-drawn line |
| Long / Short, then `Enter` | Send the order (within 3 seconds) |
| `Ctrl+Alt+S` | Show / hide every card (global) |

## Usage

| Action | How |
| --- | --- |
| Move a card | Drag the top of the card (the title bar only appears on hover) |
| Resize | Drag the diagonal grip in the bottom-right corner |
| Visible high / low | The highest and lowest points currently on screen are labeled with their price automatically (candles use high / low; line and area charts use close), updating live as you scroll or zoom |
| Read a price | The crosshair follows the cursor; the price axis on the right shows the price under it |
| Zoom time | Mouse wheel on the chart, or drag the time axis below. Zooming keeps the right edge where it is, as on TradingView. Zoomed all the way out a candle is a tenth of a pixel, little more than its high-low line, so a wide card shows about a month of 5m bars; older history loads in pages as wide as the screen until the view is filled |
| Zoom price | **Mouse wheel** or **drag up/down** on the price axis on the right. Stretching it turns autoscale off, after which dragging on the chart pans freely in any direction. **Double-click the price axis** to turn autoscale back on |
| Reset view | After you move the view, a reset button appears where the two axes meet; or press `Alt+R`. Restores autoscale and the default bar width and jumps back to the latest bar **in one step** (however far back you have scrolled) |
| Last price | The price label and dashed line on the price axis always show the **latest** bar's price, even while you look at history. When the last price is off screen, the label is pinned to the top or bottom of the price axis as `▲ price` / `▼ price` |
| Snap to OHLC | Hold `Ctrl` and the crosshair snaps to the open/high/low/close **nearest the cursor** — the high above the bar, the low below it |
| Add a support/resistance line | **Double-click** empty space on the chart. Double-click with `Ctrl` held to snap to the nearest OHLC |
| Move / delete a line | Drag the line itself to move it (hold `Ctrl` to snap); **double-click the line** to delete it |
| Spot / perp | Click the "Spot" / "Perp" tag to the right of the symbol name in the title bar to switch between the spot market and the perpetual contract of the same coin; the "Market" setting in the settings panel does the same. Differently named pairs are mapped automatically (spot `PEPEUSDT` ↔ perp `1000PEPEUSDT`); if the other market has no such pair, the tag turns gray and clicking it explains why |
| Funding rate | On perp cards, the top-right of the chart (left of the price axis) shows the current funding rate and a countdown to the next settlement, updated every second |
| Open interest (OI) | Click the **OI** icon in the left toolbar (or tick "Show open interest (OI) pane · Perp" in the settings panel) and perp cards get an orange OI pane underneath (in coins, e.g. `94.90K` BTC), updated with the exchange roughly every 3 seconds. Spot cards keep the setting and show the pane again when switched back to perp |
| Watchlist | The ☆ left of the symbol name in the title bar adds the current symbol to the watchlist (up to 10, shared by all cards). The list remembers the market: spot and perp of the same coin are two rows, with the perp row marked. Click the **symbol name** to open the list with live prices and 24h change; click a row to switch to it (market included); hover a row and click ✕ to remove it |
| Quick symbol switch | `Alt+1` – `Alt+9` switch to watchlist entries 1–9 and `Alt+0` to the 10th (keyboard order along the number row, so the first entry sits on the handy 1), market included (applies to the card clicked last). The digit at the left of each row in the list is its shortcut |
| Pick a tool | Hover the card and a toolbar slides out on the left: cursor, horizontal line, trend line, price alert, measure, Fib retracement, rectangle, volume profile, fixed range volume profile, hide drawings, higher-timeframe overlay, Opens, Highs/Lows, volume, footprint and OI (OI on perp cards only). Click the same drawing tool again to deselect it. `Esc` returns to the cursor at any time (and also cancels a half-drawn trend line) |
| Range alerts | For symbols in the watchlist (☆), the top-left of the chart shows where the current price sits in the **4H / 24H / 72H** volume profile, e.g. `4H 17 · 24H 34 · 72H 23` (orange at 80%+, red at 95%+, light blue at 20% and below, blue at 5% and below). When a configured level is hit, the card border glows, a Windows notification pops up and the taskbar flashes; **click the card** to clear it. Choose the levels in the checkbox grid under "Range alerts" in the settings panel |
| Alert switches | **Tray right-click → "Range alerts"** is the master switch; **"Alert symbols"** lets you tick symbols one by one. You can also toggle 🔔 / 🔕 on each row of the symbol list (click the symbol name). A notification only fires when both the master switch and that symbol are on; muted symbols still show their percentages, and alerts missed while muted are not replayed when you turn them back on |
| Opens | The toolbar icon with **three lines pointing right**; click it to choose when a day starts: **UTC 00:00** (the exchange's candle boundary), **New York 00:00**, **NYSE open 09:30**, **London 00:00**, **LSE open 08:00**, or off. The menu shows each converted to Taiwan time (tracking daylight saving). Draws solid daily-open (teal), weekly-open (purple) and monthly-open (pink) lines extending right from the opening bar, with matching labels on the price axis. Lines off screen are pinned to the top or bottom right as "↑ Monthly open 92,500 +10.3%". The "Show" section in the lower half of the menu picks **Current**, **Previous** (previous day / week / month open, the same boundary shifted back one period), or **Both** |
| Highs/Lows | The toolbar icon with **two dashed lines, one above the other**: **Previous** (previous day / week / month high and low, dashed), **Current to date** (dotted, following live prices), or both. Lines start at the bar that set the high or low and extend right, using the same session boundary as Opens. The settings panel lets you choose the boundary and draw only some of daily, weekly and monthly |
| Pane toggles | Two toolbar icons near the bottom: the **bars** icon opens the volume menu (Off / Show volume, plus "Color", "Position", "Thin volume PR ≤" and "Distribution lookback"). **Color**: "Taker buy / sell split" stacks taker buys (bottom) under taker sells (top); "Candle color" draws each bar whole in its candle's red or green. **Position**: "Overlaid on the chart" (the default, as on TradingView, so the candles keep the card's full height) or "Separate pane". Thin-volume bars are drawn grey. **OI** toggles the open interest pane (perp cards only). The on/off switches are the same settings as the toggles in the settings panel |
| RSI / MACD | Two toolbar icons under OI. **RSI** (a line between two dashed bounds) opens a menu: Off / Show RSI, and the length 7 / 14 / 21; the pane is fixed at 0–100 with dashed lines at 70 and 30. **MACD** (a histogram under a line) toggles a 12 / 26 / 9 pane: the MACD line (blue), the signal (orange) and the histogram, bright while it grows away from zero and dim while it shrinks. Both follow the live price tick by tick and match TradingView's built-ins. Several sub-panes share at most half the card, so the candles keep the majority |
| Measure a range | Hold `Shift` and drag to show the price difference, percentage, bar count and duration. Add `Ctrl` to snap to OHLC |
| Clear a measurement | The readout stays after you release; click empty space or press `Esc` to clear it |
| Draw a Fib retracement | Pick Fib retracement in the toolbar and drag on the chart to draw the swing. Drag the end dots to adjust; double-click a dot to delete |
| Volume profile | Click the volume profile icon in the toolbar to open a menu on the right: Off / Per 4H session / Visible range / Today (UTC). **Detail** in the lower half of the menu sets each row's height on screen: Coarse 10px / Normal 6px / Fine 4px / Ultra fine 2px. Zooming in on the price axis adds rows, so you see a finer distribution |
| Fixed range volume profile | Pick "Fixed range volume profile" in the toolbar (the icon with horizontal bars between two dashed lines) and **drag left/right** on the chart to select x1 to x2 — only time counts, not mouse height. The tool switches back to the cursor when you finish. The range shows a volume profile (**teal for buys, red for sells**, value area brighter), the POC (solid orange) and VAH / VAL (dashed); the label above shows the length, total volume and which bars it was computed from. Drag to the latest bar for **to now**, updated every minute. **Drag the left/right edges** to adjust, **drag the label** to move, **double-click** an edge or the label to delete; `Ctrl+Z` undoes. Saved per symbol like rectangles, shared between spot and perp (each uses its own market's volume) |
| Footprint | The **footprint** toolbar icon (a vertical line with a row of bars on each side) → "Show footprint". Each candle shows per-price **taker sells (left, down color)** and **taker buys (right, up color)**; candles become hollow, an orange box marks the candle's highest-volume price (POC), and the bottom of the chart shows each candle's **Delta** (taker buys − taker sells). Below 72px bar width it draws two rows of bars; zoomed in to 72px or more, each row shows `sell buy` numbers with shading for volume. **Imbalances** (diagonal comparison: a price's taker buys ≥ N × the taker sells one tick below, or taker sells ≥ N × the taker buys one tick above) are drawn solid or bold; choose 2 / 3 / 4× in the lower half of the menu. "**Zoom to last 30 bars**" in the menu fills the screen with the last 30 bars in one click. Covers the last 30 bars (up to 6 hours); when turned on it loads from disk and backfills the missing last 3 hours from the exchange, newest first. Bars not yet fully backfilled are drawn faded, with `~` before the Delta |
| Higher-timeframe overlay | The "Higher-timeframe overlay" toolbar icon (two candles) opens a menu: Off / **1H / 4H / 1D / 1W (7 days)**. Overlays the last 50 candles of that interval as translucent boxes on lower-timeframe charts; the unclosed one has a dashed outline and reshapes with live prices. 1D and 1W follow Binance's UTC days and weeks (a week opens Monday 00:00 UTC). The choice is per card |
| Draw a rectangle | Pick rectangle in the toolbar and drag to draw a price zone with a start and end time. **Drag the border** to move, **drag a corner** to resize (the opposite corner stays fixed), **double-click** to delete. Holding `Shift` while dragging locks the direction: a corner changes only the width (time) or only the height (price), the border moves only horizontally or only vertically, depending on which way the mouse has moved more. The inside is deliberately not grabbable, so you can still pan the chart from inside the box |
| Draw a trend line | Pick **trend line** in the toolbar (the diagonal icon): **drag** from one point to another, or **click** each endpoint (the line follows the mouse in between; `Esc` cancels). A solid segment between the two points, not extended into a ray. `Ctrl` snaps to OHLC; holding `Shift` draws a **horizontal or vertical line** (whichever way the mouse has moved more; also applies when dragging an endpoint or the line body, and with the trend line tool selected `Shift` no longer measures). **Drag an endpoint** to adjust, **drag the line body** to move the whole line, **double-click** to delete, `Ctrl+Z` to undo. Saved per symbol and stays at the same time and price when you change timeframes |
| Price alert | The **bell** in the toolbar, then click a price on the chart (`Ctrl` snaps to OHLC); or press `Alt+A` with the mouse over the chart. A price above the current price is a "Rose to" alert, below it a "Fell to" alert. A gold dashed line is drawn; **drag the label** to change the price, click ✕ to delete |
| Volume alert | Same bell (or `Alt+A`), but click **on the volume bars** instead of the candles — while the bell is armed a gold tag shows the level under the mouse. It fires the first time **one bar** of the card's current interval reaches that volume (in USDT), then is removed. Set below the open bar's volume, it waits for the next bar. The line shows only on the interval it was set on; drag its label to change it, ✕ to delete |
| Price alert notifications | Watched by the hidden data window, so **they fire even when cards are hidden with `Ctrl+Alt+S` or closed**; only symbols with alerts are watched. When the price is reached, a Windows notification is sent (silently) and the taskbar flashes (following the range alert notification settings); each alert fires once and is then removed |
| Drawing colors | **Right-click** a horizontal line, trend line or rectangle for a row of colors: default blue, **green** (support), **red** (resistance), orange, yellow, purple and white, e.g. one color for a weekly level and another for an intraday one. The current color is ringed. The color is saved with the drawing (it stays across restarts and intervals, on spot and perp alike), and `Ctrl+Z` undoes a change. Right-clicking anywhere else still opens the settings panel |
| Hide drawings | The **eye** icon in the toolbar (or `Alt+H`): hides all horizontal lines, trend lines, Fib retracements, rectangles and fixed range volume profiles at once for a clean chart; press again to bring them all back. They are only **not drawn**, not deleted, and the state is saved in the card settings (still hidden after a restart). Hidden lines can't be grabbed, so you won't drag a line you can't see; picking up a drawing tool, adding a horizontal line or pressing `Ctrl+Z` while hidden shows them again, so a new line doesn't vanish as soon as you let go. Price alerts, position / order lines, Opens and Highs/Lows are not drawings and stay visible |
| Shrink a card | With a card active, `Alt+M` shrinks it to a **mini chart** of the last 5 candles with the price (no time axis, volume or OI), `Alt+T` to a **ticker** strip with just the symbol, live price and 24h change. The same key again, or the **⤢** that shows on hover, brings the full card back where it was. Each small form remembers where you last dragged it, and the form survives a restart. Float mode only |
| Undo | `Ctrl+Z` undoes adding, moving and deleting horizontal lines, trend lines, Fib retracements, rectangles and fixed range volume profiles (e.g. a line dragged by accident while dragging the time axis). Each card keeps its own history; switching symbols clears it |
| Shortcuts & tips | `F1` on a card, the **?** in the title bar, or tray menu → "Shortcuts & tips" |
| Open settings | The gear button, or right-click the card |
| Close settings | `Esc`, right-click again, or the ✕ in the top-right of the panel |
| Clock | The title bar shows the time to the second (`HH:MM:SS`) in its center, in the same time zone as the chart (settings → "Time zone"); it ticks on the system clock's second. Settings → Global settings → "Title bar clock": **Always** (the default — readable at a glance without touching the card), **On hover** (with the rest of the title bar), or **Off**. While the title bar is shown on hover, the clock moves into the gap between the symbol and the price if the center is taken, and steps aside on a card too narrow for any gap (around 450px and below) rather than cover them |
| Show/hide all | `Ctrl+Alt+S` (the default; both global shortcuts, this and click-through's `Ctrl+Alt+C`, can be changed under Global settings), or left-click the tray icon. If any card is missing (e.g. minimized by another program), one press always **shows**, never hides the other cards first |
| Toggle click-through | `Ctrl+Alt+C`, or the tray menu |
| Switch Float / Board | Tray menu → "Display Mode" |
| Add / remove cards | Tray menu, or the ＋ in the Board mode title bar |

The crosshair deliberately behaves like TradingView's: it follows the cursor freely, magnet mode only kicks in with `Ctrl`, and it snaps to the nearest OHLC rather than just the close (lightweight-charts' `CrosshairMode.MagnetOHLC`). Use it for drawing support/resistance or lining up with wicks.

**Time zone** follows the local time zone by default (settings panel → "Time zone" switches between Local / Taipei / UTC). Binance timestamps are UTC epochs and lightweight-charts formats in UTC by default, so without this setting the axis would read 8 hours behind Taipei. This changes the **formatting**, not the timestamps — timestamps are also what the datafeed uses to dedupe backfills (`lastBarTime`) and to update the unclosed bar, so shifting them would mean touching the data layer for cosmetics. The one thing that can't be fixed is `1d`: Binance daily candles use UTC day boundaries, so in UTC+8 they are labeled 08:00. That's how the exchange splits days, not a display bug. Each new day on the time axis carries its weekday (`Sun 25`, `25日 週日` in Chinese), and the crosshair label shows the full date with it (`Sun, Oct 25, 15:25`).

**Interface language**: English by default; settings panel → Global settings → "語言 Language" switches between 中文 and English. The cards, the board and the journal reload; the market connections in the background stay up. The Chinese source strings stay in the code as keys: `t('…')` looks the English up in `renderer/i18n/en.json` and falls back to the Chinese when a string is missing, so the Chinese interface is unaffected. `npm run check` verifies that every displayed Chinese string goes through `t()`, has an English translation, and uses the same `{placeholders}` on both sides.

The **higher-timeframe overlay** only appears on intervals below the one chosen (4H on 1m–1h, 1D on up to 4h, and so on) — on a chart of the same interval the box is the candle itself. The unclosed box is fed by **a separate subscription on that interval** rather than aggregated from the card's own bars: the card may be on 1m, where 500 bars cover only 8 hours, and the exchange's own candles are the authoritative values anyway. Hub streams are reference-counted, so an extra subscription for the same symbol adds only one more kline stream, not another connection.

**History cache**: when you scroll left close to the edge of the loaded data, older bars are fetched in the background — local cache first, then the API — and everything fetched is written to the cache. Files live in `userData/bars2/{SYMBOL}/{interval}/{chunk}.bin` (perps in `userData/bars2/_perp/...`, since BTCUSDT has the same name in both markets but different bars; open interest is stored here too, see below), fixed-width binary, 64 bytes per record (eight float64s: `time, open, high, low, close, volume, buyVolume, quoteVolume`, i.e. the taker-buy volume and the volume in USDT). Records used to be six fields wide; the wider format moved to `bars2` and the old `bars` folder is deleted. 1m / 5m are split by **month**, everything else by **year** — backfilled older data goes into different files, so each file is only ever appended to and always sorted internally: **no global sort, no rewriting the whole history**. Only closed bars are written: the last bar Binance returns is always unclosed, and caching it would freeze half a candle forever. Measured on the same range: cache 7.4ms vs network 142ms (**19×**), identical content.

**Open interest (OI)** has no WebSocket on Binance, only REST snapshots (the exchange updates them every 2–5 seconds) and history at 5-minute resolution at best, going back at most 30 days. The 1-minute OI you see on CoinGlass is simply recorded continuously by them; this app does the same and stores two series, both reusing the bar cache's format and file layout:

| Series | File | Source | Writer |
| --- | --- | --- | --- |
| `oi_1m` | `bars2/_perp/{SYMBOL}/oi_1m/{YYYY-MM}.bin` | The hub takes a snapshot every 3 seconds and rolls each minute into one OHLC record (the volume field holds the sample count) | Only the hub — written once even if several cards show the same symbol |
| `oi_5m` | `bars2/_perp/{SYMBOL}/oi_5m/{YYYY-MM}.bin` | The exchange's 5-minute history, one sample per record (the volume field holds the USD value) | Cards fill the gap since last time when they load; once per launch the whole range is also re-checked (see below) |

- 15m, 1h, 4h and 1d are **not stored separately**; they are computed at display time by merging the two series and bucketing by timeframe (`renderer/open-interest.js`). Where the 1m chart has no recording of its own, it fills in from the surrounding 5m samples; if two samples are more than 10 minutes apart (e.g. the app was closed and it's more than 30 days ago) it leaves a gap instead of drawing a flat line that was never measured.
- As long as a perp card is open, OI for that symbol is recorded **whether or not the OI pane is on**, so the history is there as soon as you open the pane.
- The 5m history only fills gaps: in testing, the second launch made a single request covering 5 minutes. So as long as you open the app at least once every 30 days, the cache **grows beyond the exchange's 30 days**.
- **The exchange rewrites history**: on 2026-10-15 this history endpoint returned bad data for several hours (ETH OI dropped from 2.31M to around 1.9M, then samples appeared every second or two, off the 5-minute grid). Binance corrected it afterwards, but the cache had already stored the bad version, and gap-only filling would never ask for that stretch again. So now: (1) samples not on the 5-minute grid are never stored or read; (2) after each launch, the first time a symbol's OI pane finishes drawing, the full 30 days the exchange still has are fetched in the background and compared, and any differences are overwritten with the exchange's version (`replace` in `bar-store.js`, which also clears bad samples sandwiched in between); cache older than 30 days is left alone. 30 days is 18 requests, and this endpoint has its own quota (1000 per 5 minutes), so it doesn't affect order placement. If the exchange returns less than 90% of the samples, nothing is overwritten, so a single failure can't wipe the cache.
- Note: this history endpoint always returns the **latest** 500 records in the range no matter how early `startTime` is, so you have to page from newest to oldest (in testing, asking for 10 days returned only the last 41 hours).
- Size: `oi_1m` is about 92KB per symbol per day (same as 1m bars), `oi_5m` about 18KB per day.

You can choose where a "day" starts for **Opens and Highs/Lows**:

| Option | Day starts at | Taiwan time (summer / winter) |
| --- | --- | --- |
| UTC 00:00 | The exchange's candle boundary | 08:00 |
| New York 00:00 | New York midnight (midnight open) | 12:00 / 13:00 |
| **NYSE open** | New York 09:30 | **21:30 / 22:30** |
| London 00:00 | London midnight | 07:00 / 08:00 |
| **LSE open** | London 08:00 | **15:00 / 16:00** |

8:30 PM (summer, Taiwan time) is when US economic data is released (New York 08:30), not the NYSE open. The UK and US change clocks on different dates (in 2026: UK 10/25, US 11/1), and in the week between, the two opens are only 5.5 hours apart; all of this is computed by `Intl` from the time zones, with no hard-coded offsets (`renderer/sessions.js`, covered by tests). **Weekends count as days** (crypto trades on weekends), so Saturday also rolls over at 09:30; weeks start on Monday and months on the 1st at the same time; public holidays are not treated specially.

The data comes from bars whose boundaries line up exactly with the options above: the NYSE open at 09:30 isn't on the hour, so it uses **30-minute bars**; everything else falls on a UTC hour and uses 1-hour bars. The open of the boundary bar is the opening price, and the extremes of the bars within a period are the highs and lows; data is fetched from the start of the previous month (about 2–3 requests) and refetched automatically at each new day boundary.

Line styles: **color means period** (daily teal, weekly purple, monthly pink), **line style means type** (opens solid, previous-period opens dash-dotted, previous-period highs/lows dashed, current-period highs/lows dotted), with labels such as "Prev day high" or "Week low" at the start, plus "NY" or "LDN" when not on UTC. They are deliberately distinct from your own horizontal lines (gray-blue dashed lines spanning the whole chart). Lines at the same price merge into one, e.g. "Daily open · Weekly open" on Monday, or "Daily open · Day high" on a day that only went down. Off-screen lines show only the nearest 4, pinned to the top right and bottom right.

The **range alert** percentage is "what share of this period's volume traded below the current price", counted directly from the volume profile **with no distribution fitting at all**. This was chosen after measuring: on 30 days of 1m bars for BTC and ETH perps, assuming a normal distribution from VWAP and standard deviation was off from the actual cumulative share by 4 percentage points on average and by about 10 points in the worst tenth (an actual 70% would be reported as 80%); and real 24H / 72H profiles are mostly not unimodal (choosing 1–3 Gaussians by BIC mostly picks 3). Counting directly needs no shape, so it can't get the shape wrong.

- **Real time**: the profile is recomputed every time a 1m bar closes; the current price is checked against it using live quotes (as fast as every 100ms), so an alert fires when the price **touches** a level, not at the close. In testing, checking only closes missed 15–30% of touches.
- **Hysteresis (like a Schmitt trigger)**: each level fires once; the upper levels (80/90/95) re-arm only after going back **below 50%**, the lower levels (20/10/5) after going back above 50%. Jumping past several levels at once reports only the furthest; if the app starts with the price already at 92%, it doesn't immediately fire 80 and 90.
- **Default levels and measured frequency** (per symbol per day): all six levels for 24H and 72H, about 8.5 and 2.7 times; only **5% and 95%** for 4H, about 11 times — all levels on 4H is about 45 a day, too noisy.
- **Monitored in the background by the hub**: watchlist symbols are monitored even with no card open, keeping 72 hours of 1m bars per symbol (about 5 requests at startup).
- **Note: this is not an entry signal.** In the same data, the probability of a decline over the next 4 hours after price is above 90% was 44–57%, with no consistent direction across the two coins and three windows. Its purpose is to tell you "where in the distribution you are now", so you don't chase at the worst spot without noticing.
- **How notifications reach you**: no sound (by request). The card glow is visible over games in borderless windowed mode; Windows notifications are routed to the notification center by Focus Assist while gaming (in testing, with Warcraft III running there was no banner, but it was in the notification center); while the taskbar flashes, the card temporarily gets a taskbar button, and clicking the card stops it. **None of the three are visible in a full-screen game**; see case G in [docs/vanishing-cards.md](docs/vanishing-cards.md).

**Volume profile** has three modes, switched from the toolbar icon's pop-up menu:

| Mode | Contents |
| --- | --- |
| Per 4H session | Each 4H block gets its own profile and POC, growing left to right inside its own time block. Blocks align to UTC 0/4/8/12/16/20, the same boundaries as the exchange's 4h candles. Only shown on timeframes below 1h |
| Visible range | Only the bars visible on screen, drawn against the right edge and recomputed live as you pan and zoom |
| Today (UTC) | UTC 00:00 to now, drawn against the right edge |

All three are drawn by the chart itself (a series primitive), in the same frame as the candles, so resizing the card doesn't lag. Per 4H session mode is built from 5m bars: closed blocks are computed once and cached, and the block in progress is updated every minute.

The **fixed range volume profile** (TradingView's Fixed Range Volume Profile) is for "key zones": 4H, today and visible range are all ranges decided by the clock, but the question you actually want answered is often about a range decided by the chart — the run-up before a spike, the week of consolidation before a breakout, everything since a flush low. Design:

- **Drag time only**: a volume profile already covers every price in the range, so the gesture only needs x1 and x2, like drawing a horizontal line. Edges snap to whole bars, and the bars at both ends are included.
- **Computed from the finest bars**: it picks the finest timeframe that keeps the range at around 3,000 bars — 1m bars up to two days, 5m for around ten days, 15m for a month. The finer the bars, the fewer rows each bar's volume is spread across, and the closer the profile is to reality; the label says which was used. Closed ranges go through the bar cache; a "to now" range only fetches the last stretch each minute.
- **Row count follows the screen**: rows = the profile's height on screen ÷ Detail (6px etc.), so zooming in on the price axis shows more detail instead of coarser rows. All modes share the same Detail setting. Note that the POC is "the heaviest row", so finer rows put the POC on a narrower, more precise price, and it may move when you change Detail.
- **Buy/sell coloring**: the profile does not use the taker-buy volume in the bar cache; like TradingView's up/down volume, bars that close ≥ open count as buys and the rest as sells. With 1m bars this split is quite informative.
- **Inside isn't grabbable**: for the same reason as rectangles — ranges are usually wide and the inside is where you pan the chart — only the edges and the label can be dragged.

The **volume profile** is built the same way as TradingView's: load the session's **1m bars** and spread each bar's volume evenly across the price rows it touched. Their own documentation states this is an estimate, not tick-accurate. A day of 1m bars takes only **2 API requests**; using aggTrades tick data instead, BTCUSDT has about 820K trades a day and would need 819 requests — the gain in accuracy isn't worth that cost. Crypto has no trading sessions, so "session" means the exchange's own day boundary, which on Binance is 00:00 UTC.

**RSI and MACD are recursive filters, computed in plain JavaScript.** An EMA is the one-pole filter `y[n] = a·x[n] + (1−a)·y[n−1]`, i.e. `scipy.signal.lfilter([a], [1, a−1], x)`, and RSI is two of them (Wilder's smoothing, `a = 1/n`). In Python, lfilter beats numpy and pandas because it runs that loop in C instead of the interpreter; JavaScript has no interpreter loop to escape, since V8 compiles the plain `for` loop to machine code: **a million closes, RSI and MACD together, in about 35 ms** (`scripts/test-indicators.mjs`). So there is no native DLL, which would also have to be rebuilt for every Electron upgrade. Like lfilter's `zi` / `zf`, the filter state is carried over: the full pass runs only when the bars are replaced (load, history, trim); after that each closed bar advances the state once, and each live tick only *peeks* at what the forming bar would give, a handful of multiplications, without committing it. Each filter is seeded with the simple mean of its first n inputs, as TradingView's `ta.ema` / `ta.rsi` are, and the tests check the live values against a full recompute tick by tick.

The **footprint** uses individual trades (aggTrade), so unlike the volume profile above it is exact rather than an estimate: each trade carries a price, a quantity and whether the buyer was the maker (`m`); `m = true` means the taker was the seller, so it counts as a taker sell. Design:

- **Collected once in the hub**: the hub already subscribes to `@aggTrade` for every card, so the footprint just adds per-price accumulation in the same place. Any number of cards on the same symbol share one copy, stored in units of **1 minute × the exchange's raw tick size** (0.1 for BTC); 5m and 15m are sums of 1m. Cards merge ticks into rows according to zoom only when drawing, with row boundaries aligned to whole multiples, so a given price lands in the same row at any zoom and in any bar.
- **Completeness is judged by trade ID**: aggTrade IDs are consecutive, so a gap means missed trades. A minute only counts as complete if it was received from start to end within one unbroken stretch of the stream; the minute in which a card was opened, and any minute spanned by a disconnect/reconnect, are refetched in full over REST after they close, replacing the streamed version.
- **Backfill yields to trading**: `/fapi/v1/aggTrades` costs weight 20 per call with a limit of 2400 per minute, shared with order placement on the same IP. So backfill runs **at most once per second** (using at most half the quota), waits for the next minute if the used weight in the response headers exceeds 1500, and pauses per `Retry-After` on 429 / 418. When BTC is busy a minute takes about 4 requests, so filling 3 hours takes roughly ten-odd minutes, newest first so the most recent bars appear first.
- **Small on disk**: only closed, complete minutes are stored, one file per pair per hour, keeping only the last 12 hours. Prices are stored as "ticks from the previous level" and quantities as integers in the smallest unit, both as varints, then gzipped — **completely lossless**. In testing, a minute of BTCUSDT perp has about 1,300 price levels: about 25KB as float64, about 2KB this way, about 1.5MB for 12 hours. If the program is killed mid-write, reading the file recovers the minutes before the break and rewrites the file.

**Fib retracement** anchors are stored as **{time, price}** rather than bar indices — an index only means something within the currently loaded data range and points at a different bar after changing timeframe. The retracement lines span the full chart width because on a card this small, what you want to know is "how far is the price from these levels now".

When a card is too short to fit every icon in one column, the toolbar automatically **wraps into a second column** instead of getting cut off (a card at the default 220px height has two columns).

The **toolbar** follows **exactly the same** visibility rule as the title bar — it appears when the mouse is over the card and fades when it leaves. It deliberately doesn't use "expand when near the left edge": a card this small shouldn't have two different rules for summoning UI, and at 45% opacity the outermost 20px is the hardest place to aim. The toolbar overlays the chart and takes no layout width, costing 0px when idle. Once you pick a tool, its icon stays visible even after the toolbar fades — otherwise you wouldn't know you're still in drawing mode. **Gestures work in any mode** (double-click to add a line, `Shift`-drag to measure); the toolbar just lets people who haven't learned the gestures find them, the same division of labor as in TradingView.

The **measure tool** is first of all a gesture (the toolbar's measure button is there for people who haven't learned it) — TradingView's own quick measure is also `Shift`-drag, and on a card this size a gesture costs no screen space. The measurement box's two anchors are stored as logical coordinates (fractional bar indices) rather than pixels, so the box follows the bars as you pan and zoom, and can also be placed in the empty area to the right of the last bar.

**Support/resistance lines** are saved per **symbol**, not per card or per timeframe. So the same line appears on every card for that symbol and stays put as you switch between 1m, 15m and 1d — a horizontal price level has no time anchor to begin with. Lines at the same price are deduplicated automatically.

**Spot and perp share drawings**: horizontal lines, trend lines, Fib retracements, rectangles and fixed range volume profiles are likewise saved per symbol regardless of market. The basis between BTCUSDT spot and perp is usually only one or two basis points, so a support level holds on both sides; the lines are still there when you switch over, and so is the undo history. Contracts with scaled quotes (`1000PEPEUSDT`) are different symbols to begin with, so they have their own lines — prices a thousand times apart couldn't be shared anyway.

**Perpetual futures** go through Binance USDⓈ-M (`fapi.binance.com` / `fstream.binance.com`). REST paths and stream names are the same as spot, so it's the same `BinanceProvider` with a different market config, and reconnect, backfill and 100ms coalescing all carry over. One catch: the perp WebSocket must connect to **`/market/stream`** — the old `/stream` still connects but no longer sends klines, trades or tickers, so the card would show "Live" yet never move. The funding rate comes from the `@markPrice` stream (every 3 seconds); the countdown is computed on the card every second, so it keeps running between pushes and even while disconnected.

**Two display modes**

- **Float** (default): each chart is its own floating window that can be placed anywhere on screen.
- **Board**: a single window with cards in a CSS Grid; drag a card's title bar to reorder, and set the column count in the top right.

Both modes share the same card settings, so switching back and forth never loses symbol / timeframe / chart type / opacity.

**Click-through**: when on, clicks go straight through to the desktop. A small "Exit click-through" button appears in the card's bottom-right corner (hover over it to make the card clickable again), and `Ctrl+Alt+C` also forces it off, so you can't lock yourself out.

## Trading (Binance USDⓈ-M perpetuals)

> Leveraged trading is very risky. The default is **Binance demo trading (testnet)**; switching to live requires an extra confirmation checkbox. To practice with custom capital and see performance stats, use **Paper (local)** (see "Paper trading" below), which needs no API key.

**Setup**: right-click → Settings → "Trading" at the bottom.
1. Create an API key on [Binance demo trading](https://demo.binance.com/) (or in API Management on a live account): enable only "Reading" and "Futures trading", **do not enable withdrawals**, and IP restriction is recommended.
2. Fill it in according to the key type; when it shows "Connected · Available … USDT" you're done:
   - **Self-generated (recommended)**: paste the API key → "**Choose private key file…**" and select your `.pem` file that starts with `-----BEGIN PRIVATE KEY-----`. **Ed25519** and **RSA** are supported. The private key is read by the main process from the file dialog and never passes through the renderer; Binance only has the public key you uploaded.
   - **System generated (HMAC)**: paste the API key and secret key → "Save & connect".

   Binance's USDⓈ-M futures REST docs only list HMAC and RSA, but **Ed25519 has been tested and works on a live account** (read-only queries, signature verification passed). To generate an Ed25519 key: `openssl genpkey -algorithm ed25519 -out stockcard-private.pem`; public key: `openssl pkey -in stockcard-private.pem -pubout -out stockcard-public.pem`. Paste the whole public key file (including the BEGIN / END lines) into Binance.
3. **Leverage is set per symbol**: click "Cross Nx ▾" in the order ticket header, type a number or click a preset (only multiples allowed for this symbol are listed; the rightmost is its maximum leverage) → "Apply". Margin mode is fixed to **cross** and position mode to **one-way**; if the account is in hedge mode, a button to switch appears in the settings.

**Leverage lives on your Binance account, not locally**: Binance already stores leverage per symbol (read with `GET /fapi/v1/symbolConfig`, written with `POST /fapi/v1/leverage`), so the app, the website and the mobile app all see the same number. It is re-read from Binance every time the order ticket opens and is **not** changed when an order is sent — the leverage shown on the ticket is the leverage you get. Maximum leverage differs per symbol (BTC 125x, many small caps 20x or less), and **the larger the position, the lower the maximum leverage** (the brackets from `GET /fapi/v1/leverageBracket`); if the estimated position exceeds the notional allowed at the current leverage, the ticket tells you up front instead of waiting for Binance to reject it.

Keys (the HMAC secret, or the self-generated private key) are encrypted with Windows DPAPI and stored in `userData/trading-credentials.bin`, readable only by the main process; the renderer only sees the last four characters and the key type. Every order is re-validated and rounded in the main process against the exchange's rules (tick size, step size, minimum notional) before it is sent.

| Action | How |
| --- | --- |
| Place an order | On a perp card, a **＋** follows the mouse left of the price axis while you're over the chart; click it to open an order ticket at that price |
| Lock a price | **Single-click** on the chart: locks that price and pins the ＋ to its dashed line, so you can move the mouse over and click it. `Esc` or another click releases it (double-click still adds a horizontal line and doesn't lock) |
| Order ticket | Limit / market, amount (**notional in USDT**; 10% / 25% / 50% / 100% of available margin × leverage), optional TP / SL. Below, it shows live quantity, margin, the **estimated liquidation price** for long and short, and how much the TP / SL would make / lose |
| Split orders | Limit only: **Split** in the ticket (− / + or the mouse wheel, 1–10, back to 1 each time the ticket opens) sends the amount as that many equal orders at the price — whole quantity steps, the leftover step added to the first ones, so the parts add up exactly. Each must still meet Binance's minimum (5 USDT), or the ticket says so. They stack on the chart as one label marked **×N**; drag the top one off to where you want it and the next shows. TP / SL ride on every part and go on once the first fills. If one fails part-way, the ones placed stay and the notice says how many went |
| Fill alerts | When a limit order that was waiting on the book fills, or a TP / SL triggers, a desktop notification pops up and the card flashes in the taskbar — even with no card on that symbol open. Orders that fill the moment you send them (market, or a limit already past the price) only show in the card. A split order filling at once is one notification with the count; a partial fill is announced once, then again when the order is done. Follows the toast / flash choices in the alert settings |
| Long/short bias | The row above the estimated liquidation in the order ticket: the **funding rate** (positive: longs pay shorts; negative: shorts pay longs), a heat tag and the settlement countdown; with an amount entered, it shows how many USDT a long / short would pay or receive per settlement. "Heat" is measured against the **neutral** rate, not 0: funding rate = premium + 0.01% interest (per 8 hours), so when the perp tracks spot it sits at 0.01%; above neutral = **Longs hot**, below it (even if still positive) = the perp is cheaper than spot, **Shorts hot**. For symbols settling every 4 or 1 hours, neutral is scaled down proportionally (the interval comes from `/fundingInfo`). The next line is Binance's **L/S ratio**: "all" is the share of accounts with a position that are net long (mostly retail), "top" is the long share of position size among the top 20% of accounts by margin; updated every 5 minutes, and refreshed while the order ticket is open |
| **Amount unit** | Click the unit at the right of the amount field (`USDT ⇄` / `ETH ⇄`) to size orders in **USDT** (notional) or in **the coin** (quantity). Switching converts what is typed at the ticket's price, and the line below shows the other unit (≈ USDT in coin mode, ≈ coins in USDT mode). In coin mode the quantity goes to the exchange as typed, rounded down to its step size; the percentage buttons and reduce-only work the same. The choice is remembered for every card. The default amount is kept in USDT and is filled in converted in coin mode, where its button is hidden |
| **Default amount** | "Set default" to the right of the ticket's amount field: enter an amount (e.g. 200) and click it, and **every order ticket opens pre-filled** with 200 USDT; the button changes to "Default ✓". When an opportunity comes, all that's left is the direction: press "Long / Short", then press again to confirm and send. Shared by all symbols and kept across restarts; enter another amount and click again to overwrite, or clear the field and click to remove it. Not applied in reduce-only mode |
| Submit | Press "Long / Short" once and the button turns into a summary (e.g. "Confirm long 0.235 ETH @ 2551.52"); press again (or `Enter`) within 3 seconds to send |
| TP / SL | Triggered by **mark price**, closing the whole position (Binance's conditional order API). TP/SL on a limit order is placed only **after it fills**; fills that happen while the app is closed get their TP/SL placed the next time it opens |
| View the position | On the chart: entry price line (label shows live PnL), liquidation price line, order lines, TP/SL lines. The position bar at the bottom: side / leverage, size, entry price, mark price, unrealized PnL and ROE, liquidation price. The position bar is a **row** in the card layout (below the time axis), not floating over the chart: with a position the chart gives up 22px, without one it collapses, so it **never covers the volume and OI panes**. On narrow cards secondary fields are dropped first; PnL and the buttons always stay |
| **Reduce-only** | Tick "Reduce-only" in the order ticket: it can only shrink the existing position, never open a new one or reverse. A long can only "Close long (sell)", a short only "Close short (buy)"; the percentage buttons become 25 / 50 / 75 / 100% **of the position** (100% is the exact position size, leaving no dust); amounts larger than the position are blocked up front. No margin is needed, and the TP/SL fields and estimated liquidation are hidden. **Exempt from the minimum order size** (Binance's `-4164` message: "unless you choose reduce only"), so even tiny leftover positions can be closed. The position is re-fetched from Binance before sending |
| **Drag to reprice** | Hold the **label of a limit order, TP or SL** and drag up or down; release to change the price. While dragging, the label shows the new price and the estimated TP/SL PnL. With the order ticket open, dragging the "Order price / TP / SL" labels edits the ticket's fields directly. Live orders can only be grabbed by the label, not the line — the line shares the chart with horizontal lines and panning, and a mis-grab would move a real order. **The dashed lines of the order ticket and the reverse panel (order price / TP / SL / reverse price) can be grabbed anywhere along the line**: the cursor becomes an up/down arrow over the line, press and drag, and the line follows the mouse live (quantity, margin and liquidation price catch up in the background); these lines only change numbers in the panel and nothing has been sent yet, so the looser grab is safe |
| Drag safeguards | Dragging past the current price (a limit order would fill immediately) or putting a TP/SL where it would trigger immediately turns the label red, and releasing **sends nothing**; `Esc` during a drag cancels; moves under 3px don't count; **if the price scale changes during the drag (autoscale, window resize), nothing is sent either** |
| Cancel an order | Click the **✕** on an order or TP/SL label. The label immediately changes to "Cancelling…", and once Binance confirms, the line disappears and "Canceled" pops up, without waiting for the next refresh. Pressing it again on an order that no longer exists explains "cancelled or filled" instead of showing an error |
| Edit TP/SL | "TP/SL" on the position bar; clear a field to cancel it |
| Close | Double-press "Close" on the position bar (market, reduce-only, exact size). On cards narrower than 460px, the position bar buttons use short labels (TP/SL, Lmt rev, Mkt rev) to leave room for PnL |
| **Market reverse** | **Double-press** "**Market reverse**" on the position bar: the first press turns the button into a blue "Confirm reverse→Short", and a second press within 3 seconds reverses immediately without opening a panel (the same double-press confirmation as "Close"). If the position changes between the two presses, the confirmation is void and you have to start again |
| **Limit reverse** | "**Limit reverse**" on the position bar opens the reverse panel (directly in limit mode), headed "Long 0.01 → Short 0.01". Choose the price by clicking the chart, typing, or dragging the "Reverse price" line; a long can only sell **above** the current price and a short can only buy **below** it (the wrong side would fill immediately, so the panel blocks it and asks you to use market instead). Once placed, the chart label reads "Rev. sell / Rev. buy", and you can drag it to reprice or press ✕ to cancel. You can optionally add **TP / SL for the new position** (for a limit reverse, placed only after it fills) |

**How a reverse is sent**: normally **one** order in the opposite direction for twice the position size (long 0.01 → sell 0.02: the first 0.01 closes, the next 0.01 opens a short), not two orders "close, then open". It fills once, with no flat gap in between. Fees are the same either way: twice the size.

**When the margin can't take one order**: the old position's margin is only freed once the order fills, so the opening half has to fit beside it — a position using about half the balance or more can't. Then the reverse goes as **two orders**: a reduce-only close, then an open of the same size. The app judges this from the last account read (opening half ÷ leverage + taker fee, with 2% headroom), and if Binance still answers `-2019` the single order did nothing and it falls back to two. A **limit** reverse in two rests the reduce-only close at your price; once it has filled in full and the position is flat, the open goes in at the same price (filling at once at that price or better if the market is through it, otherwise resting there), carrying the reverse's TP / SL. If the close is cancelled, part-filled or leaves a position, the open is not sent; if the open fails you are flat, and the notice says so. Safeguards:

- **The size you confirm is the size that's sent**: the panel shows "Long 0.01"; the position is re-fetched from Binance before sending, and if the size differs nothing is sent and you're asked to confirm again.
- **The original position's TP/SL and reduce-only orders are canceled only after the reverse fills.** A long's stop loss is a "sell", which is meaningless once the position is reversed to short, so it's cleaned up automatically; but until the fill it still protects the original position, so a pending limit reverse leaves it alone. It's also cleaned up on a partial fill that has already crossed zero.
- **Position guard for limit reverses**: while a limit reverse is pending, if the position changes first for some other reason — say the original stop loss triggers, or you close manually — this double-size order would open a **double-size opposite position** when it fills. So every position update checks "position = original position + amount of this order filled so far", and if it doesn't match, the reverse order is canceled automatically with a warning. Positions and orders are read at the same time, and a fill landing between the two reads would also look like a mismatch, so on a mismatch they're read again in order (orders → position → orders); the reverse is canceled only if the orders didn't change in the meantime and it still doesn't match.
- Only one reverse limit order per symbol at a time.

**Order IDs must be exact to the last digit**: Binance order IDs can exceed 16 digits, while JavaScript numbers have only 15–16 significant digits, so reading them with plain `JSON.parse` rounds off the last few digits (`8389765907134201345` becomes `8389765907134202000`). The line still draws (drawing only needs the price), but cancel and reprice send a nonexistent ID and Binance replies `-2011 Unknown order sent`. So all trading responses are parsed with `parseExact`: integers of 16 or more digits are kept verbatim as strings.

**How repricing is sent**: limit orders are **modified in place** with `PUT /fapi/v1/order` (same order ID, but it loses its queue position — Binance's rule). TP/SL are conditional orders, and Binance has **no modify API** for them, so they can only be canceled and re-placed; and two close-position conditional orders on the same side can't coexist, so it cancels first, then places the new one. If the new one is rejected (e.g. the trigger price has already been crossed), **the original price is immediately re-placed**, so the position is never left without a stop; only if the restore also fails does it show an error asking you to check.

PnL is computed live from the mark price, updated every second. Positions and orders come through two paths at once: Binance's user data stream (updated the moment a fill happens), plus REST polling every 3–12 seconds as a backup — so the display doesn't freeze on stale data if the stream drops.

During development, `STOCKCARD_TESTNET_REST` / `STOCKCARD_TESTNET_WS` can point the **testnet** at a local mock exchange; the live URLs cannot be overridden.

### Paper trading (local)

For testing new strategies and seeing how good you really are: **custom starting balance**, matched against **Binance's live market data**, with PnL, fees and funding all applied to your balance and every closed position recorded. No API key needed.

**Setup**: right-click → Settings → Trading → set Environment to "**Paper (local)**".
- **Starting balance**: enter an amount → "Restart with this amount…" → confirm. Resetting clears paper positions, orders and history; **the old history is backed up** (`userData/paper-account-<time>.json`).
- **Fees**: maker / taker rates, default 0.02% / 0.05% (Binance regular user). Change them to your own rates if you have VIP or a BNB discount.
- **Trade journal & performance**: opens the journal window.

Order ticket, TP/SL, reverses, drag to reprice and default amount **all work as usual**; labels on the card read "Paper". The paper exchange mimics the Binance API's interface, so the trading code doesn't need a second code path anywhere.

**Costs and rules applied** (as close to reality as possible, erring conservative):

| Item | How it's computed |
| --- | --- |
| Fees | Notional of each fill × rate. **A resting limit order that fills is maker**; market orders, triggered TP/SL and limit orders that fill as soon as they're sent are **taker** |
| Slippage | Market orders and TP/SL **eat through Binance's real order book** (top 50 levels) level by level to get the average fill price — the bigger the order and the thinner the coin, the more slippage |
| Limit fills | A real trade price has to **cross** the limit price to fill; just touching it doesn't count (in reality you'd have to wait in the queue and might not get filled), to avoid overstating performance |
| TP / SL | Triggered by **mark price** (same as live), then closed at market against the order book |
| Funding | At each funding settlement, paid or received at Binance's published rate × mark price: when the rate is positive, longs pay and shorts receive |
| Liquidation | Cross: when balance + unrealized PnL ≤ maintenance margin, all positions are liquidated at mark price and the remaining maintenance margin is taken as the liquidation fee. The balance never goes negative |
| Leverage brackets | Without an API key the per-symbol brackets can't be read, so all symbols share one set of brackets based on BTCUSDT (max 125x) |

**While the app is closed**: a real exchange doesn't stop filling orders because you turned off your computer, so the paper exchange can't stop either. The next time you open the app, the closed period is replayed (up to 30 days) using **1m bars and Binance's published funding rates**: stop losses, limit fills, take profits, funding and liquidations are processed in time order, and a notice pops up with the result. Within a single minute you can't tell whether the high or the low came first, so **stop losses are evaluated before take profits** (conservative).

**Journal window**:
- **Performance**: current balance and equity, net PnL and return, win rate (wins / losses), profit factor (gross profit ÷ gross loss), average win / average loss, expectancy per trade, best / worst trade, max drawdown (from the balance peak), total fees, total funding, average holding time, and separate results for longs and shorts.
- **Equity curve**: the balance after each change (realized PnL, fees, funding); green above the starting balance, red below.
- **Open positions**: positions not yet closed, and the fees and funding paid on them so far.
- **Position history**: each open-to-fully-closed position is one record: side, max size, leverage, average entry / exit price, price PnL, fees, funding, **net PnL**, ROE, holding time, close reason (Manual / Close button / Limit / TP / SL / Reverse / Liq.). Can be filtered to a single symbol.
- **Transactions**: every deposit, realized PnL, fee and funding payment with the balance at the time.
- **Export CSV**: saves the position history as a CSV that opens in Excel.

**Reverses** are split into two records in the history: the original position closed with reason "Reverse", and the new position opened at the same price, with the fee split between the two in proportion to size.

## Architecture

```
main/                 Electron main process
  main.js             lifecycle, single-instance lock, all IPC
  windows.js          Float / Board window management, always-on-top, click-through, show/hide
  store.js            electron-store settings persistence + screen-bounds correction
  tray.js             system tray menu
  shortcuts.js        global shortcuts
  protocol.js         app:// custom protocol
  i18n.js             interface language for main-process text (tray menu, notifications)
  alerts.js           range alert delivery (card glow, Windows notification, taskbar flash)
  bar-store.js        bar cache (fixed-width binary, split by time)
  footprint-store.js  footprint cache (one gzip segment per minute, last 12 hours only)
  trading/            trading: rules (signing, rounding, liquidation estimate), client (REST),
                      stream (user data stream), vault (DPAPI keys), service (state and orders),
                      paper / paper-engine (local paper exchange and its bookkeeping)
preload/preload.js    contextBridge allowlisted API
renderer/
  hub.html/js         hidden window: owns all WebSockets (at most one per market)
  card.html/js        single-card page for Float mode
  board.html/js       multi-card page for Board mode
  cardview.js         card component (shared by both modes)
  chart.js            lightweight-charts v5 wrapper
  journal.html/js     paper trading journal window
  guide.html/js       shortcuts & tips window (F1)
  i18n.js             t(): looks up English in i18n/en.json, falls back to the Chinese source string
  i18n/en.json        Chinese UI string -> English
  footprint.js        footprint rows, delta, POC, imbalances (footprint-primitive.js draws them)
  volume-pane.js      volume pane: taker buy/sell split, thin volume (ranked in volume-stats.js)
  *-primitive.js      chart overlays (Fib, rectangles, trend lines, volume profiles, opens, ...)
  datafeed/
    provider.js       DataProvider abstract interface
    binance.js        Binance implementation (REST backfill + WS live + reconnect)
    footprint-collector.js  footprint collection: per-trade accumulation, completeness, REST backfill
    remote.js         card-side provider, forwards to the hub over IPC
  ui/                 settings panel, symbol search, toolbar, watchlist, trading settings
  trade/              order ticket, position bar, on-chart position / order lines (trade-primitive),
                      reverse panel, long/short bias (market-mood)
scripts/              icon generation, vendor sync, syntax and i18n checks (check-i18n.mjs),
                      tests (datafeed, bar cache, trading rules, paper engine, volume, footprint)
```

### Two implementation tradeoffs

**1. Why there is a hidden hub window**

The spec requires both "the renderer connects to Binance directly" and "only one WebSocket no matter how many cards". In Float mode each card is a separate renderer process, so if cards opened their own sockets there would be one connection per card.

So the connection lives in a persistent hidden renderer (`renderer/hub.js`), and cards request data from it over IPC. Spot and perps are on different hosts and can't share a socket, so the rule is **at most one per market**: the perp connection isn't opened when no card is showing a perp, and the spot connection closes when every card has switched to perps:

```
card --invoke--> main --send--> hub --(WebSocket)--> Binance
card <--send---- main <--send-- hub
```

This keeps "use the browser's native fetch / WebSocket" while really having only one connection. With 4 cards open, `Get-NetTCPConnection` shows just one connection on 9443.

**2. Why `app://` and not `file://`**

Chromium doesn't allow loading ES modules from `file://` (it's an opaque origin, and CORS blocks it outright). The usual workaround is `webSecurity: false`, but that throws away the security settings the spec requires. So a standard + secure `app://` protocol is registered to serve the renderer; module imports, secure context and WSS all work, and `contextIsolation: true` / `nodeIntegration: false` / `sandbox: true` are all kept.

## Data sources

Everything uses Binance public endpoints. Spot is at `api.binance.com/api/v3` and `stream.binance.com:9443/stream`, perps at `fapi.binance.com/fapi/v1` and `fstream.binance.com/market/stream`, with the same paths underneath:

- Historical klines `GET /klines` (500 bars)
- Live combined stream, `@kline_<interval>` + `@miniTicker` + `@aggTrade`; perps add `@markPrice` (funding rate)
- Symbol list `GET /exchangeInfo`, cached for 24 hours; for perps only `PERPETUAL`, no delivery contracts
- 24h change: one `/ticker/24hr` call at startup, then updated from miniTicker
- Funding rate (perps): one `/premiumIndex` call at startup, then updated from markPrice; settlement interval from `/fundingInfo` (lists only symbols not on 8 hours, cached for 1 hour)
- Long/short ratio (perps): `/futures/data/globalLongShortAccountRatio` (accounts) and `/topLongShortPositionRatio` (top traders' positions), 5m, once every 5 minutes while the order ticket is open
- Open interest (perps): `/fapi/v1/openInterest` polled every 3 seconds; history `GET /futures/data/openInterestHist` (5m, within 30 days)
- Footprint: live from the already-subscribed `@aggTrade`; missing minutes from `GET /aggTrades` (`startTime` / `endTime` spanning one minute, paging forward with `fromId` past 1000 trades), at most once per second

**Update rate**: Binance's `@kline_*` pushes once per second, which is the ceiling for official bar values. To make the price move more responsively, the per-trade `@aggTrade` is also subscribed, and between klines the trade price is merged into the close / high / low / volume of "the bar being formed". Trade messages are coalesced in the hub in **100ms** windows (`LIVE_TICK_MS`), and only the last one in each window is sent on, so no matter how hot the market, each card redraws at most 10 times a second. When a kline arrives it immediately overwrites with the official values, so any error lives for at most a second. At the moment a new bar starts, the app doesn't open one itself; it waits for the kline to roll over.

**Connection resilience**: after a disconnect, reconnects back off exponentially 1s → 2s → 4s → … → 30s; on reconnect all streams are resubscribed, and klines missed during the outage are filled in over REST before rejoining the live stream; the connection is also proactively replaced at 23 hours to avoid Binance's forced 24-hour disconnect. A small dot in the card's top-left shows the status (green = live, yellow = reconnecting, red = offline), and no error dialogs ever pop up.

These behaviors are covered by tests (`npm test`), so you can verify them without actually pulling the network cable.

### Switching data sources

`renderer/datafeed/provider.js` defines the interface:

```js
getHistory(symbol, interval, limit)   // -> Bar[]  { time(sec), open, high, low, close, volume, closed }
subscribe(subId, symbol, interval, { onBar, onTicker, onFunding })
unsubscribe(subId)
searchSymbols(query)                  // -> SymbolInfo[]
getTicker(symbol)                     // -> { symbol, last, changePercent, high, low, volume }
```

To add Taiwan or US stocks, write a second implementation and swap out `new BinanceProvider()` in `renderer/hub.js`. The chart and UI layers don't need to change.

## Config file

`%APPDATA%/stock-card/stock-card-config.json`. The folder is pinned to `stock-card` in `main/main.js` (it keeps the app's old name, StockCard), so the dev and packaged builds share the same file whatever the product is called, and cards set up under `npm start` carry over directly to the installed version.

Position and size changes are debounced 500ms before being written; at startup the saved coordinates are checked against the current screens, and if the screen layout has changed, cards are pulled back into the visible area automatically.

## Known limitations

> A card "disappeared"? See [docs/vanishing-cards.md](docs/vanishing-cards.md) first: every case encountered so far, how to diagnose it and how to fix it, plus a checklist for other desktop widget projects.

- **`backdrop-filter` can't blur the desktop.** CSS backdrop-filter only blurs backgrounds "within the same web page"; behind a transparent window is the desktop, which isn't in the page. Real frosted glass requires calling the Windows DWM acrylic API (native layer). The current translucency comes from the rgba alpha of the card background, which is what the opacity slider actually adjusts.
- **Transparent windows can't be maximized** — a Windows limitation — so there's no maximize.
- Cards use `skipTaskbar`, so they don't appear in the taskbar and are managed entirely from the tray. That also means a minimized card would have no taskbar button to bring it back, so cards can't be minimized; if `Win+M` or another program minimizes one from outside, it is restored immediately.
- "Launch at startup" only works in the packaged build (in development it would point to `electron.exe`).
- The TradingView logo in the bottom-left of the chart is Lightweight Charts' default attribution and is kept.

## License

This project is MIT. Charts use [TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts) (Apache-2.0). Market data comes from Binance's public API, and the project does not scrape private data from the TradingView website. It does include trading: paper trading (local), Binance testnet, and live orders on Binance USDⓈ-M perpetuals with your own API key (see "Trading" above). Trading real funds is entirely at your own risk; nothing in this project is financial advice.
