/** Small shared helpers for the renderer layer. */

/** Terse DOM builder: el('div.card__title', {title: 'x'}, 'text'). */
export function el(spec, attrs = {}, ...children) {
  const [tagPart, ...classes] = String(spec).split('.');
  const tag = tagPart || 'div';
  const node = document.createElement(tag);
  if (classes.length) node.className = classes.join(' ');

  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = [node.className, value].filter(Boolean).join(' ');
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }

  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function debounce(fn, delay = 250) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Coalesces high-frequency setting changes into a single write.
 *
 * Dragging an opacity slider fires `input` dozens of times a second, and each
 * one would otherwise be an IPC round trip plus a synchronous store write to
 * disk. Discrete changes (symbol, interval, chart type) still save immediately.
 *
 * @param {(patch: object) => void} save
 */
export function createPatchQueue(save, { delay = 200, coalesce = ['cardOpacity', 'windowOpacity'] } = {}) {
  let pending = null;

  const flush = debounce(() => {
    const patch = pending;
    pending = null;
    if (patch) save(patch);
  }, delay);

  return (patch) => {
    pending = { ...(pending || {}), ...patch };
    if (Object.keys(patch).every((key) => coalesce.includes(key))) {
      flush();
      return;
    }
    flush.cancel();
    const next = pending;
    pending = null;
    save(next);
  };
}

/**
 * Price formatting that stays readable across BTC (5 digits) and
 * memecoins (8 decimals).
 */
export function formatPrice(price) {
  const n = Number(price);
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  let digits;
  if (abs >= 1000) digits = 2;
  else if (abs >= 1) digits = 3;
  else if (abs >= 0.01) digits = 5;
  else if (abs >= 0.0001) digits = 7;
  else digits = 8;
  return n.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

export function formatCompact(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(2);
}

/** Split "BTCUSDT" into "BTC / USDT" for display when we know the quote asset. */
export function prettySymbol(symbol) {
  const QUOTES = ['USDT', 'FDUSD', 'USDC', 'TUSD', 'BUSD', 'BTC', 'ETH', 'BNB', 'TRY', 'EUR'];
  const upper = String(symbol || '').toUpperCase();
  const quote = QUOTES.find((q) => upper.endsWith(q) && upper.length > q.length);
  return quote ? `${upper.slice(0, -quote.length)}/${quote}` : upper;
}

export const STATUS_LABELS = {
  live: '即時連線中',
  reconnecting: '連線中斷,重新連線中…',
  offline: '網路離線',
  idle: '尚未連線',
};

/**
 * The short form shown on the card itself when the feed is in trouble.
 *
 * `live` and `idle` are deliberately absent: a working feed should say nothing.
 * Keep these to three characters -- the badge shares a 26px bar with the symbol
 * and the price on a card that may only be 300px wide.
 */
export const STATUS_BADGES = {
  reconnecting: '重連中',
  offline: '離線',
};

/**
 * Format at an explicitly given precision.
 *
 * `formatPrice` picks its decimals from the magnitude of the value it is
 * handed, which is right for a price and wrong for a *difference* between two:
 * a 550 move on an 86,000 instrument would print 3 decimals when the
 * instrument only quotes 2.
 */
export function formatAtPrecision(value, digits) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Compact span for the measure readout: 45m, 3h 20m, 2d 4h. */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600) % 24;
  const d = Math.floor(total / 86400);
  if (d) return h ? `${d}d ${h}h` : `${d}d`;
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

export const INTERVAL_LABELS = {
  '1m': '1 分',
  '5m': '5 分',
  '15m': '15 分',
  '1h': '1 時',
  '4h': '4 時',
  '1d': '1 日',
};

/** Title-bar chip text. Two characters, to sit beside the interval chip. */
export const MARKET_LABELS = {
  spot: '現貨',
  perp: '永續',
};

/** Funding rate as Binance quotes it: 0.0001 -> "+0.0100%". */
export function formatFundingRate(rate) {
  const n = Number(rate);
  if (!Number.isFinite(n)) return '—';
  const pct = n * 100;
  return `${pct > 0 ? '+' : ''}${pct.toFixed(4)}%`;
}

/** Time left to the next funding, as a clock: 3:07:45, or 07:45 under an hour. */
export function formatCountdown(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
  const s = String(total % 60).padStart(2, '0');
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${String(m).padStart(2, '0')}:${s}`;
}

export const CHART_TYPE_LABELS = {
  candlestick: 'K 線',
  line: '折線',
  area: '面積',
};
