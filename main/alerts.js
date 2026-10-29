'use strict';

/**
 * Delivering a position alert from the hub, without sound (by request):
 *
 *   - every card window hears it, and the card showing that symbol lights up
 *   - a Windows toast, unless turned off
 *   - the taskbar flashes, unless turned off
 *
 * Measured on this machine with Warcraft III running: the toast was delivered
 * (it landed in the Action Center) but no banner showed -- Focus Assist's
 * "while playing a game" rule holds banners back. The taskbar is hidden under
 * a full-screen game too. So neither reaches someone mid-game; the card does,
 * floating over a borderless game. Both still matter the rest of the time,
 * and the Action Center keeps what was missed.
 */

const { Notification } = require('electron');
const store = require('./store');
const windows = require('./windows');
const { t } = require('./i18n');

/** Toasts must be referenced until they close, or GC can take them before a click. */
const live = new Set();

/** The last position per "market:symbol", for cards that open mid-session. */
const states = new Map();

const QUOTES = ['USDT', 'FDUSD', 'USDC', 'BTC', 'ETH', 'BNB'];
function pretty(symbol) {
  const quote = QUOTES.find((q) => symbol.endsWith(q) && symbol.length > q.length);
  return quote ? `${symbol.slice(0, -quote.length)}/${quote}` : symbol;
}

function describe(alert) {
  const name = alert.market === 'perp' ? t('{symbol} 永續', { symbol: pretty(alert.symbol) }) : pretty(alert.symbol);
  const arrow = alert.side === 'high' ? '↑' : '↓';
  return {
    title: t('{name} · {window} 位置 {pct}%', { name, window: alert.window, pct: Math.round(alert.pct * 100) }),
    body: t('{arrow} 碰到 {level}%　價格 {price}\n回到 50% 前，這個等級不會再提醒', { arrow, level: alert.level, price: alert.price }),
  };
}

/**
 * Muting is decided here, not in the hub: the hub keeps measuring and keeps
 * marking levels as fired either way, so turning a symbol (or everything)
 * back on does not unload a backlog -- it alerts on the next fresh excursion.
 */
function isMuted(alert, settings) {
  if (!settings.enabled) return 'all alerts off';
  const entry = store.getWatchlist().find((e) => e.symbol === alert.symbol && e.market === alert.market);
  if (entry && entry.alert === false) return 'symbol muted';
  return null;
}

function fire(alert) {
  const settings = store.getAlerts();
  const line = `[alerts] ${alert.market}:${alert.symbol} ${alert.window} ${alert.side} ${alert.level}% at ${alert.price}`;
  const muted = isMuted(alert, settings);
  if (muted) {
    console.log(`${line} (not delivered: ${muted})`);
    return;
  }
  console.log(line);
  windows.broadcast('alerts:fired', alert);

  if (settings.toast && Notification.isSupported()) {
    const toast = new Notification({ ...describe(alert), silent: true });
    live.add(toast);
    toast.on('click', () => windows.showAll('alert notification'));
    toast.on('close', () => live.delete(toast));
    toast.on('failed', (_e, err) => {
      live.delete(toast);
      console.warn('[alerts] toast failed', err);
    });
    toast.show();
  }
  if (settings.flash) windows.flashFor(alert);
}

/**
 * A price or volume alert the user set by hand. Unlike the position alerts it
 * ignores the "all alerts off" switch and the per-symbol mute: those govern
 * automatic alerts, and a level someone placed deliberately is never noise.
 * The toast and flash preferences still decide how it is delivered -- but if
 * both are off, the toast is sent anyway, or a hidden app would have no way
 * to say it.
 */
function deliverManual(alert, hit, title, body, { broadcast = true } = {}) {
  const settings = store.getAlerts();
  if (broadcast) windows.broadcast('priceAlerts:fired', { ...alert, ...hit, time: Date.now() });

  const toastOn = settings.toast || !settings.flash;
  if (toastOn && Notification.isSupported()) {
    const toast = new Notification({
      title,
      body,
      silent: true, // no sound, like the position alerts (by request)
    });
    live.add(toast);
    toast.on('click', () => windows.showAll('price alert notification'));
    toast.on('close', () => live.delete(toast));
    toast.on('failed', (_e, err) => {
      live.delete(toast);
      console.warn('[alerts] toast failed', err);
    });
    toast.show();
  }
  if (settings.flash) windows.flashFor(alert);
}

function displayName(alert) {
  return alert.market === 'perp' ? t('{symbol} 永續', { symbol: pretty(alert.symbol) }) : pretty(alert.symbol);
}

function firePrice(alert, price) {
  const arrow = alert.direction === 'up' ? t('↑ 漲到') : t('↓ 跌到');
  console.log(`[alerts] price ${alert.market}:${alert.symbol} ${alert.direction} ${alert.price} hit at ${price}`);
  deliverManual(
    alert,
    { hitPrice: price },
    t('{name} · 價格提醒', { name: displayName(alert) }),
    t('{arrow} {target}　目前 {price}', { arrow, target: alert.price, price })
  );
}

/** 1.25M: volume in the quote currency, as the chart's label shows it. */
function compact(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(2);
}

function fireVolume(alert, volume) {
  console.log(`[alerts] volume ${alert.market}:${alert.symbol} ${alert.interval} ${alert.volume} hit at ${volume}`);
  deliverManual(
    alert,
    { hitVolume: volume },
    t('{name} · 成交量提醒', { name: displayName(alert) }),
    t('{interval} 成交量達到 {target}　目前 {volume}', {
      interval: alert.interval,
      target: compact(alert.volume),
      volume: compact(volume),
    })
  );
}

/**
 * A resting order filled, or a TP/SL went off: `batch` is what service.js
 * gathered (a split order filling at once is one alert). Delivered like a
 * price alert -- the toast and flash preferences, never muted.
 */
function fireFill(batch) {
  const name = displayName({ symbol: batch.symbol, market: 'perp' });
  let title;
  let body;
  if (batch.kind === 'tp' || batch.kind === 'sl') {
    title = batch.kind === 'tp' ? t('{name} · 止盈已觸發', { name }) : t('{name} · 止損已觸發', { name });
    body = t('倉位正在平倉，請到卡片確認');
  } else {
    const side = batch.reduceOnly
      ? batch.side === 'BUY' ? t('限價買入（只減倉）') : t('限價賣出（只減倉）')
      : batch.side === 'BUY' ? t('限價買入') : t('限價賣出');
    const avg = batch.qty > 0 ? batch.cost / batch.qty : 0;
    const qty = Number(batch.qty.toFixed(8));
    const price = avg ? Number(avg.toPrecision(8)) : '—';
    title = batch.partial ? t('{name} · 掛單部分成交', { name }) : t('{name} · 掛單已成交', { name });
    body = batch.partial
      ? t('{side} 已成交 {qty} / {total}，均價 {price}', { side, qty, total: Number(batch.orderQty.toFixed(8)), price })
      : t('{side} {qty} 已成交，均價 {price}', { side, qty, price });
    if (batch.count > 1) body += t('（{n} 筆）', { n: batch.count });
  }
  console.log(`[alerts] fill ${batch.symbol} ${batch.kind} ${batch.partial ? 'partial ' : ''}x${batch.count || 1}`);
  deliverManual({ symbol: batch.symbol, market: 'perp', kind: 'fill' }, {}, title, body, { broadcast: false });
}

function setState(state) {
  states.set(`${state.market}:${state.symbol}`, state);
  windows.broadcast('alerts:state', state);
}

/** Forget symbols no longer watched, so a re-added one does not show stale figures. */
function prune(entries) {
  const keep = new Set(entries.map((e) => `${e.market}:${e.symbol}`));
  for (const key of [...states.keys()]) if (!keep.has(key)) states.delete(key);
}

module.exports = {
  fire,
  firePrice,
  fireVolume,
  fireFill,
  setState,
  prune,
  getStates: () => [...states.values()],
};
