'use strict';

/**
 * Trading on Binance USDⓈ-M perpetuals: one service in the main process.
 *
 * Owns the credentials (via the vault), the REST client and the user-data
 * stream, and keeps a snapshot per symbol -- position, open orders, TP/SL --
 * that it pushes to every card window showing that symbol. Renderers only
 * ever send *intents* (place this, cancel that) and get snapshots back; every
 * order is validated and rounded here, against the exchange's own filters,
 * no matter what the renderer computed.
 *
 * The account runs cross margin in one-way mode (the user's choice). Leverage
 * is one global setting, applied to a symbol the first time it is traded.
 *
 * Testnet first: the default environment is Binance's demo exchange, and
 * switching to live needs an explicit confirmation in the settings.
 */

const { webContents } = require('electron');
const { randomUUID } = require('crypto');
const store = require('../store');
const vault = require('./vault');
const rules = require('./rules');
const { FuturesClient, friendly } = require('./client');
const { UserStream } = require('./stream');

const POLL_FAST_MS = 3000; // stream down: polling is all there is
const POLL_SLOW_MS = 12000; // stream up: polling is only the safety net
const ACCOUNT_MS = 10000;
const LEVERAGE_MIN = 1;
const LEVERAGE_MAX = 125;

const DEFAULT_CONFIG = Object.freeze({ env: 'testnet', leverage: 10, liveConfirmed: false, pending: {} });

/* ------------------------------------------------------------------ state */

const state = {
  client: null,
  stream: null,
  env: null,
  connection: 'idle', // idle | connecting | ready | error
  error: '',
  streamState: 'off',
  oneWay: null,
  rules: new Map(), // symbol -> parsed filters
  brackets: new Map(), // symbol -> maintenance brackets
  symbolConfig: new Map(), // symbol -> {leverage, marginType}
  snapshots: new Map(), // symbol -> last snapshot
  account: null,
  watchers: new Map(), // webContents id -> Set(symbol)
  pollTimer: null,
  accountTimer: null,
  refreshQueued: new Map(),
  busy: new Set(), // symbols with an order action in flight
};

function config() {
  const raw = store.get('trading') || {};
  return {
    env: vault.ENVS.includes(raw.env) ? raw.env : DEFAULT_CONFIG.env,
    leverage: clampLeverage(raw.leverage),
    liveConfirmed: raw.liveConfirmed === true,
    pending: raw.pending && typeof raw.pending === 'object' ? raw.pending : {},
  };
}

function saveConfig(patch) {
  store.set('trading', { ...config(), ...patch });
}

function clampLeverage(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_CONFIG.leverage;
  return Math.min(LEVERAGE_MAX, Math.max(LEVERAGE_MIN, n));
}

/* --------------------------------------------------------------- outbound */

function send(wc, channel, payload) {
  if (wc && !wc.isDestroyed()) wc.send(channel, payload);
}

/** Every window with a card watching a symbol (a board window counts once). */
function allWatchers() {
  const ids = new Set([...state.watchers.values()].map((w) => w.wcId));
  return [...ids].map((id) => webContents.fromId(id)).filter(Boolean);
}

/** Status goes to every window, not just watchers: a spot card's settings show it too. */
function broadcastStatus() {
  const payload = status();
  for (const wc of webContents.getAllWebContents()) send(wc, 'trading:status', payload);
}

function notice(level, text, symbol = null) {
  console.log(`[trading] ${level}: ${text}${symbol ? ` (${symbol})` : ''}`);
  for (const wc of allWatchers()) send(wc, 'trading:notice', { level, text, symbol, at: Date.now() });
}

function publish(symbol) {
  const snap = state.snapshots.get(symbol);
  if (!snap) return;
  const sent = new Set();
  for (const w of state.watchers.values()) {
    if (w.symbol !== symbol || sent.has(w.wcId)) continue;
    sent.add(w.wcId);
    send(webContents.fromId(w.wcId), 'trading:snapshot', snap);
  }
}

/* ----------------------------------------------------------------- status */

function status() {
  const cfg = config();
  return {
    env: cfg.env,
    leverage: cfg.leverage,
    liveConfirmed: cfg.liveConfirmed,
    keys: { testnet: vault.describe('testnet'), live: vault.describe('live') },
    connection: state.connection,
    error: state.error,
    stream: state.streamState,
    oneWay: state.oneWay,
    account: state.account ? summarizeAccount(state.account) : null,
  };
}

function summarizeAccount(acc) {
  return {
    walletBalance: Number(acc.totalWalletBalance) || 0,
    availableBalance: Number(acc.availableBalance) || 0,
    marginBalance: Number(acc.totalMarginBalance) || 0,
    unrealized: Number(acc.totalUnrealizedProfit) || 0,
  };
}

/* ------------------------------------------------------------- connection */

function disconnect() {
  clearInterval(state.pollTimer);
  clearInterval(state.accountTimer);
  state.pollTimer = null;
  state.accountTimer = null;
  if (state.stream) state.stream.stop();
  state.stream = null;
  state.client = null;
  state.env = null;
  state.connection = 'idle';
  state.error = '';
  state.streamState = 'off';
  state.oneWay = null;
  state.account = null;
  state.rules.clear();
  state.brackets.clear();
  state.symbolConfig.clear();
  state.snapshots.clear();
}

/** Connect to the configured environment if there is a key for it. Idempotent. */
async function connect() {
  const cfg = config();
  if (cfg.env === 'live' && !cfg.liveConfirmed) return false;
  const creds = vault.get(cfg.env);
  if (!creds) return false;
  if (state.client && state.env === cfg.env && state.connection === 'ready') return true;
  if (state.connecting) return state.connecting;

  disconnect();
  state.env = cfg.env;
  state.connection = 'connecting';
  broadcastStatus();
  state.client = new FuturesClient({ env: cfg.env, ...creds });

  state.connecting = (async () => {
    try {
      const client = state.client;
      const [info, mode, account] = await Promise.all([
        client.exchangeInfo(),
        client.positionMode(),
        client.account(),
      ]);
      if (client !== state.client) return false;
      for (const s of info.symbols || []) {
        if (s.contractType && s.contractType !== 'PERPETUAL') continue;
        const parsed = rules.parseSymbolRules(s);
        if (parsed) state.rules.set(s.symbol, parsed);
      }
      state.oneWay = mode && mode.dualSidePosition === false;
      state.account = account;
      state.connection = 'ready';
      state.error = '';
      state.stream = new UserStream(client, {
        onEvent: onStreamEvent,
        onState: (s) => {
          state.streamState = s;
          broadcastStatus();
          schedulePolling();
        },
      });
      state.stream.start();
      schedulePolling();
      state.accountTimer = setInterval(refreshAccount, ACCOUNT_MS);
      broadcastStatus();
      for (const symbol of watchedSymbols()) refreshSymbol(symbol);
      if (!state.oneWay) notice('warn', '帳戶目前是「雙向持倉」，下單前需要切換為單向持倉（設定 → 交易）');
      return true;
    } catch (err) {
      state.connection = 'error';
      state.error = friendly(err);
      broadcastStatus();
      return false;
    } finally {
      state.connecting = null;
    }
  })();
  return state.connecting;
}

function schedulePolling() {
  clearInterval(state.pollTimer);
  if (!state.client || state.connection !== 'ready') return;
  const every = state.streamState === 'live' ? POLL_SLOW_MS : POLL_FAST_MS;
  state.pollTimer = setInterval(() => {
    for (const symbol of watchedSymbols()) refreshSymbol(symbol);
  }, every);
}

/** Symbols on screen, plus any with a TP/SL waiting on an entry to fill. */
function watchedSymbols() {
  const out = new Set();
  for (const w of state.watchers.values()) out.add(w.symbol);
  const pending = config().pending[state.env] || {};
  for (const p of Object.values(pending)) out.add(p.symbol);
  return out;
}

function onStreamEvent(data) {
  const symbols = new Set();
  if (data.e === 'ORDER_TRADE_UPDATE' && data.o) {
    symbols.add(data.o.s);
    const o = data.o;
    if (o.X === 'FILLED' || o.X === 'PARTIALLY_FILLED') {
      const side = o.S === 'BUY' ? '買入' : '賣出';
      if (o.X === 'FILLED') notice('fill', `${o.s} ${side} ${o.z} 已成交，均價 ${o.ap}`, o.s);
    }
  } else if (data.e === 'ACCOUNT_UPDATE' && data.a) {
    for (const p of data.a.P || []) symbols.add(p.s);
    refreshAccount();
  } else if (data.e === 'ALGO_UPDATE') {
    const o = data.o || data.ao || {};
    if (o.s) symbols.add(o.s);
    if (o.X === 'TRIGGERED' || o.X === 'TRIGGERING') {
      notice('fill', `${o.s} ${/TAKE_PROFIT/.test(o.o || '') ? '止盈' : '止損'}已觸發`, o.s);
    } else if (o.X === 'REJECTED') {
      notice('error', `${o.s} 條件單被拒絕${o.rm ? `：${o.rm}` : ''}`, o.s);
    }
  }
  for (const s of symbols) queueRefresh(s);
}

/** Coalesce a burst of events (a fill is several) into one REST round. */
function queueRefresh(symbol, delay = 150) {
  if (!symbol || state.refreshQueued.has(symbol)) return;
  state.refreshQueued.set(
    symbol,
    setTimeout(() => {
      state.refreshQueued.delete(symbol);
      refreshSymbol(symbol);
    }, delay)
  );
}

async function refreshAccount() {
  if (!state.client || state.connection !== 'ready') return;
  try {
    state.account = await state.client.account();
    broadcastStatus();
  } catch {
    /* next tick */
  }
}

/* -------------------------------------------------------------- snapshots */

async function ensureSymbolMeta(symbol) {
  const client = state.client;
  if (!state.brackets.has(symbol)) {
    const res = await client.leverageBracket(symbol);
    const entry = Array.isArray(res) ? res.find((r) => r.symbol === symbol) || res[0] : res;
    state.brackets.set(symbol, (entry && entry.brackets) || []);
  }
  if (!state.symbolConfig.has(symbol)) {
    const res = await client.symbolConfig(symbol);
    const entry = Array.isArray(res) ? res.find((r) => r.symbol === symbol) || res[0] : res;
    if (entry) state.symbolConfig.set(symbol, { leverage: Number(entry.leverage), marginType: entry.marginType });
  }
}

function classifyAlgo(a) {
  const type = String(a.orderType || a.type || '');
  return {
    id: String(a.algoId),
    kind: type.startsWith('TAKE_PROFIT') ? 'tp' : 'sl',
    side: a.side,
    trigger: Number(a.triggerPrice),
    qty: Number(a.quantity) || 0,
    closePosition: a.closePosition === true || a.closePosition === 'true',
  };
}

async function refreshSymbol(symbol) {
  const client = state.client;
  if (!client || state.connection !== 'ready' || !state.rules.has(symbol)) return;
  try {
    await ensureSymbolMeta(symbol);
    const [risk, orders, algos] = await Promise.all([
      client.positionRisk(symbol),
      client.openOrders(symbol),
      client.openAlgoOrders(symbol).catch(() => []),
    ]);
    if (client !== state.client) return;
    const rows = Array.isArray(risk) ? risk.filter((p) => p.symbol === symbol) : [];
    const row = rows.find((p) => Number(p.positionAmt) !== 0) || null;
    const cfg = state.symbolConfig.get(symbol) || {};
    const position = row
      ? {
          amt: Number(row.positionAmt),
          entry: Number(row.entryPrice),
          breakEven: Number(row.breakEvenPrice) || Number(row.entryPrice),
          mark: Number(row.markPrice),
          upnl: Number(row.unRealizedProfit),
          liq: Number(row.liquidationPrice) || null,
          notional: Math.abs(Number(row.notional)),
          initialMargin: Number(row.initialMargin) || 0,
          maintMargin: Number(row.maintMargin) || 0,
          leverage: cfg.leverage || config().leverage,
          marginType: cfg.marginType || 'CROSSED',
        }
      : null;
    const algoList = (Array.isArray(algos) ? algos : (algos && algos.orders) || [])
      .filter((a) => !a.symbol || a.symbol === symbol)
      .map(classifyAlgo);
    const snap = {
      symbol,
      env: state.env,
      at: Date.now(),
      position,
      orders: (orders || [])
        .filter((o) => o.type === 'LIMIT')
        .map((o) => ({
          id: String(o.orderId),
          side: o.side,
          price: Number(o.price),
          qty: Number(o.origQty),
          filled: Number(o.executedQty),
          reduceOnly: o.reduceOnly === true,
        })),
      tp: algoList.find((a) => a.kind === 'tp') || null,
      sl: algoList.find((a) => a.kind === 'sl') || null,
      algos: algoList,
      pending: pendingFor(symbol),
      leverage: config().leverage,
      rules: state.rules.get(symbol),
    };
    state.snapshots.set(symbol, snap);
    publish(symbol);
    await settlePending(symbol, snap);
  } catch (err) {
    console.warn(`[trading] refresh ${symbol} failed: ${friendly(err)}`);
  }
}

/* ------------------------------------------- TP/SL waiting on a limit fill */

function pendingFor(symbol) {
  const pending = config().pending[state.env] || {};
  return Object.entries(pending)
    .filter(([, p]) => p.symbol === symbol)
    .map(([orderId, p]) => ({ orderId, tp: p.tp, sl: p.sl }));
}

function setPending(orderId, value) {
  const cfg = config();
  const env = { ...(cfg.pending[state.env] || {}) };
  if (value) env[orderId] = value;
  else delete env[orderId];
  saveConfig({ pending: { ...cfg.pending, [state.env]: env } });
}

/**
 * A limit entry with TP/SL attached places the TP/SL only once it fills --
 * a close-position stop sitting there before there is a position would just
 * be rejected or, worse, close whatever *else* is open. Checked on every
 * refresh, so it also catches fills that happened while the app was closed.
 */
async function settlePending(symbol, snap) {
  for (const p of snap.pending) {
    if (snap.orders.some((o) => o.id === p.orderId)) continue; // still working
    let order;
    try {
      order = await state.client.getOrder(symbol, p.orderId);
    } catch {
      continue;
    }
    const filled = Number(order.executedQty) > 0;
    const done = ['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED'].includes(order.status);
    if (!done) continue;
    setPending(p.orderId, null);
    if (filled && snap.position) {
      await placeTpsl(symbol, snap.position.amt > 0 ? 'long' : 'short', { tp: p.tp, sl: p.sl });
      queueRefresh(symbol, 300);
    }
  }
}

/* ----------------------------------------------------------------- orders */

async function ready() {
  const ok = await connect();
  if (!ok || state.connection !== 'ready') {
    throw new Error(state.error || '尚未連線到幣安：請先在設定 → 交易填入 API Key');
  }
  if (!state.oneWay) throw new Error('帳戶是雙向持倉模式，請先在設定 → 交易切換為單向持倉');
}

/** Leverage and cross margin, set on a symbol before its first order. */
async function prepareSymbol(symbol) {
  await ensureSymbolMeta(symbol);
  const want = config().leverage;
  const cfg = state.symbolConfig.get(symbol) || {};
  if (cfg.marginType && cfg.marginType !== 'CROSSED') {
    try {
      await state.client.setMarginType(symbol, 'CROSSED');
      cfg.marginType = 'CROSSED';
    } catch (err) {
      if (err.code !== -4046) notice('warn', `無法切換為全倉，將沿用逐倉：${friendly(err)}`, symbol);
    }
  }
  if (cfg.leverage !== want) {
    const res = await state.client.setLeverage(symbol, want);
    cfg.leverage = Number(res.leverage) || want;
  }
  state.symbolConfig.set(symbol, cfg);
}

function rulesFor(symbol) {
  const r = state.rules.get(symbol);
  if (!r) throw new Error(`${symbol} 不是可交易的 U 本位永續合約`);
  return r;
}

/**
 * Everything the order ticket shows before sending: the rounded quantity,
 * real notional, margin, the estimated liquidation price after the fill, and
 * what the TP/SL would make or lose. Also the validation errors, so the
 * ticket can explain why its button is disabled.
 */
async function preview(req) {
  const symbol = String(req.symbol || '').toUpperCase();
  const r = rulesFor(symbol);
  const snap = state.snapshots.get(symbol) || {};
  const side = req.side === 'SELL' ? 'SELL' : 'BUY';
  const market = req.type === 'MARKET';
  const markPrice = Number(req.markPrice) || (snap.position && snap.position.mark) || 0;
  const refPrice = market ? Number(req.lastPrice) || markPrice : Number(req.price);
  const price = market ? null : rules.roundPrice(Number(req.price), r);
  const q = rules.quantityForNotional(Number(req.notional), market ? refPrice : Number(price), r, { market });
  const qty = q ? q.qty : '0';
  const leverage = config().leverage;
  const tp = req.tp ? Number(rules.roundPrice(Number(req.tp), r)) : null;
  const sl = req.sl ? Number(rules.roundPrice(Number(req.sl), r)) : null;
  const errors = rules.validateOrder({ side, type: market ? 'MARKET' : 'LIMIT', price, qty, refPrice, tp, sl, markPrice }, r);

  const account = state.account ? summarizeAccount(state.account) : null;
  const notional = q ? q.notional : 0;
  const margin = notional / leverage;
  if (account && margin > account.availableBalance + 1e-9) errors.push('可用保證金不足');

  let liq = null;
  if (q && state.account) {
    const after = rules.positionAfter(snap.position, side, q.qtyNum, refPrice);
    const others = (state.account.positions || []).filter((p) => p.symbol !== symbol);
    liq = rules.estimateLiquidation({
      amt: after.amt,
      entry: after.entry,
      walletBalance: Number(state.account.totalWalletBalance) || 0,
      otherMaint: others.reduce((s, p) => s + (Number(p.maintMargin) || 0), 0),
      otherUpnl: others.reduce((s, p) => s + (Number(p.unrealizedProfit) || 0), 0),
      brackets: state.brackets.get(symbol),
    });
  }
  const signed = side === 'BUY' ? 1 : -1;
  const outcome = (at) => (at && q ? { pnl: (at - refPrice) * q.qtyNum * signed, roe: margin > 0 ? ((at - refPrice) * q.qtyNum * signed * 100) / margin : 0 } : null);
  return {
    symbol,
    side,
    type: market ? 'MARKET' : 'LIMIT',
    price,
    qty,
    notional,
    margin,
    leverage,
    liq,
    tp: outcome(tp),
    sl: outcome(sl),
    errors,
    baseAsset: r.baseAsset,
  };
}

async function placeOrder(req) {
  await ready();
  const symbol = String(req.symbol || '').toUpperCase();
  if (state.busy.has(symbol)) throw new Error('上一筆指令還在處理中');
  state.busy.add(symbol);
  try {
    await prepareSymbol(symbol);
    const r = rulesFor(symbol);
    const market = req.type === 'MARKET';
    const lastPrice = market ? await state.client.lastPrice(symbol) : null;
    const markPrice = await state.client.markPrice(symbol);
    const p = await preview({ ...req, symbol, lastPrice, markPrice });
    if (p.errors.length) throw new Error(p.errors[0]);

    const params = {
      symbol,
      side: p.side,
      type: p.type,
      quantity: p.qty,
      newClientOrderId: `sc_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    };
    if (!market) Object.assign(params, { price: p.price, timeInForce: 'GTC' });

    const order = await state.client.newOrder(params);
    const side = p.side === 'BUY' ? '做多' : '做空';
    const hasBracket = req.tp || req.sl;
    if (market) {
      notice('fill', `${symbol} 市價${side} ${order.executedQty || p.qty} 已送出${order.avgPrice ? `，均價 ${order.avgPrice}` : ''}`, symbol);
      if (hasBracket) {
        await placeTpsl(symbol, p.side === 'BUY' ? 'long' : 'short', { tp: req.tp, sl: req.sl });
      }
    } else {
      notice('info', `${symbol} 限價${side} ${p.qty} @ ${p.price} 已掛單`, symbol);
      if (hasBracket) {
        setPending(String(order.orderId), { symbol, tp: req.tp || null, sl: req.sl || null, at: Date.now() });
      }
    }
    queueRefresh(symbol, 200);
    return { ok: true, orderId: String(order.orderId) };
  } catch (err) {
    if (err.unknown) {
      queueRefresh(symbol, 500);
      throw new Error('送單結果不明（逾時或幣安忙碌），請確認倉位與掛單後再操作');
    }
    throw new Error(friendly(err));
  } finally {
    state.busy.delete(symbol);
  }
}

/**
 * Position TP/SL as close-position conditional orders, triggered by the mark
 * price (what liquidation uses too) with price protection. `undefined` leaves
 * a side alone; `null` removes it.
 */
async function placeTpsl(symbol, direction, { tp, sl }) {
  const r = rulesFor(symbol);
  const closeSide = direction === 'long' ? 'SELL' : 'BUY';
  const existing = (await state.client.openAlgoOrders(symbol).catch(() => []))
    .filter((a) => !a.symbol || a.symbol === symbol)
    .map(classifyAlgo);
  const results = [];
  for (const [kind, value, type] of [
    ['tp', tp, 'TAKE_PROFIT_MARKET'],
    ['sl', sl, 'STOP_MARKET'],
  ]) {
    if (value === undefined) continue;
    for (const a of existing.filter((x) => x.kind === kind)) {
      await state.client.cancelAlgoOrder(a.id).catch(() => {});
    }
    if (value === null) continue;
    try {
      await state.client.newAlgoOrder({
        symbol,
        side: closeSide,
        type,
        triggerPrice: rules.roundPrice(Number(value), r),
        closePosition: 'true',
        workingType: 'MARK_PRICE',
        priceProtect: 'true',
        clientAlgoId: `sc_${kind}_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      });
      results.push(kind);
    } catch (err) {
      notice('error', `${kind === 'tp' ? '止盈' : '止損'}設定失敗：${friendly(err)}`, symbol);
    }
  }
  if (results.length) {
    notice('info', `${symbol} 已設定${results.map((k) => (k === 'tp' ? '止盈' : '止損')).join('、')}`, symbol);
  }
}

async function setTpsl(req) {
  await ready();
  const symbol = String(req.symbol || '').toUpperCase();
  await refreshSymbol(symbol);
  const snap = state.snapshots.get(symbol);
  if (!snap || !snap.position) throw new Error('目前沒有倉位，止盈止損請在下單時一起設定');
  const long = snap.position.amt > 0;
  const mark = snap.position.mark;
  const check = (value, kind) => {
    if (value === undefined || value === null) return;
    if (!(Number(value) > 0)) throw new Error('價格不正確');
    if (kind === 'tp' && (long ? value <= mark : value >= mark)) throw new Error('止盈價會立刻觸發，請放在目前價格的獲利方向');
    if (kind === 'sl' && (long ? value >= mark : value <= mark)) throw new Error('止損價會立刻觸發，請放在目前價格的虧損方向');
  };
  check(req.tp, 'tp');
  check(req.sl, 'sl');
  try {
    await placeTpsl(symbol, long ? 'long' : 'short', { tp: req.tp, sl: req.sl });
  } finally {
    queueRefresh(symbol, 200);
  }
  return { ok: true };
}

async function cancel(req) {
  await ready();
  const symbol = String(req.symbol || '').toUpperCase();
  try {
    if (req.kind === 'algo') await state.client.cancelAlgoOrder(req.id);
    else {
      await state.client.cancelOrder(symbol, req.id);
      setPending(String(req.id), null);
    }
  } catch (err) {
    throw new Error(friendly(err));
  } finally {
    queueRefresh(symbol, 150);
  }
  return { ok: true };
}

async function closePosition(req) {
  await ready();
  const symbol = String(req.symbol || '').toUpperCase();
  if (state.busy.has(symbol)) throw new Error('上一筆指令還在處理中');
  state.busy.add(symbol);
  try {
    const risk = await state.client.positionRisk(symbol);
    const row = (risk || []).find((p) => p.symbol === symbol && Number(p.positionAmt) !== 0);
    if (!row) throw new Error('目前沒有倉位');
    const amt = Number(row.positionAmt);
    const r = rulesFor(symbol);
    // The exact size, as the exchange reports it -- not a float round trip.
    const qty = rules.roundQty(Math.abs(amt), r, { market: true });
    await state.client.newOrder({
      symbol,
      side: amt > 0 ? 'SELL' : 'BUY',
      type: 'MARKET',
      quantity: qty,
      reduceOnly: 'true',
      newClientOrderId: `sc_close_${randomUUID().replace(/-/g, '').slice(0, 18)}`,
    });
    notice('fill', `${symbol} 已市價平倉 ${qty}`, symbol);
    return { ok: true };
  } catch (err) {
    if (err.unknown) throw new Error('平倉結果不明，請確認倉位');
    throw new Error(friendly(err));
  } finally {
    state.busy.delete(symbol);
    queueRefresh(symbol, 200);
  }
}

/* ------------------------------------------------------------- settings */

async function setEnv(env, { confirmLive = false } = {}) {
  if (!vault.ENVS.includes(env)) throw new Error('unknown environment');
  const patch = { env };
  if (env === 'live' && confirmLive) patch.liveConfirmed = true;
  if (env === 'testnet') patch.liveConfirmed = false;
  saveConfig(patch);
  disconnect();
  broadcastStatus();
  if (state.watchers.size) await connect();
  return status();
}

async function setCredentials(env, apiKey, secret) {
  vault.set(env, apiKey, secret);
  if (config().env === env) {
    disconnect();
    await connect();
  }
  broadcastStatus();
  return status();
}

function clearCredentials(env) {
  vault.clear(env);
  if (config().env === env) disconnect();
  broadcastStatus();
  return status();
}

async function setLeverage(value) {
  const leverage = clampLeverage(value);
  saveConfig({ leverage });
  // Applied lazily, on each symbol's next order -- but a symbol with an open
  // position should show the new number now, so apply it to those.
  for (const [symbol, snap] of state.snapshots) {
    if (snap.position && state.client) {
      try {
        const res = await state.client.setLeverage(symbol, leverage);
        const cfg = state.symbolConfig.get(symbol) || {};
        cfg.leverage = Number(res.leverage) || leverage;
        state.symbolConfig.set(symbol, cfg);
      } catch (err) {
        notice('warn', `${symbol} 槓桿調整失敗：${friendly(err)}`, symbol);
      }
      queueRefresh(symbol);
    }
  }
  broadcastStatus();
  return status();
}

async function setOneWay() {
  if (!(await connect())) throw new Error(state.error || '尚未連線');
  try {
    await state.client.setOneWayMode();
  } catch (err) {
    if (err.code !== -4059) throw new Error(friendly(err));
  }
  state.oneWay = true;
  broadcastStatus();
  return status();
}

/** Test the stored key: connect and report balance, or the reason it failed. */
async function test() {
  disconnect();
  await connect();
  return status();
}

/* --------------------------------------------------------------- watchers */

/**
 * A card (owner) in a window watches one symbol. Keyed by window *and* card,
 * since a board window holds several cards.
 */
function watch(wc, symbol, owner = '') {
  const sym = String(symbol || '').toUpperCase();
  if (!sym) return status();
  const key = `${wc.id}:${owner}`;
  if (![...state.watchers.values()].some((w) => w.wcId === wc.id)) {
    const wcId = wc.id;
    wc.once('destroyed', () => {
      for (const [k, w] of state.watchers) if (w.wcId === wcId) state.watchers.delete(k);
    });
  }
  state.watchers.set(key, { wcId: wc.id, symbol: sym });
  connect().then((ok) => {
    if (!ok) return;
    const snap = state.snapshots.get(sym);
    if (snap) send(wc, 'trading:snapshot', snap);
    refreshSymbol(sym);
  });
  return status();
}

function unwatch(wc, owner = '') {
  state.watchers.delete(`${wc.id}:${owner}`);
}

function shutdown() {
  disconnect();
}

module.exports = {
  status,
  watch,
  unwatch,
  preview: async (req) => {
    if (!(await connect())) throw new Error(state.error || '尚未連線');
    return preview(req);
  },
  placeOrder,
  cancel,
  closePosition,
  setTpsl,
  setEnv,
  setCredentials,
  clearCredentials,
  setLeverage,
  setOneWay,
  test,
  shutdown,
};
