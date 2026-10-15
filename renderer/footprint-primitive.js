/**
 * Footprint, drawn inside each candle: taker sells to the left of the bar's
 * centre, taker buys to the right, one row per price band.
 *
 * Two looks, picked by how wide a bar is on screen:
 *
 *   profile   below NUMBERS_SPACING. Each row is a pair of bars growing out
 *             from the centre -- the shape of who traded where, readable at
 *             10-20px a candle. Imbalances are solid, the rest translucent.
 *   numbers   from NUMBERS_SPACING up. Each row prints "sell | buy", its
 *             cell shaded by size; imbalances are bold and coloured.
 *
 * Either way the POC row (most traded) is boxed, and the bar's delta (taker
 * buys minus sells) is printed under it when there is room. A bar with a
 * minute missing -- one still being fetched, or past what the exchange keeps
 * -- is drawn faded with its delta prefixed "~".
 *
 * The candles go hollow while this is on (CardChart.setFootprint): a filled
 * body would sit exactly on top of the rows. Rows are painted behind the
 * candles and the text in front of them.
 */

import { binRows, rowStep, formatQty } from './footprint.js';

/** Narrower than this, a bar has no room for rows at all. */
const MIN_SPACING = 5;
/** From this wide, rows carry their numbers. */
export const NUMBERS_SPACING = 72;
/** Row height to aim for, per look. */
const PROFILE_ROW_PX = 4;
const NUMBERS_ROW_PX = 14;
/** Delta under the bar needs this much width to be legible. */
const DELTA_SPACING = 22;

const POC = 'rgba(240, 180, 90, 0.95)';
const TEXT = 'rgba(226, 232, 240, 0.86)';
const FONT = "'Segoe UI', 'Microsoft JhengHei', sans-serif";

function rgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

class FootprintRenderer {
  constructor(source) {
    this.source = source;
  }

  /** Rows: behind the (hollow) candles. */
  drawBackground(target) {
    const layout = this.source.layout;
    if (!layout) return;
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      const { buy, sell } = this.source.palette;
      for (const bar of layout.bars) {
        const fade = bar.complete ? 1 : 0.45;
        const cx = Math.round(bar.x * hr);
        const half = layout.half * hr;
        for (const row of bar.rows) {
          const top = Math.round(row.top * vr);
          const h = Math.max(1, Math.round(row.bottom * vr) - top - (row.bottom - row.top >= 4 ? Math.round(vr) : 0));
          if (layout.mode === 'profile') {
            const ls = Math.round((row.sell / bar.maxSide) * half);
            const lb = Math.round((row.buy / bar.maxSide) * half);
            if (ls > 0) {
              ctx.fillStyle = rgba(sell, (row.sellImb ? 1 : 0.62) * fade);
              ctx.fillRect(cx - ls, top, ls, h);
            }
            if (lb > 0) {
              ctx.fillStyle = rgba(buy, (row.buyImb ? 1 : 0.62) * fade);
              ctx.fillRect(cx, top, lb, h);
            }
          } else {
            const w = Math.round(half);
            ctx.fillStyle = rgba(sell, (0.06 + 0.38 * (row.sell / bar.maxSide)) * fade);
            ctx.fillRect(cx - w, top, w, h);
            ctx.fillStyle = rgba(buy, (0.06 + 0.38 * (row.buy / bar.maxSide)) * fade);
            ctx.fillRect(cx, top, w, h);
          }
        }
      }
    });
  }

  /** POC boxes, numbers and deltas: in front, so a wick never hides them. */
  draw(target) {
    const layout = this.source.layout;
    if (!layout) return;
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      const { buy, sell } = this.source.palette;
      const half = layout.half * hr;
      const line = Math.max(1, Math.round(vr));

      for (const bar of layout.bars) {
        const cx = Math.round(bar.x * hr);
        if (bar.poc) {
          const top = Math.round(bar.poc.top * vr);
          const h = Math.max(line * 2, Math.round(bar.poc.bottom * vr) - top);
          ctx.strokeStyle = POC;
          ctx.lineWidth = line;
          ctx.strokeRect(cx - half + line / 2, top + line / 2, half * 2 - line, h - line);
        }
        if (layout.mode !== 'numbers') continue;
        const size = Math.round(Math.min(11, layout.rowPx - 3) * vr);
        ctx.textBaseline = 'middle';
        const pad = Math.round(3 * hr);
        for (const row of bar.rows) {
          const y = Math.round(((row.top + row.bottom) / 2) * vr);
          ctx.font = `${row.sellImb ? 700 : 400} ${size}px ${FONT}`;
          ctx.textAlign = 'right';
          ctx.fillStyle = row.sellImb ? rgba(sell, 1) : TEXT;
          if (row.sell > 0) ctx.fillText(formatQty(row.sell), cx - pad, y);
          ctx.font = `${row.buyImb ? 700 : 400} ${size}px ${FONT}`;
          ctx.textAlign = 'left';
          ctx.fillStyle = row.buyImb ? rgba(buy, 1) : TEXT;
          if (row.buy > 0) ctx.fillText(formatQty(row.buy), cx + pad, y);
        }
      }

      if (layout.spacing < DELTA_SPACING) return;
      // Deltas along the bottom of the pane, clear of the rows above them.
      const size = Math.round(9 * vr);
      ctx.font = `600 ${size}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const y = bitmapSize.height - Math.round(3 * vr);
      for (const bar of layout.bars) {
        const d = bar.delta;
        ctx.fillStyle = d >= 0 ? rgba(buy, bar.complete ? 0.95 : 0.5) : rgba(sell, bar.complete ? 0.95 : 0.5);
        const text = `${bar.complete ? '' : '~'}${d > 0 ? '+' : ''}${formatQty(d)}`;
        ctx.fillText(text, Math.round(bar.x * hr), y);
      }
    });
  }
}

class FootprintPaneView {
  constructor(source) {
    this.rendererInstance = new FootprintRenderer(source);
  }

  renderer() {
    return this.rendererInstance;
  }
}

export class FootprintPrimitive {
  /** @param {import('./chart.js').CardChart} card */
  constructor(card) {
    this.card = card;
    /** @type {import('./footprint.js').FootprintBook|null} */
    this.book = null;
    this.ratio = 3;
    this.palette = { buy: '#26c281', sell: '#ed5465' };
    this.layout = null;
    /** fp record -> {step, ratio, binned}: rows only change when the bar or the zoom does. */
    this.binned = new WeakMap();
    this.requestUpdate = null;
    this.views = [new FootprintPaneView(this)];
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

  /** null turns it off. */
  setBook(book) {
    this.book = book;
    this.update();
  }

  setRatio(ratio) {
    this.ratio = ratio;
    this.update();
  }

  /** Buys take the chart's up colour, sells its down colour. */
  setColors({ up, down }) {
    this.palette = { buy: up, sell: down };
    this.update();
  }

  update() {
    if (this.requestUpdate) this.requestUpdate();
  }

  updateAllViews() {
    this.layout = this.book ? this.computeLayout() : null;
  }

  rows(fp, step) {
    const hit = this.binned.get(fp);
    if (hit && hit.step === step && hit.ratio === this.ratio) return hit.binned;
    const binned = binRows(fp, step, this.ratio);
    this.binned.set(fp, { step, ratio: this.ratio, binned });
    return binned;
  }

  computeLayout() {
    const card = this.card;
    const bars = card.bars;
    if (!bars.length || !this.book.minutes.size) return null;
    const scale = card.chart.timeScale();
    const spacing = scale.options().barSpacing;
    const range = scale.getVisibleLogicalRange();
    if (!range || spacing < MIN_SPACING) return null;

    // Pixels per unit of price, from the newest close and a step above it.
    const ref = bars[bars.length - 1].close;
    const y0 = card.priceToY(ref);
    const y1 = card.priceToY(ref * 1.001);
    if (y0 === null || y1 === null || y0 === y1) return null;
    const pxPerPrice = Math.abs(y0 - y1) / (ref * 0.001);

    const mode = spacing >= NUMBERS_SPACING ? 'numbers' : 'profile';
    const rowPxWanted = mode === 'numbers' ? NUMBERS_ROW_PX : PROFILE_ROW_PX;
    const scaleKeys = this.book.scale;
    const step = rowStep(rowPxWanted / pxPerPrice, scaleKeys);
    const rowPx = (step / scaleKeys) * pxPerPrice;

    const nowSec = Date.now() / 1000;
    const from = Math.max(0, Math.floor(range.from));
    const to = Math.min(bars.length - 1, Math.ceil(range.to));
    const out = [];
    for (let i = from; i <= to; i++) {
      const fp = this.book.bar(bars[i].time, nowSec);
      if (!fp || !fp.keys.length) continue;
      const x = card.logicalToX(i);
      if (x === null) continue;
      const { rows, poc } = this.rows(fp, step);
      let maxSide = 0;
      const placed = [];
      for (const row of rows) {
        const top = card.priceToY(row.high);
        const bottom = card.priceToY(row.low);
        if (top === null || bottom === null) continue;
        if (row.sell > maxSide) maxSide = row.sell;
        if (row.buy > maxSide) maxSide = row.buy;
        placed.push({ ...row, top, bottom });
      }
      if (!placed.length || !maxSide) continue;
      const pocRow = poc && placed.find((r) => r.key === poc.key);
      out.push({ x, rows: placed, poc: pocRow || null, maxSide, delta: fp.delta, complete: fp.complete });
    }
    if (!out.length) return null;
    return { mode, spacing, half: spacing * 0.46, rowPx, bars: out };
  }
}
