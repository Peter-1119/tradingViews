**English** | [繁體中文](data-sources.zh-TW.md)

# Data sources

Everything on the chart comes from public endpoints, with no sign-up and no API key: Binance's, and for liquidations Bybit's and OKX's as well. Only trading uses your key ([Trading internals](trading.md)).

## Hosts

| Market | REST | WebSocket |
| --- | --- | --- |
| Spot | `api.binance.com/api/v3` | `stream.binance.com:9443/stream` |
| USDⓈ-M perpetuals | `fapi.binance.com/fapi/v1` | `fstream.binance.com/market/stream`; order books on `fstream.binance.com/public/stream` |
| Liquidations, other exchanges | `www.okx.com/api/v5/public/instruments` (contract sizes) | `stream.bybit.com/v5/public/linear`, `ws.okx.com:443/ws/v5/public` |

REST paths and stream names are the same on both markets, so both are one `BinanceProvider` with a different market config, and reconnects, backfill and coalescing carry over.

**The perpetual socket must use `/market/stream`.** The old `/stream` still connects but no longer sends klines, trades or tickers, so a card would say "Live" and never move. The perpetual depth stream is served only on `/public/stream`, which is why order books have a socket of their own.

## Endpoints

| Data | Source |
| --- | --- |
| Historical klines | `GET /klines` (500 bars a page) |
| Live bars and prices | Combined stream: `@kline_<interval>` + `@miniTicker` + `@aggTrade`; perps add `@markPrice` |
| Symbol list | `GET /exchangeInfo`, cached 24 hours. Perps keep contract types `PERPETUAL` and `TRADIFI_PERPETUAL` (stocks, ETFs, metals, oil, FX), not delivery contracts |
| 24h change | `/ticker/24hr` once at startup, then miniTicker |
| Funding rate | `/premiumIndex` once at startup, then `@markPrice` (every 3 s). The settlement interval comes from `/fundingInfo`, which lists only symbols not on 8 hours (cached 1 hour) |
| Open interest | `/fapi/v1/openInterest` polled every 3 s; history `GET /futures/data/openInterestHist` (5m, 30 days) |
| Long / short ratio | `/futures/data/globalLongShortAccountRatio` (accounts) and `/topLongShortPositionRatio` (top traders' positions): 5m samples, 30 days |
| Footprint, big orders | Live from the subscribed `@aggTrade`; missing minutes from `GET /aggTrades` (one minute by `startTime` / `endTime`, paging with `fromId` past 1,000 trades), at most once a second |
| Order walls | `GET /depth` snapshot (spot 5,000 levels a side, perps 1,000) plus the `@depth` diff stream |
| Liquidations | Binance `!forceOrder@arr`, Bybit `allLiquidation.{symbol}`, OKX `liquidation-orders` ([Analytics](analytics.md#liquidations)); the estimated levels from the 5m klines and OI history above |

## Update rate

Binance's `@kline_*` pushes once a second, the ceiling for official bar values. To make the price move sooner, the per-trade `@aggTrade` is also subscribed, and between klines the trade price is merged into the forming bar's close, high, low and volume.

Trade messages are coalesced in the hub in **100ms** windows (`LIVE_TICK_MS`), and only the last in each window is passed on, so however hot the market, a card redraws at most ten times a second. When a kline arrives it overwrites the bar with the official values, so any error lives for at most a second. At a bar boundary the app does not open the new bar itself; it waits for the kline to roll over.

## Connection resilience

- After a disconnect, reconnects back off exponentially: 1 s → 2 s → 4 s → … → 30 s.
- On reconnect every stream is resubscribed, and klines missed during the outage are filled in over REST before rejoining the live stream.
- A socket silent for a minute while it has streams is treated as dead and replaced (a live one always has something: the perpetual mark price alone comes every 3 seconds), and bars a quiet stream skipped are filled in.
- The connection is replaced proactively at 23 hours, before Binance's forced 24-hour disconnect.
- The dot at the card's top left shows the state: green live, yellow reconnecting, red offline. No error dialogs.

These behaviours are covered by `npm test` (`scripts/test-datafeed.mjs`, with a fake socket and fetch), so they can be checked without pulling the network cable.

## Request budget

Binance limits REST by weight per IP, and **public data shares the quota with order placement**. Background jobs are written to leave room:

- Footprint backfill: `/aggTrades` costs 20 weight against 2,400 a minute, so it runs at most once a second (half the quota at most), waits for the next minute when the used weight in the response headers passes 1,500, and pauses per `Retry-After` on 429 / 418.
- OI and long / short history have their own quota (1,000 requests per 5 minutes) and don't touch the one orders use.
- The OI history endpoint always returns the **newest** 500 rows of any range however early `startTime` is, so history is paged from newest to oldest (asking for 10 days in one call returned only the last 41 hours).

## Symbol mapping

The Spot / Perp tag needs the other market's name for a symbol (`renderer/datafeed/binance.js`, `counterpartSymbol`):

1. A TradFi perpetual maps to its tokenized stock: base + `B` (`SNDKUSDT` → `SNDKBUSDT`), or nothing.
2. Otherwise the same name, if the other market has it and it is not a TradFi contract.
3. A spot base ending in `B` maps to a TradFi perpetual without the `B` (`SNDKBUSDT` → `SNDKUSDT`), so coins such as `ARB` are not mistaken for tokens.
4. Otherwise the scaled names: `1000PEPEUSDT`, `1000000MOGUSDT` and so on, in either direction.

The tests check this against the cases that broke it before (`WEN`, where a coin and a stock token clash; `ARB`; gold with no token).
