/**
 * RSI and MACD, as recursive filters with state.
 *
 * Both are built from one-pole IIR filters -- an EMA is
 * `y[n] = a*x[n] + (1-a)*y[n-1]`, which is `scipy.signal.lfilter([a], [1, a-1], x)`
 * -- and the reason lfilter beats pandas in Python is that it runs that loop in
 * C instead of the interpreter. JavaScript has no interpreter loop to escape:
 * V8 compiles this one to machine code, so a plain `for` over the closes runs
 * at the same few nanoseconds a sample (a million in a few milliseconds, see
 * scripts/test-indicators.mjs). No native module is needed, nor wanted: one
 * would have to be rebuilt for every Electron upgrade.
 *
 * What lfilter's `zi`/`zf` give you -- carry the filter state from one block
 * to the next -- is the shape here too: `push` commits a closed bar's close
 * and advances the state; `peek` answers for the forming bar without
 * committing, so each live tick costs a handful of multiplications. A full
 * pass only happens when the bars are replaced (load, history, trim).
 *
 * Values match TradingView's built-ins: `ta.rsi` (Wilder's RMA, alpha 1/n)
 * and `ta.ema` (alpha 2/(n+1)), each seeded with the simple mean of its first
 * n inputs rather than the first input, so the early values are not skewed
 * toward one bar.
 */

/** A one-pole low-pass filter, SMA-seeded: TradingView's ema / rma. */
class Smoother {
  constructor(period, alpha) {
    this.period = period;
    this.alpha = alpha;
    this.n = 0;
    this.sum = 0;
    this.value = NaN;
  }

  push(x) {
    if (this.n < this.period) {
      this.sum += x;
      this.n += 1;
      if (this.n === this.period) this.value = this.sum / this.period;
      return this.value;
    }
    this.value += this.alpha * (x - this.value);
    return this.value;
  }

  /** What push(x) would return, leaving the state as it is. */
  peek(x) {
    if (this.n < this.period) return this.n + 1 === this.period ? (this.sum + x) / this.period : NaN;
    return this.value + this.alpha * (x - this.value);
  }
}

const ema = (period) => new Smoother(period, 2 / (period + 1));
const rma = (period) => new Smoother(period, 1 / period);

function rsiOf(up, down) {
  if (Number.isNaN(up) || Number.isNaN(down)) return NaN;
  if (down === 0) return up === 0 ? 50 : 100;
  return 100 - 100 / (1 + up / down);
}

export class Rsi {
  constructor(period = 14) {
    this.period = period;
    this.prev = NaN;
    this.up = rma(period);
    this.down = rma(period);
  }

  push(close) {
    if (Number.isNaN(this.prev)) {
      this.prev = close;
      return NaN;
    }
    const d = close - this.prev;
    this.prev = close;
    return rsiOf(this.up.push(d > 0 ? d : 0), this.down.push(d < 0 ? -d : 0));
  }

  peek(close) {
    if (Number.isNaN(this.prev)) return NaN;
    const d = close - this.prev;
    return rsiOf(this.up.peek(d > 0 ? d : 0), this.down.peek(d < 0 ? -d : 0));
  }
}

/** MACD line, signal and histogram; NaN for each until it has warmed up. */
export class Macd {
  constructor(fast = 12, slow = 26, signal = 9) {
    this.fast = ema(fast);
    this.slow = ema(slow);
    this.signal = ema(signal);
  }

  static point(macd, signal) {
    return { macd, signal, hist: macd - signal };
  }

  push(close) {
    const f = this.fast.push(close);
    const s = this.slow.push(close);
    if (Number.isNaN(s)) return Macd.point(NaN, NaN);
    const m = f - s;
    return Macd.point(m, this.signal.push(m));
  }

  peek(close) {
    const s = this.slow.peek(close);
    if (Number.isNaN(s)) return Macd.point(NaN, NaN);
    const m = this.fast.peek(close) - s;
    return Macd.point(m, this.signal.peek(m));
  }
}

/**
 * An indicator over a card's bars: every bar but the last is committed, the
 * last (the forming one) is peeked.
 *
 * `compute` is the full pass; `next` is one live update, and when the update
 * opened a new bar, the bar before it has just closed and is committed first.
 */
export class Track {
  /** @param {() => Rsi | Macd} make */
  constructor(make) {
    this.make = make;
    this.calc = null;
    /** The newest closed bar's value. */
    this.committed = null;
  }

  compute(bars) {
    this.calc = this.make();
    const n = bars.length;
    const out = new Array(n);
    for (let i = 0; i < n - 1; i++) out[i] = this.calc.push(bars[i].close);
    this.committed = n > 1 ? out[n - 2] : null;
    if (n) out[n - 1] = this.calc.peek(bars[n - 1].close);
    return out;
  }

  next(bars, isNew) {
    const n = bars.length;
    if (!this.calc || !n) return null;
    if (isNew && n > 1) this.committed = this.calc.push(bars[n - 2].close);
    return this.calc.peek(bars[n - 1].close);
  }
}
