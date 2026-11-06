/**
 * Long/short pane: bars to readings, period choice, and the provider's merge
 * of the two statistics. Run: node scripts/test-long-short.mjs
 */
import assert from 'node:assert/strict';
import { lsPeriodFor, bucketLongShort, mergeSamples, longShare, crowdContext, bucketContext, CONTEXT } from '../renderer/long-short.js';

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

const H = 3600;
const sample = (sec, accounts, top = null) => ({ time: sec * 1000, accounts, top });

console.log('long/short');

await test('period: the coarsest one no longer than a bar, 5m under that', () => {
  assert.equal(lsPeriodFor(60).name, '5m');
  assert.equal(lsPeriodFor(180).name, '5m');
  assert.equal(lsPeriodFor(300).name, '5m');
  assert.equal(lsPeriodFor(900).name, '15m');
  assert.equal(lsPeriodFor(H).name, '1h');
  assert.equal(lsPeriodFor(8 * H).name, '6h');
  assert.equal(lsPeriodFor(24 * H).name, '1d');
  assert.equal(lsPeriodFor(7 * 24 * H).name, '1d');
});

await test('an hourly bar reads the sample at its close, not its open', () => {
  const samples = [sample(0, 1.0), sample(H, 1.5), sample(2 * H, 2.0)];
  const out = bucketLongShort(samples, [0, H], H, H);
  assert.deepEqual(out.map((r) => [r.time, r.accounts]), [[0, 1.5], [H, 2.0]]);
});

await test('the forming bar shows the newest 5m sample inside it', () => {
  const samples = [sample(H, 1.5), sample(H + 900, 1.7), sample(H + 1200, 1.8)];
  const out = bucketLongShort(samples, [0, H], H, H);
  assert.deepEqual(out.map((r) => [r.time, r.accounts]), [[0, 1.5], [H, 1.8]]);
});

await test('a bar with no sample of its own is left out, not carried', () => {
  // Nothing between 1h and 3h: the 1h bar has no reading.
  const samples = [sample(H, 1.5), sample(3 * H, 2.5)];
  const out = bucketLongShort(samples, [0, H, 2 * H], H, H);
  assert.deepEqual(out.map((r) => r.time), [0, 2 * H]);
});

await test('1m bars carry a 5m sample until the next is due', () => {
  const times = Array.from({ length: 12 }, (_, i) => i * 60);
  const out = bucketLongShort([sample(0, 1.1), sample(300, 1.2)], times, 60, 300);
  // 0..4 read the 00:00 sample, 5..9 the 05:00 one; 10 and 11 are past one period.
  assert.deepEqual(out.map((r) => r.accounts), [1.1, 1.1, 1.1, 1.1, 1.2, 1.2, 1.2, 1.2, 1.2, 1.2]);
  assert.deepEqual(out.map((r) => r.time), [0, 60, 120, 180, 240, 300, 360, 420, 480, 540]);
});

await test('top traders ride along, null where the statistic had no row', () => {
  const out = bucketLongShort([sample(H, 2.9, 2.1), sample(2 * H, 3.0)], [0, H], H, H);
  assert.deepEqual(out.map((r) => r.top), [2.1, null]);
});

await test('merge keeps one row per timestamp, the newer list winning', () => {
  const merged = mergeSamples([sample(0, 1), sample(H, 2)], [sample(H, 2.5), sample(2 * H, 3)]);
  assert.deepEqual(merged.map((r) => [r.time / 1000, r.accounts]), [[0, 1], [H, 2.5], [2 * H, 3]]);
});

/* ------------------------------------------- provider: both statistics */

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = { addEventListener() {}, removeEventListener() {} };
Object.defineProperty(globalThis, 'navigator', {
  value: { onLine: true, language: 'en-US' },
  configurable: true,
  writable: true,
});
const { BinanceProvider } = await import('../renderer/datafeed/binance.js');

await test('provider: account and top-trader rows joined by timestamp, paged backwards', async () => {
  const asked = [];
  const now = Date.now();
  const step = 3_600_000;
  const rowsFor = (path, start, end, limit) => {
    const all = [];
    for (let t = Math.ceil(start / step) * step; t <= end; t += step) {
      all.push({ timestamp: t, longShortRatio: path.startsWith('global') ? '2.5' : '1.5' });
    }
    return all.slice(-limit);
  };
  const provider = new BinanceProvider({ market: 'perp', logger: { info() {}, warn() {}, error() {} } });
  provider.fetchJson = async (path) => {
    const url = new URL(path, 'https://x/');
    asked.push(url.pathname);
    const p = url.searchParams;
    return rowsFor(url.pathname.slice(1), Number(p.get('startTime')), Number(p.get('endTime')), Number(p.get('limit')));
  };
  const rows = await provider.getLongShortHist('BTCUSDT', '1h', now - 25 * 24 * step, now);
  // 600 hourly rows: two pages per statistic.
  assert.ok(rows.length >= 599 && rows.length <= 601, String(rows.length));
  assert.equal(asked.filter((p) => p === '/globalLongShortAccountRatio').length, 2);
  assert.equal(asked.filter((p) => p === '/topLongShortPositionRatio').length, 2);
  assert.ok(rows.every((r, i) => !i || r.time > rows[i - 1].time), 'oldest first, no repeats');
  assert.deepEqual([rows[0].accounts, rows[0].top], [2.5, 1.5]);
});

await test('provider: a start past 30 days back is clamped, not sent', async () => {
  let start = null;
  const provider = new BinanceProvider({ market: 'perp', logger: { info() {}, warn() {}, error() {} } });
  provider.fetchJson = async (path) => {
    start = Number(new URL(path, 'https://x/').searchParams.get('startTime'));
    return [];
  };
  await provider.getLongShortHist('BTCUSDT', '1d', Date.now() - 90 * 86_400_000, Date.now());
  assert.ok(start > Date.now() - 30 * 86_400_000, 'start within the 30 days kept');
});

await test('provider: spot has no statistics and asks for none', async () => {
  const provider = new BinanceProvider({ market: 'spot', logger: { info() {}, warn() {}, error() {} } });
  provider.fetchJson = async () => {
    throw new Error('must not be called');
  };
  assert.deepEqual(await provider.getLongShortHist('BTCUSDT', '1h', 0, Date.now()), []);
});

console.log('crowd in context');

/** Hourly samples and bars over `hours`, from a share-long and a price function of the hour. */
function hourly(hours, shareAt, priceAt) {
  const samples = [];
  const bars = [];
  for (let h = 0; h < hours; h++) {
    const share = shareAt(h);
    samples.push({ time: (h + 1) * H * 1000, accounts: share / (100 - share) });
    bars.push({ time: h * H, close: priceAt(h) });
  }
  return { samples, bars };
}

await test('share long: 3 is 75%, 1 is 50%, nonsense is NaN', () => {
  assert.equal(longShare(3), 75);
  assert.equal(longShare(1), 50);
  assert.ok(Math.abs(longShare(4) - 80) < 1e-9);
  assert.ok(Number.isNaN(longShare(0)));
  assert.ok(Number.isNaN(longShare('x')));
});

await test('baseline: the median of the week before, with a band; none on too little history', () => {
  const { samples, bars } = hourly(300, (h) => 60 + (h % 2 ? 2 : -2), () => 100);
  const ctx = crowdContext(samples, bars);
  assert.equal(ctx[10].base, null, 'ten hours in is too early');
  const late = ctx[ctx.length - 1];
  assert.ok(Math.abs(late.base - 60) < 1e-9, `base ${late.base}`);
  assert.ok(late.lo < 60 && late.hi > 60 && Math.abs(late.hi - 60 - (60 - late.lo)) < 1e-9);
});

await test('residual: near zero when the crowd only mirrors the price', () => {
  // The share long moves against the price, exactly linearly, plus a little noise.
  const price = (h) => 100 * (1 + 0.05 * Math.sin(h / 17));
  const share = (h) => 65 - 2.5 * (price(h) - 100) + 0.3 * Math.sin(h * 1.7);
  const { samples, bars } = hourly(600, share, price);
  const ctx = crowdContext(samples, bars).filter((c) => c.z !== null);
  assert.ok(ctx.length > 100, `${ctx.length} fitted hours`);
  const worst = Math.max(...ctx.map((c) => Math.abs(c.z)));
  assert.ok(worst < 3, `worst |z| ${worst.toFixed(2)}`);
});

await test('residual: a crowd far longer than the price explains stands out', () => {
  const price = (h) => 100 * (1 + 0.05 * Math.sin(h / 17));
  const base = (h) => 65 - 2.5 * (price(h) - 100) + 0.3 * Math.sin(h * 1.7);
  const share = (h) => base(h) + (h >= 560 ? 6 : 0);
  const { samples, bars } = hourly(600, share, price);
  const ctx = crowdContext(samples, bars);
  const at = ctx.find((c) => c.time === 570 * H);
  assert.ok(at.z > 4, `z ${at.z}`);
  const before = ctx.find((c) => c.time === 540 * H);
  assert.ok(Math.abs(before.z) < 3, `z before ${before.z}`);
});

await test('no look-ahead: changing later hours leaves earlier figures alone', () => {
  const price = (h) => 100 + Math.sin(h / 9) * 3;
  const share = (h) => 64 + Math.cos(h / 13) * 4;
  const a = hourly(500, share, price);
  const b = hourly(500, (h) => (h > 450 ? 90 : share(h)), (h) => (h > 450 ? 500 : price(h)));
  const ca = crowdContext(a.samples, a.bars);
  const cb = crowdContext(b.samples, b.bars);
  for (let i = 0; i < ca.length && ca[i].time <= 451 * H; i++) assert.deepEqual(cb[i], ca[i]);
});

await test('rows with no price, or an hour missing for the 24h change, are skipped, not invented', () => {
  const { samples, bars } = hourly(450, (h) => 60 + (h % 5), (h) => 100 + h * 0.01);
  const gappy = bars.filter((b) => b.time !== 380 * H);
  const ctx = crowdContext(samples, gappy);
  assert.equal(ctx.find((c) => c.time === 381 * H), undefined, 'no price, no row');
  const after = ctx.find((c) => c.time === 381 * H + 24 * H);
  assert.equal(after.z, null, 'its 24h change has no start');
});

await test('context to bars: an hour carried across 1m bars, not past the hour', () => {
  const ctx = [{ time: 10 * H, z: 1 }, { time: 11 * H, z: 2 }];
  const times = [10 * H, 10 * H + 1800, 11 * H - 60, 11 * H, 12 * H + 60];
  const out = bucketContext(ctx, times, 60);
  assert.equal(out.get(10 * H).z, 1);
  assert.equal(out.get(11 * H - 60).z, 2, 'the 11:00 reading closes the 10:59 bar');
  assert.equal(out.get(11 * H).z, 2);
  assert.equal(out.has(12 * H + 60), false, 'older than an hour');
});

await test('context to bars: an hourly bar reads the point at its close', () => {
  const ctx = [{ time: 10 * H, z: 1 }, { time: 11 * H, z: 2 }];
  const out = bucketContext(ctx, [9 * H, 10 * H], H);
  assert.equal(out.get(9 * H).z, 1);
  assert.equal(out.get(10 * H).z, 2);
  assert.equal(CONTEXT.baseHours, 168);
});

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
