/**
 * DNS over HTTPS for the app's own windows.
 *
 * Some networks answer the system DNS query for an exchange's host with an
 * address that goes nowhere (Coinbase, from some Taiwanese ISPs, resolves to
 * a block page that never answers on 443). Asking Cloudflare or Google over
 * HTTPS gets the real address; the connection itself still goes straight
 * from this machine to the exchange, as before -- this is not a proxy or a
 * VPN, and nothing else on the machine is changed.
 *
 * It covers what Chromium fetches: the hub's market data and the cards. The
 * trading client in the main process uses Node's fetch, which keeps the
 * system resolver, so orders do not depend on it.
 *
 * On by default; the tray menu turns it off, which applies at once.
 */

const { app } = require('electron');

const SERVERS = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/dns-query'];

function apply(enabled) {
  try {
    app.configureHostResolver(
      enabled ? { secureDnsMode: 'secure', secureDnsServers: SERVERS } : { secureDnsMode: 'off', secureDnsServers: [] }
    );
  } catch (err) {
    console.warn('[dns] could not set the resolver', err && err.message);
  }
}

module.exports = { apply, SERVERS };
