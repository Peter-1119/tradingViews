/**
 * Period levels -- opens, previous highs and lows, current highs and lows of
 * the day, week and month -- drawn by the chart (a series primitive).
 *
 * Each is a ray from the bar it was made on, out to the right: an open from
 * the bar its period opened on, a high or low from the bar that printed it.
 * That, and colour, is what keeps them apart from the user's own levels,
 * which span the whole chart, dashed, in one blue-grey.
 *
 *   colour = period   day teal, week violet, month pink
 *   stroke = kind     open solid, previous high/low dashed, current dotted
 *
 * plus a tag naming it at its start and a matching price tag on the axis.
 *
 * A level beyond the visible price range is not simply lost: it is pinned to
 * the top or bottom edge as "↑ 前週高 92,500 +10.3%", saying where it is and
 * how far -- nearest first, a few per edge. Often the point of turning these
 * on is just to find out where they are.
 */

const COLORS = { D: '#2dd4bf', W: '#a78bfa', M: '#f472b6' };
/** Bitmap-independent dash patterns, scaled per draw. */
const DASH = { open: [], prev: [6, 4], current: [1.5, 3] };
/** When levels coincide, the merged line takes the strongest of their strokes. */
const STRENGTH = { open: 3, prev: 2, current: 1 };
const MAX_EDGE = 4;
const MAX_AXIS = 15;

const FONT = "10px 'Segoe UI', -apple-system, 'Noto Sans TC', 'Microsoft JhengHei', sans-serif";

function strokeOf(kind) {
  if (kind === 'open') return 'open';
  if (kind === 'prevHigh' || kind === 'prevLow') return 'prev';
  return 'current';
}

class LevelsRenderer {
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
        ctx.setLineDash(DASH[l.stroke].map((d) => d * hr));
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
        ctx.stroke();
        ctx.setLineDash([]);
        // A short upright tick marks the bar the level was made on.
        if (!l.clipped) {
          ctx.beginPath();
          ctx.moveTo(x0, y - 4 * vr);
          ctx.lineTo(x0, y + 4 * vr);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        // At its start when that is on screen. A line that began off to the
        // left gets its tag by the price axis instead: the left edge is where
        // the tool rail and the position readout live.
        // A line that only just started (tonight's open) has no room after its
        // start either: the tag would run under the axis. Same treatment.
        const w = pillWidth(ctx, l.text, hr);
        const x = l.clipped || x0 + 4 * hr + w > x1 ? x1 - w - 4 * hr : x0 + 4 * hr;
        // Above the line, unless that would put it past the top of the plot.
        const tagY = l.y < 16 ? y + 8 * vr : y - 8 * vr;
        pill(ctx, l.text, x, tagY, l.color, hr, vr);
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

class LevelsPaneView {
  constructor(source) {
    this.rendererInstance = new LevelsRenderer(source);
  }

  zOrder() {
    return 'top';
  }

  renderer() {
    return this.rendererInstance;
  }
}

/** The coloured price tag on the axis, one per visible line. */
class LevelsAxisView {
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

export class PeriodLevelsPrimitive {
  /** @param {import('./chart.js').CardChart} card */
  constructor(card) {
    this.card = card;
    /** [{id, period: 'D'|'W'|'M', kind, label, time (seconds), price}] from sessions.js */
    this.levels = [];
    this.layout = { lines: [], edges: [] };
    this.requestUpdate = null;
    this.views = [new LevelsPaneView(this)];
    this.axisViews = Array.from({ length: MAX_AXIS }, (_, i) => new LevelsAxisView(this, i));
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
    this.layout = this.computeLayout();
  }

  setLevels(levels) {
    this.levels = Array.isArray(levels) ? levels : [];
    if (this.requestUpdate) this.requestUpdate();
  }

  computeLayout() {
    const card = this.card;
    if (!card.bars.length || !this.levels.length) return { lines: [], edges: [] };
    const width = card.plotWidth();
    let height = 0;
    try {
      height = card.chart.panes()[0].getHeight();
    } catch {
      return { lines: [], edges: [] };
    }
    const last = card.bars[card.bars.length - 1].close;

    // Same price, one line: on a Monday the daily open *is* the weekly open,
    // and a day that only fell has its open as its high. Longest period first,
    // so the merged line ends up in the shortest period's colour -- the one
    // that rolls over next -- and the strongest stroke among them.
    const order = { M: 0, W: 1, D: 2 };
    const merged = [];
    for (const level of [...this.levels].sort((a, b) => order[a.period] - order[b.period])) {
      if (!Number.isFinite(level.price)) continue;
      const stroke = strokeOf(level.kind);
      const same = merged.find((m) => m.price === level.price);
      if (same) {
        same.labels.push(level.label);
        same.time = Math.min(same.time, level.time);
        same.color = COLORS[level.period];
        if (STRENGTH[stroke] > STRENGTH[same.stroke]) same.stroke = stroke;
      } else {
        merged.push({ price: level.price, time: level.time, labels: [level.label], color: COLORS[level.period], stroke });
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
        const isBelow = y !== null && y > height;
        const text = `${isBelow ? '↓' : '↑'} ${label} ${card.formatPrice(m.price)} ${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
        (isBelow ? below : above).push({ text, color: m.color, distance: Math.abs(change) });
        continue;
      }
      const logical = card.logicalFromTime(m.time);
      let x0 = logical === null ? 0 : card.logicalToX(logical - 0.5);
      const clipped = x0 === null || x0 < 0;
      if (clipped) x0 = 0;
      if (x0 >= width) continue;
      lines.push({ y, x0, x1: width, price: m.price, color: m.color, stroke: m.stroke, clipped, text: clipped ? `${label} ◀` : label });
    }

    // Off-screen tags stack inward from their edge, nearest first, against the
    // price axis: below the funding readout at the top, above the reset button
    // at the bottom, clear of the position readout and tool rail on the left.
    const edges = [];
    const place = (list, fromTop) =>
      list
        .sort((a, b) => a.distance - b.distance)
        .slice(0, MAX_EDGE)
        .forEach((e, i) => {
          edges.push({ ...e, right: width - 6, y: fromTop ? 30 + i * 15 : height - 40 - i * 15 });
        });
    place(above, true);
    place(below, false);
    return { lines: lines.slice(0, MAX_AXIS), edges };
  }
}
