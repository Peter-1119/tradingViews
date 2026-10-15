import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { FootprintCollector } from '../renderer/datafeed/footprint-collector.js';
import { FootprintBook, binRows, rowStep, formatQty } from '../renderer/footprint.js';

const require = createRequire(import.meta.url);
const store = require('../main/footprint-store.js');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'footprint-'));
store._setRoot(DIR);

let pass = 0, fail = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const near = (a, b, msg, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${msg || ''} expected ${b}, got ${a}`);

const T0 = 1_760_000_040; // a minute boundary, seconds
const rec = (t, keys, sell, buy, extra = {}) => ({
  t, scale: 10, qscale: 1000, keys: Float64Array.from(keys), sell: Float64Array.from(sell), buy: Float64Array.from(buy),
  firstId: 100, lastId: 200, complete: true, closed: true, ...extra,
});

/* --------------------------------------------------------------- store */

t('store: a minute round-trips exactly, ids and all', () => {
  const r = rec(T0, [834120, 834121, 834125], [0.001, 1.234, 0], [12.5, 0, 0.003]);
  store.write('BTCUSDT', [r], 'perp', T0 + 60);
  const [back] = store.read('BTCUSDT', T0, T0 + 60, 'perp');
  assert.deepEqual([...back.keys], [...r.keys]);
  assert.deepEqual([...back.sell], [...r.sell]);
  assert.deepEqual([...back.buy], [...r.buy]);
  assert.equal(back.firstId, 100);
  assert.equal(back.lastId, 200);
  assert.equal(back.scale, 10);
  assert.equal(back.complete, true);
});

t('store: spot and perp do not share a file; a rewrite of a minute reads back as the last one', () => {
  store.write('ETHUSDT', [rec(T0, [1], [1], [1])], 'spot', T0 + 60);
  store.write('ETHUSDT', [rec(T0, [1], [2], [2])], 'spot', T0 + 60);
  assert.equal(store.read('ETHUSDT', 0, Infinity, 'perp').length, 0);
  const back = store.read('ETHUSDT', 0, Infinity, 'spot');
  assert.equal(back.length, 1);
  assert.equal(back[0].sell[0], 2);
});

t('store: a torn last append loses only that minute, and the file is repaired', () => {
  const sym = 'TORNUSDT';
  store.write(sym, [rec(T0, [1], [1], [1]), rec(T0 + 60, [2], [2], [2])], 'perp', T0 + 120);
  const file = path.join(DIR, '_perp', sym, `${Math.floor(T0 / 3600) * 3600}.fp`);
  const whole = fs.readFileSync(file);
  fs.appendFileSync(file, store.encode(rec(T0 + 120, [3], [3], [3])).subarray(0, 15));
  assert.equal(store.read(sym, 0, Infinity, 'perp').length, 2);
  assert.deepEqual(fs.readFileSync(file).length <= whole.length + 5, true, 'rewritten without the torn tail');
  store.write(sym, [rec(T0 + 180, [4], [4], [4])], 'perp', T0 + 240);
  assert.deepEqual(store.read(sym, 0, Infinity, 'perp').map((r) => r.t), [T0, T0 + 60, T0 + 180]);
});

t('store: only the retention window is kept', () => {
  const sym = 'OLDUSDT';
  const now = T0 + 20 * 3600;
  store.write(sym, [rec(T0, [1], [1], [1])], 'perp', T0 + 60);
  store.write(sym, [rec(now - 60, [1], [1], [1])], 'perp', now);
  assert.deepEqual(store.read(sym, 0, Infinity, 'perp').map((r) => r.t), [now - 60]);
});

t('store: a BTC-sized minute is a few KB, a fraction of float64 records', () => {
  const n = 1270;
  const keys = [], sell = [], buy = [];
  for (let i = 0; i < n; i++) { keys.push(834000 + i); sell.push(((i * 7919) % 500) / 1000); buy.push(((i * 104729) % 900) / 1000); }
  const size = store.encode(rec(T0, keys, sell, buy)).length;
  assert.ok(size < (n * 20) / 5, `${size} bytes`);
});

/* ----------------------------------------------------------- collector */

function fakeClock(start) {
  let now = start;
  return { now: () => now, set: (v) => (now = v) };
}

function collector(extra = {}) {
  const updates = [];
  const written = [];
  const c = new FootprintCollector({
    symbol: 'BTCUSDT',
    rest: 'https://x',
    store: { read: async () => [], write: async (r) => written.push(...r) },
    onUpdate: (r) => updates.push(...r),
    fetchFn: async () => { throw new Error('no network in tests'); },
    logger: { log() {}, warn() {}, error() {} },
    pace: { gapMs: 0, ceiling: 1e9 },
    ...extra,
  });
  return { c, updates, written };
}

const trade = (a, sec, p, q, m) => ({ a, T: sec * 1000, p, q, m });

t('collector: sorts taker sides by price, and the first minute it joined is not complete', async () => {
  const clock = fakeClock((T0 + 90) * 1000);
  const { c } = collector({ now: clock.now });
  c.trade(trade(10, T0 + 1, '83412.10', '0.010', false));
  c.trade(trade(11, T0 + 2, '83412.10', '0.020', true));
  c.trade(trade(12, T0 + 3, '83412.20', '0.005', false));
  const [m] = c.snapshot(0);
  assert.equal(m.scale, 10);
  assert.deepEqual([...m.keys], [834121, 834122]);
  near(m.sell[0], 0.02);
  near(m.buy[0], 0.01);
  near(m.buy[1], 0.005);
  assert.equal(m.complete, false, 'joined mid-minute');
  assert.equal(m.closed, false);
  c.stop();
});

t('collector: a minute seen whole closes complete and is written; a gap makes the next one incomplete', async () => {
  const clock = fakeClock((T0 + 200) * 1000);
  const { c, written } = collector({ now: clock.now });
  c.trade(trade(10, T0 + 50, '100.0', '1', false)); // joins in minute 0
  c.trade(trade(11, T0 + 61, '100.0', '1', true)); // minute 1 begins, contiguous
  c.trade(trade(12, T0 + 125, '101.0', '1', false)); // minute 2 begins: minute 1 closes complete
  assert.deepEqual(written.map((r) => r.t), [T0 + 60]);
  c.trade(trade(20, T0 + 130, '101.0', '1', false)); // ids 13-19 missed
  c.trade(trade(21, T0 + 185, '101.0', '1', false)); // minute 3 begins
  const m2 = c.snapshot(0).find((r) => r.t === T0 + 120);
  assert.equal(m2.complete, false);
  assert.equal(m2.closed, true);
  assert.deepEqual(written.map((r) => r.t), [T0 + 60], 'the broken minute is not written');
  c.stop();
});

t('collector: a quiet minute between two contiguous trades is empty and complete', async () => {
  const clock = fakeClock((T0 + 300) * 1000);
  const { c, written } = collector({ now: clock.now });
  c.trade(trade(10, T0 + 59, '1.0', '1', false));
  c.trade(trade(11, T0 + 61, '1.0', '1', false)); // minute 1, contiguous
  c.trade(trade(12, T0 + 185, '1.0', '1', false)); // skips minute 2
  assert.deepEqual(written.map((r) => [r.t, r.keys.length]), [[T0 + 60, 1], [T0 + 120, 0]]);
  c.stop();
});

t('collector: a finer price later re-keys what is held', async () => {
  const clock = fakeClock((T0 + 30) * 1000);
  const { c } = collector({ now: clock.now });
  c.trade(trade(1, T0 + 1, '89000.1', '1', false));
  c.trade(trade(2, T0 + 2, '89000.12', '1', false));
  const [m] = c.snapshot(0);
  assert.equal(m.scale, 100);
  assert.deepEqual([...m.keys], [8900010, 8900012]);
  c.stop();
});

t('collector: missing minutes are fetched from REST newest first, paged by id, and replace partial ones', async () => {
  const clock = fakeClock((T0 + 125) * 1000);
  const asked = [];
  // Two pages for minute 1 (limit 1000 -> page again by fromId), one for minute 0.
  const fetchFn = async (url) => {
    asked.push(url.replace('https://x/aggTrades?symbol=BTCUSDT&', '').replace('&limit=1000', ''));
    const u = new URL(url);
    const start = Number(u.searchParams.get('startTime'));
    const fromId = Number(u.searchParams.get('fromId'));
    let rows;
    if (start === (T0 + 60) * 1000) rows = Array.from({ length: 1000 }, (_, i) => ({ a: 5000 + i, T: start + 10, p: '50.0', q: '1', m: false }));
    else if (fromId === 6000) rows = [{ a: 6000, T: (T0 + 60) * 1000 + 20, p: '50.5', q: '2', m: true }, { a: 6001, T: (T0 + 120) * 1000 + 1, p: '51.0', q: '1', m: true }];
    else rows = [{ a: 4000, T: T0 * 1000 + 5, p: '49.0', q: '3', m: true }];
    return { ok: true, status: 200, headers: { get: () => '10' }, json: async () => rows };
  };
  const { c, written } = collector({ now: clock.now, fetchFn });
  await c.want(T0);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(asked, [
    `startTime=${(T0 + 60) * 1000}&endTime=${(T0 + 60) * 1000 + 59999}`,
    'fromId=6000',
    `startTime=${T0 * 1000}&endTime=${T0 * 1000 + 59999}`,
  ]);
  const m1 = c.snapshot(0).find((r) => r.t === T0 + 60);
  assert.deepEqual([...m1.keys], [500, 505]);
  near(m1.buy[0], 1000);
  near(m1.sell[1], 2);
  assert.equal(m1.complete, true);
  assert.deepEqual(written.map((r) => r.t).sort(), [T0, T0 + 60]);
  c.stop();
});

t('collector: a 429 pauses instead of hammering', async () => {
  const clock = fakeClock((T0 + 125) * 1000);
  let calls = 0;
  const fetchFn = async () => { calls++; return { ok: false, status: 429, headers: { get: (h) => (h === 'retry-after' ? '30' : null) }, json: async () => [] }; };
  const { c } = collector({ now: clock.now, fetchFn });
  await c.want(T0);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 1);
  assert.ok(c.pausedUntil >= (T0 + 125) * 1000 + 30_000);
  c.stop();
});

/* ---------------------------------------------------------------- book */

t('book: a 5m bar sums its minutes at one scale and knows when it is incomplete', () => {
  const book = new FootprintBook();
  book.setInterval(300);
  const bar = Math.floor(T0 / 300) * 300;
  book.put([
    rec(bar, [10, 11], [1, 2], [3, 4]),
    { ...rec(bar + 60, [101, 110], [1, 1], [1, 1]), scale: 100 }, // 1.01, 1.10
  ]);
  const forming = book.bar(bar, bar + 125);
  assert.equal(forming.complete, true, 'minutes still to come are not missing');
  const fp = book.bar(bar, bar + 1000);
  assert.equal(fp.scale, 100);
  assert.deepEqual([...fp.keys], [100, 101, 110]);
  near(fp.sell[0], 1);
  near(fp.sell[2], 3, '1.1 from both minutes');
  near(fp.delta, 9 - 5);
  assert.equal(fp.complete, false, 'three minutes missing');
});

t('book: a changed minute invalidates its bar', () => {
  const book = new FootprintBook();
  book.setInterval(300);
  const bar = Math.floor(T0 / 300) * 300;
  book.put([0, 1, 2, 3, 4].map((i) => rec(bar + i * 60, [10], [1], [1])));
  near(book.bar(bar, bar + 1000).sellTotal, 5);
  book.put([rec(bar + 60, [10], [9], [1])]);
  near(book.bar(bar, bar + 1000).sellTotal, 13);
});

t('rows: merged on round edges, highest first, with POC and diagonal imbalances', () => {
  // scale 10: keys are tenths. Rows of 1.0 (step 10).
  const fp = { scale: 10, keys: Float64Array.from([995, 1000, 1004, 1012, 1021]), sell: Float64Array.from([4, 1, 1, 9, 1]), buy: Float64Array.from([1, 10, 20, 2, 1]) };
  const { rows, poc } = binRows(fp, 10, 3);
  assert.deepEqual(rows.map((r) => r.key), [1020, 1010, 1000, 990]);
  assert.equal(rows[2].buy, 30);
  assert.equal(poc.key, 1000);
  near(rows[2].low, 100);
  near(rows[2].high, 101);
  assert.equal(rows[2].buyImb, true, '30 bought at 100 vs 4 sold at 99');
  assert.equal(rows[1].sellImb, true, '9 sold at 101 vs 1 bought at 102');
  assert.equal(rows[0].buyImb, false, '1 vs 9 below');
  assert.equal(rows[3].sellImb, false, '4 sold vs 30 bought above');
  assert.equal(rows[3].buyImb, false, 'nothing below: no imbalance against zero');
});

t('row step: 1-2-5 of a power of ten, at least the height asked for', () => {
  assert.equal(rowStep(0.05, 10), 1);
  assert.equal(rowStep(0.13, 10), 2);
  assert.equal(rowStep(0.3, 10), 5);
  assert.equal(rowStep(0.7, 10), 10);
  assert.equal(rowStep(4.2, 10), 50);
  assert.equal(rowStep(4.2, 100), 500);
});

t('quantities print short', () => {
  assert.equal(formatQty(0), '0');
  assert.equal(formatQty(0.0123), '0.012');
  assert.equal(formatQty(4.5), '4.5');
  assert.equal(formatQty(78.94), '78.9');
  assert.equal(formatQty(123.4), '123');
  assert.equal(formatQty(1234), '1.23K');
  assert.equal(formatQty(45600), '45.6K');
  assert.equal(formatQty(-1200000), '-1.2M');
});

for (const [name, fn] of tests) {
  try {
    await fn();
    console.log('  ok   ' + name);
    pass++;
  } catch (e) {
    console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n       '));
    fail++;
  }
}
fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
