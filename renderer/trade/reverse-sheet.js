/**
 * The reversal sheet: turn a long into a short of the same size, or back.
 *
 * Opened from 反手 on the position strip, which is the first of two presses;
 * the sheet's own button is the second. It sends *one* order -- the opposite
 * side, twice the position -- so the flip is a single fill, and a refusal
 * (margin, say) leaves the position exactly as it was.
 *
 *   市價 reverses now.
 *   限價 rests on the far side of the market: a long sells above the last
 *   trade, a short buys below it. Pick the price by clicking the chart or
 *   dragging its line. The main process cancels it if the position changes
 *   before it fills (a stop triggering would otherwise leave it to open
 *   twice the size the other way).
 *
 * Optional TP/SL are for the *new* position. The old position's TP/SL and
 * reduce-only orders are cancelled once the flip has happened, not before:
 * until then they are still protecting it.
 */

import { el } from '../util.js';
import { envChip } from './env-chip.js';
import { t } from '../i18n.js';

function priceInput({ placeholder, onInput }) {
  const input = el('input.tk-input__field', {
    type: 'text',
    inputmode: 'decimal',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder,
  });
  input.addEventListener('input', () => {
    const clean = input.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
    if (clean !== input.value) input.value = clean;
    onInput(clean);
  });
  return input;
}

/** 2 × a quantity, at the quantity's own precision (no float noise). */
function double(amt) {
  const s = String(Math.abs(amt));
  const decimals = s.includes('.') ? s.split('.')[1].length : 0;
  return (Math.abs(amt) * 2).toFixed(decimals);
}

export class ReverseSheet {
  /**
   * @param {{
   *   onSubmit: (req) => Promise<{ok, error}>,
   *   onClose: () => void,
   *   onDraft: (draft) => void,
   *   getMarket: () => {last: number, mark: number},
   *   formatPrice: (p) => string,
   * }} hooks
   */
  constructor(hooks) {
    this.hooks = hooks;
    this.symbol = '';
    this.baseAsset = '';
    this.position = null;
    this.type = 'MARKET';
    this.price = '';
    this.tpsl = false;
    this.tp = '';
    this.sl = '';
    this.sending = false;
    this.build();
  }

  build() {
    this.envEl = el('span.tk-chip.tk-chip--env', { hidden: true, text: t('測試網') });
    this.typeBtns = ['MARKET', 'LIMIT'].map((type) =>
      el('button.tk-seg__btn', {
        type: 'button',
        text: type === 'MARKET' ? t('市價（立即）') : t('限價'),
        onclick: () => this.setType(type),
      })
    );
    this.priceInput = priceInput({ placeholder: t('點圖表或輸入價格'), onInput: (v) => this.update({ price: v }) });
    this.priceRow = el(
      'label.tk-input',
      {},
      el('span.tk-input__prefix', { text: t('價格') }),
      this.priceInput
    );
    this.fromEl = el('span.rv-from');
    this.toEl = el('span.rv-to');
    this.orderEl = el('div.tk-sub');

    this.tpslToggle = el('input', { type: 'checkbox' });
    this.tpslToggle.addEventListener('change', () => this.update({ tpsl: this.tpslToggle.checked }));
    this.tpInput = priceInput({ placeholder: t('止盈價'), onInput: (v) => this.update({ tp: v }) });
    this.slInput = priceInput({ placeholder: t('止損價'), onInput: (v) => this.update({ sl: v }) });
    this.tpslBody = el(
      'div.tk-tpsl__body',
      { hidden: true },
      el('label.tk-tpsl__row', {}, el('span.tk-tag.tk-tag--tp', { text: t('止盈') }), el('span.tk-input', {}, this.tpInput)),
      el('label.tk-tpsl__row', {}, el('span.tk-tag.tk-tag--sl', { text: t('止損') }), el('span.tk-input', {}, this.slInput))
    );
    this.noteEl = el('div.tk-note');
    this.errorEl = el('div.tk-error', { hidden: true, role: 'alert' });
    this.goBtn = el('button.tk-side', { type: 'button', onclick: () => this.submit() });

    this.root = el(
      'div.tk.tk--reverse',
      { hidden: true, role: 'dialog', 'aria-label': t('反手') },
      el(
        'div.tk-head',
        {},
        el('span.tk-title', { text: t('反手') }),
        this.envEl,
        el('button.tk-close', { type: 'button', title: t('關閉 (Esc)'), text: '✕', onclick: () => this.hooks.onClose() })
      ),
      el('div.rv-summary', {}, this.fromEl, el('span.rv-arrow', { text: '→' }), this.toEl),
      el('div.tk-seg', {}, this.typeBtns),
      el(
        'div.tk-body',
        {},
        this.priceRow,
        this.orderEl,
        el(
          'div.tk-tpsl',
          {},
          el('label.tk-check', {}, this.tpslToggle, el('span', { text: t('新倉位的止盈 / 止損') })),
          this.tpslBody
        ),
        this.noteEl,
        this.errorEl
      ),
      el('div.tk-actions.tk-actions--single', {}, this.goBtn)
    );

    this.root.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') this.hooks.onClose();
      if (event.key === 'Enter') {
        event.preventDefault();
        this.submit();
      }
    });
    for (const type of ['mousedown', 'dblclick', 'wheel', 'click']) {
      this.root.addEventListener(type, (event) => event.stopPropagation());
    }
  }

  get isOpen() {
    return !this.root.hidden;
  }

  /**
   * @param {{symbol, baseAsset, position, env, price?, type?}} opts
   *   price: a locked chart price, for limit; type: 'MARKET' | 'LIMIT' to start in
   */
  open({ symbol, baseAsset, position, env, price, type }) {
    if (symbol !== this.symbol) {
      this.tp = this.sl = '';
      this.tpInput.value = this.slInput.value = '';
      this.tpsl = false;
      this.tpslToggle.checked = false;
    }
    this.symbol = symbol;
    this.baseAsset = baseAsset || '';
    this.position = position;
    envChip(this.envEl, env);
    this.errorEl.hidden = true;
    this.price = '';
    this.priceInput.value = '';
    if (type) this.type = type;
    if (price > 0) {
      this.type = 'LIMIT';
      this.setPrice(price, { silent: true });
    }
    this.root.hidden = false;
    this.update({});
    // Limit without a price yet: the next thing to do is pick one.
    if (this.type === 'LIMIT' && !this.price) this.priceInput.focus();
    else this.goBtn.focus();
  }

  close() {
    this.root.hidden = true;
    this.hooks.onDraft(null);
  }

  /** The snapshot moved on. A position gone or flipped means there is nothing left to reverse. */
  setPosition(position) {
    if (!this.isOpen) return;
    if (!position || !this.position || Math.sign(position.amt) !== Math.sign(this.position.amt)) {
      this.hooks.onClose();
      return;
    }
    this.position = position;
    this.render();
  }

  setType(type) {
    this.type = type;
    this.update({});
    if (type === 'LIMIT' && !this.price) this.priceInput.focus();
  }

  setPrice(price, { silent = false } = {}) {
    this.price = this.hooks.formatPrice(price).replace(/,/g, '');
    this.priceInput.value = this.price;
    if (!silent) this.update({});
  }

  /** A click on the chart, or a draft line dragged: the price, the TP or the SL. */
  setFromChart(which, price) {
    if (which === 'price') {
      this.type = 'LIMIT';
      this.setPrice(price);
      return;
    }
    this.tpsl = true;
    this.tpslToggle.checked = true;
    this[which] = this.hooks.formatPrice(price).replace(/,/g, '');
    (which === 'tp' ? this.tpInput : this.slInput).value = this[which];
    this.update({});
  }

  update(patch) {
    Object.assign(this, patch);
    this.errorEl.hidden = true;
    this.render();
    const n = (v) => (Number(v) > 0 ? Number(v) : null);
    this.hooks.onDraft({
      side: this.newSide(),
      price: this.type === 'LIMIT' ? n(this.price) : null,
      tp: this.tpsl ? n(this.tp) : null,
      sl: this.tpsl ? n(this.sl) : null,
    });
  }

  /** The side of the order, which is also the direction of the new position. */
  newSide() {
    return this.position && this.position.amt > 0 ? 'SELL' : 'BUY';
  }

  /**
   * What would be refused, said before sending. The main process checks all
   * of it again against the exchange's own filters and the live price.
   */
  problem() {
    const { last, mark } = this.hooks.getMarket();
    const short = this.newSide() === 'SELL';
    let entry = last;
    if (this.type === 'LIMIT') {
      const p = Number(this.price);
      if (!(p > 0)) return t('請輸入價格，或在圖表上點一下');
      if (last > 0 && (short ? p <= last : p >= last)) {
        return short
          ? t('反手賣出要高於目前價格，否則會立刻成交；要立刻反手請用市價')
          : t('反手買入要低於目前價格，否則會立刻成交；要立刻反手請用市價');
      }
      entry = p;
    }
    if (this.tpsl) {
      const tp = Number(this.tp);
      const sl = Number(this.sl);
      if (tp > 0 && entry > 0 && (short ? tp >= entry : tp <= entry)) return short ? t('做空的止盈要低於進場價') : t('做多的止盈要高於進場價');
      if (sl > 0 && entry > 0 && (short ? sl <= entry : sl >= entry)) return short ? t('做空的止損要高於進場價') : t('做多的止損要低於進場價');
      if (sl > 0 && mark > 0 && (short ? sl <= mark : sl >= mark)) return t('止損價已經越過目前標記價格，會立刻觸發');
    }
    return '';
  }

  render() {
    const p = this.position;
    if (!p) return;
    const long = p.amt > 0;
    const size = Math.abs(p.amt);
    const unit = this.baseAsset ? ` ${this.baseAsset}` : '';
    const limit = this.type === 'LIMIT';
    this.fromEl.textContent = long ? t('多 {size}', { size: size + unit }) : t('空 {size}', { size: size + unit });
    this.fromEl.className = `rv-from ${long ? 'is-long' : 'is-short'}`;
    this.toEl.textContent = long ? t('空 {size}', { size: size + unit }) : t('多 {size}', { size: size + unit });
    this.toEl.className = `rv-to ${long ? 'is-short' : 'is-long'}`;
    this.typeBtns.forEach((b, i) => b.classList.toggle('is-active', (i === 1) === limit));
    this.priceRow.hidden = !limit;
    const vars = { qty: double(p.amt) + unit, size };
    if (limit) {
      this.orderEl.textContent = long
        ? t('送出一張限價賣出 {qty}：先平多 {size}，再開空 {size}', vars)
        : t('送出一張限價買入 {qty}：先平空 {size}，再開多 {size}', vars);
    } else {
      this.orderEl.textContent = long
        ? t('送出一張市價賣出 {qty}：先平多 {size}，再開空 {size}', vars)
        : t('送出一張市價買入 {qty}：先平空 {size}，再開多 {size}', vars);
    }
    this.tpslBody.hidden = !this.tpsl;
    this.noteEl.textContent = limit
      ? t('成交後才會取消原倉位的止盈止損，在那之前它們繼續保護倉位。若倉位先變動（例如止損觸發），反手單會自動取消。')
      : t('原倉位的止盈止損與減倉單，會在反手成交後自動取消。');
    const problem = this.problem();
    this.goBtn.disabled = this.sending || !!problem;
    this.goBtn.title = problem;
    this.goBtn.className = `tk-side tk-side--${long ? 'short' : 'long'}`;
    if (!this.sending) {
      this.goBtn.textContent = problem && limit && !(Number(this.price) > 0)
        ? t('選擇反手價格')
        : limit
          ? long ? t('限價反手做空') : t('限價反手做多')
          : long ? t('市價反手做空') : t('市價反手做多');
    }
    if (problem && !(limit && !(Number(this.price) > 0))) {
      this.errorEl.hidden = false;
      this.errorEl.textContent = problem;
    }
  }

  async submit() {
    if (this.sending || !this.position || this.problem()) return;
    const n = (v) => (Number(v) > 0 ? Number(v) : null);
    const req = {
      symbol: this.symbol,
      type: this.type,
      price: this.type === 'LIMIT' ? Number(this.price) : null,
      tp: this.tpsl ? n(this.tp) : null,
      sl: this.tpsl ? n(this.sl) : null,
      expectAmt: this.position.amt,
    };
    this.sending = true;
    this.goBtn.textContent = t('反手中…');
    this.render();
    const res = await this.hooks.onSubmit(req);
    this.sending = false;
    if (res && res.ok) {
      this.hooks.onClose();
      return;
    }
    this.render();
    this.errorEl.hidden = false;
    this.errorEl.textContent = (res && res.error) || t('反手失敗');
  }

  destroy() {
    this.root.remove();
  }
}
