/**
 * Order-book walls on the price pane (datafeed/order-book.js finds them in
 * the hub):
 *
 *   - a wall standing now is a line at its price from when it appeared to the
 *     right edge, green for bids and red for asks, thicker the bigger it is,
 *     with its size and how many times the levels around it it holds; walls
 *     from the other market (the spot book on a perpetual card, or the
 *     reverse) are dashed and tagged;
 *   - a wall that went is a faint line over the time it stood, ending in a
 *     mark: an amber ✕ when it was pulled before price got there, a dot when
 *     price traded into it;
 *   - bottom left, a legend, one line above the order-flow one.
 */

import { withAlpha, OVERLAY_SHARE } from './volume-pane.js';
import { t } from './i18n.js';

const FONT = "10px 'Segoe UI', -apple-system, 'Noto Sans TC', 'Microsoft JhengHei', sans-serif";
const PULLED = '#f5b942';
const MIN_W = 1.5;
const MAX_W = 6;
/** Ended walls held by a card, at most. */
const ENDED_MAX = 600;

/** $512K, $1.46M: walls are read at a glance, two figures are plenty. */
const usd = (v) => (v >= 1e6 ? `$${+(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${Math.round(v / 1e3)}K` : `$${Math.round(v)}`);
const times = (s) => `×${s >= 99.5 ? '99+' : Math.round(s)}`;

class WallsRenderer {
  constructor(source) {
    this.source = source;
  }

  draw(target) {
    const { lines, marks, legend } = this.source.layout;
    if (!lines.length && !marks.length && !legend.length) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      ctx.font = FONT;
      ctx.textBaseline = 'middle';
      const right = mediaSize.width;

      for (const l of lines) {
        ctx.beginPath();
        ctx.setLineDash(l.dashed ? [6, 4] : []);
        ctx.lineWidth = l.width;
        ctx.strokeStyle = withAlpha(l.color, l.alpha);
        ctx.moveTo(Math.max(0, l.x1), l.y);
        ctx.lineTo(l.x2 === null ? right : l.x2, l.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      for (const m of marks) {
        if (m.kind === 'pulled') {
          const r = 3.5;
          ctx.lineWidth = 3.5;
          ctx.strokeStyle = 'rgba(12, 16, 23, 0.85)';
          cross(ctx, m.x, m.y, r);
          ctx.lineWidth = 1.75;
          ctx.strokeStyle = PULLED;
          cross(ctx, m.x, m.y, r);
        } else {
          ctx.beginPath();
          ctx.arc(m.x, m.y, 2.75, 0, Math.PI * 2);
          ctx.fillStyle = m.color;
          ctx.fill();
          ctx.lineWidth = 1;
          ctx.strokeStyle = 'rgba(12, 16, 23, 0.85)';
          ctx.stroke();
        }
      }

      // Labels last, right-aligned against the price scale, above their line.
      ctx.textAlign = 'right';
      for (const l of lines) {
        if (!l.label) continue;
        const y = l.y - l.width / 2 - 6;
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(15, 20, 28, 0.85)';
        ctx.strokeText(l.label, right - 6, y);
        ctx.fillStyle = l.color;
        ctx.fillText(l.label, right - 6, y);
      }
      ctx.textAlign = 'left';

      if (legend.length) {
        let x = 46; // clear of the toolbar rail
        const y = this.source.legendY(mediaSize.height);
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

function cross(ctx, x, y, r) {
  ctx.beginPath();
  ctx.moveTo(x - r, y - r);
  ctx.lineTo(x + r, y + r);
  ctx.moveTo(x + r, y - r);
  ctx.lineTo(x - r, y + r);
  ctx.stroke();
}

export class WallsPrimitive {
  /** @param {import('./chart.js').CardChart} card */
  constructor(card) {
    this.card = card;
    /** Off when null. */
    this.state = null;
    this.layout = { lines: [], marks: [], legend: [] };
    this.views = [{ renderer: () => new WallsRenderer(this), zOrder: () => 'top' }];
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
    this.layout = this.state ? this.compute() : { lines: [], marks: [], legend: [] };
  }

  /**
   * Start over, from the hub's answer: {own, sens, sources: [{market, symbol,
   * ready, step, walls, ended}]}; null turns the layer off.
   */
  set(state) {
    if (!state) {
      this.state = null;
    } else {
      const sources = new Map();
      for (const s of state.sources || []) sources.set(s.market, { ...s, ended: [...(s.ended || [])] });
      this.state = { own: state.own, sens: Number(state.sens) || 10, sources };
    }
    this.update();
  }

  setSens(sens) {
    if (!this.state) return;
    this.state.sens = Number(sens) || 10;
    this.update();
  }

  /** One second's news from the hub for one source. */
  apply(msg) {
    const src = this.state && this.state.sources.get(msg.market);
    if (!src || src.symbol !== msg.symbol) return;
    src.ready = msg.ready;
    src.step = msg.step;
    src.walls = msg.walls || [];
    if (msg.ended && msg.ended.length) {
      const known = new Set(src.ended.map((e) => e.id));
      for (const e of msg.ended) if (!known.has(e.id)) src.ended.push(e);
      if (src.ended.length > ENDED_MAX) src.ended.splice(0, src.ended.length - ENDED_MAX);
    }
    this.update();
  }

  /** One line above the order-flow legend when that has something to say. */
  legendY(height) {
    const v = this.card.volume;
    const overlaid = v && v.opts && v.opts.overlay;
    const base = Math.round(height * (overlaid ? 1 - OVERLAY_SHARE : 1)) - 12;
    const flow = this.card.flow;
    return flow && flow.layout && flow.layout.legend.length ? base - 15 : base;
  }

  /** x of a moment (ms), between the bars around it; null before the first bar. */
  timeToX(ms) {
    const card = this.card;
    const bars = card.bars;
    const ts = card.chart.timeScale();
    if (!bars.length) return null;
    const sec = ms / 1000;
    if (sec < bars[0].time) return -1;
    let lo = 0;
    let hi = bars.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (bars[mid].time <= sec) lo = mid;
      else hi = mid - 1;
    }
    const step = bars.length > 1 ? bars[bars.length - 1].time - bars[bars.length - 2].time : 60;
    const next = lo + 1 < bars.length ? bars[lo + 1].time : bars[lo].time + step;
    const frac = Math.max(0, Math.min(1, (sec - bars[lo].time) / Math.max(1, next - bars[lo].time)));
    // Bars are drawn centred on their index: a bar's first moment is half a
    // bar left of it. (logicalToCoordinate takes whole indexes only.)
    const x = ts.logicalToCoordinate(lo);
    return x === null ? null : x + (frac - 0.5) * ts.options().barSpacing;
  }

  compute() {
    const out = { lines: [], marks: [], legend: [] };
    const card = this.card;
    if (!card.chart || !card.bars.length) return out;
    const { sens, own } = this.state;
    const { up, down } = card.colors;
    const colorOf = (side) => (side === 'bid' ? up : down);
    const range = card.chart.timeScale().getVisibleLogicalRange();
    const left = range ? card.bars[Math.max(0, Math.min(card.bars.length - 1, Math.floor(range.from)))].time * 1000 : 0;

    const standing = [];
    for (const [market, src] of this.state.sources) {
      for (const w of src.walls || []) {
        if (w.peakScore >= sens && w.score >= sens / 2) standing.push({ w, other: market !== own, market });
      }
    }
    const biggest = Math.max(1, ...standing.map((s) => s.w.usd));
    for (const { w, other, market } of standing) {
      const y = card.priceToY(w.price + w.step / 2);
      if (y === null) continue;
      const x1 = this.timeToX(w.since);
      const width = MIN_W + (MAX_W - MIN_W) * Math.sqrt(w.usd / biggest);
      const tag = other ? `${market === 'spot' ? t('現貨') : t('永續')} ` : '';
      out.lines.push({
        x1: x1 === null ? 0 : x1,
        x2: null,
        y,
        width,
        color: colorOf(w.side),
        alpha: other ? 0.6 : 0.8,
        dashed: other,
        label: `${tag}${usd(w.usd)} ${times(w.score)}`,
      });
    }

    for (const [market, src] of this.state.sources) {
      const other = market !== own;
      for (const e of src.ended) {
        if (e.peakScore < sens || e.end < left) continue;
        const y = card.priceToY(e.price + e.step / 2);
        const x2 = this.timeToX(e.end);
        if (y === null || x2 === null || x2 < 0) continue;
        const x1 = this.timeToX(e.since);
        out.lines.push({ x1: x1 === null ? 0 : x1, x2, y, width: 1.25, color: colorOf(e.side), alpha: 0.3, dashed: other, label: '' });
        out.marks.push({ x: x2, y, kind: e.how, color: colorOf(e.side) });
      }
    }

    out.legend = this.legend();
    return out;
  }

  legend() {
    const muted = 'rgba(226, 232, 240, 0.7)';
    const { sens, own, sources } = this.state;
    const parts = [{ text: t('掛單牆 ≥ 附近 {n} 倍', { n: sens }), color: muted }];
    if (sources.size > 1) {
      const other = [...sources.keys()].find((m) => m !== own);
      parts.push({ text: t('虛線＝{market}', { market: other === 'spot' ? t('現貨') : t('永續') }), color: muted });
    }
    parts.push({ text: t('✕ 撤單'), color: PULLED });
    parts.push({ text: t('● 被吃'), color: muted });
    if ([...sources.values()].some((s) => !s.ready)) parts.push({ text: t('掛單簿同步中…'), color: muted });
    return parts;
  }
}
