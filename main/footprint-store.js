'use strict';

/**
 * Footprint cache: per minute, per price, what taker sellers and taker buyers
 * took. The hub collects it from the aggTrade stream (and the REST endpoint
 * for minutes it missed); this keeps the closed, complete minutes on disk so a
 * restart does not start from nothing.
 *
 * Layout
 * ------
 *   userData/footprint/{SYMBOL}/{hourStart}.fp          spot
 *   userData/footprint/_perp/{SYMBOL}/{hourStart}.fp    USD-M perpetuals
 *
 * One file per UTC hour, and only the last RETAIN_SEC of them are kept: the
 * footprint is read for the last few dozen bars, never for history, so the
 * directory stays a rolling window instead of growing for ever.
 *
 * Encoding
 * --------
 * Each minute is one gzip member appended to its hour's file (gzip members
 * concatenate, and gunzip reads them all back as one stream), so writing is an
 * append and never a rewrite. Inside, everything is an unsigned varint:
 *
 *   [minute] [log10 priceScale] [log10 qtyScale] [firstId] [lastId - firstId]
 *   [levels] [first price key] then per level: [key gap] [sell] [buy]
 *
 * Prices are integer keys -- price * priceScale, the scale being 10^decimals
 * of the exchange's own price strings -- so consecutive levels are a gap of 1
 * and take a byte. Quantities are whole multiples of the lot step, stored as
 * integers of qtyScale, so nothing is rounded. Measured on BTCUSDT perpetual:
 * ~1270 price levels a minute is ~25KB as float64 records and ~2.3KB this way.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/** Twelve hours: 5m bars x 30 with room to spare, and 15m x 48. */
const RETAIN_SEC = 12 * 3600;
const HOUR = 3600;

let rootDir = null;

function root() {
  if (!rootDir) rootDir = path.join(require('electron').app.getPath('userData'), 'footprint');
  return rootDir;
}

/** Tests point the store at a temporary directory. */
function _setRoot(dir) {
  rootDir = dir;
}

function safeName(value) {
  return String(value || '').replace(/[^A-Za-z0-9_-]/g, '');
}

function symbolDir(symbol, market) {
  const sym = safeName(String(symbol).toUpperCase());
  return market === 'perp' ? path.join(root(), '_perp', sym) : path.join(root(), sym);
}

/* ------------------------------------------------------------- varints */

function putVarint(out, value) {
  let v = Math.max(0, Math.round(Number(value) || 0));
  // Arithmetic rather than bit operators: trade ids pass 2^31.
  while (v >= 128) {
    out.push((v % 128) | 128);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

function reader(buf) {
  let pos = 0;
  return {
    get done() {
      return pos >= buf.length;
    },
    next() {
      let value = 0;
      let mul = 1;
      for (;;) {
        if (pos >= buf.length) throw new Error('truncated footprint record');
        const byte = buf[pos++];
        value += (byte & 127) * mul;
        if (byte < 128) return value;
        mul *= 128;
      }
    },
  };
}

const log10 = (scale) => Math.round(Math.log10(scale));

/**
 * One minute -> raw (uncompressed) bytes.
 * @param {{t, scale, qscale, keys, sell, buy, firstId, lastId}} rec
 */
function encodeRaw(rec, out = []) {
  const n = rec.keys.length;
  putVarint(out, rec.t / 60);
  putVarint(out, log10(rec.scale));
  putVarint(out, log10(rec.qscale));
  putVarint(out, rec.firstId || 0);
  putVarint(out, Math.max(0, (rec.lastId || 0) - (rec.firstId || 0)));
  putVarint(out, n);
  if (n) putVarint(out, rec.keys[0]);
  for (let i = 0; i < n; i++) {
    putVarint(out, i ? rec.keys[i] - rec.keys[i - 1] : 0);
    putVarint(out, rec.sell[i] * rec.qscale);
    putVarint(out, rec.buy[i] * rec.qscale);
  }
  return out;
}

function decodeRaw(buf, { tolerant = false } = {}) {
  const r = reader(buf);
  const out = [];
  while (!r.done) {
    try {
      out.push(decodeOne(r));
    } catch (err) {
      if (!tolerant) throw err;
      break;
    }
  }
  return out;
}

function decodeOne(r) {
  const t = r.next() * 60;
  const scale = 10 ** r.next();
  const qscale = 10 ** r.next();
  const firstId = r.next();
  const lastId = firstId + r.next();
  const n = r.next();
  const keys = new Float64Array(n);
  const sell = new Float64Array(n);
  const buy = new Float64Array(n);
  let key = n ? r.next() : 0;
  for (let i = 0; i < n; i++) {
    key += r.next();
    keys[i] = key;
    sell[i] = r.next() / qscale;
    buy[i] = r.next() / qscale;
  }
  return { t, scale, qscale, keys, sell, buy, firstId, lastId, complete: true, closed: true };
}

/** One minute -> one gzip member, ready to append. */
function encode(rec) {
  return zlib.gzipSync(Buffer.from(encodeRaw(rec)), { level: 9 });
}

/** A whole file (any number of members) -> minutes. */
function decode(buf) {
  if (!buf.length) return [];
  return decodeRaw(zlib.gunzipSync(buf));
}

/**
 * What can be read from a file whose last append was torn (the app killed
 * mid-write): every whole minute before the tear.
 */
function salvage(buf) {
  try {
    const raw = zlib.gunzipSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    return decodeRaw(raw, { tolerant: true });
  } catch {
    return [];
  }
}

/* --------------------------------------------------------------- files */

function hourFiles(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /^\d+\.fp$/.test(f))
      .map((f) => ({ name: f, hour: Number(f.slice(0, -3)) }));
  } catch {
    return [];
  }
}

function prune(dir, nowSec) {
  const cutoff = nowSec - RETAIN_SEC - HOUR;
  for (const f of hourFiles(dir)) {
    if (f.hour < cutoff) fs.rmSync(path.join(dir, f.name), { force: true });
  }
}

/**
 * Append closed, complete minutes. Anything older than the retention window
 * is not worth a write. Returns how many were written.
 */
function write(symbol, records, market, nowSec = Date.now() / 1000) {
  if (!symbol || !Array.isArray(records) || !records.length) return 0;
  const dir = symbolDir(symbol, market);
  fs.mkdirSync(dir, { recursive: true });
  const byHour = new Map();
  for (const rec of records) {
    if (!rec || !Number.isFinite(rec.t) || !rec.keys || rec.t < nowSec - RETAIN_SEC) continue;
    const hour = Math.floor(rec.t / HOUR) * HOUR;
    if (!byHour.has(hour)) byHour.set(hour, []);
    byHour.get(hour).push(encode(rec));
  }
  let written = 0;
  for (const [hour, members] of byHour) {
    fs.appendFileSync(path.join(dir, `${hour}.fp`), Buffer.concat(members));
    written += members.length;
  }
  prune(dir, nowSec);
  return written;
}

/**
 * Minutes in [fromSec, toSec), oldest first. A minute written twice -- a
 * repair after a partial one -- reads back as its last write.
 */
function read(symbol, fromSec, toSec, market) {
  const dir = symbolDir(symbol, market);
  const from = Number(fromSec) || 0;
  const to = Number.isFinite(Number(toSec)) ? Number(toSec) : Infinity;
  const byMinute = new Map();
  for (const f of hourFiles(dir).sort((a, b) => a.hour - b.hour)) {
    if (f.hour + HOUR <= from || f.hour >= to) continue;
    const file = path.join(dir, f.name);
    let recs;
    try {
      recs = decode(fs.readFileSync(file));
    } catch {
      // A torn append would also hide every minute appended after it, so the
      // file is rewritten from what survives.
      recs = salvage(fs.readFileSync(file));
      fs.writeFileSync(file, Buffer.concat(recs.map(encode)));
    }
    for (const rec of recs) if (rec.t >= from && rec.t < to) byMinute.set(rec.t, rec);
  }
  return [...byMinute.values()].sort((a, b) => a.t - b.t);
}

module.exports = { read, write, encode, decode, salvage, encodeRaw, decodeRaw, RETAIN_SEC, _setRoot };
