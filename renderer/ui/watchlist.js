/**
 * The watchlist dropdown under the symbol name.
 *
 * Built for the one-card habit: rather than opening settings, typing and
 * picking from search every time, the handful of symbols in regular use sit
 * one click (or Alt+1..9, 0) away. The list itself is a global pref, so every
 * card sees the same one; this module only draws it and reports picks.
 *
 * Entries are {symbol, market}: the same symbol on spot and on perp are two
 * different rows, and picking one switches the card's market as well.
 *
 * Rows reorder by dragging: press one and move, and the others slide aside
 * to make room, so the digit keys follow the new order.
 */

import { el, prettySymbol, formatPrice, formatPercent, MARKET_LABELS } from '../util.js';
import { t } from '../i18n.js';

/** Keep in step with main/store.js. One per digit key. */
export const WATCHLIST_MAX = 10;

/**
 * The digit that reaches entry `index`: keyboard order, 1..9 then 0, so the
 * first entry is on 1 (0 is a stretch from the left hand) and the tenth on 0.
 */
export function watchKey(index) {
  return index < 9 ? String(index + 1) : '0';
}

/** The entry index a digit key reaches, or -1. */
export function watchIndex(digit) {
  const d = Number(digit);
  if (!Number.isInteger(d) || d < 0 || d > 9) return -1;
  return d === 0 ? 9 : d - 1;
}

export function sameEntry(a, b) {
  return !!a && !!b && a.symbol === b.symbol && a.market === b.market;
}

/** "BTC/USDT", or "BTC/USDT 永續" -- spot is the unmarked default. */
export function entryLabel(entry) {
  const name = prettySymbol(entry.symbol);
  return entry.market === 'perp' ? `${name} ${MARKET_LABELS.perp}` : name;
}

const entryKey = (entry) => `${entry.market}:${entry.symbol}`;

/** Movement before a press becomes a drag; less is a click. */
const DRAG_START_PX = 4;

/** `list` with the entry at `from` moved to `to`. */
export function moveEntry(list, from, to) {
  const next = list.slice();
  const [entry] = next.splice(from, 1);
  next.splice(to, 0, entry);
  return next;
}

export class WatchlistMenu {
  /**
   * @param {{
   *   feedFor: (market: string) => object,
   *   onPick: (entry: {symbol, market}) => void,
   *   onRemove: (entry: {symbol, market}) => void,
   *   onAdd: () => void,
   *   onSearch: () => void,
   *   onToggleAlert: (entry: {symbol, market, alert}) => void,
   *   onReorder: (list: Array<{symbol, market}>) => void,
   * }} options
   */
  constructor({ feedFor, onPick, onRemove, onAdd, onSearch, onToggleAlert, onReorder }) {
    this.feedFor = feedFor;
    this.onPick = onPick;
    this.onRemove = onRemove;
    this.onAdd = onAdd;
    this.onSearch = onSearch;
    this.onToggleAlert = onToggleAlert;
    this.onReorder = onReorder;
    /** The row being pressed or dragged: {index, startY, step, target, rows, active}. */
    this.drag = null;
    /** Set when a drag ends, so the click that follows the release is not a pick. */
    this.dragged = false;
    /** A render that came in mid-drag (a ticker, a prefs echo), run once it ends. */
    this.renderPending = false;
    /** The tray's master switch: a symbol alerts only when this and its own bell are on. */
    this.alertsOn = true;
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
      if (!this.isOpen || event.key !== 'Escape') return;
      // Escape mid-drag puts the row back; a second one closes the menu.
      if (this.drag && this.drag.active) this.endDrag(false);
      else this.close();
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

  setState(list, current, alertsOn = true) {
    this.list = list;
    this.current = current;
    this.alertsOn = alertsOn;
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
    if (this.drag) this.endDrag(false);
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
    if (this.drag) {
      this.renderPending = true;
      return;
    }
    const rows = this.list.map((entry, index) => {
      const tick = this.tickers.get(entryKey(entry));
      const current = sameEntry(entry, this.current);
      const change = el('span.card__watch-change', { text: tick ? formatPercent(tick.changePercent) : '' });
      if (tick) change.classList.add(tick.changePercent >= 0 ? 'is-up' : 'is-down');
      const remove = el('button.card__watch-remove', {
        type: 'button',
        title: t('從常用清單移除'),
        text: '✕',
        onclick: (event) => {
          event.stopPropagation();
          this.onRemove(entry);
        },
      });
      const on = entry.alert !== false;
      const bell = el('button.card__watch-bell', {
        type: 'button',
        class: on && this.alertsOn ? 'is-on' : '',
        title: !this.alertsOn
          ? (on ? t('位置提醒總開關已關閉（系統匣右鍵開啟）') : t('位置提醒總開關已關閉（系統匣右鍵開啟）；這個幣種也已關閉'))
          : on
            ? t('位置提醒：開（點一下關閉這個幣種）')
            : t('位置提醒：關（點一下開啟這個幣種）'),
        text: on ? '🔔' : '🔕',
        onclick: (event) => {
          event.stopPropagation();
          this.onToggleAlert({ ...entry, alert: !on });
        },
      });
      return el(
        'div.card__watch-row',
        {
          role: 'menuitem',
          class: current ? 'is-current' : '',
          title: `${t('切換到 {name} (Alt+{n})', { name: entryLabel(entry), n: watchKey(index) })}\n${t('按住拖曳可調整順序')}`,
          onpointerdown: (event) => this.pressRow(event, index),
          onclick: () => {
            if (this.dragged) {
              this.dragged = false;
              return;
            }
            this.close();
            if (!current) this.onPick(entry);
          },
        },
        el('span.card__watch-key', { text: watchKey(index) }),
        el(
          'span.card__watch-symbol',
          {},
          prettySymbol(entry.symbol),
          entry.market === 'perp' ? el('span.card__watch-market', { text: MARKET_LABELS.perp }) : null
        ),
        el('span.card__watch-price', { text: tick ? formatPrice(tick.last) : '' }),
        change,
        bell,
        remove
      );
    });

    if (!this.list.length) {
      rows.push(el('div.card__watch-empty', { text: t('還沒有常用幣種。點名稱旁的 ☆ 把目前的幣種加進來。') }));
    }

    const actions = [];
    if (this.current && !this.list.some((e) => sameEntry(e, this.current))) {
      const full = this.list.length >= WATCHLIST_MAX;
      actions.push(
        el('button.card__watch-action', {
          type: 'button',
          disabled: full,
          text: full
            ? t('清單已滿 (最多 {max} 個)', { max: WATCHLIST_MAX })
            : t('＋ 加入 {name}', { name: entryLabel(this.current) }),
          onclick: () => this.onAdd(),
        })
      );
    }
    actions.push(
      el('button.card__watch-action', {
        type: 'button',
        text: t('🔍 搜尋其他幣種…'),
        onclick: () => {
          this.close();
          this.onSearch();
        },
      })
    );

    this.rows.replaceChildren(...rows, el('div.card__watch-actions', {}, actions));
  }

  /* ------------------------------------------------------------ reorder */

  pressRow(event, index) {
    if (event.button !== 0 || this.list.length < 2) return;
    if (event.target.closest('button')) return; // the bell and the ✕ are their own clicks
    const rows = [...this.rows.querySelectorAll('.card__watch-row')];
    // Row pitch, margins included: the distance between two neighbours.
    const step = rows.length > 1 ? rows[1].offsetTop - rows[0].offsetTop : rows[index].offsetHeight;
    this.dragged = false;
    const move = (e) => this.moveRow(e);
    const up = () => this.endDrag(true);
    const cancel = () => this.endDrag(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    this.drag = {
      index,
      target: index,
      startY: event.clientY,
      pointerId: event.pointerId,
      step,
      rows,
      active: false,
      detach: () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cancel);
      },
    };
  }

  moveRow(event) {
    const d = this.drag;
    if (!d || event.pointerId !== d.pointerId) return;
    if (!d.active) {
      if (Math.abs(event.clientY - d.startY) < DRAG_START_PX) return;
      d.active = true;
      this.rows.classList.add('is-sorting');
      d.rows[d.index].classList.add('is-lifted');
    }
    event.preventDefault();
    const n = d.rows.length;
    // Kept within the list: the row goes as far as the top or the bottom.
    const dy = Math.max(-d.index * d.step, Math.min((n - 1 - d.index) * d.step, event.clientY - d.startY));
    d.target = Math.round(d.index + dy / d.step);
    d.rows.forEach((row, i) => {
      let slot = i;
      if (i === d.index) {
        row.style.transform = `translateY(${dy}px)`;
        slot = d.target;
      } else {
        // The rows between the old place and the new one each move one over.
        if (d.index < i && i <= d.target) slot = i - 1;
        else if (d.target <= i && i < d.index) slot = i + 1;
        row.style.transform = slot !== i ? `translateY(${(slot - i) * d.step}px)` : '';
      }
      row.querySelector('.card__watch-key').textContent = watchKey(slot);
    });
  }

  /** Finish (`commit`) or abandon a press. */
  endDrag(commit) {
    const d = this.drag;
    if (!d) return;
    d.detach();
    this.drag = null;
    this.rows.classList.remove('is-sorting');
    if (d.active) {
      this.dragged = commit;
      if (commit && d.target !== d.index) {
        // Shown at once; the prefs round trip that follows draws the same list.
        this.list = moveEntry(this.list, d.index, d.target);
        this.renderPending = false;
        this.render();
        this.onReorder(this.list);
        return;
      }
      d.rows.forEach((row, i) => {
        row.style.transform = '';
        row.classList.remove('is-lifted');
        row.querySelector('.card__watch-key').textContent = watchKey(i);
      });
    }
    if (this.renderPending) {
      this.renderPending = false;
      this.render();
    }
  }

  destroy() {
    if (this.drag) this.drag.detach();
    window.removeEventListener('mousedown', this.onOutside, true);
    window.removeEventListener('keydown', this.onKey);
    this.root.remove();
  }
}
