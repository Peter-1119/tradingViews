/**
 * Coinbase: pairs for Binance symbols, the taker side of its trades, minute
 * buckets, the premium per bar with the USDT correction, and its CVD.
 * Run: node scripts/test-coinbase.mjs
 */
import assert from 'node:assert/strict';
import {
  granularityFor,
  usdtGranularity,
  flowStepFor,
  productFor,
  tradingProducts,
  parseMatch,
  parseTrade,
  parseCandles,
  addTrade,
  rollUp,
  lastPerBar,
  premiumPerBar,
  cvdPerBar,
} from '../renderer/coinbase.js';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} vs ${b}`);

console.log('coinbase');

await test('candle sizes: the largest that divides the bar, none under a minute', () => {
  assert.equal(granularityFor(60), 60);
  assert.equal(granularityFor(180), 60);
  assert.equal(granularityFor(300), 300);
  assert.equal(granularityFor(1800), 900);
  assert.equal(granularityFor(14400), 3600);
  assert.equal(granularityFor(43200), 21600);
  assert.equal(granularityFor(604800), 86400);
  assert.equal(granularityFor(1), null);
  assert.equal(flowStepFor(14400), 3600);
  assert.equal(flowStepFor(180), 60);
  assert.equal(flowStepFor(30), null);
});

await test('USDT in hours or coarser, two pages at most', () => {
  assert.equal(usdtGranularity(60, 86400), 3600);
  assert.equal(usdtGranularity(3600, 500 * 14400), 21600);
  assert.equal(usdtGranularity(3600, 1000 * 14400), 86400);
  assert.equal(usdtGranularity(86400, 1000 * 86400), 86400);
});

await test('pairs: Binance symbols to Coinbase dollar pairs', () => {
  const products = tradingProducts([
    { id: 'BTC-USD', quote_currency: 'USD', status: 'online', trading_disabled: false },
    { id: 'PEPE-USD', quote_currency: 'USD', status: 'online', trading_disabled: false },
    { id: 'OLD-USD', quote_currency: 'USD', status: 'delisted', trading_disabled: false },
    { id: 'BTC-EUR', quote_currency: 'EUR', status: 'online', trading_disabled: false },
  ]);
  assert.deepEqual(productFor('BTCUSDT', products), { product: 'BTC-USD', factor: 1, quote: 'USDT' });
  assert.deepEqual(productFor('1000PEPEUSDT', products), { product: 'PEPE-USD', factor: 1000, quote: 'USDT' });
  assert.deepEqual(productFor('BTCUSDC', products), { product: 'BTC-USD', factor: 1, quote: 'USDC' });
  assert.equal(productFor('OLDUSDT', products), null, 'delisted');
  assert.equal(productFor('BNBUSDT', products), null, 'not listed');
  assert.equal(productFor('ETHBTC', products), null, 'not a dollar quote');
});

await test('trades: Coinbase names the maker, so a sell side is a taker buy', () => {
  const m = parseMatch({ type: 'match', trade_id: 7, side: 'sell', size: '0.5', price: '74000', product_id: 'BTC-USD', time: '2026-11-11T16:32:13.785628Z' });
  assert.equal(m.buy, true);
  assert.equal(m.id, 7);
  assert.equal(m.t, Date.parse('2026-11-11T16:32:13.785Z'));
  const r = parseTrade({ trade_id: 8, side: 'buy', size: '1', price: '73990', time: '2026-11-11T16:32:14Z' }, 'BTC-USD');
  assert.equal(r.buy, false);
  assert.equal(r.product, 'BTC-USD');
  assert.equal(parseMatch({ type: 'subscriptions' }), null);
  assert.equal(parseMatch({ type: 'last_match', trade_id: 1, side: 'buy', size: '1', price: '1', time: '2026-11-11T00:00:00Z' }), null, 'before the subscription');
});

await test('minute buckets: open and close by time, whatever order the trades came in', () => {
  const buckets = new Map();
  const tr = (sec, price, size, buy) => ({ t: sec * 1000, price, size, buy });
  // The REST history comes newest first.
  for (const x of [tr(170, 103, 1, true), tr(150, 101, 2, false), tr(125, 100, 1, true), tr(61, 99, 3, false)]) addTrade(buckets, x);
  const a = buckets.get(120);
  assert.equal(a.open, 100);
  assert.equal(a.close, 103);
  assert.equal(a.high, 103);
  assert.equal(a.low, 100);
  assert.equal(a.volume, 4);
  assert.equal(a.buyVolume, 2);
  near(a.quoteVolume, 103 + 202 + 100);
  assert.equal(buckets.get(60).buyVolume, 0);
  const hours = rollUp([...buckets.values()].sort((x, y) => x.time - y.time), 3600);
  assert.equal(hours.length, 1);
  assert.equal(hours[0].volume, 7);
  assert.equal(hours[0].open, 99);
  assert.equal(hours[0].close, 103);
  assert.equal('lastT' in hours[0], false, 'bookkeeping left out');
});

await test('candles: newest first in, oldest first out', () => {
  const rows = parseCandles([
    [600, 1, 3, 2, 2.5, 10],
    [300, 1, 3, 2, 2.2, 10],
    ['bad'],
  ]);
  assert.deepEqual(rows, [{ time: 300, close: 2.2 }, { time: 600, close: 2.5 }]);
});

await test('per bar: the last candle opened inside each bar', () => {
  const times = [0, 900, 1800];
  const pts = [0, 300, 600, 900, 1200, 2400, 2700, 3000].map((time) => ({ time, close: time }));
  const out = lastPerBar(pts, times, 900);
  assert.equal(out.get(0).close, 600);
  assert.equal(out.get(900).close, 1200);
  assert.equal(out.get(1800).close, 2400, 'the forming bar');
  assert.equal(out.size, 3, 'past the last bar left out');
});

await test('premium: against Binance in dollars, USDT carried between its readings', () => {
  const times = [0, 60, 120];
  const binance = new Map([[0, 100], [60, 100], [120, 200]]);
  const cb = [{ time: 0, close: 100.1 }, { time: 60, close: 99.95 }, { time: 120, close: 200 }];
  const usdt = [{ time: 0, close: 1.001 }];
  const p = premiumPerBar(times, 60, binance, cb, usdt, 1);
  near(p.get(0), (100.1 / (100 * 1.001) - 1) * 100);
  near(p.get(60), (99.95 / (100 * 1.001) - 1) * 100, 1e-9);
  near(p.get(120), (200 / (200 * 1.001) - 1) * 100);
  // A USDC pair, or no reading: taken at 1.
  near(premiumPerBar(times, 60, binance, cb, null, 1).get(0), 0.1);
  // 1000PEPE prices a thousand coins.
  const pepe = premiumPerBar([0], 60, new Map([[0, 0.0082]]), [{ time: 0, close: 0.0000082 }], null, 1000);
  near(pepe.get(0), 0, 1e-9);
});

await test('CVD: from the first bucket on, flat where none came', () => {
  const times = [0, 60, 120, 180];
  const b = (time, volume, buyVolume, price = 100) => ({ time, volume, buyVolume, quoteVolume: volume * price, close: price });
  const out = cvdPerBar([b(60, 4, 3), b(180, 2, 0)], times, 60);
  assert.ok(Number.isNaN(out[0]), 'before the record');
  near(out[1], (2 * 3 - 4) * 100);
  near(out[2], 200, 1e-9);
  near(out[3], 200 - 200);
});

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
