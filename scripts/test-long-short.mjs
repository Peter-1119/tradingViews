/**
 * Long/short pane: bars to readings, period choice, and the provider's merge
 * of the two statistics. Run: node scripts/test-long-short.mjs
 */
import assert from 'node:assert/strict';
import { lsPeriodFor, bucketLongShort, mergeSamples } from '../renderer/long-short.js';

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

console.log('');
console.log(`${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
