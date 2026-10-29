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
  openGuide: () => ipcRenderer.invoke('app:open-guide'),

  /* ----------------------------------------------------------- cards */
  listCards: () => ipcRenderer.invoke('cards:list'),
  addCard: (partial) => ipcRenderer.invoke('card:add', partial),
  updateCard: (cardId, patch) => ipcRenderer.invoke('card:update', { cardId, patch }),
  removeCard: (cardId) => ipcRenderer.invoke('card:remove', cardId),
  reorderCards: (ids) => ipcRenderer.invoke('cards:reorder', ids),

  /* ---------------------------------------------------- price levels */
  listLevels: (symbol) => ipcRenderer.invoke('levels:list', symbol),
  addLevel: (symbol, price, color) => ipcRenderer.invoke('levels:add', { symbol, price, color }),
  updateLevel: (symbol, id, price) => ipcRenderer.invoke('levels:update', { symbol, id, price }),
  setLevelColor: (symbol, id, color) => ipcRenderer.invoke('levels:update', { symbol, id, color }),
  removeLevel: (symbol, id) => ipcRenderer.invoke('levels:remove', { symbol, id }),
  onLevelsChanged: (cb) => on('levels:changed', cb),

  listFibs: (symbol) => ipcRenderer.invoke('fibs:list', symbol),
  addFib: (symbol, a, b) => ipcRenderer.invoke('fibs:add', { symbol, a, b }),
  updateFib: (symbol, id, patch) => ipcRenderer.invoke('fibs:update', { symbol, id, patch }),
  removeFib: (symbol, id) => ipcRenderer.invoke('fibs:remove', { symbol, id }),
  onFibsChanged: (cb) => on('fibs:changed', cb),

  listRects: (symbol) => ipcRenderer.invoke('rects:list', symbol),
  addRect: (symbol, a, b, color) => ipcRenderer.invoke('rects:add', { symbol, a, b, color }),
  updateRect: (symbol, id, patch) => ipcRenderer.invoke('rects:update', { symbol, id, patch }),
  removeRect: (symbol, id) => ipcRenderer.invoke('rects:remove', { symbol, id }),
  onRectsChanged: (cb) => on('rects:changed', cb),

  listTrendlines: (symbol) => ipcRenderer.invoke('trendlines:list', symbol),
  addTrendline: (symbol, a, b, color) => ipcRenderer.invoke('trendlines:add', { symbol, a, b, color }),
  updateTrendline: (symbol, id, patch) => ipcRenderer.invoke('trendlines:update', { symbol, id, patch }),
  removeTrendline: (symbol, id) => ipcRenderer.invoke('trendlines:remove', { symbol, id }),
  onTrendlinesChanged: (cb) => on('trendlines:changed', cb),
  listVRanges: (symbol) => ipcRenderer.invoke('vranges:list', symbol),
  addVRange: (symbol, from, to) => ipcRenderer.invoke('vranges:add', { symbol, from, to }),
  updateVRange: (symbol, id, patch) => ipcRenderer.invoke('vranges:update', { symbol, id, patch }),
  removeVRange: (symbol, id) => ipcRenderer.invoke('vranges:remove', { symbol, id }),
  onVRangesChanged: (cb) => on('vranges:changed', cb),

  /* --------------------------------------------------------- window */
  getBounds: () => ipcRenderer.invoke('window:get-bounds'),
  setSize: (width, height) => ipcRenderer.invoke('window:set-size', { width, height }),
  setBounds: (bounds) => ipcRenderer.invoke('window:set-bounds', bounds),
  moveTo: (bounds) => ipcRenderer.send('window:move-to', bounds),
  setAlwaysOnTop: (flag) => ipcRenderer.invoke('window:set-always-on-top', flag),
  setWindowOpacity: (value) => ipcRenderer.invoke('window:set-opacity', value),
  closeWindow: (opts) => ipcRenderer.invoke('window:close', opts || {}),
  setIgnoreMouse: (ignore) => ipcRenderer.send('window:set-ignore-mouse', { ignore }),

  /* ------------------------------------------------------ bar cache */
  readBars: (market, symbol, interval, from, to) =>
    ipcRenderer.invoke('bars:read', { market, symbol, interval, from, to }),
  writeBars: (market, symbol, interval, bars) =>
    ipcRenderer.invoke('bars:write', { market, symbol, interval, bars }),
  replaceBars: (market, symbol, interval, from, to, bars) =>
    ipcRenderer.invoke('bars:replace', { market, symbol, interval, from, to, bars }),
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
    onFootprint: (cb) => on('datafeed:footprint', cb),
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
    reverse: (req) => ipcRenderer.invoke('trading:reverse', req),
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
    setDefaultNotional: (value) => ipcRenderer.invoke('trading:default-notional', { value }),
    paperReset: (capital, makerFee, takerFee) => ipcRenderer.invoke('paper:reset', { capital, makerFee, takerFee }),
    paperFees: (makerFee, takerFee) => ipcRenderer.invoke('paper:fees', { makerFee, takerFee }),
    paperJournal: () => ipcRenderer.invoke('paper:journal'),
    openJournal: () => ipcRenderer.invoke('paper:open-journal'),
    exportJournalCsv: () => ipcRenderer.invoke('paper:export-csv'),
    onJournalChanged: (cb) => on('paper:changed', cb),
    test: () => ipcRenderer.invoke('trading:test'),
    onStatus: (cb) => on('trading:status', cb),
    onSnapshot: (cb) => on('trading:snapshot', cb),
    onNotice: (cb) => on('trading:notice', cb),
  },

  /* --------------------------------------------------- price alerts */
  priceAlerts: {
    list: () => ipcRenderer.invoke('priceAlerts:list'),
    add: (alert) => ipcRenderer.invoke('priceAlerts:add', alert),
    update: (id, patch) => ipcRenderer.invoke('priceAlerts:update', { id, ...patch }),
    remove: (id) => ipcRenderer.invoke('priceAlerts:remove', id),
    onChanged: (cb) => on('priceAlerts:changed', cb),
    onFired: (cb) => on('priceAlerts:fired', cb),
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
  readFootprint: (market, symbol, from, to) => ipcRenderer.invoke('footprint:read', { market, symbol, from, to }),
  writeFootprint: (market, symbol, records) => ipcRenderer.invoke('footprint:write', { market, symbol, records }),
  onWatch: (cb) => on('hub:watch', cb),
  alert: (payload) => ipcRenderer.send('hub:alert', payload),
  alertState: (payload) => ipcRenderer.send('hub:alert-state', payload),
  onPriceAlerts: (cb) => on('hub:price-alerts', cb),
  priceAlertHit: (payload) => ipcRenderer.send('hub:price-alert-hit', payload),
};

contextBridge.exposeInMainWorld('stockcard', api);
contextBridge.exposeInMainWorld('stockcardHub', hubApi);
