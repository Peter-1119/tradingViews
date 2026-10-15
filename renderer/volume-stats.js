/**
 * Thin volume: where a bar's volume ranks among the bars before it.
 *
 * Volume has a long tail -- a spike can be 10 to 50 times an ordinary bar --
 * so "under half the average" is pulled around by every spike. A percentile
 * rank only counts places, and the tail cannot move it.
 *
 * The distribution it ranks against is low-pass filtered, so one stretch of
 * unusual bars cannot take it over. It is a histogram of log volume, and
 * every closed bar is one step of an exponential filter on the whole of it:
 *
 *     h <- (1 - a) * h      every bin decays
 *     h[bin(v)] += a        the new bar's bin gains what they lost
 *
 * The weights keep summing to 1, and a = 1 / memory gives the filter a
 * memory of about `memory` bars (a half-life of ~0.69 * memory). No shape is
 * assumed -- not normal, not log-normal -- so the tail is ranked as it is.
 *
 * The filter does not start from zero, which would make every early bar
 * rank as extreme. Its starting state is the plain histogram of the first
 * `memory` closed bars (or all of them, if fewer), so the very first bar
 * already ranks against a real distribution. The cost is a little
 * look-ahead for those first bars, which rank against a seed that includes
 * them; from there on, each bar ranks against what came before it only.
 *
 * Bars rank by their quote volume (USDT) where they have it: over a
 * thousand bars price can double, and the same dollars in base units would
 * then look like half the volume.
 *
 * The forming bar has only part of its volume, so it is not judged on it.
 * Once a quarter of its time has gone it is ranked on a projection -- its
 * volume so far over the share of the bar elapsed -- and called provisional.
 */

const BINS = 160;
const BIN_WIDTH = 0.08; // in natural log: e^0.08 ~ 8% per bin, e^12.8 ~ 360000x across
const LIVE_MIN_ELAPSED = 0.25;

export const SQUEEZE_STREAK = 3;

/** What a bar ranks by: its USDT volume, or base volume at the close. */
export function volumeValue(bar) {
  if (Number.isFinite(bar.quoteVolume)) return bar.quoteVolume;
  return (Number(bar.volume) || 0) * (Number(bar.close) || 0);
}

class Histogram {
  /** @param {number} center  ln of a typical volume: the bins sit around it */
  constructor(center) {
    this.lo = center - (BINS / 2) * BIN_WIDTH;
    this.h = new Float64Array(BINS);
  }

  /** Bin index and the position inside it (0..1) for a volume. */
  locate(v) {
    if (!(v > 0)) return { i: 0, frac: 0 };
    const x = (Math.log(v) - this.lo) / BIN_WIDTH;
    if (x <= 0) return { i: 0, frac: 0 };
    if (x >= BINS) return { i: BINS - 1, frac: 1 };
    const i = Math.floor(x);
    return { i, frac: x - i };
  }

  add(v, w) {
    this.h[this.locate(v).i] += w;
  }

  decay(keep) {
    for (let i = 0; i < BINS; i++) this.h[i] *= keep;
  }

  /** Share of the weight below `v`, 0..1, interpolating inside its bin. */
  rank(v) {
    const { i, frac } = this.locate(v);
    let below = 0;
    for (let k = 0; k < i; k++) below += this.h[k];
    return Math.min(1, Math.max(0, below + this.h[i] * frac));
  }

  /** The volume at quantile q (0..1). */
  quantile(q) {
    let acc = 0;
    for (let i = 0; i < BINS; i++) {
      const w = this.h[i];
      if (acc + w >= q && w > 0) {
        const frac = (q - acc) / w;
        return Math.exp(this.lo + (i + frac) * BIN_WIDTH);
      }
      acc += w;
    }
    return Math.exp(this.lo + BINS * BIN_WIDTH);
  }

  clone() {
    const c = Object.create(Histogram.prototype);
    c.lo = this.lo;
    c.h = Float64Array.from(this.h);
    return c;
  }
}

function median(values) {
  const s = values.filter((v) => v > 0).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 1;
}

/**
 * Rank every closed bar against the filtered distribution before it.
 *
 * @param {Array} bars  ascending; only the last one may be unclosed
 * @param {{memory?: number, threshold?: number, extreme?: number}} opts
 *        threshold and extreme are ranks (0..1): at or under `threshold` is
 *        thin, at or under `extreme` very thin
 * @returns {{
 *   rank: Float64Array,       0..1 per bar, NaN for the forming one
 *   line: Float64Array,       the threshold as a volume in the bar's own units
 *   level: Uint8Array,        0 normal, 1 thin, 2 very thin
 *   streak: Uint16Array,      thin bars in a row, ending at this one
 *   hist: Histogram | null,   the filter after the last closed bar
 * }}
 */
export function analyzeVolume(bars, { memory = 1000, threshold = 0.05, extreme = 0.02 } = {}) {
  const n = bars.length;
  const rank = new Float64Array(n).fill(NaN);
  const line = new Float64Array(n).fill(NaN);
  const level = new Uint8Array(n);
  const streak = new Uint16Array(n);
  const closedCount = n && bars[n - 1].closed === false ? n - 1 : n;
  if (!closedCount) return { rank, line, level, streak, hist: null };

  const values = new Float64Array(closedCount);
  for (let i = 0; i < closedCount; i++) values[i] = volumeValue(bars[i]);

  // z0: the plain histogram of the first `memory` bars.
  const seedCount = Math.min(memory, closedCount);
  const seed = Array.from(values.subarray(0, seedCount));
  const hist = new Histogram(Math.log(median(seed)));
  for (const v of seed) hist.add(v, 1 / seedCount);

  const a = 1 / Math.max(2, memory);
  for (let i = 0; i < closedCount; i++) {
    const v = values[i];
    const r = hist.rank(v);
    rank[i] = r;
    // The threshold in the units the pane draws (base volume): this bar's own
    // quote-to-base ratio, which is its average price.
    const toBase = toBaseFactor(bars[i]);
    line[i] = hist.quantile(threshold) * toBase;
    level[i] = r <= extreme ? 2 : r <= threshold ? 1 : 0;
    streak[i] = level[i] ? (i ? streak[i - 1] : 0) + 1 : 0;
    hist.decay(1 - a);
    hist.add(v, a);
  }
  if (closedCount < n) line[n - 1] = hist.quantile(threshold) * toBaseFactor(bars[n - 1]);
  return { rank, line, level, streak, hist };
}

function toBaseFactor(bar) {
  if (Number.isFinite(bar.quoteVolume) && bar.quoteVolume > 0 && bar.volume > 0) return bar.volume / bar.quoteVolume;
  return bar.close > 0 ? 1 / bar.close : 0;
}

/**
 * The forming bar's provisional rank: its volume so far projected to the
 * whole bar, once enough of the bar has gone to say anything.
 *
 * @returns {{rank: number, projected: number} | null}
 */
export function liveRank(hist, bar, nowSec, intervalSec) {
  if (!hist || !bar || bar.closed !== false || !(intervalSec > 0)) return null;
  const elapsed = (nowSec - bar.time) / intervalSec;
  if (!(elapsed >= LIVE_MIN_ELAPSED)) return null;
  const projected = volumeValue(bar) / Math.min(1, elapsed);
  return { rank: hist.rank(projected), projected };
}

/**
 * Bars that belong to a thin streak of at least SQUEEZE_STREAK, as index
 * runs [from, to] -- the whole run, its first bars included.
 */
export function squeezeRuns(streak, min = SQUEEZE_STREAK) {
  const runs = [];
  for (let i = 0; i < streak.length; i++) {
    const endsHere = streak[i] > 0 && (i === streak.length - 1 || streak[i + 1] === 0);
    if (endsHere && streak[i] >= min) runs.push([i - streak[i] + 1, i]);
  }
  return runs;
}
