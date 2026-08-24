/**
 * Copies the lightweight-charts ESM standalone build out of node_modules into
 * renderer/vendor/ so the renderer can `import` it over the app:// protocol
 * without a bundler and without any CDN (offline-capable shell, per spec §2).
 * Runs automatically on `npm install` via the postinstall hook.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'renderer', 'vendor');
const OUT_FILE = path.join(OUT_DIR, 'lightweight-charts.mjs');

const CANDIDATES = [
  'dist/lightweight-charts.standalone.production.mjs',
  'dist/lightweight-charts.production.mjs',
  'dist/lightweight-charts.standalone.production.js',
];

function main() {
  const pkgDir = path.join(ROOT, 'node_modules', 'lightweight-charts');
  if (!fs.existsSync(pkgDir)) {
    console.warn('[sync-vendor] lightweight-charts not installed yet, skipping.');
    return;
  }

  const src = CANDIDATES.map((p) => path.join(pkgDir, p)).find((p) => fs.existsSync(p));
  if (!src) {
    console.error('[sync-vendor] No usable lightweight-charts build found in', pkgDir);
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.copyFileSync(src, OUT_FILE);

  const version = JSON.parse(
    fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')
  ).version;
  console.log(`[sync-vendor] lightweight-charts v${version} -> renderer/vendor/lightweight-charts.mjs`);
}

main();
