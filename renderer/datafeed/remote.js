/**
 * The DataProvider card renderers actually use: a thin proxy to the hub.
 *
 * It satisfies the same interface as BinanceProvider, so the chart and UI
 * layers cannot tell whether data arrives over a socket in this process or
 * over IPC from the hub — which is the point of the abstraction (spec 6).
 *
 * One proxy per market, mirroring the hub's one provider per market. Every
 * event from the hub names its market, and each proxy ignores the other's:
 * a card that just switched market keeps its subId, so a frame still in flight
 * from the old side would otherwise land on the new chart.
 */

import { DataProvider, STATUS } from './provider.js';

export const MARKET_IDS = ['spot', 'perp'];

export class RemoteProvider extends DataProvider {
  constructor(market = 'spot') {
    super();
    this.market = market;
    this.bridge = window.stockcard.datafeed;
    /** subId -> handlers */
    this.subs = new Map();
    this.status = STATUS.IDLE;
    this.statusListeners = new Set();

    const route = (handlerName, field) => (payload) => {
      if (!payload || payload.market !== this.market) return;
      const handlers = this.subs.get(payload.subId);
      if (handlers && handlers[handlerName]) handlers[handlerName](payload[field]);
    };
    this.bridge.onBar(route('onBar', 'bar'));
    this.bridge.onTicker(route('onTicker', 'ticker'));
    this.bridge.onFunding(route('onFunding', 'funding'));

    this.bridge.onStatus(({ market, status }) => {
      if (market !== this.market || this.status === status) return;
      this.status = status;
      for (const cb of this.statusListeners) cb(status);
    });
  }

  get name() {
    return this.market === 'perp' ? 'Binance USD-M' : 'Binance Spot';
  }

  call(method, args) {
    return this.bridge.call(this.market, method, args);
  }

  getHistory(symbol, interval, limit = 500) {
    return this.call('getHistory', [symbol, interval, limit]);
  }

  getRange(symbol, interval, startMs, endMs) {
    return this.call('getRange', [symbol, interval, startMs, endMs]);
  }

  getTicker(symbol) {
    return this.call('getTicker', [symbol]);
  }

  /** @returns {Promise<{symbol, markPrice, fundingRate, nextFundingTime}|null>} null on spot */
  getFunding(symbol) {
    return this.call('getFunding', [symbol]);
  }

  searchSymbols(query) {
    return this.call('searchSymbols', [query]);
  }

  /** The same instrument on `toMarket` (PEPEUSDT -> 1000PEPEUSDT), or null. */
  counterpart(symbol, toMarket) {
    return this.call('counterpart', [symbol, this.market, toMarket]);
  }

  subscribe(subId, symbol, interval, handlers = {}) {
    this.subs.set(subId, handlers);
    this.bridge.subscribe(subId, this.market, symbol, interval);
  }

  unsubscribe(subId) {
    if (!this.subs.has(subId)) return;
    this.subs.delete(subId);
    this.bridge.unsubscribe(subId, this.market);
  }

  getStatus() {
    return this.status;
  }

  onStatusChange(cb) {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }
}

/** One proxy per market per renderer; every card in the window shares it. */
const shared = new Map();

export function getProvider(market = 'spot') {
  const key = MARKET_IDS.includes(market) ? market : 'spot';
  if (!shared.has(key)) shared.set(key, new RemoteProvider(key));
  return shared.get(key);
}
