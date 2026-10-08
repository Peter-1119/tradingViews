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
const { encodeParams, sign } = require('./rules');

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

/** Binance error codes worth a sentence of their own. */
const FRIENDLY = {
  '-1021': '電腦時間和幣安伺服器差太多，請校正系統時間',
  '-1022': '簽名錯誤：Secret Key 不正確，或私鑰和上傳到幣安的公鑰不是同一對',
  '-2014': 'API Key 格式錯誤',
  '-2015': 'API Key 無效、IP 未加入白名單，或沒有開啟合約權限',
  '-2019': '保證金不足',
  '-2021': '觸發價會立刻觸發，請調整止盈／止損價',
  '-2022': '只減倉單被拒絕（可能已經沒有倉位）',
  '-2027': '目前倉位超過這個槓桿允許的上限：請選較低的槓桿，或先減倉',
  '-2028': '降低槓桿後保證金不足：請先減倉或補保證金',
  '-4028': '槓桿倍數不在這個幣種允許的範圍內',
  '-4003': '數量必須大於 0',
  '-4014': '價格不符合最小跳動單位',
  '-4016': '限價超出允許範圍',
  '-4046': '保證金模式已經是這個設定',
  '-4048': '有倉位或掛單時不能切換保證金模式',
  '-4059': '持倉模式已經是這個設定',
  '-4061': '下單的持倉方向和帳戶的持倉模式不符',
  '-4164': '名目價值太小，低於交易所的最小下單金額',
};

function friendly(err) {
  if (!(err instanceof BinanceError)) return err && err.message ? err.message : String(err);
  const known = FRIENDLY[String(err.code)];
  return known ? `${known}（${err.code}）` : `${err.message}${err.code ? `（${err.code}）` : ''}`;
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
        msg: err.name === 'AbortError' ? '連線逾時' : `無法連線到幣安：${err.message}`,
        // A timed-out order may still have reached the matching engine.
        unknown: method !== 'GET',
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
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
