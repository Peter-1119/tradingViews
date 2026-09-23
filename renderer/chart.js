/**
 * lightweight-charts v5 wrapper (spec 5).
 *
 * v5 note: series are created with `chart.addSeries(SeriesDefinition, options)`.
 * The v4 helpers (`addCandlestickSeries()` etc.) no longer exist.
 *
 * The wrapper owns the bar cache, so switching chart type is a pure re-render
 * of data we already have — no extra REST call.
 */

import {
  createChart,
  CrosshairMode,
  CandlestickSeries,
  LineSeries,
  AreaSeries,
  HistogramSeries,
} from './vendor/lightweight-charts.mjs';

export const CHART_TYPES = ['candlestick', 'line', 'area'];

/** Volume sub-pane sizing. Below ~30px the histogram is not readable at all. */
const VOLUME_PANE_RATIO = 0.24;
const MIN_VOLUME_PANE_PX = 30;

const PALETTE = {
  greenUp: { up: '#26c281', down: '#ed5465' },
  redUp: { up: '#ed5465', down: '#26c281' },
};

const TEXT = 'rgba(226, 232, 240, 0.72)';
const GRID = 'rgba(148, 163, 184, 0.08)';
const CROSSHAIR = 'rgba(148, 163, 184, 0.45)';

/** Crypto spans BTC at 5 digits and memecoins at 8 decimals; pick per price. */
function precisionFor(price) {
  const p = Math.abs(Number(price) || 0);
  if (p >= 100) return 2;
  if (p >= 1) return 3;
  if (p >= 0.01) return 5;
  if (p >= 0.0001) return 7;
  return 8;
}

function withAlpha(hex, alpha) {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export class CardChart {
  /**
   * @param {HTMLElement} container
   * @param {{upDownColor?: string, showVolume?: boolean, chartType?: string}} options
   */
  constructor(container, options = {}) {
    this.container = container;
    this.chartType = CHART_TYPES.includes(options.chartType) ? options.chartType : 'candlestick';
    this.upDownColor = options.upDownColor === 'redUp' ? 'redUp' : 'greenUp';
    this.showVolume = options.showVolume === true;

    /** @type {Bar[]} the single source of truth for every series shape */
    this.bars = [];
    this.precision = 2;

    // While the window is hidden we keep caching bars but stop touching the
    // renderer, then replay in one shot on resume (spec 5, CPU saving).
    this.paused = false;
    this.dirtyWhilePaused = false;

    this.chart = createChart(container, {
      autoSize: true,
      layout: {
        // Must be transparent: card translucency is owned by CSS, not the chart.
        background: { color: 'transparent' },
        textColor: TEXT,
        fontSize: 10,
        fontFamily:
          "'Segoe UI', -apple-system, 'Noto Sans TC', 'Microsoft JhengHei', sans-serif",
        panes: {
          separatorColor: 'rgba(148, 163, 184, 0.16)',
          separatorHoverColor: 'rgba(148, 163, 184, 0.3)',
          enableResize: false,
        },
      },
      grid: {
        vertLines: { color: GRID },
        horzLines: { color: GRID },
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.14, bottom: 0.12 },
        entireTextOnly: true,
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 3,
        barSpacing: 6,
        minBarSpacing: 1,
        fixLeftEdge: false,
        lockVisibleTimeRangeOnResize: true,
      },
      crosshair: {
        // Free by default, Ctrl magnets -- see setCrosshairMagnet().
        mode: CrosshairMode.Normal,
        vertLine: { color: CROSSHAIR, width: 1, style: 3, labelBackgroundColor: '#1e2633' },
        horzLine: { color: CROSSHAIR, width: 1, style: 3, labelBackgroundColor: '#1e2633' },
      },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
      localization: {
        locale: navigator.language || 'en-US',
        priceFormatter: (price) => this.formatPrice(price),
      },
    });

    this.crosshairMode = CrosshairMode.Normal;
    this.paneRetryTimer = null;

    /*
     * Crosshair follows the pointer; hold Ctrl to magnet onto a price point.
     *
     * This mirrors TradingView, deliberately, so the muscle memory carries over.
     * There the crosshair always reads the price under the cursor, and Ctrl is
     * what engages Magnet mode -- which snaps to "the nearest open, high, low or
     * close", not to the close alone. Hence MagnetOHLC rather than Magnet: the
     * library picks whichever of the four candidates is nearest the pointer, so
     * hovering above a candle grabs its high and hovering below grabs its low,
     * which is the behaviour that makes magnet worth having when you are lining
     * a level up against a wick.
     *
     * This rides the crosshair's own mouse events rather than keydown/keyup on
     * purpose: cards are shown with `showInactive()` and never take focus, so a
     * key listener would hear nothing at all. The price of that is that the
     * switch lands on the next mouse movement rather than the instant Ctrl goes
     * down.
     *
     * The early return matters. This fires for redraws too -- a new bar, or our
     * own applyOptions below -- and those carry no `sourceEvent` and therefore
     * no modifier state. Reading one as "Ctrl released" flips the mode back a
     * frame after every switch, which at 100ms bar updates means Ctrl appears
     * to do nothing at all. Mouse leaving the chart is handled separately.
     */
    this.chart.subscribeCrosshairMove((param) => {
      if (!param.sourceEvent) return;
      this.setCrosshairMagnet(param.sourceEvent.ctrlKey);
    });

    this.onPointerLeave = () => this.setCrosshairMagnet(false);
    container.addEventListener('mouseleave', this.onPointerLeave);

    this.priceSeries = null;
    this.volumeSeries = null;

    this.createPriceSeries();
    if (this.showVolume) this.createVolumeSeries();

    // autoSize handles the common case; this catches pane height ratios, which
    // are expressed in pixels and so must be recomputed per resize.
    this.resizeObserver = new ResizeObserver(() => this.layoutPanes());
    this.resizeObserver.observe(container);
  }

  get colors() {
    return PALETTE[this.upDownColor];
  }

  formatPrice(price) {
    return Number(price).toFixed(this.precision);
  }

  /* ------------------------------------------------------------- series */

  priceSeriesOptions() {
    const { up, down } = this.colors;
    const priceFormat = {
      type: 'price',
      precision: this.precision,
      minMove: Number((10 ** -this.precision).toFixed(this.precision)),
    };

    if (this.chartType === 'line') {
      return {
        color: up,
        lineWidth: 2,
        priceFormat,
        lastValueVisible: true,
        priceLineVisible: true,
        priceLineColor: withAlpha(up, 0.5),
        priceLineWidth: 1,
        priceLineStyle: 2,
        crosshairMarkerRadius: 3,
      };
    }

    if (this.chartType === 'area') {
      return {
        lineColor: up,
        topColor: withAlpha(up, 0.32),
        bottomColor: withAlpha(up, 0.02),
        lineWidth: 2,
        priceFormat,
        lastValueVisible: true,
        priceLineVisible: true,
        priceLineColor: withAlpha(up, 0.5),
        priceLineWidth: 1,
        priceLineStyle: 2,
        crosshairMarkerRadius: 3,
      };
    }

    return {
      upColor: up,
      downColor: down,
      borderUpColor: up,
      borderDownColor: down,
      wickUpColor: withAlpha(up, 0.8),
      wickDownColor: withAlpha(down, 0.8),
      borderVisible: true,
      priceFormat,
      lastValueVisible: true,
      priceLineVisible: true,
      priceLineWidth: 1,
      priceLineStyle: 2,
    };
  }

  seriesDefinition() {
    if (this.chartType === 'line') return LineSeries;
    if (this.chartType === 'area') return AreaSeries;
    return CandlestickSeries;
  }

  createPriceSeries() {
    this.priceSeries = this.chart.addSeries(this.seriesDefinition(), this.priceSeriesOptions());
  }

  createVolumeSeries() {
    if (this.volumeSeries) return;
    // Pane index 1 creates the volume sub-pane below the price pane.
    this.volumeSeries = this.chart.addSeries(
      HistogramSeries,
      {
        priceFormat: { type: 'volume' },
        priceLineVisible: false,
        lastValueVisible: false,
      },
      1
    );
    this.volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.15, bottom: 0 },
      borderVisible: false,
    });
    this.layoutPanes();
  }

  removeVolumeSeries() {
    if (!this.volumeSeries) return;
    this.chart.removeSeries(this.volumeSeries);
    this.volumeSeries = null;
    this.layoutPanes();
  }

  /**
   * Pane heights are pixel values, so they need recomputing whenever we resize.
   *
   * `setHeight()` is not a plain setter. Internally it derives the new split
   * from the panes' *current* pixel heights:
   *
   *     const totalHeight = panes.reduce((s, p) => s + p.height(), 0);
   *     const pixelStretchFactor = totalStretch / totalHeight;
   *
   * So calling it on a pane the chart has not laid out yet does the arithmetic
   * against a height of 0 and silently does nothing -- no throw, no effect. The
   * volume pane is then stuck at zero height, and since the only other caller
   * of this is the ResizeObserver, it stays stuck until the card is resized.
   * That is exactly the "toggle it on, nothing looks right until I drag the
   * corner" failure, so verify the result and take one more run at it.
   */
  layoutPanes({ retry = true } = {}) {
    const panes = this.chart.panes();
    if (panes.length < 2) return;
    const total = this.container.clientHeight || 200;
    const volumeHeight = Math.max(MIN_VOLUME_PANE_PX, Math.round(total * VOLUME_PANE_RATIO));

    try {
      panes[1].setHeight(volumeHeight);
    } catch (err) {
      // A pane really can vanish mid-resize during teardown. Anything else is
      // worth seeing -- the old bare `catch {}` here meant a broken layout left
      // no trace at all.
      if (this.chart) console.warn('[chart] volume pane layout failed', err);
      return;
    }

    if (!retry) return;
    clearTimeout(this.paneRetryTimer);
    this.paneRetryTimer = setTimeout(() => {
      this.paneRetryTimer = null;
      if (!this.chart) return;
      const current = this.chart.panes();
      // Zero height means the first attempt landed before the chart had laid
      // the pane out. Deliberately setTimeout and not requestAnimationFrame:
      // a hidden or occluded card window gets its frames throttled, which is
      // when this retry matters most.
      if (current.length >= 2 && current[1].getHeight() === 0) this.layoutPanes({ retry: false });
    }, 50);
  }

  /* --------------------------------------------------------------- data */

  toPricePoint(bar) {
    if (this.chartType === 'candlestick') {
      return {
        time: bar.time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      };
    }
    // Line and area both plot the close (spec 5).
    return { time: bar.time, value: bar.close };
  }

  toVolumePoint(bar) {
    const rising = bar.close >= bar.open;
    return {
      time: bar.time,
      value: bar.volume,
      color: withAlpha(rising ? this.colors.up : this.colors.down, 0.4),
    };
  }

  /** Replace the whole cache (initial load, or a symbol/interval change). */
  setData(bars) {
    this.bars = Array.isArray(bars) ? [...bars] : [];
    const last = this.bars[this.bars.length - 1];
    if (last) {
      const nextPrecision = precisionFor(last.close);
      if (nextPrecision !== this.precision) {
        this.precision = nextPrecision;
        this.priceSeries.applyOptions(this.priceSeriesOptions());
      }
    }
    this.render();
    this.chart.timeScale().scrollToRealTime();
  }

  /** Merge one live bar into the cache and push it to the renderer. */
  update(bar) {
    if (!bar || !Number.isFinite(bar.time)) return;

    const last = this.bars[this.bars.length - 1];
    if (!last || bar.time > last.time) {
      this.bars.push(bar);
      // Keep memory bounded on a widget that may run for days.
      if (this.bars.length > 1500) this.bars.splice(0, this.bars.length - 1000);
    } else if (bar.time === last.time) {
      this.bars[this.bars.length - 1] = bar;
    } else {
      return; // out-of-order/stale bar
    }

    if (this.paused) {
      this.dirtyWhilePaused = true;
      return;
    }

    this.priceSeries.update(this.toPricePoint(bar));
    if (this.volumeSeries) this.volumeSeries.update(this.toVolumePoint(bar));
  }

  render() {
    if (this.paused) {
      this.dirtyWhilePaused = true;
      return;
    }
    this.priceSeries.setData(this.bars.map((b) => this.toPricePoint(b)));
    if (this.volumeSeries) {
      this.volumeSeries.setData(this.bars.map((b) => this.toVolumePoint(b)));
    }
  }

  /* ------------------------------------------------------------ options */

  /**
   * Chart-type switching: drop the old series, build the new one, re-feed from
   * the cache. No network round trip (spec 5).
   */
  setChartType(type) {
    const next = CHART_TYPES.includes(type) ? type : 'candlestick';
    if (next === this.chartType) return;
    this.chartType = next;

    const visibleRange = this.chart.timeScale().getVisibleLogicalRange();

    this.chart.removeSeries(this.priceSeries);
    this.createPriceSeries();
    this.render();

    // Preserve the viewport so the switch does not feel like a reload.
    if (visibleRange) {
      try {
        this.chart.timeScale().setVisibleLogicalRange(visibleRange);
      } catch {
        this.chart.timeScale().scrollToRealTime();
      }
    }
  }

  /** @param {boolean} magnet  true = snap to the nearest OHLC, false = follow the pointer. */
  setCrosshairMagnet(magnet) {
    const next = magnet ? CrosshairMode.MagnetOHLC : CrosshairMode.Normal;
    // Called on every crosshair move, so bail before touching the chart.
    if (next === this.crosshairMode) return;
    this.crosshairMode = next;
    this.chart.applyOptions({ crosshair: { mode: next } });
  }

  setVolumeVisible(visible) {
    const next = visible === true;
    if (next === this.showVolume) return;
    this.showVolume = next;
    if (next) {
      this.createVolumeSeries();
      this.volumeSeries.setData(this.bars.map((b) => this.toVolumePoint(b)));
    } else {
      this.removeVolumeSeries();
    }
  }

  setUpDownColor(mode) {
    const next = mode === 'redUp' ? 'redUp' : 'greenUp';
    if (next === this.upDownColor) return;
    this.upDownColor = next;
    this.priceSeries.applyOptions(this.priceSeriesOptions());
    if (this.volumeSeries) {
      this.volumeSeries.setData(this.bars.map((b) => this.toVolumePoint(b)));
    }
  }

  /* ----------------------------------------------------------- lifecycle */

  pause() {
    this.paused = true;
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    if (this.dirtyWhilePaused) {
      this.dirtyWhilePaused = false;
      this.render();
      this.chart.timeScale().scrollToRealTime();
    }
  }

  resize() {
    this.layoutPanes();
  }

  destroy() {
    this.resizeObserver.disconnect();
    clearTimeout(this.paneRetryTimer);
    this.container.removeEventListener('mouseleave', this.onPointerLeave);
    try {
      this.chart.remove();
    } catch {
      /* already gone */
    }
    this.chart = null;
    this.priceSeries = null;
    this.volumeSeries = null;
    this.bars = [];
  }
}
