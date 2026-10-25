'use strict';

/**
 * The paper exchange: a local stand-in for Binance USDⓈ-M, so a strategy can
 * be traded with made-up money against the real market.
 *
 * It speaks the FuturesClient's language -- the same method names, the same
 * response shapes, the same error codes -- so the trading service, the order
 * ticket, TP/SL, reversals and the drag-to-modify labels all run on it
 * unchanged. The money is in paper-engine.js; this file is the exchange
 * around it: prices, matching, the clock, and the file it all lives in.
 *
 * Prices are Binance's live public market data (no key needed):
 *
 *   - market orders and triggered stops take liquidity from the real order
 *     book, walking its levels, so size has a cost (slippage) as it would;
 *   - a resting limit order fills only when trades print *through* its price,
 *     not merely at it -- at the price itself it would be waiting in a queue
 *     of unknown length, and assuming the fill would flatter the results;
 *   - TP/SL trigger on the mark price, as the real ones are set to;
 *   - funding is settled at each funding time at the rate Binance published;
 *   - cross-margin liquidation is checked every second.
 *
 * While the app is closed nothing watches the market, so on the next start
 * the gap is replayed from 1-minute candles and the published funding rates:
 * stops, limit fills, funding and liquidation, in time order. Within one
 * candle the order of the high and the low is unknown, so stops go first --
 * the pessimistic reading, which is the honest one for judging a strategy.
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const E = require('./paper-engine');
const rules = require('./rules');
const { BinanceError } = require('./client');
const { t } = require('../i18n');

const REST = process.env.STOCKCARD_PAPER_REST || 'https://fapi.binance.com';
const TICK_MS = 1000;
/** A gap longer than this between ticks (sleep, a stall) is replayed from candles. */
const GAP_MS = 15000;
/** How far back a replay reaches. */
const REPLAY_MAX_MS = 30 * 86400e3;
const DEFAULT_CAPITAL = 10000;

const state = {
  file: null,
  acct: null,
  saveTimer: null,
  tickTimer: null,
  ticking: false,
  listeners: new Set(), // stream handlers
  changeHooks: new Set(),
  marks: {}, // symbol -> mark price
  funding: {}, // symbol -> {next, rate}
  lastTradeTime: {}, // symbol -> ms of the last aggTrade looked at
  info: null, // exchangeInfo, cached
  infoAt: 0,
  /** What a replay did, said once a card is listening. */
  replayNotes: [],
};

/* ------------------------------------------------------------ persistence */

function init(userDataDir) {
  state.file = path.join(userDataDir, 'paper-account.json');
  try {
    const raw = JSON.parse(fs.readFileSync(state.file, 'utf8'));
    if (raw && raw.version === 1 && Number.isFinite(raw.wallet)) state.acct = raw;
  } catch {
    /* none yet */
  }
  if (!state.acct) {
    state.acct = E.newAccount(DEFAULT_CAPITAL);
    save();
  }
  state.funding = state.acct.funding || {};
  // Replay whatever happened while the app was closed, then keep watching.
  catchUp().finally(() => {
    clearInterval(state.tickTimer);
    state.tickTimer = setInterval(tick, TICK_MS);
  });
}

function save() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(flush, 300);
}

function flush() {
  clearTimeout(state.saveTimer);
  if (!state.file || !state.acct) return;
  state.acct.funding = state.funding;
  const tmp = `${state.file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state.acct));
    fs.renameSync(tmp, state.file);
  } catch (err) {
    console.warn(`[paper] save failed: ${err.message}`);
  }
}

function shutdown() {
  clearInterval(state.tickTimer);
  state.tickTimer = null;
  flush();
}

/** Something changed: persist, and tell the journal window. */
function changed() {
  save();
  for (const fn of state.changeHooks) fn();
}

function onChange(fn) {
  state.changeHooks.add(fn);
  return () => state.changeHooks.delete(fn);
}

/* ------------------------------------------------------------ market data */

async function get(pathname, params = {}) {
  const q = new URLSearchParams(params).toString();
  const res = await fetch(`${REST}${pathname}${q ? `?${q}` : ''}`);
  const text = await res.text();
  if (!res.ok) throw new BinanceError({ status: res.status, msg: t('行情讀取失敗：{text}', { text: text.slice(0, 120) }) });
  return rules.parseExact(text);
}

async function premium(symbol) {
  const p = await get('/fapi/v1/premiumIndex', { symbol });
  const mark = Number(p.markPrice);
  if (mark > 0) state.marks[symbol] = mark;
  return { mark, rate: Number(p.lastFundingRate), next: Number(p.nextFundingTime) };
}

async function book(symbol) {
  const d = await get('/fapi/v1/depth', { symbol, limit: 50 });
  return { bids: d.bids || [], asks: d.asks || [] };
}

/** Where `qty` would fill taking liquidity on `side`, from the live book. */
async function takerPrice(symbol, side, qty) {
  const b = await book(symbol);
  const px = E.bookFill(side === 'BUY' ? b.asks : b.bids, qty);
  if (!(px > 0)) throw new BinanceError({ status: 0, msg: t('讀不到掛單簿，無法模擬成交') });
  return { price: px, book: b };
}

/* -------------------------------------------------------------- events */

function emit(data) {
  for (const h of state.listeners) {
    try {
      h.onEvent(data);
    } catch {
      /* a listener's problem */
    }
  }
}

function emitFill(symbol, side, qty, price, status = 'FILLED') {
  emit({ e: 'ORDER_TRADE_UPDATE', o: { s: symbol, S: side, X: status, z: String(qty), ap: String(price) } });
  emit({ e: 'ACCOUNT_UPDATE', a: { P: [{ s: symbol }] } });
}

/* ------------------------------------------------------------- helpers */

const acct = () => state.acct;
const nextId = () => acct().nextId++;
const fail = (code, msg) => new BinanceError({ status: 400, code, msg });

function finish(order, status) {
  order.status = status;
  order.updateTime = Date.now();
  acct().orders = acct().orders.filter((o) => o !== order);
  acct().done.push(order);
  if (acct().done.length > E.DONE_MAX) acct().done.splice(0, acct().done.length - E.DONE_MAX);
}

function reasonFor(clientOrderId, fallback = 'manual') {
  const id = String(clientOrderId || '');
  if (id.startsWith('sc_rev')) return 'reverse';
  if (id.startsWith('sc_close')) return 'close';
  return fallback;
}

function rulesFor(symbol) {
  const s = (state.info && state.info.symbols || []).find((x) => x.symbol === symbol);
  return s ? rules.parseSymbolRules(s) : null;
}

/** Snap a fill quantity to the symbol's step, so positions stay on the grid. */
function stepQty(symbol, qty) {
  const r = rulesFor(symbol);
  return r ? Number(rules.roundQty(qty, r)) : qty;
}

/* ---------------------------------------------------------- the client */

/**
 * The FuturesClient surface the trading service uses. Async throughout, so
 * the service cannot tell the difference.
 */
const client = {
  env: 'paper',
  wsBase: '',

  async exchangeInfo() {
    if (!state.info || Date.now() - state.infoAt > 3600e3) {
      state.info = await get('/fapi/v1/exchangeInfo');
      state.infoAt = Date.now();
    }
    return state.info;
  },

  async lastPrice(symbol) {
    const { price } = await get('/fapi/v1/ticker/price', { symbol });
    return Number(price);
  },

  async markPrice(symbol) {
    return (await premium(symbol)).mark;
  },

  async positionMode() {
    return { dualSidePosition: false };
  },

  async setOneWayMode() {
    return { code: 200 };
  },

  async account() {
    const v = E.accountView(acct(), state.marks);
    return {
      totalWalletBalance: String(v.wallet),
      availableBalance: String(v.available),
      totalMarginBalance: String(v.equity),
      totalUnrealizedProfit: String(v.upnl),
      positions: v.positions.map((p) => ({ symbol: p.symbol, maintMargin: String(p.maintMargin), unrealizedProfit: String(p.upnl) })),
    };
  },

  async positionRisk(symbol) {
    if (!state.marks[symbol] && acct().positions[symbol]) await premium(symbol).catch(() => {});
    const v = E.accountView(acct(), state.marks);
    const p = v.positions.find((x) => x.symbol === symbol);
    if (!p) return [];
    const others = v.positions.filter((x) => x.symbol !== symbol);
    const liq = rules.estimateLiquidation({
      amt: p.amt,
      entry: p.entry,
      walletBalance: acct().wallet,
      otherMaint: others.reduce((s, x) => s + x.maintMargin, 0),
      otherUpnl: others.reduce((s, x) => s + x.upnl, 0),
      brackets: E.BRACKETS,
    });
    const trip = acct().trips[symbol];
    const s = Math.sign(p.amt);
    // What the price must reach to come out even after the fees paid so far
    // and the taker fee to close.
    const breakEven = p.entry + s * ((trip ? trip.fees : 0) / Math.abs(p.amt) + p.entry * acct().settings.takerFee);
    return [
      {
        symbol,
        positionAmt: String(p.amt),
        entryPrice: String(p.entry),
        breakEvenPrice: String(breakEven),
        markPrice: String(p.mark),
        unRealizedProfit: String(p.upnl),
        liquidationPrice: String(liq || 0),
        notional: String(p.amt * p.mark),
        initialMargin: String(p.initialMargin),
        maintMargin: String(p.maintMargin),
      },
    ];
  },

  async symbolConfig(symbol) {
    return [{ symbol, leverage: E.leverageOf(acct(), symbol), marginType: 'CROSSED' }];
  },

  async leverageBracket(symbol) {
    return [{ symbol, brackets: E.BRACKETS }];
  },

  async setMarginType() {
    return { code: 200, msg: 'success' };
  },

  async setLeverage(symbol, leverage) {
    const n = Math.round(Number(leverage));
    if (!(n >= 1 && n <= 125)) throw fail(-4028, 'Leverage is not valid');
    const pos = acct().positions[symbol];
    const notional = pos ? Math.abs(pos.amt) * (state.marks[symbol] || pos.entry) : 0;
    if (notional > rules.maxNotionalAt(E.BRACKETS, n)) throw fail(-2027, 'Exceeded the maximum allowable position at current leverage.');
    acct().leverage[symbol] = n;
    changed();
    return { symbol, leverage: n };
  },

  async openOrders(symbol) {
    return acct().orders.filter((o) => o.symbol === symbol).map(view);
  },

  async getOrder(symbol, orderId) {
    const o = [...acct().orders, ...acct().done].find((x) => x.symbol === symbol && String(x.orderId) === String(orderId));
    if (!o) throw fail(-2013, 'Order does not exist.');
    return view(o);
  },

  async newOrder(p) {
    const symbol = p.symbol;
    const side = p.side;
    const qty = Number(p.quantity);
    const reduceOnly = p.reduceOnly === 'true' || p.reduceOnly === true;
    if (!(qty > 0)) throw fail(-4003, 'Quantity less than or equal to zero.');
    const pos = acct().positions[symbol];
    const amt = pos ? pos.amt : 0;
    if (reduceOnly && (!amt || (side === 'BUY') === amt > 0 || qty > Math.abs(amt) + E.EPS)) {
      throw fail(-2022, 'ReduceOnly Order is rejected.');
    }
    const order = {
      orderId: String(nextId()),
      clientOrderId: p.newClientOrderId || '',
      symbol,
      side,
      type: p.type,
      price: p.type === 'LIMIT' ? String(p.price) : '0',
      origQty: String(qty),
      executedQty: '0',
      avgPrice: '0',
      reduceOnly,
      status: 'NEW',
      time: Date.now(),
    };
    const { mark } = await premium(symbol);
    const limit = Number(order.price);

    if (p.type === 'MARKET' || p.type === 'LIMIT') {
      const b = await book(symbol);
      const best = side === 'BUY' ? Number((b.asks[0] || [])[0]) : Number((b.bids[0] || [])[0]);
      const marketable = p.type === 'MARKET' || (best > 0 && (side === 'BUY' ? limit >= best : limit <= best));
      if (marketable) {
        let price = E.bookFill(side === 'BUY' ? b.asks : b.bids, qty);
        if (!(price > 0)) throw new BinanceError({ status: 0, msg: t('讀不到掛單簿，無法模擬成交') });
        // A marketable limit never fills worse than its price.
        if (p.type === 'LIMIT') price = side === 'BUY' ? Math.min(price, limit) : Math.max(price, limit);
        if (!reduceOnly && E.marginShortfall(acct(), { ...state.marks, [symbol]: mark }, { symbol, side, qty, price }) > 0) {
          throw fail(-2019, 'Margin is insufficient.');
        }
        E.applyFill(acct(), { symbol, side, qty, price, liquidity: 'taker', reason: reasonFor(order.clientOrderId), time: Date.now() });
        Object.assign(order, { executedQty: String(qty), avgPrice: String(price) });
        finish(order, 'FILLED');
        changed();
        emitFill(symbol, side, qty, price);
        return view(order);
      }
    }
    if (p.type !== 'LIMIT') throw fail(-1116, 'Invalid orderType.');
    if (!reduceOnly) {
      const probe = { ...order, executedQty: 0 };
      const need = E.openingMargin(acct(), probe);
      const avail = E.accountView(acct(), { ...state.marks, [symbol]: mark }).available;
      if (need > avail + E.EPS) throw fail(-2019, 'Margin is insufficient.');
    }
    acct().orders.push(order);
    changed();
    emit({ e: 'ORDER_TRADE_UPDATE', o: { s: symbol, S: side, X: 'NEW', z: '0', ap: '0' } });
    return view(order);
  },

  async cancelOrder(symbol, orderId) {
    const o = acct().orders.find((x) => x.symbol === symbol && String(x.orderId) === String(orderId));
    if (!o) throw fail(-2011, 'Unknown order sent.');
    finish(o, 'CANCELED');
    changed();
    emit({ e: 'ORDER_TRADE_UPDATE', o: { s: symbol, S: o.side, X: 'CANCELED', z: o.executedQty, ap: o.avgPrice } });
    return view(o);
  },

  async modifyOrder({ symbol, orderId, price }) {
    const o = acct().orders.find((x) => x.symbol === symbol && String(x.orderId) === String(orderId));
    if (!o) throw fail(-2011, 'Unknown order sent.');
    o.price = String(price);
    o.time = Date.now(); // back of the queue, as on Binance
    changed();
    emit({ e: 'ORDER_TRADE_UPDATE', o: { s: symbol, S: o.side, X: 'NEW', z: o.executedQty, ap: o.avgPrice } });
    return view(o);
  },

  async openAlgoOrders(symbol) {
    return acct().algos.filter((a) => a.symbol === symbol).map((a) => ({ ...a }));
  },

  async newAlgoOrder(p) {
    const symbol = p.symbol;
    const trigger = Number(p.triggerPrice);
    const { mark } = await premium(symbol);
    const algo = {
      algoId: String(nextId()),
      symbol,
      side: p.side,
      orderType: p.type,
      triggerPrice: String(p.triggerPrice),
      quantity: '0',
      closePosition: true,
      time: Date.now(),
    };
    if (triggered(algo, mark)) throw fail(-2021, 'Order would immediately trigger.');
    if (acct().algos.some((a) => a.symbol === symbol && a.side === algo.side && a.orderType === algo.orderType)) {
      throw fail(-4130, 'An open stop or take profit order with GTE and closePosition in the direction is existing.');
    }
    acct().algos.push(algo);
    changed();
    emit({ e: 'ALGO_UPDATE', o: { s: symbol, X: 'NEW', o: algo.orderType } });
    return { ...algo };
  },

  async cancelAlgoOrder(algoId) {
    const a = acct().algos.find((x) => String(x.algoId) === String(algoId));
    if (!a) throw fail(-2011, 'Unknown order sent.');
    acct().algos = acct().algos.filter((x) => x !== a);
    changed();
    emit({ e: 'ALGO_UPDATE', o: { s: a.symbol, X: 'CANCELED', o: a.orderType } });
    return { code: '200', msg: 'success' };
  },
};

function view(o) {
  return { ...o, orderId: o.orderId };
}

/** Would a close-position stop fire at this mark? */
function triggered(a, mark) {
  const t = Number(a.triggerPrice);
  const tp = a.orderType.startsWith('TAKE_PROFIT');
  // A SELL closes a long: its TP is above, its stop below. A BUY, mirrored.
  if (a.side === 'SELL') return tp ? mark >= t : mark <= t;
  return tp ? mark <= t : mark >= t;
}

/* ---------------------------------------------------------- the stream */

/** The UserStream surface: start/stop, events pushed as Binance would. */
function stream(handlers) {
  return {
    start() {
      state.listeners.add(handlers);
      handlers.onState('live');
      // A replay at startup ran before anyone was listening: say what it did now.
      if (state.replayNotes.length) {
        const notes = state.replayNotes.splice(0);
        setTimeout(() => notes.forEach((n) => emit(n)), 1500);
      }
    },
    stop() {
      state.listeners.delete(handlers);
      handlers.onState('off');
    },
  };
}

/* ------------------------------------------------------------ matching */

function activeSymbols() {
  const a = acct();
  return [...new Set([...Object.keys(a.positions), ...a.orders.map((o) => o.symbol), ...a.algos.map((x) => x.symbol)])];
}

async function tick() {
  if (state.ticking || !state.acct) return;
  state.ticking = true;
  try {
    const now = Date.now();
    if (now - acct().lastTick > GAP_MS && activeSymbols().length) {
      await catchUp();
      return;
    }
    for (const symbol of activeSymbols()) await tickSymbol(symbol, now);
    if (E.shouldLiquidate(acct(), state.marks)) liquidateNow(now);
    acct().lastTick = now;
  } catch (err) {
    // A failed fetch: the next tick tries again; a long outage is replayed.
    if (!/fetch failed|ECONN|ETIMEDOUT|ENOTFOUND/.test(String(err && err.message))) console.warn(`[paper] tick: ${err.message}`);
  } finally {
    state.ticking = false;
  }
}

function liquidateNow(time) {
  const symbols = Object.keys(acct().positions);
  E.liquidate(acct(), state.marks, time);
  changed();
  emit({ e: 'PAPER_NOTICE', level: 'error', text: t('模擬帳戶保證金不足，{symbols} 已被強制平倉', { symbols: symbols.join(t('、')) }) });
  for (const s of symbols) emit({ e: 'ACCOUNT_UPDATE', a: { P: [{ s }] } });
}

async function tickSymbol(symbol, now) {
  const p = await premium(symbol);
  const a = acct();

  // Funding: the rate Binance showed before the funding time is the one settled.
  const f = state.funding[symbol];
  if (f && now >= f.next && a.positions[symbol]) {
    E.applyFunding(a, { symbol, rate: f.rate, mark: p.mark, time: f.next });
    changed();
  }
  if (p.next > 0) state.funding[symbol] = { next: p.next, rate: p.rate };

  // TP/SL on the mark. Stops first if both somehow qualify.
  const rank = (x) => (x.orderType.startsWith('STOP') ? 0 : 1);
  const due = a.algos.filter((x) => x.symbol === symbol && triggered(x, p.mark)).sort((x, y) => rank(x) - rank(y));
  for (const algo of due) await fireAlgo(algo, null, now);

  // Limit orders: filled only by trades printing through their price.
  const orders = a.orders.filter((o) => o.symbol === symbol);
  if (orders.length) {
    const since = state.lastTradeTime[symbol] || Math.min(...orders.map((o) => o.time));
    const trades = await get('/fapi/v1/aggTrades', { symbol, startTime: Math.max(since, now - 3500e3), endTime: now, limit: 1000 });
    if (Array.isArray(trades) && trades.length) {
      state.lastTradeTime[symbol] = Number(trades[trades.length - 1].T) + 1;
      for (const o of orders) {
        // An order only sees trades after it was placed (or last re-priced).
        let lo = Infinity;
        let hi = -Infinity;
        for (const t of trades) {
          if (Number(t.T) < Math.max(since, o.time)) continue;
          const px = Number(t.p);
          if (px < lo) lo = px;
          if (px > hi) hi = px;
        }
        if (lo <= hi) crossLimit(o, lo, hi, now);
      }
    } else {
      state.lastTradeTime[symbol] = now;
    }
  } else {
    delete state.lastTradeTime[symbol];
  }
}

/** A limit order and the range trades printed over: fill it if they went through. */
function crossLimit(o, lo, hi, time) {
  if (!acct().orders.includes(o)) return false;
  const px = Number(o.price);
  const hit = o.side === 'BUY' ? lo < px : hi > px;
  if (!hit) return false;
  const pos = acct().positions[o.symbol];
  let qty = Number(o.origQty) - Number(o.executedQty);
  if (o.reduceOnly) {
    const amt = pos ? pos.amt : 0;
    const closes = amt && (o.side === 'BUY') === amt < 0;
    if (!closes) {
      finish(o, 'EXPIRED');
      changed();
      return false;
    }
    qty = Math.min(qty, Math.abs(amt));
  }
  qty = stepQty(o.symbol, qty);
  if (!(qty > 0)) return false;
  E.applyFill(acct(), { symbol: o.symbol, side: o.side, qty, price: px, liquidity: 'maker', reason: reasonFor(o.clientOrderId, 'limit'), time });
  Object.assign(o, { executedQty: String(Number(o.executedQty) + qty), avgPrice: o.price });
  finish(o, 'FILLED');
  changed();
  emitFill(o.symbol, o.side, qty, px);
  return true;
}

/**
 * A TP/SL fires: close the whole position, taking liquidity. Live, at the
 * book; replayed, at `atPrice` (the trigger, or the candle's open if it
 * gapped through it).
 */
async function fireAlgo(algo, atPrice, time) {
  const a = acct();
  if (!a.algos.includes(algo)) return;
  a.algos = a.algos.filter((x) => x !== algo);
  const pos = a.positions[algo.symbol];
  const closes = pos && (algo.side === 'SELL') === pos.amt > 0;
  const kind = algo.orderType.startsWith('TAKE_PROFIT') ? 'tp' : 'sl';
  if (!closes) {
    // Nothing for it to close: it expires, as a close-position order does.
    changed();
    emit({ e: 'ALGO_UPDATE', o: { s: algo.symbol, X: 'EXPIRED', o: algo.orderType } });
    return;
  }
  const qty = Math.abs(pos.amt);
  let price = atPrice;
  if (!(price > 0)) {
    try {
      price = (await takerPrice(algo.symbol, algo.side, qty)).price;
    } catch {
      price = state.marks[algo.symbol];
    }
  }
  if (!a.positions[algo.symbol]) return; // closed while the book was fetched
  E.applyFill(a, { symbol: algo.symbol, side: algo.side, qty: Math.abs(a.positions[algo.symbol].amt), price, liquidity: 'taker', reason: kind, time });
  changed();
  emit({ e: 'ALGO_UPDATE', o: { s: algo.symbol, X: 'TRIGGERED', o: algo.orderType } });
  emitFill(algo.symbol, algo.side, qty, price);
}

/* --------------------------------------------------------------- replay */

async function klines(symbol, from, to) {
  const out = [];
  let start = from;
  while (start < to && out.length < 50000) {
    const rows = await get('/fapi/v1/klines', { symbol, interval: '1m', startTime: start, endTime: to, limit: 1500 });
    if (!Array.isArray(rows) || !rows.length) break;
    for (const r of rows) out.push({ symbol, t: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]) });
    const last = Number(rows[rows.length - 1][0]);
    if (rows.length < 1500) break;
    start = last + 60e3;
  }
  return out;
}

async function fundingHistory(symbol, from, to) {
  const rows = await get('/fapi/v1/fundingRate', { symbol, startTime: from, endTime: to, limit: 1000 });
  return (Array.isArray(rows) ? rows : []).map((r) => ({ symbol, t: Number(r.fundingTime), rate: Number(r.fundingRate), mark: Number(r.markPrice) }));
}

/**
 * Replay the market from the last tick to now: one-minute candles and the
 * funding settlements of every symbol with something open, in time order.
 */
async function catchUp() {
  const a = acct();
  const now = Date.now();
  const from = Math.max(a.lastTick, now - REPLAY_MAX_MS);
  const symbols = activeSymbols();
  if (!symbols.length || now - from < GAP_MS) {
    a.lastTick = now;
    return;
  }
  console.log(`[paper] replaying ${Math.round((now - from) / 60e3)} min for ${symbols.join(', ')}`);
  const events = [];
  for (const s of symbols) {
    try {
      // The candle the gap starts in is partly before it: start at the next one.
      const candles = await klines(s, Math.ceil(from / 60e3) * 60e3, now);
      for (const c of candles) if (c.t + 60e3 <= now) events.push({ kind: 'candle', t: c.t, c });
      for (const f of await fundingHistory(s, from + 1, now)) events.push({ kind: 'funding', t: f.t, f });
    } catch (err) {
      console.warn(`[paper] replay ${s} failed: ${err.message}`);
    }
  }
  // Funding at a minute's start settles before that minute trades.
  events.sort((x, y) => x.t - y.t || (x.kind === 'funding' ? -1 : 1));
  let changedAny = false;
  const historyBefore = a.history.length;
  const walletBefore = a.wallet;
  for (const ev of events) {
    if (ev.kind === 'funding') {
      if (a.positions[ev.f.symbol]) {
        E.applyFunding(a, { symbol: ev.f.symbol, rate: ev.f.rate, mark: ev.f.mark || state.marks[ev.f.symbol], time: ev.t });
        changedAny = true;
      }
      continue;
    }
    if (replayCandle(ev.c)) changedAny = true;
  }
  a.lastTick = now;
  if (changedAny) {
    changed();
    console.log('[paper] replay changed the account');
    const closed = a.history.slice(historyBefore);
    const names = { tp: t('止盈'), sl: t('止損'), limit: t('限價'), liquidation: t('強平'), reverse: t('反手') };
    const what = closed.map((h) => [h.symbol, names[h.reason] || t('平倉'), (h.net >= 0 ? '+' : '') + h.net.toFixed(2)].join(' '));
    const diff = a.wallet - walletBefore;
    const note = {
      e: 'PAPER_NOTICE',
      level: closed.some((h) => h.reason === 'liquidation') ? 'error' : 'warn',
      text: t('程式關閉期間的行情已補算：{what}，資金 {diff} USDT', {
        what: what.length ? what.join(t('、')) : t('限價成交或資金費'),
        diff: `${diff >= 0 ? '+' : ''}${diff.toFixed(2)}`,
      }),
    };
    if (state.listeners.size) emit(note);
    else state.replayNotes.push(note);
  } else save();
}

/** One minute of one symbol, pessimistically: stops, then limit fills, then targets. */
function replayCandle(c) {
  const a = acct();
  const t = c.t + 59e3;
  let did = false;
  const fillAt = (algo) => {
    const trig = Number(algo.triggerPrice);
    // Gapped through the trigger at the open: the open is the price there was.
    if (algo.side === 'SELL') return algo.orderType.startsWith('STOP') ? Math.min(trig, c.o) : Math.max(trig, c.o);
    return algo.orderType.startsWith('STOP') ? Math.max(trig, c.o) : Math.min(trig, c.o);
  };
  const reach = (algo) => (triggered(algo, c.l) || triggered(algo, c.h));
  const stops = a.algos.filter((x) => x.symbol === c.symbol && x.orderType.startsWith('STOP') && reach(x));
  for (const s of stops) {
    fireAlgoSync(s, fillAt(s), t);
    did = true;
  }
  for (const o of a.orders.filter((x) => x.symbol === c.symbol && x.time <= c.t)) {
    if (crossLimit(o, c.l, c.h, t)) did = true;
  }
  // A stop the fills just armed (or one still there) can still fire this minute.
  const pos = a.positions[c.symbol];
  if (pos) {
    state.marks[c.symbol] = pos.amt > 0 ? c.l : c.h;
    if (E.shouldLiquidate(a, state.marks)) {
      liquidateNow(t);
      return true;
    }
  }
  const targets = a.algos.filter((x) => x.symbol === c.symbol && x.orderType.startsWith('TAKE_PROFIT') && reach(x));
  for (const s of targets) {
    fireAlgoSync(s, fillAt(s), t);
    did = true;
  }
  state.marks[c.symbol] = c.c;
  return did;
}

function fireAlgoSync(algo, price, time) {
  const a = acct();
  a.algos = a.algos.filter((x) => x !== algo);
  const pos = a.positions[algo.symbol];
  if (!pos || (algo.side === 'SELL') !== pos.amt > 0) return;
  E.applyFill(a, {
    symbol: algo.symbol,
    side: algo.side,
    qty: Math.abs(pos.amt),
    price,
    liquidity: 'taker',
    reason: algo.orderType.startsWith('TAKE_PROFIT') ? 'tp' : 'sl',
    time,
  });
}

/* ------------------------------------------------------------- the UI */

function summary() {
  const a = acct();
  return {
    capital: a.capital,
    settings: { ...a.settings },
    createdAt: a.createdAt,
    stats: E.stats(a, state.marks),
  };
}

/**
 * Ledger notes are stored in Chinese (paper-engine.js writes them, and saved
 * accounts already hold them); they are shown in the interface language.
 * Reason codes such as 'manual' pass through for the journal to name.
 */
function noteText(note) {
  switch (note) {
    case '初始資金': // i18n-ignore
      return t('初始資金');
    case '強平清算費': // i18n-ignore
      return t('強平清算費');
    case '穿倉由保險基金補足': // i18n-ignore
      return t('穿倉由保險基金補足');
    default: {
      const m = /^費率 (\S+)%$/.exec(note || ''); // i18n-ignore
      return m ? t('費率 {rate}%', { rate: m[1] }) : note;
    }
  }
}

function journal({ history = 2000, ledger = 5000 } = {}) {
  const a = acct();
  return {
    ...summary(),
    history: a.history.slice(-history).reverse(),
    ledger: a.ledger
      .slice(-ledger)
      .reverse()
      .map((e) => (e.note ? { ...e, note: noteText(e.note) } : e)),
    open: E.accountView(a, state.marks).positions.map((p) => ({ ...p, trip: a.trips[p.symbol] || null })),
  };
}

/**
 * Start over with `capital`: a new account, empty history. The old file is
 * kept beside it (paper-account-<time>.json) -- a reset should not be the
 * only copy of weeks of results.
 */
function reset(capital, settings) {
  const cap = Number(capital);
  if (!(cap >= 10 && cap <= 1e9)) throw new Error(t('初始資金要在 10 到 1,000,000,000 USDT 之間'));
  if (state.file && fs.existsSync(state.file)) {
    flush();
    try {
      fs.copyFileSync(state.file, state.file.replace(/\.json$/, `-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
    } catch {
      /* best effort */
    }
  }
  state.acct = E.newAccount(cap, settings || acct().settings);
  state.funding = {};
  state.lastTradeTime = {};
  changed();
  for (const l of state.listeners) l.onEvent({ e: 'ACCOUNT_UPDATE', a: { P: [] } });
  return summary();
}

function setFees({ makerFee, takerFee }) {
  Object.assign(acct().settings, E.pickSettings({ makerFee, takerFee }));
  changed();
  return summary();
}

/** CSV of the closed positions, for a spreadsheet. */
function historyCsv() {
  const rows = [
    [
      t('平倉時間'),
      t('開倉時間'),
      t('幣種'),
      t('方向'),
      t('數量'),
      t('槓桿'),
      t('開倉均價'),
      t('平倉均價'),
      t('價差損益'),
      t('手續費'),
      t('資金費'),
      t('淨損益'),
      'ROE%',
      t('平倉原因'),
    ],
  ];
  const iso = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
  for (const h of acct().history.slice().reverse()) {
    rows.push([iso(h.closedAt), iso(h.openedAt), h.symbol, h.side === 'LONG' ? t('多') : t('空'), h.qty, h.leverage, h.entry, h.exit, h.realized, h.fees, h.funding, h.net, h.roe, h.reason]);
  }
  return '﻿' + rows.map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(',')).join('\r\n');
}

module.exports = {
  init,
  shutdown,
  flush,
  client,
  stream,
  onChange,
  summary,
  journal,
  reset,
  setFees,
  historyCsv,
  DEFAULT_CAPITAL,
  _state: state,
  _tick: tick,
  _catchUp: catchUp,
};
