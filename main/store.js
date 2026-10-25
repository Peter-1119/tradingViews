'use strict';

/**
 * Persistent settings (spec §7).
 *
 * Owns the canonical shape of the config, validation/normalisation of anything
 * read back from disk, and bounds sanity-checking against the *current* display
 * layout (a card saved on a monitor that no longer exists must be pulled back
 * into view).
 */

const Store = require('electron-store');
const { screen } = require('electron');
const { randomUUID } = require('crypto');

const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'];
const CHART_TYPES = ['candlestick', 'line', 'area'];
const VP_MODES = ['off', 'session4h', 'visible', 'day'];
/** Binance spot, or USD-M perpetuals. */
const MARKETS = ['spot', 'perp'];

/** Position-alert windows and the percentile levels each may alert on. */
const ALERT_WINDOWS = ['4H', '24H', '72H'];
const ALERT_LEVELS = [5, 10, 20, 80, 90, 95];

const CARD_MIN_WIDTH = 220;
const CARD_MIN_HEIGHT = 140;
const CARD_DEFAULT_WIDTH = 340;
const CARD_DEFAULT_HEIGHT = 220;

const DEFAULTS = {
  mode: 'float',
  cards: [],
  board: { bounds: null, columns: 2, alwaysOnTop: true },
  shortcuts: {
    toggleShow: 'Ctrl+Alt+S',
    toggleClickThrough: 'Ctrl+Alt+C',
  },
  upDownColor: 'greenUp',
  /**
   * IANA zone name, or 'auto' to follow the machine. Binance timestamps are
   * UTC epoch seconds and lightweight-charts renders them as UTC unless told
   * otherwise, which is why the axis read 8 hours behind Taipei by default.
   */
  timezone: 'auto',
  /** Interface language: 'en' (the default) or 'zh-TW'. */
  language: 'en',
  /**
   * Keep downloaded bars on disk. On by default: it has no downside beyond
   * space, and the whole point is that the second look at a range is instant.
   * The escape hatch that matters is clearing it, not switching it off.
   */
  cacheBars: true,
  launchAtStartup: false,
  clickThrough: false,
  /**
   * {symbol, market} entries one click away in the title bar's dropdown, in the
   * user's order. Global rather than per card: it is a list of what the user
   * trades, not a property of any one window. The market is part of the entry,
   * so "BTC perp" and "ETH spot" can sit side by side and Alt+1..9, 0 lands on the
   * right one.
   */
  watchlist: [],
  /**
   * Price-position alerts for watchlist symbols. 4H only at the extremes:
   * measured, a 4h window alerts ~45 times a day per symbol at every level,
   * and ~11 at 5/95 alone -- where a 4h breakout is the news.
   */
  alerts: {
    /** Master switch, from the tray. Off: nothing is delivered for any symbol. */
    enabled: true,
    toast: true,
    flash: true,
    levels: {
      '4H': [5, 95],
      '24H': [5, 10, 20, 80, 90, 95],
      '72H': [5, 10, 20, 80, 90, 95],
    },
  },
  /**
   * Horizontal support/resistance levels, keyed by symbol -- deliberately not
   * by card, not by interval, and not by market: spot and perp BTCUSDT track
   * each other to within a basis point or two, so a level drawn on one is the
   * level on the other. Contracts quoted at a multiple (1000PEPEUSDT) have
   * their own symbol, and so their own drawings, which their scale needs. A price level has no time anchor, so the same
   * line is meaningful on every timeframe, and keying by symbol means every
   * card showing BTCUSDT shows the same levels without any syncing logic.
   */
  levels: {},
  /**
   * Fibonacci retracements, also keyed by symbol. Anchors are {time, price}
   * rather than bar indices, so they survive a timeframe switch and a change in
   * how much history is loaded.
   */
  fibs: {},
  /**
   * Rectangles: a price zone bounded in time, for the short-lived support and
   * resistance a full-width level would overstate. Keyed by symbol, anchors
   * {time, price}, the same as fibs.
   */
  rects: {},
  /**
   * Trend lines: a segment between two {time, price} anchors, keyed by symbol
   * like rectangles, for sloped support and resistance.
   */
  trendlines: {},
  /**
   * Range volume profiles: [{id, from, to}] per symbol, times in seconds.
   * `to` is exclusive; null means "to now" -- the range stays open and grows.
   * Price plays no part: a range is a span of time, profiled over every
   * price traded in it.
   */
  vranges: {},
  /**
   * Price alerts: [{id, symbol, market, price, direction: 'up'|'down', createdAt}].
   * One-shot -- removed when hit. `direction` is which side of the price the
   * market was on when the alert was set: 'up' fires at or above, 'down' at
   * or below, so an alert never fires just for being created.
   */
  priceAlerts: [],
};

/** One per digit key, in keyboard order: Alt+1..9, then Alt+0 for the tenth. */
const WATCHLIST_MAX = 10;

/** Enough for any real chart; a guard against a stuck drag writing thousands. */
const MAX_LEVELS_PER_SYMBOL = 60;
/** Plenty for manual use; a guard against something runaway. */
const MAX_PRICE_ALERTS = 200;

const store = new Store({ name: 'stock-card-config', defaults: DEFAULTS });

/* ------------------------------------------------------------------ utils */

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function pickMarket(value) {
  return pick(value, MARKETS, 'spot');
}

/** A brand-new card, positioned so stacked cards do not perfectly overlap. */
function defaultCardBounds(index = 0) {
  const area = screen.getPrimaryDisplay().workArea;
  const offset = (index % 6) * 28;
  return {
    x: Math.round(area.x + area.width - CARD_DEFAULT_WIDTH - 40 - offset),
    y: Math.round(area.y + 80 + offset),
    width: CARD_DEFAULT_WIDTH,
    height: CARD_DEFAULT_HEIGHT,
  };
}

/**
 * Pull a saved rectangle back onto a display that actually exists.
 * Returns a rectangle guaranteed to have a visible chunk on some screen.
 */
function normalizeBounds(bounds, { minWidth = CARD_MIN_WIDTH, minHeight = CARD_MIN_HEIGHT } = {}) {
  const displays = screen.getAllDisplays();
  const fallback = defaultCardBounds(0);

  if (!bounds || typeof bounds !== 'object') return fallback;

  const width = Math.round(clampNumber(bounds.width, minWidth, 4000, fallback.width));
  const height = Math.round(clampNumber(bounds.height, minHeight, 4000, fallback.height));
  let x = Math.round(Number(bounds.x));
  let y = Math.round(Number(bounds.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ...fallback, width, height };

  // "Visible enough" = at least this many px of the title bar area on a screen.
  const VISIBLE_MARGIN = 48;
  const intersects = displays.some((d) => {
    const a = d.workArea;
    return (
      x + width > a.x + VISIBLE_MARGIN &&
      x < a.x + a.width - VISIBLE_MARGIN &&
      y + VISIBLE_MARGIN > a.y &&
      y < a.y + a.height - VISIBLE_MARGIN
    );
  });

  if (!intersects) {
    const area = screen.getPrimaryDisplay().workArea;
    x = Math.round(area.x + (area.width - width) / 2);
    y = Math.round(area.y + (area.height - height) / 2);
  }
  return { x, y, width, height };
}

function sanitizeCard(raw, index = 0) {
  const card = raw && typeof raw === 'object' ? raw : {};
  return {
    id: typeof card.id === 'string' && card.id ? card.id : randomUUID(),
    symbol: typeof card.symbol === 'string' && card.symbol ? card.symbol.toUpperCase() : 'BTCUSDT',
    market: pickMarket(card.market),
    interval: pick(card.interval, INTERVALS, '1m'),
    chartType: pick(card.chartType, CHART_TYPES, 'candlestick'),
    cardOpacity: clampNumber(card.cardOpacity, 0.1, 1, 0.75),
    windowOpacity: clampNumber(card.windowOpacity, 0.2, 1, 1),
    showVolume: card.showVolume === true,
    // Thin volume in the volume pane: the rank (in %) at or under which a bar
    // is thin, and the memory of the filtered distribution it ranks against.
    volSqueeze: pick(card.volSqueeze, ['off', '2', '3', '5', '10'], '5'),
    volMemory: pick(card.volMemory, ['500', '1000', '2000'], '1000'),
    // Was a boolean; `true` meant today's UTC-session profile, which is what
    // 'day' is now. Old configs keep showing what they showed.
    volumeProfile: pick(
      card.volumeProfile,
      VP_MODES,
      card.showVolumeProfile === true ? 'day' : 'off'
    ),
    // Row height of every volume profile on the card, range ones included.
    vpDetail: pick(card.vpDetail, ['coarse', 'normal', 'fine', 'ultra'], 'normal'),
    showHtf: card.showHtf === true,
    // The user's drawings hidden for a clean chart; they stay in their stores.
    hideDrawings: card.hideDrawings === true,
    // Open interest sub-pane. Perpetuals only; a spot card keeps the setting
    // and shows it again when switched back to perp.
    showOI: card.showOI === true,
    // Footprint inside the candles (per-price taker sells and buys), and the
    // diagonal imbalance multiple it marks.
    footprint: card.footprint === true,
    fpRatio: pick(card.fpRatio, ['2', '3', '4'], '3'),
    // Daily / weekly / monthly open rays.
    showOpens: card.showOpens === true,
    // Where the day, week and month start for opens and highs/lows: UTC (the
    // exchange's candles), New York or London midnight, or the New York
    // (09:30) or London (08:00) stock market open.
    levelAnchor: pick(card.levelAnchor, ['utc', 'ny', 'nyse', 'london', 'lse'], 'utc'),
    // Which opens: this period's, the previous one's (yesterday, last week,
    // last month), or both.
    opensWhich: pick(card.opensWhich, ['current', 'prev', 'both'], 'current'),
    // Highs and lows: of the previous period, the current one so far, or both.
    hilo: pick(card.hilo, ['off', 'prev', 'current', 'both'], 'off'),
    levelPeriods: Array.isArray(card.levelPeriods)
      ? ['D', 'W', 'M'].filter((p) => card.levelPeriods.includes(p))
      : ['D', 'W', 'M'],
    alwaysOnTop: card.alwaysOnTop !== false,
    bounds: normalizeBounds(card.bounds || defaultCardBounds(index)),
  };
}

/* ------------------------------------------------------------------- API */

function getMode() {
  return store.get('mode') === 'board' ? 'board' : 'float';
}

function setMode(mode) {
  store.set('mode', mode === 'board' ? 'board' : 'float');
}

function getCards() {
  const raw = store.get('cards');
  const list = Array.isArray(raw) ? raw : [];
  return list.map((c, i) => sanitizeCard(c, i));
}

function setCards(cards) {
  store.set('cards', cards.map((c, i) => sanitizeCard(c, i)));
}

function getCard(id) {
  return getCards().find((c) => c.id === id) || null;
}

function addCard(partial = {}) {
  const cards = getCards();
  const card = sanitizeCard(
    { ...partial, bounds: partial.bounds || defaultCardBounds(cards.length) },
    cards.length
  );
  cards.push(card);
  setCards(cards);
  return card;
}

/** Shallow-merges `patch` into the stored card. Returns the updated card. */
function updateCard(id, patch = {}) {
  const cards = getCards();
  const index = cards.findIndex((c) => c.id === id);
  if (index === -1) return null;
  const merged = sanitizeCard({ ...cards[index], ...patch, id }, index);
  cards[index] = merged;
  setCards(cards);
  return merged;
}

function removeCard(id) {
  const cards = getCards().filter((c) => c.id !== id);
  setCards(cards);
  return cards;
}

function reorderCards(orderedIds) {
  const cards = getCards();
  const byId = new Map(cards.map((c) => [c.id, c]));
  const ordered = [];
  for (const id of orderedIds) {
    if (byId.has(id)) {
      ordered.push(byId.get(id));
      byId.delete(id);
    }
  }
  // Anything not mentioned keeps its relative order at the end.
  ordered.push(...byId.values());
  setCards(ordered);
  return ordered;
}

function getBoard() {
  const board = store.get('board') || {};
  return {
    bounds: board.bounds || null,
    columns: clampNumber(board.columns, 1, 6, 2),
    alwaysOnTop: board.alwaysOnTop !== false,
  };
}

function setBoard(patch) {
  store.set('board', { ...getBoard(), ...patch });
}

function getShortcuts() {
  const s = store.get('shortcuts') || {};
  return {
    toggleShow: s.toggleShow || DEFAULTS.shortcuts.toggleShow,
    toggleClickThrough: s.toggleClickThrough || DEFAULTS.shortcuts.toggleClickThrough,
  };
}

function setShortcuts(patch) {
  store.set('shortcuts', { ...getShortcuts(), ...patch });
}

function get(key) {
  return store.get(key);
}

function set(key, value) {
  store.set(key, value);
}

/** The blob handed to renderers so they can theme themselves consistently. */
function getGlobalPrefs() {
  return {
    upDownColor: store.get('upDownColor') === 'redUp' ? 'redUp' : 'greenUp',
    timezone: getTimezone(),
    language: store.get('language') === 'zh-TW' ? 'zh-TW' : 'en',
    cacheBars: store.get('cacheBars') !== false,
    mode: getMode(),
    clickThrough: store.get('clickThrough') === true,
    launchAtStartup: store.get('launchAtStartup') === true,
    shortcuts: getShortcuts(),
    boardColumns: getBoard().columns,
    watchlist: getWatchlist(),
    alerts: getAlerts(),
  };
}

function getAlerts() {
  const raw = store.get('alerts') || {};
  const levels = {};
  for (const name of ALERT_WINDOWS) {
    const list = raw.levels && Array.isArray(raw.levels[name]) ? raw.levels[name] : DEFAULTS.alerts.levels[name];
    levels[name] = ALERT_LEVELS.filter((l) => list.includes(l));
  }
  return { enabled: raw.enabled !== false, toast: raw.toast !== false, flash: raw.flash !== false, levels };
}

function setAlerts(patch = {}) {
  const current = getAlerts();
  store.set('alerts', {
    ...current,
    ...patch,
    levels: { ...current.levels, ...(patch.levels || {}) },
  });
  return getAlerts();
}

/**
 * {symbol, market} entries, de-duplicated, in order, at most WATCHLIST_MAX.
 * A bare string is a list saved before perpetuals existed, and means spot.
 */
function sanitizeWatchlist(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const entry = item && typeof item === 'object' ? item : { symbol: item };
    const symbol = String(entry.symbol || '').toUpperCase();
    const market = pickMarket(entry.market);
    if (!/^[A-Z0-9]{2,30}$/.test(symbol)) continue;
    if (out.some((e) => e.symbol === symbol && e.market === market)) continue;
    // Per-symbol alert switch; on unless turned off, so older lists keep alerting.
    out.push({ symbol, market, alert: entry.alert !== false });
    if (out.length >= WATCHLIST_MAX) break;
  }
  return out;
}

function getWatchlist() {
  return sanitizeWatchlist(store.get('watchlist'));
}

function setWatchlist(list) {
  const clean = sanitizeWatchlist(list);
  store.set('watchlist', clean);
  return clean;
}

/** A zone the runtime actually knows; anything else falls back to the machine. */
function getTimezone() {
  const value = store.get('timezone');
  if (value === 'auto' || !value) return 'auto';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    return 'auto';
  }
}

/* ---------------------------------------------------------------- levels */

/** A drawing's colour: `#rrggbb`, or null for the default blue. */
function sanitizeColor(raw) {
  return typeof raw === 'string' && /^#[0-9a-f]{6}$/i.test(raw) ? raw.toLowerCase() : null;
}

/** Copy the colour onto a sanitized drawing, if it has one. */
function withColor(record, raw) {
  const color = sanitizeColor(raw && raw.color);
  return color ? { ...record, color } : record;
}

function sanitizeLevel(raw) {
  const price = Number(raw && raw.price);
  // A level at or below zero is not a price, it is a corrupt record.
  if (!Number.isFinite(price) || price <= 0) return null;
  const id = raw && typeof raw.id === 'string' && raw.id ? raw.id : randomUUID();
  return withColor({ id, price }, raw);
}

function levelKey(symbol) {
  return String(symbol || '').toUpperCase();
}

function getLevels(symbol) {
  const key = levelKey(symbol);
  if (!key) return [];
  const all = store.get('levels') || {};
  const list = Array.isArray(all[key]) ? all[key] : [];
  return list.map(sanitizeLevel).filter(Boolean);
}

function setLevels(symbol, list) {
  const key = levelKey(symbol);
  if (!key) return [];
  const all = { ...(store.get('levels') || {}) };
  const seen = new Set();
  const clean = (Array.isArray(list) ? list : [])
    .map(sanitizeLevel)
    .filter(Boolean)
    // Two levels at the identical price are never meaningful, and the magnet
    // makes them easy to produce: snapping twice near the same wick yields the
    // exact same OHLC value, so the second line lands invisibly on the first.
    .filter((level) => {
      if (seen.has(level.price)) return false;
      seen.add(level.price);
      return true;
    })
    .slice(0, MAX_LEVELS_PER_SYMBOL)
    .sort((a, b) => b.price - a.price);
  // Drop the key entirely when empty, so deleting the last level does not leave
  // a growing graveyard of symbols in the config file.
  if (clean.length) all[key] = clean;
  else delete all[key];
  store.set('levels', all);
  return clean;
}

function addLevel(symbol, price, color) {
  const level = sanitizeLevel({ price, color });
  if (!level) return null;
  setLevels(symbol, [...getLevels(symbol), level]);
  // setLevels drops an exact-price duplicate, so the new record may not have
  // survived. Report what is actually stored, or null -- a caller keeping an
  // undo history must not be handed the id of a line that does not exist.
  return getLevels(symbol).find((l) => l.id === level.id) || null;
}

/** `patch` is {price?, color?}; a bare number is a price (older callers). */
function updateLevel(symbol, id, patch) {
  const change = typeof patch === 'number' ? { price: patch } : patch || {};
  const next = getLevels(symbol).map((l) => (l.id === id ? { ...l, ...change } : l));
  setLevels(symbol, next);
  return getLevels(symbol).find((l) => l.id === id) || null;
}

function removeLevel(symbol, id) {
  return setLevels(
    symbol,
    getLevels(symbol).filter((l) => l.id !== id)
  );
}

/* ------------------------------------------------------------------ fibs */

function sanitizeAnchor(raw) {
  const time = Number(raw && raw.time);
  const price = Number(raw && raw.price);
  if (!Number.isFinite(time) || !Number.isFinite(price) || price <= 0) return null;
  return { time: Math.round(time), price };
}

function sanitizeFib(raw) {
  const a = sanitizeAnchor(raw && raw.a);
  const b = sanitizeAnchor(raw && raw.b);
  if (!a || !b) return null;
  // A zero-height retracement has no levels to draw.
  if (a.price === b.price) return null;
  const id = raw && typeof raw.id === 'string' && raw.id ? raw.id : randomUUID();
  return { id, a, b };
}

function getFibs(symbol) {
  const key = levelKey(symbol);
  if (!key) return [];
  const all = store.get('fibs') || {};
  const list = Array.isArray(all[key]) ? all[key] : [];
  return list.map(sanitizeFib).filter(Boolean);
}

function setFibs(symbol, list) {
  const key = levelKey(symbol);
  if (!key) return [];
  const all = { ...(store.get('fibs') || {}) };
  const clean = (Array.isArray(list) ? list : [])
    .map(sanitizeFib)
    .filter(Boolean)
    .slice(0, MAX_LEVELS_PER_SYMBOL);
  if (clean.length) all[key] = clean;
  else delete all[key];
  store.set('fibs', all);
  return clean;
}

function addFib(symbol, a, b) {
  const fib = sanitizeFib({ a, b });
  if (!fib) return null;
  setFibs(symbol, [...getFibs(symbol), fib]);
  return fib;
}

function updateFib(symbol, id, patch) {
  const next = getFibs(symbol).map((f) => (f.id === id ? { ...f, ...patch } : f));
  setFibs(symbol, next);
  return getFibs(symbol).find((f) => f.id === id) || null;
}

function removeFib(symbol, id) {
  return setFibs(
    symbol,
    getFibs(symbol).filter((f) => f.id !== id)
  );
}

/* ----------------------------------------------------------------- rects */

function sanitizeRect(raw) {
  const a = sanitizeAnchor(raw && raw.a);
  const b = sanitizeAnchor(raw && raw.b);
  if (!a || !b) return null;
  // A rectangle with no height or no width is a line, not a zone.
  if (a.price === b.price || a.time === b.time) return null;
  const id = raw && typeof raw.id === 'string' && raw.id ? raw.id : randomUUID();
  return withColor({ id, a, b }, raw);
}

function getRects(symbol) {
  const key = levelKey(symbol);
  if (!key) return [];
  const all = store.get('rects') || {};
  const list = Array.isArray(all[key]) ? all[key] : [];
  return list.map(sanitizeRect).filter(Boolean);
}

function setRects(symbol, list) {
  const key = levelKey(symbol);
  if (!key) return [];
  const all = { ...(store.get('rects') || {}) };
  const clean = (Array.isArray(list) ? list : [])
    .map(sanitizeRect)
    .filter(Boolean)
    .slice(0, MAX_LEVELS_PER_SYMBOL);
  if (clean.length) all[key] = clean;
  else delete all[key];
  store.set('rects', all);
  return clean;
}

function addRect(symbol, a, b, color) {
  const rect = sanitizeRect({ a, b, color });
  if (!rect) return null;
  setRects(symbol, [...getRects(symbol), rect]);
  return getRects(symbol).find((r) => r.id === rect.id) || null;
}

function updateRect(symbol, id, patch) {
  setRects(
    symbol,
    getRects(symbol).map((r) => (r.id === id ? { ...r, ...patch } : r))
  );
  return getRects(symbol).find((r) => r.id === id) || null;
}

function removeRect(symbol, id) {
  return setRects(
    symbol,
    getRects(symbol).filter((r) => r.id !== id)
  );
}

/* ------------------------------------------------------------ trend lines */

function sanitizeTrend(raw) {
  const a = sanitizeAnchor(raw && raw.a);
  const b = sanitizeAnchor(raw && raw.b);
  if (!a || !b) return null;
  // Both ends on the same point is a dot, not a line.
  if (a.price === b.price && a.time === b.time) return null;
  const id = raw && typeof raw.id === 'string' && raw.id ? raw.id : randomUUID();
  return withColor({ id, a, b }, raw);
}

function getTrendlines(symbol) {
  const key = levelKey(symbol);
  if (!key) return [];
  const all = store.get('trendlines') || {};
  const list = Array.isArray(all[key]) ? all[key] : [];
  return list.map(sanitizeTrend).filter(Boolean);
}

function setTrendlines(symbol, list) {
  const key = levelKey(symbol);
  if (!key) return [];
  const all = { ...(store.get('trendlines') || {}) };
  const clean = (Array.isArray(list) ? list : [])
    .map(sanitizeTrend)
    .filter(Boolean)
    .slice(0, MAX_LEVELS_PER_SYMBOL);
  if (clean.length) all[key] = clean;
  else delete all[key];
  store.set('trendlines', all);
  return clean;
}

function addTrendline(symbol, a, b, color) {
  const line = sanitizeTrend({ a, b, color });
  if (!line) return null;
  setTrendlines(symbol, [...getTrendlines(symbol), line]);
  return getTrendlines(symbol).find((l) => l.id === line.id) || null;
}

function updateTrendline(symbol, id, patch) {
  setTrendlines(
    symbol,
    getTrendlines(symbol).map((l) => (l.id === id ? { ...l, ...patch } : l))
  );
  return getTrendlines(symbol).find((l) => l.id === id) || null;
}

function removeTrendline(symbol, id) {
  return setTrendlines(
    symbol,
    getTrendlines(symbol).filter((l) => l.id !== id)
  );
}

/* ----------------------------------------------------------- price alerts */

function sanitizePriceAlert(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const symbol = String(raw.symbol || '').toUpperCase();
  const price = Number(raw.price);
  if (!/^[A-Z0-9]{2,30}$/.test(symbol) || !Number.isFinite(price) || price <= 0) return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : randomUUID(),
    symbol,
    market: pickMarket(raw.market),
    price,
    direction: raw.direction === 'down' ? 'down' : 'up',
    createdAt: Number(raw.createdAt) || Date.now(),
  };
}

function getPriceAlerts() {
  const raw = store.get('priceAlerts');
  return Array.isArray(raw) ? raw.map(sanitizePriceAlert).filter(Boolean) : [];
}

function addPriceAlert(partial) {
  const alert = sanitizePriceAlert({ ...partial, id: null, createdAt: Date.now() });
  if (!alert) return null;
  const list = getPriceAlerts();
  if (list.length >= MAX_PRICE_ALERTS) return null;
  store.set('priceAlerts', [...list, alert]);
  return alert;
}

function updatePriceAlert(id, patch) {
  let updated = null;
  const list = getPriceAlerts().map((a) => {
    if (a.id !== id) return a;
    updated = sanitizePriceAlert({ ...a, ...patch, id: a.id, symbol: a.symbol, market: a.market });
    return updated || a;
  });
  if (updated) store.set('priceAlerts', list);
  return updated;
}

function removePriceAlert(id) {
  const list = getPriceAlerts();
  const removed = list.find((a) => a.id === id) || null;
  if (removed) store.set('priceAlerts', list.filter((a) => a.id !== id));
  return removed;
}

/* ---------------------------------------------------------------- vranges */

function sanitizeVRange(raw) {
  const from = Math.round(Number(raw && raw.from));
  if (!Number.isFinite(from) || from <= 0) return null;
  let to = raw && raw.to;
  if (to !== null) {
    to = Math.round(Number(to));
    // Shorter than a minute is a click, not a range.
    if (!Number.isFinite(to) || to - from < 60) return null;
  }
  const id = raw && typeof raw.id === 'string' && raw.id ? raw.id : randomUUID();
  return { id, from, to };
}

function getVRanges(symbol) {
  const key = levelKey(symbol);
  if (!key) return [];
  const all = store.get('vranges') || {};
  const list = Array.isArray(all[key]) ? all[key] : [];
  return list.map(sanitizeVRange).filter(Boolean);
}

function setVRanges(symbol, list) {
  const key = levelKey(symbol);
  if (!key) return [];
  const all = { ...(store.get('vranges') || {}) };
  const clean = (Array.isArray(list) ? list : [])
    .map(sanitizeVRange)
    .filter(Boolean)
    .slice(0, MAX_LEVELS_PER_SYMBOL);
  if (clean.length) all[key] = clean;
  else delete all[key];
  store.set('vranges', all);
  return clean;
}

function addVRange(symbol, from, to) {
  const range = sanitizeVRange({ from, to });
  if (!range) return null;
  setVRanges(symbol, [...getVRanges(symbol), range]);
  return getVRanges(symbol).find((r) => r.id === range.id) || null;
}

function updateVRange(symbol, id, patch) {
  setVRanges(
    symbol,
    getVRanges(symbol).map((r) => (r.id === id ? { ...r, ...patch } : r))
  );
  return getVRanges(symbol).find((r) => r.id === id) || null;
}

function removeVRange(symbol, id) {
  return setVRanges(
    symbol,
    getVRanges(symbol).filter((r) => r.id !== id)
  );
}

module.exports = {
  INTERVALS,
  CHART_TYPES,
  MARKETS,
  pickMarket,
  CARD_MIN_WIDTH,
  CARD_MIN_HEIGHT,
  CARD_DEFAULT_WIDTH,
  CARD_DEFAULT_HEIGHT,
  store,
  get,
  set,
  getMode,
  setMode,
  getCards,
  setCards,
  getCard,
  addCard,
  updateCard,
  removeCard,
  reorderCards,
  getBoard,
  setBoard,
  getShortcuts,
  setShortcuts,
  getGlobalPrefs,
  getTimezone,
  getWatchlist,
  setWatchlist,
  getAlerts,
  getPriceAlerts,
  addPriceAlert,
  updatePriceAlert,
  removePriceAlert,
  setAlerts,
  ALERT_WINDOWS,
  ALERT_LEVELS,
  sanitizeWatchlist,
  normalizeBounds,
  defaultCardBounds,
  sanitizeCard,
  getLevels,
  setLevels,
  addLevel,
  updateLevel,
  removeLevel,
  getFibs,
  setFibs,
  addFib,
  updateFib,
  removeFib,
  getRects,
  getTrendlines,
  addTrendline,
  updateTrendline,
  removeTrendline,
  addRect,
  updateRect,
  removeRect,
  getVRanges,
  addVRange,
  updateVRange,
  removeVRange,
};
