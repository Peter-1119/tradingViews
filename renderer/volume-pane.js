/**
 * The volume pane: taker buys and sells, thin volume, and a readout.
 *
 *   - each bar is two segments: the taker-buy part at the bottom in the
 *     rising colour, the taker-sell part above it in the falling one (two
 *     histograms on one scale -- the whole volume, and the buy part over it);
 *   - a thin bar (rank at or under the threshold) is slate instead, both
 *     segments, and a very thin one gets a dot above it;
 *   - a dashed line is the threshold as a volume, bar by bar: the filtered
 *     distribution moves it, slowly, and how far a bar sits above it is how
 *     far it is from thin;
 *   - top right, the hovered bar (or the last closed one): volume, the buy
 *     share, the rank -- and how many thin bars in a row, when it is three or
 *     more. The price pane shades those runs (SqueezeBandsPrimitive).
 *
 * The forming bar keeps its ordinary colours: it is only part of a bar. Its
 * rank shows in the readout as an estimate (see volume-stats.js).
 *
 * Bars cached before the taker split was recorded have no buy part; they are
 * drawn whole in their candle's colour, as before.
 */

import { HistogramSeries, LineSeries } from './vendor/lightweight-charts.mjs';
import { analyzeVolume, liveRank, squeezeRuns, SQUEEZE_STREAK } from './volume-stats.js';
import { formatCompact } from './util.js';
import { t } from './i18n.js';

const SLATE = '#8494b0';
const READOUT_FONT = "10px 'Segoe UI', -apple-system, 'Noto Sans TC', 'Microsoft JhengHei', sans-serif";

export function withAlpha(hex, alpha) {
  const v = String(hex).replace('#', '');
  if (v.length !== 6) return hex;
  const n = (i) => parseInt(v.slice(i, i + 2), 16);
  return `rgba(${n(0)}, ${n(2)}, ${n(4)}, ${alpha})`;
}

/* ------------------------------------------------------ pane primitive */

class VolumeOverlayRenderer {
  constructor(source) {
    this.source = source;
  }

  draw(target) {
    const s = this.source;
    const pane = s.pane;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      // Very thin bars: a dot above the bar.
      const ts = pane.card.chart.timeScale();
      const range = ts.getVisibleLogicalRange();
      const stats = pane.stats;
      if (range && stats && pane.total) {
        const from = Math.max(0, Math.floor(range.from));
        const to = Math.min(pane.card.bars.length - 1, Math.ceil(range.to));
        const spacing = ts.options().barSpacing;
        const r = Math.max(1.2, Math.min(2.5, spacing * 0.22));
        ctx.fillStyle = withAlpha(SLATE, 0.95);
        for (let i = from; i <= to; i++) {
          if (stats.level[i] !== 2) continue;
          const x = ts.logicalToCoordinate(i);
          const y = pane.total.priceToCoordinate(pane.card.bars[i].volume);
          if (x === null || y === null) continue;
          ctx.beginPath();
          ctx.arc(x, Math.max(r + 1, y - r - 3), r, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // The readout, top right, clear of the rail on the left.
      const parts = pane.readout();
      if (parts.length) {
        ctx.font = READOUT_FONT;
        ctx.textBaseline = 'top';
        let x = mediaSize.width - 6;
        for (let k = parts.length - 1; k >= 0; k--) {
          const p = parts[k];
          const w = ctx.measureText(p.text).width;
          x -= w;
          if (p.chip) {
            ctx.fillStyle = withAlpha(SLATE, 0.22);
            roundRect(ctx, x - 4, 2, w + 8, 14, 3);
            ctx.fill();
          }
          ctx.fillStyle = p.color;
          ctx.fillText(p.text, x, 4);
          x -= p.chip ? 12 : 8;
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

class VolumeOverlay {
  constructor(pane) {
    this.pane = pane;
    this.views = [{ renderer: () => new VolumeOverlayRenderer(this), zOrder: () => 'top' }];
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

  updateAllViews() {}

  redraw() {
    if (this.requestUpdate) this.requestUpdate();
  }
}

/* ---------------------------------------------- price pane: thin runs */

class SqueezeBandsRenderer {
  constructor(source) {
    this.source = source;
  }

  draw() {}

  drawBackground(target) {
    const s = this.source;
    const runs = s.runs;
    if (!runs.length) return;
    const ts = s.card.chart.timeScale();
    const half = ts.options().barSpacing / 2;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      ctx.fillStyle = withAlpha(SLATE, 0.09);
      for (const [from, to] of runs) {
        const a = ts.logicalToCoordinate(from);
        const b = ts.logicalToCoordinate(to);
        if (a === null || b === null) continue;
        const left = a - half;
        const right = b + half;
        if (right < 0 || left > mediaSize.width) continue;
        ctx.fillRect(left, 0, right - left, mediaSize.height);
      }
      ctx.restore();
    });
  }
}

/** Light vertical bands behind the candles where thin bars run SQUEEZE_STREAK or longer. */
export class SqueezeBandsPrimitive {
  constructor(card) {
    this.card = card;
    this.runs = [];
    this.views = [{ renderer: () => new SqueezeBandsRenderer(this), zOrder: () => 'bottom' }];
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

  updateAllViews() {}

  setRuns(runs) {
    this.runs = runs || [];
    if (this.requestUpdate) this.requestUpdate();
  }
}

/* ---------------------------------------------------------- the pane */

export class VolumePane {
  /**
   * @param {import('./chart.js').CardChart} card
   * @param {number} paneIndex
   * @param {{threshold: number|null, memory: number, intervalSec: number}} opts
   *        threshold as a rank (0.05 = 5%), null for no thin-volume marking
   */
  constructor(card, paneIndex, opts) {
    this.card = card;
    this.opts = opts;
    this.stats = null;
    this.hover = null; // logical index under the crosshair
    const chart = card.chart;
    const common = { priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false };
    this.total = chart.addSeries(HistogramSeries, common, paneIndex);
    this.buy = chart.addSeries(HistogramSeries, common, paneIndex);
    this.line = chart.addSeries(
      LineSeries,
      {
        color: withAlpha(SLATE, 0.75),
        lineWidth: 1,
        lineStyle: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        priceFormat: { type: 'volume' },
      },
      paneIndex
    );
    this.total.priceScale().applyOptions({ scaleMargins: { top: 0.22, bottom: 0 }, borderVisible: false });
    this.overlay = new VolumeOverlay(this);
    this.total.attachPrimitive(this.overlay);

    this.onCrosshair = (param) => {
      const next = param && param.point && Number.isFinite(param.logical) ? Math.round(param.logical) : null;
      if (next === this.hover) return;
      this.hover = next;
      this.overlay.redraw();
    };
    chart.subscribeCrosshairMove(this.onCrosshair);
  }

  /** The thin-volume settings changed. */
  setOptions(opts) {
    this.opts = { ...this.opts, ...opts };
    this.render();
  }

  destroy() {
    const chart = this.card.chart;
    chart.unsubscribeCrosshairMove(this.onCrosshair);
    this.total.detachPrimitive(this.overlay);
    chart.removeSeries(this.line);
    chart.removeSeries(this.buy);
    chart.removeSeries(this.total);
    this.card.squeezeBands.setRuns([]);
  }

  analyze() {
    const { threshold, memory } = this.opts;
    this.stats = threshold
      ? analyzeVolume(this.card.bars, { memory, threshold, extreme: threshold * 0.4 })
      : null;
  }

  /** Everything, from the bars: on load, prepend, a bar closing, a settings change. */
  render() {
    this.analyze();
    const bars = this.card.bars;
    const stats = this.stats;
    const total = new Array(bars.length);
    const buy = new Array(bars.length);
    const line = [];
    for (let i = 0; i < bars.length; i++) {
      const [t, b] = this.points(bars[i], stats ? stats.level[i] : 0);
      total[i] = t;
      buy[i] = b;
      if (stats && Number.isFinite(stats.line[i])) line.push({ time: bars[i].time, value: stats.line[i] });
    }
    this.total.setData(total);
    this.buy.setData(buy);
    this.line.setData(line);
    this.card.squeezeBands.setRuns(stats ? squeezeRuns(stats.streak) : []);
    this.overlay.redraw();
  }

  /** One bar moved. A new bar means the one before it closed: rank it, and so everything. */
  update(bar, isNew) {
    if (isNew) {
      this.render();
      return;
    }
    const [t, b] = this.points(bar, 0);
    this.total.update(t);
    this.buy.update(b);
    this.overlay.redraw();
  }

  /** The two histogram points of one bar. */
  points(bar, level) {
    const { up, down } = this.card.colors;
    const split = Number.isFinite(bar.buyVolume);
    if (level) {
      return [
        { time: bar.time, value: bar.volume, color: withAlpha(SLATE, 0.4) },
        split ? { time: bar.time, value: bar.buyVolume, color: withAlpha(SLATE, 0.7) } : { time: bar.time },
      ];
    }
    if (!split) {
      return [{ time: bar.time, value: bar.volume, color: withAlpha(bar.close >= bar.open ? up : down, 0.4) }, { time: bar.time }];
    }
    return [
      { time: bar.time, value: bar.volume, color: withAlpha(down, 0.45) },
      { time: bar.time, value: bar.buyVolume, color: withAlpha(up, 0.55) },
    ];
  }

  /** The readout's pieces, left to right: {text, color, chip?}. */
  readout() {
    const bars = this.card.bars;
    if (!bars.length) return [];
    const last = bars.length - 1;
    const forming = bars[last].closed === false;
    let i = this.hover;
    if (i === null || i < 0 || i > last) i = forming && last > 0 ? last - 1 : last;
    const bar = bars[i];
    const muted = 'rgba(226, 232, 240, 0.62)';
    const parts = [{ text: t('量 {v}', { v: formatCompact(bar.volume) }), color: muted }];
    if (Number.isFinite(bar.buyVolume) && bar.volume > 0) {
      const share = Math.round((bar.buyVolume / bar.volume) * 100);
      parts.push({ text: t('買 {buy}% · 賣 {sell}%', { buy: share, sell: 100 - share }), color: muted });
    }
    const stats = this.stats;
    if (!stats) return parts;
    const pr = (r) => (r < 0.01 ? '<1' : String(Math.round(r * 100)));
    if (i === last && forming) {
      const live = liveRank(stats.hist, bar, Date.now() / 1000, this.opts.intervalSec);
      if (live) parts.push({ text: t('PR ~{pr}（推估）', { pr: pr(live.rank) }), color: muted });
      return parts;
    }
    const level = stats.level[i];
    parts.push({ text: `PR ${pr(stats.rank[i])}`, color: level ? SLATE : muted });
    if (level) parts.push({ text: level === 2 ? t('極度縮量') : t('縮量'), color: '#c3cde0', chip: true });
    if (stats.streak[i] >= SQUEEZE_STREAK) parts.push({ text: t('連續縮量 {n} 根', { n: stats.streak[i] }), color: '#c3cde0', chip: true });
    return parts;
  }
}
