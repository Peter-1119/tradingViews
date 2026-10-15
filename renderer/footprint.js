/**
 * Footprint, card side: the hub's per-minute records turned into what one
 * bar shows -- taker sells and taker buys per price row, the bar's delta, its
 * point of control, and the diagonal imbalances.
 *
 * Minutes arrive at the exchange's own price resolution (BTCUSDT perpetual:
 * 0.1, ~1300 prices a minute); a row on screen is a whole number of those,
 * chosen per frame so rows are as tall as the mode needs. Row edges sit on
 * multiples of the row size, so one price lands in the same row at every
 * zoom and in every bar.
 *
 * Imbalance is read diagonally, the way footprint charts conventionally do:
 * buyers lifting the offer at a price against sellers hitting the bid one row
 * *below* it -- those are the two sides that actually met as price moved
 * between the rows. A row's buying is an imbalance when it is `ratio` times
 * the selling one row down; its selling, when it is `ratio` times the buying
 * one row up.
 */

/** forming < closed but partial < closed and complete */
const rank = (rec) => (rec.closed ? (rec.complete ? 2 : 1) : 0);

/** A bar: sums of its minutes at one common price scale. */
export class FootprintBook {
  constructor() {
    /** minute (sec) -> packed record from the hub */
    this.minutes = new Map();
    /** barTime -> aggregated bar, dropped when one of its minutes changes */
    this.bars = new Map();
    this.intervalSec = 60;
    this.scale = 1;
  }

  clear() {
    this.minutes.clear();
    this.bars.clear();
  }

  setInterval(intervalSec) {
    if (intervalSec === this.intervalSec) return;
    this.intervalSec = intervalSec;
    this.bars.clear();
  }

  barTimeOf(t) {
    return Math.floor(t / this.intervalSec) * this.intervalSec;
  }

  /** Replace minutes by their start time. Returns whether anything changed. */
  put(records) {
    if (!Array.isArray(records) || !records.length) return false;
    for (const rec of records) {
      if (!rec || !Number.isFinite(rec.t) || !rec.keys) continue;
      // Updates and a snapshot can cross on the way from the hub; a settled
      // minute is never taken back to a less settled one.
      const held = this.minutes.get(rec.t);
      if (held && rank(held) > rank(rec)) continue;
      this.minutes.set(rec.t, rec);
      if (rec.scale > this.scale) {
        this.scale = rec.scale;
        this.bars.clear();
      }
      this.bars.delete(this.barTimeOf(rec.t));
    }
    return true;
  }

  /** Drop minutes before `fromSec`, so a long-open card does not keep a day of them. */
  trim(fromSec) {
    for (const t of this.minutes.keys()) {
      if (t < fromSec) {
        this.minutes.delete(t);
        this.bars.delete(this.barTimeOf(t));
      }
    }
  }

  /**
   * One bar's footprint, or null if no minute of it is held.
   * @param {number} barTime  seconds
   * @param {number} nowSec   for telling a forming bar's future minutes from missing ones
   * @returns {{time, keys: Float64Array, sell: Float64Array, buy: Float64Array,
   *   sellTotal, buyTotal, delta, complete: boolean, scale}|null}
   */
  bar(barTime, nowSec = Date.now() / 1000) {
    const cached = this.bars.get(barTime);
    if (cached) return cached;
    const end = barTime + this.intervalSec;
    const levels = new Map();
    let held = 0;
    let complete = true;
    for (let t = barTime; t < end; t += 60) {
      const rec = this.minutes.get(t);
      if (!rec) {
        // A minute that has not happened yet is not missing.
        if (t <= nowSec - 60) complete = false;
        continue;
      }
      held += 1;
      if (!rec.complete) complete = false;
      const factor = this.scale / rec.scale;
      for (let i = 0; i < rec.keys.length; i++) {
        const key = Math.round(rec.keys[i] * factor);
        const cell = levels.get(key);
        if (cell) {
          cell[0] += rec.sell[i];
          cell[1] += rec.buy[i];
        } else {
          levels.set(key, [rec.sell[i], rec.buy[i]]);
        }
      }
    }
    if (!held) return null;
    const keys = new Float64Array([...levels.keys()].sort((a, b) => a - b));
    const sell = new Float64Array(keys.length);
    const buy = new Float64Array(keys.length);
    let sellTotal = 0;
    let buyTotal = 0;
    for (let i = 0; i < keys.length; i++) {
      const cell = levels.get(keys[i]);
      sell[i] = cell[0];
      buy[i] = cell[1];
      sellTotal += cell[0];
      buyTotal += cell[1];
    }
    const out = {
      time: barTime,
      keys,
      sell,
      buy,
      sellTotal,
      buyTotal,
      delta: buyTotal - sellTotal,
      complete,
      scale: this.scale,
    };
    // A forming bar is rebuilt every time: its completeness depends on the clock.
    if (end <= nowSec) this.bars.set(barTime, out);
    return out;
  }
}

/**
 * Rows of `stepKey` price keys, highest price first.
 * @returns {{rows: Array<{key, low, high, sell, buy, total, sellImb, buyImb}>, poc: object|null, maxRow: number}}
 *   low/high are prices; `key` is the row's lower edge in keys.
 */
export function binRows(fp, stepKey, ratio = 3, minQty = 0) {
  const step = Math.max(1, Math.round(stepKey));
  const map = new Map();
  for (let i = 0; i < fp.keys.length; i++) {
    const key = Math.floor(fp.keys[i] / step) * step;
    let row = map.get(key);
    if (!row) map.set(key, (row = { key, sell: 0, buy: 0 }));
    row.sell += fp.sell[i];
    row.buy += fp.buy[i];
  }
  const rows = [...map.values()].sort((a, b) => b.key - a.key);
  let poc = null;
  let maxRow = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    row.low = row.key / fp.scale;
    row.high = (row.key + step) / fp.scale;
    row.total = row.sell + row.buy;
    if (row.total > maxRow) {
      maxRow = row.total;
      poc = row;
    }
    // Diagonals, by price rather than by array neighbour. Against nothing at
    // all there is no imbalance to speak of -- otherwise the top and bottom
    // row of every bar would light up, beating a zero by any ratio.
    const below = map.get(row.key - step);
    const above = map.get(row.key + step);
    const sellBelow = below ? below.sell : 0;
    const buyAbove = above ? above.buy : 0;
    row.buyImb = sellBelow > 0 && row.buy > minQty && row.buy >= ratio * sellBelow;
    row.sellImb = buyAbove > 0 && row.sell > minQty && row.sell >= ratio * buyAbove;
  }
  return { rows, poc, maxRow };
}

/**
 * The smallest row, in price keys, that is at least `minPrice` tall: 1, 2, 5
 * times a power of ten, so row edges land on round prices.
 */
export function rowStep(minPrice, scale) {
  const minKeys = Math.max(1, minPrice * scale);
  const pow = 10 ** Math.floor(Math.log10(minKeys));
  for (const m of [1, 2, 5, 10]) {
    if (m * pow >= minKeys - 1e-9) return Math.round(m * pow) || 1;
  }
  return Math.round(10 * pow);
}

/** 0.0123, 4.56, 78.9, 1.23K, 45.6K, 1.2M -- three significant figures, no more. */
export function formatQty(v) {
  const a = Math.abs(v);
  if (!(a > 0)) return '0';
  const sign = v < 0 ? '-' : '';
  if (a >= 1e6) return `${sign}${trim(a / 1e6)}M`;
  if (a >= 1e3) return `${sign}${trim(a / 1e3)}K`;
  return sign + trim(a);
}

function trim(a) {
  if (a >= 100) return String(Math.round(a));
  if (a >= 10) return a.toFixed(1).replace(/\.0$/, '');
  if (a >= 1) return a.toFixed(2).replace(/\.?0+$/, '');
  return a.toPrecision(2).replace(/0+$/, '').replace(/\.$/, '');
}
