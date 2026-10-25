// Checks the English interface against the source (see renderer/i18n.js).
//
//   1. Every Chinese string literal in renderer/ and main/ is the argument of
//      t(...), or sits on a line marked `// i18n-ignore` (text that must stay
//      Chinese, such as a language's own name).
//   2. Every t('...') key is in renderer/i18n/en.json, with the same
//      {placeholders} on both sides.
//   3. No Chinese inside a template literal with ${...}: it cannot be a key.
//      Use t('... {name} ...', { name }) instead.
//
// Keys in en.json that no code uses are listed as a warning.
//
// usage: node scripts/check-i18n.mjs [--quiet] [--extra frag.json] [--only renderer/trade/]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HAN = /[㐀-鿿！-～　-〿]/;
const HAN_WORD = /[㐀-鿿]/;
const DICT_FILE = path.join(ROOT, 'renderer', 'i18n', 'en.json');
const SKIP = new Set(['i18n.js']);

// --extra a.json,b.json  merge more dictionaries in (fragments not yet in en.json)
// --only prefix          report only files whose path starts with prefix (repeatable)
const argv = process.argv.slice(2);
const opt = (name) => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []));
const dict = JSON.parse(fs.readFileSync(DICT_FILE, 'utf8'));
for (const extra of opt('--extra').flatMap((s) => s.split(','))) {
  Object.assign(dict, JSON.parse(fs.readFileSync(extra, 'utf8')));
}
const only = opt('--only');

function files(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'vendor' || entry.name === 'node_modules') continue;
      out.push(...files(p));
    } else if (entry.name.endsWith('.js') && !SKIP.has(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * The string literals of a JS source, with their offsets. A small scanner,
 * not a parser: comments and the three quote kinds, ${} nesting in templates.
 * Regex literals are not recognised; none of ours contain quotes.
 */
function literals(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  function readQuoted(q) {
    const start = i;
    i++;
    let value = '';
    while (i < n && src[i] !== q) {
      if (src[i] === '\\') {
        value += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (src[i] === '\n') break;
      value += src[i++];
    }
    i++;
    return { start, end: i, raw: value, quote: q, interp: false };
  }
  function readTemplate() {
    const start = i;
    i++;
    let value = '';
    let interp = false;
    while (i < n && src[i] !== '`') {
      if (src[i] === '\\') {
        value += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (src[i] === '$' && src[i + 1] === '{') {
        interp = true;
        i += 2;
        let depth = 1;
        value += '${';
        while (i < n && depth > 0) {
          const c = src[i];
          if (c === '{') depth++;
          else if (c === '}') depth--;
          else if (c === "'" || c === '"') {
            const inner = readQuoted(c);
            out.push(inner);
            value += "''"; // checked on its own
            continue;
          } else if (c === '`') {
            const inner = readTemplate();
            out.push(inner);
            value += "''"; // checked on its own
            continue;
          }
          if (depth > 0) value += c;
          i++;
        }
        value += '}';
        continue;
      }
      value += src[i++];
    }
    i++;
    return { start, end: i, raw: value, quote: '`', interp };
  }
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === "'" || c === '"') {
      out.push(readQuoted(c));
    } else if (c === '`') {
      out.push(readTemplate());
    } else {
      i++;
    }
  }
  return out;
}

/** The runtime value of a literal (escapes resolved): it is our own source. */
function valueOf(src, lit) {
  return new Function(`return ${src.slice(lit.start, lit.end)};`)();
}

function short(s) {
  return s.slice(0, 60).replace(/\s+/g, ' ');
}

function placeholders(s) {
  return [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
}

const errors = [];
const used = new Set();

for (const file of [...files(path.join(ROOT, 'renderer')), ...files(path.join(ROOT, 'main'))]) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  if (only.length && !only.some((p) => rel.startsWith(p))) continue;
  const lineOf = (offset) => src.slice(0, offset).split('\n').length;
  const lineText = (offset) => {
    const a = src.lastIndexOf('\n', offset) + 1;
    const b = src.indexOf('\n', offset);
    return src.slice(a, b < 0 ? src.length : b);
  };
  for (const lit of literals(src)) {
    const before = src.slice(Math.max(0, lit.start - 40), lit.start);
    const inT = /(?:^|[^\w.$])t\(\s*$/.test(before);
    // A key may hold only full-width punctuation and placeholders: '{text}（{code}）'.
    if (!HAN.test(lit.raw) && !(inT && !lit.interp && Object.prototype.hasOwnProperty.call(dict, valueOf(src, lit)))) continue;
    const line = lineOf(lit.start);
    if (/i18n-ignore/.test(lineText(lit.start))) continue;
    // Punctuation only, outside t(): '、', '（' -- fine either way.
    if (!HAN_WORD.test(lit.raw) && !inT) continue;
    if (lit.interp) {
      errors.push(`${rel}:${line}  Chinese in a \${} template: ${short(lit.raw)}`);
      continue;
    }
    if (!inT) {
      errors.push(`${rel}:${line}  not wrapped in t(): ${short(lit.raw)}`);
      continue;
    }
    const key = valueOf(src, lit);
    used.add(key);
    if (!Object.prototype.hasOwnProperty.call(dict, key)) {
      errors.push(`${rel}:${line}  missing from en.json: ${JSON.stringify(key).slice(0, 80)}`);
    } else if (placeholders(key) !== placeholders(dict[key])) {
      errors.push(`${rel}:${line}  placeholders differ: ${JSON.stringify(key).slice(0, 60)}`);
    } else if (HAN_WORD.test(dict[key])) {
      errors.push(`${rel}:${line}  English still has Chinese: ${JSON.stringify(dict[key]).slice(0, 60)}`);
    }
  }
}

const unused = Object.keys(dict).filter((k) => !used.has(k));
if (unused.length && !argv.includes('--quiet') && !only.length) {
  console.log(`[check-i18n] ${unused.length} key(s) in en.json not used by the code:`);
  for (const k of unused.slice(0, 40)) console.log('   ', JSON.stringify(k).slice(0, 80));
}
if (errors.length) {
  for (const e of errors) console.log(e);
  console.log(`[check-i18n] ${errors.length} problem(s)`);
  process.exit(1);
}
console.log(`[check-i18n] ${used.size} strings, all translated`);
