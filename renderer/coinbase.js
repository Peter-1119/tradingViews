/**
 * Coinbase: the US dollar spot market, read against Binance.
 *
 * Two readings, both about whether US money is buying:
 *
 *   premium   Coinbase's dollar price over Binance's spot price, in percent.
 *             Positive: buyers on Coinbase pay up -- US demand leads.
 *             Binance quotes in USDT, which itself drifts a few hundredths of
 *             a percent off the dollar, as much as the premium moves on a
 *             quiet day; so Binance's price is first turned into dollars at
 *             Coinbase's own USDT-USD price:
 *
 *               premium = cb / (binance × usdt) − 1
 *
 *             (Charts that skip the correction read a little differently.)
 *
 *   CVD       Coinbase's own cumulative volume delta, from its trades, which
 *             say which side was the taker. Coinbase's candles do not, so
 *             this is only as old as the app's record of the trades, and a
 *             few hours fetched back each time it starts.
 *
 * Coinbase reports a trade's `side` as the maker's: 'sell' means a resting
 * sell was hit, so the taker bought.
 */

import { barDelta } from './cvd.js';

export const CB_REST = 'https://api.exchange.coinbase.com';
export const CB_WS = 'wss://ws-feed.exchange.coinbase.com';
/** Candle sizes Coinbase serves, in seconds. 300 to a request. */
export const GRANULARITIES = [60, 300, 900, 3600, 21600, 86400];
export const CANDLES_PER_PAGE = 300;
/** Trade buckets the hub hands the cards: never coarser than an hour. */
const FLOW_STEPS = [60, 300, 900, 3600];

/** The largest candle that divides a bar exactly; null under a minute. */
export function granularityFor(stepSec) {
  let best = null;
  for (const g of GRANULARITIES) if (g <= stepSec && stepSec % g === 0) best = g;
  return best;
}

/**
 * USDT-USD barely moves within an hour, so it is read in hours or coarser:
 * the coarsest needed to cover `spanSec` in two pages. Bars between its
 * candles carry the last reading.
 */
export function usdtGranularity(g, spanSec) {
  for (const x of GRANULARITIES) {
    if (x >= Math.max(g, 3600) && spanSec / x <= 2 * CANDLES_PER_PAGE) return x;
  }
  return GRANULARITIES[GRANULARITIES.length - 1];
}

/** The trade bucket for a card's bars: whole minutes, at most an hour. */
export function flowStepFor(stepSec) {
  let best = null;
  for (const s of FLOW_STEPS) if (s <= stepSec && stepSec % s === 0) best = s;
  return best;
}

/**
 * A Binance symbol to its Coinbase dollar pair: BTCUSDT -> BTC-USD, and
 * 1000PEPEUSDT -> PEPE-USD with `factor` 1000 (Binance prices a thousand).
 * `quote` is the Binance quote, which decides the stablecoin correction.
 * @param {Set<string>} products  Coinbase product ids that trade.
 * @returns {{product: string, factor: number, quote: string}|null}
 */
export function productFor(symbol, products) {
  const m = /^(1(?:0{3})+)?([A-Z0-9]+?)(USDT|USDC|FDUSD)$/.exec(String(symbol || '').toUpperCase());
  if (!m) return null;
  const product = `${m[2]}-USD`;
  if (!products || !products.has(product)) return null;
  return { product, factor: m[1] ? Number(m[1]) : 1, quote: m[3] };
}

/** Product ids that trade, from GET /products. */
export function tradingProducts(list) {
  const out = new Set();
  if (!Array.isArray(list)) return out;
  for (const p of list) {
    if (p && p.quote_currency === 'USD' && p.status === 'online' && !p.trading_disabled) out.add(p.id);
  }
  return out;
}

/* ------------------------------------------------------------- trades */

/** A websocket `match`, or null. */
export function parseMatch(msg) {
  if (!msg || msg.type !== 'match') return null;
  return trade(msg.trade_id, msg.time, msg.price, msg.size, msg.side, msg.product_id);
}

/** A row of GET /products/{id}/trades, or null. */
export function parseTrade(row, product) {
  if (!row) return null;
  return trade(row.trade_id, row.time, row.price, row.size, row.side, product);
}

function trade(id, time, price, size, side, product) {
  const t = Date.parse(time);
  const p = Number(price);
  const q = Number(size);
  if (!Number.isFinite(t) || !(p > 0) || !(q > 0)) return null;
  return { id: Number(id), product, t, price: p, size: q, buy: side === 'sell' };
}

/**
 * A trade into its bucket of `step` seconds, in the shape of a Binance bar:
 * volume and taker-buy volume in coins, quote volume in dollars. Trades may
 * come in any order (the REST history runs backwards), so open and close are
 * kept by time.
 * @param {Map<number, object>} buckets  bucket time (s) -> bar, changed in place
 */
export function addTrade(buckets, tr, step = 60) {
  const time = Math.floor(tr.t / 1000 / step) * step;
  let b = buckets.get(time);
  if (!b) {
    b = { time, open: tr.price, high: tr.price, low: tr.price, close: tr.price, volume: 0, buyVolume: 0, quoteVolume: 0, firstT: tr.t, lastT: tr.t };
    buckets.set(time, b);
  }
  if (tr.price > b.high) b.high = tr.price;
  if (tr.price < b.low) b.low = tr.price;
  if (tr.t >= b.lastT) {
    b.lastT = tr.t;
    b.close = tr.price;
  }
  if (tr.t < b.firstT) {
    b.firstT = tr.t;
    b.open = tr.price;
  }
  b.volume += tr.size;
  if (tr.buy) b.buyVolume += tr.size;
  b.quoteVolume += tr.size * tr.price;
  return b;
}

/** Minutes rolled into buckets of `step` seconds (a multiple of 60), oldest first. */
export function rollUp(minutes, step) {
  if (step === 60) return minutes.map(plain);
  const out = new Map();
  for (const m of minutes) {
    const time = Math.floor(m.time / step) * step;
    const b = out.get(time);
    if (!b) out.set(time, { ...plain(m), time });
    else merge(b, m);
  }
  return [...out.values()].sort((a, b) => a.time - b.time);
}

function plain(m) {
  return { time: m.time, open: m.open, high: m.high, low: m.low, close: m.close, volume: m.volume, buyVolume: m.buyVolume, quoteVolume: m.quoteVolume };
}

/** `m` (later) folded into `b`. */
function merge(b, m) {
  b.high = Math.max(b.high, m.high);
  b.low = Math.min(b.low, m.low);
  b.close = m.close;
  b.volume += m.volume;
  b.buyVolume += m.buyVolume;
  b.quoteVolume += m.quoteVolume;
}

/* ------------------------------------------------------------ candles */

/** GET /products/{id}/candles rows ([time, low, high, open, close, volume], newest first) -> {time, close}, oldest first. */
export function parseCandles(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 5) continue;
    const time = Number(r[0]);
    const close = Number(r[4]);
    if (Number.isFinite(time) && close > 0) out.push({ time, close });
  }
  return out.sort((a, b) => a.time - b.time);
}

/* ---------------------------------------------------------- per bar */

/** Index of the last bar opening at or before `sec`, or -1. */
function barAt(times, sec) {
  let lo = 0;
  let hi = times.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= sec) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * Points ({time, ...}, oldest first) to the chart's bars: each bar gets the
 * last point that opened inside it -- for candles, the one that closes with
 * the bar. A point before the first bar, or a bar or more past the last, is
 * left out.
 * @returns {Map<number, object>} bar time -> point
 */
export function lastPerBar(points, times, stepSec) {
  const out = new Map();
  if (!times.length) return out;
  const end = times[times.length - 1] + stepSec;
  for (const p of points) {
    if (p.time >= end) break;
    const i = barAt(times, p.time);
    if (i >= 0) out.set(times[i], p);
  }
  return out;
}

/**
 * The premium per bar, in percent: Coinbase's close (times `factor`) over
 * Binance's close in dollars. USDT-USD runs on from its last reading where a
 * bar has none; with no reading at all (a USDC pair, or none fetched yet) it
 * is taken as 1.
 * @param {number[]} times  bar opens
 * @param {Map<number, number>} binance  bar time -> close
 * @param {object[]} cbCandles  {time, close}, oldest first
 * @param {object[]|null} usdtCandles  {time, close}, oldest first, or null
 * @returns {Map<number, number>} bar time -> premium (%)
 */
export function premiumPerBar(times, stepSec, binance, cbCandles, usdtCandles, factor = 1) {
  const cb = lastPerBar(cbCandles, times, stepSec);
  const usdt = usdtCandles ? lastPerBar(usdtCandles, times, stepSec) : new Map();
  const out = new Map();
  let lastUsdt = usdtCandles && usdtCandles.length ? usdtCandles[0].close : 1;
  for (const time of times) {
    const u = usdt.get(time);
    if (u) lastUsdt = u.close;
    const c = cb.get(time);
    const b = binance.get(time);
    if (!c || !(b > 0) || !(lastUsdt > 0)) continue;
    out.set(time, ((c.close * factor) / (b * lastUsdt) - 1) * 100);
  }
  return out;
}

/**
 * Coinbase's CVD on the chart's bars, in dollars: trade buckets summed per
 * bar, then the running sum of each bar's delta. Bars before the first
 * bucket are NaN (no record); bars after it with none add nothing.
 * @param {object[]} buckets  {time, volume, buyVolume, quoteVolume, close}, oldest first
 * @returns {number[]}
 */
export function cvdPerBar(buckets, times, stepSec) {
  const per = new Map();
  const end = times.length ? times[times.length - 1] + stepSec : -Infinity;
  for (const b of buckets) {
    if (b.time >= end) break;
    const i = barAt(times, b.time);
    if (i < 0) continue;
    const t = times[i];
    const acc = per.get(t);
    if (!acc) per.set(t, { volume: b.volume, buyVolume: b.buyVolume, quoteVolume: b.quoteVolume, close: b.close });
    else {
      acc.volume += b.volume;
      acc.buyVolume += b.buyVolume;
      acc.quoteVolume += b.quoteVolume;
      acc.close = b.close;
    }
  }
  const out = new Array(times.length).fill(NaN);
  let sum = 0;
  let started = false;
  for (let i = 0; i < times.length; i++) {
    const bar = per.get(times[i]);
    if (bar) {
      started = true;
      const d = barDelta(bar);
      if (Number.isFinite(d)) sum += d;
    }
    if (started) out[i] = sum;
  }
  return out;
}
