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
import { HtfPrimitive } from './htf-primitive.js';
import { VolumeProfilePrimitive } from './vp-primitive.js';
import { RectPrimitive } from './rect-primitive.js';
import { FibPrimitive } from './fib-primitive.js';
import { MeasurePrimitive } from './measure-primitive.js';

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

/**
 * Support/resistance levels. Deliberately not green or red -- a level is not
 * bullish or bearish, and borrowing the candle colours would make it read as a
 * signal. Muted slate-blue stays legible over both.
 */
const LEVEL_COLOR = '#7f9dc4';
const LEVEL_COLOR_ACTIVE = '#bcd2ef';
/** How close the pointer must be, in px, to grab a level. */
const LEVEL_GRAB_PX = 6;

/**
 * How near an OHLC value has to be before a *drawing* anchor snaps to it.
 *
 * The crosshair magnets the way TradingView's Strong magnet does -- nearest
 * OHLC regardless of distance -- which is right when you are reading a value
 * off the scale. It is wrong when placing an anchor: aim at a price and the
 * point leaps to whatever the bar under the pointer happens to offer, tens of
 * pixels away. TradingView calls the bounded version Weak magnet, and it is
 * the correct default for drawing.
 */
const ANCHOR_SNAP_PX = 14;

/**
 * Both directions spelled out in full, and that is the whole point.
 *
 * `applyOptions({ handleScale: false })` does not set a flag -- it expands to
 * every sub-option false. Restoring with a partial object then merges, so
 * anything the partial omits stays off. Freezing the chart for a level drag and
 * restoring `{ axisPressedMouseMove }` alone left mouseWheel, pinch and
 * axisDoubleClickReset dead for the life of the card: one drag and the wheel
 * stopped zooming. Restore exactly what was there.
 *
 * The one deliberate deviation from the library defaults is
 * `axisPressedMouseMove.price`: dragging the price axis is off so that a level
 * reads true against the scale it was placed on.
 */
const HANDLE_SCALE_ON = {
  mouseWheel: true,
  pinch: true,
  axisPressedMouseMove: { time: true, price: false },
  axisDoubleClickReset: { time: true, price: true },
};
const HANDLE_SCALE_OFF = {
  mouseWheel: false,
  pinch: false,
  axisPressedMouseMove: false,
  axisDoubleClickReset: false,
};
const HANDLE_SCROLL_ON = {
  mouseWheel: true,
  pressedMouseMove: true,
  horzTouchDrag: true,
  vertTouchDrag: true,
};
const HANDLE_SCROLL_OFF = {
  mouseWheel: false,
  pressedMouseMove: false,
  horzTouchDrag: false,
  vertTouchDrag: false,
};

/**
 * Render times in a chosen zone.
 *
 * Binance timestamps are UTC epoch seconds and lightweight-charts formats them
 * as UTC, so the axis sits 8 hours behind Taipei out of the box. We fix that by
 * *formatting* rather than by shifting the timestamps: the bar times are also
 * the keys the datafeed dedupes and backfills against (`lastBarTime`), and the
 * identity lightweight-charts uses to update the forming candle, so moving them
 * would break the data layer to cosmetic ends.
 *
 * The caveat this cannot fix: a `1d` candle really is a UTC day on Binance, so
 * in UTC+8 it is labelled 08:00. That is the exchange's boundary, not a
 * formatting bug -- intraday is clean because the offset is a whole hour.
 */
function timeFormatters(timezone) {
  const zone = timezone && timezone !== 'auto' ? { timeZone: timezone } : {};
  const locale = navigator.language || 'en-US';
  const make = (opts) => new Intl.DateTimeFormat(locale, { ...opts, ...zone });

  const hm = make({ hour: '2-digit', minute: '2-digit', hour12: false });
  const hms = make({ hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const day = make({ month: 'short', day: 'numeric' });
  const month = make({ year: '2-digit', month: 'short' });
  const year = make({ year: 'numeric' });
  const full = make({
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  return {
    /** Axis ticks: the library tells us which granularity it wants. */
    tickMark: (time, tickMarkType) => {
      const date = new Date(Number(time) * 1000);
      switch (tickMarkType) {
        case 0: // Year
          return year.format(date);
        case 1: // Month
          return month.format(date);
        case 2: // DayOfMonth
          return day.format(date);
        case 4: // TimeWithSeconds
          return hms.format(date);
        default: // Time
          return hm.format(date);
      }
    },
    /** Crosshair label: always the full stamp, there is only one of them. */
    crosshair: (time) => full.format(new Date(Number(time) * 1000)),
  };
}

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
    this.timezone = options.timezone || 'auto';
    this.formatters = timeFormatters(this.timezone);

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
        tickMarkFormatter: (time, tickMarkType) => this.formatters.tickMark(time, tickMarkType),
      },
      crosshair: {
        // Free by default, Ctrl magnets -- see setCrosshairMagnet().
        mode: CrosshairMode.Normal,
        vertLine: { color: CROSSHAIR, width: 1, style: 3, labelBackgroundColor: '#1e2633' },
        horzLine: { color: CROSSHAIR, width: 1, style: 3, labelBackgroundColor: '#1e2633' },
      },
      handleScale: HANDLE_SCALE_ON,
      localization: {
        locale: navigator.language || 'en-US',
        priceFormatter: (price) => this.formatPrice(price),
        timeFormatter: (time) => this.formatters.crosshair(time),
      },
    });

    this.crosshairMode = CrosshairMode.Normal;
    this.paneRetryTimer = null;

    /** levelId -> { level, priceLine } */
    this.levels = new Map();
    this.activeLevelId = null;

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

    this.htf = new HtfPrimitive(this);
    this.htf.setColors(this.colors);
    this.vp = new VolumeProfilePrimitive(this);
    this.rects = new RectPrimitive(this);
    this.fibLayer = new FibPrimitive(this);
    this.measureLayer = new MeasurePrimitive(this);

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
    // Primitives belong to a series and die with it, so a chart-type switch
    // has to re-attach -- this is the one place every new series comes from.
    this.priceSeries.attachPrimitive(this.htf);
    this.priceSeries.attachPrimitive(this.vp);
    this.priceSeries.attachPrimitive(this.rects);
    this.priceSeries.attachPrimitive(this.fibLayer);
    this.priceSeries.attachPrimitive(this.measureLayer);
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

  /**
   * Splice older bars onto the front, preserving the viewport.
   *
   * setData would reset the visible range and yank the user back to the right
   * edge mid-scroll, which is exactly when this gets called. The logical range
   * also shifts by however many bars were added, so it has to be re-applied.
   */
  prependBars(older) {
    if (!Array.isArray(older) || !older.length || !this.priceSeries) return 0;
    const first = this.bars.length ? this.bars[0].time : Infinity;
    const fresh = older.filter((b) => b.time < first).sort((a, b) => a.time - b.time);
    if (!fresh.length) return 0;

    const scale = this.chart.timeScale();
    const before = scale.getVisibleLogicalRange();
    this.bars = [...fresh, ...this.bars];
    this.render();
    if (before) {
      try {
        scale.setVisibleLogicalRange({
          from: before.from + fresh.length,
          to: before.to + fresh.length,
        });
      } catch {
        /* range rejected mid-teardown */
      }
    }
    return fresh.length;
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
    // Price lines are owned by the series, so they die with it. Keep the level
    // records and re-attach them to the replacement.
    const levels = [...this.levels.values()].map((entry) => entry.level);

    this.chart.removeSeries(this.priceSeries);
    this.levels.clear();
    this.createPriceSeries();
    this.render();
    this.setLevels(levels);

    // Preserve the viewport so the switch does not feel like a reload.
    if (visibleRange) {
      try {
        this.chart.timeScale().setVisibleLogicalRange(visibleRange);
      } catch {
        this.chart.timeScale().scrollToRealTime();
      }
    }
  }

  /* -------------------------------------------------------------- levels */

  levelOptions(id) {
    const active = id === this.activeLevelId;
    return {
      price: 0,
      color: active ? LEVEL_COLOR_ACTIVE : LEVEL_COLOR,
      lineWidth: 1,
      lineStyle: 2, // LineStyle.Dashed -- distinguishes a drawn level from the series
      axisLabelVisible: true,
      axisLabelColor: active ? LEVEL_COLOR_ACTIVE : LEVEL_COLOR,
      axisLabelTextColor: '#0b0f17',
      title: '',
    };
  }

  /** Reconcile the rendered price lines against a list from the store. */
  setLevels(list) {
    if (!this.priceSeries) return;
    const next = new Map();
    for (const level of Array.isArray(list) ? list : []) {
      const existing = this.levels.get(level.id);
      if (existing) {
        existing.level = level;
        existing.priceLine.applyOptions({ ...this.levelOptions(level.id), price: level.price });
        next.set(level.id, existing);
        this.levels.delete(level.id);
      } else {
        const priceLine = this.priceSeries.createPriceLine({
          ...this.levelOptions(level.id),
          price: level.price,
        });
        next.set(level.id, { level, priceLine });
      }
    }
    // Whatever is left in the old map was removed upstream.
    for (const { priceLine } of this.levels.values()) {
      try {
        this.priceSeries.removePriceLine(priceLine);
      } catch {
        /* series already torn down */
      }
    }
    this.levels = next;
  }

  /**
   * Freeze pan/zoom while a level is being dragged. Cleaner than fighting the
   * library's own mouse handlers with stopPropagation, and it also stops a
   * slightly-off grab from scrolling the chart instead of moving the line.
   */
  setInteractionEnabled(enabled) {
    this.chart.applyOptions({
      handleScroll: enabled ? HANDLE_SCROLL_ON : HANDLE_SCROLL_OFF,
      handleScale: enabled ? HANDLE_SCALE_ON : HANDLE_SCALE_OFF,
    });
  }

  /** Live preview while dragging, without touching the store on every pixel. */
  previewLevel(id, price) {
    const entry = this.levels.get(id);
    if (entry) entry.priceLine.applyOptions({ price });
  }

  setActiveLevel(id) {
    if (this.activeLevelId === id) return;
    const previous = this.activeLevelId;
    this.activeLevelId = id;
    for (const key of [previous, id]) {
      const entry = key && this.levels.get(key);
      if (entry) {
        entry.priceLine.applyOptions({
          ...this.levelOptions(key),
          price: entry.priceLine.options().price,
        });
      }
    }
  }

  /** @returns {string|null} id of the level within grab distance of `y`. */
  levelAt(y) {
    if (!this.priceSeries) return null;
    let best = null;
    let bestDist = LEVEL_GRAB_PX;
    for (const [id, entry] of this.levels) {
      const lineY = this.priceSeries.priceToCoordinate(entry.priceLine.options().price);
      if (lineY === null) continue;
      const dist = Math.abs(lineY - y);
      if (dist <= bestDist) {
        best = id;
        bestDist = dist;
      }
    }
    return best;
  }

  /**
   * The price under a pointer position, magnetised to the nearest OHLC when
   * asked -- the same rule the Ctrl crosshair uses, so placing a level lands
   * exactly where the crosshair says it will.
   */
  priceAt(x, y, { magnet = false, maxSnapPx } = {}) {
    if (!this.priceSeries) return null;
    const raw = this.priceSeries.coordinateToPrice(y);
    if (raw === null) return null;
    // A pixel maps to an absurdly precise float; a level is only ever as
    // precise as the instrument quotes, and the stored value should read like
    // the axis label rather than 86279.07748827102.
    const round = (price) => Number(Number(price).toFixed(this.precision));
    if (!magnet) return round(raw);

    const bar = this.barAt(x);
    if (!bar) return round(raw);
    const candidates =
      this.chartType === 'candlestick' ? [bar.open, bar.high, bar.low, bar.close] : [bar.close];
    let nearest = raw;
    let bestDist = Infinity;
    for (const price of candidates) {
      const dist = Math.abs(price - raw);
      if (dist < bestDist) {
        bestDist = dist;
        nearest = price;
      }
    }
    // Measured in pixels, not price: a fixed price threshold would mean
    // something different on BTC than on a sub-cent token, and different again
    // at every zoom level.
    if (Number.isFinite(maxSnapPx)) {
      const targetY = this.priceSeries.priceToCoordinate(nearest);
      if (targetY === null || Math.abs(targetY - y) > maxSnapPx) return round(raw);
    }
    // A magnet target is already an exact quoted price; rounding keeps it so.
    return round(nearest);
  }

  /* ------------------------------------------------------------- measuring */

  /**
   * A chart point in *logical* coordinates rather than pixels.
   *
   * `logical` is a fractional bar index, so the point survives panning and
   * zooming, and unlike a raw timestamp it is still defined out in the
   * `rightOffset` gap past the last bar, where `timeToCoordinate` gives up.
   */
  pointAt(x, y, { magnet = false, maxSnapPx } = {}) {
    const logical = this.chart.timeScale().coordinateToLogical(x);
    const price = this.priceAt(x, y, { magnet, maxSnapPx });
    if (logical === null || price === null) return null;
    return { logical, price };
  }

  /** @returns {() => void} unsubscribe. Fires on pan and zoom. */
  onVisibleRangeChange(callback) {
    const scale = this.chart.timeScale();
    scale.subscribeVisibleLogicalRangeChange(callback);
    return () => {
      try {
        scale.unsubscribeVisibleLogicalRangeChange(callback);
      } catch {
        /* chart already gone */
      }
    };
  }

  /**
   * Time -> fractional bar index.
   *
   * The anchor of anything persisted has to be a timestamp, because a logical
   * index only means anything relative to the bars currently loaded -- load a
   * different history depth and index 40 is a different candle. But the chart
   * draws in logical space, and `timeToCoordinate` refuses any time that is not
   * exactly on a bar, which is every time once you switch timeframe. So do the
   * interpolation here: binary search the cache, then place the point
   * proportionally between the two bars it falls between. Past either end,
   * extrapolate at the average bar spacing so an anchor off-screen still
   * resolves instead of vanishing.
   */
  logicalFromTime(time) {
    const bars = this.bars;
    if (!bars.length) return null;
    const t = Number(time);
    const step = this.secondsPerBar() || 1;
    if (t <= bars[0].time) return (t - bars[0].time) / step;
    if (t >= bars[bars.length - 1].time) {
      return bars.length - 1 + (t - bars[bars.length - 1].time) / step;
    }
    let lo = 0;
    let hi = bars.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (bars[mid].time <= t) lo = mid;
      else hi = mid;
    }
    const span = bars[hi].time - bars[lo].time;
    return lo + (span ? (t - bars[lo].time) / span : 0);
  }

  /** Fractional bar index -> time, for turning a pointer position into an anchor. */
  timeFromLogical(logical) {
    const bars = this.bars;
    if (!bars.length) return null;
    const step = this.secondsPerBar() || 1;
    if (logical <= 0) return Math.round(bars[0].time + logical * step);
    if (logical >= bars.length - 1) {
      return Math.round(bars[bars.length - 1].time + (logical - (bars.length - 1)) * step);
    }
    const lo = Math.floor(logical);
    const frac = logical - lo;
    return Math.round(bars[lo].time + frac * (bars[lo + 1].time - bars[lo].time));
  }

  /** Anchor in persistable coordinates: a timestamp and a price. */
  anchorAt(x, y, { magnet = false } = {}) {
    // Drawing anchors always use the bounded (weak) magnet.
    const point = this.pointAt(x, y, { magnet, maxSnapPx: ANCHOR_SNAP_PX });
    if (!point) return null;
    const time = this.timeFromLogical(point.logical);
    if (time === null) return null;
    return { time, price: point.price };
  }

  /**
   * Fractional bar index -> x pixel.
   *
   * `timeScale.logicalToCoordinate` looks like it takes a Logical, but its
   * implementation begins:
   *
   *     if (this._internal_isEmpty() || !isInteger(index)) return 0;
   *
   * Any non-integer index silently answers 0 -- not null, so there is nothing
   * to detect -- and every anchor that is not exactly on a bar piles up against
   * the left edge. Which is most of them the moment you change timeframe. So
   * ask for the two whole bars either side and interpolate between their
   * coordinates, which is linear anyway since bar spacing is uniform.
   */
  logicalToX(logical) {
    if (!this.bars.length || !Number.isFinite(logical)) return null;
    const scale = this.chart.timeScale();
    const lo = Math.floor(logical);
    const frac = logical - lo;
    const xLo = scale.logicalToCoordinate(lo);
    if (xLo === null) return null;
    if (!frac) return xLo;
    const xHi = scale.logicalToCoordinate(lo + 1);
    if (xHi === null) return null;
    return xLo + (xHi - xLo) * frac;
  }

  /**
   * Width of the right price scale in px.
   *
   * Overlays are positioned against the whole chart element, which includes the
   * axis gutter -- so anything anchored to `right: 0` ends up underneath the
   * price labels. Inset by this instead.
   */
  priceScaleWidth() {
    try {
      return this.chart.priceScale('right').width() || 0;
    } catch {
      return 0;
    }
  }

  /** @returns {number|null} y pixel for a price, or null if off the scale. */
  priceToY(price) {
    if (!this.priceSeries) return null;
    return this.priceSeries.priceToCoordinate(price);
  }

  anchorToPixel(anchor) {
    if (!anchor || !this.priceSeries) return null;
    const logical = this.logicalFromTime(anchor.time);
    if (logical === null) return null;
    const x = this.logicalToX(logical);
    const y = this.priceSeries.priceToCoordinate(anchor.price);
    if (x === null || y === null) return null;
    return { x, y };
  }

  pointToPixel(point) {
    if (!point || !this.priceSeries) return null;
    const x = this.logicalToX(point.logical);
    const y = this.priceSeries.priceToCoordinate(point.price);
    if (x === null || y === null) return null;
    return { x, y };
  }

  /**
   * Seconds per bar, averaged across the cache rather than read from the
   * interval string -- the chart is not told which interval it is showing, and
   * an average is exact for a feed with no gaps, which crypto is.
   */
  secondsPerBar() {
    if (this.bars.length < 2) return 0;
    const first = this.bars[0];
    const last = this.bars[this.bars.length - 1];
    return (last.time - first.time) / (this.bars.length - 1);
  }

  measureStats(a, b) {
    const priceDelta = b.price - a.price;
    const bars = Math.round(Math.abs(b.logical - a.logical));
    return {
      priceDelta,
      percent: a.price ? (priceDelta / a.price) * 100 : 0,
      bars,
      seconds: bars * this.secondsPerBar(),
      rising: priceDelta >= 0,
    };
  }

  /** The cached bar under an x coordinate, via the time scale's logical index. */
  barAt(x) {
    const logical = this.chart.timeScale().coordinateToLogical(x);
    if (logical === null) return null;
    return this.bars[Math.max(0, Math.min(this.bars.length - 1, Math.round(logical)))] || null;
  }

  setTimezone(timezone) {
    const next = timezone || 'auto';
    if (next === this.timezone) return;
    this.timezone = next;
    this.formatters = timeFormatters(next);
    // The formatters are read through `this`, so the chart only needs nudging
    // to repaint its axis with them.
    this.chart.applyOptions({ timeScale: {} });
    this.chart.timeScale().applyOptions({});
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
    this.htf.setColors(this.colors);
    if (this.volumeSeries) {
      this.volumeSeries.setData(this.bars.map((b) => this.toVolumePoint(b)));
    }
  }

  /** Width of the plot area alone -- the pane, without the price scale. */
  plotWidth() {
    try {
      return this.chart.timeScale().width() || 0;
    } catch {
      return 0;
    }
  }

  /** Volume profile layer: 'off' | 'session4h' | 'visible' | 'day'. */
  setVolumeProfileMode(mode) {
    this.vp.setMode(mode);
  }

  setDayProfile(profile) {
    this.vp.setDayProfile(profile);
  }

  setPeriodProfiles(list) {
    this.vp.setPeriodProfiles(list);
  }

  /** Higher-timeframe candles, drawn by the chart itself beneath the series. */
  setHtf(bars, enabled) {
    this.htf.setBars(bars);
    this.htf.setEnabled(enabled);
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
    this.levels.clear();
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
