'use strict';

/**
 * Local bar cache: fixed-width binary, chunked by time.
 *
 * Layout
 * ------
 *   userData/bars/{SYMBOL}/{interval}/{chunk}.bin
 *
 * Each record is 48 bytes -- six float64, little endian:
 *
 *   [ time, open, high, low, close, volume ]
 *
 * float64 throughout, including the timestamp, so a whole file is one
 * Float64Array and reading it is a memcpy rather than a parse. A float64 holds
 * every integer to 2^53 exactly and epoch seconds are ~1.8e9, so nothing is
 * lost. float32 would halve the size and cannot be used: 86543.21 comes back as
 * 86543.2109375, and every realistic crypto price is affected.
 *
 * Why chunks
 * ----------
 * Live bars arrive newest-first and append; backfill arrives oldest-first and
 * would have to *prepend*, which a flat file cannot do. Chunking by time means
 * backfill writes a different file instead, so every file stays append-only and
 * internally sorted, chunk order is filename order, and there is never a global
 * sort or a whole-history rewrite. The alternative -- one flat file re-sorted at
 * startup -- costs ~9s of read/sort/write across ten symbols before the first
 * card can draw, and pays it on every launch regardless of what gets looked at.
 *
 * Only closed bars are ever written. The last bar of any Binance response is
 * still forming, and caching it would mean a request that happens to cross a
 * candle boundary bakes half a candle into the file permanently.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const FIELDS = 6;
const RECORD = FIELDS * 8;

/**
 * 1m and 5m get a month per file; everything coarser gets a year. Keeps every
 * chunk in the low megabytes -- a month of 1m bars is ~2MB, a year of 1h is
 * ~0.4MB -- so the occasional whole-chunk rewrite stays cheap.
 */
const MONTHLY = new Set(['1m', '5m']);

let rootDir = null;

function root() {
  if (!rootDir) rootDir = path.join(app.getPath('userData'), 'bars');
  return rootDir;
}

function safeName(value) {
  // Symbols and intervals both come from our own allow-lists, but these end up
  // as path segments, so treat them as untrusted anyway.
  return String(value || '').replace(/[^A-Za-z0-9_-]/g, '');
}

function chunkKey(interval, timeSec) {
  const d = new Date(timeSec * 1000);
  const year = d.getUTCFullYear();
  if (!MONTHLY.has(interval)) return String(year);
  return `${year}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function chunkDir(symbol, interval) {
  return path.join(root(), safeName(symbol).toUpperCase(), safeName(interval));
}

function chunkPath(symbol, interval, key) {
  return path.join(chunkDir(symbol, interval), `${key}.bin`);
}

/* ------------------------------------------------------------ encode/decode */

function encode(bars) {
  const a = new Float64Array(bars.length * FIELDS);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const o = i * FIELDS;
    a[o] = b.time;
    a[o + 1] = b.open;
    a[o + 2] = b.high;
    a[o + 3] = b.low;
    a[o + 4] = b.close;
    a[o + 5] = b.volume;
  }
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength);
}

function decode(buf) {
  // A truncated tail means a write was interrupted; drop the partial record
  // rather than handing back a bar with garbage in it.
  const count = Math.floor(buf.length / RECORD);
  const out = new Array(count);
  const a = new Float64Array(buf.buffer, buf.byteOffset, count * FIELDS);
  for (let i = 0; i < count; i++) {
    const o = i * FIELDS;
    out[i] = {
      time: a[o],
      open: a[o + 1],
      high: a[o + 2],
      low: a[o + 3],
      close: a[o + 4],
      volume: a[o + 5],
      closed: true,
    };
  }
  return out;
}

function readChunk(symbol, interval, key) {
  try {
    return decode(fs.readFileSync(chunkPath(symbol, interval, key)));
  } catch {
    return [];
  }
}

/* --------------------------------------------------------------------- api */

/** Chunk keys present on disk, in ascending order. */
function chunkKeys(symbol, interval) {
  try {
    return fs
      .readdirSync(chunkDir(symbol, interval))
      .filter((name) => name.endsWith('.bin'))
      .map((name) => name.slice(0, -4))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Cached bars within [fromSec, toSec], ascending.
 * Chunks never overlap and each is internally sorted, so concatenating them in
 * filename order is already sorted -- no merge step.
 */
function read(symbol, interval, fromSec, toSec) {
  const from = Number(fromSec);
  const to = Number(toSec);
  const out = [];
  for (const key of chunkKeys(symbol, interval)) {
    for (const bar of readChunk(symbol, interval, key)) {
      if (bar.time >= from && bar.time <= to) out.push(bar);
    }
  }
  return out;
}

/** The newest cached bar time for a symbol+interval, or 0. */
function latest(symbol, interval) {
  const keys = chunkKeys(symbol, interval);
  for (let i = keys.length - 1; i >= 0; i--) {
    const bars = readChunk(symbol, interval, keys[i]);
    if (bars.length) return bars[bars.length - 1].time;
  }
  return 0;
}

/**
 * Persist closed bars.
 *
 * Bars newer than everything in their chunk append, which is the live case and
 * costs one ~48-byte write. Anything landing inside a chunk's existing span
 * rewrites just that chunk -- bounded by the chunk size, and rare, since
 * backfill normally opens older chunks that do not exist yet.
 */
function write(symbol, interval, bars) {
  const closed = (Array.isArray(bars) ? bars : []).filter(
    (b) => b && b.closed === true && Number.isFinite(b.time) && Number.isFinite(b.close)
  );
  if (!closed.length) return 0;

  const byChunk = new Map();
  for (const bar of closed) {
    const key = chunkKey(interval, bar.time);
    if (!byChunk.has(key)) byChunk.set(key, []);
    byChunk.get(key).push(bar);
  }

  fs.mkdirSync(chunkDir(symbol, interval), { recursive: true });
  let written = 0;

  for (const [key, incoming] of byChunk) {
    incoming.sort((a, b) => a.time - b.time);
    const file = chunkPath(symbol, interval, key);
    const existing = readChunk(symbol, interval, key);

    if (!existing.length) {
      fs.writeFileSync(file, encode(incoming));
      written += incoming.length;
      continue;
    }

    const maxTime = existing[existing.length - 1].time;
    const fresh = incoming.filter((b) => b.time > maxTime);

    if (fresh.length === incoming.length) {
      fs.appendFileSync(file, encode(fresh));
      written += fresh.length;
      continue;
    }

    // Overlaps what is already there: merge this one chunk and rewrite it.
    const merged = new Map();
    for (const bar of existing) merged.set(bar.time, bar);
    for (const bar of incoming) merged.set(bar.time, bar);
    const sorted = [...merged.values()].sort((a, b) => a.time - b.time);
    fs.writeFileSync(file, encode(sorted));
    written += sorted.length - existing.length;
  }
  return written;
}

function stats() {
  let files = 0;
  let bytes = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.bin')) {
        files += 1;
        try {
          bytes += fs.statSync(full).size;
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  };
  walk(root());
  return { files, bytes, bars: Math.floor(bytes / RECORD), dir: root() };
}

function clear(symbol) {
  const target = symbol ? path.join(root(), safeName(symbol).toUpperCase()) : root();
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    /* nothing to remove */
  }
  return stats();
}

module.exports = {
  RECORD,
  chunkKey,
  read,
  write,
  latest,
  chunkKeys,
  stats,
  clear,
  /** Test seam: point the cache somewhere other than userData. */
  _setRoot(dir) {
    rootDir = dir;
  },
};
