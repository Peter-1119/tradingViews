/**
 * The Shift-drag measure box, drawn by the chart as a series primitive.
 *
 * It was an HTML box over the chart, repositioned on time-range changes only;
 * resizing the card or rescaling the price axis left it behind the candles.
 * Here it is recomputed on every viewport change and painted with them.
 *
 * Anchors are logical (fractional bar index) plus price, so the box stays on
 * its candles through panning and zooming and still resolves out in the
 * rightOffset gap past the last bar.
 */

import { formatAtPrecision, formatPercent, formatDuration } from './util.js';

const FILL_ALPHA = 0.16;
const EDGE_ALPHA = 0.75;
/** Readout geometry, in CSS px. */
const FONT_PX = 10;
const PAD_X = 6;
const PAD_Y = 3;
const LINE_GAP = 3;
const OFFSET = 4;

function rgba(hex, alpha) {
  const v = hex.replace('#', '');
  return `rgba(${parseInt(v.slice(0, 2), 16)}, ${parseInt(v.slice(2, 4), 16)}, ${parseInt(v.slice(4, 6), 16)}, ${alpha})`;
}

class MeasureRenderer {
  constructor(source) {
    this.source = source;
  }

  draw(target) {
    const m = this.source.layout;
    if (!m) return;
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      const x0 = Math.round(m.left * hr);
      const y0 = Math.round(m.top * vr);
      const x1 = Math.round(m.right * hr);
      const y1 = Math.round(m.bottom * vr);
      const line = Math.max(1, Math.floor(hr));

      ctx.fillStyle = rgba(m.color, FILL_ALPHA);
      ctx.fillRect(x0, y0, Math.max(line, x1 - x0), Math.max(line, y1 - y0));
      ctx.lineWidth = line;
      ctx.strokeStyle = rgba(m.color, EDGE_ALPHA);
      ctx.strokeRect(x0 + line / 2, y0 + line / 2, Math.max(0, x1 - x0 - line), Math.max(0, y1 - y0 - line));

      ctx.font = `600 ${Math.round(FONT_PX * vr)}px 'Segoe UI', 'Microsoft JhengHei', sans-serif`;
      ctx.textBaseline = 'top';
      const lineH = Math.round((FONT_PX + LINE_GAP) * vr);
      const textW = Math.max(...m.lines.map((t) => ctx.measureText(t).width));
      const w = Math.ceil(textW + 2 * PAD_X * hr);
      const h = m.lines.length * lineH + Math.round(2 * PAD_Y * vr) - Math.round(LINE_GAP * vr);

      // Centred on the box, hung off whichever end the pointer is at, then
      // clamped inside the plot on both axes -- on a card this size the box is
      // near an edge more often than not.
      let lx = Math.round((x0 + x1) / 2 - w / 2);
      let ly = m.below ? y1 + Math.round(OFFSET * vr) : y0 - Math.round(OFFSET * vr) - h;
      lx = Math.max(0, Math.min(bitmapSize.width - w, lx));
      ly = Math.max(0, Math.min(bitmapSize.height - h, ly));

      ctx.fillStyle = m.color;
      const r = Math.round(5 * hr);
      ctx.beginPath();
      ctx.roundRect(lx, ly, w, h, r);
      ctx.fill();

      ctx.fillStyle = '#0b0f17';
      ctx.textAlign = 'center';
      m.lines.forEach((text, i) => {
        ctx.fillText(text, lx + w / 2, ly + Math.round(PAD_Y * vr) + i * lineH);
      });
    });
  }
}

class MeasurePaneView {
  constructor(source) {
    this.rendererInstance = new MeasureRenderer(source);
  }

  renderer() {
    return this.rendererInstance;
  }
}

export class MeasurePrimitive {
  /** @param {import('./chart.js').CardChart} card */
  constructor(card) {
    this.card = card;
    this.span = null;
    this.layout = null;
    this.requestUpdate = null;
    this.views = [new MeasurePaneView(this)];
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

  updateAllViews() {
    this.layout = this.span ? this.computeLayout() : null;
  }

  /** @param {{from: {logical, price}, to: {logical, price}} | null} span */
  set(span) {
    this.span = span;
    if (this.requestUpdate) this.requestUpdate();
  }

  computeLayout() {
    const { from, to } = this.span;
    const a = this.card.pointToPixel(from);
    const b = this.card.pointToPixel(to);
    if (!a || !b) return null;

    const stats = this.card.measureStats(from, to);
    // Rising takes the "up" colour, whichever colour the user has made that.
    const color = stats.rising ? this.card.colors.up : this.card.colors.down;
    const sign = stats.priceDelta >= 0 ? '+' : '-';
    // At the instrument's precision, not the delta's own magnitude: a 550 move
    // on an 86,000 instrument quotes 2 decimals, not 3.
    const delta = formatAtPrecision(Math.abs(stats.priceDelta), this.card.precision);
    return {
      left: Math.min(a.x, b.x),
      right: Math.max(a.x, b.x),
      top: Math.min(a.y, b.y),
      bottom: Math.max(a.y, b.y),
      below: b.y > a.y,
      color,
      lines: [
        `${sign}${delta} (${formatPercent(stats.percent)})`,
        `${stats.bars} bars · ${formatDuration(stats.seconds)}`,
      ],
    };
  }
}
