/**
 * Price and volume alerts on a card: placing them, showing them, moving and
 * deleting.
 *
 *   - the bell on the rail arms placement; one click on the chart sets an
 *     alert at that price (Ctrl magnets) and puts the cursor tool back;
 *   - Alt+A sets one at the crosshair's price, without the rail;
 *   - each alert is a dashed line with a label: drag the label to move the
 *     alert, × to delete it.
 *
 * Where the click lands decides the kind: on the volume bars (the bottom of
 * the price pane when overlaid, or their own pane) it is a volume alert, on
 * the candles a price alert. A volume alert belongs to the interval it was
 * set on and fires once, the first time one bar's volume reaches it.
 *
 * A price alert's direction is fixed when it is set or moved -- above the
 * current price fires on the way up, below on the way down -- so setting one
 * never fires it on the spot; a volume alert set below the open bar's volume
 * waits for the next bar, for the same reason. Watching happens in the hub,
 * not here: alerts fire with every card hidden or closed
 * (price-alert-monitor.js).
 */

import { el, formatCompact } from './util.js';
import { t } from './i18n.js';
import { volumeValue } from './volume-stats.js';
import { intervalToMs } from './datafeed/provider.js';

const api = () => window.stockcard.priceAlerts;

const COLOR = '#f5c542';
const CLICK_SLOP_PX = 4;
const BELL =
  '<svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M4 9.5V6.5a3 3 0 0 1 6 0v3l1.2 1.5H2.8z"/><path d="M5.8 12.3a1.3 1.3 0 0 0 2.4 0"/></svg>';

const isVolume = (a) => a.kind === 'volume';

/** Three significant figures: a level reads like the label, not 1234567.891. */
const roundVolume = (v) => Number(Number(v).toPrecision(3));

export class PriceAlertController {
  /** @param {import('./cardview.js').CardView} view */
  constructor(view) {
    this.view = view;
    this.all = [];
    this.drag = null; // {id, kind, value, startY, moved}
    this.hoverY = null;
    /** One set of labels per layer: each layout pass prunes only its own. */
    this.labelEls = { price: new Map(), volume: new Map() };

    this.labels = el('div.pa-labels');
    this.tip = el('div.pa-tip', { hidden: true });
    this.overlay = el('div.pa-overlay', {}, this.labels, this.tip);
    view.root.append(this.overlay);
    this.fitOverlay = () => {
      this.overlay.style.top = `${view.chartEl.offsetTop}px`;
    };
    this.fitOverlay();
    window.addEventListener('resize', this.fitOverlay);

    view.chart.alertLayer.onLayout = (items) => this.placeLabels(items, 'price');
    view.chart.volumeAlertLayer.onLayout = (items) => this.placeLabels(items, 'volume');
    this.bind();

    this.offChanged = api().onChanged((list) => {
      this.all = list || [];
      this.render();
    });
    this.offFired = api().onFired((alert) => {
      if (alert.symbol !== view.card.symbol || alert.market !== view.card.market) return;
      if (isVolume(alert)) {
        view.notify(t('🔔 成交量提醒：{interval} 量達到 {volume}', { interval: alert.interval, volume: formatCompact(alert.volume) }));
        return;
      }
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

  /** Call after a symbol, market or interval switch. */
  render() {
    const chart = this.view.chart;
    if (!chart) return;
    const item = (a, value) => ({
      id: a.id,
      price: this.drag && this.drag.id === a.id ? this.drag.value : value,
      color: COLOR,
      dash: [4, 3],
      axis: true,
      alert: a,
    });
    const mine = this.mine();
    chart.alertLayer.setItems(mine.filter((a) => !isVolume(a)).map((a) => item(a, a.price)));
    // A volume level means something only on the interval it was set on.
    chart.volumeAlertLayer.setItems(
      mine.filter((a) => isVolume(a) && a.interval === this.view.card.interval).map((a) => item(a, a.volume))
    );
  }

  currentPrice() {
    const bar = this.view.lastBar;
    return bar ? bar.close : null;
  }

  /**
   * The first bar a volume alert may fire on: the open one, unless that has
   * already traded past the level -- then the next.
   */
  notBefore(volume) {
    const bar = this.view.lastBar;
    if (!bar) return 0;
    const step = intervalToMs(this.view.card.interval) / 1000;
    return volumeValue(bar) >= volume ? bar.time + step : bar.time;
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

  async addVolume(raw) {
    // No bar yet means the interval has just changed and the volume bars on
    // screen -- and the scale read off them -- may still be the old one's.
    if (!(raw > 0) || !this.view.lastBar) return;
    const volume = roundVolume(raw);
    const interval = this.view.card.interval;
    const added = await api().add({
      kind: 'volume',
      symbol: this.view.card.symbol,
      market: this.view.card.market,
      interval,
      volume,
      notBefore: this.notBefore(volume),
    });
    if (added) this.view.notify(t('🔔 已設定成交量提醒：{interval} 量達到 {volume}', { interval, volume: formatCompact(volume) }));
  }

  /** A click or Alt+A at (x, y): a volume alert on the volume bars, else a price alert. */
  placeAt(x, y, magnet = false) {
    const chart = this.view.chart;
    const volume = chart.volumeAt(x, y);
    if (volume !== null) return this.addVolume(volume);
    const price = chart.priceAt(x, y, { magnet });
    if (price !== null) return this.add(price);
    return null;
  }

  /** Over the candles or over the volume bars: anywhere an alert can go. */
  placeable(x, y) {
    const chart = this.view.chart;
    return chart.inPlot(x, y) || chart.volumeAt(x, y) !== null;
  }

  /** While the bell is armed, say what a click on the volume bars would set. */
  showTip(x, y) {
    const volume = this.view.activeTool === 'alert' ? this.view.chart.volumeAt(x, y) : null;
    if (volume === null) {
      this.tip.hidden = true;
      return;
    }
    this.tip.hidden = false;
    this.tip.textContent = t('成交量提醒 {volume}', { volume: formatCompact(roundVolume(volume)) });
    this.tip.style.left = `${Math.round(x + 12)}px`;
    this.tip.style.top = `${Math.round(y)}px`;
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
      if (!this.placeable(x, y)) return;
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
      view.setActiveTool('cursor');
      this.tip.hidden = true;
      this.placeAt(x, y, press.ctrl || event.ctrlKey);
    };
    this.onMove = (event) => {
      const { x, y } = local(event);
      this.hoverY = this.placeable(x, y) ? { x, y } : null;
      this.showTip(x, y);
    };
    this.onLeave = () => {
      this.hoverY = null;
      this.tip.hidden = true;
    };
    // Alt+A at the crosshair -- TradingView's shortcut. Only for the card
    // under the pointer, which also settles which card on a board.
    this.onKey = (event) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.code !== 'KeyA') return;
      const t = event.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (!this.hoverY) return;
      event.preventDefault();
      this.placeAt(this.hoverY.x, this.hoverY.y);
    };

    // Dragging a label moves its alert.
    this.onDragMove = (event) => {
      const d = this.drag;
      if (!d) return;
      const { x, y } = local(event);
      if (d.kind === 'volume') {
        const zone = view.chart.volumeZone();
        const v = zone ? view.chart.volume.total.coordinateToPrice(y - zone.origin) : null;
        if (!(v > 0)) return;
        d.value = roundVolume(v);
      } else {
        const price = view.chart.priceAt(x, y);
        if (price === null) return;
        d.value = Number(view.chart.formatPrice(price));
      }
      d.moved = d.moved || Math.abs(event.clientY - d.startY) > 2;
      this.render();
    };
    this.onDragUp = async () => {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      document.body.style.cursor = '';
      if (!d.moved) {
        this.render();
        return;
      }
      if (d.kind === 'volume') {
        await api().update(d.id, { volume: d.value, notBefore: this.notBefore(d.value) });
        return;
      }
      const current = this.currentPrice();
      if (current === null || d.value === current) {
        this.render();
        return;
      }
      await api().update(d.id, { price: d.value, direction: d.value > current ? 'up' : 'down' });
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

  /**
   * From an alert layer's render pass: labels land in the same frame as the
   * lines. A layer's y is within its own pane; the volume one may sit in a
   * pane of its own below the price.
   */
  placeLabels(items, kind) {
    const chart = this.view.chart;
    let top = 0;
    let bottom = Infinity;
    let origin = 0;
    try {
      if (kind === 'volume') {
        const zone = chart.volumeZone();
        if (!zone) items = [];
        else ({ top, bottom, origin } = zone);
      } else {
        bottom = chart.chart.panes()[0].getHeight();
      }
    } catch {
      /* mid-teardown */
    }
    const labels = this.labelEls[kind];
    const seen = new Set();
    for (const it of items) {
      const y = it.y + origin;
      if (y < top || y > bottom) continue;
      seen.add(it.id);
      let node = labels.get(it.id);
      if (!node) {
        node = this.buildLabel(it.id, kind);
        labels.set(it.id, node);
        this.labels.append(node.root);
      }
      node.update(it);
      const px = `${Math.round(y)}px`;
      if (node.root.style.top !== px) node.root.style.top = px;
    }
    for (const [id, node] of labels) {
      if (seen.has(id)) continue;
      node.root.remove();
      labels.delete(id);
    }
  }

  buildLabel(id, kind) {
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
      this.drag = { id, kind, value: kind === 'volume' ? a.volume : a.price, startY: e.clientY, moved: false };
      document.body.style.cursor = 'ns-resize';
    });
    let last = '';
    return {
      root,
      update: (it) => {
        const label =
          kind === 'volume'
            ? t('量 ≥ {volume}', { volume: formatCompact(it.price) })
            : `${it.alert.direction === 'up' ? '↑' : '↓'} ${this.view.chart.formatPrice(it.price)}`;
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
    if (this.view.chart) {
      this.view.chart.alertLayer.onLayout = null;
      this.view.chart.volumeAlertLayer.onLayout = null;
    }
    this.overlay.remove();
  }
}
