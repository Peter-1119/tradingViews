/**
 * Binance public market data (spec 6). No API key, no account.
 *
 * One instance per market -- spot, or USD-M perpetuals. The two live on
 * different hosts, so they cannot share a socket; within a market, one
 * combined WebSocket serves every card in the app. `subscribe()` calls are
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

/**
 * Everything that differs between the two markets. The paths under each REST
 * base are the same (/klines, /ticker/24hr, /exchangeInfo), and so are the
 * stream names and payloads, which is why one class serves both.
 *
 * The futures socket is on `/market/stream`: the bare `/stream` route on
 * fstream still accepts the connection but no longer delivers kline, trade or
 * ticker frames, so a card on it would sit "live" and never move.
 */
export const MARKETS = Object.freeze({
  spot: Object.freeze({
    name: 'Binance Spot',
    rest: 'https://api.binance.com/api/v3',
    ws: 'wss://stream.binance.com:9443/stream',
    exchangeInfo: '/exchangeInfo?permissions=SPOT',
    symbolsCacheKey: 'stockcard.symbols.v1',
    funding: false,
  }),
  perp: Object.freeze({
    name: 'Binance USD-M',
    rest: 'https://fapi.binance.com/fapi/v1',
    ws: 'wss://fstream.binance.com/market/stream',
    exchangeInfo: '/exchangeInfo',
    symbolsCacheKey: 'stockcard.symbols.perp.v1',
    funding: true,
  }),
});

const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const PROACTIVE_RECYCLE_MS = 23 * 60 * 60 * 1000; // stay ahead of the 24h cut
const SYMBOLS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Coalescing window for trade-driven bar updates.
 *
 * Binance pushes `@kline_*` once a second, which is the real ceiling on how
 * fresh the candle looks. `@aggTrade` has no such throttle -- it fires per
 * trade, which on a liquid pair is dozens of messages a second, all of which
 * would cross an IPC hop and repaint a widget the size of a postage stamp.
 * So trades fold into the forming bar locally and only the newest state is
 * forwarded, at most once per window. 100ms is smooth to the eye and caps the
 * cost at 10 updates/sec per card no matter how hot the tape runs.
 */
const LIVE_TICK_MS = 100;

/**
 * Leading multipliers Binance puts on low-priced perpetuals: spot PEPEUSDT
 * trades as 1000PEPEUSDT, spot MOG as 1000000MOGUSDT, BABYDOGE as 1MBABYDOGE.
 */
const SCALED_PREFIXES = ['1000', '1000000', '1M'];
const SCALED_BASE = /^(1000000|1000|1M)(?=[A-Z])/;

/**
 * `symbol` from one market's list, by its name in another's; null if absent.
 *
 * An exact name match wins -- that also keeps 1000SATS, which is its real spot
 * name, from being stripped. Otherwise the base asset is reduced to its
 * unscaled form and every multiplier is tried against the target list. The
 * quote asset must match: BTCUSDC is not a stand-in for BTCUSDT.
 *
 * @param {string} symbol
 * @param {SymbolInfo[]} source  the list `symbol` comes from
 * @param {SymbolInfo[]} target  the list to find it in
 */
export function counterpartSymbol(symbol, source, target) {
  const upper = String(symbol || '').toUpperCase();
  const names = new Set(target.map((s) => s.symbol));
  if (names.has(upper)) return upper;

  const info = source.find((s) => s.symbol === upper);
  if (!info) return null;
  const base = info.base.replace(SCALED_BASE, '');
  for (const prefix of ['', ...SCALED_PREFIXES]) {
    const candidate = `${prefix}${base}${info.quote}`;
    if (names.has(candidate)) return candidate;
  }
  return null;
}

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

function aggTradeStream(symbol) {
  return `${symbol.toLowerCase()}@aggTrade`;
}

/** Mark price and funding, every 3s. Perpetuals only. */
function markPriceStream(symbol) {
  return `${symbol.toLowerCase()}@markPrice`;
}

/** Binance premiumIndex / markPriceUpdate -> our Funding. */
function toFunding(symbol, markPrice, rate, nextTime) {
  return {
    symbol,
    markPrice: Number(markPrice),
    fundingRate: Number(rate),
    nextFundingTime: Number(nextTime),
  };
}

export class BinanceProvider extends DataProvider {
  constructor({ logger = console, market = 'spot' } = {}) {
    super();
    this.logger = logger;
    this.market = market in MARKETS ? market : 'spot';
    this.config = MARKETS[this.market];

    /** subId -> {symbol, interval, handlers, lastBarTime, liveBar, tickTimer, lastEmitAt} */
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
    this.fundingCache = new Map();
    this.symbols = null;

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
    return this.config.name;
  }

  log(...args) {
    this.logger.log(`[binance:${this.market}]`, ...args);
  }

  /** Every stream one card needs. Ref-counting walks this list in both directions. */
  streamsFor(symbol, interval) {
    const streams = [klineStream(symbol, interval), tickerStream(symbol), aggTradeStream(symbol)];
    if (this.config.funding) streams.push(markPriceStream(symbol));
    return streams;
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
      const res = await fetch(`${this.config.rest}${path}`, { signal: controller.signal });
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

  /**
   * Every bar in a time range, paginating past the 1000-per-request cap.
   *
   * Volume profile needs a whole session of 1m bars -- 1440 of them for a UTC
   * day -- which is two requests. That is the same method TradingView uses:
   * its own docs say the profile is built by loading the lower-timeframe bars
   * for the session, not from tick data.
   */
  async getRange(symbol, interval, startMs, endMs) {
    const upper = symbol.toUpperCase();
    const step = intervalToMs(interval);
    const out = [];
    let cursor = Math.floor(Number(startMs));
    const end = Math.floor(Number(endMs));
    if (!Number.isFinite(cursor) || !Number.isFinite(end) || cursor >= end) return out;

    // A whole day of 1m bars is two passes; the guard is here so a bad range
    // cannot spin on the API.
    for (let pass = 0; pass < 12 && cursor < end; pass++) {
      const raw = await this.fetchJson(
        `/klines?symbol=${encodeURIComponent(upper)}&interval=${encodeURIComponent(interval)}` +
          `&startTime=${cursor}&endTime=${end}&limit=1000`
      );
      if (!raw.length) break;
      for (const row of raw) out.push(toBar(row));
      if (raw.length < 1000) break;
      cursor = raw[raw.length - 1][0] + step;
    }

    // Binance returns the in-progress candle when the range reaches now.
    const last = out[out.length - 1];
    if (last && last.time * 1000 + step > Date.now()) last.closed = false;
    return out;
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

  /** Mark price, the current funding rate and when it is charged. Perpetuals only. */
  async getFunding(symbol) {
    if (!this.config.funding) return null;
    const upper = symbol.toUpperCase();
    const raw = await this.fetchJson(`/premiumIndex?symbol=${encodeURIComponent(upper)}`);
    const funding = toFunding(upper, raw.markPrice, raw.lastFundingRate, raw.nextFundingTime);
    this.fundingCache.set(upper, funding);
    return funding;
  }

  /* --------------------------------------------------------- symbol list */

  async loadSymbols() {
    // Parsed once per session: the counterpart lookup asks on every symbol load.
    if (this.symbols && Date.now() - this.symbols.at < SYMBOLS_CACHE_TTL_MS) return this.symbols.list;

    const key = this.config.symbolsCacheKey;
    try {
      const cached = JSON.parse(localStorage.getItem(key) || 'null');
      if (cached && Date.now() - cached.at < SYMBOLS_CACHE_TTL_MS && Array.isArray(cached.list)) {
        this.symbols = cached;
        return cached.list;
      }
    } catch {
      /* corrupt cache is not worth reporting; fall through and refetch */
    }

    const info = await this.fetchJson(this.config.exchangeInfo, { timeoutMs: 30000 });
    const list = (info.symbols || [])
      // Futures exchangeInfo also lists dated quarterlies; only perpetuals here.
      .filter((s) => s.status === 'TRADING' && (!s.contractType || s.contractType === 'PERPETUAL'))
      .map((s) => ({
        symbol: s.symbol,
        base: s.baseAsset,
        quote: s.quoteAsset,
        description: `${s.baseAsset} / ${s.quoteAsset}`,
      }));

    this.symbols = { at: Date.now(), list };
    try {
      localStorage.setItem(key, JSON.stringify(this.symbols));
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

    if (previous) this.cancelPendingTick(previous);

    this.subs.set(subId, {
      symbol: upper,
      interval,
      handlers,
      lastBarTime: 0,
      // The candle currently forming. Kline frames replace it wholesale; trades
      // mutate it in place between them. Null until the first kline arrives.
      liveBar: null,
      tickTimer: null,
      lastEmitAt: 0,
    });

    // Acquire the new streams *before* releasing the old ones. Releasing first
    // would let the refcount hit zero on a single-card app, closing the shared
    // socket and forcing a reconnect just to change symbol.
    const added = [];
    for (const stream of this.streamsFor(upper, interval)) {
      const next = (this.streamRefs.get(stream) || 0) + 1;
      this.streamRefs.set(stream, next);
      if (next === 1) added.push(stream);
    }

    const removed = [];
    if (previous) {
      for (const stream of this.streamsFor(previous.symbol, previous.interval)) {
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
    const cachedFunding = this.fundingCache.get(upper);
    if (cachedFunding && handlers.onFunding) handlers.onFunding(cachedFunding);

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
    this.cancelPendingTick(sub);

    const removed = [];
    for (const stream of this.streamsFor(sub.symbol, sub.interval)) {
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
    const url = `${this.config.ws}?streams=${streams}`;
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

  /* ------------------------------------------------- live bar delivery */

  cancelPendingTick(sub) {
    if (sub.tickTimer === null) return;
    clearTimeout(sub.tickTimer);
    sub.tickTimer = null;
  }

  /** Hand the subscriber a snapshot -- never `liveBar` itself, which we keep mutating. */
  flushBar(sub) {
    if (!sub.liveBar) return;
    sub.lastEmitAt = Date.now();
    if (sub.handlers.onBar) sub.handlers.onBar({ ...sub.liveBar });
  }

  /**
   * Forward `sub.liveBar`, at most once per LIVE_TICK_MS.
   *
   * `immediate` is for authoritative kline frames: they arrive at 1/s, they
   * carry the exchange's own numbers, and delaying one to satisfy the window
   * would only make the candle staler. Trade-driven updates take the slow lane
   * -- if the window is still open, one trailing timer is armed and every trade
   * until it fires just overwrites `liveBar`, so the tape can run as hot as it
   * likes and the card still sees exactly one repaint per window.
   */
  deliverBar(sub, { immediate = false } = {}) {
    if (!sub.liveBar) return;

    const waited = Date.now() - sub.lastEmitAt;
    if (immediate || waited >= LIVE_TICK_MS) {
      this.cancelPendingTick(sub);
      this.flushBar(sub);
      return;
    }
    if (sub.tickTimer !== null) return; // a flush is already on its way

    sub.tickTimer = setTimeout(() => {
      sub.tickTimer = null;
      this.flushBar(sub);
    }, LIVE_TICK_MS - waited);
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
        sub.liveBar = bar;
        this.deliverBar(sub, { immediate: true });
      }
      return;
    }

    if (data.e === 'aggTrade') {
      const price = Number(data.p);
      if (!Number.isFinite(price)) return;
      const qty = Number(data.q);
      const tradeMs = Number(data.T);

      for (const sub of this.subs.values()) {
        if (sub.symbol !== data.s) continue;

        // Only extend a candle we have already been told about. Without a kline
        // to anchor to -- or once this one has closed -- opening the next candle
        // from a trade would mean guessing a bar boundary the exchange has not
        // confirmed, and a bar invented one tick early is a bar the next kline
        // has to fight. The gap is under a second; let the kline roll it.
        const live = sub.liveBar;
        if (!live || live.closed) continue;
        if (Number.isFinite(tradeMs) && tradeMs >= live.time * 1000 + intervalToMs(sub.interval)) {
          continue;
        }

        live.close = price;
        if (price > live.high) live.high = price;
        if (price < live.low) live.low = price;
        // Drift here is bounded by one kline frame, which overwrites it outright.
        if (Number.isFinite(qty)) live.volume += qty;

        this.deliverBar(sub);
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
      return;
    }

    if (data.e === 'markPriceUpdate') {
      const funding = toFunding(data.s, data.p, data.r, data.T);
      this.fundingCache.set(data.s, funding);
      for (const sub of this.subs.values()) {
        if (sub.symbol !== data.s) continue;
        if (sub.handlers.onFunding) sub.handlers.onFunding(funding);
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
        // A trailing flush armed before the outage would replay a bar older than
        // the gap we are about to fill, so drop it rather than let it land late.
        this.cancelPendingTick(sub);
        for (const bar of fresh) {
          sub.lastBarTime = Math.max(sub.lastBarTime, bar.time);
          if (sub.handlers.onBar) sub.handlers.onBar(bar);
        }
        const last = fresh[fresh.length - 1];
        if (last && !last.closed) {
          sub.liveBar = { ...last };
          sub.lastEmitAt = Date.now();
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
    for (const sub of this.subs.values()) this.cancelPendingTick(sub);
    this.subs.clear();
    this.streamRefs.clear();
    this.disconnect(STATUS.IDLE);
    this.statusListeners.clear();
  }
}
