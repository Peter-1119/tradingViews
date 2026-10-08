/**
 * Trading lines on the price chart: the position's entry, its liquidation
 * price, working limit orders, TP/SL, and the order ticket's draft.
 *
 * The lines and their axis tags are painted here, by the chart, in the same
 * frame as the candles. The *labels* -- which carry buttons (cancel, close)
 * and want crisp text and hover states -- are DOM, positioned by the trade
 * controller from `onLayout`, which runs inside the same render pass
 * (updateAllViews), so the two cannot drift apart.
 */

const MAX_AXIS = 12;

class TradeRenderer {
  constructor(source) {
    this.source = source;
  }

  draw(target) {
    const items = this.source.layout;
    if (!items.length) return;
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      for (const it of items) {
        const width = Math.max(1, Math.round((it.width || 1) * vr));
        const y = Math.round(it.y * vr) + (width % 2 ? 0.5 : 0);
        ctx.save();
        ctx.strokeStyle = it.color;
        ctx.globalAlpha = it.alpha ?? 1;
        ctx.lineWidth = width;
        ctx.setLineDash(it.dash ? it.dash.map((d) => d * hr) : []);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(bitmapSize.width, y);
        ctx.stroke();
        ctx.restore();
      }
    });
  }
}

class TradePaneView {
  constructor(source) {
    this.rendererInstance = new TradeRenderer(source);
  }

  renderer() {
    return this.rendererInstance;
  }

  zOrder() {
    return 'top';
  }
}

class TradeAxisView {
  constructor(source, index) {
    this.source = source;
    this.index = index;
  }

  item() {
    const list = this.source.axisItems;
    return list[this.index] || null;
  }

  coordinate() {
    const it = this.item();
    return it ? it.y : -1000;
  }

  text() {
    const it = this.item();
    return it ? this.source.card.formatPrice(it.price) : '';
  }

  textColor() {
    const it = this.item();
    return it && it.axisText ? it.axisText : '#0b0f17';
  }

  backColor() {
    const it = this.item();
    return it ? it.color : 'transparent';
  }

  visible() {
    return !!this.item();
  }

  tickVisible() {
    return false;
  }
}

export class TradePrimitive {
  /** @param {import('../chart.js').CardChart} card */
  constructor(card) {
    this.card = card;
    /** [{id, price, color, dash?, width?, alpha?, axis?: boolean, axisText?}] */
    this.items = [];
    this.layout = [];
    this.axisItems = [];
    this.requestUpdate = null;
    this.onLayout = null;
    this.views = [new TradePaneView(this)];
    this.axisViews = Array.from({ length: MAX_AXIS }, (_, i) => new TradeAxisView(this, i));
  }

  attached({ requestUpdate }) {
    this.requestUpdate = requestUpdate;
  }

  detached() {
    this.requestUpdate = null;
  }

  paneViews() {
    return this.views;
  }

  priceAxisViews() {
    return this.axisViews;
  }

  updateAllViews() {
    const out = [];
    for (const it of this.items) {
      const y = this.card.priceToY(it.price);
      if (y === null || !Number.isFinite(y)) continue;
      out.push({ ...it, y });
    }
    this.layout = out;
    this.axisItems = out.filter((it) => it.axis).slice(0, MAX_AXIS);
    if (this.onLayout) this.onLayout(out);
  }

  setItems(items) {
    this.items = Array.isArray(items) ? items : [];
    if (this.requestUpdate) this.requestUpdate();
  }
}
