/**
 * Price and volume alerts, run in the hub.
 *
 * One live subscription per market:symbol:interval that has an alert, and
 * none for symbols without -- the hub's streams are ref-counted, so a symbol
 * a card is already showing costs no extra socket stream. Price alerts all
 * ride the 1m stream; a volume alert rides its own interval's, since that is
 * the bar whose volume it counts. The hub keeps running with every card
 * hidden or closed, which is the point: an alert has to fire when nothing is
 * on screen.
 *
 * Price is judged on the live price (each kline update's close, several a
 * second), not on a bar's high or low: a high since the bar opened can predate
 * the alert, and would fire it for a touch that happened before it was set.
 * Volume is judged on the open bar's volume so far, from `notBefore` on --
 * and never on the bar that was open when the alert was set or moved if that
 * bar was already past it when first seen here, whatever the card thought.
 */

import { volumeValue } from './volume-stats.js';

const isVolume = (a) => a.kind === 'volume';

/** The stream an alert is judged on. */
const streamKey = (a) => `${a.market}:${a.symbol}:${isVolume(a) ? a.interval : '1m'}`;

export class PriceAlertMonitor {
  /**
   * @param {{feedFor: (market) => object, onHit: ({id, price, volume}) => void, logger?: object}} options
   */
  constructor({ feedFor, onHit, logger = console }) {
    this.feedFor = feedFor;
    this.onHit = onHit;
    this.logger = logger;
    /** "market:symbol:interval" -> {symbol, market, interval, subId, alerts: Map(id -> alert), bar} */
    this.watched = new Map();
    /** Hits reported but not yet removed by main -- never report one twice. */
    this.reported = new Set();
    /** "id:volume" -> the first bar time a volume alert may fire on, from what this monitor saw. */
    this.armedFrom = new Map();
  }

  setAlerts(list) {
    const byKey = new Map();
    for (const a of list || []) {
      const key = streamKey(a);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(a);
    }
    for (const [key, w] of [...this.watched]) {
      if (!byKey.has(key)) this.stop(w);
    }
    const live = new Set((list || []).map((a) => a.id));
    for (const id of [...this.reported]) if (!live.has(id)) this.reported.delete(id);
    const levels = new Set((list || []).filter(isVolume).map((a) => `${a.id}:${a.volume}`));
    for (const key of [...this.armedFrom.keys()]) if (!levels.has(key)) this.armedFrom.delete(key);

    for (const [key, alerts] of byKey) {
      let w = this.watched.get(key);
      if (!w) w = this.start(key, alerts[0]);
      w.alerts = new Map(alerts.map((a) => [a.id, a]));
      // A moved alert is judged against the bar we already have, at once.
      if (w.bar) this.evaluate(w);
    }
  }

  start(key, alert) {
    const { symbol, market } = alert;
    const interval = isVolume(alert) ? alert.interval : '1m';
    const w = { key, symbol, market, interval, subId: `price-alert:${key}`, alerts: new Map(), bar: null };
    this.watched.set(key, w);
    this.feedFor(market).subscribe(w.subId, symbol, interval, {
      onBar: (bar) => {
        if (!bar || !Number.isFinite(bar.close)) return;
        // A backfilled closed bar can arrive after the live one; judge the newest.
        if (w.bar && bar.time < w.bar.time) return;
        w.bar = bar;
        this.evaluate(w);
      },
    });
    return w;
  }

  stop(w) {
    this.feedFor(w.market).unsubscribe(w.subId);
    this.watched.delete(w.key);
  }

  evaluate(w) {
    const bar = w.bar;
    const price = bar.close;
    const volume = volumeValue(bar);
    for (const a of w.alerts.values()) {
      if (this.reported.has(a.id)) continue;
      const hit = isVolume(a)
        ? bar.time >= this.volumeFrom(a, bar, volume) && volume >= a.volume
        : a.direction === 'up'
          ? price >= a.price
          : price <= a.price;
      if (!hit) continue;
      this.reported.add(a.id);
      if (isVolume(a)) this.logger.log(`[price-alert] ${w.key} volume ${a.volume} hit at ${volume}`);
      else this.logger.log(`[price-alert] ${w.key} ${a.direction} ${a.price} hit at ${price}`);
      this.onHit({ id: a.id, price, volume });
    }
  }

  /**
   * The first bar `a` may fire on. Its level is armed on the first bar seen
   * after it is set (or moved): a bar already past it then reached it
   * before the alert existed, so the next one is the first that counts.
   */
  volumeFrom(a, bar, volume) {
    const key = `${a.id}:${a.volume}`;
    if (!this.armedFrom.has(key)) this.armedFrom.set(key, volume >= a.volume ? bar.time + 1 : bar.time);
    return Math.max(a.notBefore || 0, this.armedFrom.get(key));
  }

  destroy() {
    for (const w of [...this.watched.values()]) this.stop(w);
  }
}
