// Thin-volume ranking (renderer/volume-stats.js).
import assert from 'node:assert/strict';
import { analyzeVolume, liveRank, squeezeRuns, volumeValue } from '../renderer/volume-stats.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); console.log('  ok   ' + name); pass++; } catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; } };

// A deterministic long-tailed volume series: log-normal from a seeded PRNG.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
function lognormal(n, { mu = 0, sigma = 0.8, seed = 7 } = {}) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const z = Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());
    out.push(Math.exp(mu + sigma * z));
  }
  return out;
}
const bars = (vols, price = 100) =>
  vols.map((v, i) => ({ time: i * 60, open: price, high: price, low: price, close: price, volume: v, quoteVolume: v * price, buyVolume: v / 2, closed: true }));

t('ranks match the empirical percentile of a steady series', () => {
  const vols = lognormal(3000);
  const res = analyzeVolume(bars(vols), { memory: 1000 });
  // Over the steady tail, about 5% of bars are thin at a 5% threshold.
  const tail = Array.from(res.level.subarray(1000)).filter((l) => l > 0).length / 2000;
  assert.ok(tail > 0.03 && tail < 0.07, `share thin ${tail}`);
  const sorted = vols.slice(0, 1000).sort((a, b) => a - b);
  const med = sorted[500];
  const one = analyzeVolume(bars([...vols.slice(0, 1000), med]), { memory: 1000 });
  assert.ok(Math.abs(one.rank[1000] - 0.5) < 0.06, `median ranks ${one.rank[1000]}`);
});

t('the first bar already ranks against a real distribution (seeded, not from zero)', () => {
  const vols = lognormal(1000);
  const res = analyzeVolume(bars(vols), { memory: 1000 });
  const sorted = [...vols].sort((a, b) => a - b);
  const expect = sorted.indexOf(vols[0]) / 1000;
  assert.ok(Math.abs(res.rank[0] - expect) < 0.05, `first ${res.rank[0]} vs ${expect}`);
});

t('a spike does not move the distribution, a lasting change moves it slowly', () => {
  const base = lognormal(1500);
  const spiked = [...base];
  spiked[1200] = 1e6; // one absurd bar
  const a = analyzeVolume(bars(base), { memory: 1000 });
  const b = analyzeVolume(bars(spiked), { memory: 1000 });
  assert.ok(Math.abs(a.line[1300] - b.line[1300]) / a.line[1300] < 0.01, 'one spike barely shifts the threshold');

  // Volume drops to a fifth for good: at first nearly every bar is thin, and
  // the filter takes hundreds of bars to call that normal.
  const shift = [...base.slice(0, 1000), ...lognormal(1500, { seed: 9 }).map((v) => v / 5)];
  const s = analyzeVolume(bars(shift), { memory: 1000 });
  const share = (from, to) => Array.from(s.level.subarray(from, to)).filter((l) => l > 0).length / (to - from);
  assert.ok(share(1000, 1100) > 0.35, `right after the drop ${share(1000, 1100)}`);
  assert.ok(share(2300, 2500) < share(1000, 1100) / 2, `adapted later ${share(2300, 2500)}`);
});

t('levels and streaks; runs of three or more come out whole', () => {
  const vols = [...lognormal(1000), 1e-6, 1e-6, 5, 1e-6, 1e-6, 1e-6, 1e-6];
  const res = analyzeVolume(bars(vols), { memory: 1000 });
  assert.equal(res.level[1000], 2, 'far below everything is very thin');
  assert.deepEqual(Array.from(res.streak.subarray(1000)), [1, 2, 0, 1, 2, 3, 4]);
  assert.deepEqual(squeezeRuns(res.streak).filter(([a]) => a >= 1000), [[1003, 1006]]);
});

t('the forming bar is not judged, and is projected once a quarter of it has gone', () => {
  const vols = lognormal(1001);
  const list = bars(vols);
  list[1000].closed = false;
  const res = analyzeVolume(list, { memory: 1000 });
  assert.ok(Number.isNaN(res.rank[1000]) && res.level[1000] === 0);
  const live = { ...list[1000], quoteVolume: 50, volume: 0.5 };
  assert.equal(liveRank(res.hist, live, live.time + 10, 60), null, 'too early to say');
  const half = liveRank(res.hist, live, live.time + 30, 60);
  assert.equal(half.projected, 100, 'half the bar gone: double what is there');
  assert.ok(half.rank >= 0 && half.rank <= 1);
});

t('quote volume where there is one, base volume at the close otherwise', () => {
  assert.equal(volumeValue({ volume: 2, close: 50, quoteVolume: 99 }), 99);
  assert.equal(volumeValue({ volume: 2, close: 50 }), 100);
});

t('the threshold line is in base units and sits under the thin bars', () => {
  const vols = lognormal(1500);
  const res = analyzeVolume(bars(vols, 250), { memory: 1000 });
  for (let i = 1000; i < 1500; i++) {
    if (res.level[i]) assert.ok(vols[i] <= res.line[i] * 1.0001, `bar ${i} thin but above its line`);
  }
});

console.log(`${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
