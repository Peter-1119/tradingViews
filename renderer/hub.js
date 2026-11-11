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
import { AlertMonitor } from './alert-monitor.js';
import { PriceAlertMonitor } from './price-alert-monitor.js';
import { LiquidationFeed } from './datafeed/liquidation-feed.js';
import { CoinbaseFeed } from './datafeed/coinbase-feed.js';

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
  // Footprint minutes are likewise kept by the hub, which collects them once.
  provider.footprintStore = {
    read: (symbol, from, to) => hub.readFootprint(market, symbol, from, to),
    write: (symbol, records) => hub.writeFootprint(market, symbol, records),
  };
  // Big orders go in the bar cache, as series `sweeps` (sweep-collector.js).
  provider.sweepStore = {
    read: (symbol, from, to) => hub.readBars(market, symbol, 'sweeps', from, to),
    write: (symbol, records) => hub.writeBars(market, symbol, 'sweeps', records),
  };
}

/** subId -> {ownerId, market}. */
const owners = new Map();

/* -------------------------------------------------------- liquidations */

/**
 * Forced liquidations on three exchanges (liquidation-feed.js), kept under
 * the perpetual as series `liqs`. Every perpetual a card is open on is
 * recorded (key `rec:`), so the history is there when the layer is switched
 * on; a card's layer (key `layer:`) adds its own symbol, the perpetual
 * counterpart on a spot card.
 */
const liqs = new LiquidationFeed({
  store: {
    read: (symbol, from, to) => hub.readBars('perp', symbol, 'liqs', from, to),
    write: (symbol, records) => hub.writeBars('perp', symbol, 'liqs', records),
  },
});

/**
 * A card's liquidations on or off. On, resolves with {symbol, events, since}
 * from `fromSec`, and the card hears new ones as `datafeed:liq`.
 */
async function setLiquidations(subId, enabled, fromSec) {
  liqs.unwant(`layer:${subId}`);
  const entry = owners.get(subId);
  if (!enabled || !entry) return { symbol: null, events: [], since: null };
  const sub = feed(entry.market).subs.get(subId);
  if (!sub) return { symbol: null, events: [], since: null };
  const symbol = entry.market === 'perp' ? sub.symbol : await counterpart(sub.symbol, entry.market, 'perp').catch(() => null);
  if (!symbol) return { symbol: null, events: [], since: null };
  const { ownerId, market } = entry;
  return liqs.watch(`layer:${subId}`, symbol, (events) => hub.emit(ownerId, 'datafeed:liq', { subId, market, events }), fromSec);
}

function releaseLiquidations(subId) {
  liqs.unwant(`layer:${subId}`);
  liqs.unwant(`rec:${subId}`);
}

/* ------------------------------------------------------------ coinbase */

/**
 * Coinbase's dollar pair for each card (coinbase-feed.js): candles on
 * request for the premium, and trades recorded for every symbol on screen
 * (key `cbrec:`), kept as series `cb1m` under the pair, so the CVD has a
 * history when a card's pane (key `cbpane:`) is switched on.
 */
const coinbase = new CoinbaseFeed({
  store: {
    read: (name, from, to) => hub.readBars('spot', name, 'cb1m', from, to),
    write: (name, records) => hub.writeBars('spot', name, 'cb1m', records),
  },
});

/**
 * A card's Coinbase pane on or off. On, resolves with {product, factor,
 * quote, buckets, since, filling} -- trades in buckets of `step` seconds
 * from `fromSec` -- and the card hears changes as `datafeed:coinbase`.
 * {product: null} when Coinbase has no dollar pair for the symbol.
 */
async function setCoinbase(subId, enabled, step, fromSec) {
  coinbase.unwant(`cbpane:${subId}`);
  const entry = owners.get(subId);
  if (!enabled || !entry) return { product: null };
  const { ownerId, market, symbol } = entry;
  return coinbase.watch(
    `cbpane:${subId}`,
    symbol,
    Number(step) || 60,
    (update) => hub.emit(ownerId, 'datafeed:coinbase', { subId, market, update }),
    fromSec
  );
}

function releaseCoinbase(subId) {
  coinbase.unwant(`cbpane:${subId}`);
  coinbase.unwant(`cbrec:${subId}`);
}

/* ------------------------------------------------------ counterpart */

/** The same instrument on the other market, or null if it does not trade there. */
async function counterpart(symbol, from, to) {
  if (from === to) return String(symbol || '').toUpperCase();
  const [source, target] = await Promise.all([feed(from).loadSymbols(), feed(to).loadSymbols()]);
  return counterpartSymbol(symbol, source, target);
}

/* --------------------------------------------------------------- walls */

/**
 * A card's order-book walls on or off. On, it watches its own market's book
 * and, with `both`, the same instrument's on the other market; resolves with
 * what each knows now ({sources: [{market, symbol, ready, step, walls,
 * ended}]}), and the card hears each second's news as `datafeed:walls`.
 */
async function setWalls(subId, enabled, both, fromMs) {
  for (const provider of providers.values()) provider.unwatchBook(subId);
  const entry = owners.get(subId);
  if (!enabled || !entry) return { sources: [] };
  const sub = feed(entry.market).subs.get(subId);
  if (!sub) return { sources: [] };
  const markets = [entry.market];
  if (both) markets.push(entry.market === 'perp' ? 'spot' : 'perp');
  const sources = [];
  for (const market of markets) {
    const symbol = market === entry.market ? sub.symbol : await counterpart(sub.symbol, entry.market, market).catch(() => null);
    if (!symbol) continue;
    const ownerId = entry.ownerId;
    const cardMarket = entry.market;
    sources.push(
      feed(market).books.watch(
        subId,
        symbol,
        (walls) => hub.emit(ownerId, 'datafeed:walls', { subId, market: cardMarket, walls }),
        Number(fromMs) || 0
      )
    );
  }
  return { sources };
}

function releaseWalls(subId) {
  for (const provider of providers.values()) provider.unwatchBook(subId);
}

/* ---------------------------------------------------- request/response */

hub.onRequest(async ({ reqId, market, method, args = [] }) => {
  try {
    let data;
    if (method === 'counterpart') {
      data = await counterpart(...args);
    } else if (method === 'setWalls') {
      data = await setWalls(...args);
    } else if (method === 'setLiquidations') {
      data = await setLiquidations(...args);
    } else if (method === 'setCoinbase') {
      data = await setCoinbase(...args);
    } else if (method === 'coinbaseCandles') {
      data = await coinbase.getCandles(...args);
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
  owners.set(subId, { ownerId, market, symbol: String(symbol).toUpperCase() });

  provider.subscribe(subId, symbol, interval, {
    onBar: (bar) => hub.emit(ownerId, 'datafeed:bar', { subId, market, bar }),
    onTicker: (ticker) => hub.emit(ownerId, 'datafeed:ticker', { subId, market, ticker }),
    onFunding: (funding) => hub.emit(ownerId, 'datafeed:funding', { subId, market, funding }),
    onOI: (oi) => hub.emit(ownerId, 'datafeed:oi', { subId, market, oi }),
    onFootprint: (footprint) => hub.emit(ownerId, 'datafeed:footprint', { subId, market, footprint }),
    onSweep: (sweep) => hub.emit(ownerId, 'datafeed:sweep', { subId, market, sweep }),
  });
  // A symbol change: the card asks for the new book's walls once its bars are in.
  if (previous && previous.symbol !== symbol) releaseWalls(subId);
  // Liquidations too; and every perpetual on screen is recorded.
  if (previous && (previous.symbol !== String(symbol).toUpperCase() || previous.market !== market)) liqs.unwant(`layer:${subId}`);
  if (market === 'perp') liqs.want(`rec:${subId}`, symbol);
  else liqs.unwant(`rec:${subId}`);
  // Coinbase's trades likewise, for any symbol it has a dollar pair for.
  if (previous && previous.symbol !== String(symbol).toUpperCase()) coinbase.unwant(`cbpane:${subId}`);
  coinbase.want(`cbrec:${subId}`, symbol);

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
  releaseWalls(subId);
  releaseLiquidations(subId);
  releaseCoinbase(subId);
  owners.delete(subId);
});

/** A card window went away: drop everything it was streaming. */
hub.onReleaseOwner(({ ownerId, cardId }) => {
  for (const [subId, entry] of [...owners]) {
    const matchesOwner = ownerId != null && entry.ownerId === ownerId;
    const matchesCard = cardId != null && subId.startsWith(cardId);
    if (matchesOwner || matchesCard) {
      feed(entry.market).unsubscribe(subId);
      releaseWalls(subId);
      releaseLiquidations(subId);
      releaseCoinbase(subId);
      owners.delete(subId);
    }
  }
});

/* ----------------------------------------------------- position alerts */

const monitor = new AlertMonitor({
  feedFor: feed,
  onAlert: (alert) => hub.alert(alert),
  onState: (state) => hub.alertState(state),
});

/** The watchlist and the alert levels, from main, whenever either changes. */
hub.onWatch(({ entries, levels }) => monitor.setWatch(entries, levels));

/* -------------------------------------------------------- price alerts */

const priceAlerts = new PriceAlertMonitor({
  feedFor: feed,
  onHit: (hit) => hub.priceAlertHit(hit),
});

/** The full list, from main, on start and whenever it changes. */
hub.onPriceAlerts((list) => priceAlerts.setAlerts(list));

/* -------------------------------------------------------------- status */

for (const [market, provider] of providers) {
  provider.onStatusChange((status) => {
    hub.emit(null, 'datafeed:status', { market, status });
  });
}

window.addEventListener('unload', () => {
  monitor.destroy();
  priceAlerts.destroy();
  liqs.destroy();
  coinbase.destroy();
  for (const provider of providers.values()) provider.destroy();
});

// Signal readiness last, so any queued requests arrive with handlers installed.
hub.ready();
