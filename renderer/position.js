/**
 * Where the current price sits inside its recent volume distribution, and
 * when that is worth an alert.
 *
 * The position is *empirical*: the share of the window's volume that traded
 * below the price, read straight off the volume profile. No distribution is
 * fitted. Measured over 30 days of BTC and ETH 1m bars, a Gaussian from VWAP
 * and its standard deviation was off from this by 4 percentile points on
 * average and ~10 points in one reading in ten -- enough to call 70% "80%" --
 * while real 24h/72h profiles are rarely one clean bell anyway (a 1-3
 * component mixture fitted by BIC chose 3 for most of them). Counting needs
 * no shape, so it has no shape to get wrong.
 */

/** Rolling windows, in 1m bars. */
export const WINDOWS = Object.freeze({ '4H': 240, '24H': 1440, '72H': 4320 });

/** Levels a window can alert on, in percent: the low side, then the high side. */
export const LEVELS = Object.freeze([5, 10, 20, 80, 90, 95]);

const ROWS = 100;

/**
 * Cumulative volume by price for a set of bars -- each bar's volume spread
 * evenly across the rows its range touched, the same estimate the volume
 * profile layer and TradingView use.
 *
 * @returns {{lo, hi, step, cum: Float64Array}|null}  cum[i] = share below row i
 */
export function buildCdf(bars, rows = ROWS) {
  let hi = -Infinity;
  let lo = Infinity;
  for (const b of bars) {
    if (b.high > hi) hi = b.high;
    if (b.low < lo) lo = b.low;
  }
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi <= lo) return null;
  const step = (hi - lo) / rows;
  const vol = new Float64Array(rows);
  let total = 0;
  for (const b of bars) {
    const v = Number(b.volume) || 0;
    if (!v) continue;
    const from = Math.max(0, Math.min(rows - 1, Math.floor((b.low - lo) / step)));
    const to = Math.max(0, Math.min(rows - 1, Math.floor((b.high - lo) / step)));
    const share = v / (to - from + 1);
    for (let i = from; i <= to; i++) vol[i] += share;
    total += v;
  }
  if (!total) return null;
  const cum = new Float64Array(rows + 1);
  for (let i = 0; i < rows; i++) cum[i + 1] = cum[i] + vol[i] / total;
  return { lo, hi, step, rows, cum };
}

/** 0..1: the share of the window's volume below `price`. Beyond the range, 0 or 1. */
export function percentileOf(cdf, price) {
  if (!cdf || !Number.isFinite(price)) return null;
  if (price <= cdf.lo) return 0;
  if (price >= cdf.hi) return 1;
  const i = Math.min(cdf.rows - 1, Math.floor((price - cdf.lo) / cdf.step));
  const within = (price - (cdf.lo + i * cdf.step)) / cdf.step;
  return cdf.cum[i] + (cdf.cum[i + 1] - cdf.cum[i]) * within;
}

/**
 * A Schmitt trigger over percentile levels.
 *
 * Each level fires once. The high side (80/90/95) re-arms only when the price
 * comes back to 50% or below, the low side only at 50% or above -- so price
 * chopping around 80% does not alert on every wiggle, and an alert means a
 * fresh excursion from the middle of the distribution.
 *
 * A jump across several levels at once reports only the furthest, and marks
 * the ones it passed as fired: one "95%" says it, three alerts would not.
 */
export class LevelTrigger {
  /** @param {number[]} levels  percent values from LEVELS that should alert */
  constructor(levels = []) {
    this.high = levels.filter((l) => l > 50).sort((a, b) => a - b).map((l) => l / 100);
    this.low = levels.filter((l) => l < 50).sort((a, b) => b - a).map((l) => l / 100);
    this.highFired = new Set();
    this.lowFired = new Set();
    this.primed = false;
  }

  /**
   * Adopt the current position without alerting: levels already beyond it
   * count as fired. Otherwise launching with price at 92% would announce 80%
   * and 90% the moment the app opens.
   */
  prime(pct) {
    for (const l of this.high) if (pct >= l) this.highFired.add(l);
    for (const l of this.low) if (pct <= l) this.lowFired.add(l);
    this.primed = true;
  }

  /** @returns {{side: 'high'|'low', level: number}|null}  level in percent */
  update(pct) {
    if (pct === null || !Number.isFinite(pct)) return null;
    if (!this.primed) {
      this.prime(pct);
      return null;
    }
    if (pct <= 0.5) this.highFired.clear();
    if (pct >= 0.5) this.lowFired.clear();

    let hit = null;
    for (const l of this.high) {
      if (pct >= l && !this.highFired.has(l)) {
        this.highFired.add(l);
        hit = { side: 'high', level: Math.round(l * 100) };
      }
    }
    for (const l of this.low) {
      if (pct <= l && !this.lowFired.has(l)) {
        this.lowFired.add(l);
        hit = { side: 'low', level: Math.round(l * 100) };
      }
    }
    return hit;
  }
}
