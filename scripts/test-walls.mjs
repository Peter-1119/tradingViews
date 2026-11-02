// Order-book walls (renderer/datafeed/order-book.js): keeping the book in
// sequence, finding walls, and telling a pulled wall from a filled one.
import assert from 'node:assert/strict';
import { OrderBook, WallTracker, bucketSide, scoreBuckets, niceStep } from '../renderer/datafeed/order-book.js';

let pass = 0, fail = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const quiet = { log() {}, warn() {}, error() {} };
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A book whose snapshot is `snap`, counting how often it was asked for. */
function bookWith(market, snap) {
  const asked = [];
  const book = new OrderBook({
    symbol: 'BTCUSDT',
    market,
    fetchJson: async (path) => {
      asked.push(path);
      return typeof snap === 'function' ? snap() : snap;
    },
    logger: quiet,
  });
  return { book, asked };
}

t('spot: frames the snapshot holds are dropped, the straddling one applied, then in sequence', async () => {
  const { book, asked } = bookWith('spot', { lastUpdateId: 100, bids: [['99', '1']], asks: [['101', '1']] });
  book.diff({ U: 90, u: 95, b: [['98', '5']], a: [] }); // before the snapshot
  book.diff({ U: 96, u: 103, b: [['99', '2']], a: [] }); // straddles 100
  await tick();
  assert.equal(asked.length, 1);
  assert.equal(book.state, 'live');
  assert.equal(book.bids.get(99), 2);
  assert.equal(book.bids.has(98), false, 'a frame older than the snapshot is not applied');
  book.diff({ U: 104, u: 110, b: [['99', '0']], a: [['102', '3']] });
  assert.equal(book.bids.has(99), false, 'quantity 0 removes the level');
  assert.equal(book.asks.get(102), 3);
  book.retryAt = 0; // a second on
  book.diff({ U: 120, u: 125, b: [], a: [] }); // 111..119 missed
  assert.equal(book.state, 'loading');
  await tick();
  assert.equal(asked.length, 2, 'a gap fetches the book again');
  // That copy is older than the frame too; it is not asked for again at once.
  await tick();
  assert.equal(asked.length, 2, 'not in a tight loop');
  assert.equal(book.state, 'idle');
});

t('perp: each frame names the one before it (pu)', async () => {
  const { book, asked } = bookWith('perp', { lastUpdateId: 500, bids: [['99', '1']], asks: [['101', '1']] });
  book.diff({ U: 480, u: 520, pu: 470, b: [['99', '4']], a: [] });
  await tick();
  assert.equal(book.state, 'live');
  assert.equal(book.bids.get(99), 4);
  book.diff({ U: 525, u: 540, pu: 520, b: [], a: [['101', '0']] });
  assert.equal(book.asks.has(101), false);
  book.retryAt = 0;
  book.diff({ U: 545, u: 560, pu: 541, b: [], a: [] });
  assert.equal(book.state, 'loading', 'pu not the last u: out of sequence');
  await tick();
  assert.equal(asked.length, 2);
});

t('a snapshot newer than every buffered frame waits for the straddling one', async () => {
  const { book } = bookWith('perp', { lastUpdateId: 500, bids: [['99', '1']], asks: [['101', '1']] });
  book.diff({ U: 400, u: 450, pu: 390, b: [], a: [] });
  await tick();
  assert.equal(book.state, 'priming');
  book.diff({ U: 451, u: 499, pu: 450, b: [], a: [] }); // still before it
  assert.equal(book.state, 'priming');
  book.diff({ U: 499, u: 510, pu: 499, b: [['99', '7']], a: [] });
  assert.equal(book.state, 'live');
  assert.equal(book.bids.get(99), 7);
});

t('buckets: 5 basis points, rounded; a wall scores against the buckets near it', () => {
  assert.equal(niceStep(80_000 * 0.0005), 50);
  assert.equal(niceStep(2_000 * 0.0005), 1);
  assert.equal(niceStep(0.35 * 0.0005), 0.0002);
  const levels = new Map();
  for (let p = 99_000; p < 100_000; p += 10) levels.set(p, 1); // $100K per $10 level
  levels.set(99_500, 101); // + $10M at one level
  const buckets = bucketSide(levels, 100_000, 50, true);
  assert.ok(Math.abs(buckets.get(99_500).usd - (101 * 99_500 + 4 * 99_520)) < 1e3);
  const scores = scoreBuckets(buckets, 50);
  assert.ok(scores.get(99_500) > 15, `wall ${scores.get(99_500)}`);
  assert.ok(scores.get(99_200) < 1.5, `plain level ${scores.get(99_200)}`);
});

/** A live, warm book around 100,000 with $50K per $10 level, and a tracker on it. */
function market(now) {
  const book = new OrderBook({ symbol: 'X', market: 'spot', fetchJson: async () => ({}), logger: quiet });
  for (let p = 98_000; p <= 99_990; p += 10) book.bids.set(p, 0.5);
  for (let p = 100_000; p <= 102_000; p += 10) book.asks.set(p, 0.5);
  book.state = 'live';
  book.liveAt = 1;
  const tracker = new WallTracker({ now: () => now.t });
  return { book, tracker };
}

t('a wall is found, followed, and when pulled far from price, marked pulled', () => {
  const now = { t: 1_000_000 };
  const { book, tracker } = market(now);
  book.asks.set(101_000, 60); // $6M, 1% above
  tracker.check(book);
  const [w] = tracker.snapshot().walls.filter((x) => x.side === 'ask');
  assert.equal(w.price, 101_000);
  assert.ok(w.peakScore > 20);
  now.t += 30_000;
  book.asks.set(101_000, 40); // shrinks by a third: still the same wall
  assert.equal(tracker.check(book).length, 0);
  now.t += 30_000;
  book.asks.set(101_000, 0.5); // gone, price never near
  const ended = tracker.check(book);
  assert.equal(ended.length, 1);
  assert.equal(ended[0].how, 'pulled');
  assert.equal(ended[0].end - ended[0].since, 60_000);
  assert.equal(tracker.snapshot().ended.length, 1);
});

t('a wall price traded into is marked filled', () => {
  const now = { t: 1_000_000 };
  const { book, tracker } = market(now);
  book.bids.set(99_500, 60);
  tracker.check(book);
  now.t += 20_000;
  // Sellers sweep down through it: the best bid reaches 99,490 for a moment.
  tracker.touch(99_490, 99_500);
  book.bids.set(99_500, 0);
  const ended = tracker.check(book);
  assert.equal(ended.length, 1);
  assert.equal(ended[0].how, 'filled');
});

t('a wall gone within seconds is not recorded (quote churn by the mid)', () => {
  const now = { t: 1_000_000 };
  const { book, tracker } = market(now);
  book.asks.set(101_000, 60);
  tracker.check(book);
  now.t += 4000;
  book.asks.set(101_000, 0.5);
  assert.equal(tracker.check(book).length, 0);
  assert.equal(tracker.snapshot().ended.length, 0);
});

t('a book still filling out is not read for walls', () => {
  const now = { t: 1_000_000 };
  const { book, tracker } = market(now);
  book.market = 'perp';
  book.liveAt = Date.now(); // just went live
  book.asks.set(101_000, 60);
  tracker.check(book);
  assert.equal(tracker.snapshot().walls.length, 0);
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
