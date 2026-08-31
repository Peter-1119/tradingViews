'use strict';

/**
 * Window / card lifecycle for both display modes (spec 4).
 *
 *   Float mode  -> one frameless transparent BrowserWindow per card.
 *   Board mode  -> one frameless transparent window hosting a CSS grid of cards.
 *
 * A third, permanently hidden "hub" window exists in both modes. It owns the
 * single Binance WebSocket connection shared by every card (spec 6 / 10);
 * card renderers reach it through IPC instead of opening their own sockets.
 */

const path = require('path');
const { BrowserWindow, screen } = require('electron');
const store = require('./store');
const { url } = require('./protocol');

const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');

const state = {
  hub: null,
  cards: new Map(), // cardId -> BrowserWindow
  board: null,
  allHidden: false,
  clickThrough: false,
  // Set by shutdown(). Teardown fires the same events as a user closing one
  // card, and those handlers must not start work the process will not survive.
  quitting: false,
  isDev: process.argv.includes('--dev'),
  openDevTools: process.argv.includes('--devtools'),
};

const boundsTimers = new Map();

/**
 * How often to shove the pinned cards back to the front of the topmost band.
 * Long enough to be invisible in a profiler, short enough that a card buried by
 * a full-screen app is back within a few seconds rather than lost for good.
 */
const ON_TOP_REASSERT_MS = 3000;
let onTopTimer = null;

/* ------------------------------------------------------------- helpers */

function baseWebPreferences() {
  return {
    preload: PRELOAD,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    backgroundThrottling: false,
    spellcheck: false,
  };
}

function debouncePersist(key, fn, delay = 500) {
  clearTimeout(boundsTimers.get(key));
  boundsTimers.set(key, setTimeout(fn, delay));
}

function flushPersistTimers() {
  for (const [, timer] of boundsTimers) clearTimeout(timer);
  boundsTimers.clear();
}

/**
 * A window is only safe to send to while *both* halves are alive.
 *
 * `win.isDestroyed()` is not enough: on quit Electron tears the webContents
 * down first and the BrowserWindow only emits `closed` afterwards, so there is
 * a window where the wrapper still looks healthy and `webContents.send()`
 * throws "Object has been destroyed". Card teardown emits IPC in exactly that
 * gap, which is what crashed the main process on exit.
 */
function canSend(win) {
  return !!win && !win.isDestroyed() && !!win.webContents && !win.webContents.isDestroyed();
}

/** Every window that hosts card UI (i.e. everything except the hidden hub). */
function contentWindows() {
  const list = [...state.cards.values()];
  if (state.board) list.push(state.board);
  return list.filter((w) => w && !w.isDestroyed());
}

function broadcast(channel, payload) {
  for (const win of contentWindows()) {
    if (canSend(win)) win.webContents.send(channel, payload);
  }
}

function sendToHub(channel, payload) {
  if (canSend(state.hub)) state.hub.webContents.send(channel, payload);
}

function sendToWebContents(id, channel, payload) {
  for (const win of [...contentWindows(), state.hub]) {
    if (canSend(win) && win.webContents.id === id) {
      win.webContents.send(channel, payload);
      return true;
    }
  }
  return false;
}

function windowForCard(cardId) {
  const win = state.cards.get(cardId);
  return win && !win.isDestroyed() ? win : null;
}

/** Resolve the window a renderer IPC message came from. */
function windowFromEvent(event) {
  return BrowserWindow.fromWebContents(event.sender) || null;
}

/* ----------------------------------------------------------------- hub */

function createHub() {
  if (state.hub && !state.hub.isDestroyed()) return state.hub;

  const hub = new BrowserWindow({
    width: 480,
    height: 320,
    show: false,
    frame: false,
    skipTaskbar: true,
    webPreferences: baseWebPreferences(),
  });

  hub.loadURL(url('hub.html'));
  hub.on('closed', () => {
    state.hub = null;
  });

  state.hub = hub;
  return hub;
}

/* --------------------------------------------------------- card windows */

function createCardWindow(card) {
  const existing = windowForCard(card.id);
  if (existing) return existing;

  const bounds = store.normalizeBounds(card.bounds);

  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: card.alwaysOnTop !== false,
    resizable: true,
    // Transparent windows cannot be maximized on Windows (spec 4.2 caveat).
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    minWidth: store.CARD_MIN_WIDTH,
    minHeight: store.CARD_MIN_HEIGHT,
    show: false,
    hasShadow: false,
    webPreferences: baseWebPreferences(),
  });

  win.setMenu(null);
  if (card.alwaysOnTop !== false) win.setAlwaysOnTop(true, 'floating');
  if (card.windowOpacity < 1) win.setOpacity(card.windowOpacity);

  win.loadURL(url('card.html', { cardId: card.id }));

  win.once('ready-to-show', () => {
    if (!state.allHidden) win.showInactive();
    if (state.clickThrough) applyClickThroughTo(win, true);
    if (state.openDevTools) win.webContents.openDevTools({ mode: 'detach' });
  });

  const persistBounds = () => {
    if (win.isDestroyed()) return;
    debouncePersist('card:' + card.id, () => {
      if (win.isDestroyed()) return;
      store.updateCard(card.id, { bounds: win.getBounds() });
    });
  };
  win.on('move', persistBounds);
  win.on('resize', persistBounds);

  win.on('closed', () => {
    state.cards.delete(card.id);
  });

  state.cards.set(card.id, win);
  return win;
}

function destroyCardWindow(cardId) {
  const win = state.cards.get(cardId);
  state.cards.delete(cardId);
  if (win && !win.isDestroyed()) {
    // Persist the final position before the window goes away.
    clearTimeout(boundsTimers.get('card:' + cardId));
    if (store.getCard(cardId)) store.updateCard(cardId, { bounds: win.getBounds() });
    win.destroy();
  }
}

/* -------------------------------------------------------- board window */

function createBoardWindow() {
  if (state.board && !state.board.isDestroyed()) return state.board;

  const board = store.getBoard();
  const area = screen.getPrimaryDisplay().workArea;
  const fallback = {
    width: 720,
    height: 520,
    x: Math.round(area.x + area.width - 760),
    y: Math.round(area.y + 60),
  };
  const bounds = store.normalizeBounds(board.bounds || fallback, {
    minWidth: 320,
    minHeight: 220,
  });

  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: board.alwaysOnTop,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    minWidth: 320,
    minHeight: 220,
    show: false,
    hasShadow: false,
    webPreferences: baseWebPreferences(),
  });

  win.setMenu(null);
  win.setAlwaysOnTop(board.alwaysOnTop, board.alwaysOnTop ? 'floating' : 'normal');
  win.loadURL(url('board.html'));

  win.once('ready-to-show', () => {
    if (!state.allHidden) win.showInactive();
    if (state.clickThrough) applyClickThroughTo(win, true);
    if (state.openDevTools) win.webContents.openDevTools({ mode: 'detach' });
  });

  const persistBounds = () => {
    if (win.isDestroyed()) return;
    debouncePersist('board', () => {
      if (win.isDestroyed()) return;
      store.setBoard({ bounds: win.getBounds() });
    });
  };
  win.on('move', persistBounds);
  win.on('resize', persistBounds);

  win.on('closed', () => {
    state.board = null;
  });

  state.board = win;
  return win;
}

function destroyBoardWindow() {
  const win = state.board;
  state.board = null;
  if (win && !win.isDestroyed()) {
    clearTimeout(boundsTimers.get('board'));
    store.setBoard({ bounds: win.getBounds() });
    win.destroy();
  }
}

/* ---------------------------------------------------------------- modes */

/**
 * Tear down the current mode's windows and build the other one's.
 * Card configuration lives in the store, so nothing is lost either way
 * (acceptance: Float <-> Board round trip must not lose card settings).
 */
function applyMode(mode) {
  const next = mode === 'board' ? 'board' : 'float';
  store.setMode(next);

  if (next === 'board') {
    for (const id of [...state.cards.keys()]) destroyCardWindow(id);
    createBoardWindow();
  } else {
    destroyBoardWindow();
    const cards = store.getCards();
    if (cards.length === 0) {
      addCard();
    } else {
      for (const card of cards) createCardWindow(card);
    }
  }
  broadcast('app:mode', { mode: next });
  return next;
}

function getMode() {
  return store.getMode();
}

function toggleMode() {
  return applyMode(getMode() === 'float' ? 'board' : 'float');
}

/* ------------------------------------------------------- card commands */

function addCard(partial = {}) {
  const card = store.addCard(partial);
  if (getMode() === 'float') {
    createCardWindow(card);
  } else {
    const board = createBoardWindow();
    board.webContents.send('cards:changed', store.getCards());
  }
  return card;
}

function removeCard(cardId) {
  destroyCardWindow(cardId);
  store.removeCard(cardId);
  sendToHub('hub:release-owner', { cardId });
  if (state.board && !state.board.isDestroyed()) {
    state.board.webContents.send('cards:changed', store.getCards());
  }
  return store.getCards();
}

/** Applies a settings patch and forwards any window-level side effects. */
function updateCard(cardId, patch) {
  const card = store.updateCard(cardId, patch);
  if (!card) return null;

  const win = windowForCard(cardId);
  if (win) {
    if ('alwaysOnTop' in patch) {
      win.setAlwaysOnTop(card.alwaysOnTop, card.alwaysOnTop ? 'floating' : 'normal');
    }
    if ('windowOpacity' in patch) {
      win.setOpacity(card.windowOpacity);
    }
  }
  return card;
}

/* ------------------------------------------------- visibility / on-top */

function showAll() {
  state.allHidden = false;
  for (const win of contentWindows()) win.showInactive();
  // Ctrl+Alt+S doubles as the manual repair for a buried card, so do not wait
  // for the watchdog's next pass to put it back on top.
  reassertAlwaysOnTop();
  broadcast('app:visibility', { hidden: false });
}

/**
 * Push every pinned card back to the front of the topmost band.
 *
 * Windows has exactly one topmost band -- there is no z-order above
 * HWND_TOPMOST the way macOS has window levels -- so any other app that goes
 * topmost or full-screen lands *above* our cards and simply stays there. Photo
 * viewers and video players do this routinely, which is why it shows up while
 * looking at images. Nothing in Electron notices: the flag was never cleared,
 * `isAlwaysOnTop()` still answers true, the card is just buried. And because
 * cards are `skipTaskbar`, there is no taskbar button to dig one back out with,
 * so "covered" reads as "gone". Re-asserting the position is the only repair.
 */
function reassertAlwaysOnTop() {
  if (state.quitting || state.allHidden) return;
  for (const win of contentWindows()) {
    if (!win.isAlwaysOnTop() || !win.isVisible()) continue;
    // setAlwaysOnTop repairs the flag in the rarer case Windows really did drop
    // it; moveTop repairs the ordering *within* the band, which is the common
    // one. Neither subsumes the other.
    win.setAlwaysOnTop(true, 'floating');
    win.moveTop();
  }
}

function startAlwaysOnTopWatch() {
  if (onTopTimer) return;
  onTopTimer = setInterval(reassertAlwaysOnTop, ON_TOP_REASSERT_MS);
}

function stopAlwaysOnTopWatch() {
  clearInterval(onTopTimer);
  onTopTimer = null;
}

function hideAll() {
  state.allHidden = true;
  for (const win of contentWindows()) win.hide();
  broadcast('app:visibility', { hidden: true });
}

function toggleShowAll() {
  if (state.allHidden) showAll();
  else hideAll();
  return !state.allHidden;
}

function isHidden() {
  return state.allHidden;
}

function setAlwaysOnTopAll(flag) {
  for (const win of contentWindows()) {
    win.setAlwaysOnTop(flag, flag ? 'floating' : 'normal');
  }
  if (getMode() === 'float') {
    for (const card of store.getCards()) store.updateCard(card.id, { alwaysOnTop: flag });
  } else {
    store.setBoard({ alwaysOnTop: flag });
  }
  broadcast('app:always-on-top', { alwaysOnTop: flag });
}

/* --------------------------------------------------------- click-through */

function applyClickThroughTo(win, enabled) {
  if (!win || win.isDestroyed()) return;
  // `forward: true` keeps mouse move events flowing to the renderer so the
  // "unlock" affordance can re-enable hit testing on hover (spec 4.2).
  win.setIgnoreMouseEvents(enabled, { forward: true });
}

function setClickThrough(enabled) {
  state.clickThrough = !!enabled;
  store.set('clickThrough', state.clickThrough);
  for (const win of contentWindows()) applyClickThroughTo(win, state.clickThrough);
  broadcast('app:click-through', { clickThrough: state.clickThrough });
  return state.clickThrough;
}

function toggleClickThrough() {
  return setClickThrough(!state.clickThrough);
}

function isClickThrough() {
  return state.clickThrough;
}

/**
 * Temporary hit-test override requested by a renderer: while the pointer is
 * over an interactive affordance we must stop ignoring mouse events, otherwise
 * the user can never click their way out of click-through mode.
 */
function setIgnoreMouseEventsFor(win, ignore) {
  if (!state.clickThrough || !win || win.isDestroyed()) return;
  applyClickThroughTo(win, ignore);
}

/* ------------------------------------------------------------ bootstrap */

function bootstrap() {
  createHub();
  state.clickThrough = store.get('clickThrough') === true;

  if (getMode() === 'board') {
    createBoardWindow();
  } else {
    const cards = store.getCards();
    if (cards.length === 0) {
      addCard({ symbol: 'BTCUSDT', interval: '1m', chartType: 'candlestick' });
    } else {
      for (const card of cards) createCardWindow(card);
    }
  }

  startAlwaysOnTopWatch();
}

function shutdown() {
  state.quitting = true;
  stopAlwaysOnTopWatch();
  flushPersistTimers();
  // Persist final geometry so the next launch restores exactly what was on screen.
  for (const [id, win] of state.cards) {
    if (win && !win.isDestroyed() && store.getCard(id)) {
      store.updateCard(id, { bounds: win.getBounds() });
    }
  }
  if (state.board && !state.board.isDestroyed()) {
    store.setBoard({ bounds: state.board.getBounds() });
  }
}

module.exports = {
  state,
  bootstrap,
  shutdown,
  createHub,
  createCardWindow,
  createBoardWindow,
  destroyCardWindow,
  destroyBoardWindow,
  applyMode,
  getMode,
  toggleMode,
  addCard,
  removeCard,
  updateCard,
  showAll,
  hideAll,
  toggleShowAll,
  isHidden,
  setAlwaysOnTopAll,
  reassertAlwaysOnTop,
  setClickThrough,
  toggleClickThrough,
  isClickThrough,
  setIgnoreMouseEventsFor,
  broadcast,
  sendToHub,
  sendToWebContents,
  windowForCard,
  windowFromEvent,
  contentWindows,
};
