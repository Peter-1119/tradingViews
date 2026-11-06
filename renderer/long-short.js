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
