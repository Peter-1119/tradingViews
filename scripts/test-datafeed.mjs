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

await test('streams added while the socket is still connecting are subscribed once it opens', async () => {
  const provider = new BinanceProvider({ logger: silent });
  // The 4h overlay subscribes first and opens the socket...
  provider.subscribe('card:htf', 'BTCUSDT', '4h', {});
  // ...and the chart's own stream arrives before the handshake finishes.
  provider.subscribe('card', 'BTCUSDT', '1m', {});
  provider.unsubscribe('other-never-subscribed');
  assert.equal(sockets.length, 1);
  assert.ok(!sockets[0].streams.includes('btcusdt@kline_1m'), 'precondition: not in the connect URL');

  sockets[0].open();
  const sub = sockets[0].sent.find((m) => m.method === 'SUBSCRIBE');
  assert.ok(sub, 'nothing was subscribed on open');
  assert.deepEqual(sub.params, ['btcusdt@kline_1m']);
});

await test('streams released while connecting are unsubscribed once it opens', async () => {
  const provider = new BinanceProvider({ logger: silent });
  provider.subscribe('a', 'BTCUSDT', '1m', {});
  provider.subscribe('b', 'ETHUSDT', '1m', {});
  provider.subscribe('a', 'SOLUSDT', '1m', {}); // BTC released before the socket opened
  sockets[0].open();
  const unsub = sockets[0].sent.find((m) => m.method === 'UNSUBSCRIBE');
  assert.ok(unsub, 'BTC streams would keep flowing for nobody');
  assert.ok(unsub.params.includes('btcusdt@kline_1m'));
  const sub = sockets[0].sent.find((m) => m.method === 'SUBSCRIBE');
  assert.ok(sub && sub.params.includes('ethusdt@kline_1m') && sub.params.includes('solusdt@kline_1m'));
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

/* ------------------------------------------------------ perpetuals */

const { counterpartSymbol } = await import('../renderer/datafeed/binance.js');

console.log('');
console.log('perpetuals');

await test('perp talks to the futures hosts, on the /market stream route', async () => {
  const provider = new BinanceProvider({ logger: silent, market: 'perp' });
  provider.subscribe('card', 'BTCUSDT', '1m', {});
  await provider.getHistory('BTCUSDT', '1m', 10);

  const url = new URL(sockets[0].url);
  assert.equal(url.host, 'fstream.binance.com');
  assert.equal(url.pathname, '/market/stream', 'the bare /stream route no longer carries market data');
  const klineCall = fetchCalls.find((u) => u.includes('/klines?'));
  assert.ok(klineCall && klineCall.startsWith('https://fapi.binance.com/fapi/v1/klines?'), klineCall);
  assert.ok(sockets[0].streams.includes('btcusdt@markPrice'), 'perp needs the funding stream');
});

await test('spot does not subscribe to a funding stream it cannot have', async () => {
  const provider = new BinanceProvider({ logger: silent });
  provider.subscribe('card', 'BTCUSDT', '1m', {});
  assert.ok(!sockets[0].streams.some((s) => s.includes('markPrice')));
  assert.equal(await provider.getFunding('BTCUSDT'), null);
  assert.equal(fetchCalls.length, 0, 'spot getFunding must not hit the network');
});

await test('markPriceUpdate reaches onFunding, and a late subscriber gets it at once', async () => {
  const provider = new BinanceProvider({ logger: silent, market: 'perp' });
  const got = [];
  provider.subscribe('card', 'BTCUSDT', '1m', { onFunding: (f) => got.push(f) });
  sockets[0].open();
  sockets[0].emit({
    stream: 'btcusdt@markPrice',
    data: { e: 'markPriceUpdate', s: 'BTCUSDT', p: '84238.8', r: '0.00001462', T: 1790265600000 },
  });

  assert.equal(got.length, 1);
  assert.deepEqual(got[0], {
    symbol: 'BTCUSDT',
    markPrice: 84238.8,
    fundingRate: 0.00001462,
    nextFundingTime: 1790265600000,
  });

  const late = [];
  provider.subscribe('card-2', 'BTCUSDT', '1m', { onFunding: (f) => late.push(f) });
  assert.equal(late.length, 1, 'the cached funding should be handed over on subscribe');
});

await test('getFunding maps premiumIndex', async () => {
  const provider = new BinanceProvider({ logger: silent, market: 'perp' });
  klineResponder = () => ({
    symbol: 'ETHUSDT',
    markPrice: '3200.5',
    lastFundingRate: '-0.00012',
    nextFundingTime: 1790265600000,
  });
  const f = await provider.getFunding('ethusdt');
  assert.ok(fetchCalls[0].endsWith('/premiumIndex?symbol=ETHUSDT'), fetchCalls[0]);
  assert.equal(f.fundingRate, -0.00012);
  assert.equal(f.markPrice, 3200.5);
});

await test('perp symbol list keeps perpetuals only, cached apart from spot', async () => {
  localStorage.removeItem('stockcard.symbols.v1');
  const spot = new BinanceProvider({ logger: silent });
  const perp = new BinanceProvider({ logger: silent, market: 'perp' });
  klineResponder = (url) =>
    url.includes('fapi')
      ? {
          symbols: [
            { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING', contractType: 'PERPETUAL' },
            { symbol: 'BTCUSDT_251226', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING', contractType: 'CURRENT_QUARTER' },
          ],
        }
      : { symbols: [{ symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', status: 'TRADING' }] };

  const perpList = await perp.loadSymbols();
  const spotList = await spot.loadSymbols();
  assert.deepEqual(perpList.map((s) => s.symbol), ['BTCUSDT'], 'quarterlies are not perpetuals');
  assert.deepEqual(spotList.map((s) => s.symbol), ['ETHUSDT'], 'the markets must not share a cache entry');
});

await test('counterpart: same name, scaled contracts, and none', () => {
  const info = (symbol, base, quote) => ({ symbol, base, quote });
  const spot = [
    info('BTCUSDT', 'BTC', 'USDT'),
    info('PEPEUSDT', 'PEPE', 'USDT'),
    info('1000SATSUSDT', '1000SATS', 'USDT'),
    info('1INCHUSDT', '1INCH', 'USDT'),
    info('BTCUSDC', 'BTC', 'USDC'),
    info('BNBBTC', 'BNB', 'BTC'),
  ];
  const perp = [
    info('BTCUSDT', 'BTC', 'USDT'),
    info('1000PEPEUSDT', '1000PEPE', 'USDT'),
    info('1000SATSUSDT', '1000SATS', 'USDT'),
    info('1000000MOGUSDT', '1000000MOG', 'USDT'),
    info('1INCHUSDT', '1INCH', 'USDT'),
  ];

  assert.equal(counterpartSymbol('BTCUSDT', spot, perp), 'BTCUSDT');
  assert.equal(counterpartSymbol('PEPEUSDT', spot, perp), '1000PEPEUSDT');
  assert.equal(counterpartSymbol('1000PEPEUSDT', perp, spot), 'PEPEUSDT');
  assert.equal(counterpartSymbol('1000SATSUSDT', spot, perp), '1000SATSUSDT', 'a real 1000 name is not a multiplier');
  assert.equal(counterpartSymbol('1INCHUSDT', perp, spot), '1INCHUSDT');
  assert.equal(counterpartSymbol('1000000MOGUSDT', perp, spot), null, 'MOG has no spot pair here');
  assert.equal(counterpartSymbol('BNBBTC', spot, perp), null);
  assert.equal(counterpartSymbol('BTCUSDC', spot, perp), null, 'a different quote is a different instrument');
});

/* ---------------------------------------------------- open interest */

console.log('');
console.log('open interest');

/** A responder that answers OI snapshots from a script of values, and klines empty. */
function oiResponder(values) {
  let i = 0;
  return (url) => {
    if (!url.includes('/openInterest?')) return [];
    const value = values[Math.min(i, values.length - 1)];
    i += 1;
    return { symbol: 'BTCUSDT', openInterest: String(value), time: now };
  };
}
const oiCalls = () => fetchCalls.filter((u) => u.includes('/openInterest?')).length;

await test('a perp subscription polls OI every 3s; spot never does', async () => {
  const spot = new BinanceProvider({ logger: silent });
  spot.subscribe('s', 'BTCUSDT', '1m', {});
  await flush();
  assert.equal(oiCalls(), 0, 'spot has no open interest');

  const perp = new BinanceProvider({ logger: silent, market: 'perp' });
  klineResponder = oiResponder([100, 101, 102]);
  const got = [];
  perp.subscribe('card', 'BTCUSDT', '1m', { onOI: (s) => got.push(s.value) });
  await flush();
  assert.equal(oiCalls(), 1, 'first poll is immediate');
  advance(3000);
  await flush();
  advance(3000);
  await flush();
  assert.equal(oiCalls(), 3);
  assert.deepEqual(got, [100, 101, 102]);
  assert.ok(fetchCalls.find((u) => u.includes('/openInterest?')).startsWith('https://fapi.binance.com/fapi/v1/'));
});

await test('one poller per symbol, however many cards; it stops with the last', async () => {
  const perp = new BinanceProvider({ logger: silent, market: 'perp' });
  klineResponder = oiResponder([100]);
  perp.subscribe('a', 'BTCUSDT', '1m', {});
  perp.subscribe('a:htf', 'BTCUSDT', '4h', {});
  perp.subscribe('b', 'BTCUSDT', '5m', {});
  await flush();
  assert.equal(oiCalls(), 1, 'three subscriptions, one request');

  perp.unsubscribe('a');
  perp.unsubscribe('a:htf');
  advance(3000);
  await flush();
  assert.equal(oiCalls(), 2, 'still one holder left');

  perp.unsubscribe('b');
  const before = oiCalls();
  advance(30_000);
  await flush();
  assert.equal(oiCalls(), before, 'nobody watching, nothing polled');
});

await test('an unchanged snapshot is not reported twice', async () => {
  const perp = new BinanceProvider({ logger: silent, market: 'perp' });
  const frozen = now;
  klineResponder = (url) =>
    url.includes('/openInterest?') ? { symbol: 'BTCUSDT', openInterest: '100', time: frozen } : [];
  const got = [];
  perp.subscribe('card', 'BTCUSDT', '1m', { onOI: (s) => got.push(s) });
  await flush();
  advance(3000);
  await flush();
  assert.equal(got.length, 1, 'same exchange timestamp = same reading');
});

await test('samples fold into one closed OHLC record per minute', async () => {
  const perp = new BinanceProvider({ logger: silent, market: 'perp' });
  const minutes = [];
  perp.onOIMinute = (symbol, record) => minutes.push({ symbol, ...record });
  // Start on a minute boundary so the arithmetic below is exact.
  advance(60_000 - (now % 60_000));
  klineResponder = oiResponder([100, 104, 98, 101, 200]);
  perp.subscribe('card', 'BTCUSDT', '1m', {});
  await flush();
  for (let i = 0; i < 20; i++) {
    advance(3000);
    await flush();
  }
  assert.equal(minutes.length, 1, 'the first minute closes when a later sample arrives');
  const [m] = minutes;
  assert.equal(m.symbol, 'BTCUSDT');
  assert.equal(m.time % 60, 0);
  // 100, 104, 98, 101, then 200 for every remaining sample of the minute.
  assert.deepEqual([m.open, m.high, m.low, m.close], [100, 200, 98, 200]);
  assert.equal(m.closed, true);
  assert.equal(m.volume, 20, 'volume counts the samples');
});

await test('OI history pages backwards through /futures/data, clamped to 30 days', async () => {
  const perp = new BinanceProvider({ logger: silent, market: 'perp' });
  // Behaves like the real endpoint: the NEWEST `limit` samples in [start, end].
  const first = now - 50 * 3600_000 - ((now - 50 * 3600_000) % 300_000);
  klineResponder = (url) => {
    if (!url.includes('/openInterestHist?')) return [];
    const q = new URL(url).searchParams;
    const lo = Number(q.get('startTime'));
    const hi = Number(q.get('endTime'));
    const all = [];
    for (let t = first; t <= now; t += 300_000) if (t >= lo && t <= hi) all.push(t);
    return all.slice(-Number(q.get('limit'))).map((t) => ({
      symbol: 'BTCUSDT',
      sumOpenInterest: String(1000 + (t - first) / 300_000),
      sumOpenInterestValue: '9e7',
      timestamp: t,
    }));
  };
  const rows = await perp.getOpenInterestHist('btcusdt', '5m', first, now);
  const calls = fetchCalls.filter((u) => u.includes('/openInterestHist?'));
  assert.ok(calls[0].startsWith('https://fapi.binance.com/futures/data/openInterestHist?'), calls[0]);
  assert.equal(calls.length, 2, '50h of 5m is 601 samples: one full page, then the rest');
  assert.equal(rows.length, 601, 'every sample, none lost between pages');
  assert.equal(rows[0].time, first, 'oldest first');
  assert.equal(rows[0].value, 1000);
  assert.ok(rows.every((r, i) => i === 0 || r.time - rows[i - 1].time === 300_000), 'no gaps, no duplicates');

  fetchCalls = [];
  await perp.getOpenInterestHist('BTCUSDT', '5m', now - 90 * 86400_000, now);
  const start = Number(new URL(fetchCalls[0]).searchParams.get('startTime'));
  assert.ok(start > now - 30 * 86400_000, 'older than 30 days is an error on Binance');
});

const { oiPoints, bucketOI, historyRecords, OI_MAX_GAP_SEC } = await import('../renderer/open-interest.js');

await test('bucketing: 1m OHLC passes through, 5m history steps across 1m bars', () => {
  const T = 1_790_000_100 - (1_790_000_100 % 300);
  const minute = { time: T, open: 10, high: 14, low: 9, close: 12 };
  const [bar] = bucketOI(oiPoints([minute]), [T], 60);
  assert.deepEqual(bar, { time: T, open: 10, high: 14, low: 9, close: 12 });

  // Only 5m samples, at T and T+300: the minutes between hold the earlier one.
  const pts = oiPoints([], historyRecords([{ time: T * 1000, value: 50 }, { time: (T + 300) * 1000, value: 60 }]));
  const bars = bucketOI(pts, [T, T + 60, T + 120, T + 240, T + 300], 60);
  assert.deepEqual(bars.map((b) => b.close), [50, 50, 50, 50, 60]);
  assert.equal(bars[4].open, 50, 'a bar opens where the previous one closed');
});

await test('bucketing: coarse bars aggregate, and long gaps stay empty', () => {
  const T = 1_790_006_400 - (1_790_006_400 % 3600);
  const rows = [];
  for (let i = 0; i <= 12; i++) rows.push({ time: (T + i * 300) * 1000, value: 100 + i });
  const pts = oiPoints([], historyRecords(rows));
  const [hour] = bucketOI(pts, [T], 3600);
  assert.equal(hour.open, 100);
  assert.equal(hour.close, 111, 'the sample at T+3600 belongs to the next hour');
  assert.equal(hour.high, 111);

  // Nothing for a day after the last sample: the next bars must not be invented.
  const later = bucketOI(pts, [T + 3600, T + 3600 + OI_MAX_GAP_SEC + 60, T + 86400], 60);
  assert.deepEqual(later.map((b) => b.time), [T + 3600], 'only the bar within the gap limit');
});

/* ----------------------------------------------------- price position */

const { buildCdf, percentileOf, LevelTrigger } = await import('../renderer/position.js');

console.log('');
console.log('price position');

await test('percentile is the share of volume traded below the price', () => {
  // Two one-price bars: 30 at 100, 70 at 200. Rows span 100..200.
  const bars = [
    { high: 100, low: 100, volume: 30 },
    { high: 200, low: 200, volume: 70 },
    { high: 200, low: 100, volume: 0 },
  ];
  const cdf = buildCdf(bars, 10);
  assert.equal(percentileOf(cdf, 99), 0, 'below the range');
  assert.equal(percentileOf(cdf, 201), 1, 'above the range: a breakout reads 100%');
  // Anything between the two clusters has exactly the lower one below it.
  assert.ok(Math.abs(percentileOf(cdf, 150) - 0.3) < 1e-9, String(percentileOf(cdf, 150)));
});

await test('a two-peaked distribution needs no fitting', () => {
  // Heavy nodes at 100 and 300, nothing in between: the middle of the range
  // is the 50th percentile of volume, whatever a single Gaussian would say.
  const bars = [];
  for (let i = 0; i < 50; i++) bars.push({ high: 101, low: 99, volume: 1 });
  for (let i = 0; i < 50; i++) bars.push({ high: 301, low: 299, volume: 1 });
  const cdf = buildCdf(bars, 100);
  assert.ok(Math.abs(percentileOf(cdf, 200) - 0.5) < 1e-9);
  assert.ok(percentileOf(cdf, 101.5) > 0.49 && percentileOf(cdf, 298) < 0.51);
});

await test('trigger: each level once, re-armed only back at 50%', () => {
  const t = new LevelTrigger([5, 10, 20, 80, 90, 95]);
  const run = (seq) => seq.map((p) => t.update(p)).map((h) => (h ? `${h.side}${h.level}` : '-')).join(' ');
  assert.equal(
    run([0.5, 0.79, 0.81, 0.78, 0.82, 0.91, 0.6, 0.85, 0.5, 0.81]),
    '- - high80 - - high90 - - - high80',
    'wiggling at 80 alerts once; 60% is not enough to re-arm; 50% is'
  );
});

await test('trigger: a jump reports only the furthest level, and priming is silent', () => {
  const t = new LevelTrigger([5, 10, 20, 80, 90, 95]);
  t.update(0.5);
  assert.deepEqual(t.update(0.97), { side: 'high', level: 95 });
  assert.equal(t.update(0.92), null, '80 and 90 were passed on the way, not skipped');

  const launched = new LevelTrigger([5, 10, 20, 80, 90, 95]);
  assert.equal(launched.update(0.93), null, 'already at 93% on launch: no burst of alerts');
  assert.deepEqual(launched.update(0.96), { side: 'high', level: 95 }, 'but the next level still fires');
});

await test('trigger: only the levels asked for (4H at 5 and 95)', () => {
  const t = new LevelTrigger([5, 95]);
  const hits = [0.5, 0.85, 0.92, 0.96, 0.4, 0.15, 0.04].map((p) => t.update(p)).filter(Boolean);
  assert.deepEqual(hits, [{ side: 'high', level: 95 }, { side: 'low', level: 5 }]);
});

/* --------------------------------------------- period boundaries & levels */

const { periodStart, periodLevels, updateCurrentExtremes } = await import('../renderer/sessions.js');

console.log('');
console.log('period boundaries');

const iso = (ms) => new Date(ms).toISOString().slice(0, 16);
const at = (s) => Date.parse(s);

await test('day starts at local midnight, through daylight saving', () => {
  assert.equal(iso(periodStart('D', 'utc', at('2026-10-05T12:00Z'))), '2026-10-05T00:00');
  // New York: EDT (UTC-4) until 2026-11-01, then EST (UTC-5).
  assert.equal(iso(periodStart('D', 'ny', at('2026-10-05T12:00Z'))), '2026-10-05T04:00');
  assert.equal(iso(periodStart('D', 'ny', at('2026-11-02T12:00Z'))), '2026-11-02T05:00');
  assert.equal(iso(periodStart('D', 'ny', at('2026-11-01T12:00Z'))), '2026-11-01T04:00', 'the switch day began in EDT');
  // Still the previous New York day at 03:00 UTC.
  assert.equal(iso(periodStart('D', 'ny', at('2026-10-05T03:00Z'))), '2026-10-04T04:00');
  // London: BST (UTC+1) until 2026-10-25, then GMT.
  assert.equal(iso(periodStart('D', 'london', at('2026-10-05T12:00Z'))), '2026-10-04T23:00');
  assert.equal(iso(periodStart('D', 'london', at('2026-10-26T12:00Z'))), '2026-10-26T00:00');
  // Already the next London day at 23:30 UTC in summer.
  assert.equal(iso(periodStart('D', 'london', at('2026-10-05T23:30Z'))), '2026-10-05T23:00');
});

await test('weeks start Monday, months the 1st; shifts step whole periods', () => {
  assert.equal(iso(periodStart('W', 'ny', at('2026-10-07T12:00Z'))), '2026-10-05T04:00', 'Wednesday -> Monday');
  assert.equal(iso(periodStart('W', 'ny', at('2026-10-05T03:00Z'))), '2026-09-28T04:00', 'Sunday night NY is last week');
  assert.equal(iso(periodStart('W', 'ny', at('2026-11-04T12:00Z'))), '2026-11-02T05:00', 'first week after the switch');
  assert.equal(iso(periodStart('W', 'ny', at('2026-11-04T12:00Z'), -1)), '2026-10-26T04:00', 'previous week, before it');
  assert.equal(iso(periodStart('M', 'ny', at('2026-11-15T12:00Z'))), '2026-11-01T04:00');
  assert.equal(iso(periodStart('M', 'ny', at('2026-11-15T12:00Z'), -1)), '2026-10-01T04:00');
  assert.equal(iso(periodStart('M', 'london', at('2026-11-15T12:00Z'))), '2026-11-01T00:00');
  assert.equal(iso(periodStart('M', 'utc', at('2026-01-10T00:00Z'), -1)), '2025-12-01T00:00', 'across a year');
  assert.equal(iso(periodStart('D', 'utc', at('2026-03-01T05:00Z'), -1)), '2026-02-28T00:00');
});

await test('stock-market opens: 09:30 New York, 08:00 London, through daylight saving', () => {
  // US open, EDT: 13:30 UTC (21:30 Taipei). Before it, the session is still yesterday's.
  assert.equal(iso(periodStart('D', 'nyse', at('2026-10-05T14:00Z'))), '2026-10-05T13:30');
  assert.equal(iso(periodStart('D', 'nyse', at('2026-10-05T12:00Z'))), '2026-10-04T13:30');
  // EST from 11/1: 14:30 UTC (22:30 Taipei).
  assert.equal(iso(periodStart('D', 'nyse', at('2026-11-09T15:00Z'))), '2026-11-09T14:30');
  // Weekends count: a Saturday has its own 09:30.
  assert.equal(iso(periodStart('D', 'nyse', at('2026-10-10T15:00Z'))), '2026-10-10T13:30');
  // Monday before the open is still last week; the 1st before the open, last month.
  assert.equal(iso(periodStart('W', 'nyse', at('2026-10-05T12:00Z'))), '2026-09-28T13:30');
  assert.equal(iso(periodStart('W', 'nyse', at('2026-10-05T14:00Z'))), '2026-10-05T13:30');
  assert.equal(iso(periodStart('M', 'nyse', at('2026-11-01T12:00Z'))), '2026-10-01T13:30');
  assert.equal(iso(periodStart('M', 'nyse', at('2026-11-01T15:00Z'))), '2026-11-01T14:30', 'the 1st, in EST');
  // London open: 07:00 UTC in BST (15:00 Taipei), 08:00 UTC in GMT (16:00 Taipei).
  assert.equal(iso(periodStart('D', 'lse', at('2026-10-05T09:00Z'))), '2026-10-05T07:00');
  assert.equal(iso(periodStart('D', 'lse', at('2026-10-05T06:00Z'))), '2026-10-04T07:00');
  assert.equal(iso(periodStart('D', 'lse', at('2026-10-28T09:00Z'))), '2026-10-28T08:00', 'UK already on GMT');
  // The week between the two switches: London at 08:00 UTC, New York still 13:30.
  assert.equal(iso(periodStart('D', 'nyse', at('2026-10-28T15:00Z'))), '2026-10-28T13:30');
});

await test('levels at the US open come from 30m bars', () => {
  const t0 = at('2026-09-01T00:00Z') / 1000;
  const now = at('2026-10-07T15:10Z');
  const bars = [];
  for (let t = t0, i = 0; t * 1000 <= now; t += 1800, i++) {
    bars.push({ time: t, open: i, high: i + 0.5, low: i - 0.5, close: i + 0.2 });
  }
  const levels = periodLevels(bars, { anchor: 'nyse', opens: true, previous: true, now });
  const by = Object.fromEntries(levels.map((l) => [l.id, l]));
  const half = (s) => (at(s) / 1000 - t0) / 1800;
  assert.equal(by['D-open'].price, half('2026-10-07T13:30Z'));
  assert.equal(by['D-open'].label, '日開 美股');
  assert.equal(by['D-prevLow'].price, half('2026-10-06T13:30Z') - 0.5, 'yesterday from its 09:30');
  assert.equal(by['D-prevHigh'].price, half('2026-10-07T13:00Z') + 0.5, 'to the last half hour before this open');
});

await test('levels: open at the boundary, previous and current extremes', () => {
  // Hourly bars from 2026-09-01 to 2026-10-07 12:00Z; price = hours since start.
  const t0 = at('2026-09-01T00:00Z') / 1000;
  const now = at('2026-10-07T12:30Z');
  const bars = [];
  for (let t = t0, i = 0; t * 1000 <= now; t += 3600, i++) {
    bars.push({ time: t, open: i, high: i + 0.5, low: i - 0.5, close: i + 0.2 });
  }
  const levels = periodLevels(bars, { anchor: 'ny', opens: true, previous: true, current: true, now });
  const by = Object.fromEntries(levels.map((l) => [l.id, l]));
  const hour = (s) => (at(s) / 1000 - t0) / 3600;

  assert.equal(by['D-open'].price, hour('2026-10-07T04:00Z'), 'NY midnight, not UTC midnight');
  assert.equal(by['D-open'].label, '日開 紐');
  assert.equal(by['D-prevHigh'].price, hour('2026-10-07T03:00Z') + 0.5, 'last hour of the previous NY day');
  assert.equal(by['D-prevLow'].price, hour('2026-10-06T04:00Z') - 0.5, 'first hour of it');
  assert.equal(by['D-high'].price, bars[bars.length - 1].high);
  assert.equal(by['W-open'].price, hour('2026-10-05T04:00Z'));
  assert.equal(by['M-open'].price, hour('2026-10-01T04:00Z'));
  assert.equal(by['M-prevLow'].price, hour('2026-09-01T04:00Z') - 0.5, 'September in New York starts at 04:00 UTC');
  assert.equal(by['M-prevLow'].time, at('2026-09-01T04:00Z') / 1000, 'and the line starts where the low was made');

  const only = periodLevels(bars, { anchor: 'utc', periods: ['W'], opens: true, now });
  assert.deepEqual(only.map((l) => l.id), ['W-open']);
  assert.equal(only[0].label, '週開', 'UTC needs no tag');
});

await test('a previous period not fully loaded is left out, not understated', () => {
  const now = at('2026-10-07T12:00Z');
  const bars = [{ time: at('2026-10-06T12:00Z') / 1000, open: 1, high: 2, low: 0, close: 1 }];
  const levels = periodLevels(bars, { anchor: 'utc', previous: true, opens: false, now });
  assert.ok(!levels.some((l) => l.id === 'D-prevHigh'), 'only half of yesterday is here');
});

await test('live bars move the current high and low, and only those', () => {
  const levels = [
    { id: 'D-high', kind: 'high', price: 100, time: 1 },
    { id: 'D-low', kind: 'low', price: 90, time: 1 },
    { id: 'D-prevHigh', kind: 'prevHigh', price: 105, time: 0 },
  ];
  assert.equal(updateCurrentExtremes(levels, { time: 2, high: 99, low: 91 }), null, 'nothing new');
  const next = updateCurrentExtremes(levels, { time: 3, high: 110, low: 95 });
  assert.equal(next[0].price, 110);
  assert.equal(next[0].time, 3);
  assert.equal(next[2].price, 105, 'yesterday is history');
});

/* ------------------------------------------------------ volume profile */

const { buildProfile, sessionBounds, buildPeriodProfiles, PERIOD_4H } = await import('../renderer/volume-profile.js');

console.log('');
console.log('volume profile');

await test('volume is redistributed across rows, never created or lost', async () => {
  const bars = Array.from({ length: 300 }, (_, i) => {
    const base = 100 + Math.sin(i / 20) * 8;
    return { time: 1700000000 + i * 60, open: base, high: base + 1.5, low: base - 1.5,
             close: base + 0.2, volume: 3 + (i % 11) };
  });
  const p = buildProfile(bars, 24);
  const fromRows = p.rows.reduce((sum, r) => sum + r.volume, 0);
  const fromBars = bars.reduce((sum, b) => sum + b.volume, 0);
  assert.ok(Math.abs(fromRows - fromBars) < 1e-9, `rows ${fromRows} vs bars ${fromBars}`);
  assert.equal(p.rows.length, 24);
});

await test('the POC is the heaviest row, and sits inside the value area', async () => {
  // A deliberate pile of volume in one narrow band.
  const bars = [];
  for (let i = 0; i < 120; i++) {
    const heavy = i % 3 === 0;
    const base = heavy ? 100 : 108;
    bars.push({ time: 1700000000 + i * 60, open: base, high: base + 0.4, low: base - 0.4,
                close: base, volume: heavy ? 50 : 1 });
  }
  const p = buildProfile(bars, 20);
  const peak = p.rows.reduce((a, b) => (b.volume > a.volume ? b : a));
  assert.ok(p.poc >= peak.priceLow && p.poc <= peak.priceHigh, 'POC must fall in the heaviest row');
  assert.ok(p.poc >= p.val && p.poc <= p.vah, 'POC must lie within the value area');
});

await test('the value area covers ~70% of volume and is contiguous', async () => {
  const bars = Array.from({ length: 400 }, (_, i) => {
    const base = 50 + Math.sin(i / 9) * 5;
    return { time: 1700000000 + i * 60, open: base, high: base + 0.8, low: base - 0.8,
             close: base, volume: 1 + (i % 7) };
  });
  const p = buildProfile(bars, 30);
  const inside = p.rows.filter((r) => r.inValueArea);
  const share = inside.reduce((s, r) => s + r.volume, 0) / p.total;
  assert.ok(share >= 0.7, `value area holds ${(share * 100).toFixed(1)}%, must reach 70%`);
  // It grows outward from the POC, so the flagged rows must be one unbroken run.
  const indices = inside.map((r) => r.index);
  assert.equal(indices[indices.length - 1] - indices[0], indices.length - 1, 'value area must be contiguous');
});

await test('a session is one UTC day, matching the exchange day boundary', async () => {
  const { start, end } = sessionBounds(Date.UTC(2026, 8, 23, 17, 42, 11));
  assert.equal(new Date(start).toISOString(), '2026-09-23T00:00:00.000Z');
  assert.equal(end - start, 86400000);
});

await test('degenerate input yields no profile rather than a broken one', async () => {
  assert.equal(buildProfile([], 10), null);
  assert.equal(buildProfile(null, 10), null);
  // Every bar at one price: no range to bucket.
  const flat = [{ time: 1, open: 5, high: 5, low: 5, close: 5, volume: 9 }];
  assert.equal(buildProfile(flat, 10), null);
});

await test('per-4h profiles land on the exchange 4h boundaries', async () => {
  // 12h of 5m bars starting mid-block, so the first and last blocks are partial.
  const t0 = Date.UTC(2026, 8, 23, 2, 0) / 1000;
  const bars = Array.from({ length: 144 }, (_, i) => {
    const base = 100 + Math.sin(i / 7) * 3;
    return { time: t0 + i * 300, open: base, high: base + 0.6, low: base - 0.6, close: base, volume: 2 };
  });
  const blocks = buildPeriodProfiles(bars, PERIOD_4H, 12);
  const hours = blocks.map((b) => new Date(b.start * 1000).getUTCHours());
  assert.deepEqual(hours, [0, 4, 8, 12], 'blocks must open at 00/04/08/12 UTC');
  for (const b of blocks) assert.equal(b.end - b.start, PERIOD_4H);
});

await test('per-4h profiles conserve volume block by block', async () => {
  const t0 = Date.UTC(2026, 8, 23, 0, 0) / 1000;
  const bars = Array.from({ length: 96 }, (_, i) => {
    const base = 50 + (i % 13);
    return { time: t0 + i * 300, open: base, high: base + 1, low: base - 1, close: base, volume: 1 + (i % 5) };
  });
  const blocks = buildPeriodProfiles(bars, PERIOD_4H, 10);
  assert.equal(blocks.length, 2);
  for (const b of blocks) {
    const inBlock = bars.filter((x) => x.time >= b.start && x.time < b.end);
    const want = inBlock.reduce((s, x) => s + x.volume, 0);
    const got = b.profile.rows.reduce((s, r) => s + r.volume, 0);
    assert.ok(Math.abs(want - got) < 1e-9, `block ${b.start}: ${got} vs ${want}`);
  }
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
