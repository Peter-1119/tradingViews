/**
 * RSI and MACD sub-panes. The arithmetic is in indicators.js; this is only
 * series and colours.
 *
 * Each pane computes everything once when the bars are replaced (`render`)
 * and after that only the newest point per tick (`update`), from the filter
 * state carried over the closed bars.
 */

import { HistogramSeries, LineSeries, LineStyle } from './vendor/lightweight-charts.mjs';
import { Rsi, Macd, Track } from './indicators.js';
import { withAlpha } from './volume-pane.js';

const RSI_COLOR = '#b392f0';
const MACD_COLOR = '#4ea1f3';
const SIGNAL_COLOR = '#f0a050';
const GUIDE = 'rgba(148, 163, 184, 0.45)';

const point = (time, value) => (Number.isFinite(value) ? { time, value } : { time });

export class RsiPane {
  constructor(card, paneIndex, period) {
    this.card = card;
    this.track = new Track(() => new Rsi(period));
    this.series = card.chart.addSeries(
      LineSeries,
      {
        color: RSI_COLOR,
        lineWidth: 1.5,
        title: `RSI ${period}`,
        priceLineVisible: false,
        lastValueVisible: true,
        crosshairMarkerRadius: 2,
        priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
        // Always the whole 0-100: a scale that autofits the line would move
        // 70 and 30 around and hide how stretched the reading is.
        autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
      },
      paneIndex
    );
    this.series.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.08 }, borderVisible: false });
    for (const [price, style] of [[70, LineStyle.Dashed], [50, LineStyle.Dotted], [30, LineStyle.Dashed]]) {
      this.series.createPriceLine({ price, color: GUIDE, lineWidth: 1, lineStyle: style, axisLabelVisible: false });
    }
  }

  render() {
    const bars = this.card.bars;
    const out = this.track.compute(bars);
    this.series.setData(bars.map((b, i) => point(b.time, out[i])));
  }

  update(bar, isNew) {
    this.series.update(point(bar.time, this.track.next(this.card.bars, isNew)));
  }

  destroy() {
    this.card.chart.removeSeries(this.series);
  }
}

export class MacdPane {
  constructor(card, paneIndex) {
    this.card = card;
    this.track = new Track(() => new Macd(12, 26, 9));
    const chart = card.chart;
    const common = { priceLineVisible: false, crosshairMarkerRadius: 2, priceFormat: { type: 'price', precision: card.precision, minMove: 10 ** -card.precision } };
    this.hist = chart.addSeries(HistogramSeries, { ...common, lastValueVisible: false }, paneIndex);
    this.macd = chart.addSeries(LineSeries, { ...common, color: MACD_COLOR, lineWidth: 1.5, title: 'MACD', lastValueVisible: true }, paneIndex);
    this.signal = chart.addSeries(LineSeries, { ...common, color: SIGNAL_COLOR, lineWidth: 1, lastValueVisible: false }, paneIndex);
    this.hist.priceScale().applyOptions({ scaleMargins: { top: 0.12, bottom: 0.08 }, borderVisible: false });
    this.prevHist = NaN;
  }

  /**
   * TradingView's four shades: above zero and growing, above and shrinking,
   * below and growing (more negative), below and shrinking.
   */
  histPoint(time, hist, prev) {
    if (!Number.isFinite(hist)) return { time };
    const { up, down } = this.card.colors;
    const growing = !Number.isFinite(prev) || Math.abs(hist) >= Math.abs(prev);
    return { time, value: hist, color: withAlpha(hist >= 0 ? up : down, growing ? 0.85 : 0.4) };
  }

  render() {
    const bars = this.card.bars;
    const out = this.track.compute(bars);
    const hist = new Array(bars.length);
    for (let i = 0; i < bars.length; i++) hist[i] = this.histPoint(bars[i].time, out[i].hist, i ? out[i - 1].hist : NaN);
    this.hist.setData(hist);
    this.macd.setData(bars.map((b, i) => point(b.time, out[i].macd)));
    this.signal.setData(bars.map((b, i) => point(b.time, out[i].signal)));
    this.prevHist = bars.length > 1 ? out[bars.length - 2].hist : NaN;
  }

  update(bar, isNew) {
    const p = this.track.next(this.card.bars, isNew);
    if (!p) return;
    // The bar before this one just closed: its histogram is what this is compared to.
    if (isNew) this.prevHist = this.track.committed ? this.track.committed.hist : NaN;
    this.hist.update(this.histPoint(bar.time, p.hist, this.prevHist));
    this.macd.update(point(bar.time, p.macd));
    this.signal.update(point(bar.time, p.signal));
  }

  destroy() {
    const chart = this.card.chart;
    chart.removeSeries(this.signal);
    chart.removeSeries(this.macd);
    chart.removeSeries(this.hist);
  }
}
