**English** | [繁體中文](trading.zh-TW.md)

# Trading internals

How orders get from the ticket to Binance, and the safeguards along the way. How to trade is in the [Trading guide](../guide/trading.md).

## Where trading runs

Everything that touches money runs in the **main process** (`main/trading/`): keys, signing, the REST client, the user data stream and order state. Card pages only send intents ("long 200 USDT at 2551.5 with this TP") through the allowlisted preload API, and they get back state to draw.

| Environment | Exchange | Key |
| --- | --- | --- |
| Paper (local) | `main/trading/paper.js`, answering the same calls as Binance | None |
| Testnet (the default) | Binance demo trading | A demo key |
| Live | Binance USDⓈ-M futures | Your key; switching to it needs an extra confirmation |

## Keys

- The HMAC secret, or a self-generated Ed25519 / RSA private key, is encrypted with Windows **DPAPI** (`main/trading/vault.js`) and stored in `userData/trading-credentials.bin`. DPAPI ties it to your Windows account: copied to another account or machine, the file can't be decrypted.
- A private key file is read by the main process straight from the file dialog; it never passes through a page. Binance holds only the public key you uploaded.
- Pages only ever see the last four characters and the key type.
- Binance's futures docs list HMAC and RSA, but Ed25519 has been tested on a live account (read-only queries; signature verification passed).

## Before an order is sent

- **Rounded to the exchange's rules** in the main process: tick size for prices, step size for quantities, minimum notional, from `exchangeInfo` (`main/trading/rules.js`). A page can't send an unrounded number.
- **Leverage lives on the account.** Binance stores it per symbol (read with `GET /fapi/v1/symbolConfig`, written with `POST /fapi/v1/leverage`), so the app, website and phone agree. It is re-read every time the ticket opens and never changed by sending an order. The brackets from `GET /fapi/v1/leverageBracket` lower the maximum as the position grows, and the ticket checks the estimated position against them before you send.
- **Two presses.** The first press only arms the button, which then reads back exactly what will be sent, asset, quantity and price included (and "(TradFi)" on stock and commodity perpetuals). The second press within 3 seconds sends it.

## Order ids must be exact

Binance order ids can exceed 16 digits, while JavaScript numbers carry 15–16 significant digits, so a plain `JSON.parse` rounds the last ones (`8389765907134201345` becomes `8389765907134202000`). The line still draws, since drawing needs only the price, but cancel and reprice would send an id that doesn't exist and Binance answers `-2011 Unknown order sent`. So every trading response is parsed with `parseExact`: integers of 16 digits or more are kept verbatim as strings.

## Repricing

- **Limit orders** are modified in place with `PUT /fapi/v1/order`: same order id, but the queue position is lost (Binance's rule).
- **TP / SL** are conditional orders and Binance has **no modify call** for them, so they are cancelled and placed again. Two close-position conditional orders on the same side can't coexist, so the old one is cancelled first. If the new one is rejected (say its trigger has already been crossed), **the original price is placed again at once**, so the position is never left without its stop; only if that also fails is there an error asking you to check.
- A drag sends nothing if it ends on the wrong side of the price, is cancelled with `Esc`, moved under 3px, or happened while the price scale changed.

## Reversing

**One order, normally.** A reverse sends one order in the opposite direction for twice the position (long 0.01 → sell 0.02: the first 0.01 closes, the next 0.01 opens a short), rather than "close, then open". It fills once, with no flat gap in between; fees are the same either way.

**Two orders when the margin can't take one.** The old position's margin is only freed once the order fills, so the opening half has to fit beside it, and a position using about half the balance or more can't. Then the reverse goes as a reduce-only close followed by an open of the same size. This is judged from the last account read (opening half ÷ leverage + taker fee, with 2% headroom); if Binance still answers `-2019`, the single order did nothing and it falls back to two.

A **limit** reverse in two orders rests the reduce-only close at your price. Once that has filled in full and the position is flat, the open goes in at the same price (filling at once at that price or better if the market is through it, otherwise resting there), carrying the reverse's TP / SL. If the close is cancelled, part-filled or leaves a position, the open is not sent; if the open fails you are flat, and the notice says so.

Safeguards:

- **The size you confirm is the size sent.** The panel shows "Long 0.01"; the position is re-read from Binance before sending, and if it differs nothing is sent.
- **The old TP / SL and reduce-only orders are cancelled only after the reverse fills.** A long's stop is a sell, meaningless once the position is short, so it is cleaned up; but until the fill it still protects the old position, so a pending limit reverse leaves it alone. It is also cleaned up on a partial fill that has already crossed zero.
- **The position guard.** While a limit reverse is pending, the position may change first for another reason: the old stop triggers, or you close by hand. The double-size order would then open a **double-size opposite position** when it fills. So every position update checks "position = original position + what this order has filled so far", and if that doesn't hold the reverse order is cancelled with a warning. Positions and orders are read together, and a fill landing between the two reads would also look like a mismatch, so on a mismatch they are read again in order (orders → position → orders), and the reverse is cancelled only if the orders didn't change meanwhile and it still doesn't match.
- One reverse limit order per symbol at a time.

## Keeping state current

PnL is computed from the mark price every second. Positions and orders come by two paths at once: Binance's user data stream, updated the moment a fill happens, and REST polling every 3–12 seconds as a backup, so the display can't freeze on stale data if the stream drops. TP / SL waiting for a limit order to fill are placed when the fill is seen, including fills that happened while the app was closed.

Fill notifications come from the same updates: a resting order that fills, or a TP / SL that triggers, notifies even with no card on that symbol open; orders that fill the moment they are sent only show in the card.

## The paper exchange

`main/trading/paper.js` answers the same calls as Binance's API, so the trading code has one path for all three environments; `paper-engine.js` does the bookkeeping. It matches against Binance's live data: a limit fills when a real trade crosses its price, market orders and TP / SL walk the real order book (top 50 levels) for slippage, funding is settled at Binance's published rates, and cross-margin liquidation runs at the mark price. While the app is closed, the gap (up to 30 days) is replayed from 1m bars and published funding, stops before take-profits within a minute. The rules are listed in [Paper trading](../guide/paper-trading.md#how-fills-and-costs-are-computed).

## Development against a mock exchange

`STOCKCARD_TESTNET_REST` and `STOCKCARD_TESTNET_WS` can point the **testnet** environment at a local mock exchange (read in `main/trading/client.js`). The live URLs can't be overridden.
