// Big orders (renderer/datafeed/sweep-collector.js) and the position read (renderer/flow-read.js).
import assert from 'node:assert/strict';
import { SizeRanking, SweepCollector, STORE_TOP, toStored, fromStored } from '../renderer/datafeed/sweep-collector.js';
import { readBar, readPositions } from '../renderer/flow-read.js';

let pass = 0, fail = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

t('ranking: the share of orders at least as large', () => {
  const r = new SizeRanking(() => 0);
  for (let i = 1; i <= 10000; i++) r.add(i * 10); // $10 .. $100,000, evenly
  assert.ok(r.warm);
  assert.ok(Math.abs(r.top(50_000) - 0.5) < 0.03, `median ${r.top(50_000)}`);
  assert.ok(r.top(99_900) < 0.01);
  const c = r.cutoff(0.1);
  assert.ok(c > 80_000 && c <= 90_000, `top 10% from ${c}`);
});

t('ranking: an hour-old window still counts, a two-hour-old one does not', () => {
  let now = 0;
  const r = new SizeRanking(() => now);
  for (let i = 0; i < 1000; i++) r.add(100);
  now = 61 * 60_000;
  r.add(100);
  assert.equal(r.total, 1001);
  now = 4 * 3600_000;
  r.add(100);
  assert.equal(r.total, 1);
});

t('one millisecond of trades is one order, both sides folded, kept when it ranks', async () => {
  const kept = [];
  const heard = [];
  const c = new SweepCollector({
    symbol: 'ETHUSDT',
    store: { read: async () => kept.map(toStored), write: async (recs) => kept.push(...recs.map(fromStored)) },
    onSweep: (s) => heard.push(s),
  });
  for (let i = 0; i < 5000; i++) c.ranking.add(1000); // a market of $1K orders
  // 20:50:26.306: one sell across three prices, and a small buy in the same ms.
  c.trade({ T: 1000, p: '2250.08', q: '100', m: true });
  c.trade({ T: 1000, p: '2250.01', q: '800', m: true });
  c.trade({ T: 1000, p: '2250.00', q: '2676', m: true });
  c.trade({ T: 1000, p: '2250.01', q: '4', m: false });
  c.trade({ T: 1001, p: '2250.00', q: '0.1', m: true }); // closes the first
  assert.equal(heard.length, 1);
  const s = heard[0];
  assert.equal(s.qty, 3580);
  assert.equal(s.buyQty, 4);
  assert.equal(s.high, 2250.08);
  assert.equal(s.low, 2250);
  assert.ok(s.top <= STORE_TOP);
  assert.ok(Math.abs(s.vwap - s.notional / s.qty) < 1e-9);
  c.close(); // the small one: ranks low, not kept
  assert.equal(heard.length, 1);
  const snap = await c.snapshot(0);
  assert.equal(snap.sweeps.length, 1);
  assert.equal(snap.sweeps[0].t, 1000);
  c.stop();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(kept.length, 1, 'written on stop');
  assert.deepEqual(fromStored(toStored(s)), { ...s, t: 1000 });
});

t('nothing is kept before the ranking has seen enough orders', () => {
  const heard = [];
  const c = new SweepCollector({ symbol: 'X', onSweep: (s) => heard.push(s) });
  c.trade({ T: 5, p: '1', q: '1e9', m: false });
  c.close();
  assert.equal(heard.length, 0);
  c.stop();
});

t('read: the four quadrants, and no lean when takers are even', () => {
  const bar = (buy, vol = 100) => ({ time: 0, volume: vol, buyVolume: buy });
  const oi = (d) => ({ open: 1000, close: 1000 + d });
  assert.equal(readBar(bar(80), oi(+50)).kind, 'longOpen');
  assert.equal(readBar(bar(80), oi(-50)).kind, 'shortCover');
  assert.equal(readBar(bar(20), oi(+50)).kind, 'shortOpen');
  assert.equal(readBar(bar(20), oi(-50)).kind, 'longClose');
  assert.equal(readBar(bar(52), oi(+50)).kind, 'bothOpen');
  assert.equal(readBar(bar(48), oi(-50)).kind, 'bothClose');
  assert.equal(readBar(bar(80), null), null);
});

t('read: only bars whose |ΔOI| stands out are marked (20:50 on ETH)', () => {
  // Quiet minutes moving OI by ~200, then 20:50: 86% taker selling, OI -5,786.
  const bars = [];
  const oi = new Map();
  for (let i = 0; i < 30; i++) {
    bars.push({ time: i * 60, volume: 1000, buyVolume: 500 + (i % 3) * 50 });
    oi.set(i * 60, { open: 2.34e6, close: 2.34e6 + (i % 2 ? 200 : -150) });
  }
  bars.push({ time: 1800, volume: 12814, buyVolume: 1781 });
  oi.set(1800, { open: 2341480, close: 2335694 });
  const { reads, scale } = readPositions(bars, oi, 3);
  assert.ok(scale > 100 && scale < 250, `scale ${scale}`);
  const marked = [...reads.values()].filter((r) => r.marked);
  assert.equal(marked.length, 1);
  assert.equal(reads.get(1800).kind, 'longClose');
  assert.ok(reads.get(1800).score > 20);
});

for (const [name, fn] of tests) {
  try {
    await fn();
    console.log('  ok   ' + name);
    pass++;
  } catch (e) {
    console.log('  FAIL ' + name + '\n       ' + e.message);
    fail++;
  }
}
console.log(`${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
