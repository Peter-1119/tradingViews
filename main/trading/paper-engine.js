'use strict';

/**
 * The paper account's bookkeeping: pure functions over a plain object, no
 * I/O, so all of it is unit-tested (scripts/test-paper.mjs). paper.js owns
 * the market data, the clock and the file; this owns the money.
 *
 * One-way, cross margin, USDⓈ-M -- the same model as the real account:
 *
 *   - A fill nets into the symbol's position. Adding averages the entry;
 *     reducing realizes (price - entry) × qty × side; going through zero
 *     closes the position and opens the remainder the other way.
 *   - Every fill pays a fee on its notional: maker for a resting limit
 *     order, taker for everything that takes liquidity.
 *   - Funding moves -amt × mark × rate at each funding time: longs pay a
 *     positive rate, shorts receive it.
 *   - Cross margin: the whole wallet backs every position. When equity
 *     (wallet + unrealized) falls to the maintenance margin, everything is
 *     liquidated at the mark and the remaining maintenance margin is lost
 *     as the clearance fee. The wallet never goes below zero.
 *
 * A position's life from flat back to flat is a *trip*: what the history
 * shows -- side, size, average entry and exit, gross PnL, fees, funding, net.
 */

const EPS = 1e-9;

/** Binance's default (VIP 0) USDⓈ-M rates. */
const DEFAULT_SETTINGS = Object.freeze({ makerFee: 0.0002, takerFee: 0.0005 });
const DEFAULT_LEVERAGE = 20;
const HISTORY_MAX = 5000;
const LEDGER_MAX = 20000;
const DONE_MAX = 300;

/**
 * Leverage brackets, one table for every symbol: Binance's are per symbol and
 * only readable with a key, which the paper account does not have. Modelled
 * on BTCUSDT's; `cum` is derived so maintenance is continuous across tiers.
 */
const BRACKETS = (() => {
  const tiers = [
    [125, 0, 50e3, 0.004],
    [100, 50e3, 600e3, 0.005],
    [75, 600e3, 3e6, 0.0065],
    [50, 3e6, 12e6, 0.01],
    [25, 12e6, 70e6, 0.02],
    [20, 70e6, 100e6, 0.025],
    [10, 100e6, 230e6, 0.05],
    [5, 230e6, 480e6, 0.1],
    [4, 480e6, 600e6, 0.125],
    [3, 600e6, 800e6, 0.15],
    [2, 800e6, 1.2e9, 0.25],
    [1, 1.2e9, 1.8e9, 0.5],
  ];
  let cum = 0;
  return tiers.map(([lev, floor, cap, mmr], i) => {
    if (i > 0) cum += floor * (mmr - tiers[i - 1][3]);
    return { bracket: i + 1, initialLeverage: lev, notionalFloor: floor, notionalCap: cap, maintMarginRatio: mmr, cum };
  });
})();

const round = (x, d = 10) => Math.round(x * 10 ** d) / 10 ** d;
const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

function maintenanceMargin(notional) {
  const b = BRACKETS.find((x) => notional >= x.notionalFloor && notional < x.notionalCap) || BRACKETS[BRACKETS.length - 1];
  return Math.max(0, notional * b.maintMarginRatio - b.cum);
}

function newAccount(capital, settings = {}, now = Date.now()) {
  const cap = Number(capital);
  if (!(cap > 0)) throw new Error('初始資金要大於 0');
  const acct = {
    version: 1,
    capital: cap,
    wallet: cap,
    createdAt: now,
    settings: { ...DEFAULT_SETTINGS, ...pickSettings(settings) },
    positions: {},
    trips: {},
    leverage: {},
    orders: [],
    algos: [],
    done: [],
    history: [],
    ledger: [],
    nextId: 1,
    tripSeq: 1,
    lastTick: now,
  };
  ledger(acct, { time: now, type: 'DEPOSIT', symbol: '', amount: cap, note: '初始資金' });
  return acct;
}

function pickSettings(s) {
  const out = {};
  for (const k of ['makerFee', 'takerFee']) {
    const v = Number(s && s[k]);
    if (Number.isFinite(v) && v >= 0 && v < 0.01) out[k] = v;
  }
  return out;
}

function ledger(acct, entry) {
  acct.ledger.push({ ...entry, amount: round(entry.amount, 8), balance: round(acct.wallet, 8) });
  if (acct.ledger.length > LEDGER_MAX) acct.ledger.splice(0, acct.ledger.length - LEDGER_MAX);
}

function leverageOf(acct, symbol) {
  return acct.leverage[symbol] || DEFAULT_LEVERAGE;
}

function startTrip(acct, symbol, amt, time) {
  return {
    id: acct.tripSeq++,
    symbol,
    side: amt > 0 ? 'LONG' : 'SHORT',
    openedAt: time,
    leverage: leverageOf(acct, symbol),
    openQty: 0,
    openNotional: 0,
    closeQty: 0,
    closeNotional: 0,
    maxQty: 0,
    realized: 0,
    fees: 0,
    funding: 0,
    reason: '',
  };
}

function finishTrip(acct, trip, time) {
  const entry = trip.openQty > 0 ? trip.openNotional / trip.openQty : 0;
  const exit = trip.closeQty > 0 ? trip.closeNotional / trip.closeQty : 0;
  const margin = (trip.maxQty * entry) / (trip.leverage || 1);
  const net = trip.realized - trip.fees + trip.funding;
  acct.history.push({
    id: trip.id,
    symbol: trip.symbol,
    side: trip.side,
    qty: round(trip.maxQty, 8),
    entry: round(entry, 8),
    exit: round(exit, 8),
    leverage: trip.leverage,
    openedAt: trip.openedAt,
    closedAt: time,
    realized: round(trip.realized, 8),
    fees: round(trip.fees, 8),
    funding: round(trip.funding, 8),
    net: round(net, 8),
    roe: margin > 0 ? round((net / margin) * 100, 4) : 0,
    reason: trip.reason || 'manual',
  });
  if (acct.history.length > HISTORY_MAX) acct.history.splice(0, acct.history.length - HISTORY_MAX);
}

/**
 * One fill into the account.
 * @param {{symbol, side: 'BUY'|'SELL', qty, price, liquidity: 'maker'|'taker', reason?, time}} f
 * @returns {{realized, fee, amt}} the position's amount after it
 */
function applyFill(acct, { symbol, side, qty, price, liquidity = 'taker', reason = 'manual', time = Date.now() }) {
  const q = Number(qty);
  const px = Number(price);
  if (!(q > 0) || !(px > 0)) throw new Error('fill needs a quantity and a price');
  const rate = liquidity === 'maker' ? acct.settings.makerFee : acct.settings.takerFee;
  const fee = q * px * rate;
  const delta = side === 'BUY' ? q : -q;
  const pos = acct.positions[symbol] || { amt: 0, entry: 0 };
  let trip = acct.trips[symbol] || null;
  let realized = 0;

  if (pos.amt === 0 || sign(pos.amt) === sign(delta)) {
    // Opening or adding.
    if (!trip) trip = startTrip(acct, symbol, delta, time);
    pos.entry = (Math.abs(pos.amt) * pos.entry + q * px) / (Math.abs(pos.amt) + q);
    pos.amt = round(pos.amt + delta);
    trip.openQty += q;
    trip.openNotional += q * px;
    trip.maxQty = Math.max(trip.maxQty, Math.abs(pos.amt));
    trip.fees += fee;
  } else {
    // Reducing, closing, or going through zero.
    const closeQty = Math.min(q, Math.abs(pos.amt));
    const rest = round(q - closeQty);
    realized = (px - pos.entry) * closeQty * sign(pos.amt);
    if (!trip) trip = startTrip(acct, symbol, pos.amt, time); // a position from before trips were kept
    trip.closeQty += closeQty;
    trip.closeNotional += closeQty * px;
    trip.realized += realized;
    trip.fees += fee * (closeQty / q);
    trip.reason = reason;
    pos.amt = round(pos.amt + sign(delta) * closeQty);
    if (Math.abs(pos.amt) < EPS) {
      pos.amt = 0;
      finishTrip(acct, trip, time);
      trip = null;
    }
    if (rest > EPS) {
      trip = startTrip(acct, symbol, delta, time);
      pos.amt = round(sign(delta) * rest);
      pos.entry = px;
      trip.openQty = rest;
      trip.openNotional = rest * px;
      trip.maxQty = rest;
      trip.fees = fee * (rest / q);
    }
  }

  acct.wallet = round(acct.wallet + realized - fee, 8);
  if (realized) ledger(acct, { time, type: 'REALIZED_PNL', symbol, amount: realized, note: reason });
  ledger(acct, { time, type: 'COMMISSION', symbol, amount: -fee, note: liquidity === 'maker' ? 'Maker' : 'Taker' });

  if (pos.amt === 0) {
    delete acct.positions[symbol];
    delete acct.trips[symbol];
  } else {
    acct.positions[symbol] = pos;
    acct.trips[symbol] = trip;
  }
  return { realized, fee, amt: pos.amt };
}

/** Funding at one funding time: -amt × mark × rate, into the wallet and the trip. */
function applyFunding(acct, { symbol, rate, mark, time = Date.now() }) {
  const pos = acct.positions[symbol];
  if (!pos || !pos.amt || !Number.isFinite(rate) || !(mark > 0)) return 0;
  const amount = -pos.amt * mark * rate;
  acct.wallet = round(acct.wallet + amount, 8);
  if (acct.trips[symbol]) acct.trips[symbol].funding += amount;
  ledger(acct, { time, type: 'FUNDING_FEE', symbol, amount, note: `費率 ${(rate * 100).toFixed(4)}%` });
  return amount;
}

/**
 * The account at a set of mark prices: what Binance's /account would say.
 * `marks` maps symbol -> mark price; a symbol without one counts at its entry.
 */
function accountView(acct, marks = {}) {
  let upnl = 0;
  let im = 0;
  let mm = 0;
  const positions = [];
  for (const [symbol, pos] of Object.entries(acct.positions)) {
    const mark = marks[symbol] || pos.entry;
    const notional = Math.abs(pos.amt) * mark;
    const u = (mark - pos.entry) * pos.amt;
    const lev = leverageOf(acct, symbol);
    const maint = maintenanceMargin(notional);
    upnl += u;
    im += notional / lev;
    mm += maint;
    positions.push({ symbol, amt: pos.amt, entry: pos.entry, mark, notional, upnl: u, initialMargin: notional / lev, maintMargin: maint, leverage: lev });
  }
  const orderMargin = acct.orders.reduce((s, o) => s + openingMargin(acct, o), 0);
  const equity = acct.wallet + upnl;
  return {
    wallet: acct.wallet,
    upnl,
    equity,
    initialMargin: im,
    maintMargin: mm,
    orderMargin,
    available: Math.max(0, equity - im - orderMargin),
    positions,
  };
}

/** The part of a working order that would open or add, at its price, over leverage. */
function openingMargin(acct, o) {
  if (o.reduceOnly) return 0;
  const left = Number(o.origQty) - Number(o.executedQty || 0);
  const pos = acct.positions[o.symbol];
  const amt = pos ? pos.amt : 0;
  const delta = o.side === 'BUY' ? 1 : -1;
  const opening = amt === 0 || sign(amt) === delta ? left : Math.max(0, left - Math.abs(amt));
  return (opening * Number(o.price)) / leverageOf(acct, o.symbol);
}

/**
 * Margin a new order needs that is not there: zero if it fits. Checked the
 * way Binance does it in spirit -- the opening part's initial margin plus
 * its fee must come out of what is available.
 */
function marginShortfall(acct, marks, { symbol, side, qty, price, taker = true }) {
  const view = accountView(acct, marks);
  const pos = acct.positions[symbol];
  const amt = pos ? pos.amt : 0;
  const delta = side === 'BUY' ? 1 : -1;
  const opening = amt === 0 || sign(amt) === delta ? qty : Math.max(0, qty - Math.abs(amt));
  const need = (opening * price) / leverageOf(acct, symbol) + qty * price * (taker ? acct.settings.takerFee : acct.settings.makerFee);
  return Math.max(0, need - view.available);
}

/** Cross-margin liquidation: is equity at or under the maintenance margin? */
function shouldLiquidate(acct, marks) {
  const v = accountView(acct, marks);
  return v.positions.length > 0 && v.equity <= v.maintMargin;
}

/**
 * Close every position at its mark. The maintenance margin that is left is
 * the clearance fee, and the wallet bottoms out at zero.
 */
function liquidate(acct, marks, time = Date.now()) {
  const v = accountView(acct, marks);
  for (const p of v.positions) {
    applyFill(acct, { symbol: p.symbol, side: p.amt > 0 ? 'SELL' : 'BUY', qty: Math.abs(p.amt), price: p.mark, liquidity: 'taker', reason: 'liquidation', time });
    const last = acct.history[acct.history.length - 1];
    const clearance = Math.min(p.maintMargin, Math.max(0, acct.wallet));
    if (clearance > 0) {
      acct.wallet = round(acct.wallet - clearance, 8);
      ledger(acct, { time, type: 'LIQUIDATION_FEE', symbol: p.symbol, amount: -clearance, note: '強平清算費' });
      if (last && last.symbol === p.symbol) {
        last.fees = round(last.fees + clearance, 8);
        last.net = round(last.net - clearance, 8);
      }
    }
  }
  if (acct.wallet < 0) {
    ledger(acct, { time, type: 'INSURANCE', symbol: '', amount: -acct.wallet, note: '穿倉由保險基金補足' });
    acct.wallet = 0;
  }
  acct.orders = [];
  acct.algos = [];
}

/**
 * Average price for taking `qty` from one side of a book: [[price, qty], ...]
 * best first. Past the depth given, the rest fills at the last level.
 */
function bookFill(levels, qty) {
  let left = qty;
  let cost = 0;
  let last = null;
  for (const [p, q] of levels || []) {
    const price = Number(p);
    const take = Math.min(left, Number(q));
    cost += take * price;
    left -= take;
    last = price;
    if (left <= EPS) break;
  }
  if (last === null) return null;
  if (left > EPS) cost += left * last;
  return cost / qty;
}

/* ---------------------------------------------------------------- stats */

/**
 * Performance over the closed trips and the wallet's ledger: what a trader
 * wants to know about a strategy -- return, hit rate, how big wins are
 * against losses, what fees and funding cost, and the worst drawdown.
 */
function stats(acct, marks = {}) {
  const v = accountView(acct, marks);
  const trips = acct.history;
  const wins = trips.filter((t) => t.net > 0);
  const losses = trips.filter((t) => t.net <= 0);
  const sum = (list, k) => list.reduce((s, t) => s + t[k], 0);
  const grossWin = sum(wins, 'net');
  const grossLoss = -sum(losses, 'net');
  const totals = { fees: 0, funding: 0, realized: 0, liquidation: 0, deposits: 0 };
  for (const e of acct.ledger) {
    if (e.type === 'COMMISSION') totals.fees -= e.amount;
    else if (e.type === 'LIQUIDATION_FEE') totals.liquidation -= e.amount;
    else if (e.type === 'FUNDING_FEE') totals.funding += e.amount;
    else if (e.type === 'REALIZED_PNL') totals.realized += e.amount;
    else if (e.type === 'DEPOSIT') totals.deposits += e.amount;
  }
  // Drawdown on the wallet after each event: realized results, not marks.
  let peak = 0;
  let maxDd = 0;
  let maxDdPct = 0;
  for (const e of acct.ledger) {
    peak = Math.max(peak, e.balance);
    const dd = peak - e.balance;
    if (dd > maxDd) maxDd = dd;
    if (peak > 0 && dd / peak > maxDdPct) maxDdPct = dd / peak;
  }
  const held = trips.map((t) => t.closedAt - t.openedAt);
  const side = (s) => {
    const list = trips.filter((t) => t.side === s);
    return { count: list.length, wins: list.filter((t) => t.net > 0).length, net: sum(list, 'net') };
  };
  const net = acct.wallet - totals.deposits;
  return {
    capital: acct.capital,
    deposits: totals.deposits,
    wallet: acct.wallet,
    equity: v.equity,
    upnl: v.upnl,
    net,
    returnPct: totals.deposits > 0 ? (net / totals.deposits) * 100 : 0,
    realized: totals.realized,
    fees: totals.fees,
    funding: totals.funding,
    liquidationFees: totals.liquidation,
    trades: trips.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trips.length ? (wins.length / trips.length) * 100 : 0,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : wins.length ? Infinity : 0,
    expectancy: trips.length ? sum(trips, 'net') / trips.length : 0,
    best: trips.length ? Math.max(...trips.map((t) => t.net)) : 0,
    worst: trips.length ? Math.min(...trips.map((t) => t.net)) : 0,
    maxDrawdown: maxDd,
    maxDrawdownPct: maxDdPct * 100,
    avgHoldMs: held.length ? held.reduce((a, b) => a + b, 0) / held.length : 0,
    long: side('LONG'),
    short: side('SHORT'),
    since: acct.createdAt,
  };
}

module.exports = {
  EPS,
  DEFAULT_SETTINGS,
  DEFAULT_LEVERAGE,
  DONE_MAX,
  BRACKETS,
  maintenanceMargin,
  newAccount,
  pickSettings,
  leverageOf,
  applyFill,
  applyFunding,
  accountView,
  openingMargin,
  marginShortfall,
  shouldLiquidate,
  liquidate,
  bookFill,
  stats,
};
