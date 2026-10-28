// Price and volume alerts in the hub (renderer/price-alert-monitor.js).
import assert from 'node:assert/strict';
import { PriceAlertMonitor } from '../renderer/price-alert-monitor.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); console.log('  ok   ' + name); pass++; } catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; } };

/** A feed that records subscriptions and lets the test push bars into them. */
function setup() {
  const subs = new Map();
  const feed = {
    subscribe: (id, symbol, interval, handlers) => subs.set(id, { symbol, interval, handlers }),
    unsubscribe: (id) => subs.delete(id),
  };
  const hits = [];
  const monitor = new PriceAlertMonitor({ feedFor: () => feed, onHit: (h) => hits.push(h), logger: { log() {} } });
  const push = (interval, bar) => {
    for (const s of subs.values()) if (s.interval === interval) s.handlers.onBar(bar);
  };
  return { subs, hits, monitor, push };
}
const bar = (time, close, quoteVolume) => ({ time, open: close, high: close, low: close, close, volume: quoteVolume / close, quoteVolume });
const vol = (extra) => ({ id: 'v', kind: 'volume', symbol: 'BTCUSDT', market: 'perp', interval: '5m', volume: 1e6, notBefore: 0, ...extra });

t('a volume alert subscribes to its own interval, a price alert to 1m', () => {
  const { subs, monitor } = setup();
  monitor.setAlerts([vol(), { id: 'p', symbol: 'BTCUSDT', market: 'perp', price: 100, direction: 'up' }]);
  assert.deepEqual([...subs.values()].map((s) => s.interval).sort(), ['1m', '5m']);
});

t('fires once when the open bar reaches the level', () => {
  const { hits, monitor, push } = setup();
  monitor.setAlerts([vol()]);
  push('5m', bar(300, 100, 4e5));
  assert.equal(hits.length, 0);
  push('5m', bar(300, 100, 1.2e6));
  push('5m', bar(300, 100, 1.5e6));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'v');
  assert.equal(hits[0].volume, 1.2e6);
});

t('a bar before notBefore does not fire, the next one does', () => {
  const { hits, monitor, push } = setup();
  monitor.setAlerts([vol({ notBefore: 600 })]);
  push('5m', bar(300, 100, 3e6));
  assert.equal(hits.length, 0);
  push('5m', bar(600, 100, 1e6));
  assert.equal(hits.length, 1);
});

t('an older bar arriving late is not judged', () => {
  const { hits, monitor, push } = setup();
  monitor.setAlerts([vol({ notBefore: 0 })]);
  push('5m', bar(600, 100, 1e5));
  push('5m', bar(300, 100, 5e6)); // a backfilled closed bar
  assert.equal(hits.length, 0);
});

t('price alerts still fire on the live price', () => {
  const { hits, monitor, push } = setup();
  monitor.setAlerts([{ id: 'p', symbol: 'BTCUSDT', market: 'perp', price: 105, direction: 'up' }]);
  push('1m', bar(60, 104, 1));
  push('1m', bar(60, 105.5, 1));
  assert.deepEqual(hits.map((h) => h.id), ['p']);
});

t('removing the last alert on a stream unsubscribes it', () => {
  const { subs, monitor } = setup();
  monitor.setAlerts([vol()]);
  monitor.setAlerts([]);
  assert.equal(subs.size, 0);
});

console.log(`${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
