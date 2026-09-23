/**
 * Volume profiles drawn by the chart, as a series primitive.
 *
 * Three modes, one renderer:
 *
 *   session4h  one profile per 4h block, each sitting inside its own block and
 *              growing rightward from the block's left edge, with its own POC.
 *              TradingView's Session Volume Profile at a 4h period.
 *   visible    one profile over whatever bars are on screen, right-anchored.
 *              TradingView's Visible Range Volume Profile. Computed here, in
 *              updateAllViews, so it follows panning and zooming frame for frame.
 *   day        today's UTC session, right-anchored. The original mode.
 *
 * Same reason as the 4h overlay for being a primitive rather than DOM: the
 * chart repaints this in the same frame as the candles on every viewport change,
 * so it cannot lag a resize. And the pane canvas excludes the price scale, so
 * "right edge" is simply the canvas width -- no gutter arithmetic.
 */

import { buildProfile } from './volume-profile.js';

const ROWS_VISIBLE = 24;
/** Right-anchored histograms stop at a third of the plot, framing the candles. */
const RIGHT_MAX_SHARE = 0.34;
/** A block's histogram leaves a little air before the next block. */
const PERIOD_MAX_SHARE = 0.88;

const ROW = 'rgba(125, 154, 196, 0.22)';
const ROW_VA = 'rgba(125, 154, 196, 0.42)';
const POC = 'rgba(240, 180, 90, 0.9)';
const POC_TEXT = 'rgba(245, 200, 130, 0.95)';

class VpRenderer {
  constructor(source) {
    this.source = source;
  }

  /** Histogram rows: behind the candles, like TradingView draws them. */
  drawBackground(target) {
    const layout = this.source.layout;
    if (!layout.length) return;
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      const width = bitmapSize.width;
      for (const block of layout) {
        for (const row of block.rows) {
          const top = Math.round(row.top * vr);
          const bottom = Math.round(row.bottom * vr);
          const h = Math.max(1, bottom - top - Math.round(vr));
          const len = Math.max(1, Math.round(row.length * hr));
          ctx.fillStyle = row.va ? ROW_VA : ROW;
          if (block.anchor === 'right') ctx.fillRect(width - len, top, len, h);
          else ctx.fillRect(Math.round(block.left * hr), top, len, h);
        }
      }
    });
  }

  /** POC lines and labels: above the candles, so they are never lost behind one. */
  draw(target) {
    const layout = this.source.layout;
    if (!layout.length) return;
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      // The POC is the reason to turn this on, so it gets more weight than a
      // hairline: at 1px on a dark card it read as grey in practice.
      const line = Math.max(2, Math.round(1.5 * vr));
      ctx.fillStyle = POC;
      for (const block of layout) {
        if (block.pocY === null) continue;
        const y = Math.round(block.pocY * vr) - Math.floor(line / 2);
        const x0 = block.anchor === 'right' ? 0 : Math.round(block.left * hr);
        const x1 = block.anchor === 'right' ? bitmapSize.width : Math.round(block.right * hr);
        ctx.fillRect(x0, y, Math.max(1, x1 - x0), line);
      }
      const labelled = layout.find((b) => b.label);
      if (labelled) {
        ctx.font = `${Math.round(9 * vr)}px 'Segoe UI', 'Microsoft JhengHei', sans-serif`;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'top';
        ctx.fillStyle = POC_TEXT;
        const x = bitmapSize.width - Math.round((labelled.maxLength + 6) * hr);
        ctx.fillText(labelled.label, x, Math.round(labelled.pocY * vr) + Math.round(2 * vr));
      }
    });
  }
}

class VpPaneView {
  constructor(source) {
    this.rendererInstance = new VpRenderer(source);
  }

  renderer() {
    return this.rendererInstance;
  }
}

export class VolumeProfilePrimitive {
  /** @param {import('./chart.js').CardChart} card */
  constructor(card) {
    this.card = card;
    this.mode = 'off';
    this.dayProfile = null;
    this.periodProfiles = [];
    this.layout = [];
    this.requestUpdate = null;
    this.views = [new VpPaneView(this)];
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
    this.layout = this.mode === 'off' ? [] : this.computeLayout();
  }

  /* ----------------------------------------------------------- public */

  setMode(mode) {
    this.mode = mode;
    this.update();
  }

  setDayProfile(profile) {
    this.dayProfile = profile;
    this.update();
  }

  setPeriodProfiles(list) {
    this.periodProfiles = Array.isArray(list) ? list : [];
    this.update();
  }

  update() {
    if (this.requestUpdate) this.requestUpdate();
  }

  /* ---------------------------------------------------------- geometry */

  rowsFor(profile, maxLength) {
    const out = [];
    for (const row of profile.rows) {
      const top = this.card.priceToY(row.priceHigh);
      const bottom = this.card.priceToY(row.priceLow);
      if (top === null || bottom === null) continue;
      out.push({ top, bottom, va: row.inValueArea, length: row.ratio * maxLength });
    }
    return out;
  }

  rightAnchored(profile) {
    const plotWidth = this.card.plotWidth();
    if (!profile || !plotWidth) return [];
    const maxLength = plotWidth * RIGHT_MAX_SHARE;
    return [
      {
        anchor: 'right',
        rows: this.rowsFor(profile, maxLength),
        pocY: this.card.priceToY(profile.poc),
        maxLength,
        label: `POC ${this.card.formatPrice(profile.poc)}`,
      },
    ];
  }

  computeLayout() {
    if (this.mode === 'day') return this.rightAnchored(this.dayProfile);

    if (this.mode === 'visible') {
      const range = this.card.chart.timeScale().getVisibleLogicalRange();
      const bars = this.card.bars;
      if (!range || !bars.length) return [];
      const from = Math.max(0, Math.ceil(range.from));
      const to = Math.min(bars.length - 1, Math.floor(range.to));
      if (to <= from) return [];
      return this.rightAnchored(buildProfile(bars.slice(from, to + 1), ROWS_VISIBLE));
    }

    if (this.mode === 'session4h') {
      const own = this.card.bars;
      if (!own.length) return [];
      const lastLogical = own.length - 1;
      const out = [];
      for (const block of this.periodProfiles) {
        const startLogical = this.card.logicalFromTime(block.start);
        const endLogical = this.card.logicalFromTime(block.end);
        if (startLogical === null || endLogical === null) continue;
        // The block still trading stops at the newest candle, like the 4h boxes.
        const rightLogical = block.live ? Math.min(endLogical, lastLogical + 1) : endLogical;
        const left = this.card.logicalToX(startLogical - 0.5);
        const right = this.card.logicalToX(rightLogical - 0.5);
        if (left === null || right === null || right <= left) continue;
        out.push({
          anchor: 'left',
          left,
          right,
          rows: this.rowsFor(block.profile, (right - left) * PERIOD_MAX_SHARE),
          pocY: this.card.priceToY(block.profile.poc),
        });
      }
      return out;
    }
    return [];
  }
}
