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
 *
 * Each row also splits its volume into buying and selling, the way
 * TradingView's up/down volume does: a bar that closed at or above its open
 * counts as buying. The bar cache has no taker-buy volume to do better, and
 * on 1m bars -- what a range profile uses whenever it can -- the split is a
 * fair read of who was in control at each price.
 *
 * Row count is not fixed: it follows how tall the profile is on screen
 * (rowsForHeight), so zooming in on the price axis shows more detail instead
 * of fatter rows. ProfileSource keeps the bars and rebuilds on demand.
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
  const buys = new Float64Array(rows);

  for (const bar of bars) {
    const volume = Number(bar.volume) || 0;
    if (!volume) continue;
    // Which rows this bar's range covers. A bar that never moved still occupies
    // one row rather than none.
    const from = Math.max(0, Math.min(rows - 1, Math.floor((bar.low - low) / step)));
    const to = Math.max(0, Math.min(rows - 1, Math.floor((bar.high - low) / step)));
    const share = volume / (to - from + 1);
    const buying = bar.close >= bar.open;
    for (let i = from; i <= to; i++) {
      volumes[i] += share;
      if (buying) buys[i] += share;
    }
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
      buy: buys[i],
      sell: volume - buys[i],
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

/**
 * How fine the rows are: on-screen height of one row, in px. 'normal' is
 * already about twice the detail of the old fixed 24 rows on a typical card.
 */
export const VP_DETAIL_PX = Object.freeze({ coarse: 10, normal: 6, fine: 4, ultra: 2 });
export const VP_DETAILS = Object.keys(VP_DETAIL_PX);

/** Rows for a profile spanning `heightPx` on screen, at a detail level. */
export function rowsForHeight(heightPx, detail = 'normal') {
  const px = VP_DETAIL_PX[detail] || VP_DETAIL_PX.normal;
  return Math.max(6, Math.min(300, Math.round(Math.abs(heightPx) / px)));
}

/**
 * Bars kept for one profile, rebuilt at whatever row count the screen asks
 * for. Pans and zooms ask for the same count over and over, so the last
 * build is kept; a resize or detail change rebuilds once.
 */
export class ProfileSource {
  constructor(bars) {
    this.bars = Array.isArray(bars) ? bars : [];
    let high = -Infinity;
    let low = Infinity;
    for (const bar of this.bars) {
      if (bar.high > high) high = bar.high;
      if (bar.low < low) low = bar.low;
    }
    this.high = high;
    this.low = low;
    this.rows = 0;
    this.profile = null;
  }

  at(rows) {
    if (rows !== this.rows) {
      this.rows = rows;
      this.profile = buildProfile(this.bars, rows);
    }
    return this.profile;
  }
}

/**
 * The bar interval for a range profile: the finest whose bar count over the
 * span stays near 3,000 -- 1m up to two days, 5m to about ten, 15m to a
 * month. Finer bars put each bar's volume on fewer rows, which is most of the
 * difference between a profile and a smear.
 */
const RANGE_INTERVALS = [
  ['1m', 60],
  ['5m', 300],
  ['15m', 900],
  ['1h', 3600],
  ['4h', 14400],
];
export function rangeInterval(spanSec) {
  for (const [interval, sec] of RANGE_INTERVALS) {
    if (spanSec / sec <= 3000) return interval;
  }
  return '1d';
}

/** Profile modes a card can show. 'off' first so it is the obvious default. */
export const VP_MODES = ['off', 'session4h', 'visible', 'day'];

/** Seconds in one per-period profile's block. */
export const PERIOD_4H = 4 * 3600;

/**
 * One profile per fixed-length period, oldest first.
 *
 * Periods are aligned to epoch multiples of `periodSec`. For 4h that lands on
 * 00/04/08/12/16/20 UTC -- the same boundaries Binance opens its 4h candles on,
 * because 86400 divides evenly by 14400 and the epoch starts at a UTC midnight.
 * So each block here is exactly the span of one real 4h candle.
 *
 * @returns {Array<{start: number, end: number, profile: object}>}
 */
export function buildPeriodProfiles(bars, periodSec = PERIOD_4H, rows = 16) {
  if (!Array.isArray(bars) || !bars.length) return [];
  const groups = new Map();
  for (const bar of bars) {
    const start = Math.floor(bar.time / periodSec) * periodSec;
    if (!groups.has(start)) groups.set(start, []);
    groups.get(start).push(bar);
  }
  const out = [];
  for (const start of [...groups.keys()].sort((a, b) => a - b)) {
    const profile = buildProfile(groups.get(start), rows);
    // The source lets the chart rebuild the block at its on-screen detail.
    if (profile) out.push({ start, end: start + periodSec, profile, source: new ProfileSource(groups.get(start)) });
  }
  return out;
}
