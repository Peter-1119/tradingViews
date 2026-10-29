import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const r = require('../main/trading/rules.js');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); console.log('  ok   ' + name); pass++; } catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; } };

const BTC = r.parseSymbolRules({
  symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT',
  filters: [
    { filterType: 'PRICE_FILTER', tickSize: '0.10', minPrice: '261.10', maxPrice: '809484' },
    { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '1000' },
    { filterType: 'MARKET_LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '120' },
    { filterType: 'MIN_NOTIONAL', notional: '100' },
  ],
});

t('signature matches Binance\'s documented example', () => {
  const q = 'symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559';
  assert.equal(r.sign(q, 'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j'),
    'c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71');
});

t('params encode in order and skip empty values', () => {
  assert.equal(r.encodeParams({ symbol: 'BTCUSDT', price: undefined, qty: '0.010', reduceOnly: null, note: 'a b' }),
    'symbol=BTCUSDT&qty=0.010&note=a%20b');
});

t('decimals come from the step string', () => {
  assert.equal(r.decimalsOf('0.00100000'), 3);
  assert.equal(r.decimalsOf('1'), 0);
  assert.equal(r.decimalsOf('0.10'), 1);
  assert.equal(r.decimalsOf('1e-7'), 7);
});

t('prices snap to the tick exactly, as strings', () => {
  assert.equal(r.roundPrice(84213.35, BTC), '84213.4');
  assert.equal(r.roundPrice(84213.34, BTC), '84213.3');
  assert.equal(r.roundPrice(0.30000000000000004 * 100000, BTC), '30000.0');
});

t('quantity always floors, with float noise tolerated', () => {
  assert.equal(r.roundQty(0.0069999, BTC), '0.006');
  assert.equal(r.roundQty(0.3 / 0.1 * 0.001, BTC), '0.003');
});

t('notional converts to a floored quantity and the real notional', () => {
  const q = r.quantityForNotional(500, 84200, BTC);
  assert.equal(q.qty, '0.005');
  assert.ok(Math.abs(q.notional - 421) < 1e-6);
});

t('a quantity typed in coins floors to the step and is not re-derived from USDT', () => {
  const q = r.quantityOf(0.235, 2551.52, BTC);
  assert.equal(q.qty, '0.235');
  assert.ok(Math.abs(q.notional - 0.235 * 2551.52) < 1e-9);
  assert.equal(r.quantityOf(0.0069999, 84200, BTC).qty, '0.006');
  assert.equal(r.quantityOf(0, 84200, BTC), null);
});

t('validation: below min notional and zero quantity', () => {
  const e1 = r.validateOrder({ side: 'BUY', type: 'LIMIT', price: '84200.0', qty: '0.001', refPrice: 84200 }, BTC);
  assert.ok(e1.some((m) => m.includes('100 USDT')), e1.join());
  const e2 = r.validateOrder({ side: 'BUY', type: 'MARKET', qty: '0.000', refPrice: 84200 }, BTC);
  assert.ok(e2.some((m) => m.includes('0')), e2.join());
});

t('validation: TP/SL must sit on the right side of entry and mark', () => {
  const ok = r.validateOrder({ side: 'BUY', type: 'LIMIT', price: '84000.0', qty: '0.010', refPrice: 84000, tp: 86000, sl: 83000, markPrice: 84500 }, BTC);
  assert.deepEqual(ok, []);
  const bad = r.validateOrder({ side: 'BUY', type: 'LIMIT', price: '84000.0', qty: '0.010', refPrice: 84000, tp: 83000, sl: 85000, markPrice: 84500 }, BTC);
  assert.equal(bad.length, 3, bad.join(' | '));
  const short = r.validateOrder({ side: 'SELL', type: 'MARKET', qty: '0.010', refPrice: 84000, tp: 82000, sl: 85000, markPrice: 84000 }, BTC);
  assert.deepEqual(short, []);
});

t('position bookkeeping: add, reduce, flip', () => {
  assert.deepEqual(r.positionAfter(null, 'BUY', 0.1, 50000), { amt: 0.1, entry: 50000 });
  const add = r.positionAfter({ amt: 0.1, entry: 50000 }, 'BUY', 0.1, 52000);
  assert.ok(Math.abs(add.entry - 51000) < 1e-9);
  assert.deepEqual(r.positionAfter({ amt: 0.2, entry: 50000 }, 'SELL', 0.1, 60000), { amt: 0.1, entry: 50000 });
  const flip = r.positionAfter({ amt: 0.1, entry: 50000 }, 'SELL', 0.3, 60000);
  assert.ok(Math.abs(flip.amt + 0.2) < 1e-12 && flip.entry === 60000);
  assert.deepEqual(r.positionAfter({ amt: 0.1, entry: 50000 }, 'SELL', 0.1, 60000), { amt: 0, entry: 0 });
});

const BRACKETS = [
  { bracket: 1, notionalFloor: 0, notionalCap: 50000, maintMarginRatio: 0.004, cum: 0 },
  { bracket: 2, notionalFloor: 50000, notionalCap: 600000, maintMarginRatio: 0.005, cum: 50 },
];

t('cross liquidation: equity at LP equals maintenance margin', () => {
  const lp = r.estimateLiquidation({ amt: 0.1, entry: 50000, walletBalance: 1000, brackets: BRACKETS });
  assert.ok(Math.abs(lp - 40160.64) < 0.01, String(lp));
  const equity = 1000 + (lp - 50000) * 0.1;
  assert.ok(Math.abs(equity - 0.1 * lp * 0.004) < 1e-6);
  const short = r.estimateLiquidation({ amt: -0.1, entry: 50000, walletBalance: 1000, brackets: BRACKETS });
  const eqShort = 1000 + (short - 50000) * -0.1;
  assert.ok(Math.abs(eqShort - 0.1 * short * 0.004) < 1e-6, String(short));
});

t('cross liquidation: none when the balance covers the whole move', () => {
  assert.equal(r.estimateLiquidation({ amt: 0.01, entry: 50000, walletBalance: 10000, brackets: BRACKETS }), null);
});

t('bracket lookup uses [floor, cap)', () => {
  assert.equal(r.bracketFor(BRACKETS, 49999).bracket, 1);
  assert.equal(r.bracketFor(BRACKETS, 50000).bracket, 2);
  assert.equal(r.bracketFor(BRACKETS, 9e9).bracket, 2);
});

t('pnl and ROE', () => {
  const long = r.pnlAt({ amt: 0.1, entry: 50000, leverage: 10 }, 51000);
  assert.equal(long.pnl, 100);
  assert.equal(long.roe, 20);
  const short = r.pnlAt({ amt: -0.1, entry: 50000, leverage: 10 }, 51000);
  assert.equal(short.pnl, -100);
});

/* ---------------------------------------------------- self-generated keys */

const nodeCrypto = require('crypto');
const { makeSigner } = require('../main/trading/client.js');
const QUERY = 'symbol=BTCUSDT&side=BUY&type=MARKET&quantity=0.001&recvWindow=5000&timestamp=1790000000000';

for (const type of ['ed25519', 'rsa']) {
  t(`${type} signatures verify against the public key, URL-encoded`, () => {
    const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync(type, type === 'rsa' ? { modulusLength: 2048 } : {});
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const signed = makeSigner({ type, privateKey: pem })(QUERY);
    // Base64 carries + / =, which a query string would mangle unescaped.
    assert.ok(!/[+/=]/.test(signed), 'signature must be URL-encoded');
    const raw = Buffer.from(decodeURIComponent(signed), 'base64');
    const algorithm = type === 'rsa' ? 'RSA-SHA256' : null;
    assert.ok(nodeCrypto.verify(algorithm, Buffer.from(QUERY), publicKey, raw), 'Binance verifies with the uploaded public key; so must we');
    assert.ok(!nodeCrypto.verify(algorithm, Buffer.from(QUERY + '1'), publicKey, raw), 'and a changed query must fail');
  });
}

t('HMAC keys still sign as before', () => {
  assert.equal(makeSigner({ type: 'hmac', secret: 'abc' })('x=1'), r.sign('x=1', 'abc'));
  assert.equal(makeSigner({ secret: 'abc' })('x=1'), r.sign('x=1', 'abc'), 'keys saved before types existed are HMAC');
});

/* ------------------------------------------------------ per-symbol leverage */

// Shaped like BTCUSDT's brackets: the higher the leverage, the lower the cap.
const BTC_BRACKETS = [
  { bracket: 1, initialLeverage: 125, notionalFloor: 0, notionalCap: 300000 },
  { bracket: 2, initialLeverage: 100, notionalFloor: 300000, notionalCap: 800000 },
  { bracket: 3, initialLeverage: 75, notionalFloor: 800000, notionalCap: 3000000 },
  { bracket: 4, initialLeverage: 50, notionalFloor: 3000000, notionalCap: 12000000 },
  { bracket: 5, initialLeverage: 1, notionalFloor: 12000000, notionalCap: 50000000 },
];
// An altcoin that stops at 20x.
const ALT_BRACKETS = [
  { bracket: 1, initialLeverage: 20, notionalFloor: 0, notionalCap: 5000 },
  { bracket: 2, initialLeverage: 10, notionalFloor: 5000, notionalCap: 25000 },
  { bracket: 3, initialLeverage: 5, notionalFloor: 25000, notionalCap: 100000 },
];

t('max leverage is the first bracket, and differs by symbol', () => {
  assert.equal(r.maxLeverage(BTC_BRACKETS), 125);
  assert.equal(r.maxLeverage(ALT_BRACKETS), 20, 'one global 50x would have been refused here');
  assert.equal(r.maxLeverage([]), null);
});

t('higher leverage, smaller position ceiling', () => {
  assert.equal(r.maxNotionalAt(BTC_BRACKETS, 125), 300000);
  assert.equal(r.maxNotionalAt(BTC_BRACKETS, 80), 800000, 'between brackets: the 100x bracket still allows 80x');
  assert.equal(r.maxNotionalAt(BTC_BRACKETS, 75), 3000000);
  assert.equal(r.maxNotionalAt(BTC_BRACKETS, 1), 50000000);
  assert.equal(r.maxNotionalAt(ALT_BRACKETS, 20), 5000);
  assert.equal(r.maxNotionalAt(ALT_BRACKETS, 25), 0, 'above the symbol maximum: nothing');
  assert.equal(r.maxNotionalAt(undefined, 10), Infinity, 'brackets not loaded yet: no false refusal');
});

/* ------------------------------------------------------------ reduce-only */

t('reduce-only: 100% is the exact position, with no remainder', () => {
  assert.equal(r.reduceQuantity({ positionAmt: -0.237, pct: 100, price: 80000 }, BTC).qty, '0.237', 'a short closes in full');
  assert.equal(r.reduceQuantity({ positionAmt: 0.01, pct: 100, price: 80000, market: true }, BTC).qty, '0.010', 'market step too');
});

t('reduce-only: half of an odd position floors to the step, never above it', () => {
  const half = r.reduceQuantity({ positionAmt: 0.237, pct: 50, price: 80000 }, BTC);
  assert.equal(half.qty, '0.118', '0.1185 floors to the 0.001 step');
  const quarter = r.reduceQuantity({ positionAmt: 0.01, pct: 25, price: 80000 }, BTC);
  assert.equal(quarter.qty, '0.002');
});

t('reduce-only: a notional larger than the position is refused, not trimmed', () => {
  const res = r.reduceQuantity({ positionAmt: 0.01, notional: 2000, price: 80000 }, BTC);
  assert.ok(/超過目前倉位/.test(res.error), res.error);
  const ok = r.reduceQuantity({ positionAmt: 0.01, notional: 400, price: 80000 }, BTC);
  assert.equal(ok.qty, '0.005');
});

t('reduce-only: a coin quantity closes exactly that much', () => {
  assert.equal(r.reduceQuantity({ positionAmt: -0.01, qty: 0.004, price: 80000 }, BTC).qty, '0.004');
  assert.ok(/超過目前倉位/.test(r.reduceQuantity({ positionAmt: 0.01, qty: 0.02, price: 80000 }, BTC).error));
});

t('reduce-only: no position, no order', () => {
  assert.ok(/沒有倉位/.test(r.reduceQuantity({ positionAmt: 0, pct: 100, price: 80000 }, BTC).error));
});

t('reduce-only orders are exempt from the minimum notional (Binance -4164)', () => {
  // 0.001 BTC at 80,000 is 80 USDT, under BTC's 100 USDT minimum.
  const order = { side: 'SELL', type: 'MARKET', qty: '0.001', refPrice: 80000 };
  assert.ok(r.validateOrder(order, BTC).some((e) => /名目價值至少/.test(e)), 'a normal order is held to it');
  assert.ok(!r.validateOrder({ ...order, reduceOnly: true }, BTC).some((e) => /名目價值至少/.test(e)), 'a reduce-only one is not');
});

t('a reversal is one order: the other side, twice the position', () => {
  const long = r.planReverse({ positionAmt: 0.01, market: true, lastPrice: 80000, markPrice: 80000 }, BTC);
  assert.deepEqual(long.errors, []);
  assert.equal(long.side, 'SELL');
  assert.equal(long.qty, '0.020');
  assert.ok(Math.abs(long.target + 0.01) < 1e-12, 'ends short the same size');
  const short = r.planReverse({ positionAmt: -0.003, market: true, lastPrice: 80000, markPrice: 80000 }, BTC);
  assert.equal(short.side, 'BUY');
  assert.equal(short.qty, '0.006');
});

t('a limit reversal must rest on the far side of the market', () => {
  const base = { positionAmt: 0.01, market: false, lastPrice: 80000, markPrice: 80000 };
  assert.deepEqual(r.planReverse({ ...base, price: 81000 }, BTC).errors, [], 'a long sells above');
  assert.ok(/高於目前價格/.test(r.planReverse({ ...base, price: 79000 }, BTC).errors[0]), 'not below');
  const short = { ...base, positionAmt: -0.01 };
  assert.deepEqual(r.planReverse({ ...short, price: 79000 }, BTC).errors, [], 'a short buys below');
  assert.ok(/低於目前價格/.test(r.planReverse({ ...short, price: 81000 }, BTC).errors[0]), 'not above');
});

t('a reversal\'s TP/SL are judged as the new position\'s', () => {
  const base = { positionAmt: 0.01, market: true, lastPrice: 80000, markPrice: 80000 };
  assert.deepEqual(r.planReverse({ ...base, sl: 81000, tp: 78000 }, BTC).errors, [], 'now short: stop above, target below');
  assert.ok(r.planReverse({ ...base, sl: 79000 }, BTC).errors.length, 'a stop below would be the old long\'s');
});

t('a reversal too big for one market order says so', () => {
  // 70 BTC reversed is 140, over the 120 market-order cap.
  const plan = r.planReverse({ positionAmt: 70, market: true, lastPrice: 80000, markPrice: 80000 }, BTC);
  assert.ok(plan.errors.some((e) => /單筆上限/.test(e)));
});

t('a split cuts the quantity into whole steps that add back up, the larger parts first', () => {
  assert.deepEqual(r.splitQuantity('0.010', 3, BTC), ['0.004', '0.003', '0.003']);
  assert.deepEqual(r.splitQuantity('0.012', 6, BTC), Array(6).fill('0.002'));
  assert.deepEqual(r.splitQuantity('0.005', 1, BTC), ['0.005']);
  const parts = r.splitQuantity('1.237', 7, BTC);
  assert.equal(parts.length, 7);
  assert.equal(Math.round(parts.reduce((s, q) => s + Number(q), 0) * 1000), 1237, 'nothing lost to rounding');
});

t('a split smaller than a step per order is refused', () => {
  assert.equal(r.splitQuantity('0.002', 3, BTC), null);
  assert.equal(r.splitQuantity('0.003', 0, BTC), null);
});

t('a reversal goes as one order only while its opening half fits beside the position', () => {
  // 0.01 BTC at 80000, 10x: the new half needs 80 USDT, the fee on 0.02 is 0.8.
  const base = { positionAmt: 0.01, price: 80000, leverage: 10 };
  assert.equal(r.reverseFitsOneOrder({ ...base, available: 200 }), true, 'plenty');
  assert.equal(r.reverseFitsOneOrder({ ...base, available: 80 }), false, 'the fee and headroom do not fit');
  assert.equal(r.reverseFitsOneOrder({ ...base, positionAmt: -0.01, available: 80 }), false, 'a short too');
  assert.equal(r.reverseFitsOneOrder({ ...base, available: 83 }), true, 'just fits');
  // Half the balance in the position: the other half cannot open the same again.
  assert.equal(r.reverseFitsOneOrder({ positionAmt: 0.0625, price: 80000, leverage: 10, available: 500 }), false);
  assert.equal(r.reverseFitsOneOrder({ ...base, available: undefined }), true, 'no account: try one, -2019 falls back');
  assert.equal(r.reverseFitsOneOrder({ ...base, leverage: null, available: 10 }), true, 'no leverage known');
});

t('no position, nothing to reverse', () => {
  assert.ok(/沒有倉位/.test(r.planReverse({ positionAmt: 0, market: true, lastPrice: 1 }, BTC).errors[0]));
});

t('a working reversal is intact only while its own fills explain the position', () => {
  const rev = { from: 0.01, side: 'SELL' };
  assert.ok(r.reverseIntact({ ...rev, filled: 0, amt: 0.01 }, BTC), 'untouched');
  assert.ok(r.reverseIntact({ ...rev, filled: 0.015, amt: -0.005 }, BTC), 'part filled, already past flat');
  assert.ok(!r.reverseIntact({ ...rev, filled: 0, amt: 0 }, BTC), 'stopped out first: it would open 0.02 short');
  assert.ok(!r.reverseIntact({ ...rev, filled: 0, amt: 0.02 }, BTC), 'added to by hand');
});

t('order ids too long for a double survive parsing digit for digit', () => {
  const body = r.parseExact('{"orderId":8389765907134201345,"algoId":12,"price":"84213.4","updateTime":1760250000000,"list":[9007199254740993, 5]}');
  assert.equal(body.orderId, '8389765907134201345', 'JSON.parse would give 8389765907134201000');
  assert.equal(body.algoId, 12, 'short ids stay numbers');
  assert.equal(body.updateTime, 1760250000000, 'timestamps stay numbers');
  assert.deepEqual(body.list, ['9007199254740993', 5]);
  assert.equal(r.parseExact('{"msg":"id 12345678901234567, ok"}').msg, 'id 12345678901234567, ok', 'never inside a string');
});

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
