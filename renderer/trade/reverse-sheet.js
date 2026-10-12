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
    this.envEl = el('span.tk-chip.tk-chip--env', { hidden: true, text: '測試網' });
    this.typeBtns = ['MARKET', 'LIMIT'].map((type) =>
      el('button.tk-seg__btn', {
        type: 'button',
        text: type === 'MARKET' ? '市價（立即）' : '限價',
        onclick: () => this.setType(type),
      })
    );
    this.priceInput = priceInput({ placeholder: '點圖表或輸入價格', onInput: (v) => this.update({ price: v }) });
    this.priceRow = el(
      'label.tk-input',
      {},
      el('span.tk-input__prefix', { text: '價格' }),
      this.priceInput
    );
    this.fromEl = el('span.rv-from');
    this.toEl = el('span.rv-to');
    this.orderEl = el('div.tk-sub');

    this.tpslToggle = el('input', { type: 'checkbox' });
    this.tpslToggle.addEventListener('change', () => this.update({ tpsl: this.tpslToggle.checked }));
    this.tpInput = priceInput({ placeholder: '止盈價', onInput: (v) => this.update({ tp: v }) });
    this.slInput = priceInput({ placeholder: '止損價', onInput: (v) => this.update({ sl: v }) });
    this.tpslBody = el(
      'div.tk-tpsl__body',
      { hidden: true },
      el('label.tk-tpsl__row', {}, el('span.tk-tag.tk-tag--tp', { text: '止盈' }), el('span.tk-input', {}, this.tpInput)),
      el('label.tk-tpsl__row', {}, el('span.tk-tag.tk-tag--sl', { text: '止損' }), el('span.tk-input', {}, this.slInput))
    );
    this.noteEl = el('div.tk-note');
    this.errorEl = el('div.tk-error', { hidden: true, role: 'alert' });
    this.goBtn = el('button.tk-side', { type: 'button', onclick: () => this.submit() });

    this.root = el(
      'div.tk.tk--reverse',
      { hidden: true, role: 'dialog', 'aria-label': '反手' },
      el(
        'div.tk-head',
        {},
        el('span.tk-title', { text: '反手' }),
        this.envEl,
        el('button.tk-close', { type: 'button', title: '關閉 (Esc)', text: '✕', onclick: () => this.hooks.onClose() })
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
          el('label.tk-check', {}, this.tpslToggle, el('span', { text: '新倉位的止盈 / 止損' })),
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

  /** @param {{symbol, baseAsset, position, env, price?}} opts  price: a locked chart price, for limit */
  open({ symbol, baseAsset, position, env, price }) {
    if (symbol !== this.symbol) {
      this.tp = this.sl = '';
      this.tpInput.value = this.slInput.value = '';
      this.tpsl = false;
      this.tpslToggle.checked = false;
    }
    this.symbol = symbol;
    this.baseAsset = baseAsset || '';
    this.position = position;
    this.envEl.hidden = env !== 'testnet';
    this.errorEl.hidden = true;
    this.price = '';
    this.priceInput.value = '';
    if (price > 0) {
      this.type = 'LIMIT';
      this.setPrice(price, { silent: true });
    }
    this.root.hidden = false;
    this.update({});
    this.goBtn.focus();
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
      if (!(p > 0)) return '請輸入價格，或在圖表上點一下';
      if (last > 0 && (short ? p <= last : p >= last)) {
        return `反手${short ? '賣出' : '買入'}要${short ? '高' : '低'}於目前價格，否則會立刻成交；要立刻反手請用市價`;
      }
      entry = p;
    }
    if (this.tpsl) {
      const tp = Number(this.tp);
      const sl = Number(this.sl);
      if (tp > 0 && entry > 0 && (short ? tp >= entry : tp <= entry)) return `${short ? '做空' : '做多'}的止盈要${short ? '低' : '高'}於進場價`;
      if (sl > 0 && entry > 0 && (short ? sl <= entry : sl >= entry)) return `${short ? '做空' : '做多'}的止損要${short ? '高' : '低'}於進場價`;
      if (sl > 0 && mark > 0 && (short ? sl <= mark : sl >= mark)) return '止損價已經越過目前標記價格，會立刻觸發';
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
    this.fromEl.textContent = `${long ? '多' : '空'} ${size}${unit}`;
    this.fromEl.className = `rv-from ${long ? 'is-long' : 'is-short'}`;
    this.toEl.textContent = `${long ? '空' : '多'} ${size}${unit}`;
    this.toEl.className = `rv-to ${long ? 'is-short' : 'is-long'}`;
    this.typeBtns.forEach((b, i) => b.classList.toggle('is-active', (i === 1) === limit));
    this.priceRow.hidden = !limit;
    const verb = long ? '賣出' : '買入';
    this.orderEl.textContent = `送出一張${limit ? '限價' : '市價'}${verb} ${double(p.amt)}${unit}：先平${long ? '多' : '空'} ${size}，再開${long ? '空' : '多'} ${size}`;
    this.tpslBody.hidden = !this.tpsl;
    this.noteEl.textContent = limit
      ? '成交後才會取消原倉位的止盈止損，在那之前它們繼續保護倉位。若倉位先變動（例如止損觸發），反手單會自動取消。'
      : '原倉位的止盈止損與減倉單，會在反手成交後自動取消。';
    const problem = this.problem();
    this.goBtn.disabled = this.sending || !!problem;
    this.goBtn.title = problem;
    this.goBtn.className = `tk-side tk-side--${long ? 'short' : 'long'}`;
    if (!this.sending) {
      this.goBtn.textContent = problem && limit && !(Number(this.price) > 0)
        ? '選擇反手價格'
        : `${limit ? '限價' : '市價'}反手${long ? '做空' : '做多'}`;
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
    this.goBtn.textContent = '反手中…';
    this.render();
    const res = await this.hooks.onSubmit(req);
    this.sending = false;
    if (res && res.ok) {
      this.hooks.onClose();
      return;
    }
    this.render();
    this.errorEl.hidden = false;
    this.errorEl.textContent = (res && res.error) || '反手失敗';
  }

  destroy() {
    this.root.remove();
  }
}
