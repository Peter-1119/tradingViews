/**
 * The order ticket: a compact sheet docked to the right of the chart.
 *
 * Built for one decision made quickly, on a card that may be 300px wide:
 * price (limit, prefilled from where the user clicked) or market, a notional
 * in USDT, optional TP/SL, then Long or Short. Everything derived -- quantity,
 * margin, the liquidation estimate per side, what TP/SL would make or lose --
 * comes from the main process (`trading.preview`), the same code that will
 * validate the order, so the ticket never promises what the exchange refuses.
 *
 * Sending takes two presses: the first turns the button into a summary
 * ("確認做多 0.005 BTC @ 84,213.4") with a 3s fuse; the second sends.
 */

import { el } from '../util.js';

const ARM_MS = 3000;
const PREVIEW_DEBOUNCE_MS = 120;
const PCTS = [10, 25, 50, 100];

function fmt(n, digits = 2) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function signed(n, digits = 2) {
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : '−'}${fmt(Math.abs(n), digits)}`;
}

function numberInput({ placeholder, onInput, step = 'any' }) {
  const input = el('input.tk-input__field', {
    type: 'text',
    inputmode: 'decimal',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder,
    step,
  });
  input.addEventListener('input', () => {
    // Digits and one dot; a comma typed out of habit becomes nothing.
    const clean = input.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
    if (clean !== input.value) input.value = clean;
    onInput(clean);
  });
  return input;
}

export class OrderTicket {
  /**
   * @param {{
   *   onPreview: (req) => Promise<{ok, data, error}>,
   *   onSubmit: (req) => Promise<{ok, data, error}>,
   *   onClose: () => void,
   *   onDraft: (draft) => void,   // price/TP/SL/liq lines to preview on the chart
   *   getMarket: () => {last: number, mark: number},
   * }} hooks
   */
  constructor(hooks) {
    this.hooks = hooks;
    this.symbol = '';
    this.baseAsset = '';
    this.type = 'LIMIT';
    this.price = '';
    this.notional = '';
    this.tpsl = false;
    this.tp = '';
    this.sl = '';
    /** This symbol's leverage on Binance, and its ceiling; null until known. */
    this.leverage = null;
    this.maxLeverage = null;
    this.levOpen = false;
    this.available = 0;
    this.previews = { BUY: null, SELL: null };
    this.armed = null;
    this.sending = false;
    this.seq = 0;
    this.build();
  }

  /* ------------------------------------------------------------------ DOM */

  build() {
    this.titleEl = el('span.tk-title');
    this.levEl = el('button.tk-chip.tk-chip--btn', {
      type: 'button',
      title: '這個幣種的槓桿（點一下調整，直接改在幣安帳戶上）',
      onclick: () => this.toggleLeverage(),
    });
    // Inline editor under the head: a number, quick picks, and apply.
    this.levInput = numberInput({ placeholder: '槓桿', onInput: () => this.renderLeverage() });
    this.levInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.applyLeverage();
    });
    this.levQuick = el('div.tk-pcts');
    this.levApply = el('button.tk-input__btn', { type: 'button', text: '套用', onclick: () => this.applyLeverage() });
    this.levHint = el('div.tk-sub');
    this.levBox = el(
      'div.tk-field.tk-lev',
      { hidden: true },
      el('div.tk-field__label', { text: '槓桿（只影響這個幣種）' }),
      el('div.tk-input', {}, this.levInput, this.levApply),
      this.levQuick,
      this.levHint
    );
    this.envEl = el('span.tk-chip.tk-chip--env', { hidden: true, text: '測試網' });

    this.typeBtns = ['LIMIT', 'MARKET'].map((type) =>
      el('button.tk-seg__btn', {
        type: 'button',
        text: type === 'LIMIT' ? '限價' : '市價',
        onclick: () => this.setType(type),
      })
    );

    this.priceInput = numberInput({ placeholder: '價格', onInput: (v) => this.update({ price: v }) });
    this.lastBtn = el('button.tk-input__btn', {
      type: 'button',
      text: '最新',
      title: '帶入最新成交價',
      onclick: () => {
        const { last } = this.hooks.getMarket();
        if (last > 0) this.setPrice(last);
      },
    });
    this.priceRow = el(
      'label.tk-input',
      {},
      el('span.tk-input__prefix', { text: '價格' }),
      this.priceInput,
      this.lastBtn
    );
    this.marketHint = el('div.tk-field.tk-field--hint', { hidden: true, text: '以市價立即成交' });

    this.notionalInput = numberInput({ placeholder: '名目價值', onInput: (v) => this.update({ notional: v }) });
    this.notionalInput.title = '名目價值（倉位總值），保證金 = 名目價值 ÷ 槓桿';
    this.pctBtns = PCTS.map((pct) =>
      el('button.tk-pct', {
        type: 'button',
        text: `${pct}%`,
        title: `可用保證金 × 槓桿的 ${pct}%`,
        onclick: () => this.setPercent(pct),
      })
    );
    this.qtyEl = el('div.tk-sub');

    this.tpslToggle = el('input', { type: 'checkbox' });
    this.tpslToggle.addEventListener('change', () => this.update({ tpsl: this.tpslToggle.checked }));
    this.tpInput = numberInput({ placeholder: '止盈價', onInput: (v) => this.update({ tp: v }) });
    this.slInput = numberInput({ placeholder: '止損價', onInput: (v) => this.update({ sl: v }) });
    this.tpOut = el('span.tk-outcome');
    this.slOut = el('span.tk-outcome');
    this.tpslBody = el(
      'div.tk-tpsl__body',
      { hidden: true },
      el('label.tk-tpsl__row', {}, el('span.tk-tag.tk-tag--tp', { text: '止盈' }), el('span.tk-input', {}, this.tpInput), this.tpOut),
      el('label.tk-tpsl__row', {}, el('span.tk-tag.tk-tag--sl', { text: '止損' }), el('span.tk-input', {}, this.slInput), this.slOut),
      el('div.tk-note', { text: '以標記價格觸發，整個倉位平倉。限價單會在成交後才掛上。' })
    );

    this.liqLong = el('span');
    this.liqShort = el('span');
    this.errorEl = el('div.tk-error', { hidden: true, role: 'alert' });

    this.longBtn = el('button.tk-side.tk-side--long', { type: 'button', onclick: () => this.press('BUY') });
    this.shortBtn = el('button.tk-side.tk-side--short', { type: 'button', onclick: () => this.press('SELL') });
    this.fuse = el('div.tk-fuse');

    this.root = el(
      'div.tk',
      { hidden: true, role: 'dialog', 'aria-label': '下單' },
      el(
        'div.tk-head',
        {},
        this.titleEl,
        this.levEl,
        this.envEl,
        el('button.tk-close', { type: 'button', title: '關閉 (Esc)', text: '✕', onclick: () => this.hooks.onClose() })
      ),
      this.levBox,
      el('div.tk-seg', {}, this.typeBtns),
      el(
        'div.tk-body',
        {},
        this.priceRow,
        this.marketHint,
        el(
          'label.tk-input',
          {},
          el('span.tk-input__prefix', { text: '金額' }),
          this.notionalInput,
          el('span.tk-input__unit', { text: 'USDT' })
        ),
        el('div.tk-pcts', {}, this.pctBtns),
        this.qtyEl,
        el(
          'div.tk-tpsl',
          {},
          el('label.tk-check', {}, this.tpslToggle, el('span', { text: '止盈 / 止損' })),
          this.tpslBody
        ),
        el(
          'div.tk-liq',
          { title: '成交後的預估強平價（全倉，依目前錢包餘額估算）' },
          el('span.tk-liq__label', { text: '預估強平' }),
          el('span.tk-liq__long', {}, '多 ', this.liqLong),
          el('span.tk-liq__short', {}, '空 ', this.liqShort)
        ),
        this.errorEl
      ),
      // Outside the scrolling body: on a short card the fields scroll, the
      // buttons never leave the screen.
      el('div.tk-actions', {}, this.longBtn, this.shortBtn, this.fuse)
    );

    // Typing in the ticket must not reach the chart's shortcuts (Ctrl+Z,
    // Alt+R, Escape closing the measure box, Alt+1..6).
    this.root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        if (this.armed) this.disarm();
        else this.hooks.onClose();
        return;
      }
      if (event.key === 'Enter' && this.armed) {
        event.preventDefault();
        this.press(this.armed);
      }
      event.stopPropagation();
    });
    // Nor its pointer events to the chart's gestures underneath.
    for (const type of ['mousedown', 'dblclick', 'wheel', 'click']) {
      this.root.addEventListener(type, (event) => event.stopPropagation());
    }
  }

  /* ---------------------------------------------------------------- state */

  get isOpen() {
    return !this.root.hidden;
  }

  open({ symbol, baseAsset, price, leverage, maxLeverage, available, env }) {
    const switched = symbol !== this.symbol;
    this.symbol = symbol;
    this.baseAsset = baseAsset || symbol.replace(/USDT$|USDC$/, '');
    if (switched || leverage) this.setLeverageInfo({ leverage, max: maxLeverage });
    this.available = available || 0;
    this.envEl.hidden = env !== 'testnet';
    if (switched) {
      this.tp = '';
      this.sl = '';
      this.tpInput.value = '';
      this.slInput.value = '';
    }
    this.root.hidden = false;
    if (price > 0) {
      this.setType('LIMIT', { silent: true });
      this.setPrice(price, { silent: true });
    }
    this.disarm();
    this.render();
    this.refresh();
    this.notionalInput.focus();
    this.notionalInput.select();
  }

  close() {
    this.root.hidden = true;
    this.disarm();
    this.hooks.onDraft(null);
  }

  setAccount({ available, env }) {
    if (Number.isFinite(available)) this.available = available;
    if (env) this.envEl.hidden = env !== 'testnet';
    if (this.isOpen) this.render();
  }

  /* ------------------------------------------------------------ leverage */

  /** From Binance, via the controller: {leverage, max}. */
  setLeverageInfo({ leverage, max } = {}) {
    this.leverage = leverage || null;
    this.maxLeverage = max || null;
    if (this.isOpen) this.render();
  }

  toggleLeverage() {
    this.levOpen = !this.levOpen;
    this.levBox.hidden = !this.levOpen;
    if (this.levOpen) {
      this.levInput.value = this.leverage ? String(this.leverage) : '';
      this.renderLeverage();
      this.levInput.focus();
      this.levInput.select();
    }
  }

  /** Quick picks that exist for this symbol, capped at its maximum. */
  renderLeverage() {
    const max = this.maxLeverage || 125;
    const picks = [...new Set([1, 3, 5, 10, 20, 50, 100, max].filter((n) => n <= max))];
    this.levQuick.replaceChildren(
      ...picks.map((n) =>
        el('button.tk-pct', {
          type: 'button',
          text: n === max ? `${n}x 最高` : `${n}x`,
          class: String(n) === this.levInput.value ? 'is-active' : '',
          onclick: () => {
            this.levInput.value = String(n);
            this.renderLeverage();
          },
        })
      )
    );
    const want = Math.round(Number(this.levInput.value));
    const bad = !Number.isFinite(want) || want < 1 || want > max;
    this.levApply.disabled = bad || want === this.leverage || this.levBusy;
    this.levHint.textContent = bad
      ? `這個幣種的槓桿可以設 1～${max}x`
      : `改在幣安帳戶上，${this.symbol} 之後的所有單都用 ${want}x。倉位越大，可用的最高槓桿越低。`;
  }

  async applyLeverage() {
    const want = Math.round(Number(this.levInput.value));
    if (this.levApply.disabled) return;
    this.levBusy = true;
    this.levApply.textContent = '套用中…';
    this.renderLeverage();
    const ok = await this.hooks.onLeverage(this.symbol, want);
    this.levBusy = false;
    this.levApply.textContent = '套用';
    if (ok) {
      this.levOpen = false;
      this.levBox.hidden = true;
      this.update({});
    } else {
      this.renderLeverage();
    }
  }

  setType(type, { silent = false } = {}) {
    this.type = type;
    if (!silent) this.update({});
  }

  setPrice(price, { silent = false } = {}) {
    // Shown at the instrument's precision; the main process rounds to the tick.
    this.price = String(price);
    this.priceInput.value = this.price;
    if (!silent) this.update({});
  }

  /** Re-anchor the limit price to a new click on the chart while open. */
  retarget(price) {
    this.setType('LIMIT', { silent: true });
    this.setPrice(price);
  }

  setPercent(pct) {
    const max = this.available * (this.leverage || 1);
    if (!(max > 0)) return;
    // A hair under 100%: fees and the mark/last gap would otherwise make a
    // "100%" order fail for insufficient margin.
    const value = Math.floor(max * (pct === 100 ? 0.98 : pct / 100));
    this.notional = String(value);
    this.notionalInput.value = this.notional;
    this.update({});
  }

  update(patch) {
    Object.assign(this, patch);
    this.submitError = '';
    this.disarm();
    this.render();
    clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => this.refresh(), PREVIEW_DEBOUNCE_MS);
  }

  request(side) {
    const { last, mark } = this.hooks.getMarket();
    return {
      symbol: this.symbol,
      side,
      type: this.type,
      price: this.type === 'LIMIT' ? Number(this.price) : undefined,
      notional: Number(this.notional),
      tp: this.tpsl && Number(this.tp) > 0 ? Number(this.tp) : null,
      sl: this.tpsl && Number(this.sl) > 0 ? Number(this.sl) : null,
      lastPrice: last,
      markPrice: mark,
    };
  }

  async refresh() {
    if (!this.isOpen || !this.symbol) return;
    const seq = ++this.seq;
    if (!(Number(this.notional) > 0) || (this.type === 'LIMIT' && !(Number(this.price) > 0))) {
      this.previews = { BUY: null, SELL: null };
      this.render();
      this.emitDraft();
      return;
    }
    const [buy, sell] = await Promise.all([this.hooks.onPreview(this.request('BUY')), this.hooks.onPreview(this.request('SELL'))]);
    if (seq !== this.seq) return;
    this.previews = { BUY: buy.ok ? buy.data : { errors: [buy.error] }, SELL: sell.ok ? sell.data : { errors: [sell.error] } };
    this.render();
    this.emitDraft();
  }

  /** What the chart should preview: the entry, TP/SL, and each side's liquidation. */
  emitDraft() {
    if (!this.isOpen) return this.hooks.onDraft(null);
    const { last } = this.hooks.getMarket();
    const price = this.type === 'LIMIT' ? Number(this.price) : last;
    this.hooks.onDraft({
      price: price > 0 ? price : null,
      tp: this.tpsl && Number(this.tp) > 0 ? Number(this.tp) : null,
      sl: this.tpsl && Number(this.sl) > 0 ? Number(this.sl) : null,
      armed: this.armed,
      liq: this.armed && this.previews[this.armed] ? this.previews[this.armed].liq : null,
    });
  }

  /* --------------------------------------------------------------- render */

  render() {
    this.titleEl.textContent = this.symbol;
    this.levEl.textContent = this.leverage ? `全倉 ${this.leverage}x ▾` : '全倉 …x';
    this.typeBtns.forEach((b, i) => b.classList.toggle('is-active', ['LIMIT', 'MARKET'][i] === this.type));
    this.priceRow.hidden = this.type !== 'LIMIT';
    this.marketHint.hidden = this.type !== 'MARKET';
    this.tpslBody.hidden = !this.tpsl;
    this.tpslToggle.checked = this.tpsl;

    const buy = this.previews.BUY;
    const sell = this.previews.SELL;
    const any = buy || sell;
    const avail = `可用 ${fmt(this.available)}`;
    if (any && any.qty !== undefined) {
      this.qtyEl.textContent = `≈ ${any.qty} ${this.baseAsset} · 保證金 ${fmt(any.margin)} · ${avail}`;
    } else {
      this.qtyEl.textContent = `名目價值 USDT · ${avail}`;
    }
    this.liqLong.textContent = buy && buy.liq ? fmt(buy.liq, this.priceDigits()) : '—';
    this.liqShort.textContent = sell && sell.liq ? fmt(sell.liq, this.priceDigits()) : '—';

    // TP/SL outcomes read off the side the user is about to take, or Long by default.
    const basis = this.previews[this.armed || 'BUY'];
    const outcome = (o, target) => {
      target.textContent = o ? `${signed(o.pnl)} (${signed(o.roe, 1)}%)` : '';
      target.classList.toggle('is-up', !!o && o.pnl >= 0);
      target.classList.toggle('is-down', !!o && o.pnl < 0);
    };
    outcome(basis && basis.tp, this.tpOut);
    outcome(basis && basis.sl, this.slOut);

    // A side is sendable only if its own preview has no complaints.
    const errorsOf = (p) => (p && p.errors ? p.errors : ['請輸入金額']);
    const longErr = errorsOf(buy);
    const shortErr = errorsOf(sell);
    this.longBtn.disabled = this.sending || (!!longErr.length && this.armed !== 'BUY');
    this.shortBtn.disabled = this.sending || (!!shortErr.length && this.armed !== 'SELL');
    this.longBtn.title = longErr.join('\n');
    this.shortBtn.title = shortErr.join('\n');

    // Show the error that matters: the armed side's, or one both sides share.
    const shown = this.armed ? errorsOf(this.previews[this.armed]) : longErr.filter((e) => shortErr.includes(e));
    const visible = shown.filter((e) => e !== '請輸入金額');
    const message = this.submitError || (Number(this.notional) ? visible[0] : '');
    this.errorEl.hidden = !message;
    this.errorEl.textContent = message || '';

    const label = (side) => {
      const p = this.previews[side];
      const verb = side === 'BUY' ? '做多' : '做空';
      if (this.armed !== side) return verb;
      const at = this.type === 'MARKET' ? '市價' : `@ ${p ? p.price : this.price}`;
      return `確認${verb} ${p ? p.qty : ''} ${this.baseAsset} ${at}`;
    };
    this.longBtn.textContent = this.sending && this.armed === 'BUY' ? '送出中…' : label('BUY');
    this.shortBtn.textContent = this.sending && this.armed === 'SELL' ? '送出中…' : label('SELL');
    this.root.classList.toggle('is-armed', !!this.armed);
    this.root.dataset.armed = this.armed || '';
  }

  priceDigits() {
    const p = String(this.price || '');
    const dot = p.indexOf('.');
    return dot < 0 ? 2 : Math.min(8, Math.max(2, p.length - dot - 1));
  }

  /* --------------------------------------------------------------- submit */

  press(side) {
    if (this.sending) return;
    if (this.armed !== side) {
      const p = this.previews[side];
      if (!p || (p.errors && p.errors.length)) return;
      this.arm(side);
      return;
    }
    this.submit(side);
  }

  arm(side) {
    this.armed = side;
    clearTimeout(this.armTimer);
    this.armTimer = setTimeout(() => this.disarm(), ARM_MS);
    // Restart the fuse animation.
    this.fuse.classList.remove('is-burning');
    void this.fuse.offsetWidth;
    this.fuse.classList.add('is-burning');
    this.render();
    this.emitDraft();
  }

  disarm() {
    if (!this.armed) return;
    this.armed = null;
    clearTimeout(this.armTimer);
    this.fuse.classList.remove('is-burning');
    this.render();
    this.emitDraft();
  }

  async submit(side) {
    clearTimeout(this.armTimer);
    this.fuse.classList.remove('is-burning');
    this.sending = true;
    this.render();
    const res = await this.hooks.onSubmit(this.request(side));
    this.sending = false;
    this.armed = null;
    if (res.ok) {
      this.hooks.onClose();
    } else {
      this.submitError = res.error;
      this.render();
    }
  }

  destroy() {
    clearTimeout(this.armTimer);
    clearTimeout(this.previewTimer);
    this.root.remove();
  }
}
