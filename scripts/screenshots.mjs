#!/usr/bin/env node
/**
 * The documentation's screenshots, taken from the running app.
 *
 *   npm run shots                       every shot
 *   npm run shots -- --only hero,walls  some of them (names below)
 *   npm run shots -- --list             the names
 *   npm run shots -- --collect 15       minutes to collect order flow first (default 12)
 *   npm run shots -- --keep             keep the throwaway profile afterwards
 *
 * Safety first, because the person running this may have the real app open with
 * a live account:
 *   - The app is started on a brand-new, empty profile in the temp folder
 *     (--user-data-dir), never on %APPDATA%/stock-card. It has no keys.
 *   - Trading is switched to the local paper account before anything else, and
 *     every order the script places is refused unless the app reports paper.
 *   - Only the process this script started is stopped at the end.
 * Windows appear on screen while it runs (a window must be painted to be
 * captured); leave the machine alone for the ten minutes or so it takes.
 *
 * Pictures are captured with the Chrome DevTools Protocol at 2x, so they stay
 * sharp on high-DPI screens and on GitHub, which shows them at half size.
 * Market data is live, so every run looks a little different.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'images');

/* -------------------------------------------------------------- options */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PORT = Number(option('port', '9334'));
const SCALE = Number(option('scale', '2'));
const COLLECT_MIN = Number(option('collect', '12'));
const KEEP = flag('keep');

const SHOTS = [
  'hero', 'indicators', 'levels', 'frvp', 'cvd-oi', 'order-ticket', 'tradfi-search',
  'tradfi-ticket', 'watchlist', 'modes', 'big-orders', 'walls', 'footprint',
  'journal', 'board', 'guide', 'guide-zh',
];
if (flag('list')) {
  console.log(SHOTS.join('\n'));
  process.exit(0);
}
const only = option('only', '') ? new Set(option('only', '').split(',')) : null;
for (const name of only || []) {
  if (!SHOTS.includes(name)) throw new Error(`unknown shot "${name}"; --list shows them`);
}
const wanted = (name) => !only || only.has(name);

/* ------------------------------------------------------------- helpers */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => console.log(new Date().toTimeString().slice(0, 8), ...args);

async function json(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/** Recent closed bars from Binance's public API: [{time, open, high, low, close}]. */
async function bars(symbol, interval, limit, market = 'perp') {
  const base = market === 'perp' ? 'https://fapi.binance.com/fapi/v1' : 'https://api.binance.com/api/v3';
  const rows = await json(`${base}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  return rows.slice(0, -1).map((r) => ({ time: r[0] / 1000, open: +r[1], high: +r[2], low: +r[3], close: +r[4] }));
}

/** A minimal Chrome DevTools Protocol client for one page. */
class Page {
  constructor(target) {
    this.target = target;
    this.id = 0;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error(`cannot connect to ${this.target.url}`));
    });
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      const done = this.pending.get(msg.id);
      if (done) {
        this.pending.delete(msg.id);
        done(msg);
      }
    };
    return this;
  }

  /** A call, failing after a minute rather than hanging if the page goes away. */
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no answer from ${this.target.url}`));
      }, 60000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg.result);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Run an expression without waiting for it: for one that closes this page. */
  fire(expression) {
    this.ws.send(JSON.stringify({ id: ++this.id, method: 'Runtime.evaluate', params: { expression } }));
  }

  /** Evaluate an expression in the page; promises are awaited, the value is returned. */
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(`in page: ${(d.exception && d.exception.description) || d.text}`);
    }
    return res.result.value;
  }

  async hover(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  }

  /** The page as a PNG buffer, at SCALE unless told otherwise. */
  async capture(scale = SCALE) {
    await this.send('Page.bringToFront');
    const { width, height } = await this.eval('({ width: innerWidth, height: innerHeight })');
    const shot = await this.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width, height, scale },
    });
    return Buffer.from(shot.data, 'base64');
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

/* ----------------------------------------------------------------- app */

/** The real profile: never to be touched by this script. */
const REAL_PROFILE = path.resolve(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'stock-card');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tapecard-shots-'));
if (path.resolve(profile).toLowerCase() === REAL_PROFILE.toLowerCase()) throw new Error('refusing to use the real profile');

let app = null;
const pages = new Map();

async function launch() {
  log('profile', profile);
  const logFile = fs.openSync(path.join(profile, 'app.log'), 'w');
  app = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`], {
    cwd: ROOT,
    stdio: ['ignore', logFile, logFile],
    windowsHide: false,
  });
  app.on('exit', (code) => log('app exited', code));
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    try {
      const targets = await json(`http://127.0.0.1:${PORT}/json`);
      if (targets.some((t) => t.type === 'page' && t.url.includes('card.html'))) return;
    } catch {
      /* not up yet */
    }
  }
  throw new Error('the app did not open a card within a minute; see app.log in the profile');
}

/** The page whose URL contains `match`, connected (cached until it reloads). */
async function page(match, { wait = 20000 } = {}) {
  const deadline = Date.now() + wait;
  for (;;) {
    const targets = await json(`http://127.0.0.1:${PORT}/json`);
    const target = targets.find((t) => t.type === 'page' && t.url.includes(match));
    if (target) {
      const cached = pages.get(target.id);
      if (cached && cached.ws.readyState === WebSocket.OPEN) return cached;
      const p = await new Page(target).connect();
      pages.set(target.id, p);
      return p;
    }
    if (Date.now() > deadline) throw new Error(`no page matching ${match}`);
    await sleep(500);
  }
}

/** Wait until `expression` is truthy in the page (a page found early may still be loading). */
async function waitFor(p, expression, ms = 20000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      if (await p.eval(expression)) return;
    } catch {
      /* still loading */
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${expression}`);
    await sleep(500);
  }
}

/** A card's page, once its view is up. */
async function cardPage(cardId) {
  const p = await page(`cardId=${cardId}`);
  for (let i = 0; i < 40; i++) {
    if (await p.eval('!!(window.tapecard && window.tapecard.view)')) return p;
    await sleep(500);
  }
  throw new Error(`card ${cardId} never came up`);
}

async function quit() {
  for (const p of pages.values()) p.close();
  if (app && app.exitCode === null) {
    app.kill();
    await sleep(1500);
  }
  if (!KEEP) fs.rmSync(profile, { recursive: true, force: true });
  else log('kept profile', profile);
}

/* ------------------------------------------------------- page actions */

/** The bridge, from any card page. */
const api = (p, code) => p.eval(`(async () => { const api = window.stockcard; ${code} })()`);

/** Configure a card and put its window where it can be seen. */
async function setCard(p, cardId, patch, { width, height, x = 60, y = 60 }) {
  await api(p, `await api.updateCard(${JSON.stringify(cardId)}, ${JSON.stringify({ cardOpacity: 1, ...patch })});`);
  await api(p, `await api.setBounds(${JSON.stringify({ x, y, width, height })});`);
}

/** Wait until the card has drawn bars, then a little longer for the panes. */
async function settle(p, ms = 4000) {
  for (let i = 0; i < 40; i++) {
    const ok = await p.eval('(() => { const v = window.tapecard.view; return !!(v.chart && v.chart.bars && v.chart.bars.length > 50); })()');
    if (ok) break;
    await sleep(500);
  }
  await sleep(ms);
}

async function save(group, name, png) {
  const dir = path.join(OUT, group);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  fs.writeFileSync(file, png);
  log('saved', path.relative(ROOT, file), `${Math.round(png.length / 1024)} KB`);
}

/**
 * Hover the card so its title bar and toolbar show, then capture. By default
 * the pointer rests on the title bar: the toolbar shows which tools are on,
 * and no crosshair or order ＋ crosses the chart.
 */
async function shoot(p, group, name, { hover = 'title', wait = 600 } = {}) {
  if (hover === 'title') {
    const w = await p.eval('innerWidth');
    await p.hover(Math.round(w / 2), 12);
  } else if (hover) {
    await p.hover(...hover);
  }
  await sleep(wait);
  await save(group, name, await p.capture());
}

/** Paper only: refuse to send anything unless the app says it is on paper. */
async function paper(p, code) {
  const env = await api(p, 'const s = await api.trading.status(); return (s && s.data ? s.data : s).env;');
  if (env !== 'paper') throw new Error(`trading environment is "${env}", not paper: refusing to place orders`);
  return api(p, code);
}

async function placePaper(p, req) {
  const res = await paper(p, `return api.trading.place(${JSON.stringify(req)});`);
  if (!res || !res.ok) log('order not placed:', req.symbol, req.side, res && res.error);
  return res;
}

/** Lay several PNGs side by side on a transparent canvas, in the page. */
async function composite(p, pngs, gap = 28) {
  const urls = pngs.map((b) => `data:image/png;base64,${b.toString('base64')}`);
  const out = await p.eval(`(async () => {
    const imgs = await Promise.all(${JSON.stringify(urls)}.map((src) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = src; })));
    const gap = ${gap * SCALE};
    const w = imgs.reduce((s, i) => s + i.width, 0) + gap * (imgs.length - 1);
    const h = Math.max(...imgs.map((i) => i.height));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    let x = 0;
    for (const i of imgs) { g.drawImage(i, x, Math.round((h - i.height) / 2)); x += i.width + gap; }
    return c.toDataURL('image/png').split(',')[1];
  })()`);
  return Buffer.from(out, 'base64');
}

/* ---------------------------------------------------------------- run */

async function run() {
  await launch();
  const first = await page('card.html');
  const mainId = await first.eval("new URLSearchParams(location.search).get('cardId')");
  let main = await cardPage(mainId);
  await api(main, `await api.updateCard(${JSON.stringify(mainId)}, { cardOpacity: 1 });`);

  // English, the paper account with a round starting balance, and a watchlist.
  await api(main, "await api.setPrefs({ language: 'en' });");
  main = await cardPage(mainId);
  // No range-alert glow or toasts from the test profile's watchlist.
  await api(main, 'await api.setPrefs({ alerts: { enabled: false, toast: false, flash: false } });');
  await api(main, "await api.trading.setEnv('paper');");
  await paper(main, 'return api.trading.paperReset(10000, 0.0002, 0.0005);');
  await api(main, `await api.setPrefs({ watchlist: ${JSON.stringify([
    { symbol: 'BTCUSDT', market: 'perp' },
    { symbol: 'ETHUSDT', market: 'perp' },
    { symbol: 'SOLUSDT', market: 'perp' },
    { symbol: 'BTCUSDT', market: 'spot' },
    { symbol: 'SNDKUSDT', market: 'perp' },
    { symbol: 'XAUUSDT', market: 'perp' },
  ])} });`);
  log('paper account ready');
  // The first card says once where the shortcuts are; let that note go by.
  await sleep(9000);

  // Order flow only exists from when the app starts collecting it, so the cards
  // that collect open first and are photographed last.
  const collectors = {};
  const addCard = async (key, patch, bounds) => {
    const card = await api(main, `return api.addCard(${JSON.stringify({ cardOpacity: 1, ...patch, bounds })});`);
    collectors[key] = card.id;
  };
  const needs = (...names) => names.some(wanted);
  if (needs('big-orders')) await addCard('flow', { symbol: 'SOLUSDT', market: 'perp', interval: '1m', showVolume: true, flow: 'both', flowTop: '0.5', flowSens: '2' }, { x: 700, y: 80, width: 760, height: 460 });
  if (needs('walls')) await addCard('walls', { symbol: 'BTCUSDT', market: 'spot', interval: '1m', showVolume: true, walls: 'both', wallsSens: '5' }, { x: 740, y: 120, width: 760, height: 460 });
  if (needs('footprint')) await addCard('footprint', { symbol: 'BTCUSDT', market: 'perp', interval: '1m', footprint: true, fpRatio: '3' }, { x: 780, y: 160, width: 760, height: 480 });
  const collectStart = Date.now();

  // A few paper trades along the way, so the journal has something to show.
  const trades = [
    // Symbols no shot shows, so these positions never appear on a chart.
    { symbol: 'XRPUSDT', side: 'BUY' },
    { symbol: 'DOGEUSDT', side: 'SELL' },
    { symbol: 'ADAUSDT', side: 'BUY' },
    { symbol: 'LTCUSDT', side: 'SELL' },
    { symbol: 'AVAXUSDT', side: 'BUY' },
    { symbol: 'LINKUSDT', side: 'SELL' },
    { symbol: 'TRXUSDT', side: 'BUY' },
    { symbol: 'DOTUSDT', side: 'SELL' },
  ];
  const open = [];
  const tradeStep = async () => {
    if (!wanted('journal')) return;
    if (open.length >= 2 || (!trades.length && open.length)) {
      const t = open.shift();
      await paper(main, `return api.trading.close(${JSON.stringify(t.symbol)});`);
    }
    const next = trades.shift();
    if (next) {
      const res = await placePaper(main, { ...next, type: 'MARKET', notional: 1500, tp: null, sl: null, reduceOnly: false, splits: 1 });
      if (res && res.ok) open.push(next);
    }
  };

  const v = 'window.tapecard.view';

  if (wanted('indicators')) {
    await setCard(main, mainId, { symbol: 'BTCUSDT', market: 'perp', interval: '5m', showVolume: true, showRsi: true, rsiPeriod: '14', showMacd: true }, { width: 760, height: 520 });
    await settle(main);
    await shoot(main, 'chart', 'indicators');
    await setCard(main, mainId, { showRsi: false, showMacd: false }, { width: 760, height: 520 });
  }

  if (wanted('levels')) {
    await setCard(main, mainId, { symbol: 'BTCUSDT', market: 'perp', interval: '15m', showVolume: false, showOpens: true, opensWhich: 'both', hilo: 'prev', levelAnchor: 'utc', volumeProfile: 'session4h' }, { width: 760, height: 460 });
    await settle(main, 6000);
    await shoot(main, 'chart', 'levels');
    await setCard(main, mainId, { showOpens: false, hilo: 'off', volumeProfile: 'off' }, { width: 760, height: 460 });
  }

  if (wanted('frvp')) {
    const b = await bars('BNBUSDT', '15m', 160);
    // Inside the view (a 760px card shows about 12 hours of 15m bars): the
    // profile grows rightwards from the range's left edge, which must be seen.
    const from = b[b.length - 42].time;
    const to = b[b.length - 12].time;
    await api(main, `await api.addVRange('BNBUSDT', ${from}, ${to});`);
    await setCard(main, mainId, { symbol: 'BNBUSDT', market: 'perp', interval: '15m', showVolume: true, vpDetail: 'fine' }, { width: 760, height: 460 });
    // The profile is built from 1m bars fetched after the card has drawn.
    await settle(main, 15000);
    await shoot(main, 'chart', 'frvp');
  }

  if (wanted('cvd-oi')) {
    await setCard(main, mainId, { symbol: 'BTCUSDT', market: 'perp', interval: '15m', showVolume: true, showCvd: true, cvdAnchor: 'none', showOI: true, showLS: true, lsWhich: 'both' }, { width: 760, height: 600 });
    await settle(main, 8000);
    await shoot(main, 'order-flow', 'cvd-oi');
    await setCard(main, mainId, { showCvd: false, showOI: false, showLS: false }, { width: 760, height: 520 });
  }

  if (wanted('order-ticket')) {
    await setCard(main, mainId, { symbol: 'ETHUSDT', market: 'perp', interval: '5m', showVolume: true }, { width: 760, height: 560 });
    await settle(main);
    const last = (await bars('ETHUSDT', '1m', 3)).at(-1).close;
    const price = +(last * 0.996).toFixed(2);
    await main.eval(`${v}.trade.openTicket(${price})`);
    await sleep(800);
    await main.eval(`(() => {
      const root = ${v}.root;
      const set = (input, value) => { input.value = String(value); input.dispatchEvent(new Event('input', { bubbles: true })); };
      const amount = [...root.querySelectorAll('input.tk-input__field')].find((i) => /Notional/i.test(i.placeholder));
      set(amount, 500);
      const tpsl = ${v}.trade.ticket.tpslToggle;
      if (!tpsl.checked) tpsl.click();
      set(${v}.trade.ticket.tpInput, ${+(price * 1.02).toFixed(2)});
      set(${v}.trade.ticket.slInput, ${+(price * 0.99).toFixed(2)});
    })()`);
    await sleep(2500);
    await shoot(main, 'trading', 'order-ticket', { hover: null });
    await main.eval(`${v}.trade.closeTicket()`);
  }

  if (wanted('tradfi-search')) {
    await setCard(main, mainId, { symbol: 'BTCUSDT', market: 'perp', interval: '15m' }, { width: 640, height: 520 });
    await settle(main, 1500);
    await main.eval(`(() => {
      ${v}.panel.open();
      const input = ${v}.root.querySelector('input.sc-search__input');
      input.focus();
      input.value = 'SN';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(2500);
    await shoot(main, 'trading', 'tradfi-search', { hover: null });
    await main.eval(`${v}.panel.close()`);
  }

  if (wanted('tradfi-ticket')) {
    await setCard(main, mainId, { symbol: 'SNDKUSDT', market: 'perp', interval: '15m', showVolume: true }, { width: 760, height: 700 });
    await settle(main, 5000);
    await main.eval(`${v}.trade.openTicket(0)`);
    await sleep(800);
    await main.eval(`(() => {
      const root = ${v}.root;
      const amount = [...root.querySelectorAll('input.tk-input__field')].find((i) => /Notional/i.test(i.placeholder));
      amount.value = '300';
      amount.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(2000);
    // One press arms the button and shows what would be sent; nothing is sent
    // without the second press, which this script never makes.
    await main.eval(`(() => {
      const btn = [...${v}.root.querySelectorAll('button')].find((b) => /^Long\\b/.test(b.textContent.trim()));
      if (btn) btn.click();
    })()`);
    await sleep(400);
    await shoot(main, 'trading', 'tradfi-ticket', { hover: null, wait: 200 });
    await sleep(3500);
    await main.eval(`${v}.trade.closeTicket()`);
  }

  if (wanted('hero')) {
    const b = await bars('ETHUSDT', '15m', 200);
    const recent = b.slice(-120);
    const hi = Math.max(...recent.map((x) => x.high));
    const lo = Math.min(...recent.map((x) => x.low));
    // A trend line through the two lowest lows of the halves of the view.
    const half = recent.length / 2;
    const lowOf = (xs) => xs.reduce((m, x) => (x.low < m.low ? x : m));
    const a = lowOf(recent.slice(0, half));
    const c = lowOf(recent.slice(half, -8));
    await api(main, `
      await api.addLevel('ETHUSDT', ${hi.toFixed(2)}, 'red');
      await api.addLevel('ETHUSDT', ${lo.toFixed(2)}, 'green');
      await api.addTrendline('ETHUSDT', ${JSON.stringify({ time: a.time, price: a.low })}, ${JSON.stringify({ time: c.time, price: c.low })});
    `);
    const last = (await bars('ETHUSDT', '1m', 3)).at(-1).close;
    await placePaper(main, { symbol: 'ETHUSDT', side: 'BUY', type: 'MARKET', notional: 2000, tp: +(last * 1.025).toFixed(2), sl: +(last * 0.985).toFixed(2), reduceOnly: false, splits: 1 });
    await placePaper(main, { symbol: 'ETHUSDT', side: 'BUY', type: 'LIMIT', price: +(last * 0.992).toFixed(2), notional: 1000, tp: null, sl: null, reduceOnly: false, splits: 1 });
    await setCard(main, mainId, { symbol: 'ETHUSDT', market: 'perp', interval: '15m', showVolume: true, volColor: 'split', volLayout: 'overlay', showHtf: true, htfInterval: '4h', showOpens: false }, { width: 860, height: 500 });
    await settle(main, 7000);
    await shoot(main, 'hero', 'overview');
    // Flat again, so this position shows on no other picture.
    await main.eval(`(async () => {
      const s = ${v}.trade.snapshot;
      for (const o of (s && s.orders) || []) await window.stockcard.trading.cancel({ symbol: 'ETHUSDT', kind: 'order', id: o.id });
    })()`);
    await paper(main, "return api.trading.close('ETHUSDT');");
  }

  if (wanted('watchlist')) {
    await setCard(main, mainId, { symbol: 'BTCUSDT', market: 'perp', interval: '15m', showHtf: false, showOpens: false }, { width: 560, height: 420 });
    await settle(main, 3000);
    await main.hover(200, 14);
    await sleep(300);
    await main.eval(`${v}.watchlist.open()`);
    await sleep(2000);
    await shoot(main, 'windows', 'watchlist', { hover: null });
    await main.eval(`${v}.watchlist.close()`);
  }

  if (wanted('modes')) {
    await setCard(main, mainId, { symbol: 'BTCUSDT', market: 'perp', interval: '5m', showVolume: true, compact: 'off' }, { width: 520, height: 320 });
    await settle(main, 3000);
    await main.hover(260, 12);
    await sleep(500);
    const full = await main.capture();
    await api(main, `await api.updateCard(${JSON.stringify(mainId)}, { compact: 'mini' });`);
    await sleep(3000);
    main = await cardPage(mainId);
    const mini = await main.capture();
    await api(main, `await api.updateCard(${JSON.stringify(mainId)}, { compact: 'ticker' });`);
    await sleep(3000);
    main = await cardPage(mainId);
    const ticker = await main.capture();
    await api(main, `await api.updateCard(${JSON.stringify(mainId)}, { compact: 'off' });`);
    await sleep(2000);
    main = await cardPage(mainId);
    await save('windows', 'modes', await composite(main, [full, mini, ticker]));
  }

  // Wait out the collection time, trading on paper meanwhile: two positions
  // at a time, each held a few minutes, so the journal looks like use.
  const until = collectStart + COLLECT_MIN * 60000;
  if ((Object.keys(collectors).length || wanted('journal')) && until > Date.now()) {
    log(`collecting for ${Math.ceil((until - Date.now()) / 60000)} more minute(s)`);
    const step = Math.max(30000, (until - Date.now()) / (trades.length + 1));
    while (Date.now() < until) {
      await tradeStep();
      await sleep(Math.min(step, Math.max(0, until - Date.now())));
    }
  }
  // Close what is left, so the journal is all closed trades.
  while (wanted('journal') && (trades.length || open.length)) await tradeStep();
  if (collectors.flow) {
    const p = await cardPage(collectors.flow);
    await shoot(p, 'order-flow', 'big-orders');
  }
  if (collectors.walls) {
    const p = await cardPage(collectors.walls);
    await shoot(p, 'order-flow', 'walls');
  }
  if (collectors.footprint) {
    const p = await cardPage(collectors.footprint);
    await p.eval("window.tapecard.view.setActiveTool('footprint', 'focus')");
    await sleep(2500);
    await shoot(p, 'order-flow', 'footprint');
  }

  if (wanted('journal')) {
    await paper(main, 'return api.trading.openJournal();');
    const j = await page('journal.html');
    await waitFor(j, "document.readyState === 'complete'");
    await sleep(3000);
    await save('trading', 'journal', await j.capture());
  }

  if (wanted('board')) {
    // Four cards in a grid; the collectors, when they ran, are three of them.
    const extra = [
      { symbol: 'BTCUSDT', market: 'spot', interval: '5m', showVolume: true },
      { symbol: 'SOLUSDT', market: 'perp', interval: '15m', showVolume: true },
      { symbol: 'XAUUSDT', market: 'perp', interval: '1h', showVolume: true },
    ].slice(0, Math.max(0, 3 - Object.keys(collectors).length));
    for (const card of extra) await api(main, `await api.addCard(${JSON.stringify({ cardOpacity: 1, ...card })});`);
    // Switching mode closes the card windows, this one included: don't wait on it.
    main.fire("window.stockcard.setMode('board')");
    const b = await page('board.html');
    await waitFor(b, '!!(window.stockcard && document.querySelector(".card, .sc-card, canvas"))');
    await b.eval("window.stockcard.setBounds({ x: 40, y: 40, width: 1180, height: 720 })");
    await sleep(9000);
    await save('windows', 'board', await b.capture(1.5));
    b.fire("window.stockcard.setMode('float')");
    await sleep(4000);
    main = await cardPage(mainId);
  }

  if (wanted('guide')) {
    await api(main, 'await api.openGuide();');
    const g = await page('guide.html');
    await waitFor(g, "!!document.querySelector('h1')");
    await sleep(1500);
    // Text-heavy windows: 1.5x keeps them sharp at half the file size.
    await save('windows', 'guide', await g.capture(1.5));
  }
  if (wanted('guide-zh')) {
    await api(main, "await api.setPrefs({ language: 'zh-TW' });");
    await sleep(4000);
    main = await cardPage(mainId);
    await api(main, 'await api.openGuide();');
    await sleep(1500);
    const g = await page('guide.html');
    await waitFor(g, "!!document.querySelector('h1')");
    await sleep(1500);
    await save('windows', 'guide-zh', await g.capture(1.5));
  }
}

try {
  await run();
  log('done');
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await quit();
}
