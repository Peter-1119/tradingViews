/**
 * The DataProvider card renderers actually use: a thin proxy to the hub.
 *
 * It satisfies the same interface as BinanceProvider, so the chart and UI
 * layers cannot tell whether data arrives over a socket in this process or
 * over IPC from the hub — which is the point of the abstraction (spec 6).
 */

import { DataProvider, STATUS } from './provider.js';

export class RemoteProvider extends DataProvider {
  constructor() {
    super();
    this.bridge = window.stockcard.datafeed;
    /** subId -> handlers */
    this.subs = new Map();
    this.status = STATUS.IDLE;
    this.statusListeners = new Set();

    this.bridge.onBar(({ subId, bar }) => {
      const handlers = this.subs.get(subId);
      if (handlers && handlers.onBar) handlers.onBar(bar);
    });

    this.bridge.onTicker(({ subId, ticker }) => {
      const handlers = this.subs.get(subId);
      if (handlers && handlers.onTicker) handlers.onTicker(ticker);
    });

    this.bridge.onStatus(({ status }) => {
      if (this.status === status) return;
      this.status = status;
      for (const cb of this.statusListeners) cb(status);
    });
  }

  get name() {
    return 'Binance Spot';
  }

  getHistory(symbol, interval, limit = 500) {
    return this.bridge.call('getHistory', [symbol, interval, limit]);
  }

  getTicker(symbol) {
    return this.bridge.call('getTicker', [symbol]);
  }

  searchSymbols(query) {
    return this.bridge.call('searchSymbols', [query]);
  }

  subscribe(subId, symbol, interval, handlers = {}) {
    this.subs.set(subId, handlers);
    this.bridge.subscribe(subId, symbol, interval);
  }

  unsubscribe(subId) {
    if (!this.subs.has(subId)) return;
    this.subs.delete(subId);
    this.bridge.unsubscribe(subId);
  }

  getStatus() {
    return this.status;
  }

  onStatusChange(cb) {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }
}

/** One proxy per renderer is enough; every card in the window shares it. */
let shared = null;

export function getProvider() {
  if (!shared) shared = new RemoteProvider();
  return shared;
}
