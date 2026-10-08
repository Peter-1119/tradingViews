'use strict';

/**
 * Pure order arithmetic for USDⓈ-M perpetuals: request signing, the
 * exchange's price/quantity filters, and the estimates the order ticket shows
 * before anything is sent. No I/O here, so all of it is unit-tested
 * (scripts/test-trading.mjs).
 *
 * Numbers that go to the exchange are produced as *strings* at the filter's
 * own precision. Binance rejects "0.30000000000000004" for a 0.1 step, and
 * `toFixed` on a float is where that noise would otherwise sneak in.
 */

const crypto = require('crypto');

/* ---------------------------------------------------------------- signing */

/** application/x-www-form-urlencoded, in insertion order, skipping empty values. */
function encodeParams(params) {
  const parts = [];
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.join('&');
}

/** HMAC-SHA256 of the exact query string, hex -- Binance's SIGNED scheme. */
function sign(query, secret) {
  return crypto.createHmac('sha256', secret).update(query).digest('hex');
}

/* ---------------------------------------------------------------- filters */

/** Decimal places a step like "0.00100000" allows: 3. */
function decimalsOf(step) {
  const s = String(step);
  if (/e-/i.test(s)) return Number(s.split(/e-/i)[1]) || 0;
  const dot = s.indexOf('.');
  if (dot < 0) return 0;
  return s.slice(dot + 1).replace(/0+$/, '').length;
}

/** The per-symbol filters that matter for placing an order, from exchangeInfo. */
function parseSymbolRules(info) {
  if (!info || !Array.isArray(info.filters)) return null;
  const f = Object.fromEntries(info.filters.map((x) => [x.filterType, x]));
  const price = f.PRICE_FILTER || {};
  const lot = f.LOT_SIZE || {};
  const marketLot = f.MARKET_LOT_SIZE || lot;
  const notional = f.MIN_NOTIONAL || {};
  const tickSize = String(price.tickSize || '0.01');
  const stepSize = String(lot.stepSize || '0.001');
  const marketStepSize = String(marketLot.stepSize || stepSize);
  return {
    symbol: info.symbol,
    tickSize,
    priceDecimals: decimalsOf(tickSize),
    minPrice: Number(price.minPrice) || 0,
    maxPrice: Number(price.maxPrice) || Infinity,
    stepSize,
    qtyDecimals: decimalsOf(stepSize),
    minQty: Number(lot.minQty) || 0,
    maxQty: Number(lot.maxQty) || Infinity,
    marketStepSize,
    marketQtyDecimals: decimalsOf(marketStepSize),
    marketMinQty: Number(marketLot.minQty) || Number(lot.minQty) || 0,
    marketMaxQty: Number(marketLot.maxQty) || Number(lot.maxQty) || Infinity,
    minNotional: Number(notional.notional) || 0,
    baseAsset: info.baseAsset,
    quoteAsset: info.quoteAsset,
  };
}

/**
 * Snap to a multiple of `step`, as a string at the step's precision.
 * Works in integer step-units so 84213.35 on a 0.1 tick is exact, not
 * 84213.30000000001.
 */
function snap(value, step, decimals, mode = 'round') {
  const s = Number(step);
  if (!Number.isFinite(value) || !(s > 0)) return null;
  const units = value / s;
  // A hair of tolerance so 0.3/0.1 = 2.9999999999999996 still floors to 3.
  const n = mode === 'floor' ? Math.floor(units + 1e-9) : mode === 'ceil' ? Math.ceil(units - 1e-9) : Math.round(units);
  return (n * s).toFixed(decimals);
}

const roundPrice = (price, rules, mode = 'round') => snap(price, rules.tickSize, rules.priceDecimals, mode);

/** Quantity is always floored: rounding up would spend more than was asked for. */
function roundQty(qty, rules, { market = false } = {}) {
  return market
    ? snap(qty, rules.marketStepSize, rules.marketQtyDecimals, 'floor')
    : snap(qty, rules.stepSize, rules.qtyDecimals, 'floor');
}

/**
 * Notional (USDT) -> contract quantity at `price`, floored to the step.
 * @returns {{qty: string, qtyNum: number, notional: number}|null}
 */
function quantityForNotional(notional, price, rules, { market = false } = {}) {
  if (!(notional > 0) || !(price > 0)) return null;
  const qty = roundQty(notional / price, rules, { market });
  if (qty === null) return null;
  const qtyNum = Number(qty);
  return { qty, qtyNum, notional: qtyNum * price };
}

/**
 * Everything wrong with an order, as user-facing messages; empty means sendable.
 * `refPrice` is the price notional is judged at: the limit price, or the
 * current price for a market order (which is what Binance checks against).
 */
function validateOrder({ side, type, price, qty, refPrice, tp, sl, markPrice }, rules) {
  const errors = [];
  const isBuy = side === 'BUY';
  const q = Number(qty);
  const market = type === 'MARKET';
  const minQty = market ? rules.marketMinQty : rules.minQty;
  const maxQty = market ? rules.marketMaxQty : rules.maxQty;
  if (!(q > 0)) errors.push('數量太小，四捨五入後是 0');
  else {
    if (q < minQty) errors.push(`數量低於最小下單量 ${minQty}`);
    if (q > maxQty) errors.push(`數量超過單筆上限 ${maxQty}`);
    if (rules.minNotional && q * refPrice < rules.minNotional - 1e-9) {
      errors.push(`名目價值至少 ${rules.minNotional} USDT`);
    }
  }
  if (!market) {
    const p = Number(price);
    if (!(p > 0)) errors.push('請輸入限價');
    else if (p < rules.minPrice || p > rules.maxPrice) errors.push('限價超出交易所允許範圍');
  }
  // Take-profit and stop-loss are judged against the entry, and the stop also
  // against the mark: a long's stop above the mark would trigger the instant
  // it is placed (Binance rejects it with -2021 anyway, but later and vaguer).
  const entry = market ? refPrice : Number(price);
  if (tp != null) {
    if (isBuy && !(tp > entry)) errors.push('做多的止盈價要高於進場價');
    if (!isBuy && !(tp < entry)) errors.push('做空的止盈價要低於進場價');
  }
  if (sl != null) {
    if (isBuy && !(sl < entry)) errors.push('做多的止損價要低於進場價');
    if (!isBuy && !(sl > entry)) errors.push('做空的止損價要高於進場價');
    if (markPrice > 0) {
      if (isBuy && !(sl < markPrice)) errors.push('止損價已經高於目前標記價格，會立刻觸發');
      if (!isBuy && !(sl > markPrice)) errors.push('止損價已經低於目前標記價格，會立刻觸發');
    }
  }
  return errors;
}

/* --------------------------------------------------------------- estimates */

/** The maintenance bracket a notional falls in. Brackets are [floor, cap). */
function bracketFor(brackets, notional) {
  if (!Array.isArray(brackets) || !brackets.length) return null;
  const sorted = [...brackets].sort((a, b) => a.notionalFloor - b.notionalFloor);
  for (const b of sorted) {
    if (notional >= b.notionalFloor && notional < b.notionalCap) return b;
  }
  return sorted[sorted.length - 1];
}

/**
 * The highest leverage a symbol allows at all: its first bracket's. Altcoins
 * stop far below BTC's 125x, which is why one global leverage cannot work.
 */
function maxLeverage(brackets) {
  if (!Array.isArray(brackets) || !brackets.length) return null;
  return Math.max(...brackets.map((b) => Number(b.initialLeverage) || 0)) || null;
}

/**
 * The largest position (notional, USDT) a leverage allows: the top cap of the
 * brackets that still permit it. Higher leverage, smaller ceiling -- 125x on
 * BTC holds only the first bracket.
 */
function maxNotionalAt(brackets, leverage) {
  if (!Array.isArray(brackets) || !brackets.length) return Infinity;
  const allowed = brackets.filter((b) => Number(b.initialLeverage) >= leverage);
  if (!allowed.length) return 0;
  return Math.max(...allowed.map((b) => Number(b.notionalCap) || 0));
}

/**
 * The net one-way position after an order fills: signed amount and entry.
 * Adding averages the entry; reducing keeps it; flipping starts a new one at
 * the order's price -- the same bookkeeping Binance does.
 */
function positionAfter(current, side, qty, price) {
  const curAmt = current ? Number(current.amt) || 0 : 0;
  const curEntry = current ? Number(current.entry) || 0 : 0;
  const delta = side === 'BUY' ? qty : -qty;
  const amt = curAmt + delta;
  if (Math.abs(amt) < 1e-12) return { amt: 0, entry: 0 };
  if (curAmt === 0 || Math.sign(curAmt) === Math.sign(delta)) {
    const entry = (Math.abs(curAmt) * curEntry + qty * price) / (Math.abs(curAmt) + qty);
    return { amt, entry };
  }
  if (Math.sign(amt) === Math.sign(curAmt)) return { amt, entry: curEntry };
  return { amt, entry: price };
}

/**
 * Cross-margin, one-way liquidation price for one symbol (Binance's formula):
 *
 *   LP = (WB - TMM1 + UPNL1 + cum - side*size*EP) / (size*MMR - side*size)
 *
 * WB is the wallet balance, TMM1/UPNL1 the maintenance margin and unrealized
 * PnL of *other* symbols, cum/MMR from the maintenance bracket. An estimate:
 * Binance re-picks the bracket at the liquidation notional and accounts for
 * fees, so it can differ by a little. Returns null when there is no price at
 * which this position would be liquidated.
 */
function estimateLiquidation({ amt, entry, walletBalance, otherMaint = 0, otherUpnl = 0, brackets }) {
  const size = Math.abs(amt);
  if (!(size > 0) || !(entry > 0)) return null;
  const sideSign = amt > 0 ? 1 : -1;
  const bracket = bracketFor(brackets, size * entry);
  const mmr = bracket ? Number(bracket.maintMarginRatio) : 0.004;
  const cum = bracket ? Number(bracket.cum) : 0;
  const lp = (walletBalance - otherMaint + otherUpnl + cum - sideSign * size * entry) / (size * mmr - sideSign * size);
  if (!Number.isFinite(lp) || lp <= 0) return null;
  return lp;
}

/** Unrealized PnL and ROE at a price, for a signed amount. */
function pnlAt({ amt, entry, leverage }, price) {
  if (!amt || !(entry > 0) || !(price > 0)) return null;
  const pnl = (price - entry) * amt;
  const margin = (Math.abs(amt) * entry) / (leverage || 1);
  return { pnl, roe: margin > 0 ? (pnl / margin) * 100 : 0 };
}

module.exports = {
  encodeParams,
  sign,
  decimalsOf,
  parseSymbolRules,
  roundPrice,
  roundQty,
  quantityForNotional,
  validateOrder,
  bracketFor,
  maxLeverage,
  maxNotionalAt,
  positionAfter,
  estimateLiquidation,
  pnlAt,
};
