/**
 * Open interest, from stored samples to one value per chart bar.
 *
 * Two sources, both kept in the bar cache (bar-store.js):
 *
 *   oi_1m  recorded by the hub: the exchange snapshot polled every 3s and
 *          folded into one OHLC record per minute. Fine-grained, but only
 *          exists for minutes the app was running with the symbol on a card.
 *   oi_5m  Binance's own history: one sample per 5 minutes, 30 days deep.
 *          Coarser, but covers the time the app was closed.
 *
 * Both reduce to the same thing -- open interest at a point in time -- so the
 * chart's bars are built from one merged, sorted list of points, whatever the
 * interval. That is also how 15m / 1h / 4h / 1d need no files of their own.
 */

/**
 * Carry the last value across a bar with no sample of its own, but only this
 * far. A 1m bar between two 5m samples is honestly "still that value"; a gap
 * of hours with the app closed and no history is not, and drawing a flat line
 * across it would state something nobody measured.
 */
export const OI_MAX_GAP_SEC = 600;

/**
 * Stored records -> points {t (seconds), v}, sorted.
 *
 * A 1m record contributes its open at the start of the minute, its close at
 * the end and its extremes in between; a 5m history record is one sample.
 */
export function oiPoints(minuteRecords = [], historyRecords = [], live = []) {
  const points = [];
  for (const r of minuteRecords) {
    points.push({ t: r.time, v: r.open });
    points.push({ t: r.time + 30, v: r.high });
    points.push({ t: r.time + 30, v: r.low });
    points.push({ t: r.time + 59, v: r.close });
  }
  for (const r of historyRecords) points.push({ t: r.time, v: r.close });
  for (const p of live) points.push(p);
  return points.sort((a, b) => a.t - b.t);
}

/**
 * One OHLC per bar: open is the value going into the bar, close the last one
 * inside it. A bar with nothing inside and nothing recent before it is left
 * out rather than guessed.
 *
 * @param {{t: number, v: number}[]} points  sorted by t
 * @param {number[]} barTimes                bar open times (seconds), ascending
 * @param {number} stepSec                   bar length
 */
export function bucketOI(points, barTimes, stepSec) {
  const out = [];
  let i = 0;
  let prev = null; // last point before the current bar
  for (const time of barTimes) {
    const end = time + stepSec;
    while (i < points.length && points[i].t < time) prev = points[i++];

    let open = prev && time - prev.t <= OI_MAX_GAP_SEC ? prev.v : null;
    let high = -Infinity;
    let low = Infinity;
    let close = null;
    while (i < points.length && points[i].t < end) {
      const { v } = points[i];
      if (open === null) open = v;
      if (v > high) high = v;
      if (v < low) low = v;
      close = v;
      prev = points[i++];
    }
    if (close === null) {
      if (open === null) continue;
      close = open;
    }
    out.push({
      time,
      open,
      high: Math.max(high, open, close),
      low: Math.min(low, open, close),
      close,
    });
  }
  return out;
}

/** Binance history rows -> records for the oi_5m cache (one sample each). */
export function historyRecords(rows) {
  return rows
    .filter((r) => Number.isFinite(r.time) && Number.isFinite(r.value))
    .map((r) => {
      const time = Math.floor(r.time / 1000);
      // O=H=L=C: a point sample. Volume carries the USD value, which is free
      // with the history and otherwise lost.
      return { time, open: r.value, high: r.value, low: r.value, close: r.value, volume: r.valueUsd || 0, closed: true };
    });
}
