/**
 * Coinbase, collected in the hub: candles for the premium, and trades for
 * Coinbase's own CVD.
 *
 * Candles come on request and are kept in memory per product and size, so a
 * card that refreshes asks only for the newest few.
 *
 * Trades come over one socket (the `matches` channel) for every product
 * wanted, and are summed into one-minute buckets with the taker's side --
 * the only way to a Coinbase CVD, since its candles do not say who was the
 * taker. Like the liquidations, every symbol a card is open on is recorded,
 * whether or not the pane is shown, so the history is there when it is.
 * Minutes are kept in the bar cache as series `cb1m` under the Coinbase pair
 * (BTC-USD as BTCUSD), and when a product is first wanted the hours since
 * the last saved minute are fetched back from the REST trade history, three
 * at most: past that it would be hundreds of requests for one coin.
 *
 * The REST calls go through two rate limits of their own -- five a second
 * for candles, three for trades -- under Coinbase's public limit of ten.
 * They run side by side within it: one after another, a long history took
 * twenty seconds, most of it waiting on the network.
 */

import { CB_REST, CB_WS, CANDLES_PER_PAGE, parseMatch, parseTrade, parseCandles, addTrade, rollUp, productFor, tradingProducts } from '../coinbase.js';

const BACKFILL_MS = 3 * 3600_000;
const TRADE_PAGE = 1000;
/** A page of trades is about a minute of BTC at its busiest; three hours is well under this. */
const MAX_TRADE_PAGES = 250;
const MAX_CANDLE_PAGES = 20;
const CANDLE_GAP_MS = 200;
const TRADE_GAP_MS = 300;
const TIMEOUT_MS = 15_000;
const PRODUCTS_TTL_MS = 6 * 3600_000;
const EMIT_MS = 1000;
const FLUSH_MS = 30_000;
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
/** How long the backfill waits for the socket's first trade, its upper bound. */
const LIVE_WAIT_MS = 10_000;
/** What is read back from the cache: as much as a card asks for, at most. */
const KEEP_SEC = 45 * 86400;

const storeName = (product) => product.replace('-', '');

/** Requests started at most one per `gap`, without waiting for the one before to finish. */
class RateLimit {
  constructor(gap) {
    this.gap = gap;
    this.next = 0;
  }

  run(fn) {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.gap;
    return new Promise((r) => setTimeout(r, at - now)).then(fn);
  }
}

export class CoinbaseFeed {
  /**
   * @param {{
   *   store?: {read: (name, from, to) => Promise<object[]>, write: (name, records) => Promise<any>},
   *   logger?: Console,
   * }} opts
   */
  constructor({ store = null, logger = console } = {}) {
    this.store = store;
    this.logger = logger;
    this.products = null;
    this.productsAt = 0;
    this.candleQueue = new RateLimit(CANDLE_GAP_MS);
    this.tradeQueue = new RateLimit(TRADE_GAP_MS);
    /** `${product}:${granularity}` -> {rows: Map<time, {time, close}>, lo, hi} */
    this.candles = new Map();
    /** key -> product: recorded, and why (a card open on it, or its pane). */
    this.wants = new Map();
    /** product -> {minutes, dirty, unsaved, listeners, since, filling, loaded, firstLiveId, liveWaiters} */
    this.states = new Map();
    this.socket = null;
    this.subscribed = new Set();
    this.attempts = 0;
    this.retryTimer = null;
    this.emitTimer = setInterval(() => this.emit(), EMIT_MS);
    this.flushTimer = setInterval(() => this.flush(), FLUSH_MS);
    this.status = 'idle';
  }

  /* ------------------------------------------------------------ REST */

  async get(queue, path) {
    return queue.run(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(`${CB_REST}${path}`, { cache: 'no-store', signal: controller.signal });
        if (!res.ok) throw new Error(`Coinbase ${res.status} for ${path.split('?')[0]}`);
        return await res.json();
      } finally {
        clearTimeout(timer);
      }
    });
  }

  async productSet() {
    if (!this.products || Date.now() - this.productsAt > PRODUCTS_TTL_MS) {
      const list = await this.get(this.candleQueue, '/products');
      this.products = tradingProducts(list);
      this.productsAt = Date.now();
    }
    return this.products;
  }

  /** The Coinbase pair for a Binance symbol: {product, factor, quote}, or null. */
  async resolve(symbol) {
    return productFor(symbol, await this.productSet());
  }

  /**
   * Candles of `granularity` seconds from `fromSec` to `toSec`, as {time,
   * close}, oldest first. What is held is not asked for again, except the
   * newest two, which may still have been forming.
   */
  async getCandles(product, granularity, fromSec, toSec) {
    const g = Number(granularity);
    const key = `${product}:${g}`;
    let held = this.candles.get(key);
    if (!held) {
      held = { rows: new Map(), lo: Infinity, hi: -Infinity };
      this.candles.set(key, held);
    }
    const from = Math.floor(fromSec / g) * g;
    const to = Math.floor(toSec / g) * g;
    const asks = [];
    if (!held.rows.size) asks.push([from, to]);
    else {
      if (from < held.lo) asks.push([from, held.lo - g]);
      if (to > held.hi - 2 * g) asks.push([Math.max(from, held.hi - 2 * g), to]);
    }
    // Pages newest first, so a long ask cut short still has the end that matters.
    const pages = [];
    for (const [a, b] of asks) {
      for (let end = b; end >= a && pages.length < MAX_CANDLE_PAGES; end -= CANDLES_PER_PAGE * g) {
        pages.push([Math.max(a, end - (CANDLES_PER_PAGE - 1) * g), end]);
      }
    }
    const iso = (s) => new Date(s * 1000).toISOString();
    const results = await Promise.allSettled(
      pages.map(async ([start, end]) => {
        const rows = parseCandles(
          await this.get(this.candleQueue, `/products/${product}/candles?granularity=${g}&start=${iso(start)}&end=${iso(end)}`)
        );
        for (const r of rows) held.rows.set(r.time, r);
      })
    );
    const failed = results.find((r) => r.status === 'rejected');
    // Held as covered only when every page came: a hole would never be asked for again.
    if (failed) throw failed.reason;
    for (const [start, end] of pages) {
      held.lo = Math.min(held.lo, start);
      held.hi = Math.max(held.hi, end);
    }
    return [...held.rows.values()].filter((r) => r.time >= from && r.time <= to).sort((a, b) => a.time - b.time);
  }

  /* --------------------------------------------------------- wanting */

  /** Record the pair for `symbol` (a Binance symbol) under `key`. */
  async want(key, symbol) {
    let r = null;
    try {
      r = await this.resolve(symbol);
    } catch (err) {
      this.logger.warn('[coinbase] products failed', err && err.message);
      return null;
    }
    if (!r) {
      this.unwant(key);
      return null;
    }
    if (this.wants.get(key) !== r.product) {
      this.unwant(key);
      this.wants.set(key, r.product);
      this.state(r.product);
      this.sync();
    }
    return r;
  }

  unwant(key) {
    const product = this.wants.get(key);
    if (!product) return;
    this.wants.delete(key);
    const st = this.states.get(product);
    if (st) st.listeners.delete(key);
    this.sync();
  }

  /**
   * A card's pane on: trades for `symbol` in buckets of `step` seconds from
   * `fromSec`. Resolves with {product, factor, quote, buckets, since,
   * filling}; `listener` hears changed buckets each second as {buckets,
   * since, filling, full} (full: replace everything, after a backfill).
   */
  async watch(key, symbol, step, listener, fromSec) {
    const r = await this.want(key, symbol);
    if (!r) return { product: null };
    const st = this.state(r.product);
    st.listeners.set(key, { listener, step, fromSec });
    await st.loaded;
    return { ...r, buckets: this.bucketsFor(st, step, fromSec), since: st.since, filling: st.filling };
  }

  state(product) {
    let st = this.states.get(product);
    if (st) return st;
    st = {
      product,
      minutes: new Map(),
      dirty: new Set(),
      unsaved: new Set(),
      listeners: new Map(),
      since: null,
      filling: true,
      firstLiveId: null,
      savedLast: null,
      liveWaiters: [],
      loaded: null,
    };
    this.states.set(product, st);
    st.loaded = this.load(st);
    st.loaded.then(() => this.backfill(st));
    return st;
  }

  /** What is saved, from KEEP_SEC back. */
  async load(st) {
    if (!this.store) return;
    try {
      const now = Math.floor(Date.now() / 1000);
      const rows = await this.store.read(storeName(st.product), now - KEEP_SEC, now);
      for (const r of rows || []) if (!st.minutes.has(r.time)) st.minutes.set(r.time, { ...r, firstT: r.time * 1000, lastT: r.time * 1000 + 59_999 });
      if (rows && rows.length) {
        st.since = rows[0].time * 1000;
        st.savedLast = rows[rows.length - 1].time;
      }
    } catch (err) {
      this.logger.warn('[coinbase] cache read failed', st.product, err && err.message);
    }
  }

  /**
   * The hours since the last saved minute (three at most), from the REST
   * history, walking back from the newest trade. Trades the socket has
   * already counted -- its first one and every one after -- are skipped, so
   * nothing is counted twice.
   */
  async backfill(st) {
    try {
      const nowMs = Date.now();
      // From the last saved minute: the socket's own minutes are already coming in.
      const last = st.savedLast != null ? st.savedLast : -Infinity;
      const fromMs = Math.max((last + 60) * 1000, Math.floor((nowMs - BACKFILL_MS) / 60_000) * 60_000);
      if (fromMs < nowMs - 60_000) {
        await this.firstLive(st);
        let cursor = null;
        let done = false;
        for (let page = 0; page < MAX_TRADE_PAGES && !done && this.states.get(st.product) === st; page++) {
          const rows = await this.get(
            this.tradeQueue,
            `/products/${st.product}/trades?limit=${TRADE_PAGE}${cursor ? `&after=${cursor}` : ''}`
          );
          if (!Array.isArray(rows) || !rows.length) break;
          for (const row of rows) {
            const tr = parseTrade(row, st.product);
            if (!tr) continue;
            if (tr.t < fromMs) {
              done = true;
              continue;
            }
            if (st.firstLiveId != null && tr.id >= st.firstLiveId) continue;
            const m = addTrade(st.minutes, tr);
            st.unsaved.add(m.time);
          }
          cursor = Math.min(...rows.map((r) => Number(r.trade_id)));
          if (rows.length < TRADE_PAGE) break;
        }
        if (st.since == null || fromMs < st.since) st.since = fromMs;
      } else if (st.since == null) st.since = nowMs;
    } catch (err) {
      this.logger.warn('[coinbase] backfill failed', st.product, err && err.message);
      if (st.since == null) st.since = Date.now();
    }
    st.filling = false;
    this.flush();
    for (const { listener, step, fromSec } of st.listeners.values()) {
      listener({ full: true, buckets: this.bucketsFor(st, step, fromSec), since: st.since, filling: false });
    }
  }

  /** Resolves once the socket has a trade for the product (or after a while). */
  firstLive(st) {
    if (st.firstLiveId != null) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, LIVE_WAIT_MS);
      st.liveWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  bucketsFor(st, step, fromSec) {
    const from = Math.floor((Number(fromSec) || 0) / step) * step;
    const minutes = [...st.minutes.values()].filter((m) => m.time >= from).sort((a, b) => a.time - b.time);
    return rollUp(minutes, step);
  }

  /* ---------------------------------------------------------- socket */

  wantedProducts() {
    return new Set(this.wants.values());
  }

  sync() {
    const wanted = this.wantedProducts();
    for (const [product, st] of [...this.states]) {
      if (!wanted.has(product)) {
        this.flushState(st);
        this.states.delete(product);
      }
    }
    if (!wanted.size) {
      this.close();
      return;
    }
    if (!this.socket) {
      this.open();
      return;
    }
    if (this.socket.readyState !== WebSocket.OPEN) return;
    const add = [...wanted].filter((p) => !this.subscribed.has(p));
    const drop = [...this.subscribed].filter((p) => !wanted.has(p));
    if (add.length) this.send({ type: 'subscribe', product_ids: add, channels: ['matches'] });
    if (drop.length) this.send({ type: 'unsubscribe', product_ids: drop, channels: ['matches'] });
    for (const p of add) this.subscribed.add(p);
    for (const p of drop) this.subscribed.delete(p);
  }

  send(msg) {
    try {
      this.socket.send(JSON.stringify(msg));
    } catch {
      /* closing; the reconnect subscribes again */
    }
  }

  open() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    let ws;
    try {
      ws = new WebSocket(CB_WS);
    } catch (err) {
      this.retry();
      return;
    }
    this.socket = ws;
    this.subscribed.clear();
    ws.onopen = () => {
      this.attempts = 0;
      this.status = 'live';
      this.sync();
    };
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      const tr = parseMatch(msg);
      if (tr) this.heard(tr);
    };
    ws.onclose = () => {
      if (this.socket !== ws) return;
      this.socket = null;
      this.subscribed.clear();
      this.status = 'down';
      if (this.wantedProducts().size) this.retry();
    };
    ws.onerror = () => {};
  }

  retry() {
    if (this.retryTimer) return;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** this.attempts++);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.wantedProducts().size) this.open();
    }, delay);
  }

  close() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ws = this.socket;
    this.socket = null;
    this.subscribed.clear();
    if (ws) {
      try {
        ws.close();
      } catch {
        /* already gone */
      }
    }
  }

  /* ------------------------------------------------------- recording */

  heard(tr) {
    const st = this.states.get(tr.product);
    if (!st) return;
    if (st.firstLiveId == null) {
      st.firstLiveId = tr.id;
      if (st.since == null) st.since = tr.t;
      for (const w of st.liveWaiters.splice(0)) w();
    }
    const m = addTrade(st.minutes, tr);
    st.dirty.add(m.time);
    st.unsaved.add(m.time);
  }

  /** Each second, the changed buckets to each card showing the pane. */
  emit() {
    for (const st of this.states.values()) {
      if (!st.dirty.size) continue;
      const changed = [...st.dirty];
      st.dirty.clear();
      for (const { listener, step } of st.listeners.values()) {
        const times = new Set(changed.map((t) => Math.floor(t / step) * step));
        const buckets = [];
        for (const start of times) {
          const minutes = [];
          for (let t = start; t < start + step; t += 60) if (st.minutes.has(t)) minutes.push(st.minutes.get(t));
          buckets.push(...rollUp(minutes, step));
        }
        listener({ buckets, since: st.since, filling: st.filling });
      }
    }
  }

  /** Closed minutes to disk; not while a backfill is still filling them in. */
  flush() {
    for (const st of this.states.values()) this.flushState(st);
  }

  flushState(st) {
    if (!this.store || st.filling || !st.unsaved.size) return;
    const open = Math.floor(Date.now() / 60_000) * 60;
    const done = [...st.unsaved].filter((t) => t < open);
    if (!done.length) return;
    for (const t of done) st.unsaved.delete(t);
    const records = done
      .sort((a, b) => a - b)
      .map((t) => st.minutes.get(t))
      .filter(Boolean)
      .map((m) => ({ time: m.time, open: m.open, high: m.high, low: m.low, close: m.close, volume: m.volume, buyVolume: m.buyVolume, quoteVolume: m.quoteVolume, closed: true }));
    this.store.write(storeName(st.product), records).catch((err) => {
      this.logger.warn('[coinbase] cache write failed', st.product, err && err.message);
    });
  }

  destroy() {
    clearInterval(this.emitTimer);
    clearInterval(this.flushTimer);
    this.flush();
    this.wants.clear();
    this.states.clear();
    this.close();
  }
}
