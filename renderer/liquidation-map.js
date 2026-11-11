/**
 * Where the positions still open would be liquidated -- an estimate.
 *
 * No exchange publishes its positions' liquidation prices. What it does
 * publish is open interest, and with each bar's taker split that says how
 * many contracts were opened or closed, by whom and at about what price. The
 * same reasoning third-party heatmaps use, written out so it can be checked:
 *
 *   1. OI up by Δ in a bar: Δ new longs and Δ new shorts, at the bar's VWAP.
 *      The side that crossed the spread counts in full; the resting side
 *      (often a hedged market maker, rarely liquidated) at PASSIVE of it.
 *      With b the taker-buy share of the bar's volume:
 *        longs  = Δ (b + (1 − b) · PASSIVE),  shorts = Δ (1 − b + b · PASSIVE)
 *   2. Each opening is spread over LEVERAGE, and each part's liquidation
 *      price is entry · (1 − 1/L + MMR) for a long, entry · (1 + 1/L − MMR)
 *      for a short (isolated margin; cross margin sits further out).
 *   3. OI down by Δ: Δ longs and Δ shorts closed, weighted the other way
 *      round (taker sells close longs), newest positions first (see
 *      buildLiquidationMap for why).
 *   4. A bar whose low reaches a long level, or high a short level, wipes it:
 *      those positions were liquidated, or would have been.
 *
 * What it cannot know: who used which leverage, positions opened before its
 * history starts (30 days at most, Binance's OI history), and cross-margin
 * accounts kept alive by other balances. It is the shape of the fuel, not a
 * count of it; recorded liquidations (liquidations.js) are the check.
 */

/** Share of each opening at each leverage. Weights sum to 1. */
export const LEVERAGE = Object.freeze([
  [100, 0.05],
  [50, 0.1],
  [25, 0.2],
  [20, 0.15],
  [10, 0.3],
  [5, 0.2],
]);
/** Maintenance margin rate, roughly Binance's lowest tiers. */
export const MMR = 0.005;
/** How much of the resting side of a trade is counted as liquidatable. */
export const PASSIVE = 0.5;
/** Grid cell, as a share of the reference price: 0.1%, $75 on BTC at 75K. */
const CELL = 0.001;
/** The grid spans the reference price times these. */
const SPAN_LO = 0.3;
const SPAN_HI = 2.2;

export class LiquidationMap {
  /** @param {number} refPrice  sets the grid; the latest close is right */
  constructor(refPrice) {
    this.step = refPrice * CELL;
    this.base = refPrice * SPAN_LO;
    this.size = Math.ceil((refPrice * (SPAN_HI - SPAN_LO)) / this.step) + 1;
    /** Coins whose long (or short) would be liquidated in each cell, before the multipliers. */
    this.long = new Float64Array(this.size);
    this.short = new Float64Array(this.size);
    // Pro-rata closing scales every cell at once through these.
    this.kLong = 1;
    this.kShort = 1;
    this.totalLong = 0;
    this.totalShort = 0;
    // Nonzero cells lie below this for longs, above this for shorts.
    this.longTop = -1;
    this.shortBottom = this.size;
    /** Bars folded in, and the last one's time (seconds). */
    this.bars = 0;
    this.lastTime = 0;
  }

  index(price) {
    return Math.floor((price - this.base) / this.step);
  }

  priceOf(index) {
    return this.base + (index + 0.5) * this.step;
  }

  /** Coins of longs that would be liquidated at `price`. */
  addLong(price, coins) {
    const i = this.index(price);
    if (!(coins > 0) || i < 0 || i >= this.size) return;
    this.long[i] += coins / this.kLong;
    this.totalLong += coins;
    if (i > this.longTop) this.longTop = i;
  }

  addShort(price, coins) {
    const i = this.index(price);
    if (!(coins > 0) || i < 0 || i >= this.size) return;
    this.short[i] += coins / this.kShort;
    this.totalShort += coins;
    if (i < this.shortBottom) this.shortBottom = i;
  }

  /** One opening at `entry`, spread over the leverage tiers. */
  open(entry, longs, shorts) {
    for (const [lev, w] of LEVERAGE) {
      this.addLong(longPrice(entry, lev), longs * w);
      this.addShort(shortPrice(entry, lev), shorts * w);
    }
  }

  resetSide(side) {
    if (side === 'long') {
      this.long.fill(0);
      this.kLong = 1;
      this.totalLong = 0;
      this.longTop = -1;
    } else {
      this.short.fill(0);
      this.kShort = 1;
      this.totalShort = 0;
      this.shortBottom = this.size;
    }
  }

  /** Price reached `high` and `low`: whatever lay in between is gone. */
  touch(high, low) {
    if (Number.isFinite(low)) {
      const stop = Math.max(0, this.index(low));
      for (let i = Math.min(this.longTop, this.size - 1); i >= stop; i--) {
        if (this.long[i]) {
          this.totalLong -= this.long[i] * this.kLong;
          this.long[i] = 0;
        }
      }
      if (this.longTop >= stop) this.longTop = stop - 1;
    }
    if (Number.isFinite(high)) {
      const stop = Math.min(this.size - 1, this.index(high));
      for (let i = Math.max(this.shortBottom, 0); i <= stop; i++) {
        if (this.short[i]) {
          this.totalShort -= this.short[i] * this.kShort;
          this.short[i] = 0;
        }
      }
      if (this.shortBottom <= stop) this.shortBottom = stop + 1;
    }
    if (this.totalLong < 0) this.totalLong = 0;
    if (this.totalShort < 0) this.totalShort = 0;
  }

  /**
   * USDT waiting in each of `rows` equal rows between two prices, for drawing.
   * @returns {{lo, hi, rows: {price, long, short}[], max}}
   */
  rows(lo, hi, count) {
    const out = [];
    let max = 0;
    if (!(hi > lo) || !(count > 0)) return { lo, hi, rows: out, max };
    const h = (hi - lo) / count;
    for (let r = 0; r < count; r++) out.push({ price: lo + (r + 0.5) * h, long: 0, short: 0 });
    const i0 = Math.max(0, this.index(lo));
    const i1 = Math.min(this.size - 1, this.index(hi));
    for (let i = i0; i <= i1; i++) {
      const L = this.long[i];
      const S = this.short[i];
      if (!L && !S) continue;
      const p = this.priceOf(i);
      const r = Math.min(count - 1, Math.max(0, Math.floor((p - lo) / h)));
      if (L) out[r].long += L * this.kLong * p;
      if (S) out[r].short += S * this.kShort * p;
    }
    for (const row of out) max = Math.max(max, row.long, row.short);
    return { lo, hi, rows: out, max };
  }

  /**
   * The nearest big cluster on each side of `price`, within `range` (a share,
   * 0.12 = ±12%). Each cell is summed with its neighbours over `width` (a
   * share) so one cell does not win on its own; of the peaks that hold at
   * least `major` of the side's largest, the one closest to the price is
   * named. The closest big pool is what price can reach first, and two pools
   * of nearly equal size would otherwise swap the name back and forth.
   * @returns {{above: {price, usd}|null, below: {price, usd}|null}}
   */
  clusters(price, range = 0.12, width = 0.006, major = 0.6) {
    const half = Math.max(1, Math.round((price * width) / this.step / 2));
    const at = this.index(price);
    const reach = Math.round((price * range) / this.step);
    // Window sums, ordered outward from the price.
    const sums = (cells, k, dir) => {
      const value = (i) => (i >= 0 && i < this.size ? cells[i] * k * this.priceOf(i) : 0);
      const out = [];
      for (let step = 1; step <= reach; step++) {
        const c = at + dir * step;
        if (c < 0 || c >= this.size) break;
        let sum = 0;
        for (let i = c - half; i <= c + half; i++) sum += value(i);
        out.push({ c, sum });
      }
      return out;
    };
    const pick = (list) => {
      let max = 0;
      for (const x of list) max = Math.max(max, x.sum);
      if (!(max > 0)) return null;
      for (let j = 0; j < list.length; j++) {
        const x = list[j];
        const prev = j > 0 ? list[j - 1].sum : 0;
        const next = j + 1 < list.length ? list[j + 1].sum : 0;
        if (!(x.sum >= max * major && x.sum >= prev && x.sum >= next)) continue;
        // A flat top (a lone pool inside the window) names its middle.
        let k = j;
        while (k + 1 < list.length && list[k + 1].sum >= x.sum * (1 - 1e-9)) k++;
        const mid = list[(j + k) >> 1];
        return { price: this.priceOf(mid.c), usd: x.sum };
      }
      return null;
    };
    return {
      above: pick(sums(this.short, this.kShort, 1)),
      below: pick(sums(this.long, this.kLong, -1)),
    };
  }

  /** USDT still open on each side, at the price it would be liquidated. */
  totals() {
    let long = 0;
    let short = 0;
    for (let i = 0; i < this.size; i++) {
      if (this.long[i]) long += this.long[i] * this.kLong * this.priceOf(i);
      if (this.short[i]) short += this.short[i] * this.kShort * this.priceOf(i);
    }
    return { long, short };
  }
}

export const longPrice = (entry, lev) => entry * (1 - 1 / lev + MMR);
export const shortPrice = (entry, lev) => entry * (1 + 1 / lev - MMR);

/**
 * The map from Binance's history: bars (seconds, oldest first, each `stepSec`
 * long) and OI rows ([{time (ms), value (coins)}]) on the same grid.
 *
 * Openings are kept as cohorts, one per bar, and closings come off the
 * newest first: most open interest that comes and goes within the month is
 * short-term trading, opened and closed in hours, while the positions that
 * stay are the ones that were not closed. Taken pro rata instead, thirty days
 * of five-minute churn wore every old position down to almost nothing (on
 * BTC it left $0.3B of $7.5B). Then each cohort's tiers are kept only if no
 * later bar reached them.
 */
export function buildLiquidationMap(bars, oiRows, stepSec = 300) {
  if (!bars.length) return null;
  const ref = bars[bars.length - 1].close;
  if (!(ref > 0)) return null;
  const oiAt = new Map();
  for (const row of oiRows) if (Number.isFinite(row.value)) oiAt.set(Math.round(row.time / 1000) * 1000, row.value);

  const n = bars.length;
  const entry = new Float64Array(n);
  const longs = new Float64Array(n);
  const shorts = new Float64Array(n);
  const longStack = [];
  const shortStack = [];
  const take = (stack, amounts, qty) => {
    while (qty > 1e-12 && stack.length) {
      const c = stack[stack.length - 1];
      const used = Math.min(amounts[c], qty);
      amounts[c] -= used;
      qty -= used;
      if (amounts[c] <= 1e-12) stack.pop();
    }
  };
  for (let i = 0; i < n; i++) {
    const bar = bars[i];
    const a = oiAt.get(bar.time * 1000);
    const b = oiAt.get((bar.time + stepSec) * 1000);
    if (!Number.isFinite(a) || !Number.isFinite(b) || !(bar.volume > 0)) continue;
    const d = b - a;
    const buy = Number.isFinite(bar.buyVolume) ? Math.min(1, Math.max(0, bar.buyVolume / bar.volume)) : 0.5;
    if (d > 0) {
      entry[i] = bar.quoteVolume > 0 ? bar.quoteVolume / bar.volume : (bar.high + bar.low) / 2;
      longs[i] = d * (buy + (1 - buy) * PASSIVE);
      shorts[i] = d * (1 - buy + buy * PASSIVE);
      longStack.push(i);
      shortStack.push(i);
    } else if (d < 0) {
      // Taker sells close longs, taker buys close shorts.
      take(longStack, longs, -d * (1 - buy + buy * PASSIVE));
      take(shortStack, shorts, -d * (buy + (1 - buy) * PASSIVE));
    }
  }

  // The lowest low and highest high from each bar on: what each level faced.
  const minLow = new Float64Array(n);
  const maxHigh = new Float64Array(n);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = n - 1; i >= 0; i--) {
    lo = Math.min(lo, bars[i].low);
    hi = Math.max(hi, bars[i].high);
    minLow[i] = lo;
    maxHigh[i] = hi;
  }

  const map = new LiquidationMap(ref);
  for (let i = 0; i < n; i++) {
    if (!(longs[i] > 0) && !(shorts[i] > 0)) continue;
    for (const [lev, w] of LEVERAGE) {
      const lp = longPrice(entry[i], lev);
      const sp = shortPrice(entry[i], lev);
      if (longs[i] > 0 && minLow[i] > lp) map.addLong(lp, longs[i] * w);
      if (shorts[i] > 0 && maxHigh[i] < sp) map.addShort(sp, shorts[i] * w);
    }
  }
  map.bars = n;
  map.lastTime = bars[n - 1].time;
  return map;
}
