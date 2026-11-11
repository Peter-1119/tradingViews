/**
 * Forced liquidations on Binance, Bybit and OKX: what each exchange sends,
 * read into one shape, and how they are kept and summed per bar.
 *
 * One event:
 *   {t (ms), ex: 'binance'|'bybit'|'okx', side: 'long'|'short', price, qty, usd}
 * `side` is the position that was closed out. A long's liquidation is a forced
 * *sell*, a short's a forced *buy*; `qty` is in the units of the Binance symbol
 * the card shows (1000PEPEUSDT counts thousands of PEPE), and `price` on its
 * scale, so every exchange lands on the same chart.
 *
 * What each exchange sends, and what it leaves out:
 *   - Binance `!forceOrder@arr`: every symbol on one stream, but at most the
 *     latest liquidation per symbol per second -- in a cascade it misses most
 *     of them. `S` is the order's side: SELL closes a long.
 *   - Bybit `allLiquidation.{symbol}`: every liquidation, one topic per symbol.
 *     `S` is the *position's* side: Buy means a long was liquidated.
 *   - OKX `liquidation-orders`: every swap on one channel, sizes in contracts
 *     (ctVal coins each, from the instrument list). `side` sell closes a long.
 */

export const EXCHANGES = ['binance', 'bybit', 'okx'];
const EX_CODE = { binance: 1, bybit: 2, okx: 3 };
const EX_NAME = { 1: 'binance', 2: 'bybit', 3: 'okx' };

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

/** A finished event, or null when a field is missing or nonsense. */
function event(t, ex, side, price, qty) {
  if (!(t > 0) || !(price > 0) || !(qty > 0) || (side !== 'long' && side !== 'short')) return null;
  return { t: Math.round(t), ex, side, price, qty, usd: price * qty };
}

/* ------------------------------------------------------------ symbols */

/**
 * Binance prices some small coins per thousand (1000PEPEUSDT, 1000000MOGUSDT).
 * Bybit lists most of them the same way; OKX lists the coin itself.
 * @returns {{base: string, factor: number}} e.g. {base: 'PEPE', factor: 1000}
 */
export function splitSymbol(symbol) {
  const s = String(symbol || '').toUpperCase();
  const m = /^(1(?:0{3})+)?([A-Z0-9]+?)USDT$/.exec(s);
  if (!m) return { base: s.replace(/USDT$/, ''), factor: 1 };
  return { base: m[2], factor: m[1] ? Number(m[1]) : 1 };
}

/** The OKX swap for a Binance perpetual: BTCUSDT -> BTC-USDT-SWAP. */
export function okxInstId(symbol) {
  return `${splitSymbol(symbol).base}-USDT-SWAP`;
}

/* ------------------------------------------------------------- parsers */

/**
 * One frame of Binance's `!forceOrder@arr`, bare or wrapped in {stream, data}.
 * @returns {{symbol: string, event: object}|null}
 */
export function parseBinance(msg) {
  const data = msg && msg.data ? msg.data : msg;
  const o = data && data.o;
  if (!o || !o.s) return null;
  const qty = num(o.z) > 0 ? num(o.z) : num(o.q);
  const price = num(o.ap) > 0 ? num(o.ap) : num(o.p);
  const side = o.S === 'SELL' ? 'long' : o.S === 'BUY' ? 'short' : '';
  const e = event(num(o.T) || num(data.E), 'binance', side, price, qty);
  return e ? { symbol: String(o.s).toUpperCase(), event: e } : null;
}

/**
 * One frame of Bybit's `allLiquidation.*`. Bybit's symbol is taken to be the
 * Binance one (they agree on BTCUSDT and on 1000PEPEUSDT alike).
 * @returns {{symbol: string, event: object}[]}
 */
export function parseBybit(msg) {
  if (!msg || !Array.isArray(msg.data) || !String(msg.topic || '').startsWith('allLiquidation.')) return [];
  const out = [];
  for (const d of msg.data) {
    const side = d.S === 'Buy' ? 'long' : d.S === 'Sell' ? 'short' : '';
    const e = event(num(d.T) || num(msg.ts), 'bybit', side, num(d.p), num(d.v));
    if (e && d.s) out.push({ symbol: String(d.s).toUpperCase(), event: e });
  }
  return out;
}

/**
 * One frame of OKX's `liquidation-orders`, kept only for the instruments in
 * `wanted`: instId -> {symbol (Binance), ctVal (coins per contract), factor}.
 * @returns {{symbol: string, event: object}[]}
 */
export function parseOkx(msg, wanted) {
  if (!msg || !Array.isArray(msg.data) || !wanted) return [];
  const out = [];
  for (const d of msg.data) {
    const target = wanted.get(d.instId);
    if (!target || !Array.isArray(d.details)) continue;
    for (const x of d.details) {
      const side = x.side === 'sell' ? 'long' : x.side === 'buy' ? 'short' : '';
      const coins = num(x.sz) * target.ctVal;
      const e = event(num(x.ts) || num(x.time), 'okx', side, num(x.bkPx) * target.factor, coins / target.factor);
      if (e) out.push({ symbol: target.symbol, event: e });
    }
  }
  return out;
}

/* ------------------------------------------------------------- storage */

/**
 * Bar-cache record <-> event. The cache keys records by time, so events in
 * the same millisecond on different exchanges or sides would overwrite each
 * other: each gets its own few microseconds (the code below), and the fields
 * still say which it is, so reading back never depends on the offset.
 *   time = ms / 1000 + code * 10µs, open = exchange, high = +1 long / -1 short,
 *   low = close = price, volume = qty, quoteVolume = USDT.
 */
export function toStored(e) {
  const code = EX_CODE[e.ex] || 0;
  const sideCode = e.side === 'long' ? 1 : -1;
  return {
    time: e.t / 1000 + (code * 2 + (sideCode > 0 ? 1 : 0)) * 1e-5,
    open: code,
    high: sideCode,
    low: e.price,
    close: e.price,
    volume: e.qty,
    buyVolume: NaN,
    quoteVolume: e.usd,
    closed: true,
  };
}

export function fromStored(r) {
  const price = Number.isFinite(r.close) ? r.close : r.low;
  return {
    t: Math.floor(r.time * 1000 + 1e-6),
    ex: EX_NAME[Math.round(r.open)] || 'binance',
    side: r.high > 0 ? 'long' : 'short',
    price,
    qty: r.volume,
    usd: Number.isFinite(r.quoteVolume) ? r.quoteVolume : r.volume * price,
  };
}

/**
 * Events from the same exchange, side and millisecond as one: Bybit and OKX
 * print a cascade as several in a frame, and the cache keeps one per key.
 */
export function mergeSameMs(events) {
  const byKey = new Map();
  for (const e of events) {
    const key = `${e.t}|${e.ex}|${e.side}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...e });
      continue;
    }
    const qty = prev.qty + e.qty;
    prev.price = (prev.price * prev.qty + e.price * e.qty) / qty;
    prev.qty = qty;
    prev.usd += e.usd;
  }
  return [...byKey.values()].sort((a, b) => a.t - b.t);
}

/* --------------------------------------------------------------- per bar */

/** First index with t >= ms. */
export function lowerBound(list, ms) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].t < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Liquidations summed per bar, over bars sorted by time (seconds) with each
 * bar ending where the next begins (the last at `lastEndSec`).
 * @returns {Map<number, {long, short, byEx: {[ex]: {long, short}}, count}>}
 *   USDT per bar time, bars with none left out
 */
export function sumPerBar(events, bars, lastEndSec = Infinity) {
  const out = new Map();
  if (!events.length || !bars.length) return out;
  let k = lowerBound(events, bars[0].time * 1000);
  for (let i = 0; i < bars.length && k < events.length; i++) {
    const end = (i + 1 < bars.length ? bars[i + 1].time : lastEndSec) * 1000;
    let cell = null;
    for (; k < events.length && events[k].t < end; k++) {
      const e = events[k];
      if (!cell) cell = { long: 0, short: 0, byEx: {}, count: 0 };
      cell[e.side] += e.usd;
      const ex = cell.byEx[e.ex] || (cell.byEx[e.ex] = { long: 0, short: 0 });
      ex[e.side] += e.usd;
      cell.count += 1;
    }
    if (cell) out.set(bars[i].time, cell);
  }
  return out;
}

/**
 * The size a bar's liquidations on one side must reach to be marked: the
 * value at which only the top `share` of bars that had any are larger. Each
 * side's sums are pooled, so a coin's own scale sets it, as with big orders.
 * @returns {number} USDT, Infinity when there is too little to rank
 */
export function markThreshold(perBar, share) {
  const sums = [];
  for (const cell of perBar.values()) {
    if (cell.long > 0) sums.push(cell.long);
    if (cell.short > 0) sums.push(cell.short);
  }
  if (sums.length < 10) return sums.length ? Math.max(...sums) * 0.5 : Infinity;
  sums.sort((a, b) => a - b);
  const idx = Math.min(sums.length - 1, Math.max(0, Math.floor(sums.length * (1 - share))));
  return sums[idx];
}
