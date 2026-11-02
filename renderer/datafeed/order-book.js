/**
 * Resting-order walls: price levels where the order book holds far more than
 * the levels around them, and what became of each one -- traded into, or
 * pulled before price got there.
 *
 * The book. Binance has no stream of the whole book, only a REST snapshot and
 * a stream of the levels that changed. The local copy is the snapshot with
 * every later change applied in sequence (each frame names the update it
 * follows; a gap means one was missed, and the book is fetched again). The
 * snapshot is 5,000 levels a side on spot, about ±1.5% on BTC, but only 1,000
 * on perpetuals, under ±0.2% on BTC; levels further out join the book as they
 * change, which an order being placed or moved does, so a perpetual's book
 * fills out over its first minutes.
 *
 * A wall. The book within RANGE of the mid is summed into buckets of BUCKET
 * (5 basis points: $50 on BTC near 80K, $1 on ETH near 2,000), so an order
 * spread over a few ticks counts as one. A bucket's score is its size over
 * the median of the buckets near it on its side (NEIGHBOURS each way): the
 * book is always thicker by the mid than a percent out, and against the
 * whole side's median every level near the price would stand out. From
 * MIN_SENS up it is a wall; each carries the highest score it reached, and a
 * card shows those whose peak reached its own choice. It stays a wall until
 * it holds less than half its peak, so one hovering at the threshold does
 * not flicker in and out.
 *
 * Its end. When a wall goes, the question is whether price reached it: if
 * the best price on its side came within a bucket of it since the last
 * check, it was traded into ("filled"); if price was elsewhere, it was taken
 * away ("pulled"). For a large order that is what spoofing looks like --
 * shown to move others, cancelled before anyone can hit it.
 */

/** Walls are looked for this far either side of the mid. */
export const RANGE = 0.03;
/** Bucket width, as a share of the mid. */
export const BUCKET = 0.0005;
/** Buckets each way a wall is measured against. */
const NEIGHBOURS = 10;
/** Most walls kept a side. */
const MAX_WALLS = 10;
/** Walls are found from this score up; the card picks among them (see header). */
export const MIN_SENS = 5;
export const SENS_CHOICES = [5, 10, 20];
/**
 * A wall that lived less than this is not recorded when it goes: by the mid,
 * market makers re-quote every few seconds, and each would be a "pull".
 */
const MIN_LIFE_MS = 10_000;
/**
 * A wall must also hold at least the median bucket within NEAR_MID of the
 * mid: far out the book is thin, and a few thousand dollars among dust is
 * not a wall however it scores.
 */
const NEAR_MID = 0.005;
/** Ended walls kept, and for how long. */
const ENDED_MAX = 400;
const ENDED_MS = 6 * 60 * 60_000;
/** Frames buffered while the snapshot is in flight, at most. */
const BUFFER_MAX = 2000;
/** After a failed snapshot, wait this long before the next. */
const RETRY_MS = 5000;
/**
 * Snapshots at most this often. One older than the stream's first frame is
 * fetched again, and a REST copy that keeps lagging would otherwise be asked
 * for in a tight loop; the frames meanwhile are buffered.
 */
const MIN_GAP_MS = 1000;
/**
 * A book is read for walls only this long after it goes live: a perpetual's
 * snapshot covers a few tenths of a percent, and until the levels beyond have
 * changed once and joined it, the few that have look like walls in an empty
 * book.
 */
const WARMUP_MS = { spot: 5000, perp: 90_000 };
/** Neighbours with something in them a bucket needs to be scored at all. */
const MIN_NEAR = 5;
/** Scores are capped here: past it the number says nothing more. */
const MAX_SCORE = 999;

/** A round width near `raw`: 1, 2 or 5 times a power of ten. */
export function niceStep(raw) {
  if (!(raw > 0)) return 0;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

function median(values) {
  if (!values.length) return 0;
  const s = Float64Array.from(values).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * The local copy of one symbol's book. Feed it the diff stream's frames with
 * `diff()`; it fetches the snapshot itself, and again whenever the sequence
 * breaks.
 *
 *   idle -> loading (frames buffered) -> priming (waiting for the frame that
 *   straddles the snapshot) -> live (each frame must follow the last)
 */
export class OrderBook {
  /**
   * @param {{
   *   symbol: string,
   *   market: 'spot'|'perp',
   *   fetchJson: (path: string) => Promise<any>,
   *   logger?: Console,
   * }} opts
   */
  constructor({ symbol, market, fetchJson, logger = console }) {
    this.symbol = symbol;
    this.market = market;
    this.fetchJson = fetchJson;
    this.logger = logger;
    /** price -> quantity. */
    this.bids = new Map();
    this.asks = new Map();
    this.lastId = 0;
    this.state = 'idle';
    this.buffer = [];
    this.retryAt = 0;
    /** When the book last went live; see WARMUP_MS. */
    this.liveAt = 0;
    this.stopped = false;
  }

  get synced() {
    return this.state === 'live';
  }

  /** Live, and long enough to be read for walls. */
  get warm() {
    return this.synced && Date.now() - this.liveAt >= (WARMUP_MS[this.market] || 0);
  }

  /** One frame of `<symbol>@depth`: {U, u, pu?, b: [[p, q]], a: [[p, q]]}. */
  diff(frame) {
    if (this.stopped || !frame) return;
    if (this.state === 'idle' || this.state === 'loading') {
      if (this.buffer.length < BUFFER_MAX) this.buffer.push(frame);
      if (this.state === 'idle' && Date.now() >= this.retryAt) this.load();
      return;
    }
    if (this.state === 'priming') {
      this.prime(frame);
      return;
    }
    if (!this.follows(frame)) {
      this.logger.log('[book]', this.symbol, this.market, 'sequence broke, fetching it again');
      this.restart(frame);
      return;
    }
    this.apply(frame);
  }

  /** Does `frame` come right after what is applied? */
  follows(frame) {
    // Perpetual frames name the one before them; spot frames start where it ended.
    if (frame.pu !== undefined) return frame.pu === this.lastId;
    return frame.U === this.lastId + 1;
  }

  /** Before the first frame past the snapshot: drop what it holds, apply the one that straddles it. */
  prime(frame) {
    if (frame.u <= this.lastId) return;
    if (frame.U > this.lastId + 1) {
      this.restart(frame);
      return;
    }
    this.apply(frame);
    this.state = 'live';
    // Back after a short break the book is as full as it was; only the first
    // time does it have to fill out.
    if (!this.liveAt) this.liveAt = Date.now();
  }

  restart(frame) {
    this.state = 'idle';
    this.buffer = frame ? [frame] : [];
    if (Date.now() >= this.retryAt) this.load();
  }

  async load() {
    this.state = 'loading';
    this.retryAt = Date.now() + MIN_GAP_MS;
    try {
      const limit = this.market === 'perp' ? 1000 : 5000;
      const snap = await this.fetchJson(`/depth?symbol=${encodeURIComponent(this.symbol)}&limit=${limit}`);
      if (this.stopped) return;
      if (!snap || !Array.isArray(snap.bids) || !Array.isArray(snap.asks)) throw new Error('no book in the answer');
      this.bids = new Map(snap.bids.map(([p, q]) => [Number(p), Number(q)]));
      this.asks = new Map(snap.asks.map(([p, q]) => [Number(p), Number(q)]));
      this.lastId = Number(snap.lastUpdateId);
      this.state = 'priming';
      const pending = this.buffer;
      this.buffer = [];
      for (const f of pending) this.diff(f);
    } catch (err) {
      if (this.stopped) return;
      this.logger.warn('[book] snapshot failed', this.symbol, this.market, err && err.message);
      this.state = 'idle';
      this.buffer = [];
      this.retryAt = Date.now() + RETRY_MS;
    }
  }

  apply(frame) {
    for (const [p, q] of frame.b || []) setLevel(this.bids, Number(p), Number(q));
    for (const [p, q] of frame.a || []) setLevel(this.asks, Number(p), Number(q));
    this.lastId = frame.u;
  }

  /** Drop the levels further than `share` from `mid`: orders far out that never change. */
  prune(mid, share) {
    for (const side of [this.bids, this.asks]) {
      for (const p of side.keys()) if (Math.abs(p / mid - 1) > share) side.delete(p);
    }
  }

  bestBid() {
    let best = -Infinity;
    for (const p of this.bids.keys()) if (p > best) best = p;
    return best;
  }

  bestAsk() {
    let best = Infinity;
    for (const p of this.asks.keys()) if (p < best) best = p;
    return best;
  }

  stop() {
    this.stopped = true;
    this.bids.clear();
    this.asks.clear();
  }
}

function setLevel(side, price, qty) {
  if (!Number.isFinite(price)) return;
  if (qty > 0) side.set(price, qty);
  else side.delete(price);
}

/**
 * One side of the book within RANGE, in buckets: Map(bucket floor -> {qty, usd}).
 * A bucket is [p, p + step).
 */
export function bucketSide(levels, mid, step, isBid) {
  const out = new Map();
  const lo = mid * (1 - RANGE);
  const hi = mid * (1 + RANGE);
  for (const [p, q] of levels) {
    if (p < lo || p > hi) continue;
    if (isBid ? p > mid : p < mid) continue; // crossed for a moment, mid-update
    const key = Math.round(Math.floor(p / step) * step * 1e8) / 1e8;
    const b = out.get(key);
    if (b) {
      b.qty += q;
      b.usd += p * q;
    } else out.set(key, { qty: q, usd: p * q });
  }
  return out;
}

/**
 * Each bucket's size over the median of the non-empty buckets near it:
 * Map(price -> score). With fewer than MIN_NEAR of those there is nothing to
 * measure it against, and it scores 0.
 */
export function scoreBuckets(buckets, step) {
  const scores = new Map();
  for (const [price, b] of buckets) {
    const near = [];
    for (let k = 1; k <= NEIGHBOURS; k++) {
      for (const p of [price - k * step, price + k * step]) {
        const n = buckets.get(Math.round(p * 1e8) / 1e8);
        if (n) near.push(n.usd);
      }
    }
    const m = near.length >= MIN_NEAR ? median(near) : 0;
    scores.set(price, m > 0 ? Math.min(MAX_SCORE, b.usd / m) : 0);
  }
  return scores;
}

/** Walls of one book, followed over time. `check()` once a second or so. */
export class WallTracker {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.step = 0;
    /** `${side}:${price}` -> wall */
    this.live = new Map();
    /** Ended walls, oldest first. */
    this.ended = [];
    /**
     * How far price went since the last check: the lowest best bid (sellers
     * reaching down into the bids) and the highest best ask.
     */
    this.reach = { bidLow: Infinity, askHigh: -Infinity };
    this.seq = 0;
  }

  /** Price as far as it went; call as often as the book moves. */
  touch(bestBid, bestAsk) {
    if (bestBid < this.reach.bidLow) this.reach.bidLow = bestBid;
    if (bestAsk > this.reach.askHigh) this.reach.askHigh = bestAsk;
  }

  /**
   * Find the walls in `book` now, carry on the ones already known, and end the
   * ones that are gone. Returns the walls that ended in this check.
   */
  check(book) {
    if (!book.warm) return [];
    const bid = book.bestBid();
    const ask = book.bestAsk();
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid >= ask) return [];
    this.touch(bid, ask);
    const mid = (bid + ask) / 2;
    // The bucket width follows the price only once it has moved a long way:
    // a width that changed every check would end and restart every wall.
    const want = niceStep(mid * BUCKET);
    if (!this.step || want / this.step > 2.5 || this.step / want > 2.5) {
      if (this.step) this.endAll('rescaled');
      this.step = want;
    }
    const step = this.step;
    const t = this.now();
    const seen = new Set();
    for (const [side, levels, isBid] of [['bid', book.bids, true], ['ask', book.asks, false]]) {
      const buckets = bucketSide(levels, mid, step, isBid);
      const scores = scoreBuckets(buckets, step);
      const floor = median([...buckets].filter(([p]) => Math.abs(p / mid - 1) <= NEAR_MID).map(([, b]) => b.usd));
      for (const w of this.live.values()) {
        if (w.side !== side) continue;
        const b = buckets.get(w.price);
        // Known walls need only half their peak to carry on.
        if (!b || b.usd < w.peak * 0.5) continue;
        const score = scores.get(w.price);
        // Still there, but no longer above what is around it (the book filled
        // in): no longer a wall, and not something that was pulled either.
        if (score < MIN_SENS / 2) {
          this.live.delete(w.key);
          continue;
        }
        w.usd = b.usd;
        w.qty = b.qty;
        w.score = score;
        if (w.score > w.peakScore) w.peakScore = w.score;
        if (b.usd > w.peak) w.peak = b.usd;
        seen.add(w.key);
      }
      const fresh = [...buckets.entries()]
        .filter(([price, b]) => scores.get(price) >= MIN_SENS && b.usd >= floor)
        .sort((a, b) => b[1].usd - a[1].usd)
        .slice(0, MAX_WALLS);
      for (const [price, b] of fresh) {
        const key = `${side}:${price}`;
        if (seen.has(key)) continue;
        const score = scores.get(price);
        this.live.set(key, {
          id: ++this.seq,
          key,
          side,
          price,
          step,
          usd: b.usd,
          qty: b.qty,
          peak: b.usd,
          score,
          peakScore: score,
          since: t,
        });
        seen.add(key);
      }
    }
    const ended = [];
    for (const [key, w] of [...this.live]) {
      if (seen.has(key)) continue;
      this.live.delete(key);
      if (t - w.since < MIN_LIFE_MS) continue;
      ended.push(this.finish(w, t, this.reached(w) ? 'filled' : 'pulled'));
    }
    this.trim();
    this.reach = { bidLow: bid, askHigh: ask };
    return ended;
  }

  /** Did price come within a bucket of the wall since the last check? */
  reached(w) {
    if (w.side === 'bid') return this.reach.bidLow <= w.price + 2 * w.step;
    return this.reach.askHigh >= w.price - w.step;
  }

  finish(w, t, how) {
    const e = pub({ ...w, end: t, how });
    this.ended.push(e);
    const cutoff = t - ENDED_MS;
    while (this.ended.length > ENDED_MAX || (this.ended.length && this.ended[0].end < cutoff)) this.ended.shift();
    return e;
  }

  /** Only the largest few a side stay on show; the rest are dropped quietly. */
  trim() {
    for (const side of ['bid', 'ask']) {
      const list = [...this.live.values()].filter((w) => w.side === side).sort((a, b) => b.usd - a.usd);
      for (const w of list.slice(MAX_WALLS)) this.live.delete(w.key);
    }
  }

  endAll(how) {
    const t = this.now();
    for (const w of this.live.values()) if (t - w.since >= MIN_LIFE_MS) this.finish(w, t, how);
    this.live.clear();
  }

  /** What a card needs: the walls standing and the ones that ended from `fromMs`. */
  snapshot(fromMs = 0) {
    return {
      step: this.step,
      walls: [...this.live.values()].map(pub),
      ended: this.ended.filter((e) => e.end >= fromMs && e.how !== 'rescaled'),
    };
  }
}

/** The fields a card draws; the tracker's own bookkeeping stays behind. */
function pub(w) {
  const out = {
    id: w.id,
    side: w.side,
    price: w.price,
    step: w.step,
    usd: w.usd,
    qty: w.qty,
    peak: w.peak,
    score: w.score,
    peakScore: w.peakScore,
    since: w.since,
  };
  if (w.end) {
    out.end = w.end;
    out.how = w.how;
  }
  return out;
}

/* ------------------------------------------------------------------ feed */

/** How often walls are looked for and sent. */
const CHECK_MS = 1000;
/** Levels further than this from the mid are dropped, every PRUNE_EVERY checks. */
const KEEP = 0.1;
const PRUNE_EVERY = 30;
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
/** The depth stream is never quiet; one silent this long is dead. */
const SILENT_MS = 30_000;

/**
 * Every watched book of one market, on a socket of its own: the depth
 * stream is the busiest there is (a BTC perpetual frame changes 800 levels),
 * and on perpetuals it is not served on the socket the rest of the market
 * data uses at all (`/market/stream` carries no depth; `/public` does).
 *
 * Books are shared by key (a card's subscription id): `watch()` starts one or
 * joins it, `unwatch()` lets it go, and the socket closes when no book is
 * left. Each watcher hears {market, symbol, ready, step, walls, ended} every
 * CHECK_MS -- `ended` being only the walls that ended since the last.
 */
export class BookFeed {
  /**
   * @param {{
   *   market: 'spot'|'perp',
   *   url: string,                 the combined-stream WebSocket URL
   *   suffix: string,              e.g. '@depth' or '@depth@500ms'
   *   fetchJson: (path: string) => Promise<any>,
   *   logger?: Console,
   * }} opts
   */
  constructor({ market, url, suffix, fetchJson, logger = console }) {
    this.market = market;
    this.url = url;
    this.suffix = suffix;
    this.fetchJson = fetchJson;
    this.logger = logger;
    /** symbol -> {book, tracker, listeners: Map<key, fn>} */
    this.symbols = new Map();
    /** key -> symbol */
    this.keys = new Map();
    this.ws = null;
    this.attempt = 0;
    this.reconnectTimer = null;
    this.watchdog = null;
    this.lastMessageAt = 0;
    this.timer = null;
    this.ticks = 0;
    this.requestId = 1;
  }

  stream(symbol) {
    return `${symbol.toLowerCase()}${this.suffix}`;
  }

  /**
   * Watch `symbol`'s walls under `key`, replacing whatever `key` watched.
   * Returns what is known now (ended walls from `fromMs`); `listener` hears
   * the rest.
   */
  watch(key, symbol, listener, fromMs = 0) {
    const upper = String(symbol || '').toUpperCase();
    if (this.keys.get(key) !== upper) this.unwatch(key);
    let entry = this.symbols.get(upper);
    if (!entry) {
      entry = { book: this.newBook(upper), tracker: new WallTracker(), listeners: new Map() };
      this.symbols.set(upper, entry);
      this.sendControl('SUBSCRIBE', [this.stream(upper)]);
    }
    entry.listeners.set(key, listener);
    this.keys.set(key, upper);
    this.ensure();
    return this.payload(upper, entry, entry.tracker.snapshot(fromMs));
  }

  unwatch(key) {
    const symbol = this.keys.get(key);
    if (!symbol) return;
    this.keys.delete(key);
    const entry = this.symbols.get(symbol);
    if (!entry) return;
    entry.listeners.delete(key);
    if (entry.listeners.size) return;
    entry.book.stop();
    this.symbols.delete(symbol);
    this.sendControl('UNSUBSCRIBE', [this.stream(symbol)]);
    if (!this.symbols.size) this.close();
  }

  newBook(symbol) {
    return new OrderBook({ symbol, market: this.market, fetchJson: this.fetchJson, logger: this.logger });
  }

  payload(symbol, entry, snap) {
    return { market: this.market, symbol, ready: entry.book.warm, ...snap };
  }

  /* ------------------------------------------------------------ socket */

  ensure() {
    if (!this.timer) this.timer = setInterval(() => this.check(), CHECK_MS);
    if (!this.ws) this.connect();
  }

  connect() {
    clearTimeout(this.reconnectTimer);
    if (!this.symbols.size) return;
    const connectedWith = new Set([...this.symbols.keys()].map((s) => this.stream(s)));
    let ws;
    try {
      ws = new WebSocket(`${this.url}?streams=${[...connectedWith].join('/')}`);
    } catch (err) {
      this.logger.error('[book] websocket construction failed', err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.lastMessageAt = Date.now();
      // Books added or dropped while the handshake was out.
      const now = new Set([...this.symbols.keys()].map((s) => this.stream(s)));
      const added = [...now].filter((s) => !connectedWith.has(s));
      const removed = [...connectedWith].filter((s) => !now.has(s));
      if (added.length) this.sendControl('SUBSCRIBE', added);
      if (removed.length) this.sendControl('UNSUBSCRIBE', removed);
      this.armWatchdog(ws);
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      this.lastMessageAt = Date.now();
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      const data = msg && msg.data;
      if (!data || !data.s) return;
      const entry = this.symbols.get(data.s);
      if (!entry) return;
      entry.book.diff(data);
      if (entry.book.synced) entry.tracker.touch(entry.book.bestBid(), entry.book.bestAsk());
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearTimeout(this.watchdog);
      if (!this.symbols.size) return;
      // What changed while away is not in the books: start them again.
      for (const [symbol, entry] of this.symbols) {
        entry.book.stop();
        entry.book = this.newBook(symbol);
      }
      this.scheduleReconnect();
    };
  }

  armWatchdog(ws) {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      if (this.ws !== ws) return;
      if (Date.now() - this.lastMessageAt >= SILENT_MS) {
        this.logger.log('[book]', this.market, 'depth stream silent, reconnecting');
        try {
          ws.close();
        } catch {
          /* already closing */
        }
        return;
      }
      this.armWatchdog(ws);
    }, SILENT_MS / 2);
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** this.attempt);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  sendControl(method, params) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ method, params, id: this.requestId++ }));
  }

  close() {
    clearInterval(this.timer);
    this.timer = null;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.watchdog);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    }
  }

  /* ------------------------------------------------------------- walls */

  check() {
    this.ticks += 1;
    for (const [symbol, entry] of this.symbols) {
      const { book, tracker } = entry;
      const ended = book.warm ? tracker.check(book) : [];
      if (book.synced && this.ticks % PRUNE_EVERY === 0) {
        const bid = book.bestBid();
        const ask = book.bestAsk();
        if (Number.isFinite(bid) && Number.isFinite(ask)) book.prune((bid + ask) / 2, KEEP);
      }
      const msg = this.payload(symbol, entry, { ...tracker.snapshot(Infinity), ended });
      for (const listener of entry.listeners.values()) {
        try {
          listener(msg);
        } catch (err) {
          this.logger.error('[book] listener threw', err);
        }
      }
    }
  }

  destroy() {
    for (const entry of this.symbols.values()) entry.book.stop();
    this.symbols.clear();
    this.keys.clear();
    this.close();
  }
}
