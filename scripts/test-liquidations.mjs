/**
 * Liquidations: each exchange's frames read into one shape, the cache record
 * round trip, per-bar sums, and the estimated map's bookkeeping.
 * Run: node scripts/test-liquidations.mjs
 */
import assert from 'node:assert/strict';
import {
  parseBinance,
  parseBybit,
  parseOkx,
  toStored,
  fromStored,
  mergeSameMs,
  sumPerBar,
  markThreshold,
  splitSymbol,
  okxInstId,
} from '../renderer/liquidations.js';
import { LiquidationMap, buildLiquidationMap, LEVERAGE, MMR } from '../renderer/liquidation-map.js';

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

console.log('liquidations');

await test('Binance: SELL closes a long, filled quantity at the average price', () => {
  // As received on /market/stream, wrapped in {stream, data}.
  const one = parseBinance({
    stream: '!forceOrder@arr',
    data: { e: 'forceOrder', E: 1794401079132, o: { s: 'BTCUSDT', S: 'SELL', q: '0.5', p: '74000', ap: '74100', X: 'FILLED', z: '0.4', T: 1794401078127 } },
  });
  assert.equal(one.symbol, 'BTCUSDT');
  assert.equal(one.event.side, 'long');
  assert.equal(one.event.ex, 'binance');
  assert.equal(one.event.qty, 0.4);
  assert.equal(one.event.price, 74100);
  near(one.event.usd, 0.4 * 74100);
  assert.equal(one.event.t, 1794401078127);
  assert.equal(parseBinance({ o: { s: 'X', S: 'BUY', q: '0', p: '1' } }), null, 'nothing filled');
});

await test('Bybit: Buy means a long was liquidated', () => {
  const out = parseBybit({
    topic: 'allLiquidation.JCTUSDT',
    ts: 1794401230875,
    data: [
      { T: 1794401230701, s: 'JCTUSDT', S: 'Buy', v: '1300', p: '0.0072460' },
      { T: 1794401230702, s: 'JCTUSDT', S: 'Sell', v: '10', p: '0.0073' },
    ],
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].event.side, 'long');
  assert.equal(out[1].event.side, 'short');
  near(out[0].event.usd, 1300 * 0.007246);
  assert.deepEqual(parseBybit({ op: 'subscribe', success: true }), []);
});

await test('OKX: contracts to coins, and 1000-prefixed symbols rescaled', () => {
  const wanted = new Map([
    ['ETH-USDT-SWAP', { symbol: 'ETHUSDT', ctVal: 0.1, factor: 1 }],
    ['PEPE-USDT-SWAP', { symbol: '1000PEPEUSDT', ctVal: 10_000_000, factor: 1000 }],
  ]);
  const out = parseOkx(
    {
      arg: { channel: 'liquidation-orders', instType: 'SWAP' },
      data: [
        { instId: 'ETH-USDT-SWAP', details: [{ side: 'sell', posSide: 'long', bkPx: '2091.39', sz: '3', ts: '1794306208144' }] },
        { instId: 'PEPE-USDT-SWAP', details: [{ side: 'buy', posSide: 'short', bkPx: '0.0000082', sz: '2', ts: '1794306208145' }] },
        { instId: 'PYTH-USDT-SWAP', details: [{ side: 'sell', bkPx: '0.06', sz: '17', ts: '1794401221881' }] },
      ],
    },
    wanted
  );
  assert.equal(out.length, 2, 'unwanted instruments dropped');
  assert.equal(out[0].event.side, 'long');
  near(out[0].event.qty, 0.3);
  assert.equal(out[1].symbol, '1000PEPEUSDT');
  near(out[1].event.price, 0.0082);
  near(out[1].event.qty, 20_000);
  near(out[1].event.usd, 2 * 10_000_000 * 0.0000082);
});

await test('symbols: Binance names to the OKX swap', () => {
  assert.deepEqual(splitSymbol('BTCUSDT'), { base: 'BTC', factor: 1 });
  assert.deepEqual(splitSymbol('1000PEPEUSDT'), { base: 'PEPE', factor: 1000 });
  assert.deepEqual(splitSymbol('1000000MOGUSDT'), { base: 'MOG', factor: 1_000_000 });
  assert.deepEqual(splitSymbol('1INCHUSDT'), { base: '1INCH', factor: 1 });
  assert.equal(okxInstId('1000PEPEUSDT'), 'PEPE-USDT-SWAP');
});

await test('cache round trip, and same-millisecond events on different exchanges kept apart', () => {
  const a = { t: 1794401078127, ex: 'binance', side: 'long', price: 74100, qty: 0.4, usd: 29640 };
  const b = { ...a, ex: 'okx' };
  const c = { ...a, side: 'short' };
  const times = new Set([a, b, c].map((e) => toStored(e).time));
  assert.equal(times.size, 3);
  for (const e of [a, b, c]) {
    const back = fromStored(toStored(e));
    assert.equal(back.t, e.t);
    assert.equal(back.ex, e.ex);
    assert.equal(back.side, e.side);
    near(back.usd, e.usd);
  }
});

await test('same exchange, side and millisecond merged into one', () => {
  const e = (qty, price) => ({ t: 5, ex: 'bybit', side: 'long', price, qty, usd: qty * price });
  const out = mergeSameMs([e(1, 100), e(3, 104), { ...e(1, 1), side: 'short' }]);
  assert.equal(out.length, 2);
  const long = out.find((x) => x.side === 'long');
  assert.equal(long.qty, 4);
  near(long.price, 103);
  near(long.usd, 412);
});

await test('per bar: each event in the bar it fell in, by side and exchange', () => {
  const bars = [{ time: 0 }, { time: 60 }, { time: 120 }];
  const ev = (sec, side, usd, ex = 'binance') => ({ t: sec * 1000, ex, side, price: 1, qty: usd, usd });
  const out = sumPerBar([ev(10, 'long', 5), ev(59, 'short', 2, 'okx'), ev(61, 'long', 1), ev(500, 'long', 7)], bars);
  assert.equal(out.get(0).long, 5);
  assert.equal(out.get(0).short, 2);
  assert.equal(out.get(0).byEx.okx.short, 2);
  assert.equal(out.get(60).long, 1);
  assert.equal(out.get(120).long, 7, 'the last bar runs on');
});

await test('threshold: the coin\'s own top share of bars', () => {
  const per = new Map();
  for (let i = 1; i <= 100; i++) per.set(i, { long: i, short: 0 });
  assert.equal(markThreshold(per, 0.05), 96);
  assert.equal(markThreshold(new Map(), 0.05), Infinity);
});

await test('map: an opening lands at each leverage\'s liquidation price', () => {
  const map = new LiquidationMap(100);
  map.open(100, 10, 10);
  for (const [lev] of LEVERAGE) {
    assert.ok(map.long[map.index(100 * (1 - 1 / lev + MMR))] > 0, `long ${lev}x`);
    assert.ok(map.short[map.index(100 * (1 + 1 / lev - MMR))] > 0, `short ${lev}x`);
  }
  near(map.totalLong, 10);
  near(map.totalShort, 10);
});

await test('map: price reaching a level wipes it, and only what it reached', () => {
  const map = new LiquidationMap(100);
  map.open(100, 10, 10);
  // 100x long sits near 99.5, 50x near 98.5, 25x near 96.5.
  map.touch(100, 98);
  assert.equal(map.long[map.index(100 * (1 - 1 / 100 + MMR))], 0);
  assert.equal(map.long[map.index(100 * (1 - 1 / 50 + MMR))], 0);
  assert.ok(map.long[map.index(100 * (1 - 1 / 25 + MMR))] > 0);
  near(map.totalLong, 10 * (1 - 0.05 - 0.1));
  // Shorts above untouched.
  near(map.totalShort, 10);
});

await test('map: OI falling closes the newest positions first', () => {
  const bar = (i, low, high, buyVolume) => ({ time: i * 300, high, low, close: 100, volume: 10, buyVolume, quoteVolume: 1000 });
  // Opened at 100, then at 100 again; a fall in OI with all taker selling
  // closes the second opening's longs, leaving the first's.
  const bars = [bar(0, 99.9, 100.1, 5), bar(1, 99.9, 100.1, 5), bar(2, 99.9, 100.1, 0), bar(3, 99.9, 100.1, 5)];
  const oi = [0, 10, 20, 12.5, 12.5].map((value, i) => ({ time: i * 300_000, value }));
  const map = buildLiquidationMap(bars, oi, 300);
  // Each opening: 10 * (0.5 + 0.25) = 7.5 longs; the fall of 7.5 takes the second's.
  // Every tier lies outside the bars' 99.9-100.1, so nothing is wiped.
  near(map.totalLong, 7.5, 1e-9);
  // Shorts: 7.5 each, 3.75 closed (the passive share) from the second.
  near(map.totalShort, 11.25, 1e-9);
});

await test('map: built from bars and OI, clusters named on each side', () => {
  const bars = [];
  const oi = [];
  let value = 1000;
  for (let i = 0; i < 50; i++) {
    const time = 1_800_000_000 + i * 300;
    bars.push({ time, open: 100, high: 100.2, low: 99.8, close: 100, volume: 10, buyVolume: 5, quoteVolume: 1000 });
    oi.push({ time: time * 1000, value });
    value += 10;
  }
  oi.push({ time: (bars[49].time + 300) * 1000, value });
  const map = buildLiquidationMap(bars, oi, 300);
  assert.equal(map.bars, 50);
  const { above, below } = map.clusters(100);
  assert.ok(above && above.price > 100);
  assert.ok(below && below.price < 100);
  // The 10x pools are the biggest, about 10% away; the 25x ones, at two
  // thirds of that and nearer (about 3.5%), are the ones named.
  assert.ok(Math.abs(above.price - 103.5) < 0.5, `above at ${above.price}`);
  assert.ok(Math.abs(below.price - 96.5) < 0.5, `below at ${below.price}`);
  const rows = map.rows(80, 120, 40);
  assert.equal(rows.rows.length, 40);
  assert.ok(rows.max > 0);
});

await test('map: the nearest big pool is named, not a slightly bigger one further out', () => {
  const map = new LiquidationMap(100);
  map.addShort(104, 9);
  map.addShort(110, 10);
  map.addShort(102, 1); // too small to name
  map.addLong(95, 5);
  const { above, below } = map.clusters(100);
  assert.ok(Math.abs(above.price - 104) < 0.3, `above at ${above.price}`);
  assert.ok(Math.abs(below.price - 95) < 0.3, `below at ${below.price}`);
});

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
