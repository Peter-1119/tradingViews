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
