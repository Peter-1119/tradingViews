/**
 * Footprint collection for one symbol: per minute, per price, how much taker
 * sellers and taker buyers took. Runs in the hub, fed by the aggTrade stream
 * the hub already holds for every card; the cards only draw it.
 *
 * Minutes are the unit everywhere -- a 5m or 15m bar's footprint is the sum of
 * its minutes -- and prices are kept at the exchange's own resolution. The
 * cards merge rows to whatever height fits on screen.
 *
 * Completeness
 * ------------
 * aggTrade ids are consecutive, so a gap in them is a trade we never saw. A
 * minute is complete when every id in it arrived in one unbroken run that
 * began before the minute did. That is decided as the next minute's first
 * trade arrives: a minute only closes then, because until it does there is
 * no telling whether its last trade has been seen.
 *
 * Minutes that are not complete -- the one the card opened in, anything
 * across a reconnect, anything from before the app was started -- are fetched
 * whole from REST and replace what the stream gave. Newest first, so the bars
 * nearest now fill in first, and paced well inside the IP weight budget: the
 * user may be trading on the same IP, and a 429 there would be far worse than
 * a footprint that fills in a minute later.
 *
 * Only closed, complete minutes go to disk.
 */

/** Closed minutes kept in memory: 2.5h of 5m bars is 150; this leaves room. */
const KEEP_SEC = 4 * 3600;
/**
 * How far back REST fills in. BTCUSDT runs ~4 pages a minute, so 3h is ~700
 * pages -- about twelve minutes at a page a second, newest first. Older
 * minutes come only from disk, recorded while the app was running.
 */
const BACKFILL_SEC = 3 * 3600;
/** How often the forming minute is re-sent to the cards. */
const LIVE_EMIT_MS = 250;
/** Back off this long after a 429/418 with no Retry-After. */
const RATE_LIMIT_PAUSE_MS = 60_000;
/** A failed request is retried after this, a few times, then left alone. */
const RETRY_MS = 5000;
const MAX_TRIES = 3;
/** A minute is fetched no sooner than this after it ends. */
const SETTLE_MS = 3000;
/**
 * Per market: request weight of one aggTrades page, the pause between pages,
 * and the 1-minute weight above which we wait for the next minute. Perpetuals
 * cost 20 of 2400 a minute, so one page a second uses half the budget at
 * most; spot costs 4 of 6000.
 */
export const REST_PACE = {
  perp: { gapMs: 1000, ceiling: 1500 },
  spot: { gapMs: 250, ceiling: 4000 },
};

const decimals = (s) => {
  const dot = s.indexOf('.');
  if (dot < 0) return 0;
  let end = s.length;
  while (end > dot + 1 && s[end - 1] === '0') end -= 1;
  return end - dot - 1;
};

export const minuteOf = (ms) => Math.floor(ms / 60_000) * 60;

/** A minute being built: price key -> [sell, buy]. */
function newMinute(t, complete) {
  return { t, levels: new Map(), firstId: 0, lastId: 0, complete, closed: false, packed: null };
}

export class FootprintCollector {
  /**
   * @param {{
   *   symbol: string,
   *   market?: 'spot'|'perp',
   *   rest: string,                                   REST base, e.g. https://fapi.binance.com/fapi/v1
   *   fetchFn?: typeof fetch,
   *   store?: {read: (from, to) => Promise<object[]>, write: (records) => Promise<any>},
   *   onUpdate: (records: object[]) => void,          packed minutes, as they change
   *   now?: () => number,                             ms
   *   pace?: {gapMs, ceiling},
   *   logger?: Console,
   * }} opts
   */
  constructor(opts) {
    this.symbol = opts.symbol;
    this.market = opts.market === 'spot' ? 'spot' : 'perp';
    this.rest = opts.rest;
    this.fetchFn = opts.fetchFn || ((...a) => fetch(...a));
    this.store = opts.store || null;
    this.onUpdate = opts.onUpdate;
    this.now = opts.now || (() => Date.now());
    this.pace = opts.pace || REST_PACE[this.market];
    this.logger = opts.logger || console;

    /** minute (sec) -> minute record */
    this.minutes = new Map();
    /** Price and quantity resolution, from the decimals the exchange prints. */
    this.pdec = 0;
    this.qdec = 0;
    this.lastId = null;
    this.lastT = null;
    /** The earliest minute anyone has asked for. */
    this.fromSec = Infinity;

    /** Minutes to fetch from REST; worked newest first. */
    this.queue = new Set();
    this.tries = new Map();
    this.working = false;
    this.pausedUntil = 0;
    this.nextAt = 0;
    this.stopped = false;
    this.liveTimer = null;
    this.ready = Promise.resolve();
  }

  get scale() {
    return 10 ** this.pdec;
  }

  /**
   * Someone wants minutes back to `fromSec`. Reads what is on disk, then
   * queues the rest. Resolves once the disk read has landed, so a snapshot
   * taken after it has everything there is so far.
   */
  want(fromSec) {
    const from = minuteOf(Number(fromSec) * 1000);
    if (!(from < this.fromSec)) return this.ready;
    const prevFrom = this.fromSec;
    this.fromSec = from;
    this.ready = this.ready.then(() => this.loadRange(from, Math.min(prevFrom, minuteOf(this.now()))));
    return this.ready;
  }

  async loadRange(from, to) {
    if (this.stopped) return;
    if (this.store && to > from) {
      try {
        const recs = await this.store.read(from, to);
        const landed = [];
        for (const rec of recs) {
          const own = this.minutes.get(rec.t);
          // A live minute that is already complete is as good; keep it.
          if (own && own.complete) continue;
          const minute = this.fromPacked(rec);
          this.minutes.set(rec.t, minute);
          landed.push(minute);
        }
        if (landed.length) this.emit(landed);
      } catch (err) {
        this.logger.error('[footprint] disk read failed', this.symbol, err);
      }
    }
    if (this.stopped) return;
    const horizon = minuteOf(this.now()) - BACKFILL_SEC;
    const current = minuteOf(this.now());
    for (let t = Math.max(from, horizon); t < Math.min(to, current); t += 60) {
      const own = this.minutes.get(t);
      if (!own || !own.complete) this.queue.add(t);
    }
    this.work();
  }

  /* ------------------------------------------------------------- stream */

  /** One aggTrade payload: {a, p, q, T, m}. */
  trade(d) {
    if (this.stopped) return;
    const id = Number(d.a);
    const ms = Number(d.T);
    const price = Number(d.p);
    const qty = Number(d.q);
    if (!Number.isFinite(id) || !Number.isFinite(ms) || !(price > 0) || !(qty > 0)) return;
    if (this.lastId !== null && id <= this.lastId) return; // a replay

    this.resolution(String(d.p), String(d.q));
    const contiguous = this.lastId !== null && id === this.lastId + 1;
    const t = minuteOf(ms);

    if (this.lastT !== null && t > this.lastT) {
      // Every minute up to this one is over. Minutes the tape skipped had no
      // trades at all -- if nothing was missed, they are empty and complete.
      for (let m = this.lastT; m < t; m += 60) {
        let minute = this.minutes.get(m);
        if (!minute && m > this.lastT) {
          minute = newMinute(m, contiguous);
          this.minutes.set(m, minute);
        }
        if (minute && !minute.closed) this.close(minute, contiguous);
      }
    }

    let minute = this.minutes.get(t);
    if (!minute) {
      // The first trade of a minute: complete so far if the one before it was seen.
      minute = newMinute(t, contiguous);
      this.minutes.set(t, minute);
    } else if (minute.closed) {
      // Already settled from disk or REST; the stream has nothing to add.
      this.lastId = id;
      this.lastT = t;
      return;
    }
    if (!contiguous) minute.complete = false;
    if (!minute.firstId) minute.firstId = id;
    minute.lastId = id;
    const key = Math.round(price * this.scale);
    let cell = minute.levels.get(key);
    if (!cell) minute.levels.set(key, (cell = [0, 0]));
    // `m`: the buyer was the maker, so the taker sold.
    cell[d.m ? 0 : 1] += qty;
    minute.packed = null;

    this.lastId = id;
    this.lastT = t;
    this.scheduleLive();
  }

  /** Price and quantity decimals, from the strings the exchange prints. */
  resolution(p, q) {
    this.setPriceDecimals(decimals(p));
    const qd = decimals(q);
    if (qd > this.qdec) this.qdec = qd;
  }

  /**
   * A finer price than any so far re-keys everything held, so every minute
   * stays at the one scale pack() stamps on it. Happens in the first few
   * trades (89000.1 prints one decimal, 89000.12 two), not after.
   */
  setPriceDecimals(pd) {
    if (!(pd > this.pdec)) return;
    const factor = 10 ** (pd - this.pdec);
    for (const minute of this.minutes.values()) {
      const next = new Map();
      for (const [key, cell] of minute.levels) next.set(key * factor, cell);
      minute.levels = next;
      minute.packed = null;
    }
    this.pdec = pd;
  }

  close(minute, nextContiguous) {
    minute.closed = true;
    if (!nextContiguous) minute.complete = false;
    minute.packed = null;
    this.emit([minute]);
    if (minute.complete) {
      this.persist([minute]);
    } else if (minute.t >= this.fromSec) {
      this.queue.add(minute.t);
      this.work();
    }
    this.trim();
  }

  scheduleLive() {
    if (this.liveTimer) return;
    this.liveTimer = setTimeout(() => {
      this.liveTimer = null;
      if (this.stopped || this.lastT === null) return;
      const minute = this.minutes.get(this.lastT);
      if (minute && !minute.closed) this.emit([minute]);
    }, LIVE_EMIT_MS);
  }

  trim() {
    const keepFrom = Math.min(this.fromSec, minuteOf(this.now()) - KEEP_SEC);
    for (const t of this.minutes.keys()) if (t < keepFrom) this.minutes.delete(t);
  }

  /* ---------------------------------------------------------------- REST */

  async work() {
    if (this.working || this.stopped) return;
    this.working = true;
    try {
      while (!this.stopped && this.queue.size) {
        const t = Math.max(...this.queue);
        this.queue.delete(t);
        if (t < this.fromSec || t < minuteOf(this.now()) - BACKFILL_SEC) continue;
        const own = this.minutes.get(t);
        if (own && own.complete && own.closed) continue;
        // Just ended: give the exchange a moment to have all of it on REST.
        if ((t + 60) * 1000 > this.now() - SETTLE_MS) {
          setTimeout(() => {
            this.queue.add(t);
            this.work();
          }, SETTLE_MS);
          continue;
        }
        try {
          const minute = await this.fetchMinute(t);
          if (this.stopped) break;
          const now = this.minutes.get(t);
          if (now && now.complete && now.closed) continue;
          this.minutes.set(t, minute);
          this.emit([minute]);
          this.persist([minute]);
        } catch (err) {
          const n = (this.tries.get(t) || 0) + 1;
          this.tries.set(t, n);
          this.logger.warn('[footprint] fetch failed', this.symbol, t, err.message);
          if (n < MAX_TRIES) {
            setTimeout(() => {
              this.queue.add(t);
              this.work();
            }, RETRY_MS);
          }
        }
      }
    } finally {
      this.working = false;
    }
  }

  async wait(ms) {
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
  }

  /** One page of aggTrades, paced, honoring the exchange's weight headers. */
  async page(query) {
    await this.wait(this.pausedUntil - this.now());
    await this.wait(this.nextAt - this.now());
    this.nextAt = this.now() + this.pace.gapMs;
    const res = await this.fetchFn(`${this.rest}/aggTrades?symbol=${this.symbol}&${query}&limit=1000`);
    const used = Number(res.headers && res.headers.get && res.headers.get('x-mbx-used-weight-1m'));
    if (res.status === 429 || res.status === 418) {
      const after = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
      this.pausedUntil = this.now() + (after > 0 ? after * 1000 : RATE_LIMIT_PAUSE_MS);
      throw new Error(`rate limited (${res.status})`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Close to the ceiling: let the minute roll over before the next page.
    if (used > this.pace.ceiling) this.pausedUntil = (Math.floor(this.now() / 60_000) + 1) * 60_000 + 1000;
    return res.json();
  }

  /** Every trade in one minute, as a closed, complete minute. */
  async fetchMinute(t) {
    const start = t * 1000;
    const end = start + 59_999;
    const trades = [];
    let rows = await this.page(`startTime=${start}&endTime=${end}`);
    for (;;) {
      let past = false;
      for (const row of rows) {
        if (row.T > end) {
          past = true;
          break;
        }
        this.resolution(String(row.p), String(row.q));
        trades.push(row);
      }
      if (past || rows.length < 1000) break;
      rows = await this.page(`fromId=${Number(rows[rows.length - 1].a) + 1}`);
    }
    // Keyed only now, at the resolution every row has been seen at.
    const minute = newMinute(t, true);
    for (const row of trades) {
      const id = Number(row.a);
      if (!minute.firstId) minute.firstId = id;
      minute.lastId = id;
      const key = Math.round(Number(row.p) * this.scale);
      let cell = minute.levels.get(key);
      if (!cell) minute.levels.set(key, (cell = [0, 0]));
      cell[row.m ? 0 : 1] += Number(row.q);
    }
    minute.closed = true;
    return minute;
  }

  /* ---------------------------------------------------------- packing */

  /** A minute as the cards and the disk take it: parallel arrays, sorted by price. */
  pack(minute) {
    if (minute.packed) return minute.packed;
    const keys = [...minute.levels.keys()].sort((a, b) => a - b);
    const n = keys.length;
    const rec = {
      t: minute.t,
      scale: this.scale,
      qscale: 10 ** this.qdec,
      keys: new Float64Array(keys),
      sell: new Float64Array(n),
      buy: new Float64Array(n),
      firstId: minute.firstId,
      lastId: minute.lastId,
      complete: minute.complete,
      closed: minute.closed,
    };
    for (let i = 0; i < n; i++) {
      const cell = minute.levels.get(keys[i]);
      rec.sell[i] = cell[0];
      rec.buy[i] = cell[1];
    }
    if (minute.closed) minute.packed = rec;
    return rec;
  }

  /** A packed record (from disk) back into a settled minute. */
  fromPacked(rec) {
    // Disk keys are at the resolution they were written with.
    this.setPriceDecimals(Math.round(Math.log10(rec.scale)));
    const factor = this.scale / rec.scale;
    const minute = newMinute(rec.t, true);
    for (let i = 0; i < rec.keys.length; i++) minute.levels.set(rec.keys[i] * factor, [rec.sell[i], rec.buy[i]]);
    const qd = Math.round(Math.log10(rec.qscale));
    if (qd > this.qdec) this.qdec = qd;
    minute.firstId = rec.firstId;
    minute.lastId = rec.lastId;
    minute.closed = true;
    return minute;
  }

  emit(minutes) {
    if (!this.onUpdate || !minutes.length) return;
    try {
      this.onUpdate(minutes.map((m) => this.pack(m)));
    } catch (err) {
      this.logger.error('[footprint] update sink threw', err);
    }
  }

  persist(minutes) {
    if (!this.store) return;
    const recs = minutes.filter((m) => m.complete && m.closed).map((m) => this.pack(m));
    if (!recs.length) return;
    Promise.resolve(this.store.write(recs)).catch((err) => {
      this.logger.error('[footprint] disk write failed', this.symbol, err);
    });
  }

  /** Everything held from `fromSec` on, packed, oldest first. */
  snapshot(fromSec = this.fromSec) {
    return [...this.minutes.values()]
      .filter((m) => m.t >= fromSec)
      .sort((a, b) => a.t - b.t)
      .map((m) => this.pack(m));
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.liveTimer);
    this.queue.clear();
  }
}
