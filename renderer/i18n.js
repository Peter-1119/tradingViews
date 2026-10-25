/**
 * The interface language.
 *
 * The source strings stay in Chinese and double as the keys: `t('游標')` is
 * '游標' in Chinese and whatever i18n/en.json maps it to in English. Nothing
 * has to be named twice, and a string missing from the dictionary falls back
 * to the Chinese it was written in rather than to a bare key.
 *
 * Placeholders are `{name}`: t('每 {n} 小時', { n: 4 }).
 *
 * The language is read once, before any module that uses t() runs (this one
 * awaits at the top level, and ES modules wait for their imports), so module
 * constants such as the rail's tool list can call t() where they are defined.
 * Switching language reloads the windows (see prefs:set in main.js).
 */

/** 'zh-TW' or 'en'. */
export let language = 'zh-TW';
let dict = null;

const api = typeof window !== 'undefined' ? window.stockcard : null;
if (api && api.getPrefs) {
  try {
    const prefs = await api.getPrefs();
    if (prefs && prefs.language === 'en') {
      dict = await (await fetch(new URL('./i18n/en.json', import.meta.url))).json();
      language = 'en';
    }
  } catch (err) {
    console.error('[i18n] falling back to Chinese', err);
    dict = null;
    language = 'zh-TW';
  }
  if (typeof document !== 'undefined') {
    document.documentElement.lang = language === 'en' ? 'en' : 'zh-Hant';
  }
}

/** Fill `{name}` placeholders. */
function fill(text, vars) {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** Translate a Chinese source string. */
export function t(key, vars) {
  const text = dict && Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
  return fill(text, vars);
}

/** True when the interface is in English. */
export function isEnglish() {
  return language === 'en';
}

/** The locale for Intl / toLocaleString, matching the interface. */
export function locale() {
  return language === 'en' ? 'en-US' : 'zh-TW';
}
