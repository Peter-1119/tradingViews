'use strict';

/**
 * The only bridge between renderers and Electron (spec 3).
 *
 * Everything is an explicit named method over a fixed channel list; no generic
 * `invoke(channel, ...)` escape hatch is exposed, so a compromised renderer
 * cannot reach arbitrary main-process IPC.
 */

const { contextBridge, ipcRenderer } = require('electron');

/** Wraps `ipcRenderer.on` so callers get an unsubscribe function. */
function on(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  /* ------------------------------------------------------------- app */
  bootstrap: (opts) => ipcRenderer.invoke('app:bootstrap', opts),
  getPrefs: () => ipcRenderer.invoke('prefs:get'),
  setPrefs: (patch) => ipcRenderer.invoke('prefs:set', patch),
  updateShortcuts: (patch) => ipcRenderer.invoke('shortcuts:update', patch),
  setMode: (mode) => ipcRenderer.invoke('mode:set', mode),
  toggleClickThrough: () => ipcRenderer.invoke('app:toggle-click-through'),
  setClickThrough: (value) => ipcRenderer.invoke('app:set-click-through', value),
  hideAll: () => ipcRenderer.invoke('app:hide-all'),
  quit: () => ipcRenderer.invoke('app:quit'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),

  /* ----------------------------------------------------------- cards */
  listCards: () => ipcRenderer.invoke('cards:list'),
  addCard: (partial) => ipcRenderer.invoke('card:add', partial),
  updateCard: (cardId, patch) => ipcRenderer.invoke('card:update', { cardId, patch }),
  removeCard: (cardId) => ipcRenderer.invoke('card:remove', cardId),
  reorderCards: (ids) => ipcRenderer.invoke('cards:reorder', ids),

  /* ---------------------------------------------------- price levels */
  listLevels: (symbol) => ipcRenderer.invoke('levels:list', symbol),
  addLevel: (symbol, price) => ipcRenderer.invoke('levels:add', { symbol, price }),
  updateLevel: (symbol, id, price) => ipcRenderer.invoke('levels:update', { symbol, id, price }),
  removeLevel: (symbol, id) => ipcRenderer.invoke('levels:remove', { symbol, id }),
  onLevelsChanged: (cb) => on('levels:changed', cb),

  listFibs: (symbol) => ipcRenderer.invoke('fibs:list', symbol),
  addFib: (symbol, a, b) => ipcRenderer.invoke('fibs:add', { symbol, a, b }),
  updateFib: (symbol, id, patch) => ipcRenderer.invoke('fibs:update', { symbol, id, patch }),
  removeFib: (symbol, id) => ipcRenderer.invoke('fibs:remove', { symbol, id }),
  onFibsChanged: (cb) => on('fibs:changed', cb),

  listRects: (symbol) => ipcRenderer.invoke('rects:list', symbol),
  addRect: (symbol, a, b) => ipcRenderer.invoke('rects:add', { symbol, a, b }),
  updateRect: (symbol, id, patch) => ipcRenderer.invoke('rects:update', { symbol, id, patch }),
  removeRect: (symbol, id) => ipcRenderer.invoke('rects:remove', { symbol, id }),
  onRectsChanged: (cb) => on('rects:changed', cb),

  /* --------------------------------------------------------- window */
  getBounds: () => ipcRenderer.invoke('window:get-bounds'),
  setSize: (width, height) => ipcRenderer.invoke('window:set-size', { width, height }),
  setBounds: (bounds) => ipcRenderer.invoke('window:set-bounds', bounds),
  setAlwaysOnTop: (flag) => ipcRenderer.invoke('window:set-always-on-top', flag),
  setWindowOpacity: (value) => ipcRenderer.invoke('window:set-opacity', value),
  closeWindow: (opts) => ipcRenderer.invoke('window:close', opts || {}),
  setIgnoreMouse: (ignore) => ipcRenderer.send('window:set-ignore-mouse', { ignore }),

  /* ------------------------------------------------------ bar cache */
  readBars: (market, symbol, interval, from, to) =>
    ipcRenderer.invoke('bars:read', { market, symbol, interval, from, to }),
  writeBars: (market, symbol, interval, bars) =>
    ipcRenderer.invoke('bars:write', { market, symbol, interval, bars }),
  barCacheStats: () => ipcRenderer.invoke('bars:stats'),
  clearBarCache: (symbol) => ipcRenderer.invoke('bars:clear', symbol),

  /* ------------------------------------------------------- datafeed */
  datafeed: {
    call: (market, method, args) => ipcRenderer.invoke('datafeed:call', { market, method, args }),
    subscribe: (subId, market, symbol, interval) =>
      ipcRenderer.send('datafeed:subscribe', { subId, market, symbol, interval }),
    unsubscribe: (subId, market) => ipcRenderer.send('datafeed:unsubscribe', { subId, market }),
    onBar: (cb) => on('datafeed:bar', cb),
    onTicker: (cb) => on('datafeed:ticker', cb),
    onFunding: (cb) => on('datafeed:funding', cb),
    onOI: (cb) => on('datafeed:oi', cb),
    onStatus: (cb) => on('datafeed:status', cb),
    onReset: (cb) => on('datafeed:reset', cb),
  },

  /* --------------------------------------------------------- events */
  onCardChanged: (cb) => on('card:changed', cb),
  onCardsChanged: (cb) => on('cards:changed', cb),
  onPrefs: (cb) => on('app:prefs', cb),
  onVisibility: (cb) => on('app:visibility', cb),
  onClickThrough: (cb) => on('app:click-through', cb),
  onAlwaysOnTop: (cb) => on('app:always-on-top', cb),
  onMode: (cb) => on('app:mode', cb),

  /* ---------------------------------------------------------- trading */
  // Intents only: the main process validates and rounds every order, and the
  // API secret never crosses this bridge -- it can be set, never read back.
  trading: {
    status: () => ipcRenderer.invoke('trading:status'),
    watch: (symbol, owner) => ipcRenderer.invoke('trading:watch', { symbol, owner }),
    unwatch: (owner) => ipcRenderer.invoke('trading:unwatch', { owner }),
    preview: (req) => ipcRenderer.invoke('trading:preview', req),
    place: (req) => ipcRenderer.invoke('trading:place', req),
    cancel: (req) => ipcRenderer.invoke('trading:cancel', req),
    close: (symbol) => ipcRenderer.invoke('trading:close', { symbol }),
    setTpsl: (req) => ipcRenderer.invoke('trading:tpsl', req),
    // Dragging on the chart: a limit order's price, and a pending TP/SL.
    modifyOrder: (req) => ipcRenderer.invoke('trading:modify', req),
    updatePending: (req) => ipcRenderer.invoke('trading:pending', req),
    setEnv: (env, confirmLive = false) => ipcRenderer.invoke('trading:set-env', { env, confirmLive }),
    setKeys: (env, apiKey, secret) => ipcRenderer.invoke('trading:set-keys', { env, apiKey, secret }),
    // Opens a file dialog in the main process; the private key never comes back.
    setKeyFile: (env, apiKey) => ipcRenderer.invoke('trading:set-key-file', { env, apiKey }),
    clearKeys: (env) => ipcRenderer.invoke('trading:clear-keys', { env }),
    // Per symbol, on Binance: its current leverage and ceiling, and a change.
    getLeverage: (symbol) => ipcRenderer.invoke('trading:leverage', { symbol }),
    setLeverage: (symbol, leverage) => ipcRenderer.invoke('trading:set-leverage', { symbol, leverage }),
    setOneWay: () => ipcRenderer.invoke('trading:one-way'),
    test: () => ipcRenderer.invoke('trading:test'),
    onStatus: (cb) => on('trading:status', cb),
    onSnapshot: (cb) => on('trading:snapshot', cb),
    onNotice: (cb) => on('trading:notice', cb),
  },

  /* ------------------------------------------------ position alerts */
  alertStates: () => ipcRenderer.invoke('alerts:states'),
  onAlertState: (cb) => on('alerts:state', cb),
  onAlertFired: (cb) => on('alerts:fired', cb),
  ackAlert: () => ipcRenderer.send('alerts:ack'),
};

/**
 * Hub-only surface. The hidden hub window owns the Binance connections (one
 * per market) and answers requests relayed by the main process.
 */
const hubApi = {
  ready: () => ipcRenderer.send('hub:ready'),
  onRequest: (cb) => on('hub:request', cb),
  respond: (payload) => ipcRenderer.send('hub:response', payload),
  onSubscribe: (cb) => on('hub:subscribe', cb),
  onUnsubscribe: (cb) => on('hub:unsubscribe', cb),
  onReleaseOwner: (cb) => on('hub:release-owner', cb),
  emit: (ownerId, channel, payload) => ipcRenderer.send('hub:emit', { ownerId, channel, payload }),
  writeBars: (market, symbol, interval, bars) =>
    ipcRenderer.invoke('bars:write', { market, symbol, interval, bars }),
  onWatch: (cb) => on('hub:watch', cb),
  alert: (payload) => ipcRenderer.send('hub:alert', payload),
  alertState: (payload) => ipcRenderer.send('hub:alert-state', payload),
};

contextBridge.exposeInMainWorld('stockcard', api);
contextBridge.exposeInMainWorld('stockcardHub', hubApi);
