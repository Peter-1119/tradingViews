/**
 * Liquidations on the price pane, two layers that answer two questions.
 *
 * What was forced out (recorded, liquidations.js):
 *   a triangle at a bar whose liquidations rank among the coin's largest --
 *   ▼ under the low when longs were closed out (a forced sell pushes down),
 *   ▲ over the high for shorts (a forced buy pushes up). Its size follows the
 *   amount; the largest carry it. Smaller ones are in the legend when the
 *   crosshair is on their bar, so the chart stays readable.
 *
 * Where the fuel is now (estimated, liquidation-map.js):
 *   a profile against the right edge, behind the candles: how much would be
 *   liquidated at each price, longs below in the sell colour, shorts above in
 *   the buy colour. The biggest cluster each side is named, with its distance
 *   from the price, and pinned to the top or bottom edge when off screen --
 *   the nearest big pool is what a trader wants from it, not the shape.
 *
 * Bottom left, a line above the order-flow legend: what is shown, from when
 * there is a record, and the hovered bar's liquidations.
 */

import { formatCompact } from './util.js';
import { withAlpha } from './volume-pane.js';
import { sumPerBar, markThreshold } from './liquidations.js';
import { t } from './i18n.js';

const FONT = "10px 'Segoe UI', -apple-system, 'Noto Sans TC', 'Microsoft JhengHei', sans-serif";
const MUTED = 'rgba(226, 232, 240, 0.7)';
const MIN_S = 4.5;
const MAX_S = 12;
/** Triangles this many times the threshold carry their amount. */
const LABEL_AT = 2.5;
/** Profile rows, in pixels, and its width. */
const ROW_PX = 3;
const MAP_MAX_W = 96;
const MAP_MAX_SHARE = 0.16;
/** Where a cluster above the screen is named. */
const PIN_TOP = 40;
/** A named cluster must hold at least this share of the larger one. */
const CLUSTER_MIN = 0.15;

/** $56.5M, $812K, $1.24B: three figures at most, which is all an estimate or a glance needs. */
function usd(v) {
  const a = Math.abs(v);
  const [div, unit] = a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : a >= 1e3 ? [1e3, 'K'] : [1, ''];
  const x = v / div;
  const digits = Math.abs(x) >= 100 || !unit ? 0 : Math.abs(x) >= 10 ? 1 : 2;
  return `$${x.toFixed(digits).replace(/\.0+$|(\.\d*?)0+$/, '$1')}${unit}`;
}
const pct = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}%`;

/** `hex` mixed with white by `amount` (0..1), as #rrggbb. */
function lighten(hex, amount) {
  const v = String(hex).replace('#', '');
  if (v.length !== 6) return hex;
  const mix = (i) => Math.round(parseInt(v.slice(i, i + 2), 16) + (255 - parseInt(v.slice(i, i + 2), 16)) * amount);
  return `#${[0, 2, 4].map((i) => mix(i).toString(16).padStart(2, '0')).join('')}`;
}

/** A cluster's centre is good to a cell or so: 81,967 rather than 81966.70. */
function roughPrice(price, card) {
  if (price >= 1000) return Math.round(price).toLocaleString('en-US');
  return card.formatPrice(price);
}

function outlinedText(ctx, text, x, y, color) {
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(15, 20, 28, 0.85)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

/** Behind the candles: the estimated profile. */
class MapRenderer {
  constructor(source) {
    this.source = source;
  }

  draw(target) {
    const rows = this.source.layout.rows;
    if (!rows.length) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const right = mediaSize.width;
      for (const r of rows) {
        ctx.fillStyle = r.color;
        ctx.fillRect(right - r.w, r.y, r.w, r.h);
      }
    });
  }
}

/** Over the candles: triangles, cluster names, the legend. */
class MarkRenderer {
  constructor(source) {
    this.source = source;
  }

  draw(target) {
    const s = this.source;
    const { marks, clusters, legend } = s.layout;
    if (!marks.length && !clusters.length && !legend.length) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      ctx.font = FONT;
      ctx.textBaseline = 'middle';

      for (const m of marks) {
        const light = lighten(m.color, 0.35);
        const dir = m.down ? 1 : -1;
        ctx.beginPath();
        // Point first: ▼ points down from its base, ▲ up.
        ctx.moveTo(m.x, m.y + dir * m.s);
        ctx.lineTo(m.x - m.s, m.y - dir * m.s * 0.6);
        ctx.lineTo(m.x + m.s, m.y - dir * m.s * 0.6);
        ctx.closePath();
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(12, 16, 23, 0.9)';
        ctx.stroke();
        ctx.fillStyle = withAlpha(light, 0.85);
        ctx.fill();
        if (m.label) outlinedText(ctx, m.label, m.x + m.s + 3, m.y, light);
      }

      const right = mediaSize.width;
      for (const c of clusters) {
        const light = lighten(c.color, 0.35);
        ctx.strokeStyle = withAlpha(light, 0.8);
        ctx.lineWidth = 1;
        ctx.setLineDash(c.pinned ? [] : [3, 2]);
        ctx.beginPath();
        ctx.moveTo(right - c.w - 4, c.y + 0.5);
        ctx.lineTo(right, c.y + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.textAlign = 'right';
        outlinedText(ctx, c.text, right - c.w - 8, c.y, light);
        ctx.textAlign = 'left';
      }

      if (legend.length) {
        let x = 46;
        const y = s.legendY(mediaSize.height);
        for (const part of legend) {
          outlinedText(ctx, part.text, x, y, part.color);
          x += ctx.measureText(part.text).width + 8;
        }
      }
      ctx.restore();
    });
  }
}

export class LiquidationPrimitive {
  /** @param {import('./chart.js').CardChart} card */
  constructor(card) {
    this.card = card;
    /** Recorded events, sorted by t (ms). */
    this.events = [];
    /** bar time -> {long, short, byEx, count}. */
    this.perBar = new Map();
    this.threshold = Infinity;
    /** {real, map, top (share)}, or null for off. */
    this.opts = null;
    /** The estimate (liquidation-map.js), and how it stands: 'loading', 'ready', 'none'. */
    this.map = null;
    this.mapState = 'none';
    /** When recording began for this symbol (ms), and which symbol it is. */
    this.since = null;
    this.symbol = '';
    this.hoverTime = null;
    this.layout = { rows: [], marks: [], clusters: [], legend: [] };
    this.views = [
      { renderer: () => new MapRenderer(this), zOrder: () => 'bottom' },
      { renderer: () => new MarkRenderer(this), zOrder: () => 'top' },
    ];
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

  /* --------------------------------------------------------------- data */

  setOptions(opts) {
    this.opts = opts;
    this.rebucket();
  }

  setEvents(events, since = null, symbol = '') {
    this.events = Array.isArray(events) ? events.slice().sort((a, b) => a.t - b.t) : [];
    this.since = since;
    this.symbol = symbol;
    this.rebucket();
  }

  addEvents(events) {
    if (!Array.isArray(events) || !events.length) return;
    const last = this.events.length ? this.events[this.events.length - 1].t : -Infinity;
    for (const e of events) this.events.push(e);
    if (events.some((e) => e.t < last)) this.events.sort((a, b) => a.t - b.t);
    // Live ones land on the last bars: re-sum only from there.
    this.rebucket();
  }

  setMap(map, state) {
    this.map = map;
    this.mapState = state || (map ? 'ready' : 'none');
    this.update();
  }

  /** The forming bar's range clears what it reached. */
  touch(bar) {
    if (this.map && bar) this.map.touch(bar.high, bar.low);
  }

  rebucket() {
    const bars = this.card.bars;
    this.perBar = this.opts && this.opts.real ? sumPerBar(this.events, bars) : new Map();
    this.threshold = this.opts && this.opts.real ? markThreshold(this.perBar, this.opts.top) : Infinity;
    this.update();
  }

  /* ------------------------------------------------------------- layout */

  updateAllViews() {
    this.layout = this.opts ? this.compute() : { rows: [], marks: [], clusters: [], legend: [] };
  }

  /** One line above the order-flow legend when that one is showing. */
  legendY(height) {
    const flow = this.card.flow;
    const above = flow && flow.layout && flow.layout.legend && flow.layout.legend.length ? 15 : 0;
    return (flow ? flow.legendY(height) : height - 12) - above;
  }

  compute() {
    const card = this.card;
    const out = { rows: [], marks: [], clusters: [], legend: [] };
    const bars = card.bars;
    if (!bars.length || !card.chart || !card.priceSeries) return out;
    const ts = card.chart.timeScale();
    const range = ts.getVisibleLogicalRange();
    if (!range) return out;
    const from = Math.max(0, Math.floor(range.from));
    const to = Math.min(bars.length - 1, Math.ceil(range.to));
    const { up, down } = card.colors;

    if (this.opts.real && from <= to && Number.isFinite(this.threshold)) {
      const spacing = ts.options().barSpacing;
      const read = card.flow && card.flow.reads;
      const gap = read ? 24 : 9;
      for (let i = from; i <= to; i++) {
        const cell = this.perBar.get(bars[i].time);
        if (!cell) continue;
        const x = ts.logicalToCoordinate(i);
        if (x === null) continue;
        for (const side of ['long', 'short']) {
          const v = cell[side];
          if (!(v >= this.threshold)) continue;
          const down = side === 'long';
          const edge = card.priceToY(down ? bars[i].low : bars[i].high);
          if (edge === null) continue;
          const s = Math.max(MIN_S, Math.min(MAX_S, MIN_S * Math.sqrt(v / this.threshold)));
          out.marks.push({
            x,
            y: down ? edge + gap + s * 0.4 : edge - gap - s * 0.4,
            s,
            down,
            color: down ? card.colors.down : card.colors.up,
            label: v >= this.threshold * LABEL_AT && spacing >= 4 ? usd(v) : '',
          });
        }
      }
    }

    if (this.opts.map && this.map) this.layoutMap(out, up, down);
    out.legend = this.legend();
    return out;
  }

  layoutMap(out, up, down) {
    const card = this.card;
    const series = card.priceSeries;
    const height = card.chart.paneSize ? card.chart.paneSize(0).height : 0;
    const width = card.chart.paneSize ? card.chart.paneSize(0).width : 0;
    if (!(height > 0) || !(width > 0)) return;
    const top = series.coordinateToPrice(0);
    const bottom = series.coordinateToPrice(height);
    if (!Number.isFinite(top) || !Number.isFinite(bottom) || top <= bottom) return;
    const count = Math.max(10, Math.floor(height / ROW_PX));
    const { rows, max } = this.map.rows(bottom, top, count);
    const maxW = Math.min(MAP_MAX_W, width * MAP_MAX_SHARE);
    if (max > 0) {
      const h = height / count;
      for (const r of rows) {
        const y = card.priceToY(r.price);
        if (y === null) continue;
        for (const side of ['long', 'short']) {
          const v = r[side];
          if (!(v > 0)) continue;
          const w = Math.max(1, (v / max) * maxW);
          // Fainter for the thin rows, so the clusters read first.
          const alpha = 0.18 + 0.42 * Math.sqrt(v / max);
          out.rows.push({ y: y - h / 2 + 0.5, h: Math.max(1, h - 1), w, color: withAlpha(side === 'long' ? down : up, alpha) });
        }
      }
    }

    const last = card.bars[card.bars.length - 1];
    const price = last && last.close;
    if (!(price > 0)) return;
    const { above, below } = this.map.clusters(price);
    const biggest = Math.max(above ? above.usd : 0, below ? below.usd : 0);
    for (const [c, side] of [[above, 'short'], [below, 'long']]) {
      if (!c || c.usd < biggest * CLUSTER_MIN) continue;
      let y = card.priceToY(c.price);
      let pinned = false;
      const arrow = side === 'short' ? '▲ ' : '▼ ';
      if (y === null || y < 8 || y > height - 8) {
        // Off screen: say so at the edge it lies beyond.
        // Clear of the funding and countdown readout in the top right corner.
        y = side === 'short' ? PIN_TOP : height - 10;
        pinned = true;
      }
      const name = side === 'short' ? t('估計空單清算') : t('估計多單清算');
      out.clusters.push({
        y,
        w: pinned ? 0 : maxW,
        pinned,
        color: side === 'short' ? up : down,
        text: `${pinned ? arrow : ''}${name} ≈${usd(c.usd)} · ${roughPrice(c.price, card)} · ${pct(c.price / price - 1)}`,
      });
    }
  }

  legend() {
    const parts = [];
    const o = this.opts;
    const bars = this.card.bars;
    const { up, down } = this.card.colors;
    if (o.real) {
      parts.push({ text: t('清算 Binance·Bybit·OKX'), color: MUTED });
      // Before recording began there is nothing, which is not the same as calm.
      const first = this.events.length ? Math.min(this.events[0].t, this.since || Infinity) : this.since;
      if (first && bars.length && first > bars[0].time * 1000) {
        parts.push({ text: t('{time} 起才有紀錄', { time: this.card.formatters ? this.card.formatters.crosshair(Math.floor(first / 1000)) : new Date(first).toLocaleString() }), color: MUTED });
      }
    }
    if (o.map) {
      if (this.mapState === 'loading') parts.push({ text: t('估計清算區計算中…'), color: MUTED });
      else if (this.mapState === 'ready') parts.push({ text: t('右側：估計清算區'), color: MUTED });
      else if (this.mapState === 'failed') parts.push({ text: t('估計清算區載入失敗'), color: MUTED });
    }
    const time = this.hoverTime;
    if (time !== null && o.real) {
      const cell = this.perBar.get(time);
      if (cell) {
        if (cell.long > 0) parts.push({ text: t('多單被清 {usd}', { usd: usd(cell.long) }), color: down });
        if (cell.short > 0) parts.push({ text: t('空單被清 {usd}', { usd: usd(cell.short) }), color: up });
        const shares = Object.entries(cell.byEx)
          .map(([ex, v]) => [ex, v.long + v.short])
          .sort((a, b) => b[1] - a[1]);
        const total = cell.long + cell.short;
        if (total > 0 && shares.length > 1) {
          const NAMES = { binance: 'Binance', bybit: 'Bybit', okx: 'OKX' };
          parts.push({ text: shares.map(([ex, v]) => `${NAMES[ex]} ${Math.round((v / total) * 100)}%`).join(' · '), color: MUTED });
        }
      }
    }
    return parts;
  }
}
