/**
 * Higher-timeframe candles drawn *by the chart*, as a series primitive.
 *
 * This replaced a DOM overlay, and the reason is worth keeping. The overlay was
 * repositioned from outside: on a 4h tick, on a visible-range change, after a
 * reload. Resizing the card fired none of those -- `lockVisibleTimeRangeOnResize`
 * deliberately holds the time range still, so the range subscriber stays silent
 * -- and a price-axis autoscale has no event at all. The boxes sat where they
 * were until the next 4h tick, up to a second later, which read as the overlay
 * lagging and not quite fitting the candles.
 *
 * A primitive has no such gap. The chart calls `updateAllViews` whenever the
 * viewport changes and then paints this in the same frame as the candles, with
 * the same coordinate conversions, so the two cannot drift.
 *
 * Geometry: a candle is drawn centred on its time, so a box running from
 * x(open) to x(open + 4h) starts half a bar late and ends half a bar into the
 * next group. Edges go on bar *boundaries* instead -- logical index +/- 0.5 --
 * so each box hugs exactly the candles it is made of.
 */

const SECONDS = 4 * 3600;

function rgba(hex, alpha) {
  const v = hex.replace('#', '');
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

class HtfRenderer {
  constructor(source) {
    this.source = source;
  }

  draw() {
    /* everything happens in drawBackground, beneath the series */
  }

  drawBackground(target) {
    const boxes = this.source.boxes;
    if (!boxes.length) return;

    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      const line = Math.max(1, Math.floor(hr));
      for (const box of boxes) {
        const x0 = Math.round(box.left * hr);
        const x1 = Math.round(box.right * hr);
        const bodyTop = Math.round(box.bodyTop * vr);
        const bodyBottom = Math.max(bodyTop + line, Math.round(box.bodyBottom * vr));
        const width = Math.max(line, x1 - x0);

        ctx.fillStyle = box.fill;
        ctx.fillRect(x0, bodyTop, width, bodyBottom - bodyTop);

        // Wick in two pieces, outside the body only -- through a translucent
        // body a full-length wick would show as a stripe down the middle.
        const mid = Math.round(((box.left + box.right) / 2) * hr) - Math.floor(line / 2);
        const high = Math.round(box.high * vr);
        const low = Math.round(box.low * vr);
        ctx.fillStyle = box.wick;
        if (bodyTop > high) ctx.fillRect(mid, high, line, bodyTop - high);
        if (low > bodyBottom) ctx.fillRect(mid, bodyBottom, line, low - bodyBottom);

        ctx.lineWidth = line;
        ctx.strokeStyle = box.stroke;
        // Dashed edge marks the candle still being traded -- the only one whose
        // shape can still change.
        ctx.setLineDash(box.live ? [4 * hr, 3 * hr] : []);
        const inset = line / 2;
        ctx.strokeRect(x0 + inset, bodyTop + inset, width - line, bodyBottom - bodyTop - line);
      }
      ctx.setLineDash([]);
    });
  }
}

class HtfPaneView {
  constructor(source) {
    this.rendererInstance = new HtfRenderer(source);
  }

  zOrder() {
    return 'bottom';
  }

  renderer() {
    return this.rendererInstance;
  }
}

export class HtfPrimitive {
  /** @param {import('./chart.js').CardChart} card  for its interpolated conversions */
  constructor(card) {
    this.card = card;
    this.bars = [];
    this.enabled = false;
    this.colors = { up: '#26c281', down: '#ed5465' };
    this.boxes = [];
    this.requestUpdate = null;
    this.views = [new HtfPaneView(this)];
  }

  /* --------------------------------------------------- ISeriesPrimitive */

  attached({ requestUpdate }) {
    this.requestUpdate = requestUpdate;
  }

  detached() {
    this.requestUpdate = null;
  }

  paneViews() {
    return this.views;
  }

  /** Called by the chart on every viewport change: resize, scroll, zoom, data. */
  updateAllViews() {
    this.boxes = this.enabled ? this.computeBoxes() : [];
  }

  /* ----------------------------------------------------------- public */

  setBars(bars) {
    this.bars = Array.isArray(bars) ? bars : [];
    this.update();
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
    this.update();
  }

  setColors(colors) {
    this.colors = colors;
    this.update();
  }

  update() {
    if (this.requestUpdate) this.requestUpdate();
  }

  /* ---------------------------------------------------------- geometry */

  computeBoxes() {
    const card = this.card;
    const own = card.bars;
    if (!own.length || !this.bars.length) return [];
    // The newest candle on the card is where the last tick landed.
    const lastLogical = own.length - 1;

    const out = [];
    for (const bar of this.bars) {
      const startLogical = card.logicalFromTime(bar.time);
      const endLogical = card.logicalFromTime(bar.time + SECONDS);
      if (startLogical === null || endLogical === null) continue;

      const live = bar.closed === false;
      // Closed: through its last constituent candle. Forming: only as far as
      // the candle holding the latest tick -- the 4h window's remaining hours
      // have not traded yet and there is nothing to draw there.
      const rightLogical = live ? Math.min(endLogical, lastLogical + 1) : endLogical;

      const left = card.logicalToX(startLogical - 0.5);
      const right = card.logicalToX(rightLogical - 0.5);
      const yOpen = card.priceToY(bar.open);
      const yClose = card.priceToY(bar.close);
      const yHigh = card.priceToY(bar.high);
      const yLow = card.priceToY(bar.low);
      if ([left, right, yOpen, yClose, yHigh, yLow].some((v) => v === null)) continue;
      if (right <= left) continue;

      const rising = bar.close >= bar.open;
      const color = rising ? this.colors.up : this.colors.down;
      out.push({
        left,
        right,
        bodyTop: Math.min(yOpen, yClose),
        bodyBottom: Math.max(yOpen, yClose),
        high: yHigh,
        low: yLow,
        live,
        fill: rgba(color, live ? 0.2 : 0.13),
        stroke: rgba(color, live ? 0.75 : 0.4),
        wick: rgba(color, 0.4),
      });
    }
    return out;
  }
}
