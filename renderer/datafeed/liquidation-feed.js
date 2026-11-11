/**
 * Forced liquidations from Binance, Bybit and OKX, collected in the hub.
 *
 * One socket per exchange, opened while anything is wanted and closed when
 * nothing is: Binance and OKX each send every symbol on one stream, filtered
 * here; Bybit sends a topic per symbol, subscribed as symbols come and go.
 *
 * What it records: every perpetual a card is open on (recording does not wait
 * for the layer to be switched on -- history is the point, and it can only
 * start when the app sees it), and whatever a card's layer asks for, which
 * for a spot card is its perpetual counterpart. Kept in the bar cache as
 * series `liqs` under the perpetual (liquidations.js, toStored).
 *
 * The sockets follow the app's pattern: exponential backoff on close, and a
 * ping where the exchange asks for one (OKX drops a socket silent for 30s,
 * Bybit recommends one every 20s; Binance pings us and the browser answers).
 */

import { parseBinance, parseBybit, parseOkx, mergeSameMs, toStored, fromStored, okxInstId, splitSymbol } from '../liquidations.js';

const URLS = {
  binance: 'wss://fstream.binance.com/market/stream?streams=!forceOrder@arr',
  bybit: 'wss://stream.bybit.com/v5/public/linear',
  okx: 'wss://ws.okx.com:443/ws/v5/public',
};
const OKX_INSTRUMENTS = 'https://www.okx.com/api/v5/public/instruments?instType=SWAP';
const PING_MS = { bybit: 20_000, okx: 20_000 };
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
/** Frames to cards and writes to disk, batched. */
const EMIT_MS = 1000;
const FLUSH_MS = 5000;
/** Bybit takes topics ten to a request. */
const BYBIT_BATCH = 10;

export class LiquidationFeed {
  /**
   * @param {{
   *   store?: {read: (symbol, from, to) => Promise<object[]>, write: (symbol, records) => Promise<any>},
   *   logger?: Console,
   * }} opts
   */
  constructor({ store = null, logger = console } = {}) {
    this.store = store;
    this.logger = logger;
    /** key -> symbol: what is recorded, and why (a card open on it, or its layer). */
    this.wants = new Map();
    /** symbol -> Map<key, listener> for cards showing the layer. */
    this.listeners = new Map();
    /** symbol -> events heard but not yet sent to the cards. */
    this.pending = new Map();
    /** symbol -> events not yet written, still answered from memory. */
    this.unsaved = new Map();
    /** OKX instId -> {symbol, ctVal, factor}, for the symbols wanted. */
    this.okxWanted = new Map();
    this.okxCtVal = null;
    this.sockets = {};
    this.attempts = {};
    this.timers = {};
    this.pings = {};
    this.bybitTopics = new Set();
    this.emitTimer = null;
    this.flushTimer = null;
    /** When each symbol was first recorded this session (ms). */
    this.since = new Map();
  }

  /* ----------------------------------------------------------- wanting */

  symbols() {
    return new Set(this.wants.values());
  }

  /** Record `symbol` (a Binance perpetual) under `key`, replacing what `key` wanted. */
  want(key, symbol) {
    const upper = String(symbol || '').toUpperCase();
    if (!upper) return;
    if (this.wants.get(key) === upper) return;
    this.wants.set(key, upper);
    if (!this.since.has(upper)) this.since.set(upper, Date.now());
    this.sync();
  }

  unwant(key) {
    if (!this.wants.delete(key)) return;
    for (const map of this.listeners.values()) map.delete(key);
    this.sync();
  }

  /**
   * A card's layer on: listen for `symbol` under `key`. Resolves with what is
   * kept from `fromSec` ({symbol, events, since}); `listener` hears new
   * events in batches each second.
   */
  async watch(key, symbol, listener, fromSec) {
    const upper = String(symbol || '').toUpperCase();
    this.want(key, upper);
    for (const map of this.listeners.values()) map.delete(key);
    if (!this.listeners.has(upper)) this.listeners.set(upper, new Map());
    this.listeners.get(upper).set(key, listener);
    return { symbol: upper, events: await this.snapshot(upper, fromSec), since: this.since.get(upper) || Date.now() };
  }

  /** Sockets opened or closed, and topics changed, to match what is wanted. */
  sync() {
    const symbols = this.symbols();
    for (const symbol of [...this.listeners.keys()]) {
      if (!symbols.has(symbol) || !this.listeners.get(symbol).size) this.listeners.delete(symbol);
    }
    if (!symbols.size) {
      for (const ex of Object.keys(URLS)) this.closeSocket(ex);
      this.bybitTopics.clear();
      this.okxWanted.clear();
      return;
    }
    this.ensure('binance');
    this.ensure('bybit');
    this.syncBybit();
    this.syncOkx();
  }

  /* --------------------------------------------------------- recording */

  /** One parsed {symbol, event}, from any exchange. */
  heard(symbol, event) {
    if (!this.symbols().has(symbol)) return;
    if (!this.pending.has(symbol)) this.pending.set(symbol, []);
    this.pending.get(symbol).push(event);
    if (!this.unsaved.has(symbol)) this.unsaved.set(symbol, []);
    this.unsaved.get(symbol).push(event);
    if (!this.emitTimer) this.emitTimer = setTimeout(() => this.emit(), EMIT_MS);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  emit() {
    this.emitTimer = null;
    for (const [symbol, events] of this.pending) {
      const listeners = this.listeners.get(symbol);
      if (!listeners) continue;
      const batch = mergeSameMs(events);
      for (const listener of listeners.values()) {
        try {
          listener(batch);
        } catch (err) {
          this.logger.error('[liqs] listener threw', err);
        }
      }
    }
    this.pending.clear();
  }

  async flush() {
    this.flushTimer = null;
    if (!this.store) return;
    for (const [symbol, events] of [...this.unsaved]) {
      if (!events.length) continue;
      const batch = events.slice();
      try {
        await this.store.write(symbol, mergeSameMs(batch).map(toStored));
        const left = this.unsaved.get(symbol) || [];
        this.unsaved.set(symbol, left.filter((e) => !batch.includes(e)));
      } catch (err) {
        this.logger.error('[liqs] write failed', symbol, err);
      }
    }
  }

  /** Every kept event for `symbol` from `fromSec`, oldest first. */
  async snapshot(symbol, fromSec) {
    const from = Number(fromSec) || 0;
    const byKey = new Map();
    const key = (e) => `${e.t}|${e.ex}|${e.side}`;
    if (this.store) {
      try {
        for (const r of await this.store.read(symbol, from, Date.now() / 1000 + 60)) {
          const e = fromStored(r);
          byKey.set(key(e), e);
        }
      } catch (err) {
        this.logger.error('[liqs] read failed', symbol, err);
      }
    }
    for (const e of mergeSameMs(this.unsaved.get(symbol) || [])) if (e.t >= from * 1000) byKey.set(key(e), e);
    return [...byKey.values()].sort((a, b) => a.t - b.t);
  }

  /* ------------------------------------------------------------ sockets */

  ensure(ex) {
    if (this.sockets[ex]) return;
    clearTimeout(this.timers[ex]);
    let ws;
    try {
      ws = new WebSocket(URLS[ex]);
    } catch (err) {
      this.logger.error('[liqs] socket failed', ex, err);
      this.retry(ex);
      return;
    }
    this.sockets[ex] = ws;
    ws.onopen = () => {
      if (this.sockets[ex] !== ws) return;
      this.attempts[ex] = 0;
      if (ex === 'bybit') {
        const topics = [...this.bybitTopics];
        this.bybitTopics.clear();
        this.syncBybit(topics);
      }
      if (ex === 'okx') ws.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'liquidation-orders', instType: 'SWAP' }] }));
      if (PING_MS[ex]) {
        clearInterval(this.pings[ex]);
        this.pings[ex] = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(ex === 'okx' ? 'ping' : '{"op":"ping"}');
        }, PING_MS[ex]);
      }
    };
    ws.onmessage = (msg) => {
      if (this.sockets[ex] !== ws || msg.data === 'pong') return;
      let data;
      try {
        data = JSON.parse(msg.data);
      } catch {
        return;
      }
      this.dispatch(ex, data);
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.sockets[ex] !== ws) return;
      this.sockets[ex] = null;
      clearInterval(this.pings[ex]);
      if (ex === 'bybit') this.bybitTopics.clear();
      if (this.symbols().size) this.retry(ex);
    };
  }

  dispatch(ex, data) {
    if (ex === 'binance') {
      const one = parseBinance(data);
      if (one) this.heard(one.symbol, one.event);
    } else if (ex === 'bybit') {
      for (const one of parseBybit(data)) this.heard(one.symbol, one.event);
    } else if (ex === 'okx') {
      for (const one of parseOkx(data, this.okxWanted)) this.heard(one.symbol, one.event);
    }
  }

  retry(ex) {
    const attempt = (this.attempts[ex] = (this.attempts[ex] || 0) + 1);
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** (attempt - 1));
    clearTimeout(this.timers[ex]);
    this.timers[ex] = setTimeout(() => {
      this.sockets[ex] = null;
      if (this.symbols().size && (ex !== 'okx' || this.okxWanted.size)) this.ensure(ex);
    }, delay);
  }

  closeSocket(ex) {
    clearTimeout(this.timers[ex]);
    clearInterval(this.pings[ex]);
    const ws = this.sockets[ex];
    this.sockets[ex] = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    }
  }

  /** Bybit topics to match the symbols wanted; `resend` after a reconnect. */
  syncBybit(resend = null) {
    const ws = this.sockets.bybit;
    const want = new Set([...this.symbols()].map((s) => `allLiquidation.${s}`));
    if (resend) for (const topic of resend) if (want.has(topic)) this.bybitTopics.delete(topic);
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const add = [...want].filter((topic) => !this.bybitTopics.has(topic));
    const drop = [...this.bybitTopics].filter((topic) => !want.has(topic));
    for (let i = 0; i < add.length; i += BYBIT_BATCH) {
      ws.send(JSON.stringify({ op: 'subscribe', args: add.slice(i, i + BYBIT_BATCH) }));
    }
    for (let i = 0; i < drop.length; i += BYBIT_BATCH) {
      ws.send(JSON.stringify({ op: 'unsubscribe', args: drop.slice(i, i + BYBIT_BATCH) }));
    }
    for (const topic of add) this.bybitTopics.add(topic);
    for (const topic of drop) this.bybitTopics.delete(topic);
  }

  /** The OKX swaps for the symbols wanted, once its contract sizes are known. */
  async syncOkx() {
    if (!this.okxCtVal) {
      if (!this.okxLoading) {
        this.okxLoading = fetch(OKX_INSTRUMENTS)
          .then((res) => res.json())
          .then((body) => {
            const map = new Map();
            for (const row of (body && body.data) || []) {
              const ctVal = Number(row.ctVal);
              if (row.ctType === 'linear' && ctVal > 0) map.set(row.instId, ctVal);
            }
            this.okxCtVal = map;
          })
          .catch((err) => {
            this.logger.warn('[liqs] OKX instruments failed', err && err.message);
          })
          .finally(() => {
            this.okxLoading = null;
          });
      }
      await this.okxLoading;
      if (!this.okxCtVal) return;
    }
    this.okxWanted.clear();
    for (const symbol of this.symbols()) {
      const instId = okxInstId(symbol);
      const ctVal = this.okxCtVal.get(instId);
      if (ctVal) this.okxWanted.set(instId, { symbol, ctVal, factor: splitSymbol(symbol).factor });
    }
    if (this.okxWanted.size) this.ensure('okx');
    else this.closeSocket('okx');
  }

  destroy() {
    this.wants.clear();
    this.listeners.clear();
    for (const ex of Object.keys(URLS)) this.closeSocket(ex);
    clearTimeout(this.emitTimer);
    clearTimeout(this.flushTimer);
    this.flush();
  }
}
