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
  readBars: (symbol, interval, from, to) =>
    ipcRenderer.invoke('bars:read', { symbol, interval, from, to }),
  writeBars: (symbol, interval, bars) =>
    ipcRenderer.invoke('bars:write', { symbol, interval, bars }),
  barCacheStats: () => ipcRenderer.invoke('bars:stats'),
  clearBarCache: (symbol) => ipcRenderer.invoke('bars:clear', symbol),

  /* ------------------------------------------------------- datafeed */
  datafeed: {
    call: (method, args) => ipcRenderer.invoke('datafeed:call', { method, args }),
    subscribe: (subId, symbol, interval) =>
      ipcRenderer.send('datafeed:subscribe', { subId, symbol, interval }),
    unsubscribe: (subId) => ipcRenderer.send('datafeed:unsubscribe', { subId }),
    onBar: (cb) => on('datafeed:bar', cb),
    onTicker: (cb) => on('datafeed:ticker', cb),
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
};

/**
 * Hub-only surface. The hidden hub window owns the single Binance connection
 * and answers requests relayed by the main process.
 */
const hubApi = {
  ready: () => ipcRenderer.send('hub:ready'),
  onRequest: (cb) => on('hub:request', cb),
  respond: (payload) => ipcRenderer.send('hub:response', payload),
  onSubscribe: (cb) => on('hub:subscribe', cb),
  onUnsubscribe: (cb) => on('hub:unsubscribe', cb),
  onReleaseOwner: (cb) => on('hub:release-owner', cb),
  emit: (ownerId, channel, payload) => ipcRenderer.send('hub:emit', { ownerId, channel, payload }),
};

contextBridge.exposeInMainWorld('stockcard', api);
contextBridge.exposeInMainWorld('stockcardHub', hubApi);
