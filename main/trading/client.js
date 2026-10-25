'use strict';

/**
 * Binance USDⓈ-M futures REST client, signed requests only where needed.
 *
 * Conditional orders (take-profit, stop-loss) are not plain orders any more:
 * since 2025-12-09 /fapi/v1/order rejects STOP_MARKET and TAKE_PROFIT_MARKET
 * with -4120 and they go through the Algo Order endpoints instead
 * (/fapi/v1/algoOrder, /fapi/v1/openAlgoOrders).
 */

const crypto = require('crypto');
const { encodeParams, sign, parseExact } = require('./rules');
const { t } = require('../i18n');

/*
 * STOCKCARD_TESTNET_REST / _WS point the *testnet* at another host -- a local
 * mock exchange for development. Live is never overridable.
 */
const ENDPOINTS = Object.freeze({
  live: { rest: 'https://fapi.binance.com', ws: 'wss://fstream.binance.com' },
  testnet: {
    rest: process.env.STOCKCARD_TESTNET_REST || 'https://demo-fapi.binance.com',
    ws: process.env.STOCKCARD_TESTNET_WS || 'wss://demo-fstream.binance.com',
  },
});

const RECV_WINDOW = 5000;
const TIMEOUT_MS = 10000;

class BinanceError extends Error {
  constructor({ status, code, msg, unknown = false }) {
    super(msg || `HTTP ${status}`);
    this.status = status;
    this.code = code;
    // A 503 "unknown error" means the request may or may not have executed.
    this.unknown = unknown;
  }
}

/**
 * Binance error codes worth a sentence of their own. A function, not a table:
 * the text follows the interface language, which can change while running.
 */
function friendlyText(code) {
  switch (code) {
    case '-1021': return t('電腦時間和幣安伺服器差太多，請校正系統時間');
    case '-1022': return t('簽名錯誤：Secret Key 不正確，或私鑰和上傳到幣安的公鑰不是同一對');
    case '-2014': return t('API Key 格式錯誤');
    case '-2015': return t('API Key 無效、IP 未加入白名單，或沒有開啟合約權限');
    case '-2019': return t('保證金不足');
    case '-2021': return t('觸發價會立刻觸發，請調整止盈／止損價');
    case '-2022': return t('只減倉單被拒絕：可能已經沒有倉位，或和現有的掛單衝突（請先取消同方向的掛單）');
    case '-4118': return t('只減倉單失敗：加上現有的掛單會變成反向倉位，請先取消那些掛單');
    case '-2027': return t('目前倉位超過這個槓桿允許的上限：請選較低的槓桿，或先減倉');
    case '-2028': return t('降低槓桿後保證金不足：請先減倉或補保證金');
    case '-4028': return t('槓桿倍數不在這個幣種允許的範圍內');
    case '-4003': return t('數量必須大於 0');
    case '-4014': return t('價格不符合最小跳動單位');
    case '-4016': return t('限價超出允許範圍');
    case '-4046': return t('保證金模式已經是這個設定');
    case '-4048': return t('有倉位或掛單時不能切換保證金模式');
    case '-4059': return t('持倉模式已經是這個設定');
    case '-4061': return t('下單的持倉方向和帳戶的持倉模式不符');
    case '-4164': return t('名目價值太小，低於交易所的最小下單金額');
    default: return null;
  }
}

function friendly(err) {
  if (!(err instanceof BinanceError)) return err && err.message ? err.message : String(err);
  const known = friendlyText(String(err.code));
  if (known) return t('{text}（{code}）', { text: known, code: err.code });
  return err.code ? t('{text}（{code}）', { text: err.message, code: err.code }) : err.message;
}

/**
 * The signature for a query string, by key type. HMAC is hex; Ed25519 and RSA
 * are base64, which has to be URL-encoded to survive the query string.
 * Ed25519 on USD-M REST is not in Binance's docs (they list HMAC and RSA), but
 * it was checked against the live API with a self-generated key: accepted.
 */
function makeSigner({ type = 'hmac', secret, privateKey }) {
  if (type === 'hmac') return (query) => sign(query, secret);
  const key = crypto.createPrivateKey(privateKey);
  const algorithm = type === 'rsa' ? 'RSA-SHA256' : null; // Ed25519 takes none
  return (query) => encodeURIComponent(crypto.sign(algorithm, Buffer.from(query), key).toString('base64'));
}

class FuturesClient {
  constructor({ env, apiKey, type, secret, privateKey }) {
    if (!ENDPOINTS[env]) throw new Error(`unknown environment ${env}`);
    this.env = env;
    this.base = ENDPOINTS[env].rest;
    this.wsBase = ENDPOINTS[env].ws;
    this.apiKey = apiKey;
    this.signer = makeSigner({ type, secret, privateKey });
    this.timeOffset = 0;
    this.timeSynced = false;
  }

  async syncTime() {
    const t0 = Date.now();
    const { serverTime } = await this.request('GET', '/fapi/v1/time');
    const t1 = Date.now();
    this.timeOffset = serverTime - Math.round((t0 + t1) / 2);
    this.timeSynced = true;
  }

  /**
   * One HTTP round trip. Signed requests carry everything in the query string
   * (Binance accepts that for POST/DELETE too), signature last.
   */
  async request(method, path, params = {}, { signed = false, keyed = false, retried = false } = {}) {
    if (signed && !this.timeSynced) await this.syncTime();
    let query = encodeParams(params);
    if (signed) {
      const stamp = encodeParams({ recvWindow: RECV_WINDOW, timestamp: Date.now() + this.timeOffset });
      query = query ? `${query}&${stamp}` : stamp;
      query += `&signature=${this.signer(query)}`;
    }
    const url = `${this.base}${path}${query ? `?${query}` : ''}`;
    const headers = {};
    if (signed || keyed) headers['X-MBX-APIKEY'] = this.apiKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, { method, headers, signal: controller.signal });
    } catch (err) {
      throw new BinanceError({
        status: 0,
        msg: err.name === 'AbortError' ? t('連線逾時') : t('無法連線到幣安：{error}', { error: err.message }),
        // A timed-out order may still have reached the matching engine.
        unknown: method !== 'GET',
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let body = null;
    try {
      body = text ? parseExact(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok || (body && typeof body.code === 'number' && body.code < 0)) {
      const err = new BinanceError({
        status: res.status,
        code: body && body.code,
        msg: (body && body.msg) || text.slice(0, 200) || `HTTP ${res.status}`,
        unknown: res.status === 503 && /unknown/i.test(text),
      });
      // Clock drift: resync once and retry -- safe, the request was rejected.
      if (signed && err.code === -1021 && !retried) {
        await this.syncTime();
        return this.request(method, path, params, { signed, keyed, retried: true });
      }
      throw err;
    }
    return body;
  }

  /* ------------------------------------------------------------- market */

  exchangeInfo() {
    return this.request('GET', '/fapi/v1/exchangeInfo');
  }

  async lastPrice(symbol) {
    const { price } = await this.request('GET', '/fapi/v1/ticker/price', { symbol });
    return Number(price);
  }

  async markPrice(symbol) {
    const { markPrice } = await this.request('GET', '/fapi/v1/premiumIndex', { symbol });
    return Number(markPrice);
  }

  /* ------------------------------------------------------------ account */

  account() {
    return this.request('GET', '/fapi/v3/account', {}, { signed: true });
  }

  positionRisk(symbol) {
    return this.request('GET', '/fapi/v3/positionRisk', { symbol }, { signed: true });
  }

  symbolConfig(symbol) {
    return this.request('GET', '/fapi/v1/symbolConfig', { symbol }, { signed: true });
  }

  leverageBracket(symbol) {
    return this.request('GET', '/fapi/v1/leverageBracket', { symbol }, { signed: true });
  }

  positionMode() {
    return this.request('GET', '/fapi/v1/positionSide/dual', {}, { signed: true });
  }

  setOneWayMode() {
    return this.request('POST', '/fapi/v1/positionSide/dual', { dualSidePosition: 'false' }, { signed: true });
  }

  /**
   * Change a working LIMIT order's price in place: same order id, but it goes
   * to the back of the queue at its new price. Binance only modifies LIMIT
   * orders, and wants side and quantity restated with the price.
   */
  modifyOrder({ symbol, orderId, side, quantity, price }) {
    return this.request('PUT', '/fapi/v1/order', { symbol, orderId, side, quantity, price }, { signed: true });
  }

  setLeverage(symbol, leverage) {
    return this.request('POST', '/fapi/v1/leverage', { symbol, leverage }, { signed: true });
  }

  setMarginType(symbol, marginType) {
    return this.request('POST', '/fapi/v1/marginType', { symbol, marginType }, { signed: true });
  }

  /* ------------------------------------------------------------- orders */

  openOrders(symbol) {
    return this.request('GET', '/fapi/v1/openOrders', { symbol }, { signed: true });
  }

  getOrder(symbol, orderId) {
    return this.request('GET', '/fapi/v1/order', { symbol, orderId }, { signed: true });
  }

  newOrder(params) {
    return this.request('POST', '/fapi/v1/order', { newOrderRespType: 'RESULT', ...params }, { signed: true });
  }

  cancelOrder(symbol, orderId) {
    return this.request('DELETE', '/fapi/v1/order', { symbol, orderId }, { signed: true });
  }

  openAlgoOrders(symbol) {
    return this.request('GET', '/fapi/v1/openAlgoOrders', { symbol }, { signed: true });
  }

  newAlgoOrder(params) {
    return this.request('POST', '/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', ...params }, { signed: true });
  }

  cancelAlgoOrder(algoId) {
    return this.request('DELETE', '/fapi/v1/algoOrder', { algoId }, { signed: true });
  }

  /* --------------------------------------------------------- user stream */

  async createListenKey() {
    const { listenKey } = await this.request('POST', '/fapi/v1/listenKey', {}, { keyed: true });
    return listenKey;
  }

  keepAliveListenKey() {
    return this.request('PUT', '/fapi/v1/listenKey', {}, { keyed: true });
  }

  closeListenKey() {
    return this.request('DELETE', '/fapi/v1/listenKey', {}, { keyed: true });
  }
}

module.exports = { FuturesClient, BinanceError, ENDPOINTS, friendly, makeSigner };
