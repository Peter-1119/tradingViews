/**
 * Fibonacci retracements, drawn as a DOM overlay on top of the chart.
 *
 * Same reasoning as the measure box: a retracement is a handful of horizontal
 * rules and some labels, the card's CSS already knows how to style those, and
 * staying out of the chart's canvas pipeline keeps the whole thing debuggable.
 *
 * The levels span the full chart width rather than just the span between the
 * two anchors. On a 340px card the point of a retracement is to see where price
 * is *now* against those levels, and a line that stops halfway cannot show you
 * that. The anchors stay visible as draggable handles, so the swing they were
 * drawn from is still legible.
 */

import { el } from '../util.js';

/** The ratios worth the vertical room on a card this size. */
export const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

export class FibOverlay {
  constructor() {
    this.root = el('div.card__fibs');
    /** fibId -> { line elements, handle elements } */
    this.rendered = new Map();
  }

  /**
   * @param {Array} fibs        records from the store
   * @param {(fib) => ({a, b} | null)} project  anchors -> pixel positions
   * @param {(price: number) => string} format
   * @param {string|null} activeId
   */
  render(fibs, project, format, activeId = null) {
    const keep = new Set();

    for (const fib of fibs) {
      const pts = project(fib);
      if (!pts) continue;
      keep.add(fib.id);

      let entry = this.rendered.get(fib.id);
      if (!entry) {
        entry = { root: el('div.card__fib'), rows: [], handles: [] };
        for (let i = 0; i < FIB_RATIOS.length; i++) {
          const row = el('div.card__fib-row', {}, el('span.card__fib-tag'));
          entry.rows.push(row);
          entry.root.append(row);
        }
        for (let i = 0; i < 2; i++) {
          const handle = el('div.card__fib-handle', { dataset: { index: String(i) } });
          entry.handles.push(handle);
          entry.root.append(handle);
        }
        this.rendered.set(fib.id, entry);
        this.root.append(entry.root);
      }

      entry.root.classList.toggle('is-active', fib.id === activeId);
      // `a` is the anchor the retracement is measured *from*, so it is the 100%
      // end and ratio 0 sits at `b`.
      const span = fib.b.price - fib.a.price;
      entry.rows.forEach((row, i) => {
        const ratio = FIB_RATIOS[i];
        const price = fib.b.price - span * ratio;
        const y = pts.priceToY(price);
        if (y === null) {
          row.hidden = true;
          return;
        }
        row.hidden = false;
        row.style.top = `${y}px`;
        row.firstChild.textContent = `${(ratio * 100).toFixed(1).replace(/\.0$/, '')}%  ${format(price)}`;
      });

      entry.handles[0].style.left = `${pts.a.x}px`;
      entry.handles[0].style.top = `${pts.a.y}px`;
      entry.handles[1].style.left = `${pts.b.x}px`;
      entry.handles[1].style.top = `${pts.b.y}px`;
    }

    for (const [id, entry] of this.rendered) {
      if (keep.has(id)) continue;
      entry.root.remove();
      this.rendered.delete(id);
    }
  }

  clear() {
    for (const entry of this.rendered.values()) entry.root.remove();
    this.rendered.clear();
  }
}
