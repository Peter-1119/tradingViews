'use strict';

/**
 * The account's user-data stream: order fills, position and balance changes,
 * pushed the moment they happen.
 *
 * Treated as a *signal*, not the source of truth. Any event makes the service
 * re-read positions and orders over REST, so a payload shape we mis-parse
 * costs a few hundred milliseconds, never a wrong position on screen; and if
 * the socket is down, polling carries on regardless.
 *
 * fstream routes by path: account events are on /private, and the bare /ws
 * route stops delivering them. The demo (testnet) host is tried the same way,
 * falling back to /ws if /private will not open.
 */

const KEEPALIVE_MS = 30 * 60 * 1000;
// Binance drops a connection at 24h; leave on our own terms a little before.
const MAX_SESSION_MS = 23 * 60 * 60 * 1000;
const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 60000;

class UserStream {
  /**
   * @param {import('./client').FuturesClient} client
   * @param {{onEvent: (data: object) => void, onState: (state: string) => void}} handlers
   */
  constructor(client, { onEvent, onState }) {
    this.client = client;
    this.onEvent = onEvent;
    this.onState = onState;
    this.ws = null;
    this.listenKey = null;
    this.stopped = true;
    this.backoff = RECONNECT_MIN_MS;
    this.routeIndex = 0;
    this.timers = new Set();
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    clearInterval(this.keepAlive);
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* already closing */
      }
    }
    this.ws = null;
    if (this.listenKey) this.client.closeListenKey().catch(() => {});
    this.listenKey = null;
    this.onState('off');
  }

  later(fn, ms) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  async connect() {
    if (this.stopped) return;
    this.onState('connecting');
    try {
      if (!this.listenKey) this.listenKey = await this.client.createListenKey();
    } catch (err) {
      this.onState('error');
      this.scheduleReconnect();
      return;
    }
    const routes = [`/private/ws/${this.listenKey}`, `/ws/${this.listenKey}`];
    const url = `${this.client.wsBase}${routes[this.routeIndex % routes.length]}`;
    let opened = false;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      opened = true;
      this.backoff = RECONNECT_MIN_MS;
      this.onState('live');
      clearInterval(this.keepAlive);
      this.keepAlive = setInterval(() => {
        this.client.keepAliveListenKey().catch(() => {
          // A dead key: drop it, the next connect makes a new one.
          this.listenKey = null;
          this.reopen();
        });
      }, KEEPALIVE_MS);
      this.later(() => this.reopen(), MAX_SESSION_MS);
    };

    ws.onmessage = (msg) => {
      let data;
      try {
        data = JSON.parse(typeof msg.data === 'string' ? msg.data : msg.data.toString());
      } catch {
        return;
      }
      // Combined-stream wrapping, in case a route delivers {stream, data}.
      if (data && data.data && data.stream) data = data.data;
      if (!data || !data.e) return;
      if (data.e === 'listenKeyExpired') {
        this.listenKey = null;
        this.reopen();
        return;
      }
      this.onEvent(data);
    };

    ws.onerror = () => {
      /* onclose follows and handles it */
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.keepAlive);
      if (this.stopped) return;
      // Never opened: try the other route next time.
      if (!opened) this.routeIndex += 1;
      this.onState('connecting');
      this.scheduleReconnect();
    };
  }

  reopen() {
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    if (!this.stopped) this.connect();
  }

  scheduleReconnect() {
    const wait = this.backoff;
    this.backoff = Math.min(RECONNECT_MAX_MS, this.backoff * 2);
    this.later(() => this.connect(), wait);
  }
}

module.exports = { UserStream };
