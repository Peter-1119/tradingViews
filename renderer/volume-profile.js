/**
 * Session volume profile.
 *
 * Built the same way TradingView builds its own: load the session's
 * lower-timeframe bars and spread each bar's volume across the price rows it
 * touched. Their docs are explicit that this is how it works -- "the system
 * loads all 1-minute bars that were traded in that daily session" -- and
 * equally explicit that the result is an estimate, because volume inside a bar
 * is not actually uniform across its range.
 *
 * Tick data would be exact, but a day of BTCUSDT aggTrades is ~820k trades and
 * 819 requests against a 1000-row cap. A day of 1m bars is two requests. The
 * accuracy difference does not pay for that.
 *
 * Crypto has no sessions, so "session" here means the exchange's own day
 * boundary, which for Binance is 00:00 UTC -- the same boundary its daily
 * candles use.
 */

/** UTC-day bounds, in epoch ms, containing `atMs`. */
export function sessionBounds(atMs = Date.now()) {
  const start = Date.UTC(
    new Date(atMs).getUTCFullYear(),
    new Date(atMs).getUTCMonth(),
    new Date(atMs).getUTCDate()
  );
  return { start, end: start + 86400000 };
}

/**
 * @param {Bar[]} bars    session bars, finest interval available
 * @param {number} rows   how many price buckets to split the range into
 * @returns {{rows: Array, poc: number, vah: number, val: number, total: number, high: number, low: number, step: number}|null}
 */
export function buildProfile(bars, rows = 24) {
  if (!Array.isArray(bars) || !bars.length) return null;

  let high = -Infinity;
  let low = Infinity;
  for (const bar of bars) {
    if (bar.high > high) high = bar.high;
    if (bar.low < low) low = bar.low;
  }
  if (!Number.isFinite(high) || !Number.isFinite(low) || high <= low) return null;

  const step = (high - low) / rows;
  const volumes = new Float64Array(rows);

  for (const bar of bars) {
    const volume = Number(bar.volume) || 0;
    if (!volume) continue;
    // Which rows this bar's range covers. A bar that never moved still occupies
    // one row rather than none.
    const from = Math.max(0, Math.min(rows - 1, Math.floor((bar.low - low) / step)));
    const to = Math.max(0, Math.min(rows - 1, Math.floor((bar.high - low) / step)));
    const share = volume / (to - from + 1);
    for (let i = from; i <= to; i++) volumes[i] += share;
  }

  let total = 0;
  let peak = 0;
  let pocIndex = 0;
  for (let i = 0; i < rows; i++) {
    total += volumes[i];
    if (volumes[i] > peak) {
      peak = volumes[i];
      pocIndex = i;
    }
  }
  if (!total) return null;

  /*
   * Value area: expand out from the POC, always taking the heavier neighbour,
   * until 70% of the session's volume is enclosed. That is the standard
   * construction, and it is what makes the profile useful as support and
   * resistance rather than just a pretty histogram.
   */
  const target = total * 0.7;
  let lowIndex = pocIndex;
  let highIndex = pocIndex;
  let inside = volumes[pocIndex];
  while (inside < target && (lowIndex > 0 || highIndex < rows - 1)) {
    const below = lowIndex > 0 ? volumes[lowIndex - 1] : -1;
    const above = highIndex < rows - 1 ? volumes[highIndex + 1] : -1;
    if (above >= below) inside += volumes[++highIndex];
    else inside += volumes[--lowIndex];
  }

  const mid = (i) => low + (i + 0.5) * step;
  return {
    rows: Array.from(volumes, (volume, i) => ({
      index: i,
      volume,
      ratio: volume / peak,
      priceLow: low + i * step,
      priceHigh: low + (i + 1) * step,
      inValueArea: i >= lowIndex && i <= highIndex,
    })),
    poc: mid(pocIndex),
    val: low + lowIndex * step,
    vah: low + (highIndex + 1) * step,
    total,
    high,
    low,
    step,
  };
}
