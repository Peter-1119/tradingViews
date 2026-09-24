/**
 * The watchlist dropdown under the symbol name.
 *
 * Built for the one-card habit: rather than opening settings, typing and
 * picking from search every time, the handful of symbols in regular use sit
 * one click (or Alt+1..6) away. The list itself is a global pref, so every
 * card sees the same one; this module only draws it and reports picks.
 *
 * Entries are {symbol, market}: the same symbol on spot and on perp are two
 * different rows, and picking one switches the card's market as well.
 */

import { el, prettySymbol, formatPrice, formatPercent, MARKET_LABELS } from '../util.js';

export const WATCHLIST_MAX = 6;

export function sameEntry(a, b) {
  return !!a && !!b && a.symbol === b.symbol && a.market === b.market;
}

/** "BTC/USDT", or "BTC/USDT 永續" -- spot is the unmarked default. */
export function entryLabel(entry) {
  const name = prettySymbol(entry.symbol);
  return entry.market === 'perp' ? `${name} ${MARKET_LABELS.perp}` : name;
}

const entryKey = (entry) => `${entry.market}:${entry.symbol}`;

export class WatchlistMenu {
  /**
   * @param {{
   *   feedFor: (market: string) => object,
   *   onPick: (entry: {symbol, market}) => void,
   *   onRemove: (entry: {symbol, market}) => void,
   *   onAdd: () => void,
   *   onSearch: () => void,
   * }} options
   */
  constructor({ feedFor, onPick, onRemove, onAdd, onSearch }) {
    this.feedFor = feedFor;
    this.onPick = onPick;
    this.onRemove = onRemove;
    this.onAdd = onAdd;
    this.onSearch = onSearch;
    this.list = [];
    this.current = null;
    /** "market:symbol" -> {last, changePercent}; kept across opens so rows never flash empty. */
    this.tickers = new Map();
    this.openSeq = 0;

    this.rows = el('div.card__watch-rows');
    this.root = el('div.card__watch', { hidden: true, role: 'menu' }, this.rows);

    // Anything outside the menu (and outside the symbol button, which toggles
    // it itself) closes it, as does Escape.
    this.onOutside = (event) => {
      if (!this.isOpen) return;
      if (this.root.contains(event.target)) return;
      if (this.anchor && this.anchor.contains(event.target)) return;
      this.close();
    };
    this.onKey = (event) => {
      if (this.isOpen && event.key === 'Escape') this.close();
    };
    window.addEventListener('mousedown', this.onOutside, true);
    window.addEventListener('keydown', this.onKey);
  }

  get isOpen() {
    return !this.root.hidden;
  }

  /** The element that toggles the menu; clicks on it are not "outside". */
  setAnchor(node) {
    this.anchor = node;
  }

  setState(list, current) {
    this.list = list;
    this.current = current;
    if (this.isOpen) this.render();
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  open() {
    this.root.hidden = false;
    this.render();
    this.refreshTickers();
  }

  close() {
    this.root.hidden = true;
    this.openSeq += 1;
  }

  /** One REST round per symbol, only while the menu is open -- no standing streams. */
  refreshTickers() {
    const seq = ++this.openSeq;
    for (const entry of this.list) {
      this.feedFor(entry.market)
        .getTicker(entry.symbol)
        .then((t) => {
          if (seq !== this.openSeq || !t) return;
          this.tickers.set(entryKey(entry), { last: t.last, changePercent: t.changePercent });
          this.render();
        })
        .catch(() => {
          /* a row without a quote is still a working shortcut */
        });
    }
  }

  render() {
    const rows = this.list.map((entry, index) => {
      const t = this.tickers.get(entryKey(entry));
      const current = sameEntry(entry, this.current);
      const change = el('span.card__watch-change', { text: t ? formatPercent(t.changePercent) : '' });
      if (t) change.classList.add(t.changePercent >= 0 ? 'is-up' : 'is-down');
      const remove = el('button.card__watch-remove', {
        type: 'button',
        title: '從常用清單移除',
        text: '✕',
        onclick: (event) => {
          event.stopPropagation();
          this.onRemove(entry);
        },
      });
      return el(
        'div.card__watch-row',
        {
          role: 'menuitem',
          class: current ? 'is-current' : '',
          title: `切換到 ${entryLabel(entry)} (Alt+${index + 1})`,
          onclick: () => {
            this.close();
            if (!current) this.onPick(entry);
          },
        },
        el('span.card__watch-key', { text: String(index + 1) }),
        el(
          'span.card__watch-symbol',
          {},
          prettySymbol(entry.symbol),
          entry.market === 'perp' ? el('span.card__watch-market', { text: MARKET_LABELS.perp }) : null
        ),
        el('span.card__watch-price', { text: t ? formatPrice(t.last) : '' }),
        change,
        remove
      );
    });

    if (!this.list.length) {
      rows.push(el('div.card__watch-empty', { text: '還沒有常用幣種。點名稱旁的 ☆ 把目前的幣種加進來。' }));
    }

    const actions = [];
    if (this.current && !this.list.some((e) => sameEntry(e, this.current))) {
      const full = this.list.length >= WATCHLIST_MAX;
      actions.push(
        el('button.card__watch-action', {
          type: 'button',
          disabled: full,
          text: full ? `清單已滿 (最多 ${WATCHLIST_MAX} 個)` : `＋ 加入 ${entryLabel(this.current)}`,
          onclick: () => this.onAdd(),
        })
      );
    }
    actions.push(
      el('button.card__watch-action', {
        type: 'button',
        text: '🔍 搜尋其他幣種…',
        onclick: () => {
          this.close();
          this.onSearch();
        },
      })
    );

    this.rows.replaceChildren(...rows, el('div.card__watch-actions', {}, actions));
  }

  destroy() {
    window.removeEventListener('mousedown', this.onOutside, true);
    window.removeEventListener('keydown', this.onKey);
    this.root.remove();
  }
}
