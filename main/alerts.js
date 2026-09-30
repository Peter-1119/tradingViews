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
  const name = `${pretty(alert.symbol)}${alert.market === 'perp' ? ' 永續' : ''}`;
  const arrow = alert.side === 'high' ? '↑' : '↓';
  return {
    title: `${name} · ${alert.window} 位置 ${Math.round(alert.pct * 100)}%`,
    body: `${arrow} 碰到 ${alert.level}%　價格 ${alert.price}\n回到 50% 前，這個等級不會再提醒`,
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
  setState,
  prune,
  getStates: () => [...states.values()],
};
