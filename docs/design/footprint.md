**English** | [繁體中文](footprint.zh-TW.md)

# Footprint implementation notes

This document records how "taker buy and sell volume at each price level", that is, the footprint chart (also called an order-flow chart), is built. **It is implemented** ("Footprint" on the toolbar). Sections 1–3 are background from the evaluation; section 4 onward covers the actual implementation and measured numbers.

The simpler layer is the **taker buy/sell split per candle**: the volume pane splits each volume bar into two parts, taker buys on the bottom and taker sells on top, plus a low-volume marker. The footprint breaks that split down further, to "each price level".

---

## 1. What a footprint chart is

Next to each candle, it lists, price level by price level, what traded within that candle:

```
          Sell × Buy
83,420    12 × 3
83,410    40 × 18     ← left: taker sells (hitting bids)
83,400   105 × 230    ← right: taker buys (lifting offers)
83,390    31 × 92
```

- **Taker sells (bid side)**: the taker is the seller, selling into bids.
- **Taker buys (ask side)**: the taker is the buyer, buying from offers.
- Common extras:
  - The difference per cell (buy − sell).
  - Each candle's POC: the price level with the most volume.
  - **Imbalance**: a diagonal comparison; when a level's taker buys are 3× or more the taker sells one level below, it is colored.
  - Each candle's total Delta at the bottom.

On CoinGlass this kind of chart lives in the chart modes rather than the ordinary indicator list; look for "足跡圖" or "Footprint".

## 2. How it differs from the finished "candle buy/sell split"

| | Candle buy/sell split (done) | Footprint (this document) |
|---|---|---|
| Granularity | One set of numbers per candle | Per candle × per price level |
| Data source | The kline's own `takerBuyBaseVolume` (`k[9]` / stream `k.V`) | Individual trades, `aggTrade` |
| History | Comes with the klines, free | Must be downloaded trade by trade; only the last 3 hours are backfilled, the rest is accumulated while the app is open |
| Cache | `bars2` cache (8 fields per record) | `footprint/` cache (one segment per minute, variable length, kept for 12 hours only) |

## 3. Data sources

### 3.1 Live: the `<symbol>@aggTrade` stream

The hub already subscribes to aggTrade for every card (`aggTradeStream()` in `binance.js`, so the candle's close moves faster than the kline does). For the footprint, the `aggTrade` branch of `dispatch()` also hands a copy to `FootprintCollector`.

| Field | Meaning |
|---|---|
| `p` | Trade price (the number of decimals in the string is the price precision, used to turn the price into an integer key) |
| `q` | Quantity (in coin); its number of decimals likewise sets the integer unit used for storage |
| `m` | **Buyer is maker**: `true` means the taker is the seller, counted as a taker sell; `false` counts as a taker buy |
| `T` | Trade time (ms); decides which minute it falls in, rather than the time the message arrived |
| `a` | aggTrade ID, consecutive and increasing; used to detect missed trades |

### 3.2 History: REST `aggTrades`

- Perpetual `GET /fapi/v1/aggTrades`: **weight 20**, IP limit 2400 per minute; only the last 48 hours can be queried. Spot `GET /api/v3/aggTrades`: weight 4, limit 6000.
- At most 1000 trades per request; the `startTime` / `endTime` range must be under 1 hour; don't send it together with `fromId`.
- **Measured volume** (2026-10-15, latest minute): BTCUSDT perpetual 3,634 trades, 4 requests, 1,153 price levels; ETHUSDT 2,910 trades, 3 requests, 560 price levels; DOGEUSDT 342 trades, 1 request, 15 price levels.
- Approach: backfill one minute at a time (`startTime` = start of the minute, `endTime` = end); when a page is full at 1000 trades, page forward with `fromId` until the trade time passes the end of the minute.

### 3.3 Completeness

aggTrade IDs are consecutive, so completeness can be judged without reconciling against the kline volume:

- A minute is **complete** = every one of its trades was received within a single stretch of the stream with no gaps in IDs, and that stretch was already receiving before the minute began (the last trade of the previous minute was seen).
- This is only known once the first trade of the next minute arrives (which confirms nothing was missed after this minute's last trade), so that is when a minute "closes".
- A minute with no trades at all: if the IDs of the trades on either side are consecutive, the minute is empty and complete.
- Incomplete minutes (the minute the card opened, minutes spanning a reconnect, minutes while the app was closed) are refetched whole over REST after they close, replacing the stream version. Only complete, closed minutes are saved.

## 4. Actual architecture

```
  hub                                                          card
 ┌────────────────────────────────────────────────┐           ┌────────────────────────────────────────────────┐
 │ aggTrade stream                                │           │ FootprintBook                                  │
 │  └→ FootprintCollector (one per coin)          │ ─IPC→     │   minutes → candles (5m = five 1m summed)      │
 │      minute × raw price level → [sell, buy]    │ snapshot  │ FootprintPrimitive                             │
 │      completeness, REST backfill (1 per second)│ + updates │   rows merged by zoom, POC, imbalance, Delta   │
 └────────────────────────────────────────────────┘           └────────────────────────────────────────────────┘
        │ closed, complete minutes
        ▼
  main/footprint-store.js → userData/footprint/{_perp/}{SYMBOL}/{hourStart}.fp
```

- When a card turns the footprint on it calls `setFootprint(subId, true, fromSec)`: the hub first reads the saved files and returns every minute it has (the snapshot); after that, every change to a minute (every 250ms for the minute still forming, on close, and when REST backfill arrives) is pushed to the card through `datafeed:footprint`.
- The card ranks versions as "forming < closed but incomplete < closed and complete", so when the snapshot and updates cross in transit, a minute that is already final is never replaced by an older version.
- Range: the last 30 candles, at most 6 hours (the card and the hub each keep a copy of the 1-minute raw price level data; BTC is about 30KB per minute). REST backfills only the last 3 hours; anything older comes only from the saved files.

### 4.1 File format

Each minute is one gzip member, appended directly to that hour's file (gzip members can be concatenated and are read back as one stream on decompression). Everything inside a member is an unsigned varint:

```
[minute] [log10 price scale] [log10 quantity scale] [firstId] [lastId − firstId]
[level count] [first price key] then for each level: [difference from previous key] [taker sells] [taker buys]
```

- Price key = price × 10^decimals; consecutive levels differ by 1, which takes only 1 byte.
- Quantities are stored as integers in the smallest unit, with no loss.
- **Measured**: a BTCUSDT perpetual minute has about 1,300 price levels, about 25KB as float64, about 2.3KB stored this way; merged into $1 rows about 0.5KB (but that isn't needed, merging is done only when drawing). 12 hours is about 1.5MB.
- Only the last 12 hours are kept; older files are deleted on every write.
- Killed mid-write: if reading a file fails, the minutes before the break are recovered with `Z_SYNC_FLUSH` and the file is rewritten, so minutes appended later remain readable.

### 4.2 Rendering (`renderer/footprint-primitive.js`)

- When on, candles become hollow; the left and right columns are drawn behind the candles, and numbers and boxes in front.
- **Candle width < 72px**: left and right columns of horizontal bars, each row targeting 4px tall, lengths scaled to the larger side of that candle; imbalances are drawn solid, everything else translucent.
- **Candle width ≥ 72px**: "sell buy" numbers on each row, targeting 14px tall, with background shade showing volume; imbalances bold and colored.
- Row height = 1, 2 or 5 × 10ⁿ times the raw price step, with boundaries aligned to whole multiples.
- POC gets an orange box; each candle's Delta is printed at the bottom of the chart (when width ≥ 22px).
- Incomplete candles (not yet fully backfilled) are drawn faded, with `~` in front of the Delta.
- **Imbalance**: diagonal comparison. A row's taker buys ≥ N × the taker sells of the row below, or a row's taker sells ≥ N × the taker buys of the row above (N selectable as 2 / 3 / 4, default 3); a zero on the opposite side doesn't count, otherwise the top and bottom rows of every candle would light up.

## 5. Possible additions

- When the crosshair rests on a row, show that row's buys, sells and difference in the readout (currently you have to zoom in to number mode to see numbers).
- Mark stacked imbalances (3 or more rows in the same direction) as a zone, often treated as support/resistance.
- Cumulative Delta (CVD) pane: can be computed directly from the kline's `buyVolume`, without footprint data.
- Works for both spot and perpetuals; spot's REST weight is lower, so backfill can be faster.

## 6. Related files

- `renderer/datafeed/footprint-collector.js`: collection, completeness, REST backfill, throttling.
- `renderer/datafeed/binance.js`: `setFootprint()` / `releaseFootprint()`, aggTrade routing.
- `main/footprint-store.js`: file encoding, reading and writing, retention, repairing truncated files.
- `renderer/footprint.js`: merging minutes into candles, merging into rows, POC, imbalance, quantity formatting.
- `renderer/footprint-primitive.js`: drawing.
- `scripts/test-footprint.mjs`: tests for the modules above.
