/**
 * Fibonacci retracements, drawn by the chart as a series primitive.
 *
 * These used to be an HTML layer over the chart, positioned by the card on a
 * short list of events: a time-range change, a data reload, an edit. A resize or
 * a price-axis rescale was on nobody's list, so the ladder sat at its old pixel
 * positions while the candles moved underneath -- the same lag the 4h overlay
 * had before it moved into the chart. As a primitive it is recomputed in
 * updateAllViews on every viewport change and painted in the same frame as the
 * candles, so the two cannot drift.
 *
 * Levels run the full plot width rather than stopping at the anchors: on a card
 * this size the point of a retracement is where price sits against those levels
 * *now*. The anchors are drawn as handles, which is also where it is grabbed.
 */

/** The ratios worth the vertical room on a card this size. */
export const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

/** How near the pointer must be, in px, to take a handle. */
const HANDLE_GRAB_PX = 7;
/** Labels start clear of the tool rail, which covers x 4..34 of the plot. */
const LABEL_X = 40;

const LINE = 'rgba(186, 164, 216, 0.55)';
const LINE_ACTIVE = 'rgba(214, 196, 240, 0.9)';
const TEXT = 'rgba(214, 196, 240, 0.85)';
const HANDLE = 'rgba(214, 196, 240, 0.95)';

class FibRenderer {
  constructor(source) {
    this.source = source;
  }

  draw(target) {
    const layout = this.source.layout;
    if (!layout.length) return;
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      const line = Math.max(1, Math.floor(vr));
      ctx.font = `${Math.round(9 * vr)}px 'Segoe UI', 'Microsoft JhengHei', sans-serif`;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      for (const fib of layout) {
        ctx.strokeStyle = fib.active ? LINE_ACTIVE : LINE;
        ctx.lineWidth = line;
        ctx.setLineDash([3 * hr, 3 * hr]);
        for (const row of fib.rows) {
          const y = Math.round(row.y * vr) + (line % 2 ? 0.5 : 0);
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(bitmapSize.width, y);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        // A dark halo under the label, standing in for the old text-shadow, so it
        // stays legible over candles.
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(2, Math.round(3 * vr));
        ctx.strokeStyle = 'rgba(6, 9, 15, 0.9)';
        ctx.fillStyle = TEXT;
        for (const row of fib.rows) {
          const x = Math.round(LABEL_X * hr);
          const y = Math.round(row.y * vr) + Math.round(1 * vr);
          ctx.strokeText(row.label, x, y);
          ctx.fillText(row.label, x, y);
        }
        const r = Math.round(4.5 * hr);
        for (const h of fib.handles) {
          ctx.beginPath();
          ctx.arc(Math.round(h.x * hr), Math.round(h.y * vr), r, 0, Math.PI * 2);
          ctx.fillStyle = h.hover ? 'rgba(214, 196, 240, 0.35)' : '#0b0f17';
          ctx.fill();
          ctx.lineWidth = Math.max(1, Math.round(1.5 * hr));
          ctx.strokeStyle = HANDLE;
          ctx.stroke();
        }
      }
    });
  }
}

class FibPaneView {
  constructor(source) {
    this.rendererInstance = new FibRenderer(source);
  }

  renderer() {
    return this.rendererInstance;
  }
}

export class FibPrimitive {
  /** @param {import('./chart.js').CardChart} card */
  constructor(card) {
    this.card = card;
    this.fibs = [];
    this.draft = null;
    this.activeId = null;
    this.hover = null;
    this.layout = [];
    this.requestUpdate = null;
    this.views = [new FibPaneView(this)];
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
    this.layout = this.computeLayout();
  }

  /* ----------------------------------------------------------- public */

  /**
   * Hand over what to draw. `fibs` may be the card's own array, mutated in
   * place during a handle drag -- calling this again is what repaints it.
   */
  set(fibs, draft = null, activeId = null) {
    this.fibs = Array.isArray(fibs) ? fibs : [];
    this.draft = draft;
    this.activeId = activeId;
    this.update();
  }

  setHover(hit) {
    const key = hit ? `${hit.id}:${hit.end}` : null;
    if (key === (this.hover ? `${this.hover.id}:${this.hover.end}` : null)) return;
    this.hover = hit;
    this.update();
  }

  update() {
    if (this.requestUpdate) this.requestUpdate();
  }

  /* ---------------------------------------------------------- geometry */

  computeLayout() {
    const all = this.draft ? [...this.fibs, this.draft] : this.fibs;
    const out = [];
    for (const fib of all) {
      const a = this.card.anchorToPixel(fib.a);
      const b = this.card.anchorToPixel(fib.b);
      if (!a || !b) continue;
      // `a` is where the swing started, so it is the 100% end.
      const span = fib.b.price - fib.a.price;
      const rows = [];
      for (const ratio of FIB_RATIOS) {
        const price = fib.b.price - span * ratio;
        const y = this.card.priceToY(price);
        if (y === null) continue;
        const pct = `${(ratio * 100).toFixed(1).replace(/\.0$/, '')}%`;
        rows.push({ y, label: `${pct}  ${this.card.formatPrice(price)}` });
      }
      const hover = (end) => !!this.hover && this.hover.id === fib.id && this.hover.end === end;
      out.push({
        id: fib.id,
        active: fib.id === this.activeId,
        rows,
        handles: [
          { x: a.x, y: a.y, hover: hover('a') },
          { x: b.x, y: b.y, hover: hover('b') },
        ],
      });
    }
    return out;
  }

  /** The handle under a pointer position, as {id, end: 'a' | 'b'}, or null. */
  hitTest(x, y) {
    const layout = this.computeLayout();
    for (let i = layout.length - 1; i >= 0; i--) {
      const fib = layout[i];
      if (fib.id === '__draft__') continue;
      for (let h = 0; h < 2; h++) {
        const p = fib.handles[h];
        if (Math.hypot(x - p.x, y - p.y) <= HANDLE_GRAB_PX) return { id: fib.id, end: h === 0 ? 'a' : 'b' };
      }
    }
    return null;
  }
}
