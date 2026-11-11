/**
 * The Coinbase sub-pane: is US spot money buying?
 *
 *   bars   the premium per bar (coinbase.js), on the pane's axis in percent,
 *          above zero in the up colour (Coinbase pays more), below in the
 *          down colour. The scale is centred on zero, so a bar's side and
 *          height read the same from one view to the next.
 *   line   Coinbase's CVD, the running sum of its takers' net buying, on a
 *          scale of its own: only its direction means anything, as with the
 *          Binance CVD pane.
 *
 * Top left, a line in words: the hovered (or newest) bar's premium and
 * Coinbase net buying, and what the pane cannot show yet -- the record
 * starting late, the hours being fetched back, no dollar pair, no link.
 */

import { HistogramSeries, LineSeries, LineStyle } from './vendor/lightweight-charts.mjs';
import { withAlpha } from './volume-pane.js';
import { t } from './i18n.js';

const CVD_COLOR = '#5b9cf6';
const MUTED = 'rgba(226, 232, 240, 0.7)';
const GUIDE = 'rgba(148, 163, 184, 0.45)';
const FONT = "10px 'Segoe UI', -apple-system, 'Noto Sans TC', 'Microsoft JhengHei', sans-serif";
/** The premium's scale shows at least ±this much, so noise stays small. */
const MIN_RANGE = 0.03;

const signed = (v, digits) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}`;
export const premiumText = (v) => `${signed(v, Math.abs(v) >= 1 ? 2 : 3)}%`;

/** $1.24M, $812K: three figures, signed. */
export function usdSigned(v) {
  const a = Math.abs(v);
  const [div, unit] = a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : a >= 1e3 ? [1e3, 'K'] : [1, ''];
  const x = a / div;
  const digits = x >= 100 || !unit ? 0 : x >= 10 ? 1 : 2;
  return `${v >= 0 ? '+' : '−'}$${x.toFixed(digits).replace(/\.0+$|(\.\d*?)0+$/, '$1')}${unit}`;
}

function outlinedText(ctx, text, x, y, color) {
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(15, 20, 28, 0.85)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

class LegendRenderer {
  constructor(source) {
    this.source = source;
  }

  draw(target) {
    const parts = this.source.legend();
    if (!parts.length) return;
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      ctx.save();
      ctx.font = FONT;
      ctx.textBaseline = 'middle';
      // Clear of the tool rail, like the price pane's legends.
      let x = 46;
      for (const part of parts) {
        outlinedText(ctx, part.text, x, 11, part.color);
        x += ctx.measureText(part.text).width + 8;
      }
      ctx.restore();
    });
  }
}

class Legend {
  constructor(pane) {
    this.pane = pane;
    this.views = [{ renderer: () => new LegendRenderer(this), zOrder: () => 'top' }];
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

  legend() {
    return this.pane.legend();
  }
}

export class CoinbasePane {
  /**
   * @param {import('./chart.js').CardChart} card
   * @param {{premium: boolean, cvd: boolean}} opts
   */
  constructor(card, paneIndex, opts) {
    this.card = card;
    this.opts = opts;
    this.hoverTime = null;
    const chart = card.chart;
    this.premium = null;
    this.cvd = null;
    if (opts.premium) {
      this.premium = chart.addSeries(
        HistogramSeries,
        {
          priceLineVisible: false,
          lastValueVisible: true,
          base: 0,
          priceFormat: { type: 'custom', formatter: premiumText, minMove: 0.001 },
          autoscaleInfoProvider: (original) => {
            const res = original();
            const r = res && res.priceRange;
            const m = Math.max(MIN_RANGE, r ? Math.abs(r.minValue) : 0, r ? Math.abs(r.maxValue) : 0);
            return { priceRange: { minValue: -m, maxValue: m } };
          },
        },
        paneIndex
      );
      this.premium.priceScale().applyOptions({ scaleMargins: { top: 0.18, bottom: 0.06 }, borderVisible: false });
      this.premium.createPriceLine({ price: 0, color: GUIDE, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false });
    }
    if (opts.cvd) {
      const own = !opts.premium;
      this.cvd = chart.addSeries(
        LineSeries,
        {
          color: CVD_COLOR,
          lineWidth: 1.5,
          priceLineVisible: false,
          // On its own scale beside the premium, which has the axis; its
          // level is only where the record starts, so no label for it.
          lastValueVisible: own,
          crosshairMarkerRadius: 2,
          ...(own ? { priceFormat: { type: 'custom', formatter: (v) => usdSigned(v), minMove: 0.01 } } : { priceScaleId: 'cb-cvd' }),
        },
        paneIndex
      );
      this.cvd.priceScale().applyOptions({ scaleMargins: { top: 0.2, bottom: 0.08 }, borderVisible: false, visible: own });
    }
    this.legendPrimitive = new Legend(this);
    (this.premium || this.cvd).attachPrimitive(this.legendPrimitive);
  }

  get data() {
    return this.card.cbData;
  }

  render() {
    const bars = this.card.bars;
    const d = this.data;
    const { up, down } = this.card.colors;
    if (this.premium) {
      this.premium.setData(
        bars.map((b) => {
          const v = d.premium.get(b.time);
          return Number.isFinite(v) ? { time: b.time, value: v, color: withAlpha(v >= 0 ? up : down, 0.8) } : { time: b.time };
        })
      );
    }
    if (this.cvd) {
      this.cvd.setData(
        bars.map((b) => {
          const v = d.cvd.get(b.time);
          return Number.isFinite(v) ? { time: b.time, value: v } : { time: b.time };
        })
      );
    }
    this.redrawLegend();
  }

  redrawLegend() {
    if (this.legendPrimitive.requestUpdate) this.legendPrimitive.requestUpdate();
  }

  legend() {
    const d = this.data;
    const { up, down } = this.card.colors;
    const out = [{ text: 'Coinbase', color: MUTED }];
    const note = this.note();
    if (note && d.state !== 'ready') return [...out, { text: note, color: MUTED }];
    const bars = this.card.bars;
    let time = this.hoverTime;
    if (time == null && bars.length) time = bars[bars.length - 1].time;
    if (this.opts.premium) {
      const v = d.premium.get(time);
      out.push(Number.isFinite(v) ? { text: `${t('溢價')} ${premiumText(v)}`, color: v >= 0 ? up : down } : { text: `${t('溢價')} —`, color: MUTED });
    }
    if (this.opts.cvd) {
      const v = d.delta.get(time);
      out.push(Number.isFinite(v) ? { text: `${t('主動淨買')} ${usdSigned(v)}`, color: CVD_COLOR } : { text: `${t('主動淨買')} —`, color: MUTED });
    }
    if (note) out.push({ text: note, color: MUTED });
    return out;
  }

  /** What the pane cannot show, or null. */
  note() {
    const d = this.data;
    if (d.state === 'short') return t('需要 1 分鐘以上的 K 棒');
    if (d.state === 'none') return t('Coinbase 沒有這個幣的美元交易對');
    if (d.state === 'failed') return t('連不上 Coinbase（可在系統匣開啟加密 DNS）');
    if (d.state === 'loading') return t('載入中…');
    if (!this.opts.cvd) return null;
    if (d.filling) return t('補抓近 3 小時的成交中…');
    const bars = this.card.bars;
    if (d.since && bars.length && d.since / 1000 > bars[0].time + 60) {
      return t('成交 {time} 起才有紀錄', { time: this.card.formatters.crosshair(Math.floor(d.since / 1000)) });
    }
    return null;
  }

  destroy() {
    const chart = this.card.chart;
    (this.premium || this.cvd).detachPrimitive(this.legendPrimitive);
    if (this.premium) chart.removeSeries(this.premium);
    if (this.cvd) chart.removeSeries(this.cvd);
  }
}
