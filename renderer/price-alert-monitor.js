/**
 * Price alerts, run in the hub.
 *
 * One live subscription per market:symbol that has an alert, and none for
 * symbols without -- the hub's streams are ref-counted, so a symbol a card is
 * already showing costs no extra socket stream. The hub keeps running with
 * every card hidden or closed, which is the point: an alert has to fire when
 * nothing is on screen.
 *
 * Judged on the live price (each kline update's close, several a second), not
 * on a bar's high or low: a high since the bar opened can predate the alert,
 * and would fire it for a touch that happened before it was set.
 */

export class PriceAlertMonitor {
  /**
   * @param {{feedFor: (market) => object, onHit: ({id, price}) => void, logger?: object}} options
   */
  constructor({ feedFor, onHit, logger = console }) {
    this.feedFor = feedFor;
    this.onHit = onHit;
    this.logger = logger;
    /** "market:symbol" -> {symbol, market, subId, alerts: Map(id -> alert), price} */
    this.watched = new Map();
    /** Hits reported but not yet removed by main -- never report one twice. */
    this.reported = new Set();
  }

  setAlerts(list) {
    const byKey = new Map();
    for (const a of list || []) {
      const key = `${a.market}:${a.symbol}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(a);
    }
    for (const [key, w] of [...this.watched]) {
      if (!byKey.has(key)) this.stop(w);
    }
    const live = new Set((list || []).map((a) => a.id));
    for (const id of [...this.reported]) if (!live.has(id)) this.reported.delete(id);

    for (const [key, alerts] of byKey) {
      let w = this.watched.get(key);
      if (!w) w = this.start(key, alerts[0]);
      w.alerts = new Map(alerts.map((a) => [a.id, a]));
      // A moved alert is judged against the price we already have, at once.
      if (w.price !== null) this.evaluate(w);
    }
  }

  start(key, { symbol, market }) {
    const w = { key, symbol, market, subId: `price-alert:${key}`, alerts: new Map(), price: null };
    this.watched.set(key, w);
    this.feedFor(market).subscribe(w.subId, symbol, '1m', {
      onBar: (bar) => {
        if (!bar || !Number.isFinite(bar.close)) return;
        w.price = bar.close;
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
    const price = w.price;
    for (const a of w.alerts.values()) {
      if (this.reported.has(a.id)) continue;
      const hit = a.direction === 'up' ? price >= a.price : price <= a.price;
      if (!hit) continue;
      this.reported.add(a.id);
      this.logger.log(`[price-alert] ${w.key} ${a.direction} ${a.price} hit at ${price}`);
      this.onHit({ id: a.id, price });
    }
  }

  destroy() {
    for (const w of [...this.watched.values()]) this.stop(w);
  }
}
