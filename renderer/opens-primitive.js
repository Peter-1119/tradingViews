/**
 * Daily / weekly / monthly open lines, drawn by the chart (a series primitive).
 *
 * Each is a ray from the bar its period opened on, out to the right -- the
 * way short-term traders mark them -- rather than a full-width line. That is
 * also what keeps them apart from the user's own levels, which span the whole
 * chart, dashed, in one blue-grey. These are solid, one colour per period,
 * with a tag at their start and a matching price tag on the axis.
 *
 * An open beyond the visible price range is not simply lost: it is pinned to
 * the top or bottom edge as "↑ 月開 92,500 +10.3%", saying where it is and how
 * far. The point of the toggle is often just to find out where they are.
 */

export const OPEN_KINDS = Object.freeze([
  { key: 'M', label: '月開', color: '#f472b6' },
  { key: 'W', label: '週開', color: '#a78bfa' },
  { key: 'D', label: '日開', color: '#2dd4bf' },
]);

const FONT = "10px 'Segoe UI', -apple-system, 'Noto Sans TC', 'Microsoft JhengHei', sans-serif";

class OpensRenderer {
  constructor(source) {
    this.source = source;
  }

  draw(target) {
    const { lines, edges } = this.source.layout;
    if (!lines.length && !edges.length) return;

    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      ctx.save();
      ctx.font = FONT.replace('10px', `${Math.round(10 * vr)}px`);
      ctx.textBaseline = 'middle';
      const lineWidth = Math.max(1, Math.round(1.25 * hr));

      for (const l of lines) {
        const y = Math.round(l.y * vr) + (lineWidth % 2 ? 0.5 : 0);
        const x0 = Math.round(l.x0 * hr);
        const x1 = Math.round(l.x1 * hr);
        ctx.strokeStyle = l.color;
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = lineWidth;
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
        // A short upright tick marks the bar the period opened on.
        if (!l.clipped) {
          ctx.moveTo(x0, y - 4 * vr);
          ctx.lineTo(x0, y + 4 * vr);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
        // At its start when that is on screen. A line that began off to the
        // left gets its tag by the price axis instead: the left edge is where
        // the tool rail and the position readout live.
        const x = l.clipped ? x1 - pillWidth(ctx, l.text, hr) - 4 * hr : x0 + 4 * hr;
        pill(ctx, l.text, x, y - 8 * vr, l.color, hr, vr);
      }

      for (const e of edges) {
        // Right-aligned against the price axis, where the eye goes for prices.
        const w = pillWidth(ctx, e.text, hr);
        pill(ctx, e.text, e.right * hr - w, e.y * vr, e.color, hr, vr);
      }
      ctx.restore();
    });
  }
}

function pillWidth(ctx, text, hr) {
  return ctx.measureText(text).width + 8 * hr;
}

/** A filled tag, vertically centred on `y`, starting at `x`. */
function pill(ctx, text, x, y, color, hr, vr) {
  const padX = 4 * hr;
  const height = 13 * vr;
  const width = pillWidth(ctx, text, hr);
  const top = y - height / 2;
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.92;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, top, width, height, 3 * hr);
  else ctx.rect(x, top, width, height);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#0b0f17';
  ctx.fillText(text, x + padX, top + height / 2 + 0.5 * vr);
}

class OpensPaneView {
  constructor(source) {
    this.rendererInstance = new OpensRenderer(source);
  }

  zOrder() {
    return 'top';
  }

  renderer() {
    return this.rendererInstance;
  }
}

/** The coloured price tag on the axis, one per visible line. */
class OpensAxisView {
  constructor(source, index) {
    this.source = source;
    this.index = index;
  }

  item() {
    return this.source.layout.lines[this.index] || null;
  }

  coordinate() {
    const l = this.item();
    return l ? l.y : -1000;
  }

  text() {
    const l = this.item();
    return l ? this.source.card.formatPrice(l.price) : '';
  }

  textColor() {
    return '#0b0f17';
  }

  backColor() {
    const l = this.item();
    return l ? l.color : 'transparent';
  }

  visible() {
    return !!this.item();
  }

  tickVisible() {
    return false;
  }
}

export class OpensPrimitive {
  /** @param {import('./chart.js').CardChart} card */
  constructor(card) {
    this.card = card;
    /** [{key, time (seconds), price}] -- the current period's open of each kind */
    this.opens = [];
    this.enabled = false;
    this.layout = { lines: [], edges: [] };
    this.requestUpdate = null;
    this.views = [new OpensPaneView(this)];
    this.axisViews = OPEN_KINDS.map((_, i) => new OpensAxisView(this, i));
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
    this.layout = this.enabled ? this.computeLayout() : { lines: [], edges: [] };
  }

  setOpens(opens) {
    this.opens = Array.isArray(opens) ? opens : [];
    this.update();
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
    this.update();
  }

  update() {
    if (this.requestUpdate) this.requestUpdate();
  }

  computeLayout() {
    const card = this.card;
    if (!card.bars.length || !this.opens.length) return { lines: [], edges: [] };
    const width = card.plotWidth();
    let height = 0;
    try {
      height = card.chart.panes()[0].getHeight();
    } catch {
      return { lines: [], edges: [] };
    }
    const last = card.bars[card.bars.length - 1].close;

    // Same price, one line: on a Monday the daily open *is* the weekly open.
    const merged = [];
    for (const kind of OPEN_KINDS) {
      const open = this.opens.find((o) => o.key === kind.key);
      if (!open || !Number.isFinite(open.price)) continue;
      const same = merged.find((m) => m.price === open.price);
      if (same) {
        same.labels.push(kind.label);
        same.time = Math.max(same.time, open.time);
        same.color = kind.color; // the shortest period's colour: it is the one that rolls next
      } else {
        merged.push({ ...open, labels: [kind.label], color: kind.color });
      }
    }

    const lines = [];
    const above = [];
    const below = [];
    for (const m of merged) {
      const y = card.priceToY(m.price);
      const label = m.labels.join('・');
      if (y === null || y < 0 || y > height) {
        const change = last ? ((m.price - last) / last) * 100 : 0;
        const text = `${y !== null && y > height ? '↓' : '↑'} ${label} ${card.formatPrice(m.price)} ${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
        (y !== null && y > height ? below : above).push({ text, color: m.color });
        continue;
      }
      const logical = card.logicalFromTime(m.time);
      let x0 = logical === null ? 0 : card.logicalToX(logical - 0.5);
      const clipped = x0 === null || x0 < 0;
      if (clipped) x0 = 0;
      if (x0 >= width) continue;
      lines.push({ y, x0, x1: width, price: m.price, color: m.color, clipped, text: clipped ? `${label} ◀` : label });
    }

    // Off-screen tags stack inward from their edge, against the price axis:
    // below the funding readout at the top, above the reset button at the
    // bottom, and clear of the position readout and tool rail on the left.
    const edges = [];
    const place = (list, fromTop) =>
      list.forEach((e, i) => {
        edges.push({ ...e, right: width - 6, y: fromTop ? 30 + i * 15 : height - 40 - i * 15 });
      });
    place(above, true);
    place(below, false);
    return { lines, edges };
  }
}
