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
 * The account runs cross margin in one-way mode (the user's choice).
 *
 * Leverage is per symbol, and Binance is the record of it: the ticket shows
 * the symbol's current leverage as the exchange has it (symbolConfig), and a
 * change is written straight back (POST /leverage). Nothing here overrides it
 * at order time -- what the ticket shows is what the order uses. Each symbol's
 * ceiling comes from its leverage brackets, and falls as the position grows.
 *
 * Testnet first: the default environment is Binance's demo exchange, and
 * switching to live needs an explicit confirmation in the settings.
 *
 * A third environment, paper, needs no key at all: paper.js is a local
 * exchange that answers the FuturesClient's calls against the live market,
 * with a balance the user sets. Everything below runs on it unchanged.
 */

const { webContents } = require('electron');
const { randomUUID } = require('crypto');
const store = require('../store');
const vault = require('./vault');
const rules = require('./rules');
const { FuturesClient, friendly } = require('./client');
const { UserStream } = require('./stream');
const paper = require('./paper');

/** paper first: it is the one that needs nothing set up. */
const ENVS = ['paper', ...vault.ENVS];

const POLL_FAST_MS = 3000; // stream down: polling is all there is
const POLL_SLOW_MS = 12000; // stream up: polling is only the safety net
const ACCOUNT_MS = 10000;
const LEVERAGE_MIN = 1;
const LEVERAGE_MAX = 125;

const DEFAULT_CONFIG = Object.freeze({ env: 'testnet', leverage: 10, liveConfirmed: false, pending: {}, defaultNotional: null });

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
  flipCleared: new Set(), // reversal orders whose old-side stops are already gone
};

function config() {
  const raw = store.get('trading') || {};
  return {
    env: ENVS.includes(raw.env) ? raw.env : DEFAULT_CONFIG.env,
    leverage: clampLeverage(raw.leverage),
    liveConfirmed: raw.liveConfirmed === true,
    pending: raw.pending && typeof raw.pending === 'object' ? raw.pending : {},
    // USDT the order ticket opens with, every symbol alike; null for none.
    defaultNotional: Number(raw.defaultNotional) > 0 ? Number(raw.defaultNotional) : null,
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
    defaultNotional: cfg.defaultNotional,
    keys: { paper: { configured: true, keyTail: '', type: 'paper' }, testnet: vault.describe('testnet'), live: vault.describe('live') },
    paper: cfg.env === 'paper' ? paperBrief() : null,
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
  const isPaper = cfg.env === 'paper';
  const creds = isPaper ? null : vault.get(cfg.env);
  if (!isPaper && !creds) return false;
  if (state.client && state.env === cfg.env && state.connection === 'ready') return true;
  if (state.connecting) return state.connecting;

  disconnect();
  state.env = cfg.env;
  state.connection = 'connecting';
  broadcastStatus();
  state.client = isPaper ? paper.client : new FuturesClient({ env: cfg.env, ...creds });

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
      const handlers = {
        onEvent: onStreamEvent,
        onState: (s) => {
          state.streamState = s;
          broadcastStatus();
          schedulePolling();
        },
      };
      state.stream = isPaper ? paper.stream(handlers) : new UserStream(client, handlers);
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
  if (data.e === 'PAPER_NOTICE') {
    notice(data.level || 'info', data.text, data.s || null);
    return;
  }
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
    reduceOnly: a.reduceOnly === true || a.reduceOnly === 'true',
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
          leverage: cfg.leverage || null,
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
      leverage: cfg.leverage || null,
      maxLeverage: rules.maxLeverage(state.brackets.get(symbol)),
      rules: state.rules.get(symbol),
    };
    state.snapshots.set(symbol, snap);
    publish(symbol);
    await guardReversals(symbol, snap);
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
    .map(([orderId, p]) => ({ orderId, tp: p.tp, sl: p.sl, reverse: p.reverse || null }));
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
    state.flipCleared.delete(p.orderId);
    if (p.reverse) {
      if (filled && snap.position) await settleReversal(symbol, snap, p);
      continue;
    }
    if (filled && snap.position) {
      await placeTpsl(symbol, snap.position.amt > 0 ? 'long' : 'short', { tp: p.tp, sl: p.sl });
      queueRefresh(symbol, 300);
    }
  }
}

/* -------------------------------------------------------------- reversals */

const directionWord = (amt) => (amt > 0 ? '多' : '空');

/**
 * After a flip, the old position's TP/SL and reduce-only orders sit on the
 * wrong side of the new one: a long's stop is a sell, and the position is now
 * short. They cannot do anything useful and could only confuse, so they go.
 * `side` is the side that closed the old position.
 */
async function clearStale(symbol, side) {
  const [algos, orders] = await Promise.all([
    state.client.openAlgoOrders(symbol).catch(() => []),
    state.client.openOrders(symbol).catch(() => []),
  ]);
  let n = 0;
  const algoList = (Array.isArray(algos) ? algos : (algos && algos.orders) || [])
    .filter((a) => !a.symbol || a.symbol === symbol)
    .map(classifyAlgo);
  for (const a of algoList) {
    if (a.side !== side || !(a.closePosition || a.reduceOnly)) continue;
    try {
      await state.client.cancelAlgoOrder(a.id);
      n++;
    } catch {
      /* already gone */
    }
  }
  for (const o of orders || []) {
    if (o.side !== side || !(o.reduceOnly === true || o.reduceOnly === 'true')) continue;
    try {
      await state.client.cancelOrder(symbol, o.orderId);
      n++;
    } catch {
      /* already gone */
    }
  }
  if (n) notice('info', `${symbol} 已取消原倉位的 ${n} 筆止盈止損／減倉單`, symbol);
}

/**
 * A working limit reversal is only safe while the position is the one it was
 * sized for. If a stop triggers first, or the position is closed by hand, the
 * order would open *twice* the size the other way -- so it is cancelled.
 *
 * Position and open orders are read in parallel for the snapshot, and a fill
 * landing between the two reads looks exactly like a changed position. So a
 * mismatch is confirmed with reads in order -- the order, the position, the
 * order again -- and only acted on if the order did not move in between.
 */
async function guardReversals(symbol, snap) {
  for (const p of snap.pending) {
    if (!p.reverse) continue;
    const o = snap.orders.find((x) => x.id === p.orderId);
    if (!o) continue; // done: settlePending takes it from here
    const r = rulesFor(symbol);
    const amt = snap.position ? snap.position.amt : 0;
    const want = p.reverse.side === 'BUY' ? 1 : -1;
    if (rules.reverseIntact({ ...p.reverse, filled: o.filled, amt }, r)) {
      // Part filled and already past flat: the old side's stops are now in the way.
      if (Math.sign(amt) === want && !state.flipCleared.has(p.orderId)) {
        state.flipCleared.add(p.orderId);
        await clearStale(symbol, p.reverse.side);
      }
      continue;
    }
    try {
      const before = await state.client.getOrder(symbol, p.orderId);
      const risk = await state.client.positionRisk(symbol);
      const after = await state.client.getOrder(symbol, p.orderId);
      if (before.executedQty !== after.executedQty) continue; // filling right now
      if (!['NEW', 'PARTIALLY_FILLED'].includes(after.status)) continue;
      const row = (risk || []).find((x) => x.symbol === symbol && Number(x.positionAmt) !== 0);
      const now = row ? Number(row.positionAmt) : 0;
      if (rules.reverseIntact({ ...p.reverse, filled: Number(after.executedQty), amt: now }, r)) continue;
      await state.client.cancelOrder(symbol, p.orderId);
      setPending(p.orderId, null);
      notice(
        'warn',
        `${symbol} 倉位在反手單成交前變了（可能是止盈止損觸發或手動平倉），已取消反手限價單，避免開出兩倍的反向倉位`,
        symbol
      );
      queueRefresh(symbol, 200);
    } catch (err) {
      console.warn(`[trading] reversal guard ${symbol} failed: ${friendly(err)}`);
    }
  }
}

/** A limit reversal is done: clear the old side, then put on the new TP/SL. */
async function settleReversal(symbol, snap, p) {
  const want = p.reverse.side === 'BUY' ? 1 : -1;
  const amt = snap.position.amt;
  if (Math.sign(amt) !== want) {
    notice(
      'warn',
      `${symbol} 反手限價單只成交了一部分，倉位還是${directionWord(amt)} ${Math.abs(amt)}${p.tp || p.sl ? '，新的止盈止損沒有設定' : ''}`,
      symbol
    );
    return;
  }
  await clearStale(symbol, p.reverse.side);
  if (p.tp || p.sl) {
    await placeTpsl(symbol, want > 0 ? 'long' : 'short', { tp: p.tp || undefined, sl: p.sl || undefined });
  }
  queueRefresh(symbol, 300);
}

/**
 * A market reversal as two orders, for when one will not fit the margin:
 * close the position (reduce-only, so it can never open anything), then open
 * the same size the other way with the margin that freed. Returns the
 * opening order. If the open fails the position is flat, not reversed -- the
 * old side's stops are cleared all the same, and the error says so.
 */
async function reverseInTwo(symbol, amt, side, r, clientId) {
  const qty = rules.roundQty(Math.abs(amt), r, { market: true });
  await state.client.newOrder({ symbol, side, type: 'MARKET', quantity: qty, reduceOnly: 'true', newClientOrderId: clientId() });
  try {
    return await state.client.newOrder({ symbol, side, type: 'MARKET', quantity: qty, newClientOrderId: clientId() });
  } catch (err) {
    if (err.unknown) throw err; // may have opened after all: the caller says to check
    queueRefresh(symbol, 200);
    await clearStale(symbol, side).catch(() => {});
    const e = new Error(`已平倉，但開反向倉失敗：${friendly(err)}。目前沒有倉位，請確認後再下單`);
    e.flat = true;
    throw e;
  }
}

/**
 * Reverse the position: long to short of the same size, or short to long.
 * Market fills now; limit rests on the far side of the market, guarded until
 * it fills. Either way, once flipped, the old side's TP/SL and reduce-only
 * orders are cancelled and the new TP/SL (if any) placed.
 *
 * `expectAmt` is the size the user saw when confirming. If the exchange says
 * otherwise, nothing is sent: the summary they agreed to is no longer true.
 */
async function reversePosition(req) {
  await ready();
  const symbol = String(req.symbol || '').toUpperCase();
  if (state.busy.has(symbol)) throw new Error('上一筆指令還在處理中');
  state.busy.add(symbol);
  try {
    await prepareSymbol(symbol);
    const r = rulesFor(symbol);
    const market = req.type !== 'LIMIT';
    const risk = await state.client.positionRisk(symbol);
    const row = (risk || []).find((p) => p.symbol === symbol && Number(p.positionAmt) !== 0);
    if (!row) throw new Error('目前沒有倉位');
    const amt = Number(row.positionAmt);
    if (req.expectAmt !== undefined && Math.abs(Number(req.expectAmt) - amt) > Number(r.stepSize) / 2) {
      throw new Error(`倉位剛剛變成${directionWord(amt)} ${Math.abs(amt)}，請確認後再反手`);
    }
    if (!market && pendingFor(symbol).some((p) => p.reverse)) {
      throw new Error('已經有一筆反手限價單在等成交，要改價請拖曳它，或先取消');
    }
    const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
    const tp = num(req.tp);
    const sl = num(req.sl);
    const [last, mark] = await Promise.all([state.client.lastPrice(symbol), state.client.markPrice(symbol)]);
    const plan = rules.planReverse(
      { positionAmt: amt, market, price: req.price, lastPrice: Number(last), markPrice: Number(mark), tp, sl },
      r
    );
    if (plan.errors.length) throw new Error(plan.errors[0]);
    const from = `${directionWord(amt)} ${Math.abs(amt)}`;
    const to = `${directionWord(plan.target)} ${Math.abs(plan.target)}`;
    const clientId = () => `sc_rev_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

    // A market reversal is one order when the margin allows -- no moment flat,
    // one round trip. When the opening half will not fit beside the position
    // still holding its margin, it is two: close, then open. Judged from the
    // last account read; if that was stale and Binance says -2019 anyway, the
    // one order did nothing and the two-order way follows.
    let order = null;
    let split = false;
    if (market) {
      const leverage = (state.symbolConfig.get(symbol) || {}).leverage || config().leverage;
      const account = state.account ? summarizeAccount(state.account) : null;
      split = !rules.reverseFitsOneOrder({
        positionAmt: amt,
        price: Number(last) || Number(mark),
        leverage,
        available: account ? account.availableBalance : undefined,
      });
      if (!split) {
        try {
          order = await state.client.newOrder({ symbol, side: plan.side, type: 'MARKET', quantity: plan.qty, newClientOrderId: clientId() });
        } catch (err) {
          if (err.code !== -2019) throw err;
          split = true;
        }
      }
      if (split) order = await reverseInTwo(symbol, amt, plan.side, r, clientId);
    } else {
      order = await state.client.newOrder({
        symbol,
        side: plan.side,
        type: 'LIMIT',
        quantity: plan.qty,
        price: plan.price,
        timeInForce: 'GTC',
        newClientOrderId: clientId(),
      });
    }

    if (market) {
      const avg = Number(order.avgPrice) > 0 ? `，均價 ${order.avgPrice}` : '';
      const how = split ? '（保證金不足以一筆反手，已分成平倉＋開倉兩筆）' : '';
      notice('fill', `${symbol} 已市價反手：${from} → ${to}${avg}${how}`, symbol);
      const now = await state.client.positionRisk(symbol);
      const nrow = (now || []).find((p) => p.symbol === symbol && Number(p.positionAmt) !== 0);
      const namt = nrow ? Number(nrow.positionAmt) : 0;
      if (Math.sign(namt) === Math.sign(plan.target)) {
        await clearStale(symbol, plan.side);
        if (tp || sl) {
          await placeTpsl(symbol, plan.target > 0 ? 'long' : 'short', { tp: tp || undefined, sl: sl || undefined });
        }
      } else {
        notice('warn', `${symbol} 反手單沒有完全成交，目前倉位 ${namt}，請確認`, symbol);
      }
    } else {
      setPending(String(order.orderId), {
        symbol,
        tp,
        sl,
        at: Date.now(),
        reverse: { from: amt, side: plan.side, qty: plan.qty },
      });
      notice(
        'info',
        `${symbol} 反手限價${plan.side === 'SELL' ? '賣出' : '買入'} ${plan.qty} @ ${plan.price} 已掛單，成交後 ${from} → ${to}`,
        symbol
      );
    }
    queueRefresh(symbol, 200);
    return { ok: true, orderId: String(order.orderId) };
  } catch (err) {
    if (err.flat) {
      notice('warn', `${symbol} ${err.message}`, symbol);
      throw err;
    }
    if (err.unknown) {
      queueRefresh(symbol, 500);
      throw new Error('反手結果不明（逾時或幣安忙碌），請確認倉位與掛單後再操作');
    }
    throw new Error(friendly(err));
  } finally {
    state.busy.delete(symbol);
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

/** Cross margin, set on a symbol before its first order. Leverage is left as the user set it. */
async function prepareSymbol(symbol) {
  await ensureSymbolMeta(symbol);
  const cfg = state.symbolConfig.get(symbol) || {};
  if (cfg.marginType && cfg.marginType !== 'CROSSED') {
    try {
      await state.client.setMarginType(symbol, 'CROSSED');
      cfg.marginType = 'CROSSED';
    } catch (err) {
      if (err.code !== -4046) notice('warn', `無法切換為全倉，將沿用逐倉：${friendly(err)}`, symbol);
    }
  }
  state.symbolConfig.set(symbol, cfg);
}

/** The symbol's leverage as Binance has it, and how far it can go. */
async function getLeverage(symbol) {
  await ready();
  const sym = String(symbol || '').toUpperCase();
  rulesFor(sym);
  await ensureSymbolMeta(sym);
  return leverageInfo(sym);
}

function leverageInfo(symbol) {
  const brackets = state.brackets.get(symbol);
  const leverage = (state.symbolConfig.get(symbol) || {}).leverage || null;
  return {
    symbol,
    leverage,
    max: rules.maxLeverage(brackets),
    maxNotional: leverage ? rules.maxNotionalAt(brackets, leverage) : null,
  };
}

/** Change one symbol's leverage on Binance. */
async function setSymbolLeverage(symbol, value) {
  await ready();
  const sym = String(symbol || '').toUpperCase();
  rulesFor(sym);
  await ensureSymbolMeta(sym);
  const max = rules.maxLeverage(state.brackets.get(sym)) || LEVERAGE_MAX;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < LEVERAGE_MIN || n > max) throw new Error(`${sym} 的槓桿要在 1～${max}x 之間`);
  const res = await state.client.setLeverage(sym, n);
  const cfg = state.symbolConfig.get(sym) || {};
  cfg.leverage = Number(res.leverage) || n;
  state.symbolConfig.set(sym, cfg);
  queueRefresh(sym);
  return leverageInfo(sym);
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
  const reduceOnly = req.reduceOnly === true;
  const markPrice = Number(req.markPrice) || (snap.position && snap.position.mark) || 0;
  const refPrice = market ? Number(req.lastPrice) || markPrice : Number(req.price);
  const price = market ? null : rules.roundPrice(Number(req.price), r);
  const at = market ? refPrice : Number(price);
  let q;
  const reduceErrors = [];
  if (reduceOnly) {
    // Only ever against the position: the side that closes it, and no more
    // than its size. TP/SL make no sense on an order that only closes.
    const pos = snap.position;
    const r2 = rules.reduceQuantity(
      { positionAmt: pos ? pos.amt : 0, pct: Number(req.reducePct) || 0, notional: Number(req.notional), price: at, market },
      r
    );
    if (r2.error) reduceErrors.push(r2.error);
    else q = r2;
    if (pos && pos.amt !== 0) {
      const closing = pos.amt > 0 ? 'SELL' : 'BUY';
      if (side !== closing) reduceErrors.unshift(`持${pos.amt > 0 ? '多' : '空'}倉時，只減倉只能${closing === 'SELL' ? '賣出' : '買入'}`);
    }
  } else {
    q = rules.quantityForNotional(Number(req.notional), at, r, { market });
  }
  const qty = q ? q.qty : '0';
  if (state.client && state.connection === 'ready') await ensureSymbolMeta(symbol);
  const leverage = (state.symbolConfig.get(symbol) || {}).leverage || config().leverage;
  const tp = !reduceOnly && req.tp ? Number(rules.roundPrice(Number(req.tp), r)) : null;
  const sl = !reduceOnly && req.sl ? Number(rules.roundPrice(Number(req.sl), r)) : null;
  const errors = [
    ...reduceErrors,
    ...rules.validateOrder({ side, type: market ? 'MARKET' : 'LIMIT', price, qty, refPrice, tp, sl, markPrice, reduceOnly }, r),
  ];

  const account = state.account ? summarizeAccount(state.account) : null;
  const notional = q ? q.notional : 0;
  // Closing frees margin rather than using it, and cannot grow the position.
  const margin = reduceOnly ? 0 : notional / leverage;
  if (account && margin > account.availableBalance + 1e-9) errors.push('可用保證金不足');
  // The bracket ceiling: say so here rather than let Binance refuse the order.
  if (q && !reduceOnly) {
    const after = rules.positionAfter(snap.position, side, q.qtyNum, refPrice);
    const cap = rules.maxNotionalAt(state.brackets.get(symbol), leverage);
    if (Math.abs(after.amt) * refPrice > cap) {
      errors.push(`${leverage}x 時這個幣種的倉位上限是 ${Math.floor(cap).toLocaleString()} USDT，請降低槓桿或金額`);
    }
  }

  let liq = null;
  if (q && state.account && !reduceOnly) {
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
    reduceOnly,
    positionSize: snap.position ? Math.abs(snap.position.amt) : 0,
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
    const reduceOnly = req.reduceOnly === true;
    // A reduce-only order is sized against the position: check the one the
    // exchange has now, not the one a snapshot saw seconds ago.
    if (reduceOnly) await refreshSymbol(symbol);
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
    if (reduceOnly) params.reduceOnly = 'true';

    const order = await state.client.newOrder(params);
    const side = reduceOnly ? (p.side === 'BUY' ? '只減倉買入' : '只減倉賣出') : p.side === 'BUY' ? '做多' : '做空';
    const hasBracket = !reduceOnly && (req.tp || req.sl);
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
    const label = kind === 'tp' ? '止盈' : '止損';
    const old = existing.filter((x) => x.kind === kind);
    // Binance has no way to amend a conditional order, so a new price means
    // cancel and re-place -- cancel first, because a second close-position
    // order in the same direction is refused while the first stands.
    for (const a of old) {
      await state.client.cancelAlgoOrder(a.id).catch(() => {});
    }
    if (value === null) continue;
    const place = (trigger) =>
      state.client.newAlgoOrder({
        symbol,
        side: closeSide,
        type,
        triggerPrice: rules.roundPrice(Number(trigger), r),
        closePosition: 'true',
        workingType: 'MARK_PRICE',
        priceProtect: 'true',
        clientAlgoId: `sc_${kind}_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      });
    try {
      await place(value);
      results.push(kind);
    } catch (err) {
      // The old one is already gone. Leaving the position without a stop
      // because the *new* price was refused (it would have triggered at once,
      // say) is the worst outcome on offer, so put the old one back.
      const previous = old[0] && old[0].trigger;
      if (!previous) {
        notice('error', `${label}設定失敗：${friendly(err)}`, symbol);
        continue;
      }
      try {
        await place(previous);
        notice('error', `${label}調整失敗：${friendly(err)}。已恢復為原本的 ${previous}`, symbol);
      } catch (restoreErr) {
        notice('error', `${label}調整失敗，而且無法恢復原本的 ${previous}：${friendly(restoreErr)}。這個倉位目前沒有${label}，請立刻檢查！`, symbol);
      }
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

/**
 * A working limit order dragged to a new price: modified in place. Refused if
 * the new price is through the market -- a buy above or a sell below the
 * last trade would fill on the spot as a taker, which a drag should not do.
 */
async function modifyOrderPrice(req) {
  await ready();
  const symbol = String(req.symbol || '').toUpperCase();
  const r = rulesFor(symbol);
  const orders = await state.client.openOrders(symbol);
  const order = (orders || []).find((o) => String(o.orderId) === String(req.orderId));
  if (!order) throw new Error('找不到這筆委託（可能已經成交或取消）');
  if (order.type !== 'LIMIT') throw new Error('只有限價委託可以拖曳改價');
  const price = rules.roundPrice(Number(req.price), r);
  if (!(Number(price) > 0)) throw new Error('價格不正確');
  const last = Number(await state.client.lastPrice(symbol));
  if (last > 0 && (order.side === 'BUY' ? Number(price) >= last : Number(price) <= last)) {
    throw new Error('拖過目前價格會立刻成交；要立刻成交請用下單票的市價單');
  }
  try {
    await state.client.modifyOrder({ symbol, orderId: order.orderId, side: order.side, quantity: order.origQty, price });
  } catch (err) {
    throw new Error(friendly(err));
  } finally {
    queueRefresh(symbol, 150);
  }
  notice('info', `${symbol} 限價${order.side === 'BUY' ? '買' : '賣'}已改到 ${price}`, symbol);
  return { ok: true, price };
}

/**
 * The TP or SL waiting for a limit order to fill: only stored here, so a drag
 * just rewrites it -- checked against the order's own price and side, since
 * that is where the position will start.
 */
async function updatePending(req) {
  await ready();
  const symbol = String(req.symbol || '').toUpperCase();
  const r = rulesFor(symbol);
  const id = String(req.orderId);
  const record = (config().pending[state.env] || {})[id];
  if (!record) throw new Error('找不到這筆委託的止盈止損');
  const order = ((await state.client.openOrders(symbol)) || []).find((o) => String(o.orderId) === id);
  if (!order) throw new Error('找不到這筆委託（可能已經成交或取消）');
  const entry = Number(order.price);
  const long = order.side === 'BUY';
  const next = { ...record };
  for (const kind of ['tp', 'sl']) {
    if (req[kind] === undefined) continue;
    const value = Number(rules.roundPrice(Number(req[kind]), r));
    const wrong = kind === 'tp' ? (long ? value <= entry : value >= entry) : long ? value >= entry : value <= entry;
    if (wrong) throw new Error(`${kind === 'tp' ? '止盈' : '止損'}要放在委託價的${kind === 'tp' ? '獲利' : '虧損'}方向`);
    next[kind] = value;
  }
  setPending(id, next);
  queueRefresh(symbol, 50);
  return { ok: true };
}

/** Is the order (or conditional order) a cancel was refused for still working? */
async function stillOpen(symbol, req) {
  try {
    if (req.kind === 'algo') {
      const algos = await state.client.openAlgoOrders(symbol);
      const list = Array.isArray(algos) ? algos : (algos && algos.orders) || [];
      return list.some((a) => String(a.algoId) === String(req.id));
    }
    const orders = await state.client.openOrders(symbol);
    return (orders || []).some((o) => String(o.orderId) === String(req.id));
  } catch {
    return true; // unknown: keep the error
  }
}

async function cancel(req) {
  await ready();
  const symbol = String(req.symbol || '').toUpperCase();
  try {
    if (req.kind === 'algo') {
      await state.client.cancelAlgoOrder(req.id);
      notice('info', `${symbol} 已取消條件單`, symbol);
    } else {
      const res = await state.client.cancelOrder(symbol, req.id);
      setPending(String(req.id), null);
      const side = res && res.side === 'SELL' ? '賣' : '買';
      notice('info', `${symbol} 已取消限價${side}${res && res.price ? ` @ ${Number(res.price)}` : ''}`, symbol);
    }
  } catch (err) {
    // -2011 "Unknown order sent": usually a second press on a line still
    // drawn after the first press had already cancelled it (or the order
    // filled meanwhile). If it really is gone, the user got what they asked
    // for -- say so plainly instead of showing an alarming error.
    if (err.code === -2011 && !(await stillOpen(symbol, req))) {
      if (req.kind !== 'algo') setPending(String(req.id), null);
      notice('info', `${symbol} 這筆委託已經不在了（已取消或已成交）`, symbol);
      return { ok: true, gone: true };
    }
    throw new Error(friendly(err));
  } finally {
    queueRefresh(symbol, 150);
    // Binance's open-order list can trail a cancel; look again a little later
    // rather than wait for the next poll to drop the line.
    setTimeout(() => refreshSymbol(symbol), 1500);
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
  if (!ENVS.includes(env)) throw new Error('unknown environment');
  const patch = { env };
  if (env === 'live' && confirmLive) patch.liveConfirmed = true;
  if (env !== 'live') patch.liveConfirmed = false;
  saveConfig(patch);
  disconnect();
  broadcastStatus();
  if (state.watchers.size) await connect();
  return status();
}

async function reconnectAfterKeyChange(env) {
  if (config().env === env) {
    disconnect();
    await connect();
  }
  broadcastStatus();
  return status();
}

/** A System-generated (HMAC) key. */
async function setCredentials(env, apiKey, secret) {
  vault.set(env, apiKey, secret);
  return reconnectAfterKeyChange(env);
}

/** A Self-generated key: the API key, and the private key's PEM text. */
async function setPrivateKey(env, apiKey, pem) {
  vault.setPrivateKey(env, apiKey, pem);
  return reconnectAfterKeyChange(env);
}

function clearCredentials(env) {
  vault.clear(env);
  if (config().env === env) disconnect();
  broadcastStatus();
  return status();
}

/** The amount the order ticket opens with; 0 or empty clears it. */
function setDefaultNotional(value) {
  const n = Math.round(Number(value) * 100) / 100;
  saveConfig({ defaultNotional: Number.isFinite(n) && n > 0 ? n : null });
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

/* ------------------------------------------------------------------ paper */

function paperBrief() {
  const s = paper.summary();
  return { capital: s.capital, settings: s.settings, wallet: s.stats.wallet, net: s.stats.net, returnPct: s.stats.returnPct };
}

/** Start the paper account over; reconnects so every card sees the new balance. */
async function paperReset(capital, settings) {
  paper.reset(capital, settings);
  if (config().env === 'paper') {
    disconnect();
    if (state.watchers.size) await connect();
  }
  broadcastStatus();
  return status();
}

function paperSetFees(fees) {
  paper.setFees(fees);
  broadcastStatus();
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
  reversePosition,
  setTpsl,
  modifyOrderPrice,
  updatePending,
  setEnv,
  setCredentials,
  setPrivateKey,
  clearCredentials,
  getLeverage,
  setSymbolLeverage,
  setOneWay,
  setDefaultNotional,
  paperReset,
  paperSetFees,
  test,
  shutdown,
};
