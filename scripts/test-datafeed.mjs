/**
 * Headless tests for BinanceProvider.
 *
 * The connection-resilience rules in spec 6 are the hardest part of this app to
 * verify by hand (you would have to physically drop the network and wait out an
 * exponential backoff), so the browser globals the provider depends on --
 * WebSocket, fetch, localStorage, setTimeout -- are stubbed here and time is
 * driven manually.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

/* ------------------------------------------------------------ fake clock */

/** Tests start at a realistic epoch: the provider reasons about wall-clock gaps. */
const START_MS = 1_700_000_000_000;

let now = START_MS;
let nextTimerId = 1;
const timers = [];

const realSetTimeout = globalThis.setTimeout;
const realDateNow = Date.now;

// The coalescing window compares Date.now() against the last flush, so the
// fake clock has to drive both halves or `advance()` proves nothing.
Date.now = () => now;

globalThis.setTimeout = (fn, delay = 0, ...args) => {
  const timer = { id: nextTimerId++, at: now + delay, fn, args };
  timers.push(timer);
  return timer.id;
};
globalThis.clearTimeout = (id) => {
  const index = timers.findIndex((t) => t.id === id);
  if (index >= 0) timers.splice(index, 1);
};

function advance(ms) {
  const target = now + ms;
  for (;;) {
    const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    timers.splice(timers.indexOf(due), 1);
    now = due.at;
    due.fn(...due.args);
  }
  now = target;
}

/** Pending short-fuse timers, i.e. reconnects (ignores the 23h recycle timer). */
function pendingReconnectDelays() {
  return timers.filter((t) => t.at - now <= 60_000).map((t) => t.at - now);
}

/** Let queued promise callbacks run. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/* ------------------------------------------------------- browser globals */

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

globalThis.window = { addEventListener() {}, removeEventListener() {} };
// Node 24 ships a read-only `navigator`, so replace the property outright.
Object.defineProperty(globalThis, 'navigator', {
  value: { onLine: true, language: 'en-US' },
  configurable: true,
  writable: true,
});

const sockets = [];

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    sockets.push(this);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    if (this.onclose) this.onclose({});
  }

  /* test helpers */
  open() {
    this.readyState = FakeWebSocket.OPEN;
    if (this.onopen) this.onopen({});
  }

  emit(payload) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(payload) });
  }

  get streams() {
    return new URL(this.url).searchParams.get('streams').split('/');
  }
}
globalThis.WebSocket = FakeWebSocket;

let fetchCalls = [];
let klineResponder = null;

globalThis.fetch = async (url) => {
  fetchCalls.push(String(url));
  const body = klineResponder ? klineResponder(String(url)) : [];
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
};
globalThis.AbortController = class {
  constructor() {
    this.signal = {};
  }
  abort() {}
};

/* ------------------------------------------------------------- fixtures */

const MINUTE = 60_000;

/** Binance kline REST rows: [openTime, o, h, l, c, v, ...] */
function klines(startMs, count, basePrice = 100) {
  return Array.from({ length: count }, (_, i) => [
    startMs + i * MINUTE,
    String(basePrice + i),
    String(basePrice + i + 1),
    String(basePrice + i - 1),
    String(basePrice + i + 0.5),
    '10',
    startMs + i * MINUTE + MINUTE - 1,
    '0',
    1,
    '0',
    '0',
    '0',
  ]);
}

function klineEvent(symbol, interval, openTimeMs, close, closed) {
  return {
    stream: `${symbol.toLowerCase()}@kline_${interval}`,
    data: {
      e: 'kline',
      s: symbol,
      k: {
        t: openTimeMs,
        i: interval,
        o: '100',
        h: '110',
        l: '90',
        c: String(close),
        v: '42',
        x: closed,
      },
    },
  };
}

function aggTradeEvent(symbol, price, qty, tradeMs) {
  return {
    stream: `${symbol.toLowerCase()}@aggTrade`,
    data: { e: 'aggTrade', s: symbol, p: String(price), q: String(qty), T: tradeMs },
  };
}

/* ------------------------------------------------------------------ run */

const { BinanceProvider } = await import('../renderer/datafeed/binance.js');

const results = [];
async function test(name, fn) {
  sockets.length = 0;
  timers.length = 0;
  fetchCalls = [];
  klineResponder = null;
  now = START_MS;
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

const silent = { log() {}, error() {} };

console.log('BinanceProvider');

await test('one connection serves many cards, streams are ref-counted', async () => {
  const provider = new BinanceProvider({ logger: silent });

  provider.subscribe('card-a', 'BTCUSDT', '1m', {});
  provider.subscribe('card-b', 'BTCUSDT', '1m', {}); // same market, second card
  await flush();

  assert.equal(sockets.length, 1, 'a second card must not open a second socket');
  assert.deepEqual(
    sockets[0].streams.sort(),
    ['btcusdt@kline_1m', 'btcusdt@miniTicker', 'btcusdt@aggTrade'].sort()
  );
  sockets[0].open();

  provider.subscribe('card-c', 'ETHUSDT', '1m', {});
  assert.equal(sockets.length, 1, 'a new symbol grows the existing socket');
  assert.deepEqual(sockets[0].sent.at(-1).method, 'SUBSCRIBE');
  assert.deepEqual(sockets[0].sent.at(-1).params.sort(), [
    'ethusdt@kline_1m',
    'ethusdt@miniTicker',
    'ethusdt@aggTrade',
  ].sort());

  // BTCUSDT still has one holder, so nothing may be unsubscribed yet.
  const before = sockets[0].sent.length;
  provider.unsubscribe('card-a');
  assert.equal(sockets[0].sent.length, before, 'stream released while still referenced');

  provider.unsubscribe('card-b');
  assert.equal(sockets[0].sent.at(-1).method, 'UNSUBSCRIBE');
  assert.deepEqual(sockets[0].sent.at(-1).params.sort(), [
    'btcusdt@kline_1m',
    'btcusdt@miniTicker',
    'btcusdt@aggTrade',
  ].sort());

  provider.unsubscribe('card-c');
  assert.equal(provider.getStatus(), 'idle');
  assert.equal(sockets[0].readyState, FakeWebSocket.CLOSED, 'last unsubscribe closes the socket');
});

await test('kline events become bars and carry the closed flag', async () => {
  const provider = new BinanceProvider({ logger: silent });
  const bars = [];
  provider.subscribe('card', 'BTCUSDT', '1m', { onBar: (b) => bars.push(b) });
  sockets[0].open();

  sockets[0].emit(klineEvent('BTCUSDT', '1m', 1_700_000_000_000, 101.5, false));
  sockets[0].emit(klineEvent('BTCUSDT', '1m', 1_700_000_000_000, 102.5, true));

  assert.equal(bars.length, 2);
  assert.equal(bars[0].time, 1_700_000_000, 'time must be UNIX seconds for lightweight-charts');
  assert.equal(bars[0].close, 101.5);
  assert.equal(bars[0].closed, false, 'in-progress candle');
  assert.equal(bars[1].closed, true, 'x:true marks the candle final');
});

await test('trades extend the forming candle, coalesced to one update per window', async () => {
  const provider = new BinanceProvider({ logger: silent });
  const bars = [];
  provider.subscribe('card', 'BTCUSDT', '1m', { onBar: (b) => bars.push(b) });
  sockets[0].open();

  const openMs = 1_700_000_000_000;
  sockets[0].emit(klineEvent('BTCUSDT', '1m', openMs, 101.5, false));
  assert.equal(bars.length, 1, 'the authoritative kline must not wait for the window');

  // A burst on a hot tape: dozens of trades inside one 100ms window.
  for (let i = 0; i < 40; i++) {
    sockets[0].emit(aggTradeEvent('BTCUSDT', 105, 1, openMs + i));
  }
  sockets[0].emit(aggTradeEvent('BTCUSDT', 115, 1, openMs + 41));
  assert.equal(bars.length, 1, 'trades inside the window must not each reach the card');

  advance(100);
  assert.equal(bars.length, 2, 'a whole burst collapses into exactly one repaint');

  const live = bars[1];
  assert.equal(live.close, 115, 'the newest trade wins; the rest are skipped');
  assert.equal(live.high, 115, 'a trade above the kline high extends the candle');
  assert.equal(live.low, 90, 'the kline low stands when no trade goes under it');
  assert.equal(live.time, bars[0].time, 'trades extend the candle, they never open one');
  assert.equal(live.volume, 42 + 41, 'trade size accumulates onto the kline volume');
});

await test('a trade past the candle boundary waits for the kline to roll it', async () => {
  const provider = new BinanceProvider({ logger: silent });
  const bars = [];
  provider.subscribe('card', 'BTCUSDT', '1m', { onBar: (b) => bars.push(b) });
  sockets[0].open();

  const openMs = 1_700_000_000_000;
  sockets[0].emit(klineEvent('BTCUSDT', '1m', openMs, 101.5, false));

  // One minute on: this trade belongs to the *next* candle, which no kline has
  // announced yet. Folding it in here would corrupt the one still on screen.
  sockets[0].emit(aggTradeEvent('BTCUSDT', 200, 1, openMs + MINUTE));
  advance(100);
  assert.equal(bars.length, 1, 'a next-candle trade must not touch the current one');

  // Same once the candle is final.
  sockets[0].emit(klineEvent('BTCUSDT', '1m', openMs, 102.5, true));
  assert.equal(bars.length, 2);
  sockets[0].emit(aggTradeEvent('BTCUSDT', 300, 1, openMs + 100));
  advance(100);
  assert.equal(bars.length, 2, 'a closed candle is final, whatever trades follow');
});

await test('no trade is lost: the last one in a window still lands', async () => {
  const provider = new BinanceProvider({ logger: silent });
  const bars = [];
  provider.subscribe('card', 'BTCUSDT', '1m', { onBar: (b) => bars.push(b) });
  sockets[0].open();

  const openMs = 1_700_000_000_000;
  sockets[0].emit(klineEvent('BTCUSDT', '1m', openMs, 101.5, false));

  sockets[0].emit(aggTradeEvent('BTCUSDT', 108, 1, openMs + 1));
  advance(100);
  sockets[0].emit(aggTradeEvent('BTCUSDT', 109, 1, openMs + 2));
  advance(100);

  assert.equal(bars.length, 3, 'trades in separate windows each get their own update');
  assert.equal(bars.at(-1).close, 109);
  assert.notEqual(bars[1], bars[2], 'each update must be its own object, not a shared mutable bar');
});

await test('miniTicker yields the 24h change percentage', async () => {
  const provider = new BinanceProvider({ logger: silent });
  const tickers = [];
  provider.subscribe('card', 'BTCUSDT', '1m', { onTicker: (t) => tickers.push(t) });
  sockets[0].open();

  sockets[0].emit({
    stream: 'btcusdt@miniTicker',
    data: { e: '24hrMiniTicker', s: 'BTCUSDT', o: '100', c: '110', h: '111', l: '99', v: '5' },
  });

  assert.equal(tickers.length, 1);
  assert.equal(tickers[0].changePercent, 10);
  assert.equal(tickers[0].last, 110);
});

await test('a dropped connection retries with exponential backoff capped at 30s', async () => {
  const provider = new BinanceProvider({ logger: silent });
  provider.subscribe('card', 'BTCUSDT', '1m', {});

  const observed = [];
  // Fail each attempt before it opens, so the backoff keeps escalating.
  for (let i = 0; i < 8; i++) {
    sockets.at(-1).close();
    const [delay] = pendingReconnectDelays();
    observed.push(delay);
    assert.equal(provider.getStatus(), 'reconnecting');
    advance(delay);
  }

  assert.deepEqual(observed, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  assert.equal(sockets.length, 9, 'every backoff step must actually reconnect');
});

await test('reconnecting re-subscribes every stream', async () => {
  const provider = new BinanceProvider({ logger: silent });
  provider.subscribe('a', 'BTCUSDT', '1m', {});
  provider.subscribe('b', 'ETHUSDT', '5m', {});
  sockets[0].open();

  sockets[0].close();
  advance(1000);

  const reconnected = sockets.at(-1);
  assert.deepEqual(
    reconnected.streams.sort(),
    [
      'btcusdt@kline_1m',
      'btcusdt@miniTicker',
      'btcusdt@aggTrade',
      'ethusdt@kline_5m',
      'ethusdt@miniTicker',
      'ethusdt@aggTrade',
    ].sort(),
    'the new socket must carry the full stream set'
  );
});

await test('bars missed during an outage are backfilled before live bars resume', async () => {
  const provider = new BinanceProvider({ logger: silent });
  const bars = [];
  provider.subscribe('card', 'BTCUSDT', '1m', { onBar: (b) => bars.push(b) });
  sockets[0].open();

  // Last bar seen before the drop.
  const lastSeenMs = Date.now() - 5 * MINUTE;
  sockets[0].emit(klineEvent('BTCUSDT', '1m', lastSeenMs, 100, true));
  assert.equal(bars.length, 1);

  // Five minutes of downtime, then the REST endpoint has the gap.
  klineResponder = () => klines(lastSeenMs, 6, 200);

  sockets[0].close();
  advance(1000);
  sockets.at(-1).open();
  await flush();
  await flush();

  const backfilled = bars.slice(1);
  assert.ok(backfilled.length >= 5, `expected the gap to be filled, got ${backfilled.length}`);
  assert.ok(
    backfilled.every((b) => b.time >= Math.floor(lastSeenMs / 1000)),
    'backfill must not replay bars older than what the chart already has'
  );
  assert.ok(
    backfilled.every((b, i) => i === 0 || b.time > backfilled[i - 1].time),
    'backfilled bars must be strictly increasing, or series.update() will throw'
  );
  assert.ok(
    fetchCalls.some((u) => u.includes('/klines') && u.includes('BTCUSDT')),
    'backfill should hit the REST klines endpoint'
  );
});

await test('changing symbol replaces the subscription instead of stacking one', async () => {
  const provider = new BinanceProvider({ logger: silent });
  provider.subscribe('card', 'BTCUSDT', '1m', {});
  sockets[0].open();

  provider.subscribe('card', 'ETHUSDT', '1m', {}); // same subId = same card

  assert.equal(provider.subs.size, 1);
  assert.deepEqual([...provider.streamRefs.keys()].sort(), [
    'ethusdt@kline_1m',
    'ethusdt@miniTicker',
    'ethusdt@aggTrade',
  ].sort());
  assert.equal(sockets.length, 1, 'switching symbols must not reconnect');
});

await test('symbol search ranks exact and USDT pairs first, and caches the list', async () => {
  const provider = new BinanceProvider({ logger: silent });
  klineResponder = () => ({
    symbols: [
      { symbol: 'BTCNGN', baseAsset: 'BTC', quoteAsset: 'NGN', status: 'TRADING' },
      { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING' },
      { symbol: 'ETHBTC', baseAsset: 'ETH', quoteAsset: 'BTC', status: 'TRADING' },
      { symbol: 'DEADCOIN', baseAsset: 'DEAD', quoteAsset: 'USDT', status: 'BREAK' },
    ],
  });

  const first = await provider.searchSymbols('BTC');
  assert.equal(first[0].symbol, 'BTCUSDT', 'USDT pairs should outrank exotic quotes');
  assert.ok(!first.some((s) => s.symbol === 'DEADCOIN'), 'non-TRADING pairs must be filtered out');

  const callsAfterFirst = fetchCalls.length;
  await provider.searchSymbols('ETH');
  assert.equal(fetchCalls.length, callsAfterFirst, 'the symbol list must be served from cache');
});

/* ---------------------------------------------------------------- report */

globalThis.setTimeout = realSetTimeout;
Date.now = realDateNow;

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  for (const f of failed) console.error(`\n${f.name}:\n${f.err.stack}`);
  process.exitCode = 1;
}
