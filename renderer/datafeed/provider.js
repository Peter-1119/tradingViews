/**
 * DataProvider — the seam between market data and everything above it (spec 6).
 *
 * The chart and UI layers only ever talk to this interface, so adding a second
 * source later (TWSE, Yahoo Finance, ...) means writing one more subclass and
 * changing nothing else.
 *
 * Shapes exchanged across this boundary:
 *
 *   Bar    { time, open, high, low, close, volume, closed }
 *            `time` is UNIX **seconds** (what lightweight-charts expects).
 *            `closed` mirrors Binance's kline `x` flag: the bar is final.
 *
 *   Ticker { symbol, last, changePercent, high, low, volume }
 *
 *   SymbolInfo { symbol, base, quote, description }
 *
 *   Status 'live' | 'reconnecting' | 'offline' | 'idle'
 */

export const STATUS = Object.freeze({
  LIVE: 'live',
  RECONNECTING: 'reconnecting',
  OFFLINE: 'offline',
  IDLE: 'idle',
});

export class DataProvider {
  /** Human-readable source name, shown in the settings panel. */
  get name() {
    return 'abstract';
  }

  /**
   * Historical bars, oldest first.
   * @param {string} symbol
   * @param {string} interval  '1m' | '5m' | '15m' | '1h' | '4h' | '1d'
   * @param {number} limit
   * @returns {Promise<Bar[]>}
   */
  // eslint-disable-next-line no-unused-vars
  async getHistory(symbol, interval, limit) {
    throw new Error('getHistory() not implemented');
  }

  /**
   * Start streaming. Implementations must coalesce identical streams so N
   * subscribers to the same symbol+interval cost one upstream connection.
   * @param {string} subId    caller-owned identity, also used to unsubscribe
   * @param {object} handlers { onBar, onTicker }
   */
  // eslint-disable-next-line no-unused-vars
  subscribe(subId, symbol, interval, handlers) {
    throw new Error('subscribe() not implemented');
  }

  // eslint-disable-next-line no-unused-vars
  unsubscribe(subId) {
    throw new Error('unsubscribe() not implemented');
  }

  /** @returns {Promise<SymbolInfo[]>} */
  // eslint-disable-next-line no-unused-vars
  async searchSymbols(query) {
    return [];
  }

  /** @returns {Promise<Ticker>} */
  // eslint-disable-next-line no-unused-vars
  async getTicker(symbol) {
    throw new Error('getTicker() not implemented');
  }

  /** Current link state, for the connection dot. */
  getStatus() {
    return STATUS.IDLE;
  }

  /** @param {(status: string) => void} cb */
  // eslint-disable-next-line no-unused-vars
  onStatusChange(cb) {
    return () => {};
  }
}

/** Interval string -> milliseconds. Used for gap detection on reconnect. */
export const INTERVAL_MS = Object.freeze({
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
});

export function intervalToMs(interval) {
  return INTERVAL_MS[interval] || INTERVAL_MS['1m'];
}
