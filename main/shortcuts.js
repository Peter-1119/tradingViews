'use strict';

/**
 * Global shortcuts (spec 4.4). Accelerators are user-editable, so registration
 * has to survive a bad/duplicate accelerator without taking the app down:
 * a failed binding is reported back rather than thrown.
 */

const { globalShortcut } = require('electron');
const store = require('./store');

let handlers = {};
const registered = new Set();

function unregisterAll() {
  for (const accel of registered) {
    try {
      globalShortcut.unregister(accel);
    } catch {
      /* already gone */
    }
  }
  registered.clear();
}

function tryRegister(accelerator, callback) {
  if (!accelerator) return { ok: false, reason: 'empty' };
  try {
    const ok = globalShortcut.register(accelerator, callback);
    if (ok) {
      registered.add(accelerator);
      return { ok: true };
    }
    // Electron returns false when another app already owns the combination.
    return { ok: false, reason: 'taken' };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * (Re)binds every shortcut from the store.
 * @returns {{toggleShow: object, toggleClickThrough: object}} per-binding result
 */
function register(nextHandlers = handlers) {
  handlers = nextHandlers;
  unregisterAll();

  const accels = store.getShortcuts();
  return {
    toggleShow: tryRegister(accels.toggleShow, () => handlers.onToggleShow && handlers.onToggleShow()),
    toggleClickThrough: tryRegister(accels.toggleClickThrough, () =>
      handlers.onToggleClickThrough && handlers.onToggleClickThrough()
    ),
  };
}

function update(patch) {
  const previous = store.getShortcuts();
  store.setShortcuts(patch);
  const result = register();

  // Never persist an accelerator we could not actually claim, or the user ends
  // up with a shortcut that looks configured and silently does nothing.
  const failed = Object.keys(patch).filter((name) => result[name] && !result[name].ok);
  if (failed.length) {
    store.setShortcuts(Object.fromEntries(failed.map((name) => [name, previous[name]])));
    register();
  }

  return result;
}

module.exports = { register, update, unregisterAll };
