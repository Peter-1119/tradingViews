'use strict';

/**
 * App entry point: lifecycle, single-instance lock, and the whole IPC surface.
 *
 * All privileged operations funnel through here. The preload exposes a fixed
 * allow-list of these channels; renderers never touch Electron APIs directly
 * (spec 3).
 */

const fs = require('fs');
const { app, ipcMain, BrowserWindow, shell, dialog } = require('electron');
const { randomUUID } = require('crypto');

const protocolSetup = require('./protocol');
const store = require('./store');
const windows = require('./windows');
const tray = require('./tray');
const shortcuts = require('./shortcuts');
const barStore = require('./bar-store');
const footprintStore = require('./footprint-store');
const alerts = require('./alerts');
const trading = require('./trading/service');
const paper = require('./trading/paper');
const { t } = require('./i18n');

// Toasts are attributed by AppUserModelID; the same id the installer uses,
// so dev and packaged builds show up as the same app in Windows settings.
app.setAppUserModelId('com.stockcard.desktop');

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
    windows.showAll('second launch');
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

function hubRequest(market, method, args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const reqId = randomUUID();
    const timer = setTimeout(() => {
      pendingHubRequests.delete(reqId);
      reject(new Error(`datafeed request timed out: ${method}`));
    }, timeoutMs);

    pendingHubRequests.set(reqId, { resolve, reject, timer });
    sendHub('hub:request', { reqId, market, method, args });
  });
}

ipcMain.on('hub:ready', () => {
  hubReady = true;
  flushHubQueue();
  sendWatch();
  sendPriceAlerts();
});

/* ----------------------------------------------------------- price alerts */

/*
 * The hub watches prices, because it holds the sockets and keeps running with
 * every card hidden (Ctrl+Alt+S) or closed. Main owns the list: it persists,
 * tells the hub what to watch, and delivers a hit -- then drops the alert,
 * since they are one-shot.
 */
function sendPriceAlerts() {
  sendHub('hub:price-alerts', store.getPriceAlerts());
}

function priceAlertsChanged() {
  const list = store.getPriceAlerts();
  windows.broadcast('priceAlerts:changed', list);
  sendHub('hub:price-alerts', list);
}

ipcMain.handle('priceAlerts:list', () => store.getPriceAlerts());
ipcMain.handle('priceAlerts:add', (_event, partial = {}) => {
  const alert = store.addPriceAlert(partial);
  if (alert) priceAlertsChanged();
  return alert;
});
ipcMain.handle('priceAlerts:update', (_event, { id, price, direction } = {}) => {
  const alert = store.updatePriceAlert(id, { price, direction });
  if (alert) priceAlertsChanged();
  return alert;
});
ipcMain.handle('priceAlerts:remove', (_event, id) => {
  const removed = store.removePriceAlert(id);
  if (removed) priceAlertsChanged();
  return !!removed;
});
ipcMain.on('hub:price-alert-hit', (_event, { id, price } = {}) => {
  // Removed first: a second report of the same hit finds nothing to deliver.
  const alert = store.removePriceAlert(id);
  if (!alert) return;
  priceAlertsChanged();
  alerts.firePrice(alert, price);
});

/** Tell the hub what to monitor for position alerts, and at which levels. */
function sendWatch() {
  const entries = store.getWatchlist();
  alerts.prune(entries);
  sendHub('hub:watch', { entries, levels: store.getAlerts().levels });
}

ipcMain.on('hub:alert', (_event, alert) => alerts.fire(alert));
ipcMain.on('hub:alert-state', (_event, state) => alerts.setState(state));
ipcMain.handle('alerts:states', () => alerts.getStates());
ipcMain.on('alerts:ack', (event) => windows.stopFlash(windows.windowFromEvent(event)));

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
  // Text is laid out once per window; a new language reloads them.
  const language = patch.language === 'zh-TW' ? 'zh-TW' : 'en';
  const relabel = 'language' in patch && language !== store.getGlobalPrefs().language;
  if (relabel) store.set('language', language);
  if ('cacheBars' in patch) store.set('cacheBars', patch.cacheBars !== false);
  if ('launchAtStartup' in patch) tray.setLaunchAtStartup(patch.launchAtStartup);
  if ('boardColumns' in patch) store.setBoard({ columns: patch.boardColumns });
  if ('watchlist' in patch) store.setWatchlist(patch.watchlist);
  if ('alerts' in patch) store.setAlerts(patch.alerts);
  if ('watchlist' in patch || 'alerts' in patch) sendWatch();
  const prefs = store.getGlobalPrefs();
  windows.broadcast('app:prefs', prefs);
  tray.refresh();
  if (relabel) setTimeout(() => windows.reloadContent(), 50);
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
  windows.hideAll('board hide button');
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
    if (patch && ('symbol' in patch || 'interval' in patch || 'market' in patch)) tray.refresh();
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

function broadcastTrendlines(symbol) {
  const trendlines = store.getTrendlines(symbol);
  windows.broadcast('trendlines:changed', { symbol: String(symbol).toUpperCase(), trendlines });
  return trendlines;
}

ipcMain.handle('trendlines:list', (_event, symbol) => store.getTrendlines(symbol));

ipcMain.handle('trendlines:add', (_event, { symbol, a, b } = {}) => {
  const line = store.addTrendline(symbol, a, b);
  if (line) broadcastTrendlines(symbol);
  return line;
});

ipcMain.handle('trendlines:update', (_event, { symbol, id, patch } = {}) => {
  const line = store.updateTrendline(symbol, id, patch || {});
  broadcastTrendlines(symbol);
  return line;
});

ipcMain.handle('trendlines:remove', (_event, { symbol, id } = {}) => {
  store.removeTrendline(symbol, id);
  return broadcastTrendlines(symbol);
});

function broadcastVRanges(symbol) {
  const vranges = store.getVRanges(symbol);
  windows.broadcast('vranges:changed', { symbol: String(symbol).toUpperCase(), vranges });
  return vranges;
}

ipcMain.handle('vranges:list', (_event, symbol) => store.getVRanges(symbol));

ipcMain.handle('vranges:add', (_event, { symbol, from, to } = {}) => {
  const range = store.addVRange(symbol, from, to);
  if (range) broadcastVRanges(symbol);
  return range;
});

ipcMain.handle('vranges:update', (_event, { symbol, id, patch } = {}) => {
  const range = store.updateVRange(symbol, id, patch || {});
  broadcastVRanges(symbol);
  return range;
});

ipcMain.handle('vranges:remove', (_event, { symbol, id } = {}) => {
  store.removeVRange(symbol, id);
  return broadcastVRanges(symbol);
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

ipcMain.handle('bars:read', (_event, { market, symbol, interval, from, to } = {}) =>
  store.get('cacheBars') === false ? [] : barStore.read(symbol, interval, from, to, market)
);

ipcMain.handle('bars:write', (_event, { market, symbol, interval, bars } = {}) =>
  store.get('cacheBars') === false ? 0 : barStore.write(symbol, interval, bars, market)
);

// For a series whose source revises its past: the span ends up holding
// exactly these records. See barStore.replace.
ipcMain.handle('bars:replace', (_event, { market, symbol, interval, from, to, bars } = {}) =>
  store.get('cacheBars') === false ? 0 : barStore.replace(symbol, interval, from, to, bars, market)
);

ipcMain.handle('bars:stats', () => barStore.stats());

ipcMain.handle('bars:clear', (_event, symbol) => barStore.clear(symbol));

/* ------------------------------------------------- IPC: footprint cache */

// Only the hub collects footprints, so only it reads and writes them.
ipcMain.handle('footprint:read', (_event, { market, symbol, from, to } = {}) =>
  footprintStore.read(symbol, from, to, store.pickMarket(market))
);

ipcMain.handle('footprint:write', (_event, { market, symbol, records } = {}) =>
  footprintStore.write(symbol, records, store.pickMarket(market))
);

/* ------------------------------------------------------- IPC: datafeed */

ipcMain.handle('datafeed:call', async (_event, { market, method, args } = {}) => {
  const ALLOWED = [
    'getHistory',
    'getRange',
    'searchSymbols',
    'getTicker',
    'getFunding',
    'getLongShortRatio',
    'getOpenInterestHist',
    'setFootprint',
    'getStatus',
    'counterpart',
  ];
  if (!ALLOWED.includes(method)) throw new Error(`unknown datafeed method: ${method}`);
  return hubRequest(store.pickMarket(market), method, args || []);
});

ipcMain.on('datafeed:subscribe', (event, { subId, market, symbol, interval } = {}) => {
  sendHub('hub:subscribe', {
    subId,
    market: store.pickMarket(market),
    symbol,
    interval,
    ownerId: event.sender.id,
  });
});

ipcMain.on('datafeed:unsubscribe', (event, { subId, market } = {}) => {
  sendHub('hub:unsubscribe', { subId, market: store.pickMarket(market), ownerId: event.sender.id });
});

/* -------------------------------------------------------- IPC: trading */

/*
 * Every trading call answers {ok, data} or {ok: false, error}. A thrown error
 * would reach the renderer as "Error invoking remote method 'trading:place':
 * Error: ..." -- the user should read why an order failed, not that.
 */
function tradingHandle(channel, fn) {
  ipcMain.handle(channel, async (event, payload = {}) => {
    try {
      return { ok: true, data: await fn(event, payload) };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
}

tradingHandle('trading:status', () => trading.status());
tradingHandle('trading:watch', (event, { symbol, owner }) => trading.watch(event.sender, symbol, owner));
tradingHandle('trading:unwatch', (event, { owner }) => trading.unwatch(event.sender, owner));
tradingHandle('trading:preview', (_e, req) => trading.preview(req));
tradingHandle('trading:place', (_e, req) => trading.placeOrder(req));
tradingHandle('trading:cancel', (_e, req) => trading.cancel(req));
tradingHandle('trading:close', (_e, req) => trading.closePosition(req));
tradingHandle('trading:reverse', (_e, req) => trading.reversePosition(req));
tradingHandle('trading:tpsl', (_e, req) => trading.setTpsl(req));
tradingHandle('trading:modify', (_e, req) => trading.modifyOrderPrice(req));
tradingHandle('trading:pending', (_e, req) => trading.updatePending(req));
tradingHandle('trading:set-env', (_e, { env, confirmLive }) => trading.setEnv(env, { confirmLive }));
tradingHandle('trading:set-keys', (_e, { env, apiKey, secret }) => trading.setCredentials(env, apiKey, secret));
/**
 * Self-generated key: the private key is chosen in a dialog and read here, in
 * the main process. The renderer sends only the API key, and never sees the
 * file's contents -- not even in transit.
 */
tradingHandle('trading:set-key-file', async (event, { env, apiKey }) => {
  const win = windows.windowFromEvent(event);
  const picked = await dialog.showOpenDialog(win, {
    title: t('選擇私鑰檔案（-----BEGIN PRIVATE KEY-----）'),
    properties: ['openFile'],
    filters: [
      { name: t('私鑰 (.pem / .key)'), extensions: ['pem', 'key', 'txt'] },
      { name: t('所有檔案'), extensions: ['*'] },
    ],
  });
  if (picked.canceled || !picked.filePaths.length) return { canceled: true };
  const file = picked.filePaths[0];
  // A PEM private key is a few KB at most; anything bigger is not one.
  if (fs.statSync(file).size > 16 * 1024) throw new Error(t('這個檔案太大，不是私鑰檔案'));
  return trading.setPrivateKey(env, apiKey, fs.readFileSync(file, 'utf8'));
});
tradingHandle('trading:clear-keys', (_e, { env }) => trading.clearCredentials(env));
tradingHandle('trading:leverage', (_e, { symbol }) => trading.getLeverage(symbol));
tradingHandle('trading:set-leverage', (_e, { symbol, leverage }) => trading.setSymbolLeverage(symbol, leverage));
tradingHandle('trading:one-way', () => trading.setOneWay());
tradingHandle('trading:default-notional', (_e, { value }) => trading.setDefaultNotional(value));
tradingHandle('paper:reset', (_e, { capital, makerFee, takerFee }) => trading.paperReset(capital, { makerFee, takerFee }));
tradingHandle('paper:fees', (_e, { makerFee, takerFee }) => trading.paperSetFees({ makerFee, takerFee }));
tradingHandle('paper:journal', () => paper.journal());
tradingHandle('paper:open-journal', () => {
  windows.openJournal();
  return true;
});
tradingHandle('paper:export-csv', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const stamp = new Date().toISOString().slice(0, 10);
  const res = await dialog.showSaveDialog(win, {
    title: t('匯出模擬交易紀錄'),
    defaultPath: t('模擬交易紀錄-{stamp}.csv', { stamp }),
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  fs.writeFileSync(res.filePath, paper.historyCsv(), 'utf8');
  return { path: res.filePath };
});
tradingHandle('trading:test', () => trading.test());

/* ------------------------------------------------------------ lifecycle */

app.on('browser-window-created', (_event, win) => {
  const wcId = win.webContents.id;

  if (windows.state.isDev || windows.state.traceWindows) {
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

  // The paper exchange runs whether or not it is the selected environment:
  // its stops and limit orders must keep working, as Binance's would.
  paper.init(app.getPath('userData'));
  let journalTimer = null;
  paper.onChange(() => {
    clearTimeout(journalTimer);
    journalTimer = setTimeout(() => windows.sendToJournal('paper:changed', {}), 400);
  });

  windows.bootstrap();
  tray.create();

  const result = shortcuts.register({
    onToggleShow: () => {
      windows.toggleShowAll('show/hide shortcut');
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
    else windows.showAll('app activate');
  });
});

// The tray keeps the app alive after the last card is closed.
app.on('window-all-closed', () => {
  // Intentionally empty: quitting is a tray/shortcut decision, not a window one.
});

app.on('before-quit', () => {
  trading.shutdown();
  paper.shutdown();
  windows.shutdown();
  shortcuts.unregisterAll();
  tray.destroy();
});
