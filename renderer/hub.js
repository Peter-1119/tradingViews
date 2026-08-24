/**
 * The data hub: a permanently hidden renderer that owns the one and only
 * upstream market-data connection.
 *
 * Why this exists: in Float mode every card is its own renderer process, so a
 * card-local WebSocket would mean one Binance connection per card — the spec
 * requires a single shared connection for 4+ cards. Putting the provider in a
 * dedicated renderer keeps the browser-native `fetch`/`WebSocket` usage the
 * spec asks for while still collapsing to one socket.
 *
 * Cards reach it through main-process IPC relay:
 *   card --invoke--> main --send--> hub --send--> main --send--> card
 */

import { BinanceProvider } from './datafeed/binance.js';

const hub = window.stockcardHub;
const provider = new BinanceProvider();

/** subId -> ownerId (the webContents id of the card renderer). */
const owners = new Map();

/* ---------------------------------------------------- request/response */

hub.onRequest(async ({ reqId, method, args = [] }) => {
  try {
    if (typeof provider[method] !== 'function') {
      throw new Error(`unsupported method: ${method}`);
    }
    const data = await provider[method](...args);
    hub.respond({ reqId, ok: true, data });
  } catch (err) {
    hub.respond({ reqId, ok: false, error: err && err.message ? err.message : String(err) });
  }
});

/* ------------------------------------------------------- subscriptions */

hub.onSubscribe(({ subId, symbol, interval, ownerId }) => {
  if (!subId || !symbol || !interval) return;
  owners.set(subId, ownerId);

  provider.subscribe(subId, symbol, interval, {
    onBar: (bar) => hub.emit(ownerId, 'datafeed:bar', { subId, bar }),
    onTicker: (ticker) => hub.emit(ownerId, 'datafeed:ticker', { subId, ticker }),
  });

  // A card that mounts mid-session needs the current link state right away.
  hub.emit(ownerId, 'datafeed:status', { status: provider.getStatus() });
});

hub.onUnsubscribe(({ subId }) => {
  if (!subId) return;
  provider.unsubscribe(subId);
  owners.delete(subId);
});

/** A card window went away: drop everything it was streaming. */
hub.onReleaseOwner(({ ownerId, cardId }) => {
  for (const [subId, owner] of [...owners]) {
    const matchesOwner = ownerId != null && owner === ownerId;
    const matchesCard = cardId != null && subId.startsWith(cardId);
    if (matchesOwner || matchesCard) {
      provider.unsubscribe(subId);
      owners.delete(subId);
    }
  }
});

/* -------------------------------------------------------------- status */

provider.onStatusChange((status) => {
  hub.emit(null, 'datafeed:status', { status });
});

window.addEventListener('unload', () => provider.destroy());

// Signal readiness last, so any queued requests arrive with handlers installed.
hub.ready();
