/**
 * Price-position alerts for the watchlist, run in the hub.
 *
 * For every watchlist entry -- whether or not any card shows it -- this keeps
 * the last 72 hours of closed 1m bars, rebuilds the 4H / 24H / 72H volume
 * distributions each time a bar closes, and reads the *live* price against
 * them on every update the feed delivers (up to 10 a second). An alert is a
 * price touching a level, not a bar closing past it: measured over 30 days,
 * checking closes alone misses 15-30% of the touches.
 *
 * It lives in the hub for the same reason the sockets do: one copy, however
 * many card windows are open, and none needed for it to run.
 */

import { WINDOWS, buildCdf, percentileOf, LevelTrigger } from './position.js';

const KEEP = WINDOWS['72H'];
/** A window with less history than this (a new listing) is not measured. */
const MIN_FILL = 0.9;
/** Cards redraw the readout at most this often; alerts are never throttled. */
const STATE_MS = 250;

export class AlertMonitor {
  /**
   * @param {{
   *   feedFor: (market: string) => object,
   *   onAlert: (alert: object) => void,
   *   onState: (state: object) => void,
   *   logger?: object,
   * }} options
   */
  constructor({ feedFor, onAlert, onState, logger = console }) {
    this.feedFor = feedFor;
    this.onAlert = onAlert;
    this.onState = onState;
    this.logger = logger;
    /** "market:symbol" -> watch record */
    this.watched = new Map();
    /** window name -> percent levels that alert */
    this.levels = {};
  }

  /**
   * @param {{symbol: string, market: string}[]} entries
   * @param {Record<string, number[]>} levels
   */
  setWatch(entries, levels = {}) {
    const levelsChanged = JSON.stringify(levels) !== JSON.stringify(this.levels);
    this.levels = levels;
    const wanted = new Map((entries || []).map((e) => [`${e.market}:${e.symbol}`, e]));
    for (const [key, w] of [...this.watched]) if (!wanted.has(key)) this.stop(w);
    for (const [key, entry] of wanted) {
      const w = this.watched.get(key);
      if (!w) this.start(key, entry);
      else if (levelsChanged) this.resetTriggers(w);
    }
  }

  start(key, { symbol, market }) {
    const w = {
      key,
      symbol,
      market,
      subId: `alert:${key}`,
      bars: [],
      cdfs: {},
      triggers: {},
      price: null,
      stopped: false,
      sentAt: 0,
      sentSig: '',
      stateTimer: null,
    };
    this.watched.set(key, w);
    this.resetTriggers(w);

    // Live first, so no bar that closes while history is loading is lost.
    const feed = this.feedFor(market);
    feed.subscribe(w.subId, symbol, '1m', { onBar: (bar) => this.onBar(w, bar) });

    const now = Date.now();
    feed
      .getRange(symbol, '1m', now - (KEEP + 2) * 60_000, now)
      .then((history) => {
        if (w.stopped) return;
        const byTime = new Map(history.filter((b) => b.closed).map((b) => [b.time, b]));
        for (const b of w.bars) byTime.set(b.time, b);
        w.bars = [...byTime.values()].sort((a, b) => a.time - b.time).slice(-KEEP);
        this.rebuild(w);
        const last = history[history.length - 1];
        if (w.price === null && last) w.price = last.close;
        this.evaluate(w);
      })
      .catch((err) => this.logger.error('[alerts] history failed', key, err));
  }

  stop(w) {
    w.stopped = true;
    clearTimeout(w.stateTimer);
    this.feedFor(w.market).unsubscribe(w.subId);
    this.watched.delete(w.key);
  }

  /** Fresh triggers prime themselves on the next price: no alert for where it already is. */
  resetTriggers(w) {
    for (const name of Object.keys(WINDOWS)) w.triggers[name] = new LevelTrigger(this.levels[name] || []);
  }

  onBar(w, bar) {
    if (w.stopped || !bar) return;
    if (bar.closed) {
      const last = w.bars[w.bars.length - 1];
      if (!last || bar.time > last.time) {
        w.bars.push(bar);
        if (w.bars.length > KEEP) w.bars.splice(0, w.bars.length - KEEP);
        this.rebuild(w);
      } else if (bar.time === last.time) {
        w.bars[w.bars.length - 1] = bar;
        this.rebuild(w);
      }
    }
    w.price = bar.close;
    this.evaluate(w);
  }

  /** Once a minute per symbol: ~6000 bars across three windows, a few ms. */
  rebuild(w) {
    for (const [name, n] of Object.entries(WINDOWS)) {
      w.cdfs[name] = w.bars.length >= n * MIN_FILL ? buildCdf(w.bars.slice(-n)) : null;
    }
  }

  evaluate(w) {
    if (w.price === null) return;
    const pcts = {};
    for (const name of Object.keys(WINDOWS)) {
      const pct = percentileOf(w.cdfs[name], w.price);
      pcts[name] = pct;
      if (pct === null) continue;
      const hit = w.triggers[name].update(pct);
      if (hit) {
        this.onAlert({
          symbol: w.symbol,
          market: w.market,
          window: name,
          side: hit.side,
          level: hit.level,
          pct,
          price: w.price,
          time: Date.now(),
        });
      }
    }
    this.sendState(w, pcts);
  }

  /** Only when a rounded figure moved, at most every STATE_MS, never dropping the last one. */
  sendState(w, pcts) {
    const sig = Object.values(pcts)
      .map((p) => (p === null ? '-' : Math.round(p * 100)))
      .join(',');
    if (sig === w.sentSig) {
      // Back to what the cards already show: drop anything queued in between.
      clearTimeout(w.stateTimer);
      w.stateTimer = null;
      return;
    }
    const send = () => {
      w.stateTimer = null;
      w.sentAt = Date.now();
      w.sentSig = sig;
      this.onState({ symbol: w.symbol, market: w.market, pcts, price: w.price });
    };
    clearTimeout(w.stateTimer);
    const wait = STATE_MS - (Date.now() - w.sentAt);
    if (wait <= 0) send();
    else w.stateTimer = setTimeout(send, wait);
  }

  destroy() {
    for (const w of [...this.watched.values()]) this.stop(w);
  }
}
