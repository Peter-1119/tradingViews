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
  /**
   * Keep downloaded bars on disk. On by default: it has no downside beyond
   * space, and the whole point is that the second look at a range is instant.
   * The escape hatch that matters is clearing it, not switching it off.
   */
  cacheBars: true,
  launchAtStartup: false,
  clickThrough: false,
  /**
   * Horizontal support/resistance levels, keyed by symbol -- deliberately not
   * by card and not by interval. A price level has no time anchor, so the same
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
};

/** Enough for any real chart; a guard against a stuck drag writing thousands. */
const MAX_LEVELS_PER_SYMBOL = 60;

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
    interval: pick(card.interval, INTERVALS, '1m'),
    chartType: pick(card.chartType, CHART_TYPES, 'candlestick'),
    cardOpacity: clampNumber(card.cardOpacity, 0.1, 1, 0.75),
    windowOpacity: clampNumber(card.windowOpacity, 0.2, 1, 1),
    showVolume: card.showVolume === true,
    // Was a boolean; `true` meant today's UTC-session profile, which is what
    // 'day' is now. Old configs keep showing what they showed.
    volumeProfile: pick(
      card.volumeProfile,
      VP_MODES,
      card.showVolumeProfile === true ? 'day' : 'off'
    ),
    showHtf: card.showHtf === true,
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
    cacheBars: store.get('cacheBars') !== false,
    mode: getMode(),
    clickThrough: store.get('clickThrough') === true,
    launchAtStartup: store.get('launchAtStartup') === true,
    shortcuts: getShortcuts(),
    boardColumns: getBoard().columns,
  };
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

function sanitizeLevel(raw) {
  const price = Number(raw && raw.price);
  // A level at or below zero is not a price, it is a corrupt record.
  if (!Number.isFinite(price) || price <= 0) return null;
  const id = raw && typeof raw.id === 'string' && raw.id ? raw.id : randomUUID();
  return { id, price };
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

function addLevel(symbol, price) {
  const level = sanitizeLevel({ price });
  if (!level) return null;
  setLevels(symbol, [...getLevels(symbol), level]);
  return level;
}

function updateLevel(symbol, id, price) {
  const next = getLevels(symbol).map((l) => (l.id === id ? { ...l, price } : l));
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

module.exports = {
  INTERVALS,
  CHART_TYPES,
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
};
