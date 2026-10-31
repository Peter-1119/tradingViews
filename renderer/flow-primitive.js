/**
 * Order flow on the price pane: big taker orders as bubbles, and the position
 * read as a tag on the bars that stand out (flow-read.js).
 *
 *   - a bubble sits in its bar at the order's average price, green for a
 *     buy and red for a sell, its area in proportion to the order's size
 *     against the threshold; the biggest carry their amount;
 *   - a tag sits under the bar when it read as buying (longs opening, shorts
 *     covering) and over it when selling; zoomed out too far for text it is a
 *     dot in the same colour;
 *   - bottom left, a legend: the current threshold in USDT, and for the bar
 *     under the crosshair its ΔOI, taker delta, reading and biggest order.
 */

import { formatCompact } from './util.js';
import { withAlpha, OVERLAY_SHARE } from './volume-pane.js';
import { t } from './i18n.js';

const FONT = "10px 'Segoe UI', -apple-system, 'Noto Sans TC', 'Microsoft JhengHei', sans-serif";
const SLATE = '#8494b0';
const MIN_R = 4;
const MAX_R = 16;
/** Bubbles this large carry their amount. */
const LABEL_R = 9;
/** Narrower bars than this get a dot instead of a text tag. */
const TAG_MIN_SPACING = 14;

const TAGS = {
  longOpen: t('新多'),
  shortCover: t('空補'),
  shortOpen: t('新空'),
  longClose: t('多平'),
  bothOpen: t('雙開'),
  bothClose: t('雙平'),
};

export const READ_NAMES = {
  longOpen: t('多單進場'),
  shortCover: t('空單回補'),
  shortOpen: t('空單進場'),
  longClose: t('多單平倉'),
  bothOpen: t('多空雙方開倉'),
  bothClose: t('多空雙方平倉'),
};

const BUYING = new Set(['longOpen', 'shortCover']);
const SELLING = new Set(['shortOpen', 'longClose']);

const usd = (v) => `$${formatCompact(v).replace(/\.00(?=[KMB]?$)/, '')}`;
const signed = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${formatCompact(Math.abs(v))}`;

class FlowRenderer {
  constructor(source) {
    this.source = source;
  }

  draw(target) {
    const s = this.source;
    const { bubbles, tags, legend } = s.layout;
    if (!bubbles.length && !tags.length && !legend.length) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      ctx.font = FONT;
      ctx.textBaseline = 'middle';

      for (const b of bubbles) {
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fillStyle = withAlpha(b.color, 0.32);
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = withAlpha(b.color, 0.95);
        ctx.stroke();
        if (b.label) {
          const x = b.x + b.r + 3;
          ctx.lineWidth = 3;
          ctx.strokeStyle = 'rgba(15, 20, 28, 0.85)';
          ctx.strokeText(b.label, x, b.y);
          ctx.fillStyle = withAlpha(b.color, 1);
          ctx.fillText(b.label, x, b.y);
        }
      }

      for (const g of tags) {
        if (!g.text) {
          ctx.beginPath();
          ctx.arc(g.x, g.y, 2.5, 0, Math.PI * 2);
          ctx.fillStyle = withAlpha(g.color, g.strong ? 0.95 : 0.6);
          ctx.fill();
          continue;
        }
        const w = ctx.measureText(g.text).width + 8;
        const h = 14;
        ctx.fillStyle = withAlpha(g.color, g.strong ? 0.9 : 0.45);
        roundRect(ctx, g.x - w / 2, g.y - h / 2, w, h, 3);
        ctx.fill();
        ctx.fillStyle = g.strong ? '#0f141c' : 'rgba(240, 244, 250, 0.95)';
        ctx.textAlign = 'center';
        ctx.fillText(g.text, g.x, g.y + 0.5);
        ctx.textAlign = 'left';
      }

      if (legend.length) {
        // Clear of the toolbar rail, which is out exactly when the pointer is
        // over the chart reading this.
        let x = 46;
        const y = s.legendY(mediaSize.height);
        for (const part of legend) {
          ctx.lineWidth = 3;
          ctx.strokeStyle = 'rgba(15, 20, 28, 0.8)';
          ctx.strokeText(part.text, x, y);
          ctx.fillStyle = part.color;
          ctx.fillText(part.text, x, y);
          x += ctx.measureText(part.text).width + 8;
        }
      }
      ctx.restore();
    });
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export class FlowPrimitive {
  /** @param {import('./chart.js').CardChart} card */
  constructor(card) {
    this.card = card;
    /** Sorted by t (ms). */
    this.sweeps = [];
    /** Show orders up to this rank (0.001 = top 0.1%), or null for none. */
    this.top = null;
    /** The current USDT size of that rank, from the hub. */
    this.cutoff = NaN;
    /** bar time -> reading, or null when the read is off. */
    this.reads = null;
    this.hoverTime = null;
    this.layout = { bubbles: [], tags: [], legend: [] };
    this.views = [{ renderer: () => new FlowRenderer(this), zOrder: () => 'top' }];
    this.requestUpdate = null;
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

  update() {
    if (this.requestUpdate) this.requestUpdate();
  }

  updateAllViews() {
    this.layout = this.top === null && !this.reads ? { bubbles: [], tags: [], legend: [] } : this.compute();
  }

  /** Just above the volume when it is overlaid, else at the bottom. */
  legendY(height) {
    const v = this.card.volume;
    const overlaid = v && v.opts && v.opts.overlay;
    return Math.round(height * (overlaid ? 1 - OVERLAY_SHARE : 1)) - 12;
  }

  /** The bar holding a time (seconds): its index, or -1. */
  barIndex(sec) {
    const bars = this.card.bars;
    let lo = 0;
    let hi = bars.length - 1;
    if (hi < 0 || sec < bars[0].time) return -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (bars[mid].time <= sec) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  shown(s) {
    return this.top !== null && s.top <= this.top * 1.0001;
  }

  compute() {
    const card = this.card;
    const bars = card.bars;
    const out = { bubbles: [], tags: [], legend: [] };
    if (!bars.length || !card.chart) return out;
    const ts = card.chart.timeScale();
    const range = ts.getVisibleLogicalRange();
    if (!range) return out;
    const from = Math.max(0, Math.floor(range.from));
    const to = Math.min(bars.length - 1, Math.ceil(range.to));
    // The view can lie wholly past the bars: right after a load replaces a
    // longer history the old range still stands. The chart calls this inside
    // setData, so a throw here failed the card's whole load.
    if (from > to) return out;
    const { up, down } = card.colors;

    if (this.top !== null && this.sweeps.length) {
      const startSec = bars[from].time;
      const endSec = to + 1 < bars.length ? bars[to + 1].time : Infinity;
      // The threshold's size, for scaling; before the hub has ranked, the
      // smallest order shown stands in for it.
      let unit = this.cutoff;
      const visible = [];
      for (let i = lowerBound(this.sweeps, startSec * 1000); i < this.sweeps.length; i++) {
        const s = this.sweeps[i];
        if (s.t >= endSec * 1000) break;
        if (!this.shown(s)) continue;
        visible.push(s);
      }
      if (!(unit > 0)) unit = Math.min(...visible.map((s) => s.notional));
      // The biggest last, so they are drawn over the small ones.
      visible.sort((a, b) => a.notional - b.notional);
      for (const s of visible) {
        const i = this.barIndex(s.t / 1000);
        const x = ts.logicalToCoordinate(i);
        const y = card.priceToY(s.vwap);
        if (x === null || y === null) continue;
        const r = Math.max(MIN_R, Math.min(MAX_R, MIN_R * Math.sqrt(s.notional / unit)));
        const color = s.buyQty * 2 >= s.qty ? up : down;
        out.bubbles.push({ x, y, r, color, label: r >= LABEL_R ? usd(s.notional) : '' });
      }
    }

    if (this.reads) {
      const spacing = ts.options().barSpacing;
      for (let i = from; i <= to; i++) {
        const bar = bars[i];
        const r = this.reads.get(bar.time);
        if (!r || !r.marked) continue;
        const x = ts.logicalToCoordinate(i);
        if (x === null) continue;
        const buying = BUYING.has(r.kind);
        const color = buying ? up : SELLING.has(r.kind) ? down : SLATE;
        const below = buying;
        const yEdge = card.priceToY(below ? bar.low : bar.high);
        if (yEdge === null) continue;
        out.tags.push({
          x,
          y: below ? yEdge + 11 : yEdge - 11,
          color,
          // Opening is the stronger statement: solid; closing, outlined in tone.
          strong: r.kind === 'longOpen' || r.kind === 'shortOpen',
          text: spacing >= TAG_MIN_SPACING ? TAGS[r.kind] : '',
        });
      }
    }

    out.legend = this.legend();
    return out;
  }

  legend() {
    const parts = [];
    const muted = 'rgba(226, 232, 240, 0.7)';
    if (this.top !== null) {
      const share = `${+(this.top * 100).toFixed(2)}%`;
      parts.push({
        text: this.cutoff > 0 ? t('大單 ≥ {usd}（前 {share}）', { usd: usd(this.cutoff), share }) : t('大單：前 {share}', { share }),
        color: muted,
      });
    }
    const time = this.hoverTime;
    if (time === null) return parts;
    const { up, down } = this.card.colors;
    const r = this.reads && this.reads.get(time);
    if (r) {
      parts.push({ text: `ΔOI ${signed(r.dOI)}`, color: r.dOI >= 0 ? up : down });
      if (Number.isFinite(r.delta)) parts.push({ text: t('淨主動 {delta}', { delta: signed(r.delta) }), color: r.delta >= 0 ? up : down });
      parts.push({ text: READ_NAMES[r.kind], color: r.marked ? '#e2e8f0' : muted });
    }
    if (this.top !== null) {
      const bars = this.card.bars;
      const i = this.barIndex(time);
      const end = i + 1 < bars.length ? bars[i + 1].time * 1000 : Infinity;
      let best = null;
      for (let k = lowerBound(this.sweeps, time * 1000); k < this.sweeps.length && this.sweeps[k].t < end; k++) {
        const s = this.sweeps[k];
        if (this.shown(s) && (!best || s.notional > best.notional)) best = s;
      }
      if (best) {
        const buy = best.buyQty * 2 >= best.qty;
        parts.push({
          text: t('最大單 {side} {usd} @ {price}', {
            side: buy ? t('買') : t('賣'),
            usd: usd(best.notional),
            price: this.card.formatPrice(best.vwap),
          }),
          color: buy ? up : down,
        });
      }
    }
    return parts;
  }
}

/** First index with t >= ms. */
function lowerBound(list, ms) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].t < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
