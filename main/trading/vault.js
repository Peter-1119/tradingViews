'use strict';

/**
 * API credentials, encrypted at rest with Electron's safeStorage -- DPAPI on
 * Windows, so the file is only readable by this Windows user on this machine.
 *
 * The secret never leaves the main process: renderers can set or clear a key
 * and see its last four characters, nothing more. And if the OS offers no
 * encryption, nothing is stored at all -- a plaintext secret on disk is not a
 * fallback worth having for a key that can trade.
 */

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const ENVS = ['testnet', 'live'];

let cache = null;

function file() {
  return path.join(app.getPath('userData'), 'trading-credentials.bin');
}

function readAll() {
  if (cache) return cache;
  cache = {};
  try {
    const raw = fs.readFileSync(file());
    if (!safeStorage.isEncryptionAvailable()) return cache;
    const parsed = JSON.parse(safeStorage.decryptString(raw));
    for (const env of ENVS) {
      const entry = parsed && parsed[env];
      if (entry && typeof entry.apiKey === 'string' && typeof entry.secret === 'string') cache[env] = entry;
    }
  } catch {
    /* missing or unreadable (another user / machine): no keys */
  }
  return cache;
}

function writeAll(all) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('這台電腦無法加密儲存金鑰（系統加密服務不可用），因此不會保存');
  }
  const tmp = `${file()}.tmp`;
  fs.writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(all)));
  fs.renameSync(tmp, file());
  cache = all;
}

function get(env) {
  return readAll()[env] || null;
}

function set(env, apiKey, secret) {
  if (!ENVS.includes(env)) throw new Error('unknown environment');
  const key = String(apiKey || '').trim();
  const sec = String(secret || '').trim();
  // Binance keys are 64 alphanumerics; be a little lenient, but refuse junk.
  if (!/^[A-Za-z0-9]{16,128}$/.test(key) || !/^[A-Za-z0-9]{16,128}$/.test(sec)) {
    throw new Error('API Key 或 Secret 格式不對（應為英數字）');
  }
  writeAll({ ...readAll(), [env]: { apiKey: key, secret: sec } });
}

function clear(env) {
  const all = { ...readAll() };
  delete all[env];
  if (Object.keys(all).length) writeAll(all);
  else {
    try {
      fs.unlinkSync(file());
    } catch {
      /* already gone */
    }
    cache = {};
  }
}

/** What a renderer may know: whether a key exists, and its tail. */
function describe(env) {
  const entry = get(env);
  return entry ? { configured: true, keyTail: entry.apiKey.slice(-4) } : { configured: false, keyTail: '' };
}

module.exports = { ENVS, get, set, clear, describe };
