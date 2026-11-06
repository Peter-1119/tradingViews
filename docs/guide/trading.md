**English** | [繁體中文](trading.zh-TW.md)

# Trading (Binance USDⓈ-M perpetuals)

Placing and managing orders on Binance perpetuals from the card: the order ticket, TP / SL, positions, dragging orders to a new price, and reversing.

> **Leveraged trading is very risky.** The default environment is **Binance demo trading (testnet)**; switching to live needs an extra confirmation. To practise with your own starting balance and see statistics, use [Paper trading](paper-trading.md), which needs no API key. Nothing in this project is financial advice.

![The order ticket: limit price, amount, TP / SL with their PnL, funding and the long / short ratio, estimated liquidation](../images/trading/order-ticket.png)

## Setup

Right-click a card → Settings → "Trading" at the bottom.

1. **Create an API key** on [Binance demo trading](https://demo.binance.com/), or under API Management on a live account. Enable only "Reading" and "Futures trading", **never withdrawals**, and restrict it to your IP.
2. **Enter it** according to its type. "Connected · Available … USDT" means you are done.
   - **Self-generated (recommended).** Paste the API key, then "**Choose private key file…**" and pick your `.pem` file (it starts with `-----BEGIN PRIVATE KEY-----`). **Ed25519** and **RSA** are supported. The private key is read by the main process from the file dialog and never passes through the card's page; Binance only holds the public key you uploaded.
   - **System generated (HMAC).** Paste the API key and secret, then "Save & connect".
3. **Set leverage per symbol.** Click "Cross Nx ▾" in the order ticket header, type a number or click a preset (only this symbol's allowed multiples are listed; the rightmost is its maximum) → "Apply". Margin mode is fixed to **cross** and position mode to **one-way**; if the account is in hedge mode, the settings offer a button to switch.

To make an Ed25519 key (Binance's futures docs list only HMAC and RSA, but Ed25519 has been tested on a live account):

```bash
openssl genpkey -algorithm ed25519 -out stockcard-private.pem
openssl pkey -in stockcard-private.pem -pubout -out stockcard-public.pem
```

Paste the whole public key file, BEGIN and END lines included, into Binance.

**Where the key goes.** The secret or private key is encrypted with Windows DPAPI into `%APPDATA%/stock-card/trading-credentials.bin`, readable only by the main process under your Windows account. The card's page only ever sees the last four characters and the key type. See [Trading internals](../design/trading.md#keys).

**Leverage lives on your Binance account**, not in the app: Binance stores it per symbol, so the app, the website and the phone all see the same number. It is re-read every time the ticket opens and never changed by sending an order. Maximum leverage differs per symbol (BTC 125x, many small caps 20x or less) and falls as the position grows; if the estimated position exceeds what the current leverage allows, the ticket says so before you send.

## Placing an order

| Step | How |
| --- | --- |
| Open the ticket | On a perp card a **＋** follows the mouse left of the price axis; click it to open a ticket at that price |
| Lock a price | **Single-click** the chart: the price is locked and the ＋ pinned to its dashed line, so you can move over and click it. `Esc` or another click releases it (double-click still adds a level) |
| Fill it in | Limit or market; the amount as **notional in USDT** (10% / 25% / 50% / 100% of available margin × leverage); optional TP / SL. Below: quantity, margin, the **estimated liquidation price** for long and short, and what the TP / SL would make or lose |
| Send | Press "Long" or "Short": the button turns into a summary such as "Confirm long 0.235 ETH @ 2551.52". Press again, or `Enter`, **within 3 seconds** to send |

Every order is re-checked and rounded in the main process against the exchange's rules (tick size, step size, minimum notional) before it goes out.

### Ticket options

- **Amount unit.** Click the unit at the right of the amount (`USDT ⇄` / `ETH ⇄`) to size in **USDT** or in **coins**. Switching converts what is typed at the ticket's price, and the line below shows the other unit. In coin mode the quantity is sent as typed, rounded down to the step size. The choice is remembered for every card.
- **Default amount.** Type an amount (say 200) and click "Set default": every ticket then opens with 200 USDT filled in, and the button reads "Default ✓". When the moment comes, all that's left is the direction and the second press. Shared by every symbol and kept across restarts; set another amount to overwrite it, or clear the field and click to remove it. Not applied in reduce-only mode.
- **Split.** Limit orders only: **Split** (− / +, or the mouse wheel, 1–10, back to 1 each time the ticket opens) sends the amount as that many equal orders at the price, in whole steps with the leftover added to the first ones so the parts add up exactly. Each must still meet Binance's 5 USDT minimum. They stack on the chart as one label marked **×N**; drag the top one off to where you want it and the next shows. TP / SL ride on every part and go on once the first fills. If one fails part-way, the placed ones stay and the notice says how many went.
- **Reduce-only.** It can only shrink the position, never open or reverse one: a long can only "Close long (sell)", a short only "Close short (buy)". The percentage buttons become 25 / 50 / 75 / 100% **of the position** (100% is the exact size, leaving no dust) and larger amounts are blocked. No margin is needed and the TP / SL fields hide. Reduce-only orders are **exempt from the minimum order size**, so tiny leftovers can be closed. The position is re-read from Binance before sending.

### Long / short bias

The row above the estimated liquidation:

- The **funding rate** (positive: longs pay shorts; negative: shorts pay longs), a heat tag and the countdown. With an amount entered, it shows what a long or a short would pay or receive per settlement.
- "Heat" is measured against the **neutral rate**, not zero: funding = premium + 0.01% interest per 8 hours, so a perp tracking spot sits at 0.01%. Above neutral is **Longs hot**; below it, even if still positive, the perp is cheaper than spot and it reads **Shorts hot**. For symbols settling every 4 or 1 hours, neutral is scaled down to match.
- The next line is Binance's **long / short ratio**: "all" is the share of accounts with a position that are net long (mostly retail), "top" the long share of position size among the top 20% of accounts by margin. Refreshed every 5 minutes while the ticket is open. The same numbers can be charted: [Order flow](order-flow.md#long--short-ratio).

## Positions and orders on the chart

- **On the chart:** the entry line (its label shows live PnL), the liquidation line, order lines and TP / SL lines.
- **The position bar** along the bottom: side and leverage, size, entry, mark price, unrealized PnL and ROE, liquidation price. It is a row of the card's layout, below the time axis, not floating over the chart: with a position the chart gives up 22px, without one the row collapses, so it never covers the volume or OI panes. On narrow cards the secondary fields go first; PnL and the buttons always stay.

PnL is computed from the mark price every second. Positions and orders arrive both through Binance's user data stream (the moment a fill happens) and through REST polling every 3–12 seconds as a backup, so the display does not freeze if the stream drops.

### TP / SL

Triggered by the **mark price** and closing the whole position (Binance's conditional orders). On a limit order they are placed **after it fills**; fills that happen while the app is closed get their TP / SL the next time it opens. Edit them with "TP/SL" on the position bar; clear a field to cancel it.

### Drag to reprice

Hold the **label** of a limit order, TP or SL and drag it up or down; release to change the price. While dragging, the label shows the new price and the TP / SL's estimated PnL.

- Live orders can only be grabbed by the label, not the line: the line shares the chart with your levels and with panning, and a mis-grab would move a real order.
- The ticket's and the reverse panel's dashed lines (order price, TP, SL, reverse price) can be grabbed anywhere along the line, because they only change numbers in a panel that has not been sent.
- **Safeguards.** Dragging a limit past the current price (it would fill at once) or a TP / SL to where it would trigger at once turns the label red, and releasing **sends nothing**. `Esc` cancels a drag; moves under 3px don't count; and if the price scale changes during the drag (autoscale, a resize), nothing is sent either.
- A limit order is modified in place and keeps its id (it loses its queue position, as Binance rules). A TP / SL is cancelled and placed again, and if the new one is rejected **the old price is put straight back**, so the position is never left without its stop. See [Trading internals](../design/trading.md#repricing).

### Cancel and close

| Action | How |
| --- | --- |
| Cancel an order | ✕ on its label. It reads "Cancelling…" at once, and the line goes as soon as Binance confirms. Pressing it on an order already gone says "cancelled or filled" instead of an error |
| Close the position | Double-press "Close" on the position bar: market, reduce-only, exact size |

On cards narrower than 460px the position bar uses short labels (TP/SL, Lmt rev, Mkt rev) to leave room for PnL.

### Fill alerts

When a limit order resting on the book fills, or a TP / SL triggers, a desktop notification pops up and the card flashes in the taskbar, even with no card on that symbol open. Orders that fill the moment they are sent (market, or a limit already through the price) only show in the card. A split order filling at once is one notification with the count; a partial fill is announced once, then again when the order is done. They follow the toast / flash choices in the alert settings.

## Reversing a position

| Button | What it does |
| --- | --- |
| **Market reverse** | **Double-press**: the first press turns it into a blue "Confirm reverse→Short", the second within 3 seconds reverses at once. If the position changes between the presses, the confirmation is void |
| **Limit reverse** | Opens the reverse panel, headed e.g. "Long 0.01 → Short 0.01". Pick the price by clicking the chart, typing or dragging the "Reverse price" line. A long can only sell **above** the price and a short only buy **below** it (the wrong side would fill at once, so the panel blocks it and suggests market). Once placed, its label reads "Rev. sell / Rev. buy" and can be dragged or cancelled. Optional **TP / SL for the new position**, placed after it fills |

A reverse is normally **one** order in the opposite direction for twice the size (long 0.01 → sell 0.02), so it fills once with no flat gap in between; fees are the same as closing and opening. When the margin can't hold the opening half beside the old position, it goes as a reduce-only close followed by an open instead.

What protects you:

- **The size you confirm is the size sent.** The position is re-read from Binance first; if it differs, nothing is sent and you are asked again.
- **The old position's TP / SL stay until the reverse fills**, protecting it while a limit reverse waits, and are cleaned up after.
- **A pending limit reverse is cancelled if the position changes underneath it**, say the old stop triggers or you close by hand, because filling it then would open a double-size opposite position. You get a warning.
- One reverse limit order per symbol at a time.

The full sequence, including the two-order fallback and how a mismatch is double-checked: [Trading internals](../design/trading.md#reversing).
