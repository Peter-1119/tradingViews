// RSI and MACD (renderer/indicators.js).
import assert from 'node:assert/strict';
import { Rsi, Macd, Track } from '../renderer/indicators.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); console.log('  ok   ' + name); pass++; } catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; } };

function walk(n, seed = 3) {
  let s = seed >>> 0;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const out = new Float64Array(n);
  let p = 100;
  for (let i = 0; i < n; i++) out[i] = p *= 1 + (r() - 0.5) * 0.01;
  return out;
}
const close = (arr) => Array.from(arr, (c, i) => ({ time: i * 60, close: c }));
const near = (a, b, tol = 1e-9) => (Number.isNaN(a) ? Number.isNaN(b) : Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)));

// The textbook definitions, array by array, as TradingView writes them.
function refEma(x, n, alpha) {
  const y = new Array(x.length).fill(NaN);
  let start = x.findIndex((v) => !Number.isNaN(v));
  if (start < 0 || start + n > x.length) return y;
  let sum = 0;
  for (let i = start; i < start + n; i++) sum += x[i];
  y[start + n - 1] = sum / n;
  for (let i = start + n; i < x.length; i++) y[i] = alpha * x[i] + (1 - alpha) * y[i - 1];
  return y;
}
function refRsi(c, n) {
  const up = [NaN], down = [NaN];
  for (let i = 1; i < c.length; i++) {
    up.push(Math.max(c[i] - c[i - 1], 0));
    down.push(Math.max(c[i - 1] - c[i], 0));
  }
  const u = refEma(up, n, 1 / n), d = refEma(down, n, 1 / n);
  return u.map((v, i) => (Number.isNaN(v) ? NaN : d[i] === 0 ? (v === 0 ? 50 : 100) : 100 - 100 / (1 + v / d[i])));
}

t('RSI matches the textbook Wilder definition, warm-up included', () => {
  const c = Array.from(walk(500));
  const ref = refRsi(c, 14);
  const rsi = new Rsi(14);
  c.forEach((v, i) => assert.ok(near(rsi.push(v), ref[i]), `bar ${i}`));
  assert.ok(Number.isNaN(ref[13]) && !Number.isNaN(ref[14]), 'first value at bar n');
});

t('MACD matches EMA(12) - EMA(26) and its EMA(9)', () => {
  const c = Array.from(walk(500));
  const f = refEma(c, 12, 2 / 13), s = refEma(c, 26, 2 / 27);
  const m = c.map((_, i) => f[i] - s[i]);
  const sig = refEma(m, 9, 2 / 10);
  const macd = new Macd();
  c.forEach((v, i) => {
    const p = macd.push(v);
    assert.ok(near(p.macd, m[i]), `macd ${i}`);
    assert.ok(near(p.signal, sig[i]), `signal ${i}`);
  });
});

t('live updates equal a full recompute, tick by tick and across new bars', () => {
  const c = walk(400);
  const bars = close(c.subarray(0, 300));
  for (const make of [() => new Rsi(14), () => new Macd()]) {
    const live = new Track(make);
    live.compute(bars);
    const grown = bars.slice();
    for (let i = 300; i < 400; i++) {
      // Three ticks into each bar, then the next bar opens.
      for (const k of [0.998, 1.003, 1]) {
        const isNew = grown[grown.length - 1].time < i * 60;
        if (isNew) grown.push({ time: i * 60, close: c[i] * k });
        else grown[grown.length - 1] = { time: i * 60, close: c[i] * k };
        const got = live.next(grown, isNew);
        const want = new Track(make).compute(grown).at(-1);
        const pick = (v) => (typeof v === 'number' ? [v] : [v.macd, v.signal, v.hist]);
        pick(got).forEach((g, j) => assert.ok(near(g, pick(want)[j]), `bar ${i}`));
      }
    }
  }
});

t('flat prices: RSI 50, MACD 0', () => {
  const rsi = new Track(() => new Rsi(14)).compute(close(new Array(50).fill(10)));
  assert.equal(rsi.at(-1), 50);
  const macd = new Track(() => new Macd()).compute(close(new Array(60).fill(10)));
  assert.equal(macd.at(-1).macd, 0);
  assert.equal(macd.at(-1).hist, 0);
});

t('a million closes, both indicators, in well under a second', () => {
  const c = walk(1_000_000);
  const t0 = performance.now();
  const rsi = new Rsi(14), macd = new Macd();
  let sink = 0;
  for (let i = 0; i < c.length; i++) {
    const v = rsi.push(c[i]) + macd.push(c[i]).hist;
    if (v === v) sink += v; // skip the warm-up NaNs
  }
  const ms = performance.now() - t0;
  console.log(`       1,000,000 closes: RSI + MACD in ${ms.toFixed(1)} ms`);
  assert.ok(Number.isFinite(sink) && ms < 1000, `${ms} ms`);
});

console.log(`${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
