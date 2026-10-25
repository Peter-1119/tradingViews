/**
 * Price alerts on a card: placing them, showing them, moving and deleting.
 *
 *   - the bell on the rail arms placement; one click on the chart sets an
 *     alert at that price (Ctrl magnets) and puts the cursor tool back;
 *   - Alt+A sets one at the crosshair's price, without the rail;
 *   - each alert is a dashed line with a label: drag the label to move the
 *     alert, × to delete it.
 *
 * The direction is fixed when the alert is set or moved -- above the current
 * price fires on the way up, below on the way down -- so setting one never
 * fires it on the spot. Watching happens in the hub, not here: alerts fire
 * with every card hidden or closed (price-alert-monitor.js).
 */

import { el } from './util.js';
import { t } from './i18n.js';

const api = () => window.stockcard.priceAlerts;

const COLOR = '#f5c542';
const CLICK_SLOP_PX = 4;
const BELL =
  '<svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M4 9.5V6.5a3 3 0 0 1 6 0v3l1.2 1.5H2.8z"/><path d="M5.8 12.3a1.3 1.3 0 0 0 2.4 0"/></svg>';

export class PriceAlertController {
  /** @param {import('./cardview.js').CardView} view */
  constructor(view) {
    this.view = view;
    this.all = [];
    this.drag = null; // {id, price, startY}
    this.hoverY = null;
    this.labelEls = new Map();

    this.labels = el('div.pa-labels');
    this.overlay = el('div.pa-overlay', {}, this.labels);
    view.root.append(this.overlay);
    this.fitOverlay = () => {
      this.overlay.style.top = `${view.chartEl.offsetTop}px`;
    };
    this.fitOverlay();
    window.addEventListener('resize', this.fitOverlay);

    view.chart.alertLayer.onLayout = (items) => this.placeLabels(items);
    this.bind();

    this.offChanged = api().onChanged((list) => {
      this.all = list || [];
      this.render();
    });
    this.offFired = api().onFired((alert) => {
      if (alert.symbol !== view.card.symbol || alert.market !== view.card.market) return;
      const price = view.chart.formatPrice(alert.price);
      view.notify(
        alert.direction === 'up'
          ? t('🔔 價格提醒：漲到 {price}', { price })
          : t('🔔 價格提醒：跌到 {price}', { price })
      );
    });
    api()
      .list()
      .then((list) => {
        this.all = list || [];
        this.render();
      });
  }

  /** The alerts for what this card is showing. */
  mine() {
    const { symbol, market } = this.view.card;
    return this.all.filter((a) => a.symbol === symbol && a.market === market);
  }

  /** Call after a symbol or market switch. */
  render() {
    const chart = this.view.chart;
    if (!chart) return;
    chart.alertLayer.setItems(
      this.mine().map((a) => {
        const price = this.drag && this.drag.id === a.id ? this.drag.price : a.price;
        return { id: a.id, price, color: COLOR, dash: [4, 3], axis: true, alert: a };
      })
    );
  }

  currentPrice() {
    const bar = this.view.lastBar;
    return bar ? bar.close : null;
  }

  async add(price) {
    const current = this.currentPrice();
    if (!(price > 0) || current === null || price === current) return;
    const rounded = Number(this.view.chart.formatPrice(price));
    const added = await api().add({
      symbol: this.view.card.symbol,
      market: this.view.card.market,
      price: rounded,
      direction: rounded > current ? 'up' : 'down',
    });
    if (added) this.view.notify(t('🔔 已設定價格提醒 {price}', { price: this.view.chart.formatPrice(rounded) }));
  }

  /* -------------------------------------------------------------- input */

  bind() {
    const view = this.view;
    const chartEl = view.chartEl;
    const local = (event) => {
      const r = chartEl.getBoundingClientRect();
      return { x: event.clientX - r.left, y: event.clientY - r.top };
    };

    // Placement: a click (not a drag) in the plot while the bell is armed.
    this.onDown = (event) => {
      this.press = null;
      if (view.activeTool !== 'alert' || event.button !== 0) return;
      if (view.offChart(event)) return;
      const { x, y } = local(event);
      if (!view.chart.inPlot(x, y)) return;
      this.press = { x, y, ctrl: event.ctrlKey };
      // Armed tools own the press: no panning the chart from under it.
      event.preventDefault();
      event.stopPropagation();
    };
    this.onUp = (event) => {
      const press = this.press;
      this.press = null;
      if (!press) return;
      const { x, y } = local(event);
      if (Math.hypot(x - press.x, y - press.y) > CLICK_SLOP_PX) return;
      const price = view.chart.priceAt(x, y, { magnet: press.ctrl || event.ctrlKey });
      view.setActiveTool('cursor');
      if (price !== null) this.add(price);
    };
    this.onMove = (event) => {
      const { x, y } = local(event);
      this.hoverY = view.chart.inPlot(x, y) ? { x, y } : null;
    };
    this.onLeave = () => {
      this.hoverY = null;
    };
    // Alt+A at the crosshair -- TradingView's shortcut. Only for the card
    // under the pointer, which also settles which card on a board.
    this.onKey = (event) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.code !== 'KeyA') return;
      const t = event.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (!this.hoverY) return;
      event.preventDefault();
      const price = view.chart.priceAt(this.hoverY.x, this.hoverY.y);
      if (price !== null) this.add(price);
    };

    // Dragging a label moves its alert.
    this.onDragMove = (event) => {
      if (!this.drag) return;
      const { x, y } = local(event);
      const price = view.chart.priceAt(x, y);
      if (price === null) return;
      this.drag.price = Number(view.chart.formatPrice(price));
      this.drag.moved = this.drag.moved || Math.abs(event.clientY - this.drag.startY) > 2;
      this.render();
    };
    this.onDragUp = async () => {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      document.body.style.cursor = '';
      const current = this.currentPrice();
      if (!d.moved || current === null || d.price === current) {
        this.render();
        return;
      }
      await api().update(d.id, { price: d.price, direction: d.price > current ? 'up' : 'down' });
    };

    chartEl.addEventListener('mousedown', this.onDown, true);
    chartEl.addEventListener('mouseup', this.onUp, true);
    chartEl.addEventListener('mousemove', this.onMove);
    chartEl.addEventListener('mouseleave', this.onLeave);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('mousemove', this.onDragMove);
    window.addEventListener('mouseup', this.onDragUp);
  }

  /* ------------------------------------------------------------- labels */

  /** From the alert layer's render pass: labels land in the same frame as the lines. */
  placeLabels(items) {
    const chart = this.view.chart;
    let paneHeight = Infinity;
    try {
      paneHeight = chart.chart.panes()[0].getHeight();
    } catch {
      /* mid-teardown */
    }
    const seen = new Set();
    for (const it of items) {
      if (it.y < 0 || it.y > paneHeight) continue;
      seen.add(it.id);
      let node = this.labelEls.get(it.id);
      if (!node) {
        node = this.buildLabel(it.id);
        this.labelEls.set(it.id, node);
        this.labels.append(node.root);
      }
      node.update(it);
      const top = `${Math.round(it.y)}px`;
      if (node.root.style.top !== top) node.root.style.top = top;
    }
    for (const [id, node] of this.labelEls) {
      if (seen.has(id)) continue;
      node.root.remove();
      this.labelEls.delete(id);
    }
  }

  buildLabel(id) {
    const text = el('span.pa-label__text');
    const x = el('button.pa-label__x', { type: 'button', title: t('刪除這個提醒'), text: '✕' });
    const root = el('div.pa-label', { title: t('拖曳可移動提醒') }, el('span.pa-label__bell', { html: BELL }), text, x);
    x.addEventListener('mousedown', (e) => e.stopPropagation());
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      api().remove(id);
    });
    root.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const a = this.mine().find((m) => m.id === id);
      if (!a) return;
      this.drag = { id, price: a.price, startY: e.clientY, moved: false };
      document.body.style.cursor = 'ns-resize';
    });
    let last = '';
    return {
      root,
      update: (it) => {
        const dir = it.alert.direction === 'up' ? '↑' : '↓';
        const label = `${dir} ${this.view.chart.formatPrice(it.price)}`;
        if (label === last) return;
        last = label;
        text.textContent = label;
      },
    };
  }

  destroy() {
    const chartEl = this.view.chartEl;
    chartEl.removeEventListener('mousedown', this.onDown, true);
    chartEl.removeEventListener('mouseup', this.onUp, true);
    chartEl.removeEventListener('mousemove', this.onMove);
    chartEl.removeEventListener('mouseleave', this.onLeave);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('mousemove', this.onDragMove);
    window.removeEventListener('mouseup', this.onDragUp);
    window.removeEventListener('resize', this.fitOverlay);
    if (this.offChanged) this.offChanged();
    if (this.offFired) this.offFired();
    if (this.view.chart) this.view.chart.alertLayer.onLayout = null;
    this.overlay.remove();
  }
}
