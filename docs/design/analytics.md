**English** | [繁體中文](analytics.zh-TW.md)

# Analytics

How the numbers on the chart are computed, and why that way: volume profiles, range alerts, thin volume, RSI and MACD, CVD, big orders and the position read, order walls, and liquidations. How to use each is in the [guide](../README.md#user-guide); the footprint has [its own page](footprint.md).

## Volume profiles

Built the way TradingView builds its own: load the session's **1m bars** and spread each bar's volume evenly over the price rows it touched. TradingView's own documentation calls this an estimate, not tick-accurate. A day of 1m bars costs **2 requests**; BTCUSDT's aggTrades for a day are about 820,000 trades and 819 requests, and the accuracy gained isn't worth that. Crypto has no sessions, so "session" means the exchange's day, 00:00 UTC on Binance.

- All three modes are drawn by the chart itself (a series primitive), in the same frame as the candles, so resizing a card doesn't lag. The per-4H mode is built from 5m bars: closed blocks are computed once and cached, the block in progress every minute.
- **Rows follow the screen.** Rows = the profile's height on screen ÷ the Detail setting, so zooming in on the price axis gives more rows rather than coarser ones.
- **The fixed range profile picks the finest bars that keep the range near 3,000** (1m up to two days, 5m around ten days, 15m a month): the finer the bars, the fewer rows each bar's volume is spread over and the closer to what traded. Closed ranges go through the bar cache; a "to now" range fetches only its last stretch each minute. Buys and sells split by candle direction, like TradingView's up / down volume, rather than by the cache's taker-buy volume.

## Range alerts

The percentage is the share of the period's volume that traded below the current price, **counted straight from the volume profile with no distribution fitted**. That was chosen after measuring. On 30 days of 1m bars for the BTC and ETH perps:

- Assuming a normal distribution from VWAP and standard deviation was off from the real cumulative share by 4 percentage points on average and about 10 in the worst tenth (a real 70% reported as 80%).
- Real 24H and 72H profiles are mostly not unimodal: choosing 1–3 Gaussians by BIC mostly picks 3.

Counting needs no shape, so it can't get the shape wrong. The same data gave the alert frequencies the defaults are built on, and the finding that it is not an entry signal (after price was above 90%, a decline over the next 4 hours was 44–57% likely, inconsistent across coins and windows). Touches are checked on live quotes rather than closes, which in testing missed 15–30% of them; hysteresis re-arms a level only after price returns past 50%.

## Thin volume

Volume has a long tail (a spike can be 10 to 50 times an ordinary bar), so "under half the average" is pulled around by every spike. A percentile rank only counts places and the tail can't move it (`renderer/volume-stats.js`).

- The distribution is a histogram of log volume, low-pass filtered: every closed bar is one step of an exponential filter on the whole histogram (every bin decays by `1 − a`, the new bar's bin gains `a`), so the weights keep summing to 1 and `a = 1 / memory` remembers about `memory` bars. No shape is assumed.
- The filter starts from the plain histogram of the first `memory` bars rather than zero, so the first bars rank against a real distribution.
- Bars rank by quote volume (USDT) where they have it: over a thousand bars price can double, and the same dollars in coins would look like half the volume. The forming bar is not judged.

## RSI and MACD

**Recursive filters in plain JavaScript.** An EMA is the one-pole filter `y[n] = a·x[n] + (1−a)·y[n−1]`, i.e. `scipy.signal.lfilter([a], [1, a−1], x)`; RSI is two of them (Wilder's smoothing, `a = 1/n`).

- In Python, lfilter beats numpy and pandas because it runs the loop in C instead of the interpreter. JavaScript has no interpreter loop to escape: V8 compiles the plain `for` loop to machine code. **A million closes, RSI and MACD together, take about 35 ms** (`scripts/test-indicators.mjs`). So there is no native DLL, which would also need rebuilding for every Electron upgrade.
- Like lfilter's `zi` / `zf`, the filter state is carried. The full pass runs only when the bars are replaced (load, history, trim); after that each closed bar advances the state once, and each live tick only *peeks* at what the forming bar would give, a few multiplications, without committing it.
- Each filter is seeded with the simple mean of its first n inputs, as TradingView's `ta.ema` / `ta.rsi` are, and the tests compare the live values with a full recompute tick by tick.

## The crowd in context

The crowd's long/short ratio (`globalLongShortAccountRatio`) is hard to read on its own. Measured on 30 days of hourly BTC and ETH perpetual data (7 October – 6 November 2026):

| | BTC | ETH |
| --- | --- | --- |
| Share long, min – median – max | 48% – 64% – 76% | 65% – 75% – 80% |
| Correlation of 24h change in the ratio with 24h price change | −0.87 | −0.75 |
| Correlation of 1h changes | −0.04 | −0.01 |

Three things follow, and the share-long unit of the pane is built on them (`crowdContext` in `renderer/long-short.js`):

1. **Read the share, not the ratio.** long / short stretches as it rises: ETH's 2.95 → 3.92 is 74.7% → 79.7%, against a ceiling. The pane draws `100 · r / (1 + r)`.
2. **Read it against its own level.** Accounts are counted, not sized, and small accounts lean long, so the crowd has a floor of its own. The baseline is the median of the share over the 168 hours before (at least 84 of them), and the band two robust deviations (1.4826 × MAD) either side.
3. **Take the price out.** Most of the day-to-day movement is the crowd buying falls and selling rallies. For each hour, the 24h change in the share long is regressed on the 24h price change over the 240 hours before (at least 120 pairs), and the bar is that hour's residual in standard deviations of the fit's residuals.

Everything at an hour is fitted on earlier hours only, and a test checks that changing later hours leaves earlier figures untouched. Samples and prices are hourly over the 30 days the exchange keeps, fetched once an hour whatever the card's interval, and mapped to bars the way the ratios are (the newest point by a bar's close, carried no longer than an hour).

**What the month said about the signal.** Taking the deviation from the 7-day baseline in the log ratio, on BTC:

| Crowd vs its 7-day baseline | Hours | Next 24h, average | Share down after 24h |
| --- | --- | --- | --- |
| ≥ +2σ (far more long than usual) | 19 | +0.24% | 21% |
| ≤ −2σ (far less long than usual) | 50 | −3.9% | 94% |

The crowd was most long at local lows (77.5K on 31 October, 75.8K on 6 November): after a fall, buying the dip. It was least long near highs (84.2K on 22 October at a ratio of 1.02, 80.5K on 5 November at 1.39), and both preceded drops. So "the crowd is very long, so it will be flushed" did not hold that month; "the crowd has turned away near a high" did. The sample is small (overlapping hours, two or three episodes), which is why the pane shows context and colours only the extremes rather than issuing signals. ETH, already near its ceiling, showed no consistent pattern either way.

## CVD

Cumulative volume delta is the running sum of taker buys minus taker sells (`renderer/cvd.js`). Every Binance kline carries the taker-buy volume, so the delta is `2 × takerBuy − volume` per bar, free on both markets. Each bar's delta is converted to USDT at its average price (quote volume ÷ volume), matching the volume bars and within about 1% of Binance's exact taker-buy quote volume. The daily-reset mode restarts the sum at each UTC midnight and breaks the line there.

## Big orders and the position read

**One order is one millisecond.** A taker order that sweeps several prices is printed as several aggTrades with the same millisecond timestamp, so a millisecond's trades, summed, are one order (20:50:26.306 on ETHUSDT was 7,000 ETH sold at seven prices in one go).

**Big is a rank, not an amount.** Measured over an hour, $500K was 35 orders on ETH and none on ADA, while "the top 0.1% of this coin's orders" is a comparable handful on each. The hub ranks each order against a log-binned histogram of the last one to two hours of orders, seeded with the newest 5,000 aggTrades from REST so the first ranks are not guesses (`renderer/datafeed/sweep-collector.js`). Orders in the top 0.5% are stored ([Storage](storage.md#big-orders)); the card picks its threshold from those.

**The position read stores nothing.** It is computed from the bars' taker-buy volume and open interest (`renderer/flow-read.js`). OI only moves when both sides of a trade open (up) or both close (down), so ΔOI says how much was opened or closed, and the taker side says which way the aggressors leaned:

| Takers | ΔOI | Read |
| --- | --- | --- |
| Net buying | Up | Longs opening |
| Net selling | Up | Shorts opening |
| Net buying | Down | Shorts closing |
| Net selling | Down | Longs closing |

A bar is read only when OI was sampled inside it, which means the hub's 3-second polling while the app runs: Binance's 5-minute history gives a 1m bar one sample or none and would pile five minutes of change onto one bar. It reads net numbers per bar, so opening and closing within one bar offset each other, and only bars whose |ΔOI| is 2 / 3 / 5× the median are tagged.

## Order walls

The hub keeps a local copy of the order book for every symbol a card shows walls for (`renderer/datafeed/order-book.js`): Binance's REST snapshot with the change stream applied in sequence. Each frame names the update it follows; a gap refetches the book, at most once a second.

- **Depth.** On spot the snapshot is 5,000 levels a side, about ±1.5% on BTC; on perpetuals 1,000, under ±0.2%, and levels beyond join as they change. A BTC perpetual frame changes some 800 levels, so the book is read only after 90 seconds.
- **Buckets.** Each second the book within ±3% of the mid is summed into buckets of 5 basis points ($50 on BTC near 80K, $1 on ETH).
- **Scored locally.** Each bucket is compared with the median of the non-empty buckets within ten on either side. The book is always thicker by the price than a percent out, so against the whole side's median every level near the price stood out (twenty "walls" on ETH spot in a test).
- **A floor.** A wall must also hold at least the median bucket within 0.5% of the mid, so a few thousand dollars in a thin stretch far out is not one.
- **Lifetime.** It stays a wall until it holds less than half its peak. Walls that lived under ten seconds are not recorded, because by the price market makers re-quote every few seconds.
- **Filled or pulled.** When a wall goes, the lowest best bid and highest best ask since the last check say whether price came within a bucket of it: if so it was filled (a dot), if not pulled (✕).
- The hub keeps six hours of ended walls in memory, from when the first card asked for that book.

## Liquidations

**Recorded** (`renderer/liquidations.js`, `renderer/datafeed/liquidation-feed.js`). The hub keeps one socket per exchange while anything is wanted, and records every perpetual a card is open on:

| Exchange | Stream | What it sends |
| --- | --- | --- |
| Binance | `!forceOrder@arr` on `fstream.binance.com/market/stream` | Every symbol, but **at most the latest liquidation per symbol per second** (the bare `/ws` route connects and sends nothing). `S` is the order's side: SELL closes a long |
| Bybit | `allLiquidation.{symbol}` on `stream.bybit.com/v5/public/linear` | Every liquidation, a topic per symbol, ten to a request. `S` is the *position's* side: Buy means a long was liquidated |
| OKX | `liquidation-orders`, `instType: SWAP`, on `ws.okx.com:443/ws/v5/public` | Every swap on one channel, sizes in contracts (`ctVal` from the instrument list). On subscribing it also replays the last one per instrument, which the cache's keys deduplicate |

Each becomes `{t, ex, side, price, qty, usd}` on the Binance symbol's scale (OKX lists `PEPE-USDT-SWAP` where Binance has `1000PEPEUSDT`, so its price and size are rescaled). A bar is marked when its longs or shorts reach the coin's own top 10 / 5 / 2% of bars that had any, the same idea as big orders being ranked against their own coin.

**Estimated** (`renderer/liquidation-map.js`). No exchange publishes liquidation prices, so the map is reasoned from Binance's 5-minute bars and open interest over the last 30 days:

1. **OI up by Δ**: Δ new longs and Δ new shorts at the bar's VWAP. The side that crossed the spread counts in full; the resting side, often a hedged market maker and rarely liquidated, counts at half. With *b* the taker-buy share: longs = Δ(*b* + ½(1 − *b*)), shorts = Δ(1 − *b* + ½*b*).
2. **Leverage** is assumed: 5% at 100×, 10% at 50×, 20% at 25×, 15% at 20×, 30% at 10×, 20% at 5×. A long's liquidation price is entry · (1 − 1/L + 0.5%), a short's entry · (1 + 1/L − 0.5%): isolated margin, at Binance's lowest maintenance rate.
3. **OI down by Δ** closes Δ of each side, weighted the other way round (taker sells close longs), **newest positions first**.
4. A level that any later bar reached is gone: liquidated, or it would have been. Live, the forming bar keeps clearing what it reaches.

Newest-first was measured. Taken pro rata from everything open, a month of five-minute OI churn wore every old position down: on BTC it left $0.3B of liquidatable longs. Most of the OI that comes and goes inside a month is short-term trading opened and closed within hours, and what stays is what was not closed. Even so the map holds only about $1B of BTC's $7.4B open interest. The rest was opened before the window, is the resting side counted at half, or sat at levels price has since passed. That is why the amounts are drawn as relative sizes and labelled *≈* and *Est.*

Thirty days of 5m is 8,640 bars and builds in under 10ms. The map names, on each side, the nearest pool holding at least 60% of the largest within ±12%. Naming the single largest made two pools of nearly equal size swap the label back and forth as data arrived.
