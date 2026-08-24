/**
 * Binance public market data (spec 6). No API key, no account, spot only.
 *
 * One combined WebSocket serves every card in the app; `subscribe()` calls are
 * reference-counted onto stream names and the socket is grown/shrunk with
 * SUBSCRIBE / UNSUBSCRIBE frames rather than reconnected.
 *
 * Resilience (spec 6, "連線韌性"):
 *   - exponential backoff 1s -> 30s on any close
 *   - full re-subscribe after every reconnect
 *   - REST backfill of bars missed while offline, replayed before live bars
 *     resume, so the chart has no hole
 *   - proactive reconnect before Binance's own ~24h server-side cut
 */

import { DataProvider, STATUS, intervalToMs } from './provider.js';

const REST_BASE = 'https://api.binance.com/api/v3';
const WS_BASE = 'wss://stream.binance.com:9443/stream';

const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const PROACTIVE_RECYCLE_MS = 23 * 60 * 60 * 1000; // stay ahead of the 24h cut
const SYMBOLS_CACHE_KEY = 'stockcard.symbols.v1';
const SYMBOLS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Binance kline array -> our Bar. */
function toBar(k) {
  return {
    time: Math.floor(k[0] / 1000),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    closed: true,
  };
}

/** Binance kline websocket payload -> our Bar. */
function toBarFromStream(k) {
  return {
    time: Math.floor(k.t / 1000),
    open: Number(k.o),
    high: Number(k.h),
    low: Number(k.l),
    close: Number(k.c),
    volume: Number(k.v),
    closed: k.x === true,
  };
}

function klineStream(symbol, interval) {
  return `${symbol.toLowerCase()}@kline_${interval}`;
}

function tickerStream(symbol) {
  return `${symbol.toLowerCase()}@miniTicker`;
}

export class BinanceProvider extends DataProvider {
  constructor({ logger = console } = {}) {
    super();
    this.logger = logger;

    /** subId -> {symbol, interval, handlers, lastBarTime} */
    this.subs = new Map();
    /** stream name -> refcount */
    this.streamRefs = new Map();

    this.ws = null;
    this.status = STATUS.IDLE;
    this.statusListeners = new Set();

    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.recycleTimer = null;
    this.requestId = 1;
    this.intentionalClose = false;

    // Last ticker per symbol, so a newly-mounted card gets a value immediately.
    this.tickerCache = new Map();

    this.handleOnline = () => {
      if (this.status !== STATUS.LIVE && this.streamRefs.size > 0) {
        this.log('network back online, reconnecting immediately');
        this.reconnectAttempt = 0;
        this.scheduleReconnect(0);
      }
    };
    this.handleOffline = () => {
      if (this.streamRefs.size > 0) this.setStatus(STATUS.OFFLINE);
    };
    window.addEventListener('online', this.handleOnline);
    window.addEventListener('offline', this.handleOffline);
  }

  get name() {
    return 'Binance Spot';
  }

  log(...args) {
    this.logger.log('[binance]', ...args);
  }

  /* --------------------------------------------------------------- status */

  setStatus(next) {
    if (this.status === next) return;
    this.status = next;
    for (const cb of this.statusListeners) {
      try {
        cb(next);
      } catch (err) {
        this.logger.error('[binance] status listener threw', err);
      }
    }
  }

  getStatus() {
    return this.status;
  }

  onStatusChange(cb) {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  /* ----------------------------------------------------------------- REST */

  async fetchJson(path, { timeoutMs = 15000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${REST_BASE}${path}`, { signal: controller.signal });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Binance ${res.status} ${path} ${body.slice(0, 160)}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async getHistory(symbol, interval, limit = 500) {
    const capped = Math.min(1000, Math.max(10, Number(limit) || 500));
    const raw = await this.fetchJson(
      `/klines?symbol=${encodeURIComponent(symbol.toUpperCase())}&interval=${encodeURIComponent(
        interval
      )}&limit=${capped}`
    );
    const bars = raw.map(toBar);
    // Binance includes the in-progress candle as the last element.
    if (bars.length) bars[bars.length - 1].closed = false;
    return bars;
  }

  async getTicker(symbol) {
    const upper = symbol.toUpperCase();
    const raw = await this.fetchJson(`/ticker/24hr?symbol=${encodeURIComponent(upper)}`);
    const ticker = {
      symbol: upper,
      last: Number(raw.lastPrice),
      changePercent: Number(raw.priceChangePercent),
      high: Number(raw.highPrice),
      low: Number(raw.lowPrice),
      volume: Number(raw.volume),
    };
    this.tickerCache.set(upper, ticker);
    return ticker;
  }

  /* --------------------------------------------------------- symbol list */

  async loadSymbols() {
    try {
      const cached = JSON.parse(localStorage.getItem(SYMBOLS_CACHE_KEY) || 'null');
      if (cached && Date.now() - cached.at < SYMBOLS_CACHE_TTL_MS && Array.isArray(cached.list)) {
        return cached.list;
      }
    } catch {
      /* corrupt cache is not worth reporting; fall through and refetch */
    }

    const info = await this.fetchJson('/exchangeInfo?permissions=SPOT', { timeoutMs: 30000 });
    const list = (info.symbols || [])
      .filter((s) => s.status === 'TRADING')
      .map((s) => ({
        symbol: s.symbol,
        base: s.baseAsset,
        quote: s.quoteAsset,
        description: `${s.baseAsset} / ${s.quoteAsset}`,
      }));

    try {
      localStorage.setItem(SYMBOLS_CACHE_KEY, JSON.stringify({ at: Date.now(), list }));
    } catch {
      /* quota exceeded: run uncached rather than fail */
    }
    return list;
  }

  async searchSymbols(query) {
    const list = await this.loadSymbols();
    const q = String(query || '').trim().toUpperCase();

    // Popular quote assets first so "BTC" surfaces BTCUSDT ahead of BTCNGN.
    const QUOTE_RANK = { USDT: 0, FDUSD: 1, USDC: 2, BTC: 3, ETH: 4, BNB: 5 };
    const rank = (s) => (s.quote in QUOTE_RANK ? QUOTE_RANK[s.quote] : 9);

    const matches = q
      ? list.filter((s) => s.symbol.includes(q) || s.base.includes(q))
      : list.filter((s) => rank(s) === 0);

    return matches
      .sort((a, b) => {
        const exact = (b.symbol === q) - (a.symbol === q);
        if (exact) return exact;
        const starts = b.symbol.startsWith(q) - a.symbol.startsWith(q);
        if (starts) return starts;
        const byQuote = rank(a) - rank(b);
        if (byQuote) return byQuote;
        return a.symbol.localeCompare(b.symbol);
      })
      .slice(0, 40);
  }

  /* ------------------------------------------------------- subscriptions */

  subscribe(subId, symbol, interval, handlers = {}) {
    const upper = symbol.toUpperCase();
    const previous = this.subs.get(subId);

    this.subs.set(subId, {
      symbol: upper,
      interval,
      handlers,
      lastBarTime: 0,
    });

    // Acquire the new streams *before* releasing the old ones. Releasing first
    // would let the refcount hit zero on a single-card app, closing the shared
    // socket and forcing a reconnect just to change symbol.
    const added = [];
    for (const stream of [klineStream(upper, interval), tickerStream(upper)]) {
      const next = (this.streamRefs.get(stream) || 0) + 1;
      this.streamRefs.set(stream, next);
      if (next === 1) added.push(stream);
    }

    const removed = [];
    if (previous) {
      for (const stream of [
        klineStream(previous.symbol, previous.interval),
        tickerStream(previous.symbol),
      ]) {
        const next = (this.streamRefs.get(stream) || 1) - 1;
        if (next <= 0) {
          this.streamRefs.delete(stream);
          removed.push(stream);
        } else {
          this.streamRefs.set(stream, next);
        }
      }
    }

    // Hand over whatever we already know so the card is not blank while it loads.
    const cachedTicker = this.tickerCache.get(upper);
    if (cachedTicker && handlers.onTicker) handlers.onTicker(cachedTicker);

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.connect();
      return;
    }
    if (added.length) this.sendControl('SUBSCRIBE', added);
    if (removed.length) this.sendControl('UNSUBSCRIBE', removed);
  }

  unsubscribe(subId) {
    const sub = this.subs.get(subId);
    if (!sub) return;
    this.subs.delete(subId);

    const removed = [];
    for (const stream of [klineStream(sub.symbol, sub.interval), tickerStream(sub.symbol)]) {
      const next = (this.streamRefs.get(stream) || 1) - 1;
      if (next <= 0) {
        this.streamRefs.delete(stream);
        removed.push(stream);
      } else {
        this.streamRefs.set(stream, next);
      }
    }

    if (removed.length && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendControl('UNSUBSCRIBE', removed);
    }
    if (this.streamRefs.size === 0) this.disconnect(STATUS.IDLE);
  }

  /** Drop every subscription belonging to one owner (a closed card window). */
  unsubscribeOwner(predicate) {
    for (const [subId, sub] of [...this.subs]) {
      if (predicate(subId, sub)) this.unsubscribe(subId);
    }
  }

  /* ------------------------------------------------------------ websocket */

  connect() {
    if (this.streamRefs.size === 0) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    clearTimeout(this.reconnectTimer);
    this.intentionalClose = false;

    const streams = [...this.streamRefs.keys()].join('/');
    const url = `${WS_BASE}?streams=${streams}`;
    this.setStatus(this.reconnectAttempt > 0 ? STATUS.RECONNECTING : this.status);

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.logger.error('[binance] websocket construction failed', err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      const wasReconnect = this.reconnectAttempt > 0;
      this.reconnectAttempt = 0;
      this.setStatus(STATUS.LIVE);
      this.log('connected', this.streamRefs.size, 'streams');

      // Binance drops long-lived connections around the 24h mark; get ahead of it.
      clearTimeout(this.recycleTimer);
      this.recycleTimer = setTimeout(() => {
        this.log('proactive reconnect before server-side timeout');
        this.reconnect();
      }, PROACTIVE_RECYCLE_MS);

      if (wasReconnect) this.backfillAll();
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!msg || !msg.data) return; // control acks have no `data`
      this.dispatch(msg.data);
    };

    ws.onerror = () => {
      // `onclose` always follows; reconnect is handled there.
      if (this.ws === ws) this.log('websocket error');
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearTimeout(this.recycleTimer);
      if (this.intentionalClose || this.streamRefs.size === 0) return;
      this.setStatus(STATUS.RECONNECTING);
      this.scheduleReconnect();
    };
  }

  disconnect(nextStatus = STATUS.IDLE) {
    this.intentionalClose = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.recycleTimer);
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* already closing */
      }
      this.ws = null;
    }
    this.setStatus(nextStatus);
  }

  reconnect() {
    this.intentionalClose = true;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.reconnectAttempt = Math.max(this.reconnectAttempt, 1);
    this.scheduleReconnect(0);
  }

  scheduleReconnect(overrideDelay) {
    clearTimeout(this.reconnectTimer);
    if (this.streamRefs.size === 0) return;

    const delay =
      overrideDelay !== undefined
        ? overrideDelay
        : Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.setStatus(navigator.onLine === false ? STATUS.OFFLINE : STATUS.RECONNECTING);
    this.log(`reconnect in ${delay}ms (attempt ${this.reconnectAttempt})`);

    this.reconnectTimer = setTimeout(() => {
      this.intentionalClose = false;
      this.connect();
    }, delay);
  }

  sendControl(method, params) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ method, params, id: this.requestId++ }));
  }

  /* ------------------------------------------------------------ dispatch */

  dispatch(data) {
    if (data.e === 'kline') {
      const bar = toBarFromStream(data.k);
      const symbol = data.s;
      const interval = data.k.i;
      for (const sub of this.subs.values()) {
        if (sub.symbol !== symbol || sub.interval !== interval) continue;
        sub.lastBarTime = Math.max(sub.lastBarTime, bar.time);
        if (sub.handlers.onBar) sub.handlers.onBar(bar);
      }
      return;
    }

    if (data.e === '24hrMiniTicker') {
      const open = Number(data.o);
      const last = Number(data.c);
      const ticker = {
        symbol: data.s,
        last,
        changePercent: open ? ((last - open) / open) * 100 : 0,
        high: Number(data.h),
        low: Number(data.l),
        volume: Number(data.v),
      };
      this.tickerCache.set(data.s, ticker);
      for (const sub of this.subs.values()) {
        if (sub.symbol !== data.s) continue;
        if (sub.handlers.onTicker) sub.handlers.onTicker(ticker);
      }
    }
  }

  /* ------------------------------------------------------------ backfill */

  /**
   * After a reconnect, pull the bars we missed and replay them so the chart is
   * continuous instead of jumping from the pre-outage bar to the live one.
   */
  async backfillAll() {
    const jobs = [...this.subs.entries()].map(async ([subId, sub]) => {
      if (!sub.lastBarTime) return; // never had data; the card's own load covers it
      const gapMs = Date.now() - sub.lastBarTime * 1000;
      const missing = Math.ceil(gapMs / intervalToMs(sub.interval)) + 2;
      const limit = Math.min(1000, Math.max(10, missing));

      try {
        const bars = await this.getHistory(sub.symbol, sub.interval, limit);
        // Still subscribed to the same thing? A fast symbol switch could have
        // replaced this subscription while the request was in flight.
        const current = this.subs.get(subId);
        if (!current || current !== sub) return;

        const fresh = bars.filter((b) => b.time >= sub.lastBarTime);
        for (const bar of fresh) {
          sub.lastBarTime = Math.max(sub.lastBarTime, bar.time);
          if (sub.handlers.onBar) sub.handlers.onBar(bar);
        }
        this.log(`backfilled ${fresh.length} bars for ${sub.symbol} ${sub.interval}`);
      } catch (err) {
        this.logger.error('[binance] backfill failed', sub.symbol, err);
      }
    });

    await Promise.allSettled(jobs);
  }

  destroy() {
    window.removeEventListener('online', this.handleOnline);
    window.removeEventListener('offline', this.handleOffline);
    this.subs.clear();
    this.streamRefs.clear();
    this.disconnect(STATUS.IDLE);
    this.statusListeners.clear();
  }
}
