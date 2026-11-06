**English** | [繁體中文](order-flow.zh-TW.md)

# Order flow

Who is trading, and how hard: volume split into taker buys and sells, CVD, open interest, the long / short ratios, big taker orders, the position read, order-book walls and the footprint. Everything here comes from Binance's public data, free and with no API key.

| Tool | Spot | Perp | Toolbar icon |
| --- | :---: | :---: | --- |
| [Volume](#volume) | ✓ | ✓ | Bars |
| [CVD](#cvd) | ✓ | ✓ | Staircase |
| [Open interest](#open-interest-oi) | | ✓ | OI |
| [Long / short ratio](#long--short-ratio) | | ✓ | Two curves |
| [Big orders](#big-orders) | ✓ | ✓ | Two bubbles |
| [Position read](#position-read) | | ✓ | Two bubbles |
| [Order walls](#order-walls) | ✓ | ✓ | Two bars |
| [Footprint](#footprint) | ✓ | ✓ | A line with bars on both sides |

![CVD, open interest and the long / short ratios under an ETH perpetual](../images/order-flow/cvd-oi.png)

## Volume

The **bars** icon opens the volume menu: Off / Show volume, then:

- **Color.** "Taker buy / sell split" stacks taker buys (bottom) under taker sells (top). "Candle color" draws each bar whole in its candle's colour.
- **Position.** "Overlaid on the chart" (the default, as on TradingView, so the candles keep the card's full height) or "Separate pane".
- **Thin volume PR ≤.** A closed bar whose volume (in USDT) ranks at or below that percentile of the bars before it is drawn grey, so quiet bars stand out. A percentile rank rather than "under half the average", because one spike can be 10 to 50 times an ordinary bar and would drag an average around.
- **Distribution lookback.** About how many bars that distribution remembers; older bars fade out of it gradually.

## CVD

The **staircase** icon: off / show CVD, and where the sum starts.

- **From the first bar loaded.** Only the shape means anything: is buying keeping up with the price?
- **From 0 at each UTC midnight** (08:00 in Taiwan). The level is that day's net, with a dotted zero line and the line broken at each day.

Cumulative volume delta is taker buys minus taker sells, summed bar by bar. Binance sends the taker-buy volume with every kline, so it is free, on spot and perp alike. Each bar's delta is turned into USDT at its average price, like the volume bars (within about 1% of Binance's exact taker-buy quote volume). It updates tick by tick; bars from an old cache without the taker split add nothing.

## Open interest (OI)

The **OI** icon (or settings → "Show open interest (OI) pane · Perp") adds an orange pane in coins (e.g. `94.90K` BTC), updated about every 3 seconds. Spot cards keep the setting and show the pane again when switched back to perp.

Binance publishes OI only as snapshots and a 5-minute history 30 days deep, so the app records it itself while a perp card is open, whether or not the pane is showing. Open the app at least once every 30 days and the history grows beyond the exchange's. How it is stored: [Storage](../design/storage.md#open-interest).

## Long / short ratio

The **two-curve** icon opens a menu: off / show, which lines, and the unit.

| Line | Colour | Meaning |
| --- | --- | --- |
| Crowd | Pink | Among accounts with a position, how many are net long, each account counted once: mostly retail |
| Top traders | Green | The top 20% of accounts by margin, by position size |

**Unit: share long % (the default).** Each line is the share long: a long/short ratio of 3 is 75%. The ratio stretches as it rises (2 → 3 looks like half again, but is 67% → 75% of accounts), so the share reads changes as they are. The crowd's line also gets:

- **7d base** (dashed) and a **band** (dotted): the median of the crowd's share over the week before, and two robust deviations either side. The crowd has a level of its own (it rarely left 48–76% on BTC and 65–80% on ETH over a month), so what says something is the distance from its usual, not the number itself.
- **Bars along the bottom: what the price does not explain.** Over a day the crowd mostly mirrors the price: it adds longs into falls and closes them into rallies. The bars are the part of the crowd's 24h change that the 24h price change does not account for, in standard deviations: **amber at +2σ and over** (far longer than the fall explains: genuinely crowded), **blue at −2σ and under** (far less long than usual for the move), grey in between. They need ten days of history behind an hour, so the first stretch of the 30 days has none.

Both are fitted on the hours before each hour only, so the history shows what the pane would have said at the time. They are hourly, whatever the card's interval, and refresh once an hour.

> **How to read it.** A crowd far above its base after a sharp fall is usually just buying the dip, and on 30 days of BTC that was followed by bounces as often as not. An amber bar says the crowd is longer than even that explains, which is the crowding a flush feeds on; a blue bar near a high is the crowd turning away, which preceded the drops in that month. It is context for the order flow, not a signal on its own. Details and measurements: [Analytics](../design/analytics.md#the-crowd-in-context).

**Unit: long/short ratio.** The exchange's two ratios as they are, on one scale with a dotted line at 1.0 where longs and shorts balance.

The data is Binance's public trading statistics: every 5 minutes, the last 30 days, perpetuals only (the icon is hidden on spot cards). Each bar shows the reading taken at its **close**, and the forming bar the newest one. Bars shorter than 5 minutes carry the latest reading; spans older than 30 days or never sampled are left blank rather than drawn flat.

The same two numbers, with the funding rate, are in the order ticket: see [Trading](trading.md#long--short-bias).

## Big orders

The **two-bubble** icon: Off / Big orders / Position read / Both.

![Big taker orders as bubbles at their average price, and position-read tags on the bars](../images/order-flow/big-orders.png)

Every taker trade printed in the same millisecond is one order. Orders in the top 0.5% … 0.01% **of the coin's own recent orders** (pick in the menu) are drawn as bubbles at their average price, green for buys and red for sells, sized by amount; the biggest carry it. The legend at the bottom left says what the threshold is in USDT right now (ETH top 0.1% ≈ $300–800K, ADA ≈ $50K).

A rank rather than a dollar amount, because a fixed amount means a handful of orders an hour on ETH and none at all on ADA. Big orders are collected only while the app runs and a card shows them; rebuilding them afterwards would mean downloading every trade. Details: [Analytics](../design/analytics.md#big-orders-and-the-position-read).

## Position read

On perpetuals, a bar whose change in OI is 2 / 3 / 5× the median is tagged:

| Tag | Takers | OI | Reading |
| --- | --- | --- | --- |
| **新多** L+ | Buying | Up | Longs opening |
| **新空** S+ | Selling | Up | Shorts opening |
| **空補** S− | Buying | Down | Shorts closing |
| **多平** L− | Selling | Down | Longs closing |

Hover a bar for its ΔOI, taker net volume, reading and biggest order. OI only moves when both sides of a trade open (up) or both close (down), so ΔOI says how much was opened or closed and the taker side says which way the aggressors leaned. Bars are read only where OI was sampled inside them, i.e. while the app was running; opening and closing within one bar offset each other.

## Order walls

The **two-bar** icon: Off / This market's book / Spot + perp.

![Order walls: bids in green and asks in red, sized by amount; pulled walls end in an amber ✕](../images/order-flow/walls.png)

Resting orders far larger than the price levels around them (5 / 10 / 20 times, in the menu) are drawn as a line at their price from when they appeared, green for bids and red for asks, thicker the bigger, labelled with their size and multiple. With "Spot + perp" the other market's walls are dashed and tagged.

When a wall goes it leaves a faint line ending in:

- an amber **✕**: it was **pulled** before price got there, or
- a **dot**: price **traded into** it.

A perpetual's book takes about a minute and a half to fill out; the legend says so meanwhile. Walls that lived under ten seconds are not recorded, because near the price market makers re-quote every few seconds. How walls are found: [Analytics](../design/analytics.md#order-walls).

## Footprint

The **footprint** icon (a vertical line with a row of bars on each side) → "Show footprint".

![Footprint: taker sells and buys at each price inside each 1m candle, the POC boxed, delta along the bottom](../images/order-flow/footprint.png)

- Each candle shows **taker sells (left, down colour)** and **taker buys (right, up colour)** at each price. Candles become hollow, an orange box marks the candle's highest-volume price (POC), and the bottom of the chart shows each candle's **Delta** (taker buys − taker sells).
- Below 72px bar width it draws two rows of bars; at 72px or more each row shows `sell buy` numbers shaded by volume.
- **Imbalances** (a price's taker buys ≥ N × the taker sells one tick below, or its taker sells ≥ N × the taker buys one tick above) are drawn solid or bold; pick 2 / 3 / 4× in the menu.
- "**Zoom to last 30 bars**" fills the screen with the last 30 bars in one click.
- It covers the last 30 bars (up to 6 hours). Turning it on loads from disk and backfills the missing last 3 hours from the exchange, newest first; bars not fully backfilled yet are faded, with `~` before the Delta.

Unlike the volume profile, the footprint is exact: it is built from every trade. The backfill yields to order placement, which shares the same request quota. The full design: [Footprint](../design/footprint.md).
