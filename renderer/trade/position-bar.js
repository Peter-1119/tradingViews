/**
 * The position strip along the bottom of the card: what is open, how it is
 * doing, and the things one does with it -- adjust TP/SL, reverse, or close.
 *
 * The two that act at market -- 市價反手 and 平倉 -- take two presses on the
 * same button within 3s: the first turns it into what the second will do
 * ("確認反手→空"), so a stray click never trades, and a deliberate one is
 * a double tap away. 限價反手 opens the reversal sheet at a limit price.
 *
 * Docked, not floating: it is a row of the card's own layout, under the time
 * axis, and the chart gives up its height while a position is open. As an
 * overlay it sat on the lowest pane -- which is the volume or OI pane -- and on
 * a small card hid it completely. Persistent UI gets its own space; only
 * transient UI (the ticket, toasts) floats over data.
 *
 * Unrealized PnL is recomputed here on every mark-price tick (1s) rather than
 * waiting for the next account snapshot; the snapshot supplies size, entry and
 * leverage. Narrow cards drop the secondary fields first (a container query
 * in card.css), never the PnL or the buttons.
 */

import { el } from '../util.js';
import { envChip } from './env-chip.js';
import { t } from '../i18n.js';

const ARM_MS = 3000;
/** Under this width the buttons use their short labels, so the PnL keeps its room. */
const COMPACT_PX = 460;

const fmt = (n, d = 2) =>
  Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';

export class PositionBar {
  /**
   * @param {{
   *   onClose: () => Promise<{ok, error}>,
   *   onReverseMarket: (expectAmt: number) => Promise<{ok, error}>,
   *   onReverseLimit: () => void,
   *   onTpsl: () => void,
   *   formatPrice: (p) => string,
   * }} hooks
   */
  constructor(hooks) {
    this.hooks = hooks;
    this.position = null;
    this.mark = null;
    /** 'close' | 'reverse' while a button waits for its second press. */
    this.armed = null;

    this.sideEl = el('span.pb-side');
    this.envEl = el('span.pb-env', { text: t('測試網'), hidden: true });
    this.qtyEl = el('span.pb-field.pb-qty');
    this.entryEl = el('span.pb-field.pb-entry');
    this.markEl = el('span.pb-field.pb-mark');
    this.pnlEl = el('span.pb-pnl');
    this.liqEl = el('span.pb-field.pb-liq');
    this.tpslEl = el('span.pb-field.pb-tpsl');
    this.tpslBtn = el('button.pb-btn', { type: 'button', text: t('止盈止損'), onclick: () => this.hooks.onTpsl() });
    this.limitReverseBtn = el('button.pb-btn.pb-btn--reverse', {
      type: 'button',
      text: t('限價反手'),
      title: t('限價反手：打開反手面板，在圖上點價格或拖曳「反手價」線，掛單等成交'),
      onclick: () => {
        this.disarm();
        this.hooks.onReverseLimit();
      },
    });
    this.reverseBtn = el('button.pb-btn.pb-btn--reverse', {
      type: 'button',
      title: t('市價反手：按兩下立刻反手（同樣大小的反向倉位，一張兩倍數量的市價單）'),
      onclick: () => this.press('reverse'),
    });
    this.closeBtn = el('button.pb-btn.pb-btn--close', {
      type: 'button',
      title: t('平倉：按兩下市價平掉整個倉位'),
      onclick: () => this.press('close'),
    });
    this.labels();

    this.root = el(
      'div.pb',
      { hidden: true },
      this.envEl,
      this.sideEl,
      this.qtyEl,
      this.entryEl,
      this.markEl,
      this.pnlEl,
      this.liqEl,
      this.tpslEl,
      el('span.pb-spacer'),
      this.tpslBtn,
      this.limitReverseBtn,
      this.reverseBtn,
      this.closeBtn
    );
    for (const type of ['mousedown', 'dblclick', 'wheel', 'click']) {
      this.root.addEventListener(type, (event) => event.stopPropagation());
    }
    this.compact = false;
    this.resize = new ResizeObserver(() => {
      const compact = this.root.clientWidth > 0 && this.root.clientWidth < COMPACT_PX;
      if (compact === this.compact) return;
      this.compact = compact;
      this.labels();
    });
    this.resize.observe(this.root);
  }

  set(snapshot) {
    this.position = snapshot && snapshot.position ? snapshot.position : null;
    this.tp = snapshot ? snapshot.tp : null;
    this.sl = snapshot ? snapshot.sl : null;
    this.baseAsset = snapshot && snapshot.rules ? snapshot.rules.baseAsset : '';
    if (this.position && !this.mark) this.mark = this.position.mark;
    // An armed button promised something about *this* position; if it is gone
    // or has changed size, the promise is void.
    const amt = this.position ? this.position.amt : 0;
    if (amt !== this.armedAmt) this.disarm();
    this.render();
  }

  setEnv(env) {
    envChip(this.envEl, env);
  }

  setMark(mark) {
    if (!(mark > 0)) return;
    this.mark = mark;
    if (this.position) this.renderPnl();
  }

  /** {pnl, roe} at the live mark, falling back to the snapshot's own figure. */
  pnl() {
    const p = this.position;
    if (!p) return null;
    const mark = this.mark || p.mark;
    const pnl = Number.isFinite(mark) ? (mark - p.entry) * p.amt : p.upnl;
    const margin = (Math.abs(p.amt) * p.entry) / (p.leverage || 1);
    return { pnl, roe: margin > 0 ? (pnl / margin) * 100 : 0 };
  }

  render() {
    const p = this.position;
    this.root.hidden = !p;
    if (!p) return;
    const long = p.amt > 0;
    const price = (v) => (Number.isFinite(v) && v > 0 ? this.hooks.formatPrice(v) : '—');
    this.root.classList.toggle('is-long', long);
    this.root.classList.toggle('is-short', !long);
    this.sideEl.textContent = long ? t('多 {lev}x', { lev: p.leverage }) : t('空 {lev}x', { lev: p.leverage });
    this.qtyEl.textContent = `${Math.abs(p.amt)} ${this.baseAsset}`;
    this.entryEl.textContent = t('均 {price}', { price: price(p.entry) });
    this.liqEl.textContent = t('強平 {price}', { price: price(p.liq) });
    const parts = [];
    if (this.tp) parts.push(`TP ${price(this.tp.trigger)}`);
    if (this.sl) parts.push(`SL ${price(this.sl.trigger)}`);
    this.tpslEl.textContent = parts.join(' · ');
    this.tpslEl.hidden = !parts.length;
    this.renderPnl();
  }

  renderPnl() {
    const p = this.position;
    const r = this.pnl();
    if (!p || !r) return;
    this.markEl.textContent = t('標 {price}', { price: this.hooks.formatPrice(this.mark || p.mark) });
    this.pnlEl.textContent = `${r.pnl >= 0 ? '+' : '−'}${fmt(Math.abs(r.pnl))} USDT (${r.roe >= 0 ? '+' : '−'}${fmt(Math.abs(r.roe), 1)}%)`;
    this.pnlEl.classList.toggle('is-up', r.pnl >= 0);
    this.pnlEl.classList.toggle('is-down', r.pnl < 0);
  }

  /** The two market buttons' resting and armed labels. */
  labels() {
    const p = this.position;
    const toShort = p && p.amt > 0;
    const c = this.compact;
    this.tpslBtn.textContent = c ? 'TP/SL' : t('止盈止損');
    this.limitReverseBtn.textContent = c ? t('限反') : t('限價反手');
    if (this.busy) return;
    const armedReverse = c
      ? toShort ? t('確認→空') : t('確認→多')
      : toShort ? t('確認反手→空') : t('確認反手→多');
    this.reverseBtn.textContent = this.armed === 'reverse' ? armedReverse : c ? t('市反') : t('市價反手');
    this.closeBtn.textContent = this.armed === 'close' ? (c ? t('確認平倉') : t('確認市價平倉')) : t('平倉');
    this.reverseBtn.classList.toggle('is-armed', this.armed === 'reverse');
    this.closeBtn.classList.toggle('is-armed', this.armed === 'close');
  }

  press(kind) {
    if (!this.position || this.busy) return;
    if (this.armed !== kind) {
      this.armed = kind;
      this.armedAmt = this.position.amt;
      clearTimeout(this.armTimer);
      this.armTimer = setTimeout(() => this.disarm(), ARM_MS);
      this.labels();
      return;
    }
    const amt = this.armedAmt;
    this.disarm();
    const btn = kind === 'close' ? this.closeBtn : this.reverseBtn;
    this.busy = true;
    btn.disabled = true;
    btn.textContent = kind === 'close' ? t('平倉中…') : t('反手中…');
    const run = kind === 'close' ? this.hooks.onClose() : this.hooks.onReverseMarket(amt);
    run.finally(() => {
      this.busy = false;
      btn.disabled = false;
      this.labels();
    });
  }

  disarm() {
    this.armed = null;
    this.armedAmt = undefined;
    clearTimeout(this.armTimer);
    this.labels();
  }

  destroy() {
    clearTimeout(this.armTimer);
    this.resize.disconnect();
    this.root.remove();
  }
}
