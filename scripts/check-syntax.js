/**
 * Syntax gate for the whole source tree.
 *
 * The renderer is authored as ES modules in `.js` files (they are served over
 * the app:// protocol, not resolved by Node), so `node --check` would parse
 * them as CommonJS and reject every `import`. This copies each file to a
 * temporary `.mjs` before checking so both dialects are validated correctly.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CJS_DIRS = ['main', 'preload', 'scripts'];
const ESM_DIRS = ['renderer'];
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'release', '.git']);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function check(file, asModule) {
  let target = file;
  let temp = null;
  if (asModule) {
    temp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-check-')), 'mod.mjs');
    fs.copyFileSync(file, temp);
    target = temp;
  }
  try {
    execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
    return null;
  } catch (err) {
    return String(err.stderr || err.message);
  } finally {
    if (temp) fs.rmSync(path.dirname(temp), { recursive: true, force: true });
  }
}

let failures = 0;
let checked = 0;

for (const [dirs, asModule] of [
  [CJS_DIRS, false],
  [ESM_DIRS, true],
]) {
  for (const dir of dirs) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const file of walk(abs)) {
      checked += 1;
      const error = check(file, asModule);
      if (error) {
        failures += 1;
        console.error(`FAIL ${path.relative(ROOT, file)}\n${error}`);
      }
    }
  }
}

console.log(`[check-syntax] ${checked} files checked, ${failures} failed`);
process.exitCode = failures ? 1 : 0;
