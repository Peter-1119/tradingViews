import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Stub electron: bar-store only wants app.getPath.
require.cache[require.resolve('electron')] = { exports: { app: { getPath: () => os.tmpdir() } } };
const store = require('../main/bar-store.js');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'barstore-'));
store._setRoot(DIR);

const bar = (t, v = 1) => ({ time: t, open: 100, high: 101, low: 99, close: 100.5, volume: v, closed: true });
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); console.log('  ok   ' + name); pass++; } catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; } };

const SEP = Date.UTC(2026, 8, 1) / 1000; // 2026-09-01 UTC

t('round-trips exactly, including volume', () => {
  const bars = [bar(SEP, 1.23456), bar(SEP + 60, 2.5), bar(SEP + 120, 0.00001234)];
  store.write('BTCUSDT', '1m', bars);
  const back = store.read('BTCUSDT', '1m', 0, 1e12);
  assert.equal(back.length, 3);
  assert.deepEqual(back.map((b) => b.time), bars.map((b) => b.time));
  assert.equal(back[0].volume, 1.23456);
  assert.equal(back[2].volume, 0.00001234);
  assert.equal(back[1].close, 100.5);
});

t('unclosed bars are never persisted', () => {
  const n = store.read('BTCUSDT', '1m', 0, 1e12).length;
  store.write('BTCUSDT', '1m', [{ ...bar(SEP + 180), closed: false }]);
  assert.equal(store.read('BTCUSDT', '1m', 0, 1e12).length, n, 'a forming candle must not reach disk');
});

t('1m splits by month, 1h by year', () => {
  const oct = Date.UTC(2026, 9, 5) / 1000;
  store.write('BTCUSDT', '1m', [bar(oct)]);
  assert.deepEqual(store.chunkKeys('BTCUSDT', '1m'), ['2026-09', '2026-10']);
  store.write('BTCUSDT', '1h', [bar(SEP), bar(oct)]);
  assert.deepEqual(store.chunkKeys('BTCUSDT', '1h'), ['2026']);
});

t('newer bars append; re-writing the same bars does not duplicate', () => {
  const base = Date.UTC(2026, 10, 1) / 1000;
  const first = [bar(base), bar(base + 60), bar(base + 120)];
  store.write('ETHUSDT', '1m', first);
  store.write('ETHUSDT', '1m', [bar(base + 180)]);          // append path
  store.write('ETHUSDT', '1m', first);                       // overlap path
  const back = store.read('ETHUSDT', '1m', 0, 1e12);
  assert.equal(back.length, 4, 'expected 4 distinct bars, got ' + back.length);
  assert.deepEqual(back.map((b) => b.time), [base, base + 60, base + 120, base + 180]);
});

t('backfill into an older chunk keeps everything sorted', () => {
  const aug = Date.UTC(2026, 7, 20) / 1000;
  store.write('BTCUSDT', '1m', [bar(aug + 60), bar(aug)]);   // deliberately out of order
  const back = store.read('BTCUSDT', '1m', 0, 1e12);
  const times = back.map((b) => b.time);
  assert.deepEqual(times, [...times].sort((a, b) => a - b), 'read must come back ascending');
  assert.equal(times[0], aug);
});

t('range filter and latest()', () => {
  const back = store.read('BTCUSDT', '1m', SEP, SEP + 60);
  assert.equal(back.length, 2);
  assert.equal(store.latest('BTCUSDT', '1m'), Date.UTC(2026, 9, 5) / 1000);
});

t('a truncated file yields whole bars, not garbage', () => {
  const f = path.join(DIR, 'BTCUSDT', '1m', '2026-09.bin');
  fs.appendFileSync(f, Buffer.alloc(17)); // half a record
  const back = store.read('BTCUSDT', '1m', 0, 1e12);
  assert.ok(back.every((b) => Number.isFinite(b.time) && b.time > 0), 'no partial record should surface');
});

t('perp bars live apart from spot bars of the same name', () => {
  const t0 = Date.UTC(2026, 11, 1) / 1000;
  store.write('SOLUSDT', '1m', [bar(t0, 5)]);
  store.write('SOLUSDT', '1m', [bar(t0, 7), bar(t0 + 60, 7)], 'perp');
  assert.equal(store.read('SOLUSDT', '1m', 0, 1e12).length, 1, 'spot must not see perp bars');
  const perp = store.read('SOLUSDT', '1m', 0, 1e12, 'perp');
  assert.equal(perp.length, 2);
  assert.equal(perp[0].volume, 7);
  assert.equal(store.latest('SOLUSDT', '1m', 'perp'), t0 + 60);
  assert.ok(fs.existsSync(path.join(DIR, 'SOLUSDT', '1m')), 'spot keeps the original layout');
});

t('stats and clear', () => {
  const s = store.stats();
  assert.ok(s.files >= 3 && s.bytes > 0, JSON.stringify(s));
  store.clear('ETHUSDT');
  assert.equal(store.read('ETHUSDT', '1m', 0, 1e12).length, 0);
  assert.ok(store.stats().files >= 1, 'clearing one symbol must not wipe the rest');
});

t('path traversal in a symbol name is neutralised', () => {
  store.write('../../evil', '1m', [bar(SEP)]);
  assert.ok(!fs.existsSync(path.join(DIR, '..', '..', 'evil')), 'must not escape the cache root');
});

console.log(`\n${pass}/${pass + fail} passed`);
fs.rmSync(DIR, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
