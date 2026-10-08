'use strict';

/**
 * API credentials, encrypted at rest with Electron's safeStorage -- DPAPI on
 * Windows, so the file is only readable by this Windows user on this machine.
 *
 * Two kinds of key, as Binance issues them:
 *
 *   hmac             "System generated": an API key and a secret, both strings
 *   ed25519 / rsa    "Self-generated": an API key and the private key of a pair
 *                    whose public half was uploaded to Binance. Read from a
 *                    .pem file chosen in a dialog in the main process, so the
 *                    private key never passes through a renderer at all.
 *
 * The secret never leaves the main process: renderers can set or clear a key
 * and see its last four characters and its type, nothing more. And if the OS
 * offers no encryption, nothing is stored at all -- a plaintext secret on disk
 * is not a fallback worth having for a key that can trade.
 */

const crypto = require('crypto');
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
      if (!entry || typeof entry.apiKey !== 'string') continue;
      // Entries saved before self-generated keys existed have no type: HMAC.
      if (typeof entry.secret === 'string') cache[env] = { type: 'hmac', ...entry };
      else if (typeof entry.privateKey === 'string' && (entry.type === 'ed25519' || entry.type === 'rsa')) cache[env] = entry;
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

function cleanApiKey(apiKey) {
  const key = String(apiKey || '').trim();
  // Binance keys are 64 alphanumerics; be a little lenient, but refuse junk.
  if (!/^[A-Za-z0-9]{16,128}$/.test(key)) throw new Error('API Key 格式不對（應為英數字）');
  return key;
}

/** A System-generated (HMAC) key. */
function set(env, apiKey, secret) {
  if (!ENVS.includes(env)) throw new Error('unknown environment');
  const key = cleanApiKey(apiKey);
  const sec = String(secret || '').trim();
  if (!/^[A-Za-z0-9]{16,128}$/.test(sec)) throw new Error('Secret Key 格式不對（應為英數字）');
  writeAll({ ...readAll(), [env]: { type: 'hmac', apiKey: key, secret: sec } });
}

/**
 * A Self-generated key: the API key Binance issued for the uploaded public
 * key, and the private key from its .pem file. Checked before it is stored:
 * a public key, an encrypted key or anything but Ed25519 or RSA is refused
 * with a reason, rather than saved and failing on the first order.
 */
function setPrivateKey(env, apiKey, pem) {
  if (!ENVS.includes(env)) throw new Error('unknown environment');
  const key = cleanApiKey(apiKey);
  const text = String(pem || '');
  if (/BEGIN PUBLIC KEY/.test(text)) throw new Error('這是公鑰檔案。請選私鑰（-----BEGIN PRIVATE KEY-----）那個檔案');
  if (/ENCRYPTED/.test(text)) throw new Error('這把私鑰有設定密碼，目前不支援。請產生沒有密碼的私鑰');
  let object;
  try {
    object = crypto.createPrivateKey(text);
  } catch {
    throw new Error('讀不出私鑰：請確認選的是 .pem 格式的私鑰檔案');
  }
  const type = object.asymmetricKeyType;
  if (type !== 'ed25519' && type !== 'rsa') throw new Error(`不支援的金鑰類型：${type}（請用 Ed25519 或 RSA）`);
  const privateKey = object.export({ type: 'pkcs8', format: 'pem' });
  writeAll({ ...readAll(), [env]: { type, apiKey: key, privateKey } });
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

/** What a renderer may know: whether a key exists, its tail, and its type. */
function describe(env) {
  const entry = get(env);
  return entry
    ? { configured: true, keyTail: entry.apiKey.slice(-4), type: entry.type }
    : { configured: false, keyTail: '', type: '' };
}

module.exports = { ENVS, get, set, setPrivateKey, clear, describe };
