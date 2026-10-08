/**
 * Trading on a card: everything between the chart and the trading service.
 *
 * Only on perpetual cards, and only once an API key is set for the current
 * environment -- otherwise none of this draws a single pixel. Then:
 *
 *   - a ＋ rides the crosshair at the right edge of the plot, just inside the
 *     price axis (moving the pointer right onto it keeps the same price);
 *   - a plain click on the chart *locks* that price: a dashed line with the ＋
 *     pinned to it, so the pointer is free to travel to the button. Escape or
 *     another click lets go. A double-click (which adds a level) never locks;
 *   - ＋ opens the order ticket at that price;
 *   - the position, its liquidation price, working limit orders and TP/SL are
 *     lines on the chart with labels that cancel on ×, and the position strip
 *     along the bottom carries the live PnL and the close button;
 *   - a limit order's, a TP/SL's or the ticket's draft label can be dragged to
 *     a new price (the label, not the line: lines share the chart with levels
 *     and panning, and grabbing one by accident would move a real order).
 */

import { el } from '../util.js';
import { OrderTicket } from './order-ticket.js';
import { PositionBar } from './position-bar.js';

const api = () => window.stockcard.trading;

const CLICK_SLOP_PX = 4;
/** A drag shorter than this is a click, and sends nothing. */
const DRAG_SLOP_PX = 3;
const CLICK_MAX_MS = 350;
// Long enough for the second click of a double-click to cancel the lock.
const LOCK_DELAY_MS = 230;
const TOAST_MS = 4500;

const COLORS = {
  long: '#26c281',
  short: '#ed5465',
  liq: '#f0a03c',
  tp: '#3fb68b',
  sl: '#e0565f',
  order: '#8fb4ff',
  lock: 'rgba(226, 232, 240, 0.75)',
  draft: '#8fb4ff',
};

export class TradeController {
  /** @param {import('../cardview.js').CardView} view */
  constructor(view) {
    this.view = view;
    this.status = null;
    this.snapshot = null;
    /** {id, meta, startY, startPrice, price, moved, problem} while a label is dragged. */
    this.drag = null;
    /** {id, price} after a drag is sent, until the exchange's answer arrives. */
    this.saving = null;
    this.mark = null;
    this.hoverY = null;
    this.lock = null; // {price}
    this.draft = null;
    this.symbol = null;
    this.offs = [];

    this.ticket = new OrderTicket({
      onPreview: (req) => api().preview(req),
      onSubmit: (req) => this.submit(req),
      onClose: () => this.closeTicket(),
      onLeverage: (symbol, leverage) => this.setLeverage(symbol, leverage),
      onDraft: (draft) => {
        this.draft = draft;
        this.renderLines();
      },
      getMarket: () => ({ last: this.lastPrice(), mark: this.mark || 0 }),
      getPosition: () => (this.snapshot && this.snapshot.position) || null,
    });
    this.bar = new PositionBar({
      onClose: () => this.closePosition(),
      onTpsl: () => this.openTpslEditor(),
      formatPrice: (p) => this.view.chart.formatPrice(p),
    });

    this.plusBtn = el('button.tr-plus', {
      type: 'button',
      hidden: true,
      title: '在這個價位下單',
      text: '+',
    });
    this.plusBtn.addEventListener('mousedown', (event) => {
      event.stopPropagation();
      event.preventDefault();
    });
    this.plusBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      this.openTicket(this.plusPrice);
    });

    this.labels = el('div.tr-labels');
    this.labelEls = new Map();
    this.toasts = el('div.tr-toasts', { 'aria-live': 'polite' });
    this.editor = this.buildEditor();

    // A sibling of the chart, laid over it -- not a child. The chart's drawing
    // gestures listen in the capture phase on the chart element, so anything
    // inside it would hand a click in the ticket to, say, the level under it.
    this.overlay = el(
      'div.tr-overlay',
      {},
      this.labels,
      this.plusBtn,
      this.bar.root,
      this.ticket.root,
      this.editor.root,
      this.toasts
    );
    view.root.append(this.overlay);
    this.fitOverlay = () => {
      this.overlay.style.top = `${view.chartEl.offsetTop}px`;
    };
    this.fitOverlay();
    window.addEventListener('resize', this.fitOverlay);

    view.chart.tradeLayer.onLayout = (items) => this.placeLabels(items);
    this.bindPointer();
    this.bindKeys();

    this.offs.push(api().onStatus((s) => this.applyStatus(s)));
    this.offs.push(api().onSnapshot((snap) => this.applySnapshot(snap)));
    this.offs.push(api().onNotice((n) => this.applyNotice(n)));
    this.sync();
  }

  /* ------------------------------------------------------------- lifecycle */

  get enabled() {
    const s = this.status;
    if (!s || this.view.card.market !== 'perp') return false;
    const key = s.keys && s.keys[s.env];
    if (!key || !key.configured) return false;
    return s.env !== 'live' || s.liveConfirmed;
  }

  /** Call when the card's symbol or market changed. */
  async sync() {
    const card = this.view.card;
    const symbol = card.market === 'perp' ? card.symbol : null;
    if (symbol !== this.symbol) {
      this.symbol = symbol;
      this.snapshot = null;
      this.mark = null;
      this.lock = null;
      this.closeTicket();
      this.closeEditor();
      this.bar.set(null);
    }
    if (symbol) {
      const res = await api().watch(symbol, this.view.card.id);
      if (res.ok) this.applyStatus(res.data);
    } else {
      api().unwatch(this.view.card.id);
      const res = await api().status();
      if (res.ok) this.applyStatus(res.data);
    }
    this.renderAll();
  }

  applyStatus(status) {
    this.status = status;
    const acc = status.account;
    this.ticket.setAccount({ available: acc ? acc.availableBalance : 0, env: status.env });
    if (!this.enabled) {
      this.closeTicket();
      this.closeEditor();
    }
    this.bar.setEnv(status.env);
    this.view.root.classList.toggle('is-trading', this.enabled);
    this.view.root.classList.toggle('is-trading-testnet', this.enabled && status.env === 'testnet');
    this.renderAll();
  }

  applySnapshot(snap) {
    if (!snap || snap.symbol !== this.symbol) return;
    if (this.status && snap.env !== this.status.env) return;
    this.snapshot = snap;
    // The exchange has answered: draw what it says, not what was dragged.
    if (this.saving && this.saving.sent) this.saving = null;
    if (snap.position && !this.mark) this.mark = snap.position.mark;
    this.bar.set(this.enabled ? snap : null);
    if (this.editor.isOpen && !snap.position) this.closeEditor();
    this.renderLines();
  }

  applyNotice(n) {
    if (n.symbol && n.symbol !== this.symbol) return;
    if (!this.enabled && n.level !== 'error') return;
    const toast = el(`div.tr-toast.tr-toast--${n.level}`, { text: n.text });
    this.toasts.append(toast);
    while (this.toasts.children.length > 3) this.toasts.firstChild.remove();
    setTimeout(() => toast.classList.add('is-leaving'), TOAST_MS);
    setTimeout(() => toast.remove(), TOAST_MS + 400);
  }

  /** Mark price from the card's own markPrice stream, once a second. */
  setMark(mark) {
    if (!(mark > 0)) return;
    this.mark = mark;
    this.bar.setMark(mark);
    if (this.snapshot && this.snapshot.position) this.renderLines();
  }

  lastPrice() {
    const bar = this.view.lastBar;
    return bar ? bar.close : this.mark || 0;
  }

  renderAll() {
    this.bar.set(this.enabled ? this.snapshot : null);
    this.renderLines();
    this.renderPlus();
  }

  /* ------------------------------------------------------------- pointer */

  bindPointer() {
    const chartEl = this.view.chartEl;
    const local = (event) => {
      const r = chartEl.getBoundingClientRect();
      return { x: event.clientX - r.left, y: event.clientY - r.top };
    };

    this.onMove = (event) => {
      if (!this.enabled) return;
      const { x, y } = local(event);
      const chart = this.view.chart;
      this.hoverY = chart.inPlot(Math.min(x, chart.plotWidth() - 1), y) && x >= 0 ? y : null;
      this.renderPlus();
    };
    // Sliding off the plot onto the ＋ (or a label) is not leaving: those live
    // in the overlay, outside the chart element, and must not vanish under
    // the pointer that is reaching for them.
    this.onLeave = (event) => {
      if (event.relatedTarget && this.overlay.contains(event.relatedTarget)) return;
      this.hoverY = null;
      this.renderPlus();
    };
    this.plusBtn.addEventListener('mouseleave', (event) => {
      if (event.relatedTarget && this.view.chartEl.contains(event.relatedTarget)) return;
      this.hoverY = null;
      this.renderPlus();
    });

    // A click is a press and release in place, quickly, with no tool armed
    // and nothing else having claimed the gesture.
    this.onDown = (event) => {
      this.press = null;
      if (!this.enabled || event.button !== 0 || event.shiftKey || event.ctrlKey || event.altKey) return;
      if (this.view.activeTool !== 'cursor') return;
      // This click is the one that dismisses a held measure box, nothing more.
      if (this.view.measuring) return;
      const { x, y } = local(event);
      if (!this.view.chart.inPlot(x, y)) return;
      this.press = { x, y, at: performance.now() };
    };
    this.onUp = (event) => {
      const press = this.press;
      this.press = null;
      if (!press || event.button !== 0) return;
      const { x, y } = local(event);
      if (Math.hypot(x - press.x, y - press.y) > CLICK_SLOP_PX) return;
      if (performance.now() - press.at > CLICK_MAX_MS) return;
      // Something else took the click: a level/fib/rect drag, the measure box.
      if (this.view.draggingLevel || this.view.measuring || this.view.draggingRect || this.view.draggingFib) return;
      clearTimeout(this.lockTimer);
      this.lockTimer = setTimeout(() => this.toggleLock(y), LOCK_DELAY_MS);
    };
    this.onDbl = () => clearTimeout(this.lockTimer);

    chartEl.addEventListener('mousemove', this.onMove);
    chartEl.addEventListener('mouseleave', this.onLeave);
    chartEl.addEventListener('mousedown', this.onDown, true);
    chartEl.addEventListener('mouseup', this.onUp, true);
    chartEl.addEventListener('dblclick', this.onDbl, true);
  }

  bindKeys() {
    this.onDragMove = (event) => this.dragMove(event);
    this.onDragUp = () => this.dragEnd();
    window.addEventListener('mousemove', this.onDragMove);
    window.addEventListener('mouseup', this.onDragUp);

    this.onKey = (event) => {
      if (event.key !== 'Escape') return;
      // A drag in progress takes Escape first: put things back, send nothing.
      if (this.drag) {
        this.cancelDrag();
        event.stopPropagation();
        return;
      }
      if (this.ticket.isOpen || this.editor.isOpen) return; // they handle their own
      if (this.lock) {
        this.lock = null;
        this.renderLines();
        this.renderPlus();
      }
    };
    window.addEventListener('keydown', this.onKey);
  }

  toggleLock(y) {
    if (this.lock) {
      this.lock = null;
    } else {
      const price = this.view.chart.priceAt(0, y);
      if (price === null) return;
      this.lock = { price };
      // With the ticket open, a click re-targets its limit price instead.
      if (this.ticket.isOpen) {
        this.ticket.retarget(price);
        this.lock = null;
      }
    }
    this.renderLines();
    this.renderPlus();
  }

  /** The ＋ sits inside the plot's right edge, at the locked price or the pointer. */
  renderPlus() {
    const chart = this.view.chart;
    let y = null;
    if (this.lock) y = chart.priceToY(this.lock.price);
    else if (this.hoverY !== null && !this.ticket.isOpen) y = this.hoverY;
    const show = this.enabled && y !== null && Number.isFinite(y);
    this.plusBtn.hidden = !show;
    if (!show) return;
    this.plusPrice = this.lock ? this.lock.price : chart.priceAt(0, y);
    this.plusBtn.style.top = `${Math.round(y)}px`;
    this.plusBtn.style.right = `${chart.priceScaleWidth() + 4}px`;
    this.plusBtn.classList.toggle('is-locked', !!this.lock);
  }

  /* ---------------------------------------------------------------- ticket */

  openTicket(price) {
    if (!this.enabled || !this.symbol) return;
    this.closeEditor();
    const rules = this.snapshot && this.snapshot.rules;
    const acc = this.status.account;
    this.lock = null;
    this.ticket.open({
      symbol: this.symbol,
      baseAsset: rules ? rules.baseAsset : '',
      price: price > 0 ? Number(this.view.chart.formatPrice(price)) : this.lastPrice(),
      // From the last snapshot; refreshed from Binance just below.
      leverage: this.snapshot ? this.snapshot.leverage : null,
      maxLeverage: this.snapshot ? this.snapshot.maxLeverage : null,
      available: acc ? acc.availableBalance : 0,
      env: this.status.env,
    });
    this.view.root.classList.add('is-ticket-open');
    this.renderPlus();
    this.renderLines();
    // Ask Binance for the symbol's leverage as it stands now -- it may have
    // been changed on the website or the phone since the last snapshot.
    const symbol = this.symbol;
    api()
      .getLeverage(symbol)
      .then((res) => {
        if (res && res.ok && symbol === this.symbol) this.ticket.setLeverageInfo(res.data);
      });
  }

  /** The ticket's leverage editor: change it on Binance, then show what Binance says. */
  async setLeverage(symbol, leverage) {
    const res = await api().setLeverage(symbol, leverage);
    if (!res || !res.ok) {
      this.applyNotice({ level: 'error', text: res ? res.error : '槓桿調整失敗', symbol });
      return false;
    }
    if (symbol === this.symbol) this.ticket.setLeverageInfo(res.data);
    this.applyNotice({ level: 'fill', text: `${symbol} 槓桿已改為 ${res.data.leverage}x`, symbol });
    return true;
  }

  closeTicket() {
    if (!this.ticket.isOpen) return;
    this.ticket.close();
    this.view.root.classList.remove('is-ticket-open');
    this.draft = null;
    this.renderLines();
    this.renderPlus();
  }

  async submit(req) {
    const res = await api().place(req);
    if (!res.ok) this.applyNotice({ level: 'error', text: res.error, symbol: this.symbol });
    return res;
  }

  async closePosition() {
    const res = await api().close(this.symbol);
    if (!res.ok) this.applyNotice({ level: 'error', text: res.error, symbol: this.symbol });
    return res;
  }

  async cancel(kind, id) {
    const res = await api().cancel({ symbol: this.symbol, kind, id });
    if (!res.ok) this.applyNotice({ level: 'error', text: res.error, symbol: this.symbol });
  }

  /* ------------------------------------------------------- TP/SL editor */

  buildEditor() {
    const tpInput = el('input.tk-input__field', { type: 'text', inputmode: 'decimal', placeholder: '不設定' });
    const slInput = el('input.tk-input__field', { type: 'text', inputmode: 'decimal', placeholder: '不設定' });
    const error = el('div.tk-error', { hidden: true });
    const save = el('button.tk-primary', { type: 'button', text: '儲存' });
    const root = el(
      'div.tk.tk--editor',
      { hidden: true, role: 'dialog', 'aria-label': '倉位止盈止損' },
      el(
        'div.tk-head',
        {},
        el('span.tk-title', { text: '倉位止盈 / 止損' }),
        el('button.tk-close', { type: 'button', text: '✕', onclick: () => this.closeEditor() })
      ),
      el('label.tk-tpsl__row', {}, el('span.tk-tag.tk-tag--tp', { text: '止盈' }), el('span.tk-input', {}, tpInput)),
      el('label.tk-tpsl__row', {}, el('span.tk-tag.tk-tag--sl', { text: '止損' }), el('span.tk-input', {}, slInput)),
      el('div.tk-note', { text: '以標記價格觸發、整倉平倉。清空欄位即取消。' }),
      error,
      save
    );
    for (const type of ['mousedown', 'dblclick', 'wheel', 'click']) root.addEventListener(type, (e) => e.stopPropagation());
    root.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') this.closeEditor();
      if (event.key === 'Enter') save.click();
    });
    const editor = {
      root,
      get isOpen() {
        return !root.hidden;
      },
      open: (snap) => {
        tpInput.value = snap.tp ? this.view.chart.formatPrice(snap.tp.trigger) : '';
        slInput.value = snap.sl ? this.view.chart.formatPrice(snap.sl.trigger) : '';
        error.hidden = true;
        root.hidden = false;
        tpInput.focus();
      },
    };
    save.addEventListener('click', async () => {
      const snap = this.snapshot;
      if (!snap || !snap.position) return;
      const read = (input, current) => {
        const v = input.value.trim();
        if (!v) return current ? null : undefined; // cleared: remove; never set: leave
        return Number(v);
      };
      const req = { symbol: this.symbol, tp: read(tpInput, snap.tp), sl: read(slInput, snap.sl) };
      if (req.tp !== undefined && snap.tp && req.tp === Number(this.view.chart.formatPrice(snap.tp.trigger))) delete req.tp;
      if (req.sl !== undefined && snap.sl && req.sl === Number(this.view.chart.formatPrice(snap.sl.trigger))) delete req.sl;
      if (req.tp === undefined && req.sl === undefined) return this.closeEditor();
      save.disabled = true;
      const res = await api().setTpsl(req);
      save.disabled = false;
      if (res.ok) this.closeEditor();
      else {
        error.hidden = false;
        error.textContent = res.error;
      }
    });
    return editor;
  }

  openTpslEditor() {
    if (!this.snapshot || !this.snapshot.position) return;
    this.closeTicket();
    this.editor.open(this.snapshot);
  }

  closeEditor() {
    if (this.editor) this.editor.root.hidden = true;
  }

  /* --------------------------------------------------------- chart lines */

  /** Every line the chart should draw, with the label that goes with it. */
  lineItems() {
    if (!this.enabled) return [];
    const items = [];
    const snap = this.snapshot;
    const fmt = (p) => this.view.chart.formatPrice(p);
    const pos = snap && snap.position;

    if (pos) {
      const long = pos.amt > 0;
      const color = long ? COLORS.long : COLORS.short;
      const pnl = this.bar.pnl();
      items.push({
        id: 'entry',
        price: pos.entry,
        color,
        width: 1.5,
        axis: true,
        label: {
          text: `${long ? '多' : '空'} ${Math.abs(pos.amt)}`,
          value: pnl ? `${pnl.pnl >= 0 ? '+' : '−'}${Math.abs(pnl.pnl).toFixed(2)}` : '',
          tone: pnl && pnl.pnl >= 0 ? 'up' : 'down',
          color,
        },
      });
      if (pos.liq > 0) {
        items.push({ id: 'liq', price: pos.liq, color: COLORS.liq, dash: [5, 4], axis: true, label: { text: '強平', color: COLORS.liq } });
      }
    }
    for (const kind of ['tp', 'sl']) {
      const a = snap && snap[kind];
      if (!a) continue;
      let value = '';
      if (pos) {
        const pnl = (a.trigger - pos.entry) * pos.amt;
        value = `${pnl >= 0 ? '+' : '−'}${Math.abs(pnl).toFixed(2)}`;
      }
      items.push({
        id: `algo:${a.id}`,
        price: a.trigger,
        color: COLORS[kind],
        dash: [6, 4],
        axis: true,
        label: { text: kind === 'tp' ? '止盈' : '止損', value, color: COLORS[kind], cancel: { kind: 'algo', id: a.id } },
        drag: pos ? { kind: 'algo', which: kind } : null,
      });
    }
    for (const o of (snap && snap.orders) || []) {
      const buy = o.side === 'BUY';
      items.push({
        id: `order:${o.id}`,
        price: o.price,
        color: buy ? COLORS.long : COLORS.short,
        dash: [2, 3],
        axis: true,
        label: {
          text: `${o.reduceOnly ? '減倉' : '限價'}${buy ? '買' : '賣'} ${o.qty - o.filled}`,
          color: buy ? COLORS.long : COLORS.short,
          cancel: { kind: 'order', id: o.id },
        },
        drag: { kind: 'order', orderId: o.id, side: o.side },
      });
      const pend = (snap.pending || []).find((p) => p.orderId === o.id);
      if (pend) {
        const meta = (which) => ({ kind: 'pending', which, orderId: o.id, side: o.side, entry: o.price });
        if (pend.tp) items.push({ id: `pend-tp:${o.id}`, price: pend.tp, color: COLORS.tp, dash: [2, 4], alpha: 0.6, label: { text: '止盈・成交後', color: COLORS.tp, faint: true }, drag: meta('tp') });
        if (pend.sl) items.push({ id: `pend-sl:${o.id}`, price: pend.sl, color: COLORS.sl, dash: [2, 4], alpha: 0.6, label: { text: '止損・成交後', color: COLORS.sl, faint: true }, drag: meta('sl') });
      }
    }
    if (this.lock && !this.ticket.isOpen) {
      items.push({ id: 'lock', price: this.lock.price, color: COLORS.lock, dash: [3, 3], axis: true, axisText: '#0b0f17' });
    }
    const d = this.draft;
    if (d && this.ticket.isOpen) {
      if (d.price) items.push({ id: 'draft', price: d.price, color: COLORS.draft, dash: [4, 3], axis: true, label: { text: '下單價', color: COLORS.draft, faint: true }, drag: { kind: 'draft', which: 'price' } });
      if (d.tp) items.push({ id: 'draft-tp', price: d.tp, color: COLORS.tp, dash: [4, 3], alpha: 0.8, axis: true, label: { text: '止盈', color: COLORS.tp, faint: true }, drag: { kind: 'draft', which: 'tp' } });
      if (d.sl) items.push({ id: 'draft-sl', price: d.sl, color: COLORS.sl, dash: [4, 3], alpha: 0.8, axis: true, label: { text: '止損', color: COLORS.sl, faint: true }, drag: { kind: 'draft', which: 'sl' } });
      if (d.liq) items.push({ id: 'draft-liq', price: d.liq, color: COLORS.liq, dash: [5, 4], alpha: 0.8, label: { text: '預估強平', color: COLORS.liq, faint: true } });
    }
    return items.map((it) => this.withDrag(it));
  }

  /* ------------------------------------------------------------------- drag */

  /** Draw a dragged (or just-sent) item at its new price, saying what it will do. */
  withDrag(it) {
    const fmt = (p) => this.view.chart.formatPrice(p);
    const d = this.drag && this.drag.moved && this.drag.id === it.id ? this.drag : null;
    const s = !d && this.saving && this.saving.id === it.id ? this.saving : null;
    if (!d && !s) return it;
    const price = (d || s).price;
    const label = { ...it.label, cancel: null };
    if (s) {
      label.value = `${fmt(price)} 更新中…`;
      label.faint = true;
    } else if (d.problem) {
      label.value = d.problem;
      label.tone = 'down';
    } else {
      label.value = `→ ${fmt(price)}${this.dragOutcome(d.meta, price)}`;
      label.tone = '';
    }
    return { ...it, price, label, alpha: s ? 0.6 : it.alpha };
  }

  /** For a TP/SL on an open position: what it would make or lose there. */
  dragOutcome(meta, price) {
    const pos = this.snapshot && this.snapshot.position;
    if (meta.kind !== 'algo' || !pos) return '';
    const pnl = (price - pos.entry) * pos.amt;
    return `（${pnl >= 0 ? '+' : '−'}${Math.abs(pnl).toFixed(2)}）`;
  }

  /** Why a price would be refused, checked live so the label can say so. */
  dragProblem(meta, price) {
    if (meta.kind === 'order') {
      const last = this.lastPrice();
      if (last > 0 && (meta.side === 'BUY' ? price >= last : price <= last)) return '會立刻成交';
    }
    if (meta.kind === 'algo') {
      const pos = this.snapshot && this.snapshot.position;
      if (!pos) return '已經沒有倉位';
      const mark = this.mark || pos.mark;
      const long = pos.amt > 0;
      const wrong = meta.which === 'tp' ? (long ? price <= mark : price >= mark) : long ? price >= mark : price <= mark;
      if (wrong) return '會立刻觸發';
    }
    if (meta.kind === 'pending') {
      const long = meta.side === 'BUY';
      const wrong = meta.which === 'tp' ? (long ? price <= meta.entry : price >= meta.entry) : long ? price >= meta.entry : price <= meta.entry;
      if (wrong) return meta.which === 'tp' ? '要在委託價的獲利方向' : '要在委託價的虧損方向';
    }
    return '';
  }

  /**
   * The drag works in *offsets from the line*, not in absolute positions:
   * where the line really is when the drag starts, plus how far the pointer
   * has moved. Where on the label it was grabbed, or a label a frame behind
   * its line, cannot then turn into a price nobody aimed at.
   */
  startDrag(item, event) {
    if (this.drag || this.saving) return;
    const lineY = this.view.chart.priceToY(item.price);
    if (lineY === null) return;
    this.drag = {
      id: item.id,
      meta: item.drag,
      startY: event.clientY,
      startLineY: lineY,
      startPrice: item.price,
      price: item.price,
      moved: false,
      problem: '',
    };
    this.view.chart.setInteractionEnabled(false);
  }

  /**
   * The price scale must not have moved during the drag -- an autoscale on a
   * new high, say. If it did, the pixel the pointer let go at no longer means
   * the price shown, and nothing is sent.
   */
  scaleHeld(d) {
    const nowY = this.view.chart.priceToY(d.startPrice);
    return nowY !== null && Math.abs(nowY - d.startLineY) <= 4;
  }

  dragMove(event) {
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.abs(event.clientY - d.startY) < DRAG_SLOP_PX) return;
    d.moved = true;
    const chart = this.view.chart;
    const rect = this.view.chartEl.getBoundingClientRect();
    const y = d.startLineY + (event.clientY - d.startY);
    let paneHeight = Infinity;
    try {
      paneHeight = chart.chart.panes()[0].getHeight();
    } catch {
      /* mid-teardown */
    }
    if (y < 0 || y > paneHeight) {
      d.problem = '超出圖表範圍';
      this.renderLines();
      return;
    }
    // Ctrl magnets to OHLC, the same as everywhere else on the chart.
    const price = chart.priceAt(event.clientX - rect.left, y, { magnet: event.ctrlKey });
    if (price === null) return;
    d.price = Number(chart.formatPrice(price));
    d.problem = this.dragProblem(d.meta, d.price);
    // The ticket's own lines move its fields as they go: that is the point.
    if (d.meta.kind === 'draft') this.ticket.setFromChart(d.meta.which, d.price);
    else this.renderLines();
  }

  cancelDrag() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.view.chart.setInteractionEnabled(true);
    if (d.meta.kind === 'draft' && d.moved) this.ticket.setFromChart(d.meta.which, d.startPrice);
    this.renderLines();
  }

  async dragEnd() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.view.chart.setInteractionEnabled(true);
    if (!d.moved || d.price === d.startPrice) {
      this.renderLines();
      return;
    }
    if (d.meta.kind === 'draft') return; // already applied, live
    if (d.problem) {
      this.applyNotice({ level: 'warn', text: `沒有變更：${d.problem}`, symbol: this.symbol });
      this.renderLines();
      return;
    }
    if (!this.scaleHeld(d)) {
      this.applyNotice({ level: 'warn', text: '沒有變更：拖曳期間圖表的價格刻度變了，請再拖一次', symbol: this.symbol });
      this.renderLines();
      return;
    }
    const symbol = this.symbol;
    this.saving = { id: d.id, price: d.price, sent: false };
    this.renderLines();
    const m = d.meta;
    let res;
    if (m.kind === 'order') res = await api().modifyOrder({ symbol, orderId: m.orderId, price: d.price });
    else if (m.kind === 'algo') res = await api().setTpsl({ symbol, [m.which]: d.price });
    else if (m.kind === 'pending') res = await api().updatePending({ symbol, orderId: m.orderId, [m.which]: d.price });
    if (!res || !res.ok) {
      this.saving = null;
      this.applyNotice({ level: 'error', text: res ? res.error : '更新失敗', symbol });
      this.renderLines();
      return;
    }
    // Hold the new position until the next snapshot confirms it, rather than
    // flashing back to the old price for the round trip -- but not forever.
    if (this.saving && this.saving.id === d.id) {
      this.saving.sent = true;
      setTimeout(() => {
        if (this.saving && this.saving.id === d.id) {
          this.saving = null;
          this.renderLines();
        }
      }, 4000);
    }
  }

  renderLines() {
    this.view.chart.tradeLayer.setItems(this.lineItems());
  }

  /**
   * Called from the trade layer's updateAllViews, i.e. inside the chart's
   * render pass: label positions land in the same frame as the lines.
   */
  placeLabels(items) {
    const seen = new Set();
    const chart = this.view.chart;
    // The ticket, strip and toasts keep clear of both axes.
    const axisRight = `${chart.priceScaleWidth()}px`;
    const axisBottom = `${chart.timeScaleHeight()}px`;
    if (axisRight !== this.axisRight) {
      this.axisRight = axisRight;
      this.overlay.style.setProperty('--tr-axis-right', axisRight);
    }
    if (axisBottom !== this.axisBottom) {
      this.axisBottom = axisBottom;
      this.overlay.style.setProperty('--tr-axis-bottom', axisBottom);
    }
    // Labels sit left of the ＋ lane, right-aligned against the price axis.
    const right = `${chart.priceScaleWidth() + 28}px`;
    // A price off the top or bottom of the price pane has its line clipped by
    // the chart; its label must go too, not hang over the volume pane.
    let paneHeight = Infinity;
    try {
      paneHeight = chart.chart.panes()[0].getHeight();
    } catch {
      /* mid-teardown */
    }
    for (const it of items) {
      if (!it.label || it.y < 0 || it.y > paneHeight) continue;
      seen.add(it.id);
      let node = this.labelEls.get(it.id);
      if (!node) {
        node = this.buildLabel();
        this.labelEls.set(it.id, node);
        this.labels.append(node.root);
      }
      node.update(it);
      const top = `${Math.round(it.y)}px`;
      if (node.root.style.top !== top) node.root.style.top = top;
      if (node.root.style.right !== right) node.root.style.right = right;
    }
    for (const [id, node] of this.labelEls) {
      if (seen.has(id)) continue;
      node.root.remove();
      this.labelEls.delete(id);
    }
    // A locked ＋ follows its price through pans and rescales.
    if (this.lock) this.renderPlus();
  }

  buildLabel() {
    const text = el('span.tr-label__text');
    const value = el('span.tr-label__value');
    const x = el('button.tr-label__x', { type: 'button', title: '取消', text: '✕', hidden: true });
    const root = el('div.tr-label', {}, text, value, x);
    let cancel = null;
    let item = null;
    root.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !item || !item.drag) return;
      e.preventDefault();
      e.stopPropagation();
      this.startDrag(item, e);
    });
    x.addEventListener('mousedown', (e) => e.stopPropagation());
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!cancel) return;
      x.disabled = true;
      this.cancel(cancel.kind, cancel.id).finally(() => {
        x.disabled = false;
      });
    });
    let last = '';
    return {
      root,
      update: (it) => {
        item = it;
        root.classList.toggle('is-draggable', !!it.drag);
        root.title = it.drag ? '拖曳可改價（Esc 取消）' : '';
        const l = it.label;
        const key = `${l.text}|${l.value || ''}|${l.tone || ''}|${l.color}|${l.faint ? 1 : 0}|${l.cancel ? l.cancel.id : ''}`;
        cancel = l.cancel || null;
        if (key === last) return;
        last = key;
        text.textContent = l.text;
        value.textContent = l.value || '';
        value.hidden = !l.value;
        value.className = `tr-label__value${l.tone ? ` is-${l.tone}` : ''}`;
        root.style.setProperty('--tr-color', l.color);
        root.classList.toggle('is-faint', !!l.faint);
        x.hidden = !l.cancel;
      },
    };
  }

  /* --------------------------------------------------------------- teardown */

  destroy() {
    for (const off of this.offs) off();
    clearTimeout(this.lockTimer);
    const chartEl = this.view.chartEl;
    chartEl.removeEventListener('mousemove', this.onMove);
    chartEl.removeEventListener('mouseleave', this.onLeave);
    chartEl.removeEventListener('mousedown', this.onDown, true);
    chartEl.removeEventListener('mouseup', this.onUp, true);
    chartEl.removeEventListener('dblclick', this.onDbl, true);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('mousemove', this.onDragMove);
    window.removeEventListener('mouseup', this.onDragUp);
    window.removeEventListener('resize', this.fitOverlay);
    if (this.view.chart) this.view.chart.tradeLayer.onLayout = null;
    this.overlay.remove();
    this.ticket.destroy();
    this.bar.destroy();
    this.editor.root.remove();
    this.labels.remove();
    this.plusBtn.remove();
    this.toasts.remove();
    api().unwatch(this.view.card.id);
  }
}
