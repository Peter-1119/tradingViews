/**
 * The highest and lowest price on screen, marked where they happened -- the
 * little "── 2,714.10" tags Binance's app hangs off the extreme wicks.
 *
 * Recomputed in updateAllViews, so it follows every pan, zoom, resize and
 * rescale in the same frame as the candles. Only bars fully on screen count:
 * a wick half cut off by the edge is not "in view" in any useful sense.
 *
 * Candles are measured by their highs and lows. A line or area chart only
 * ever draws closes, so there the extremes are the highest and lowest close
 * -- marking a wick the chart does not show would point at empty space.
 */

/** Leader line length, gap to the text, and clearance from the bar, in CSS px. */
const LEADER = 18;
const GAP = 4;
const OFFSET = 3;
const FONT_PX = 10.5;

const TEXT = 'rgba(226, 232, 240, 0.86)';
const LINE = 'rgba(226, 232, 240, 0.5)';

class ExtremesRenderer {
  constructor(source) {
    this.source = source;
  }

  draw(target) {
    const marks = this.source.layout;
    if (!marks.length) return;
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      ctx.font = `${Math.round(FONT_PX * vr)}px 'Segoe UI', 'Microsoft JhengHei', sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.lineWidth = Math.max(1, Math.floor(hr));
      for (const m of marks) {
        const text = m.label;
        const textW = ctx.measureText(text).width;
        const x = m.x * hr;
        const y = Math.round(m.y * vr) + 0.5;
        const leader = LEADER * hr;
        const gap = GAP * hr;
        // Point inwards, towards the middle of the chart, so the tag never runs
        // off the edge or under the price axis. Where even that does not fit
        // (a narrow card, zoomed far out), slide the whole tag back inside.
        let dir = m.x * hr > bitmapSize.width / 2 ? -1 : 1;
        let end = x + dir * leader;
        let textX = dir > 0 ? end + gap : end - gap - textW;
        if (textX < 2 * hr) textX = 2 * hr;
        if (textX + textW > bitmapSize.width - 2 * hr) textX = bitmapSize.width - 2 * hr - textW;
        end = dir > 0 ? Math.min(end, textX - gap) : Math.max(end, textX + textW + gap);

        ctx.strokeStyle = LINE;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(end, y);
        ctx.stroke();

        // A dark halo so the figure stays legible over candles and grid.
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(2, Math.round(3 * vr));
        ctx.strokeStyle = 'rgba(6, 9, 15, 0.85)';
        ctx.strokeText(text, textX, y);
        ctx.fillStyle = TEXT;
        ctx.fillText(text, textX, y);
        ctx.lineWidth = Math.max(1, Math.floor(hr));
      }
    });
  }
}

class ExtremesPaneView {
  constructor(source) {
    this.rendererInstance = new ExtremesRenderer(source);
  }

  renderer() {
    return this.rendererInstance;
  }
}

export class ExtremesPrimitive {
  /** @param {import('./chart.js').CardChart} card */
  constructor(card) {
    this.card = card;
    this.enabled = true;
    this.layout = [];
    this.requestUpdate = null;
    this.views = [new ExtremesPaneView(this)];
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
    this.layout = this.enabled ? this.computeLayout() : [];
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
    if (this.requestUpdate) this.requestUpdate();
  }

  computeLayout() {
    const card = this.card;
    const bars = card.bars;
    if (!bars.length || !card.chart) return [];
    const range = card.chart.timeScale().getVisibleLogicalRange();
    if (!range) return [];
    const from = Math.max(0, Math.ceil(range.from));
    const to = Math.min(bars.length - 1, Math.floor(range.to));
    if (to < from) return [];

    const wicks = card.chartType === 'candlestick';
    let hi = from;
    let lo = from;
    for (let i = from + 1; i <= to; i++) {
      if ((wicks ? bars[i].high : bars[i].close) > (wicks ? bars[hi].high : bars[hi].close)) hi = i;
      if ((wicks ? bars[i].low : bars[i].close) < (wicks ? bars[lo].low : bars[lo].close)) lo = i;
    }
    const high = wicks ? bars[hi].high : bars[hi].close;
    const low = wicks ? bars[lo].low : bars[lo].close;
    if (!(high > low)) return [];

    const out = [];
    const put = (index, price, dy) => {
      const x = card.logicalToX(index);
      const y = card.priceToY(price);
      if (x === null || y === null) return;
      out.push({ x, y: y + dy, label: card.formatPrice(price) });
    };
    // Candles: the tag sits just off the wick tip. Lines: on the point itself.
    put(hi, high, wicks ? -OFFSET : 0);
    put(lo, low, wicks ? OFFSET : 0);
    return out;
  }
}
