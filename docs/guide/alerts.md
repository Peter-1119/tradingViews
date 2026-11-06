**English** | [繁體中文](alerts.zh-TW.md)

# Alerts

Three kinds: **price** alerts, **volume** alerts, and **range** alerts that say where the price sits in its recent volume distribution. Order fills and TP / SL triggers notify you too; see [Trading](trading.md#fill-alerts).

None of them make a sound (by request). How each one reaches you, including while a game is running, is at the [end of this page](#how-notifications-reach-you).

## Price alerts

| Action | How |
| --- | --- |
| Set | Pick the **bell** in the toolbar and click a price on the chart (`Ctrl` snaps to OHLC); or press `Alt+A` with the mouse over the chart |
| Direction | Above the current price it is a "Rose to" alert, below it a "Fell to" alert |
| Move | Drag the label of its gold dashed line |
| Delete | Click ✕ on the label |

When the price is reached a Windows notification is sent (silently) and the taskbar flashes, following the range-alert notification settings; each alert fires once and is removed.

Alerts are watched by the hidden data window, so they **fire even when the cards are hidden with `Ctrl+Alt+S` or closed**. Only symbols with alerts are watched.

## Volume alerts

The same bell (or `Alt+A`), but click **on the volume bars** instead of the candles; while the bell is armed a gold tag shows the volume under the mouse.

- It fires the first time **one bar** of the card's current interval reaches that volume (in USDT), then is removed.
- Set below the forming bar's volume, it waits for the next bar instead of firing at once.
- The line shows only on the interval it was set on. Drag its label to change it, ✕ to delete.

## Range alerts

For symbols in the watchlist (☆), the top left of the chart shows where the current price sits in the **4H / 24H / 72H** volume profile, e.g. `4H 17 · 24H 34 · 72H 23`: the share of that period's volume that traded below the current price. Colours: orange at 80% and up, red at 95% and up, light blue at 20% and below, blue at 5% and below.

When a chosen level is touched, the card's border glows, a Windows notification pops up and the taskbar flashes; **click the card** to clear it. Choose the levels in the checkbox grid under "Range alerts" in the settings panel.

| Switch | Where |
| --- | --- |
| Master switch | Tray right-click → "Range alerts" |
| Per symbol | Tray → "Alert symbols", or 🔔 / 🔕 on each row of the symbol list (click the symbol name) |

A notification fires only when both the master switch and that symbol are on. Muted symbols still show their percentages, and alerts missed while muted are not replayed later.

- **Live.** The profile is recomputed each time a 1m bar closes; the price is checked against it on live quotes (up to every 100ms), so an alert fires when the price **touches** a level, not at a close. Checking closes only missed 15–30% of touches in testing.
- **Hysteresis**, like a Schmitt trigger. Each level fires once; the upper levels (80 / 90 / 95) re-arm only after going back below 50%, the lower ones (20 / 10 / 5) after going back above it. Jumping past several levels reports only the furthest, and starting the app at 92% does not fire 80 and 90 at once.
- **Default levels**, with measured frequency per symbol per day: all six for 24H and 72H (about 8.5 and 2.7 alerts), only 5% and 95% for 4H (about 11; all six on 4H is about 45 a day, too noisy).
- **Watched in the background.** Watchlist symbols are monitored by the hub even with no card open, keeping 72 hours of 1m bars per symbol.

> **This is not an entry signal.** In the same data, the chance of a decline over the next 4 hours after price was above 90% was 44–57%, with no consistent direction across the two coins and three windows. It tells you where in the distribution you are, so you don't chase at the worst spot without noticing.

Why the percentage is counted straight from the profile rather than fitted to a curve: [Analytics](../design/analytics.md#range-alerts).

## How notifications reach you

| Signal | Over a borderless-window game | Over a full-screen game |
| --- | --- | --- |
| Card border glow | Visible | Not visible |
| Windows notification | Sent to the notification centre by Focus Assist (no banner while Warcraft III ran in testing) | Not visible |
| Taskbar flash | The card temporarily gets a taskbar button; clicking the card stops it | Not visible |

Nothing makes a sound. Why nothing shows over a full-screen game, and what can be done about it: case G in [Vanishing cards](../troubleshooting/vanishing-cards.md).
