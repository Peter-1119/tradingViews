'use strict';

/**
 * Serves the renderer over a privileged `app://bundle/...` scheme.
 *
 * Why not `file://`: Chromium refuses ES module imports from file:// origins
 * (opaque origin -> CORS failure), and the alternative of `webSecurity: false`
 * would defeat the security posture required by spec §3. A custom standard +
 * secure scheme gives us a real origin, working `<script type="module">`, and
 * a secure context (needed for WSS without downgrade warnings).
 */

const { protocol, net } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const SCHEME = 'app';
const HOST = 'bundle';
const ROOT = path.join(__dirname, '..', 'renderer');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/** Must run before `app.ready`. */
function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        codeCache: true,
      },
    },
  ]);
}

/** Must run after `app.ready`. */
function registerHandler() {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== HOST) {
      return new Response('Not found', { status: 404 });
    }

    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'card.html';
    const resolved = path.resolve(ROOT, relative);

    // Path-traversal guard: never serve anything outside renderer/.
    if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      const data = await fs.promises.readFile(resolved);
      const type = MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
      return new Response(data, { status: 200, headers: { 'content-type': type } });
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'EISDIR') {
        return new Response('Not found', { status: 404 });
      }
      return new Response('Internal error', { status: 500 });
    }
  });
}

/** Build an `app://bundle/...` URL, optionally with a query string. */
function url(page, query = {}) {
  const u = new URL(`${SCHEME}://${HOST}/${page}`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

module.exports = { SCHEME, HOST, ROOT, registerScheme, registerHandler, url, net, pathToFileURL };
