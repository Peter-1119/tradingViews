/**
 * Period boundaries in a chosen market's clock, and the levels built on them:
 * each period's open, the previous period's high and low, and the current
 * period's high and low so far.
 *
 * Five anchors, because where "the day" starts depends on who is trading:
 *
 *   utc     00:00 UTC -- Binance's own candle boundary (08:00 in Taipei)
 *   ny      00:00 New York -- the "midnight open"
 *   nyse    09:30 New York -- the US stock market open (21:30 / 22:30 Taipei)
 *   london  00:00 London
 *   lse     08:00 London -- the London stock market open (15:00 / 16:00 Taipei)
 *
 * Every calendar day counts, weekends included -- crypto trades through
 * them -- so on a Saturday the "day" still starts at 09:30 New York. Weeks
 * start on Monday and months on the 1st, at the same time of day. Exchange
 * holidays are not modelled.
 *
 * Daylight saving is the whole difficulty, so nothing here adds fixed hours:
 * every boundary is found by asking Intl what the wall clock reads in that
 * zone. The US and UK switch on different dates (2026: UK 10/25, US 11/1), so
 * for a week the London and New York opens are an hour closer together.
 *
 * Bars: the 09:30 open is a half hour, so that anchor needs 30m bars; the
 * rest fall on whole UTC hours and 1h bars are exact. Either way the open of
 * the bar starting at a boundary *is* the open, and a period's high and low
 * are the extremes of the bars inside it.
 */

export const ANCHORS = Object.freeze({
  utc: { zone: 'UTC', hour: 0, minute: 0, tag: '' },
  ny: { zone: 'America/New_York', hour: 0, minute: 0, tag: '紐' },
  nyse: { zone: 'America/New_York', hour: 9, minute: 30, tag: '美股' },
  london: { zone: 'Europe/London', hour: 0, minute: 0, tag: '倫' },
  lse: { zone: 'Europe/London', hour: 8, minute: 0, tag: '英股' },
});

const NAMES = {
  utc: 'UTC 00:00',
  ny: '紐約 00:00',
  nyse: '美股開盤 09:30',
  london: '倫敦 00:00',
  lse: '英股開盤 08:00',
};

/**
 * "美股開盤 09:30（台灣 21:30）": the anchor and when it falls on this
 * machine's clock today. Computed on demand, so it is right on both sides of
 * a daylight-saving switch.
 */
export function anchorLabel(anchor, atMs = Date.now()) {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const where = local === 'Asia/Taipei' ? '台灣' : '本地';
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
    new Date(periodStart('D', anchor, atMs))
  );
  return `${NAMES[anchor] || anchor}（${where} ${time}）`;
}

/** The bar interval that lands exactly on every boundary of an anchor. */
export function barsIntervalFor(anchor) {
  return (ANCHORS[anchor] || ANCHORS.utc).minute ? '30m' : '1h';
}

export const PERIODS = Object.freeze(['D', 'W', 'M']);

const formatters = new Map();
function partsIn(zone, ms) {
  if (!formatters.has(zone)) {
    formatters.set(
      zone,
      new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      })
    );
  }
  const out = {};
  for (const p of formatters.get(zone).formatToParts(new Date(ms))) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
  };
}

/** Milliseconds the zone's wall clock is ahead of UTC at `ms`. */
function offsetAt(zone, ms) {
  const p = partsIn(zone, ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/**
 * Epoch ms of a wall-clock time in `zone`. Out-of-range days and months roll
 * over the way Date.UTC rolls them (day 0 is the last day of the previous
 * month). None of the anchor times falls in a DST gap in these zones -- the
 * switches happen at 01:00-03:00 -- so one correction suffices.
 */
function wallTime(zone, year, month, day, hour, minute) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetAt(zone, guess);
  return guess - offsetAt(zone, first);
}

/**
 * Start of the period containing `atMs`, or `shift` periods before or after.
 * @param {'D'|'W'|'M'} period
 * @param {string} anchor  a key of ANCHORS
 */
export function periodStart(period, anchor, atMs, shift = 0) {
  const { zone, hour, minute } = ANCHORS[anchor] || ANCHORS.utc;
  const p = partsIn(zone, atMs);
  // Before today's open, the session still belongs to yesterday's date.
  const beforeOpen = p.hour * 60 + p.minute < hour * 60 + minute;
  const session = new Date(Date.UTC(p.year, p.month - 1, p.day - (beforeOpen ? 1 : 0)));
  const y = session.getUTCFullYear();
  const m = session.getUTCMonth() + 1;
  const d = session.getUTCDate();
  const weekday = (session.getUTCDay() + 6) % 7; // Monday = 0
  if (period === 'M') return wallTime(zone, y, m + shift, 1, hour, minute);
  if (period === 'W') return wallTime(zone, y, m, d - weekday + 7 * shift, hour, minute);
  return wallTime(zone, y, m, d + shift, hour, minute);
}

const LABELS = { D: '日', W: '週', M: '月' };

/**
 * Levels for the chart, from 1h bars (oldest first, times in seconds) that
 * reach back at least to the start of the previous month.
 *
 * @param {{
 *   anchor: string, periods: string[], opens: boolean,
 *   previous: boolean, current: boolean, now?: number,
 * }} options
 * @returns {{id, period, kind, label, time, price}[]}  time = when the level was made (seconds)
 */
export function periodLevels(bars, { anchor = 'utc', periods = PERIODS, opens = true, previous = false, current = false, now = Date.now() } = {}) {
  const tag = (ANCHORS[anchor] || ANCHORS.utc).tag;
  const name = (text) => (tag ? `${text} ${tag}` : text);
  const out = [];
  for (const period of PERIODS) {
    if (!periods.includes(period)) continue;
    const start = periodStart(period, anchor, now) / 1000;
    const prevStart = periodStart(period, anchor, now, -1) / 1000;
    const p = LABELS[period];

    if (opens) {
      const bar = bars.find((b) => b.time === start);
      if (bar) out.push({ id: `${period}-open`, period, kind: 'open', label: name(`${p}開`), time: start, price: bar.open });
    }
    const extremes = (from, to) => {
      let hi = null;
      let lo = null;
      for (const b of bars) {
        if (b.time < from || b.time >= to) continue;
        if (!hi || b.high > hi.price) hi = { price: b.high, time: b.time };
        if (!lo || b.low < lo.price) lo = { price: b.low, time: b.time };
      }
      return { hi, lo };
    };
    if (previous) {
      // Only a complete previous period: half of one would understate it.
      if (bars.length && bars[0].time <= prevStart) {
        const { hi, lo } = extremes(prevStart, start);
        if (hi) out.push({ id: `${period}-prevHigh`, period, kind: 'prevHigh', label: name(`前${p}高`), ...hi });
        if (lo) out.push({ id: `${period}-prevLow`, period, kind: 'prevLow', label: name(`前${p}低`), ...lo });
      }
    }
    if (current) {
      const { hi, lo } = extremes(start, Infinity);
      if (hi) out.push({ id: `${period}-high`, period, kind: 'high', label: name(`本${p}高`), ...hi });
      if (lo) out.push({ id: `${period}-low`, period, kind: 'low', label: name(`本${p}低`), ...lo });
    }
  }
  return out;
}

/**
 * Fold a live bar into the current-period highs and lows. Returns a new list
 * if anything moved, or null -- the card redraws only on a change.
 */
export function updateCurrentExtremes(levels, bar) {
  let changed = false;
  const next = levels.map((l) => {
    if (l.kind === 'high' && bar.high > l.price) {
      changed = true;
      return { ...l, price: bar.high, time: bar.time };
    }
    if (l.kind === 'low' && bar.low < l.price) {
      changed = true;
      return { ...l, price: bar.low, time: bar.time };
    }
    return l;
  });
  return changed ? next : null;
}
