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
 * (Range profiles the user drags out are their own layer, vrange-primitive.js,
 * drawn with the same rows.)
 *
 * Rows are as fine as the detail setting asks for at the profile's current
 * height on screen, and each is split into buying and selling.
 *
 * Same reason as the 4h overlay for being a primitive rather than DOM: the
 * chart repaints this in the same frame as the candles on every viewport change,
 * so it cannot lag a resize. And the pane canvas excludes the price scale, so
 * "right edge" is simply the canvas width -- no gutter arithmetic.
 */

import { ProfileSource, rowsForHeight } from './volume-profile.js';

/** Right-anchored histograms stop at a third of the plot, framing the candles. */
const RIGHT_MAX_SHARE = 0.34;
/** A block's histogram leaves a little air before the next block. */
const PERIOD_MAX_SHARE = 0.88;

/** Buying and selling, brighter inside the value area. */
export const VP_COLORS = {
  buy: 'rgba(45, 190, 160, 0.24)',
  buyVa: 'rgba(45, 190, 160, 0.5)',
  sell: 'rgba(236, 94, 108, 0.22)',
  sellVa: 'rgba(236, 94, 108, 0.46)',
};
const POC = 'rgba(240, 180, 90, 0.9)';
const POC_TEXT = 'rgba(245, 200, 130, 0.95)';

/**
 * Screen rows for a profile: y extent, and the buying and selling lengths.
 * Shared with the range layer.
 */
export function projectRows(card, profile, maxLength) {
  const out = [];
  if (!profile) return out;
  const peak = profile.rows.reduce((m, r) => Math.max(m, r.volume), 0) || 1;
  for (const row of profile.rows) {
    if (!row.volume) continue;
    const top = card.priceToY(row.priceHigh);
    const bottom = card.priceToY(row.priceLow);
    if (top === null || bottom === null) continue;
    out.push({
      top,
      bottom,
      va: row.inValueArea,
      buy: (row.buy / peak) * maxLength,
      sell: (row.sell / peak) * maxLength,
    });
  }
  return out;
}

/** The row count that gives a source's price span the detail asked for. */
export function rowsOnScreen(card, source, detail) {
  const top = card.priceToY(source.high);
  const bottom = card.priceToY(source.low);
  if (top === null || bottom === null) return rowsForHeight(0, detail);
  return rowsForHeight(bottom - top, detail);
}

/**
 * Paint rows in bitmap space. `fromRight` grows them leftward from `x`.
 * Buying sits against the anchor, selling continues past it.
 */
export function paintRows(ctx, rows, x, fromRight, hr, vr) {
  // A one-pixel gap between rows reads as separate rows; below ~3px a gap
  // would eat the row, so fine rows touch.
  for (const row of rows) {
    const top = Math.round(row.top * vr);
    const bottom = Math.round(row.bottom * vr);
    const tall = bottom - top;
    const h = Math.max(1, tall >= 3 * vr ? tall - Math.round(vr) : tall);
    const buy = Math.round(row.buy * hr);
    const sell = Math.round(row.sell * hr);
    if (buy > 0) {
      ctx.fillStyle = row.va ? VP_COLORS.buyVa : VP_COLORS.buy;
      ctx.fillRect(fromRight ? x - buy : x, top, buy, h);
    }
    if (sell > 0) {
      ctx.fillStyle = row.va ? VP_COLORS.sellVa : VP_COLORS.sell;
      ctx.fillRect(fromRight ? x - buy - sell : x + buy, top, sell, h);
    }
  }
}

class VpRenderer {
  constructor(source) {
    this.source = source;
  }

  /** Histogram rows: behind the candles, like TradingView draws them. */
  drawBackground(target) {
    const layout = this.source.layout;
    if (!layout.length) return;
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      for (const block of layout) {
        if (block.anchor === 'right') paintRows(ctx, block.rows, bitmapSize.width, true, hr, vr);
        else paintRows(ctx, block.rows, Math.round(block.left * hr), false, hr, vr);
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
    this.detail = 'normal';
    /** @type {ProfileSource|null} */
    this.daySource = null;
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

  setDetail(detail) {
    this.detail = detail;
    this.update();
  }

  /** Today's 1m bars, as a ProfileSource. */
  setDaySource(source) {
    this.daySource = source;
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

  rightAnchored(source) {
    const plotWidth = this.card.plotWidth();
    if (!source || !plotWidth) return [];
    const profile = source.at(rowsOnScreen(this.card, source, this.detail));
    if (!profile) return [];
    const maxLength = plotWidth * RIGHT_MAX_SHARE;
    return [
      {
        anchor: 'right',
        rows: projectRows(this.card, profile, maxLength),
        pocY: this.card.priceToY(profile.poc),
        maxLength,
        label: `POC ${this.card.formatPrice(profile.poc)}`,
      },
    ];
  }

  computeLayout() {
    if (this.mode === 'day') return this.rightAnchored(this.daySource);

    if (this.mode === 'visible') {
      const range = this.card.chart.timeScale().getVisibleLogicalRange();
      const bars = this.card.bars;
      if (!range || !bars.length) return [];
      const from = Math.max(0, Math.ceil(range.from));
      const to = Math.min(bars.length - 1, Math.floor(range.to));
      if (to <= from) return [];
      // The slice changes on every pan, so the source is rebuilt -- a few
      // hundred bars at most, cheap next to the repaint itself.
      return this.rightAnchored(new ProfileSource(bars.slice(from, to + 1)));
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
        const profile = block.source ? block.source.at(rowsOnScreen(this.card, block.source, this.detail)) : block.profile;
        if (!profile) continue;
        out.push({
          anchor: 'left',
          left,
          right,
          rows: projectRows(this.card, profile, (right - left) * PERIOD_MAX_SHARE),
          pocY: this.card.priceToY(profile.poc),
        });
      }
      return out;
    }
    return [];
  }
}
