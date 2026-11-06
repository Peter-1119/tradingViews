**English** | [繁體中文](storage.zh-TW.md)

# Storage

What the app keeps on disk, where, and in what format. Everything is under the user-data folder, `%APPDATA%/stock-card/` (`userData` below), unless the app is started with `--user-data-dir`.

| What | Where | Size |
| --- | --- | --- |
| Settings, cards, drawings, alerts | `stock-card-config.json` | Small |
| Bar cache | `bars2/{SYMBOL}/{interval}/{chunk}.bin`, perps under `bars2/_perp/` | 64 bytes a bar |
| Open interest | `bars2/_perp/{SYMBOL}/oi_1m/`, `oi_5m/` | ~92 KB and ~18 KB per symbol per day |
| Big orders | `bars2/[_perp/]{SYMBOL}/sweeps/{YYYY-MM}.bin` | ~3–4 MB a month on ETH |
| Footprint | `footprint/[_perp/]{SYMBOL}/{hour}.fp`, last 12 hours | ~1.5 MB per 12 hours on BTC |
| Trading keys | `trading-credentials.bin` (DPAPI-encrypted) | Small |
| Paper account | `paper-account.json`, backups `paper-account-<time>.json` | Small |

Order-book walls are kept only in memory (six hours of ended walls in the hub); nothing about them is written.

## Settings

`stock-card-config.json` holds every card (symbol, market, interval, chart type, panes, position and size), the global settings, the watchlist, drawings and alerts. The folder is pinned to `stock-card` in `main/main.js`, keeping the app's old name, so the development and installed builds share one file and cards set up under `npm start` carry over to the installed app. An explicit `--user-data-dir` (a separate test profile) still wins.

Position and size changes are debounced 500ms before being written. At startup, saved positions are checked against the current screens and cards are pulled back into view if the layout changed.

## Bar cache

When you scroll back near the edge of the loaded bars, older ones are fetched in the background, local cache first and then the API, and whatever is fetched is written to the cache.

- **Format.** Fixed-width binary, 64 bytes a record: eight float64s, `time, open, high, low, close, volume, buyVolume, quoteVolume` (the taker-buy volume and the volume in USDT). Records used to be six fields; the wider format moved to `bars2` and the old `bars` folder is deleted.
- **Perps apart.** BTCUSDT has the same name on both markets but different bars, so perpetuals live under `bars2/_perp/`.
- **Chunked by time.** 1m and 5m by **month**, everything else by **year**. Backfilled older data goes into different files, so each file is only ever appended to and always sorted inside: no global sort and no rewriting the history.
- **Closed bars only.** The last bar Binance returns is always still forming; caching it would freeze half a candle forever.
- **Fast.** On the same range: cache 7.4ms against network 142ms (**19×**), identical content.
- A history page the cache only partly covers is refetched, and trimming the series keeps it in step with the cache.

## Open interest

Binance has no OI WebSocket: only REST snapshots (updated every 2–5 seconds) and a history at 5-minute resolution at best, 30 days deep. The 1-minute OI on CoinGlass is recorded continuously by them; the app does the same and keeps two series in the bar cache's format and layout:

| Series | File | Source | Written by |
| --- | --- | --- | --- |
| `oi_1m` | `bars2/_perp/{SYMBOL}/oi_1m/{YYYY-MM}.bin` | A snapshot every 3 seconds, rolled into one OHLC record a minute (the volume field holds the sample count) | Only the hub, so several cards on one symbol write it once |
| `oi_5m` | `bars2/_perp/{SYMBOL}/oi_5m/{YYYY-MM}.bin` | The exchange's 5-minute history, one sample a record (the volume field holds the USD value) | Cards fill the gap since last time when they load; once per launch the whole range is re-checked |

- 15m, 1h, 4h and 1d are **not stored**: they are computed at display time by merging the two series and bucketing (`renderer/open-interest.js`). Where the 1m chart has no recording of its own it fills from the surrounding 5m samples, and where two samples are more than 10 minutes apart it leaves a gap rather than a flat line nobody measured.
- OI is recorded while a perp card is open **whether or not the pane is on**, so the history is there when you open it.
- The 5m history only fills gaps (the second launch in testing made one request covering 5 minutes), so opening the app at least every 30 days grows the cache beyond the exchange's 30 days.
- **The exchange rewrites history.** On 2026-10-15 the history endpoint returned bad data for hours (ETH OI fell from 2.31M to about 1.9M, then samples came every second or two, off the 5-minute grid). Binance corrected it later, but the cache had stored the bad version and gap filling would never ask again. So: (1) samples off the 5-minute grid are never stored or read; (2) after each launch, the first time a symbol's OI pane is drawn, the 30 days the exchange still has are fetched in the background and compared, and differences are overwritten with the exchange's version (`replace` in `bar-store.js`, which also clears bad samples in between). The cache older than 30 days is left alone. That is 18 requests on an endpoint with its own quota, and if the exchange returns under 90% of the samples nothing is overwritten, so one failure can't wipe the cache.

## Big orders

Orders in the top 0.5% of their coin's recent orders are stored as series `sweeps` in the bar cache's layout, monthly files of 64-byte records: time to the millisecond, rank, price range, VWAP, quantity, the taker-buy part and USDT. That is about 75 an hour on ETH. The card picks its threshold from these, so changing it needs no new data. They exist only for the time the app was collecting. How orders are ranked: [Analytics](analytics.md#big-orders-and-the-position-read).

## Footprint

Only closed, complete minutes are stored, one file per pair per hour, keeping the last 12 hours. Prices are stored as ticks from the previous level and quantities as integers in the smallest unit, both as varints, then gzipped: lossless. A minute of BTCUSDT perp has about 1,300 price levels, about 25 KB as float64 and about 2 KB this way. If the app is killed mid-write, reading the file recovers the minutes before the break and rewrites it. Full design: [Footprint](footprint.md).

## Keys and the paper account

- **Trading keys** are encrypted with Windows DPAPI and stored in `trading-credentials.bin`, readable only by the main process under your Windows account. Pages see only the last four characters and the key type. See [Trading internals](trading.md#keys).
- **Paper account**: balance, positions, orders and history. Restarting with a new balance backs the old one up as `paper-account-<time>.json`.

None of these files belong in the repository; they are outside it.
