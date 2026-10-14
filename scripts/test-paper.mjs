import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../main/trading/paper-engine.js');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); console.log('  ok   ' + name); pass++; } catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; } };
const near = (a, b, msg, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${msg || ''} expected ${b}, got ${a}`);
const T0 = 1_760_000_000_000;

t('a new account holds its capital, recorded as a deposit', () => {
  const a = P.newAccount(1000, {}, T0);
  assert.equal(a.wallet, 1000);
  assert.equal(a.ledger[0].type, 'DEPOSIT');
  assert.throws(() => P.newAccount(0));
});

t('open and close a long: gross PnL, both fees, one trip in the history', () => {
  const a = P.newAccount(1000, {}, T0);
  P.applyFill(a, { symbol: 'BTCUSDT', side: 'BUY', qty: 0.01, price: 80000, liquidity: 'taker', time: T0 });
  near(a.wallet, 1000 - 800 * 0.0005, 'taker fee on open');
  P.applyFill(a, { symbol: 'BTCUSDT', side: 'SELL', qty: 0.01, price: 81000, liquidity: 'maker', reason: 'limit', time: T0 + 60000 });
  // +10 gross, fees 0.4 + 0.162
  near(a.wallet, 1000 + 10 - 0.4 - 0.162);
  assert.equal(a.positions.BTCUSDT, undefined);
  assert.equal(a.history.length, 1);
  const h = a.history[0];
  assert.equal(h.side, 'LONG');
  near(h.entry, 80000);
  near(h.exit, 81000);
  near(h.realized, 10);
  near(h.fees, 0.562);
  near(h.net, 9.438);
  assert.equal(h.reason, 'limit');
  near(h.roe, (9.438 / (800 / 20)) * 100, 'ROE on the margin at 20x');
});

t('adding averages the entry; a partial close realizes against it', () => {
  const a = P.newAccount(1000, { makerFee: 0, takerFee: 0 }, T0);
  P.applyFill(a, { symbol: 'X', side: 'SELL', qty: 1, price: 100, time: T0 });
  P.applyFill(a, { symbol: 'X', side: 'SELL', qty: 1, price: 110, time: T0 });
  near(a.positions.X.entry, 105);
  assert.equal(a.positions.X.amt, -2);
  const r = P.applyFill(a, { symbol: 'X', side: 'BUY', qty: 1, price: 95, time: T0 });
  near(r.realized, 10, 'short from 105 covered at 95');
  assert.equal(a.history.length, 0, 'still open');
  near(a.positions.X.entry, 105, 'reducing keeps the entry');
});

t('going through zero closes one trip and starts the next at the fill price', () => {
  const a = P.newAccount(1000, { makerFee: 0, takerFee: 0.001 }, T0);
  P.applyFill(a, { symbol: 'X', side: 'BUY', qty: 1, price: 100, time: T0 });
  P.applyFill(a, { symbol: 'X', side: 'SELL', qty: 2, price: 90, reason: 'reverse', time: T0 + 1 });
  assert.equal(a.history.length, 1);
  near(a.history[0].realized, -10);
  near(a.history[0].fees, 0.1 + 0.09, 'open fee + its half of the reversal fee');
  assert.equal(a.history[0].reason, 'reverse');
  assert.equal(a.positions.X.amt, -1);
  near(a.positions.X.entry, 90);
  near(a.trips.X.fees, 0.09, 'the other half belongs to the new short');
  assert.equal(a.trips.X.side, 'SHORT');
});

t('funding: a long pays a positive rate, a short receives it, and the trip carries it', () => {
  const a = P.newAccount(1000, { makerFee: 0, takerFee: 0 }, T0);
  P.applyFill(a, { symbol: 'X', side: 'BUY', qty: 2, price: 100, time: T0 });
  near(P.applyFunding(a, { symbol: 'X', rate: 0.0001, mark: 100, time: T0 }), -0.02);
  P.applyFill(a, { symbol: 'X', side: 'SELL', qty: 4, price: 100, time: T0 });
  near(P.applyFunding(a, { symbol: 'X', rate: 0.0001, mark: 100, time: T0 }), 0.02);
  near(a.history[0].funding, -0.02);
  near(a.history[0].net, -0.02);
  assert.equal(P.applyFunding(a, { symbol: 'NONE', rate: 0.01, mark: 1 }), 0, 'no position, no funding');
});

t('available balance takes out position margin, open-order margin and losses', () => {
  const a = P.newAccount(1000, { makerFee: 0, takerFee: 0 }, T0);
  a.leverage.X = 10;
  P.applyFill(a, { symbol: 'X', side: 'BUY', qty: 10, price: 100, time: T0 }); // 1000 notional, 100 margin
  a.orders.push({ symbol: 'X', side: 'BUY', price: 90, origQty: 10, executedQty: 0, reduceOnly: false });
  a.orders.push({ symbol: 'X', side: 'SELL', price: 120, origQty: 5, executedQty: 0, reduceOnly: false });
  const v = P.accountView(a, { X: 95 });
  near(v.upnl, -50);
  near(v.initialMargin, 95);
  near(v.orderMargin, 90, 'the buy opens more; the sell only reduces');
  near(v.available, 1000 - 50 - 95 - 90);
});

t('an order larger than the available margin falls short by the difference', () => {
  const a = P.newAccount(100, { makerFee: 0, takerFee: 0 }, T0);
  a.leverage.X = 10;
  assert.equal(P.marginShortfall(a, {}, { symbol: 'X', side: 'BUY', qty: 10, price: 100 }), 0, '1000 at 10x is 100');
  near(P.marginShortfall(a, {}, { symbol: 'X', side: 'BUY', qty: 11, price: 100 }), 10);
});

t('cross-margin liquidation closes at the mark, charges the clearance, never below zero', () => {
  const a = P.newAccount(100, { makerFee: 0, takerFee: 0 }, T0);
  a.leverage.X = 50;
  P.applyFill(a, { symbol: 'X', side: 'BUY', qty: 50, price: 100, time: T0 }); // 5000 notional
  assert.ok(!P.shouldLiquidate(a, { X: 99 }), '-50 of 100 is not enough');
  assert.ok(P.shouldLiquidate(a, { X: 98.1 }), 'equity 5 under maintenance 19.6');
  P.liquidate(a, { X: 98.1 }, T0 + 1);
  assert.equal(Object.keys(a.positions).length, 0);
  assert.equal(a.history[0].reason, 'liquidation');
  assert.ok(a.wallet >= 0);
  assert.ok(a.ledger.some((e) => e.type === 'LIQUIDATION_FEE'));
});

t('a book fill walks the levels, and past the book fills at its last price', () => {
  near(P.bookFill([[100, 1], [101, 1], [102, 5]], 3), (100 + 101 + 102) / 3);
  near(P.bookFill([[100, 1]], 2), 100);
  assert.equal(P.bookFill([], 1), null);
});

t('brackets are continuous: maintenance does not jump at a tier edge', () => {
  for (const b of P.BRACKETS.slice(1)) {
    const below = P.maintenanceMargin(b.notionalFloor - 1e-6);
    const at = P.maintenanceMargin(b.notionalFloor);
    near(below, at, `at ${b.notionalFloor}`, 1e-3);
  }
});

t('stats: return, hit rate, profit factor, fees, funding and drawdown', () => {
  const a = P.newAccount(1000, { makerFee: 0, takerFee: 0.001 }, T0);
  const trip = (side, open, close, i) => {
    P.applyFill(a, { symbol: 'X', side, qty: 1, price: open, time: T0 + i * 10 });
    P.applyFill(a, { symbol: 'X', side: side === 'BUY' ? 'SELL' : 'BUY', qty: 1, price: close, time: T0 + i * 10 + 5 });
  };
  trip('BUY', 100, 120, 0); // +20 - 0.22
  trip('SELL', 100, 110, 1); // -10 - 0.21
  trip('BUY', 100, 105, 2); // +5 - 0.205
  const s = P.stats(a);
  assert.equal(s.trades, 3);
  assert.equal(s.wins, 2);
  near(s.winRate, 200 / 3);
  near(s.fees, 0.635);
  near(s.net, 15 - 0.635);
  near(s.returnPct, ((15 - 0.635) / 1000) * 100);
  near(s.profitFactor, (19.78 + 4.795) / 10.21);
  near(s.maxDrawdown, 10.21 + 0.1, 'from the peak after trip 1 (incl. trip 2 open fee) down to after trip 2', 1e-6);
  assert.equal(s.long.count, 2);
  assert.equal(s.short.count, 1);
});

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
