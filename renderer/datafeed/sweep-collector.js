/**
 * Big taker orders ("sweeps"), collected in the hub from the aggTrade stream.
 *
 * What one is: every aggTrade the exchange prints in the same millisecond is
 * one taker order taking the book, level by level -- an aggTrade is already
 * that order's fills at one price, and its other prices carry the same
 * timestamp. So a millisecond's trades, summed, are an order: 20:50:26.306 on
 * ETHUSDT was 7,000 ETH sold in one go, across seven prices.
 *
 * What makes one big is relative to the coin, not a dollar amount: $500K is
 * thirty-five orders an hour on ETH and none on ADA. Each order is ranked
 * against this symbol's own recent orders -- its `top`, the share of orders at
 * least as large (0.001 = the top 0.1%) -- and a card shows those above the
 * share it was set to, whatever the coin. The ranking comes from a
 * log-binned histogram of the last one to two hours of orders, seeded from
 * REST when the collector starts so the first ranks are not guesses.
 *
 * Kept: orders in the top STORE_TOP, in the bar cache as series `sweeps`
 * (monthly chunks, one 64-byte record each, see toStored). On ETH that is
 * about 75 an hour, 3-4 MB a month. Only what the app saw is there: the
 * collector runs while a card has the layer on, plus the seed's few minutes.
 */

/** Orders this far up the ranking are kept and sent; the card picks within them. */
export const STORE_TOP = 0.005;
/** The choices a card offers, as fractions. */
export const TOP_CHOICES = [0.005, 0.002, 0.001, 0.0005, 0.0002, 0.0001];

const BINS_PER_DECADE = 40;
const DECADES = 10; // $1 to $10B
const BIN_COUNT = BINS_PER_DECADE * DECADES;
/** One histogram covers this long; ranks read the current one and the last. */
const WINDOW_MS = 60 * 60_000;
/** Orders a ranking needs before it is believed. */
const WARM = 1000;
/** REST pages of 1,000 aggTrades for the seed. */
const SEED_PAGES = 5;
const FLUSH_MS = 5000;

/** Fractional bin position: the integer part is the bin, the rest how far up it. */
const binPos = (usd) => Math.max(0, Math.min(BIN_COUNT - 1e-9, Math.log10(Math.max(usd, 1)) * BINS_PER_DECADE));
const binOf = (usd) => Math.floor(binPos(usd));
const binFloor = (bin) => 10 ** (bin / BINS_PER_DECADE);

/**
 * Bar-cache record <-> sweep. The cache's eight fields, reused:
 *   time = ms / 1000, open = top, high / low = price range, close = VWAP,
 *   volume = quantity, buyVolume = the taker-buy part, quoteVolume = USDT.
 */
export function toStored(s) {
  return {
    time: s.t / 1000,
    open: s.top,
    high: s.high,
    low: s.low,
    close: s.vwap,
    volume: s.qty,
    buyVolume: s.buyQty,
    quoteVolume: s.notional,
    closed: true,
  };
}

export function fromStored(r) {
  return {
    t: Math.round(r.time * 1000),
    top: r.open,
    high: r.high,
    low: r.low,
    vwap: r.close,
    qty: r.volume,
    buyQty: Number.isFinite(r.buyVolume) ? r.buyVolume : 0,
    notional: Number.isFinite(r.quoteVolume) ? r.quoteVolume : r.volume * r.close,
  };
}

/** Recent order sizes, for ranking: two rotating hour-long histograms. */
export class SizeRanking {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.cur = new Float64Array(BIN_COUNT);
    this.prev = new Float64Array(BIN_COUNT);
    this.curTotal = 0;
    this.prevTotal = 0;
    this.since = now();
  }

  rotate() {
    const t = this.now();
    if (t - this.since < WINDOW_MS) return;
    // Idle for over two windows: nothing recent to keep.
    const both = t - this.since >= 2 * WINDOW_MS;
    this.prev = both ? new Float64Array(BIN_COUNT) : this.cur;
    this.prevTotal = both ? 0 : this.curTotal;
    this.cur = new Float64Array(BIN_COUNT);
    this.curTotal = 0;
    this.since = t;
  }

  add(usd) {
    this.rotate();
    this.cur[binOf(usd)] += 1;
    this.curTotal += 1;
  }

  get total() {
    return this.curTotal + this.prevTotal;
  }

  get warm() {
    return this.total >= WARM;
  }

  /**
   * Share of recent orders at least this large. Its own bin counts in the
   * part above it, taking the orders as spread evenly (in log size) across
   * the bin.
   */
  top(usd) {
    const total = this.total;
    if (!total) return NaN;
    const pos = binPos(usd);
    const b = Math.floor(pos);
    let above = (this.cur[b] + this.prev[b]) * (1 - (pos - b));
    for (let i = b + 1; i < BIN_COUNT; i++) above += this.cur[i] + this.prev[i];
    return above / total;
  }

  /** The smallest order in the top `share`, in USDT. */
  cutoff(share) {
    const total = this.total;
    if (!total) return NaN;
    let above = 0;
    for (let i = BIN_COUNT - 1; i >= 0; i--) {
      above += this.cur[i] + this.prev[i];
      if (above >= share * total) return binFloor(i);
    }
    return binFloor(0);
  }

  cutoffs() {
    const out = {};
    for (const share of TOP_CHOICES) out[share] = this.cutoff(share);
    return out;
  }
}

/** Fold one aggTrade into a millisecond's order. */
function addTrade(group, price, qty, takerSold) {
  group.qty += qty;
  group.notional += price * qty;
  if (!takerSold) group.buyQty += qty;
  if (price > group.high) group.high = price;
  if (price < group.low) group.low = price;
}

const newGroup = (t) => ({ t, qty: 0, buyQty: 0, notional: 0, high: -Infinity, low: Infinity });

export class SweepCollector {
  /**
   * @param {{
   *   symbol: string,
   *   fetchJson?: (path: string) => Promise<any>,   REST, relative to the market's base
   *   store?: {read: (from, to) => Promise<object[]>, write: (records) => Promise<any>},
   *   onSweep: (sweep: object, cutoffs: object) => void,
   *   now?: () => number,
   *   logger?: Console,
   * }} opts
   */
  constructor(opts) {
    this.symbol = opts.symbol;
    this.fetchJson = opts.fetchJson || null;
    this.store = opts.store || null;
    this.onSweep = opts.onSweep;
    this.now = opts.now || (() => Date.now());
    this.logger = opts.logger || console;
    this.ranking = new SizeRanking(this.now);
    this.group = null;
    this.flushTimer = null;
    /** Kept but not yet written, and so still answered from memory. */
    this.unsaved = [];
    this.writeTimer = null;
    this.stopped = false;
    this.ready = this.seed();
  }

  /** The newest few thousand trades from REST: a ranking to start from, and their big orders. */
  async seed() {
    if (!this.fetchJson) return;
    try {
      const pages = [];
      let page = await this.fetchJson(`/aggTrades?symbol=${encodeURIComponent(this.symbol)}&limit=1000`);
      for (let i = 0; i < SEED_PAGES && Array.isArray(page) && page.length; i++) {
        pages.unshift(page);
        if (i === SEED_PAGES - 1) break;
        const fromId = Math.max(0, page[0].a - 1000);
        if (fromId === page[0].a) break;
        page = (await this.fetchJson(`/aggTrades?symbol=${encodeURIComponent(this.symbol)}&fromId=${fromId}&limit=1000`))
          .filter((t) => t.a < page[0].a);
      }
      if (this.stopped) return;
      const orders = [];
      let g = null;
      for (const tr of pages.flat()) {
        if (!g || tr.T !== g.t) {
          if (g) orders.push(g);
          g = newGroup(tr.T);
        }
        addTrade(g, Number(tr.p), Number(tr.q), tr.m);
      }
      // The last millisecond may still be filling on the stream; leave it.
      for (const o of orders) this.ranking.add(o.notional);
      const big = [];
      for (const o of orders) {
        const s = this.finish(o);
        if (s) big.push(s);
      }
      this.keep(big);
    } catch (err) {
      this.logger.warn('[sweeps] seed failed', this.symbol, err && err.message);
    }
  }

  /** A raw aggTrade from the stream: {T, p, q, m}. */
  trade(data) {
    if (this.stopped) return;
    const t = Number(data.T);
    if (!Number.isFinite(t)) return;
    if (this.group && this.group.t !== t) this.close();
    if (!this.group) this.group = newGroup(t);
    addTrade(this.group, Number(data.p), Number(data.q), data.m === true);
    // Its millisecond is over by the next trade, or soon in a quiet market.
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.close(), 250);
  }

  close() {
    clearTimeout(this.flushTimer);
    const g = this.group;
    this.group = null;
    if (!g || !g.qty) return;
    this.ranking.add(g.notional);
    const s = this.finish(g);
    if (!s) return;
    this.keep([s]);
    try {
      this.onSweep(s, this.ranking.cutoffs());
    } catch (err) {
      this.logger.error('[sweeps] sink threw', err);
    }
  }

  /** A finished order as a sweep, if it ranks high enough to keep. */
  finish(g) {
    if (!this.ranking.warm) return null;
    const top = this.ranking.top(g.notional);
    if (!(top <= STORE_TOP)) return null;
    return {
      t: g.t,
      top,
      notional: g.notional,
      qty: g.qty,
      buyQty: g.buyQty,
      vwap: g.notional / g.qty,
      high: g.high,
      low: g.low,
    };
  }

  keep(list) {
    if (!list.length) return;
    this.unsaved.push(...list);
    if (!this.writeTimer) this.writeTimer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  async flush() {
    this.writeTimer = null;
    const batch = this.unsaved;
    if (!batch.length || !this.store) return;
    try {
      await this.store.write(batch.map(toStored));
      // Only now drop them from memory: a snapshot in between still sees them.
      this.unsaved = this.unsaved.filter((s) => !batch.includes(s));
    } catch (err) {
      this.logger.error('[sweeps] write failed', this.symbol, err);
    }
  }

  /** Every kept sweep from `fromSec`, and the current cutoffs. */
  async snapshot(fromSec) {
    await this.ready;
    const from = Number(fromSec) || 0;
    const byT = new Map();
    if (this.store) {
      try {
        for (const r of await this.store.read(from, this.now() / 1000 + 60)) {
          const s = fromStored(r);
          byT.set(s.t, s);
        }
      } catch (err) {
        this.logger.error('[sweeps] read failed', this.symbol, err);
      }
    }
    for (const s of this.unsaved) if (s.t >= from * 1000) byT.set(s.t, s);
    const sweeps = [...byT.values()].sort((a, b) => a.t - b.t);
    return { sweeps, cutoffs: this.ranking.warm ? this.ranking.cutoffs() : {} };
  }

  stop() {
    this.close();
    this.stopped = true;
    clearTimeout(this.writeTimer);
    this.flush();
  }
}
