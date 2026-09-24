/**
 * Rectangles: a price zone bounded in time.
 *
 * A horizontal level runs the full width of the chart, which overstates a
 * support or resistance that only mattered for a few hours -- on a short-term
 * chart it reads as a level that still applies. A rectangle says where the zone
 * started and where it stopped mattering.
 *
 * Drawn by the chart as a series primitive, like the 4h overlay and the volume
 * profile, so it moves with the candles on every pan, zoom, resize and price
 * rescale in the same frame. Anchors are {time, price}, projected through the
 * card's interpolating conversions, so they survive timeframe switches too.
 *
 * Grabbing is deliberately limited to the border and the corners. The interior
 * of a zone is large, and it is exactly where the user pans from -- if the
 * interior were grabbable, panning inside a zone would drag the zone. The
 * interior only answers a double-click, which deletes.
 */

const FILL = 'rgba(79, 143, 247, 0.13)';
const FILL_ACTIVE = 'rgba(79, 143, 247, 0.22)';
const EDGE = 'rgba(79, 143, 247, 0.75)';
const EDGE_ACTIVE = 'rgba(150, 190, 255, 0.95)';

/** How near the pointer must be, in px, to take a corner or an edge. */
export const RECT_CORNER_PX = 7;
export const RECT_EDGE_PX = 5;

class RectRenderer {
  constructor(source) {
    this.source = source;
  }

  /** Fill behind the candles, so the zone never hides the price inside it. */
  drawBackground(target) {
    const boxes = this.source.boxes;
    if (!boxes.length) return;
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      for (const box of boxes) {
        ctx.fillStyle = box.active ? FILL_ACTIVE : FILL;
        const x0 = Math.round(box.left * hr);
        const y0 = Math.round(box.top * vr);
        ctx.fillRect(x0, y0, Math.round(box.right * hr) - x0, Math.round(box.bottom * vr) - y0);
      }
    });
  }

  /** Border and handles above the candles, so the edges stay grabbable. */
  draw(target) {
    const boxes = this.source.boxes;
    if (!boxes.length) return;
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      const line = Math.max(1, Math.floor(hr));
      for (const box of boxes) {
        const x0 = Math.round(box.left * hr);
        const y0 = Math.round(box.top * vr);
        const x1 = Math.round(box.right * hr);
        const y1 = Math.round(box.bottom * vr);
        ctx.lineWidth = line;
        ctx.strokeStyle = box.active ? EDGE_ACTIVE : EDGE;
        ctx.setLineDash(box.draft ? [4 * hr, 3 * hr] : []);
        ctx.strokeRect(x0 + line / 2, y0 + line / 2, x1 - x0 - line, y1 - y0 - line);
        ctx.setLineDash([]);
        if (!box.active) continue;
        // Corner handles only on the rectangle under the pointer: four squares
        // on every zone at all times would clutter a card this size.
        const size = Math.round(6 * hr);
        ctx.fillStyle = '#0b0f17';
        ctx.strokeStyle = EDGE_ACTIVE;
        for (const [cx, cy] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) {
          ctx.fillRect(cx - size / 2, cy - size / 2, size, size);
          ctx.strokeRect(cx - size / 2 + line / 2, cy - size / 2 + line / 2, size - line, size - line);
        }
      }
    });
  }
}

class RectPaneView {
  constructor(source) {
    this.rendererInstance = new RectRenderer(source);
  }

  renderer() {
    return this.rendererInstance;
  }
}

export class RectPrimitive {
  /** @param {import('./chart.js').CardChart} card */
  constructor(card) {
    this.card = card;
    this.rects = [];
    this.draft = null;
    this.activeId = null;
    this.boxes = [];
    this.requestUpdate = null;
    this.views = [new RectPaneView(this)];
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
    this.boxes = this.computeBoxes();
  }

  /* ----------------------------------------------------------- public */

  setRects(rects) {
    this.rects = Array.isArray(rects) ? rects : [];
    this.update();
  }

  /** A rectangle being dragged out or reshaped, drawn ahead of the store. */
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

  /* ---------------------------------------------------------- geometry */

  project(rect) {
    const a = this.card.anchorToPixel(rect.a);
    const b = this.card.anchorToPixel(rect.b);
    if (!a || !b) return null;
    return {
      id: rect.id,
      left: Math.min(a.x, b.x),
      right: Math.max(a.x, b.x),
      top: Math.min(a.y, b.y),
      bottom: Math.max(a.y, b.y),
    };
  }

  computeBoxes() {
    const out = [];
    for (const rect of this.rects) {
      // While a stored rectangle is being reshaped, the draft stands in for it.
      if (this.draft && this.draft.id === rect.id) continue;
      const box = this.project(rect);
      if (box) out.push({ ...box, active: rect.id === this.activeId });
    }
    if (this.draft) {
      const box = this.project(this.draft);
      if (box) out.push({ ...box, active: true, draft: this.draft.id === '__draft__' });
    }
    return out;
  }

  /**
   * What the pointer is over, most specific first:
   *   { id, part: 'corner', corner: 0..3 }   0 top-left, clockwise
   *   { id, part: 'edge' }
   *   { id, part: 'inside' }
   * Topmost rectangle wins, i.e. the one drawn last.
   */
  hitTest(x, y) {
    const boxes = this.computeBoxes().filter((b) => !b.draft);
    for (let i = boxes.length - 1; i >= 0; i--) {
      const b = boxes[i];
      const corners = [
        [b.left, b.top],
        [b.right, b.top],
        [b.right, b.bottom],
        [b.left, b.bottom],
      ];
      for (let c = 0; c < 4; c++) {
        if (Math.abs(x - corners[c][0]) <= RECT_CORNER_PX && Math.abs(y - corners[c][1]) <= RECT_CORNER_PX) {
          return { id: b.id, part: 'corner', corner: c };
        }
      }
    }
    for (let i = boxes.length - 1; i >= 0; i--) {
      const b = boxes[i];
      const withinX = x >= b.left - RECT_EDGE_PX && x <= b.right + RECT_EDGE_PX;
      const withinY = y >= b.top - RECT_EDGE_PX && y <= b.bottom + RECT_EDGE_PX;
      if (!withinX || !withinY) continue;
      const nearEdge =
        Math.abs(x - b.left) <= RECT_EDGE_PX ||
        Math.abs(x - b.right) <= RECT_EDGE_PX ||
        Math.abs(y - b.top) <= RECT_EDGE_PX ||
        Math.abs(y - b.bottom) <= RECT_EDGE_PX;
      if (nearEdge) return { id: b.id, part: 'edge' };
    }
    for (let i = boxes.length - 1; i >= 0; i--) {
      const b = boxes[i];
      if (x > b.left && x < b.right && y > b.top && y < b.bottom) return { id: b.id, part: 'inside' };
    }
    return null;
  }
}
