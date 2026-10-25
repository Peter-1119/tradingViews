/**
 * Trend lines: a solid segment between two points the user picked -- not a
 * ray, it stops at both ends -- for reading a sloped support or resistance.
 *
 * Drawn by the chart as a series primitive, so it moves with the candles on
 * every pan, zoom, resize and rescale in the same frame. Anchors are
 * {time, price}, like rectangles and fibs, so a line survives a timeframe
 * switch and still lands on the same two prices at the same two moments.
 */

const LINE = 'rgba(91, 156, 255, 0.95)';
const LINE_ACTIVE = 'rgba(160, 196, 255, 1)';

/** How near the pointer must be, in px, to take an end or the line itself. */
export const TREND_END_PX = 7;
export const TREND_LINE_PX = 5;

class TrendRenderer {
  constructor(source) {
    this.source = source;
  }

  draw(target) {
    const segs = this.source.segments;
    if (!segs.length) return;
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      ctx.save();
      ctx.lineCap = 'round';
      for (const s of segs) {
        ctx.strokeStyle = s.active ? LINE_ACTIVE : LINE;
        ctx.lineWidth = Math.max(1, Math.round((s.active ? 2 : 1.5) * hr));
        ctx.setLineDash(s.draft ? [5 * hr, 4 * hr] : []);
        ctx.beginPath();
        ctx.moveTo(s.a.x * hr, s.a.y * vr);
        ctx.lineTo(s.b.x * hr, s.b.y * vr);
        ctx.stroke();
        ctx.setLineDash([]);
        if (!s.active) continue;
        // End handles only on the line under the pointer or being drawn.
        const r = 4 * hr;
        for (const p of [s.a, s.b]) {
          ctx.beginPath();
          ctx.arc(p.x * hr, p.y * vr, r, 0, Math.PI * 2);
          ctx.fillStyle = '#0b0f17';
          ctx.fill();
          ctx.lineWidth = Math.max(1, Math.round(1.5 * hr));
          ctx.strokeStyle = LINE_ACTIVE;
          ctx.stroke();
        }
      }
      ctx.restore();
    });
  }
}

class TrendPaneView {
  constructor(source) {
    this.rendererInstance = new TrendRenderer(source);
  }

  renderer() {
    return this.rendererInstance;
  }
}

/** Distance from point p to the segment a-b, in px. */
function distanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export class TrendPrimitive {
  /** @param {import('./chart.js').CardChart} card */
  constructor(card) {
    this.card = card;
    this.lines = [];
    this.draft = null;
    this.activeId = null;
    this.segments = [];
    this.requestUpdate = null;
    this.views = [new TrendPaneView(this)];
    /** Hidden by the rail's eye: kept, not drawn, and not grabbable. */
    this.hidden = false;
  }

  attached({ requestUpdate }) {
    this.requestUpdate = requestUpdate;
  }

  detached() {
    this.requestUpdate = null;
  }

  paneViews() {
    return this.hidden ? [] : this.views;
  }

  setHidden(hidden) {
    if (this.hidden === !!hidden) return;
    this.hidden = !!hidden;
    this.update();
  }

  updateAllViews() {
    this.segments = this.computeSegments();
  }

  setLines(lines) {
    this.lines = Array.isArray(lines) ? lines : [];
    this.update();
  }

  /** A line being drawn or dragged, shown ahead of the store. */
  setDraft(draft) {
    this.draft = draft;
    this.update();
  }

  setActive(id) {
    if (this.activeId === id) return;
    this.activeId = id;
    this.update();
  }

  update() {
    if (this.requestUpdate) this.requestUpdate();
  }

  project(line) {
    const a = this.card.anchorToPixel(line.a);
    const b = this.card.anchorToPixel(line.b);
    if (!a || !b) return null;
    return { id: line.id, a, b };
  }

  computeSegments() {
    const out = [];
    for (const line of this.lines) {
      // While a stored line is being dragged, the draft stands in for it.
      if (this.draft && this.draft.id === line.id) continue;
      const seg = this.project(line);
      if (seg) out.push({ ...seg, active: line.id === this.activeId });
    }
    if (this.draft) {
      const seg = this.project(this.draft);
      if (seg) out.push({ ...seg, active: true, draft: this.draft.id === '__draft__' });
    }
    return out;
  }

  /**
   * What the pointer is over: {id, part: 'a' | 'b'} for an end, {id, part:
   * 'line'} for the segment between. Ends first, so a short line can still
   * be reshaped; the topmost (last drawn) line wins.
   */
  hitTest(x, y) {
    if (this.hidden) return null;
    const segs = this.computeSegments().filter((s) => !s.draft);
    const p = { x, y };
    for (let i = segs.length - 1; i >= 0; i--) {
      const s = segs[i];
      if (Math.hypot(x - s.a.x, y - s.a.y) <= TREND_END_PX) return { id: s.id, part: 'a' };
      if (Math.hypot(x - s.b.x, y - s.b.y) <= TREND_END_PX) return { id: s.id, part: 'b' };
    }
    for (let i = segs.length - 1; i >= 0; i--) {
      const s = segs[i];
      if (distanceToSegment(p, s.a, s.b) <= TREND_LINE_PX) return { id: s.id, part: 'line' };
    }
    return null;
  }
}
