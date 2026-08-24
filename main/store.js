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
  launchAtStartup: false,
  clickThrough: false,
};

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
    mode: getMode(),
    clickThrough: store.get('clickThrough') === true,
    launchAtStartup: store.get('launchAtStartup') === true,
    shortcuts: getShortcuts(),
    boardColumns: getBoard().columns,
  };
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
  normalizeBounds,
  defaultCardBounds,
  sanitizeCard,
};
