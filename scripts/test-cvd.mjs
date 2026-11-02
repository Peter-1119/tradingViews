// Cumulative volume delta (renderer/cvd.js).
import assert from 'node:assert/strict';
import { barDelta, cvdValues, CvdTrack } from '../renderer/cvd.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); console.log('  ok   ' + name); pass++; } catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; } };
const near = (a, b) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));

// Bars of 1h across three UTC days, with a seeded mix of buying and selling.
function bars(n, start = 86400 * 100 - 3 * 3600) {
  let s = 7;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  return Array.from({ length: n }, (_, i) => {
    const volume = 100 + r() * 50;
    const close = 2 + r();
    return { time: start + i * 3600, close, volume, buyVolume: volume * r(), quoteVolume: volume * close };
  });
}

t('a bar: 2·buy − volume, at its average price', () => {
  assert.equal(barDelta({ volume: 10, buyVolume: 7, quoteVolume: 20, close: 3 }), (14 - 10) * 2);
  // No quote volume: the close stands in.
  assert.equal(barDelta({ volume: 10, buyVolume: 2, close: 3 }), (4 - 10) * 3);
  assert.ok(Number.isNaN(barDelta({ volume: 10, close: 3 })));
});

t('summed from the first bar; a bar with no split adds nothing', () => {
  const b = [
    { time: 0, volume: 10, buyVolume: 7, quoteVolume: 10, close: 1 },
    { time: 60, volume: 10, close: 1 },
    { time: 120, volume: 4, buyVolume: 1, quoteVolume: 4, close: 1 },
  ];
  assert.deepEqual(cvdValues(b), [4, 4, 2]);
});

t('the daily anchor starts over at each UTC midnight', () => {
  const b = bars(60);
  const v = cvdValues(b, 'day');
  for (let i = 0; i < b.length; i++) {
    const day = Math.floor(b[i].time / 86400);
    let sum = 0;
    for (let j = 0; j <= i; j++) if (Math.floor(b[j].time / 86400) === day) sum += barDelta(b[j]);
    assert.ok(near(v[i], sum), `bar ${i}`);
  }
  // The first bar of a day is its own delta.
  const first = b.findIndex((x) => x.time % 86400 === 0);
  assert.ok(near(v[first], barDelta(b[first])));
});

for (const anchor of ['none', 'day']) {
  t(`live ticks match a full recompute, across new bars and days (${anchor})`, () => {
    const all = bars(60);
    const shown = all.slice(0, 10);
    const track = new CvdTrack(anchor);
    track.compute(shown);
    for (let i = 10; i < all.length; i++) {
      // The new bar opens small and grows tick by tick.
      const full = all[i];
      for (const share of [0.1, 0.5, 1]) {
        const tick = { ...full, volume: full.volume * share, buyVolume: full.buyVolume * share, quoteVolume: full.quoteVolume * share };
        if (share === 0.1) shown.push(tick);
        else shown[shown.length - 1] = tick;
        const live = track.next(shown);
        const ref = cvdValues(shown, anchor);
        assert.ok(near(live, ref[ref.length - 1]), `bar ${i} at ${share}: ${live} vs ${ref[ref.length - 1]}`);
      }
    }
  });
}

console.log(`${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
