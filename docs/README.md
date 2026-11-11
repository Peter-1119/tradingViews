**English** | [繁體中文](README.zh-TW.md)

# TapeCard documentation

[← Back to the project README](../README.md)

New to the app? Read [Reading the chart](guide/chart.md) and [Cards & windows](guide/windows.md) first, then press `F1` on any card for the cheat sheet of every key.

## User guide

How to use each feature.

| Page | What's in it |
| --- | --- |
| [Reading the chart](guide/chart.md) | Zoom and pan, the crosshair, prices and times, higher-timeframe overlay, RSI / MACD, the toolbar, language |
| [Symbols & markets](guide/markets.md) | Symbol search, spot ↔ perpetual, stock and commodity perpetuals, the watchlist |
| [Drawing](guide/drawing.md) | Levels, trend lines, Fib, rectangles, measuring, colours, hiding, undo |
| [Levels & volume profiles](guide/levels.md) | Daily / weekly / monthly opens, highs and lows, volume profiles, fixed range volume profile |
| [Order flow](guide/order-flow.md) | Volume, CVD, open interest, long / short ratios, big orders, position read, order walls, liquidations, footprint |
| [Alerts](guide/alerts.md) | Price, volume and range alerts, and how notifications reach you while gaming |
| [Trading](guide/trading.md) | Binance perpetuals: setup, the order ticket, TP / SL, dragging orders, reversing |
| [Paper trading](guide/paper-trading.md) | The local practice account, how fills and costs are computed, the journal |
| [Cards & windows](guide/windows.md) | Float and Board, mini chart and ticker, click-through, settings, shortcuts, limitations |

## Design

Why the app is built the way it is, for anyone changing it.

| Page | What's in it |
| --- | --- |
| [Architecture](design/architecture.md) | Processes, the hidden hub window, `app://`, interface language, source files, tests |
| [Data sources](design/data-sources.md) | Binance endpoints, update rate, reconnects, request budget, spot ↔ perp symbol mapping |
| [Storage](design/storage.md) | Settings, bar cache, open-interest recording, big orders, footprint and key files |
| [Analytics](design/analytics.md) | Volume profiles, range alerts, thin volume, RSI / MACD, CVD, big orders, position read, order walls, liquidations |
| [Trading internals](design/trading.md) | Keys, rounding, exact order ids, repricing, reversing, the paper exchange |
| [Footprint](design/footprint.md) | The footprint chart from evaluation to implementation, with measurements |
| [Original specification](design/original-spec.md) | The spec the project started from (historical) |

## Troubleshooting

| Page | What's in it |
| --- | --- |
| [Vanishing cards](troubleshooting/vanishing-cards.md) | Every way a card has disappeared so far, how to tell which, and how to fix it |

## For contributors

[CONTRIBUTING.md](../CONTRIBUTING.md) covers the checks to run, the rules for translations and these documents, and how the screenshots are made. Changes by date are in [CHANGELOG.md](../CHANGELOG.md).
