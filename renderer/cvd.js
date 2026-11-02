/**
 * Cumulative volume delta: the running sum of what aggressive buyers took
 * minus what aggressive sellers took, bar by bar.
 *
 * Binance gives the taker-buy volume with every kline (k[9]), so the delta of
 * a bar is buy - (volume - buy) = 2·buy - volume, in coins. It is turned into
 * USDT at the bar's average price (quote volume / volume), like the volume
 * bars, so one coin reads like another.
 *
 * Where the sum starts is a choice, not a fact: from the first bar loaded, or
 * from 0 again at each UTC day (Binance's daily candle). Only the shape means
 * anything in the first case; in the second the level is that day's net.
 */

const DAY = 86400;

/** A bar's delta in USDT; NaN when the bar has no taker split (old cache). */
export function barDelta(bar) {
  const volume = Number(bar.volume);
  const buy = Number(bar.buyVolume);
  if (!Number.isFinite(buy) || !Number.isFinite(volume)) return NaN;
  const price = volume > 0 && Number(bar.quoteVolume) > 0 ? Number(bar.quoteVolume) / volume : Number(bar.close);
  return (2 * buy - volume) * price;
}

export const dayOf = (time) => Math.floor(time / DAY);

/** Whether the sum starts over at `bar`, coming from `prev`. */
export function resetsAt(prev, bar, anchor) {
  return anchor === 'day' && !!prev && !!bar && dayOf(prev.time) !== dayOf(bar.time);
}

/**
 * CVD of every bar. A bar without a taker split adds nothing but keeps its
 * place, so the line runs on through it.
 * @returns {number[]}
 */
export function cvdValues(bars, anchor = 'none') {
  const out = new Array(bars.length);
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    if (resetsAt(bars[i - 1], bars[i], anchor)) sum = 0;
    const d = barDelta(bars[i]);
    if (Number.isFinite(d)) sum += d;
    out[i] = sum;
  }
  return out;
}

/**
 * The live end of the line: the sum up to the forming bar is kept, and each
 * tick only adds the forming bar's delta to it. When a new bar opens, the one
 * before it is final and moves into the kept sum.
 */
export class CvdTrack {
  constructor(anchor = 'none') {
    this.anchor = anchor;
    this.before = 0;
    this.formTime = null;
  }

  /** All values, and the state for `next` from the newest bar on. */
  compute(bars) {
    const out = cvdValues(bars, this.anchor);
    const n = bars.length;
    if (!n) {
      this.before = 0;
      this.formTime = null;
      return out;
    }
    const last = bars[n - 1];
    const d = barDelta(last);
    this.before = out[n - 1] - (Number.isFinite(d) ? d : 0);
    this.formTime = last.time;
    return out;
  }

  /** The newest bar's value; `bars` already holds it last. */
  next(bars) {
    const n = bars.length;
    const bar = bars[n - 1];
    if (!bar) return NaN;
    if (this.formTime !== null && bar.time !== this.formTime) {
      const prev = bars[n - 2];
      const d = prev ? barDelta(prev) : NaN;
      if (prev && prev.time === this.formTime && Number.isFinite(d)) this.before += d;
      if (resetsAt(prev, bar, this.anchor)) this.before = 0;
    }
    this.formTime = bar.time;
    const d = barDelta(bar);
    return this.before + (Number.isFinite(d) ? d : 0);
  }
}
