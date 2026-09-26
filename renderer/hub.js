/**
 * The data hub: a permanently hidden renderer that owns every upstream
 * market-data connection -- at most one per market.
 *
 * Why this exists: in Float mode every card is its own renderer process, so a
 * card-local WebSocket would mean one Binance connection per card — the spec
 * requires a single shared connection for 4+ cards. Putting the providers in a
 * dedicated renderer keeps the browser-native `fetch`/`WebSocket` usage the
 * spec asks for while still collapsing to one socket per market. Spot and
 * perpetuals are served from different hosts, so they cannot share one; a
 * market nobody is watching holds no socket at all.
 *
 * Cards reach it through main-process IPC relay:
 *   card --invoke--> main --send--> hub --send--> main --send--> card
 */

import { BinanceProvider, MARKETS, counterpartSymbol } from './datafeed/binance.js';

const hub = window.stockcardHub;

/** market -> provider. */
const providers = new Map(Object.keys(MARKETS).map((market) => [market, new BinanceProvider({ market })]));

function feed(market) {
  return providers.get(market) || providers.get('spot');
}

// Open interest is recorded here, once, as each minute closes -- not by the
// cards, several of which may show the same symbol and would write it twice.
for (const [market, provider] of providers) {
  provider.onOIMinute = (symbol, record) => {
    hub.writeBars(market, symbol, 'oi_1m', [record]).catch((err) => {
      console.error('[hub] OI write failed', symbol, err);
    });
  };
}

/** subId -> {ownerId, market}. */
const owners = new Map();

/* ------------------------------------------------------ counterpart */

/** The same instrument on the other market, or null if it does not trade there. */
async function counterpart(symbol, from, to) {
  if (from === to) return String(symbol || '').toUpperCase();
  const [source, target] = await Promise.all([feed(from).loadSymbols(), feed(to).loadSymbols()]);
  return counterpartSymbol(symbol, source, target);
}

/* ---------------------------------------------------- request/response */

hub.onRequest(async ({ reqId, market, method, args = [] }) => {
  try {
    let data;
    if (method === 'counterpart') {
      data = await counterpart(...args);
    } else {
      const provider = feed(market);
      if (typeof provider[method] !== 'function') {
        throw new Error(`unsupported method: ${method}`);
      }
      data = await provider[method](...args);
    }
    hub.respond({ reqId, ok: true, data });
  } catch (err) {
    hub.respond({ reqId, ok: false, error: err && err.message ? err.message : String(err) });
  }
});

/* ------------------------------------------------------- subscriptions */

hub.onSubscribe(({ subId, market, symbol, interval, ownerId }) => {
  if (!subId || !symbol || !interval) return;
  const provider = feed(market);
  market = provider.market;

  // The same card moving to the other market: release the old side first, or
  // its socket keeps streaming a symbol no one is showing.
  const previous = owners.get(subId);
  if (previous && previous.market !== market) feed(previous.market).unsubscribe(subId);
  owners.set(subId, { ownerId, market });

  provider.subscribe(subId, symbol, interval, {
    onBar: (bar) => hub.emit(ownerId, 'datafeed:bar', { subId, market, bar }),
    onTicker: (ticker) => hub.emit(ownerId, 'datafeed:ticker', { subId, market, ticker }),
    onFunding: (funding) => hub.emit(ownerId, 'datafeed:funding', { subId, market, funding }),
    onOI: (oi) => hub.emit(ownerId, 'datafeed:oi', { subId, market, oi }),
  });

  // A card that mounts mid-session needs the current link state right away.
  hub.emit(ownerId, 'datafeed:status', { market, status: provider.getStatus() });
});

hub.onUnsubscribe(({ subId, market }) => {
  const entry = subId && owners.get(subId);
  if (!entry) return;
  // A late unsubscribe for the market a card just left must not tear down the
  // subscription it just made on the new one.
  if (market && market !== entry.market) return;
  feed(entry.market).unsubscribe(subId);
  owners.delete(subId);
});

/** A card window went away: drop everything it was streaming. */
hub.onReleaseOwner(({ ownerId, cardId }) => {
  for (const [subId, entry] of [...owners]) {
    const matchesOwner = ownerId != null && entry.ownerId === ownerId;
    const matchesCard = cardId != null && subId.startsWith(cardId);
    if (matchesOwner || matchesCard) {
      feed(entry.market).unsubscribe(subId);
      owners.delete(subId);
    }
  }
});

/* -------------------------------------------------------------- status */

for (const [market, provider] of providers) {
  provider.onStatusChange((status) => {
    hub.emit(null, 'datafeed:status', { market, status });
  });
}

window.addEventListener('unload', () => {
  for (const provider of providers.values()) provider.destroy();
});

// Signal readiness last, so any queued requests arrive with handlers installed.
hub.ready();
