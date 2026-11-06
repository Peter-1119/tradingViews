/**
 * Long/short ratios, from the exchange's samples to one reading per chart bar.
 *
 * Binance keeps two that matter here, every 5 minutes, 30 days deep:
 *
 *   accounts  globalLongShortAccountRatio: of all accounts with a position,
 *             how many are net long per net short. Each account counts once,
 *             whatever its size -- in practice, the crowd.
 *   top       topLongShortPositionRatio: the top 20% of accounts by margin,
 *             their long position size per short. Weighted by size.
 *
 * A sample is a snapshot at its timestamp, so a bar's reading is the latest
 * one taken by its close: the 01:00 sample is the 00:00 hourly bar's close.
 * The bar still forming has no close yet and shows the newest 5m sample.
 */

/**
 * Periods the exchange keeps the statistics at. Each row is a snapshot at its
 * timestamp: the 1h row at 01:00 equals the 5m row at 01:00. 30 days deep,
 * whatever the period.
 */
export const LS_PERIOD_MS = Object.freeze({
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '6h': 21_600_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
});

/** Periods the exchange keeps, shortest first, in seconds. */
const PERIODS = Object.entries(LS_PERIOD_MS)
  .map(([name, ms]) => ({ name, sec: ms / 1000 }))
  .sort((a, b) => a.sec - b.sec);

/** Statistics refresh every 5 minutes on the exchange. */
export const LS_LIVE_PERIOD = '5m';
export const LS_LIVE_SEC = 300;

/**
 * The coarsest period no longer than a bar: one sample per bar where it can,
 * 5m under that. A 1d card asks for 30 rows, not 8,640.
 */
export function lsPeriodFor(stepSec) {
  let best = PERIODS[0];
  for (const p of PERIODS) if (p.sec <= stepSec) best = p;
  return best;
}

/**
 * Samples {time (ms), accounts, top} -> one {time, accounts, top} per bar,
 * for bars that have a reading.
 *
 * A bar's reading is the newest sample taken by its close. For a bar at
 * least one period long it must also be from after the bar's open: the
 * sample at the open is the bar before's close. A bar shorter than a period
 * (a 1m bar between 5m samples) carries the last sample until the next is
 * due -- no older than one period at the bar's close. A bar with nothing
 * that recent is left out: a stretch nobody sampled is a gap, not a flat line.
 *
 * @param {{time: number, accounts: number, top: number|null}[]} samples  sorted by time
 * @param {number[]} barTimes  bar open times (seconds), ascending
 * @param {number} stepSec     bar length
 * @param {number} periodSec   the sampling period the samples were asked at
 */
export function bucketLongShort(samples, barTimes, stepSec, periodSec) {
  const out = [];
  let i = 0;
  let last = null; // newest sample at or before the current bar's close
  for (const time of barTimes) {
    const close = time + stepSec;
    while (i < samples.length && samples[i].time / 1000 <= close) last = samples[i++];
    if (!last) continue;
    const at = last.time / 1000;
    const fresh = stepSec >= periodSec ? at > time : at >= close - periodSec;
    if (!fresh) continue;
    out.push({ time, accounts: last.accounts, top: last.top });
  }
  return out;
}

/** Two sample lists merged by timestamp, the second winning a tie. Sorted. */
export function mergeSamples(a, b) {
  const byTime = new Map();
  for (const r of a) byTime.set(r.time, r);
  for (const r of b) byTime.set(r.time, r);
  return [...byTime.values()].sort((x, y) => x.time - y.time);
}

/* ------------------------------------------------- the crowd in context */

/*
 * The crowd's ratio is hard to read on its own, for three reasons measured on
 * 30 days of BTC and ETH perpetuals (November 2026):
 *
 *  - The ratio is long / short, which stretches as it rises: 2 -> 3 looks like
 *    half again, but is 67% -> 75% of accounts long. ETH sat between 65% and
 *    80% the whole month, against a ceiling. So the pane reads the share long.
 *  - It has a floor of its own. Accounts are counted, not sized, and small
 *    accounts lean long, so the share long rarely left 48-76% on BTC and
 *    65-80% on ETH. What says something is the distance from the usual: a
 *    7-day median, and a band of two robust deviations around it.
 *  - Most of its movement is the price's. Over 24 hours the change in the
 *    share long ran against the change in price with a correlation of -0.87
 *    (BTC) and -0.75 (ETH): the crowd buys falls and sells rallies. So the
 *    part worth a look is what the price does not explain -- the residual of
 *    the 24h change in the share long, regressed on the 24h price change,
 *    in standard deviations of the residuals.
 *
 * Every figure at an hour is fitted on the hours before it only, so the
 * history drawn is what the pane would have said at the time.
 */

/** A long/short ratio as the share long, in percent: 3 -> 75. */
export function longShare(ratio) {
  const r = Number(ratio);
  return Number.isFinite(r) && r > 0 ? (100 * r) / (1 + r) : NaN;
}

/** Hours of the baseline, of the change, and of the fit behind the residual. */
export const CONTEXT = Object.freeze({
  baseHours: 168,
  baseMin: 84,
  changeHours: 24,
  fitHours: 240,
  fitMin: 120,
  /** Robust deviations either side of the baseline for the band. */
  band: 2,
});

function median(sorted) {
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/**
 * The crowd's share long against its own week and against the price.
 *
 * @param {{time: number, accounts: number}[]} samples  hourly long/short rows, time in ms
 * @param {{time: number, close: number}[]} bars        hourly bars, time = open in seconds
 * @returns {{time: number, share: number, base: number|null, lo: number|null,
 *            hi: number|null, z: number|null}[]}
 *   one per sample with a price, time in seconds (the sample's timestamp, which
 *   is the close of the hour before it). `base`/`lo`/`hi` need half a week
 *   behind them, `z` ten days of fitted pairs.
 */
export function crowdContext(samples, bars, opts = CONTEXT) {
  const o = { ...CONTEXT, ...opts };
  const closeAt = new Map();
  // A row stamped T is a snapshot at T: the hourly bar that opened at T - 1h has closed.
  for (const b of bars) if (Number.isFinite(b.close)) closeAt.set(b.time + 3600, b.close);
  const rows = [];
  for (const s of samples) {
    const time = Math.round(s.time / 1000);
    const share = longShare(s.accounts);
    const close = closeAt.get(time);
    if (Number.isFinite(share) && Number.isFinite(close)) rows.push({ time, share, close });
  }
  rows.sort((a, b) => a.time - b.time);
  const byTime = new Map(rows.map((r) => [r.time, r]));
  const lag = o.changeHours * 3600;

  // The 24h changes, where both ends were sampled.
  const pairs = [];
  for (const r of rows) {
    const then = byTime.get(r.time - lag);
    if (then) pairs.push({ time: r.time, dp: (r.close / then.close - 1) * 100, dl: r.share - then.share });
  }
  const pairAt = new Map(pairs.map((p) => [p.time, p]));

  const out = [];
  let pi = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rec = { time: r.time, share: r.share, base: null, lo: null, hi: null, z: null };

    // Baseline: the median of the week before, and a band of robust deviations.
    const from = r.time - o.baseHours * 3600;
    const week = [];
    for (let j = i - 1; j >= 0 && rows[j].time >= from; j--) week.push(rows[j].share);
    if (week.length >= o.baseMin) {
      week.sort((a, b) => a - b);
      const base = median(week);
      const spread = 1.4826 * median(week.map((v) => Math.abs(v - base)).sort((a, b) => a - b));
      rec.base = base;
      rec.lo = base - o.band * spread;
      rec.hi = base + o.band * spread;
    }

    // Residual: this hour's 24h change against a line fitted on the hours before.
    const now = pairAt.get(r.time);
    if (now) {
      while (pi < pairs.length && pairs[pi].time < r.time - o.fitHours * 3600) pi++;
      const fit = [];
      for (let j = pi; j < pairs.length && pairs[j].time < r.time; j++) fit.push(pairs[j]);
      if (fit.length >= o.fitMin) {
        const n = fit.length;
        const mx = fit.reduce((s, p) => s + p.dp, 0) / n;
        const my = fit.reduce((s, p) => s + p.dl, 0) / n;
        let sxx = 0;
        let sxy = 0;
        for (const p of fit) {
          sxx += (p.dp - mx) ** 2;
          sxy += (p.dp - mx) * (p.dl - my);
        }
        const b = sxx > 0 ? sxy / sxx : 0;
        const a = my - b * mx;
        const sd = Math.sqrt(fit.reduce((s, p) => s + (p.dl - (a + b * p.dp)) ** 2, 0) / n);
        if (sd > 1e-9) rec.z = (now.dl - (a + b * now.dp)) / sd;
      }
    }
    out.push(rec);
  }
  return out;
}

/**
 * Hourly context -> one per chart bar, read the way bucketLongShort reads
 * samples: the newest point by the bar's close; for a bar of an hour or more
 * it must fall after the bar's open, and a shorter bar carries it no longer
 * than an hour.
 *
 * @returns {Map<number, object>} bar time (seconds) -> context point
 */
export function bucketContext(context, barTimes, stepSec) {
  const out = new Map();
  let i = 0;
  let last = null;
  for (const time of barTimes) {
    const close = time + stepSec;
    while (i < context.length && context[i].time <= close) last = context[i++];
    if (!last) continue;
    const fresh = stepSec >= 3600 ? last.time > time : last.time >= close - 3600;
    if (fresh) out.set(time, last);
  }
  return out;
}
