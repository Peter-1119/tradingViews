/**
 * The interface language, for text the main process shows (tray menu,
 * notifications, order errors). Same scheme as renderer/i18n.js: the Chinese
 * source string is the key, renderer/i18n/en.json holds the English.
 *
 * The language is read from the store on every call, so the tray follows a
 * switch without a restart. The store is required lazily: the trading tests
 * load modules that call t() without an Electron app around them, and get
 * the Chinese.
 */

const path = require('path');
const fs = require('fs');

let dict = null;

function english() {
  if (!process.versions.electron) return false;
  try {
    return require('./store').get('language') !== 'zh-TW';
  } catch {
    return false;
  }
}

function load() {
  if (!dict) {
    try {
      dict = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'i18n', 'en.json'), 'utf8'));
    } catch {
      dict = {};
    }
  }
  return dict;
}

function fill(text, vars) {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** Translate a Chinese source string. */
function t(key, vars) {
  let text = key;
  if (english()) {
    const d = load();
    if (Object.prototype.hasOwnProperty.call(d, key)) text = d[key];
  }
  return fill(text, vars);
}

module.exports = { t, english };
