/**
 * The latest price: a dashed line across the pane and a tag on the price axis,
 * always for the *newest* bar.
 *
 * Replaces the series' own last-value tag and price line, which follow the
 * last *visible* bar once the chart is scrolled back -- so looking at history
 * showed the price at the right edge of the window, a number that says
 * nothing. And when the live price is outside the price range on screen (the
 * usual case after scrolling back, since autoscale fits what is visible), no
 * built-in tag shows it at all. Here the tag then pins to the top or bottom of
 * the axis with an arrow, so where price is *now* is always one glance away.
 */

const TAG_HALF_PX = 9;

class LivePriceRenderer {
  constructor(source) {
    this.source = source;
  }

  draw(target) {
    const l = this.source.layout;
    if (!l || l.clamped) return;
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      const width = Math.max(1, Math.floor(vr));
      const y = Math.round(l.y * vr) + (width % 2 ? 0.5 : 0);
      ctx.save();
      ctx.strokeStyle = l.lineColor;
      ctx.lineWidth = width;
      ctx.setLineDash([2 * hr, 2 * hr]);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(bitmapSize.width, y);
      ctx.stroke();
      ctx.restore();
    });
  }
}

class LivePricePaneView {
  constructor(source) {
    this.rendererInstance = new LivePriceRenderer(source);
  }

  renderer() {
    return this.rendererInstance;
  }

  zOrder() {
    return 'top';
  }
}

class LivePriceAxisView {
  constructor(source) {
    this.source = source;
  }

  coordinate() {
    return this.source.layout ? this.source.layout.tagY : -1000;
  }

  text() {
    const l = this.source.layout;
    if (!l) return '';
    const price = this.source.card.formatPrice(l.price);
    return l.clamped === 'above' ? `▲ ${price}` : l.clamped === 'below' ? `▼ ${price}` : price;
  }

  textColor() {
    return '#ffffff';
  }

  backColor() {
    return this.source.layout ? this.source.layout.color : 'transparent';
  }

  visible() {
    return !!this.source.layout;
  }

  tickVisible() {
    return false;
  }
}

export class LivePricePrimitive {
  /** @param {import('./chart.js').CardChart} card */
  constructor(card) {
    this.card = card;
    this.layout = null;
    this.views = [new LivePricePaneView(this)];
    this.axisViews = [new LivePriceAxisView(this)];
  }

  paneViews() {
    return this.views;
  }

  priceAxisViews() {
    return this.axisViews;
  }

  updateAllViews() {
    this.layout = this.computeLayout();
  }

  computeLayout() {
    const card = this.card;
    const bar = card.bars[card.bars.length - 1];
    if (!bar || !card.priceSeries) return null;
    const y = card.priceToY(bar.close);
    if (y === null || !Number.isFinite(y)) return null;
    let height = 0;
    try {
      height = card.chart.panes()[0].getHeight();
    } catch {
      return null;
    }
    // The series' own colours: line and area are drawn in the rising colour
    // throughout; candles take the newest candle's direction.
    const { up, down } = card.colors;
    const color = card.chartType === 'candlestick' && bar.close < bar.open ? down : up;
    let clamped = null;
    let tagY = y;
    if (y < TAG_HALF_PX) {
      clamped = y < 0 ? 'above' : null;
      tagY = TAG_HALF_PX;
    } else if (y > height - TAG_HALF_PX) {
      clamped = y > height ? 'below' : null;
      tagY = height - TAG_HALF_PX;
    }
    return { price: bar.close, y, tagY, clamped, color, lineColor: withAlpha(color, 0.55) };
  }
}

function withAlpha(hex, alpha) {
  const v = String(hex).replace('#', '');
  if (v.length !== 6) return hex;
  const n = (i) => parseInt(v.slice(i, i + 2), 16);
  return `rgba(${n(0)}, ${n(2)}, ${n(4)}, ${alpha})`;
}
