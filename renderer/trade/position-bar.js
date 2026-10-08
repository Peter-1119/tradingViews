/**
 * The position strip along the bottom of the chart: what is open, how it is
 * doing, and the two things one does with it -- adjust TP/SL, or close.
 *
 * Unrealized PnL is recomputed here on every mark-price tick (1s) rather than
 * waiting for the next account snapshot; the snapshot supplies size, entry and
 * leverage. Narrow cards drop the secondary fields first (a container query
 * in card.css), never the PnL or the buttons.
 */

import { el } from '../util.js';

const CLOSE_ARM_MS = 3000;

const fmt = (n, d = 2) =>
  Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';

export class PositionBar {
  /**
   * @param {{onClose: () => Promise<{ok, error}>, onTpsl: () => void, formatPrice: (p) => string}} hooks
   */
  constructor(hooks) {
    this.hooks = hooks;
    this.position = null;
    this.mark = null;
    this.closeArmed = false;

    this.sideEl = el('span.pb-side');
    this.envEl = el('span.pb-env', { text: '測試網', hidden: true });
    this.qtyEl = el('span.pb-field.pb-qty');
    this.entryEl = el('span.pb-field.pb-entry');
    this.markEl = el('span.pb-field.pb-mark');
    this.pnlEl = el('span.pb-pnl');
    this.liqEl = el('span.pb-field.pb-liq');
    this.tpslEl = el('span.pb-field.pb-tpsl');
    this.tpslBtn = el('button.pb-btn', { type: 'button', text: '止盈止損', onclick: () => this.hooks.onTpsl() });
    this.closeBtn = el('button.pb-btn.pb-btn--close', { type: 'button', text: '平倉', onclick: () => this.pressClose() });

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
      this.closeBtn
    );
    for (const type of ['mousedown', 'dblclick', 'wheel', 'click']) {
      this.root.addEventListener(type, (event) => event.stopPropagation());
    }
  }

  set(snapshot) {
    this.position = snapshot && snapshot.position ? snapshot.position : null;
    this.tp = snapshot ? snapshot.tp : null;
    this.sl = snapshot ? snapshot.sl : null;
    this.baseAsset = snapshot && snapshot.rules ? snapshot.rules.baseAsset : '';
    if (this.position && !this.mark) this.mark = this.position.mark;
    if (!this.position) this.disarmClose();
    this.render();
  }

  setEnv(env) {
    this.envEl.hidden = env !== 'testnet';
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
    this.sideEl.textContent = `${long ? '多' : '空'} ${p.leverage}x`;
    this.qtyEl.textContent = `${Math.abs(p.amt)} ${this.baseAsset}`;
    this.entryEl.textContent = `均 ${price(p.entry)}`;
    this.liqEl.textContent = `強平 ${price(p.liq)}`;
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
    this.markEl.textContent = `標 ${this.hooks.formatPrice(this.mark || p.mark)}`;
    this.pnlEl.textContent = `${r.pnl >= 0 ? '+' : '−'}${fmt(Math.abs(r.pnl))} USDT (${r.roe >= 0 ? '+' : '−'}${fmt(Math.abs(r.roe), 1)}%)`;
    this.pnlEl.classList.toggle('is-up', r.pnl >= 0);
    this.pnlEl.classList.toggle('is-down', r.pnl < 0);
  }

  pressClose() {
    if (!this.closeArmed) {
      this.closeArmed = true;
      this.closeBtn.textContent = '確認市價平倉';
      this.closeBtn.classList.add('is-armed');
      clearTimeout(this.closeTimer);
      this.closeTimer = setTimeout(() => this.disarmClose(), CLOSE_ARM_MS);
      return;
    }
    this.disarmClose();
    this.closeBtn.disabled = true;
    this.closeBtn.textContent = '平倉中…';
    this.hooks.onClose().finally(() => {
      this.closeBtn.disabled = false;
      this.closeBtn.textContent = '平倉';
    });
  }

  disarmClose() {
    this.closeArmed = false;
    clearTimeout(this.closeTimer);
    this.closeBtn.textContent = '平倉';
    this.closeBtn.classList.remove('is-armed');
  }

  destroy() {
    clearTimeout(this.closeTimer);
    this.root.remove();
  }
}
