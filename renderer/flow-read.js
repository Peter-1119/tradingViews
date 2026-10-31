/**
 * Position read: who was opening or closing in a bar, from two numbers the
 * card already has -- the taker delta (buys minus sells, from the bar's
 * taker-buy volume) and the change in open interest across the bar.
 *
 * Open interest moves only when both sides of a trade open (up) or both
 * close (down); one opening against one closing leaves it where it was. So a
 * bar's ΔOI says how much was opened or closed on balance, and the taker side
 * says which way the aggressors leaned:
 *
 *                     OI up             OI down
 *   takers buying     longs opening     shorts covering
 *   takers selling    shorts opening    longs closing
 *
 * With the takers near even (|delta| under a tenth of the volume) there is
 * no lean to read, and the bar says only that positions were opened or
 * closed on both sides.
 *
 * It is a reading of net per-bar numbers, not of each trade: opening and
 * closing inside one bar offset each other. A bar is read only when its OI
 * was sampled from inside it (two samples or more: the hub's 3-second
 * polling while the app runs). Binance's 5-minute history alone gives a 1m
 * bar one sample or none, and would put five minutes of change on one bar.
 * Only bars whose |ΔOI| stands out -- `sens` times the median |ΔOI| of the
 * bars loaded -- are marked.
 */

/** Below this share of the volume, the delta has no direction worth naming. */
export const LEAN = 0.1;

export const KINDS = ['longOpen', 'shortCover', 'shortOpen', 'longClose', 'bothOpen', 'bothClose'];

/** One bar: {kind, dOI, delta} or null when there is no OI for it. */
export function readBar(bar, oi) {
  if (!bar || !oi || !Number.isFinite(oi.open) || !Number.isFinite(oi.close)) return null;
  if (Number.isFinite(oi.n) && oi.n < 2) return null;
  const dOI = oi.close - oi.open;
  const volume = bar.volume || 0;
  const delta = Number.isFinite(bar.buyVolume) ? 2 * bar.buyVolume - volume : NaN;
  let kind;
  if (!Number.isFinite(delta) || Math.abs(delta) < LEAN * volume) kind = dOI >= 0 ? 'bothOpen' : 'bothClose';
  else if (delta > 0) kind = dOI >= 0 ? 'longOpen' : 'shortCover';
  else kind = dOI >= 0 ? 'shortOpen' : 'longClose';
  return { kind, dOI, delta };
}

function median(values) {
  if (!values.length) return 0;
  const s = Float64Array.from(values).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Every bar's reading, and which stand out.
 * @param {object[]} bars
 * @param {Map<number, object>} oiByTime  bar time -> {open, close} (open-interest.js bucketOI)
 * @param {number} sens  how many median |ΔOI| a bar needs to be marked
 * @returns {{reads: Map<number, object>, scale: number}}
 *          reads: time -> {kind, dOI, delta, score, marked}; scale: the median |ΔOI|
 */
export function readPositions(bars, oiByTime, sens = 3) {
  const reads = new Map();
  const sizes = [];
  for (const bar of bars) {
    const r = readBar(bar, oiByTime.get(bar.time));
    if (!r) continue;
    reads.set(bar.time, r);
    if (r.dOI) sizes.push(Math.abs(r.dOI));
  }
  const scale = median(sizes);
  for (const r of reads.values()) mark(r, scale, sens);
  return { reads, scale };
}

/** Score one reading against the scale; used again for the live bar. */
export function mark(r, scale, sens) {
  r.score = scale > 0 ? Math.abs(r.dOI) / scale : 0;
  r.marked = r.score >= sens;
  return r;
}
