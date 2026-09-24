'use strict';

/**
 * App entry point: lifecycle, single-instance lock, and the whole IPC surface.
 *
 * All privileged operations funnel through here. The preload exposes a fixed
 * allow-list of these channels; renderers never touch Electron APIs directly
 * (spec 3).
 */

const { app, ipcMain, BrowserWindow, shell } = require('electron');
const { randomUUID } = require('crypto');

const protocolSetup = require('./protocol');
const store = require('./store');
const windows = require('./windows');
const tray = require('./tray');
const shortcuts = require('./shortcuts');
const barStore = require('./bar-store');

// Must happen before `ready`.
protocolSetup.registerScheme();

// Helps transparent frameless windows composite correctly on some setups.
app.commandLine.appendSwitch('enable-transparent-visuals');

/* ------------------------------------------------- single instance lock */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    windows.showAll();
    tray.refresh();
  });
}

/* --------------------------------------------- hub request/response bus */

/**
 * The hub is a renderer, so main cannot `invoke` into it. This is a small
 * correlation-id bus over one-way IPC in both directions.
 */
const pendingHubRequests = new Map();
let hubReady = false;
const hubQueue = [];

function flushHubQueue() {
  while (hubQueue.length) {
    const { channel, payload } = hubQueue.shift();
    windows.sendToHub(channel, payload);
  }
}

function sendHub(channel, payload) {
  if (hubReady) windows.sendToHub(channel, payload);
  else hubQueue.push({ channel, payload });
}

function hubRequest(method, args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const reqId = randomUUID();
    const timer = setTimeout(() => {
      pendingHubRequests.delete(reqId);
      reject(new Error(`datafeed request timed out: ${method}`));
    }, timeoutMs);

    pendingHubRequests.set(reqId, { resolve, reject, timer });
    sendHub('hub:request', { reqId, method, args });
  });
}

ipcMain.on('hub:ready', () => {
  hubReady = true;
  flushHubQueue();
});

ipcMain.on('hub:response', (_event, { reqId, ok, data, error }) => {
  const pending = pendingHubRequests.get(reqId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingHubRequests.delete(reqId);
  if (ok) pending.resolve(data);
  else pending.reject(new Error(error || 'datafeed error'));
});

/** Hub -> card routing. `ownerId === null` means broadcast (e.g. link status). */
ipcMain.on('hub:emit', (_event, { ownerId, channel, payload }) => {
  if (ownerId == null) windows.broadcast(channel, payload);
  else windows.sendToWebContents(ownerId, channel, payload);
});

/* ----------------------------------------------------------- IPC: app */

ipcMain.handle('app:bootstrap', (event, { cardId } = {}) => {
  const win = windows.windowFromEvent(event);
  return {
    cardId: cardId || null,
    card: cardId ? store.getCard(cardId) : null,
    cards: store.getCards(),
    prefs: store.getGlobalPrefs(),
    mode: windows.getMode(),
    hidden: windows.isHidden(),
    clickThrough: windows.isClickThrough(),
    bounds: win && !win.isDestroyed() ? win.getBounds() : null,
    limits: {
      minWidth: store.CARD_MIN_WIDTH,
      minHeight: store.CARD_MIN_HEIGHT,
    },
    intervals: store.INTERVALS,
    chartTypes: store.CHART_TYPES,
    isDev: windows.state.isDev,
  };
});

ipcMain.handle('prefs:get', () => store.getGlobalPrefs());

ipcMain.handle('prefs:set', (_event, patch = {}) => {
  if ('upDownColor' in patch) store.set('upDownColor', patch.upDownColor);
  if ('timezone' in patch) store.set('timezone', patch.timezone);
  if ('cacheBars' in patch) store.set('cacheBars', patch.cacheBars !== false);
  if ('launchAtStartup' in patch) tray.setLaunchAtStartup(patch.launchAtStartup);
  if ('boardColumns' in patch) store.setBoard({ columns: patch.boardColumns });
  const prefs = store.getGlobalPrefs();
  windows.broadcast('app:prefs', prefs);
  tray.refresh();
  return prefs;
});

ipcMain.handle('shortcuts:update', (_event, patch = {}) => {
  const result = shortcuts.update(patch);
  windows.broadcast('app:prefs', store.getGlobalPrefs());
  tray.refresh();
  return { result, shortcuts: store.getShortcuts() };
});

ipcMain.handle('mode:set', (_event, mode) => {
  const next = windows.applyMode(mode);
  tray.refresh();
  return next;
});

ipcMain.handle('app:toggle-click-through', () => {
  const value = windows.toggleClickThrough();
  tray.refresh();
  return value;
});

ipcMain.handle('app:set-click-through', (_event, value) => {
  const next = windows.setClickThrough(value);
  tray.refresh();
  return next;
});

ipcMain.handle('app:hide-all', () => {
  windows.hideAll();
  tray.refresh();
  return true;
});

ipcMain.handle('app:quit', () => {
  app.quit();
});

ipcMain.handle('app:open-external', (_event, url) => {
  if (typeof url === 'string' && /^https:\/\//i.test(url)) shell.openExternal(url);
});

/* ---------------------------------------------------------- IPC: cards */

ipcMain.handle('cards:list', () => store.getCards());

ipcMain.handle('card:add', (_event, partial = {}) => {
  const card = windows.addCard(partial);
  tray.refresh();
  return card;
});

ipcMain.handle('card:update', (_event, { cardId, patch } = {}) => {
  const card = windows.updateCard(cardId, patch || {});
  if (card) {
    // Keep any other view of the same card (e.g. board grid) in sync.
    windows.broadcast('card:changed', card);
    if (patch && ('symbol' in patch || 'interval' in patch)) tray.refresh();
  }
  return card;
});

ipcMain.handle('card:remove', (_event, cardId) => {
  const cards = windows.removeCard(cardId);
  tray.refresh();
  return cards;
});

ipcMain.handle('cards:reorder', (_event, ids = []) => {
  const cards = store.reorderCards(ids);
  tray.refresh();
  return cards;
});

/* ------------------------------------------------------ price levels */

/**
 * Levels belong to a symbol, not to the card that drew them, so every write
 * has to reach every other card showing that symbol -- including the Board
 * window. Broadcasting the whole list rather than a delta keeps the renderers
 * stateless about ordering and de-duplication.
 */
function broadcastLevels(symbol) {
  const levels = store.getLevels(symbol);
  windows.broadcast('levels:changed', { symbol: String(symbol).toUpperCase(), levels });
  return levels;
}

ipcMain.handle('levels:list', (_event, symbol) => store.getLevels(symbol));

ipcMain.handle('levels:add', (_event, { symbol, price } = {}) => {
  const level = store.addLevel(symbol, price);
  if (!level) return null;
  broadcastLevels(symbol);
  return level;
});

ipcMain.handle('levels:update', (_event, { symbol, id, price } = {}) => {
  const level = store.updateLevel(symbol, id, price);
  broadcastLevels(symbol);
  return level;
});

ipcMain.handle('levels:remove', (_event, { symbol, id } = {}) => {
  store.removeLevel(symbol, id);
  return broadcastLevels(symbol);
});

function broadcastFibs(symbol) {
  const fibs = store.getFibs(symbol);
  windows.broadcast('fibs:changed', { symbol: String(symbol).toUpperCase(), fibs });
  return fibs;
}

ipcMain.handle('fibs:list', (_event, symbol) => store.getFibs(symbol));

ipcMain.handle('fibs:add', (_event, { symbol, a, b } = {}) => {
  const fib = store.addFib(symbol, a, b);
  if (!fib) return null;
  broadcastFibs(symbol);
  return fib;
});

ipcMain.handle('fibs:update', (_event, { symbol, id, patch } = {}) => {
  const fib = store.updateFib(symbol, id, patch || {});
  broadcastFibs(symbol);
  return fib;
});

ipcMain.handle('fibs:remove', (_event, { symbol, id } = {}) => {
  store.removeFib(symbol, id);
  return broadcastFibs(symbol);
});

function broadcastRects(symbol) {
  const rects = store.getRects(symbol);
  windows.broadcast('rects:changed', { symbol: String(symbol).toUpperCase(), rects });
  return rects;
}

ipcMain.handle('rects:list', (_event, symbol) => store.getRects(symbol));

ipcMain.handle('rects:add', (_event, { symbol, a, b } = {}) => {
  const rect = store.addRect(symbol, a, b);
  if (rect) broadcastRects(symbol);
  return rect;
});

ipcMain.handle('rects:update', (_event, { symbol, id, patch } = {}) => {
  const rect = store.updateRect(symbol, id, patch || {});
  broadcastRects(symbol);
  return rect;
});

ipcMain.handle('rects:remove', (_event, { symbol, id } = {}) => {
  store.removeRect(symbol, id);
  return broadcastRects(symbol);
});

/* -------------------------------------------------------- IPC: windows */

function senderWindow(event) {
  return windows.windowFromEvent(event);
}

ipcMain.handle('window:get-bounds', (event) => {
  const win = senderWindow(event);
  return win && !win.isDestroyed() ? win.getBounds() : null;
});

ipcMain.handle('window:set-size', (event, { width, height } = {}) => {
  const win = senderWindow(event);
  if (!win || win.isDestroyed()) return null;
  const [minW, minH] = win.getMinimumSize();
  const next = {
    width: Math.max(minW, Math.round(width)),
    height: Math.max(minH, Math.round(height)),
  };
  win.setSize(next.width, next.height);
  return win.getBounds();
});

ipcMain.handle('window:set-bounds', (event, bounds = {}) => {
  const win = senderWindow(event);
  if (!win || win.isDestroyed()) return null;
  win.setBounds(store.normalizeBounds({ ...win.getBounds(), ...bounds }));
  return win.getBounds();
});

ipcMain.handle('window:set-always-on-top', (event, flag) => {
  const win = senderWindow(event);
  if (!win || win.isDestroyed()) return null;
  win.setAlwaysOnTop(!!flag, flag ? 'floating' : 'normal');
  return !!flag;
});

ipcMain.handle('window:set-opacity', (event, value) => {
  const win = senderWindow(event);
  if (!win || win.isDestroyed()) return null;
  const clamped = Math.min(1, Math.max(0.2, Number(value) || 1));
  win.setOpacity(clamped);
  return clamped;
});

ipcMain.handle('window:close', (event, { cardId } = {}) => {
  const win = senderWindow(event);
  if (cardId) {
    windows.removeCard(cardId);
    tray.refresh();
    return true;
  }
  if (win && !win.isDestroyed()) win.hide();
  tray.refresh();
  return true;
});

/**
 * Hover-driven hit-test override while click-through is active, so the unlock
 * affordance stays clickable (spec 4.2). One-way: high frequency, no reply needed.
 */
ipcMain.on('window:set-ignore-mouse', (event, { ignore } = {}) => {
  windows.setIgnoreMouseEventsFor(senderWindow(event), ignore !== false);
});

/* ---------------------------------------------------- IPC: bar cache */

ipcMain.handle('bars:read', (_event, { symbol, interval, from, to } = {}) =>
  store.get('cacheBars') === false ? [] : barStore.read(symbol, interval, from, to)
);

ipcMain.handle('bars:write', (_event, { symbol, interval, bars } = {}) =>
  store.get('cacheBars') === false ? 0 : barStore.write(symbol, interval, bars)
);

ipcMain.handle('bars:stats', () => barStore.stats());

ipcMain.handle('bars:clear', (_event, symbol) => barStore.clear(symbol));

/* ------------------------------------------------------- IPC: datafeed */

ipcMain.handle('datafeed:call', async (_event, { method, args } = {}) => {
  const ALLOWED = ['getHistory', 'getRange', 'searchSymbols', 'getTicker', 'getStatus'];
  if (!ALLOWED.includes(method)) throw new Error(`unknown datafeed method: ${method}`);
  return hubRequest(method, args || []);
});

ipcMain.on('datafeed:subscribe', (event, { subId, symbol, interval } = {}) => {
  sendHub('hub:subscribe', { subId, symbol, interval, ownerId: event.sender.id });
});

ipcMain.on('datafeed:unsubscribe', (event, { subId } = {}) => {
  sendHub('hub:unsubscribe', { subId, ownerId: event.sender.id });
});

/* ------------------------------------------------------------ lifecycle */

app.on('browser-window-created', (_event, win) => {
  const wcId = win.webContents.id;

  if (windows.state.isDev) {
    // Surface renderer logs in the terminal; without this a failed module
    // import in a frameless transparent window is completely silent.
    win.webContents.on('console-message', (...args) => {
      const details = args[1] && typeof args[1] === 'object' ? args[1] : null;
      const message = details ? details.message : args[2];
      const source = details ? details.sourceId : args[4];
      const line = details ? details.lineNumber : args[3];
      console.log(`[renderer:${wcId}] ${message}  (${source}:${line})`);
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error(`[renderer:${wcId}] load failed ${code} ${desc} ${url}`);
    });
    win.webContents.on('preload-error', (_e, preloadPath, error) => {
      console.error(`[renderer:${wcId}] preload error ${preloadPath}`, error);
    });
  }

  // Release the hub's subscriptions for a renderer that has gone away, so a
  // closed card stops costing us a Binance stream. On quit there is nothing to
  // reclaim -- the hub is being torn down in the same breath -- and asking it
  // to would only race its teardown.
  win.webContents.once('destroyed', () => {
    if (windows.state.quitting) return;
    sendHub('hub:release-owner', { ownerId: wcId });
  });

  // Cards are chrome-less widgets: block any navigation or popup.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
});

app.whenReady().then(() => {
  /*
   * A second instance has already handed off to the first via `second-instance`
   * and is on its way out. `app.quit()` does not stop this handler from
   * running, so without this guard the doomed process still registers the
   * global shortcuts, opens the Chromium cache and builds a tray -- all of
   * which the live instance already owns. The user sees a wall of
   * "failed to bind: taken" and "Unable to move the cache (0x5)" and no chart,
   * which reads like a GPU fault and is really just two instances colliding.
   */
  if (!gotLock) return;

  protocolSetup.registerHandler();

  windows.bootstrap();
  tray.create();

  const result = shortcuts.register({
    onToggleShow: () => {
      windows.toggleShowAll();
      tray.refresh();
    },
    onToggleClickThrough: () => {
      windows.toggleClickThrough();
      tray.refresh();
    },
  });

  for (const [name, r] of Object.entries(result)) {
    if (!r.ok) console.warn(`[shortcuts] failed to bind ${name}: ${r.reason}`);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) windows.bootstrap();
    else windows.showAll();
  });
});

// The tray keeps the app alive after the last card is closed.
app.on('window-all-closed', () => {
  // Intentionally empty: quitting is a tray/shortcut decision, not a window one.
});

app.on('before-quit', () => {
  windows.shutdown();
  shortcuts.unregisterAll();
  tray.destroy();
});
