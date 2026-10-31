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
} from './vendor/lightweight-charts.mjs';
import { HtfPrimitive } from './htf-primitive.js';
import { VolumeProfilePrimitive } from './vp-primitive.js';
import { FootprintPrimitive } from './footprint-primitive.js';
import { VRangePrimitive } from './vrange-primitive.js';
import { RectPrimitive } from './rect-primitive.js';
import { TrendPrimitive } from './trend-primitive.js';
import { FibPrimitive } from './fib-primitive.js';
import { PeriodLevelsPrimitive } from './period-levels-primitive.js';
import { formatCompact } from './util.js';
import { MeasurePrimitive } from './measure-primitive.js';
import { ExtremesPrimitive } from './extremes-primitive.js';
import { TradePrimitive } from './trade/trade-primitive.js';
import { LivePricePrimitive } from './live-price-primitive.js';
import { VolumePane, SqueezeBandsPrimitive, OVERLAY_SHARE } from './volume-pane.js';
import { RsiPane, MacdPane } from './oscillator-pane.js';
import { FlowPrimitive } from './flow-primitive.js';
import { readPositions, readBar, mark } from './flow-read.js';
import { locale as uiLocale, isEnglish } from './i18n.js';

export const CHART_TYPES = ['candlestick', 'line', 'area'];

/** The view "Reset" returns to: the spacing and right-edge gap the chart starts with. */
const DEFAULT_BAR_SPACING = 6;
const DEFAULT_RIGHT_OFFSET = 3;
/** Candles a mini card shows. */
const MINI_BARS = 5;

/**
 * A widget may run for days: past MAX_BARS the oldest are dropped, down to
 * TRIM_TO -- but never the ones on screen, nor TRIM_MARGIN before them, or the
 * history prefetch would fetch them straight back on the next candle.
 */
const MAX_BARS = 1500;
const TRIM_TO = 1000;
const TRIM_MARGIN = 200;

/** Price-axis wheel zoom per notch: e^(100 * 0.0015) is about 16% a click. */
const PRICE_WHEEL_RATE = 0.0015;

/** Volume sub-pane sizing. Below ~30px the histogram is not readable at all. */
const VOLUME_PANE_RATIO = 0.24;
const MIN_VOLUME_PANE_PX = 30;
/** Open interest: the perp tint, so it reads as a perp-only layer. */
const OI_COLOR = '#f0b45a';

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
 * Dragging the price axis is on, as in TradingView: it stretches the price
 * scale and switches autoscale off, after which a drag on the chart pans in
 * both directions. It was off once, "so a level reads true against its scale",
 * which never held -- levels are anchored to prices, and every drawing is
 * re-projected on each repaint, so no rescale can put one in the wrong place.
 */
const HANDLE_SCALE_ON = {
  mouseWheel: true,
  pinch: true,
  axisPressedMouseMove: { time: true, price: true },
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
  // The interface's language, not the machine's: an English UI on a Chinese
  // Windows should not label the axis 10月25日.
  const locale = uiLocale();
  const make = (opts) => new Intl.DateTimeFormat(locale, { ...opts, ...zone });

  const hm = make({ hour: '2-digit', minute: '2-digit', hour12: false });
  const hms = make({ hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const dayOfMonth = make({ day: 'numeric' });
  const monthDay = make({ month: 'short', day: 'numeric' });
  const weekday = make({ weekday: 'short' });
  const month = make({ year: '2-digit', month: 'short' });
  const year = make({ year: 'numeric' });
  const en = isEnglish();
  // Each new day on the axis carries its weekday: "Sun 25" / "25日 週日".
  // The month is left to the month ticks (and the crosshair), which keeps
  // the label as short as the "Oct 25" it replaces.
  const dayTick = (date) =>
    en ? `${weekday.format(date)} ${dayOfMonth.format(date)}` : `${dayOfMonth.format(date)} ${weekday.format(date)}`;
  // "Sun, Oct 25, 15:25" / "10月25日 週日 15:25"
  const full = (date) =>
    en
      ? `${weekday.format(date)}, ${monthDay.format(date)}, ${hm.format(date)}`
      : `${monthDay.format(date)} ${weekday.format(date)} ${hm.format(date)}`;

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
          return dayTick(date);
        case 4: // TimeWithSeconds
          return hms.format(date);
        default: // Time
          return hm.format(date);
      }
    },
    /** Crosshair label: always the full stamp, there is only one of them. */
    crosshair: (time) => full(new Date(Number(time) * 1000)),
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
        rightOffset: DEFAULT_RIGHT_OFFSET,
        barSpacing: DEFAULT_BAR_SPACING,
        // Zoomed out as far as TradingView goes: under a pixel a bar, each
        // candle is little more than its high-low line, and a 700px card
        // holds some 7,000 of them -- weeks of 5m, the shape of the trend.
        minBarSpacing: 0.1,
        // Zoom holds the right edge, as TradingView does, rather than the bar
        // under the cursor: zoomed far out from the middle of the plot, the
        // latest candles were otherwise squeezed into the centre with half
        // the card empty to their right.
        rightBarStaysOnScroll: true,
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
        locale: uiLocale(),
        // No chart-wide priceFormatter: it overrides every series' own format,
        // which would print open interest as 94887.21 instead of 94.89K. The
        // price series formats itself at `this.precision` (priceSeriesOptions).
        timeFormatter: (time) => this.formatters.crosshair(time),
      },
    });

    this.crosshairMode = CrosshairMode.Normal;

    /** levelId -> { level, priceLine } */
    this.levels = new Map();
    this.activeLevelId = null;
    /** The user's drawings are hidden (not deleted); see setDrawingsHidden. */
    this.drawingsHidden = false;

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
    // The flow legend describes the bar under the crosshair.
    this.chart.subscribeCrosshairMove((param) => {
      const time = param && param.point && param.time != null ? Number(param.time) : null;
      if (time === this.flow.hoverTime) return;
      this.flow.hoverTime = time;
      if (this.flow.top !== null || this.flow.reads) this.flow.update();
    });

    this.onPointerLeave = () => this.setCrosshairMagnet(false);
    container.addEventListener('mouseleave', this.onPointerLeave);

    this.priceSeries = null;
    /** @type {VolumePane | null} */
    this.volume = null;
    /** Thin volume: threshold as a rank (null = off), filter memory in bars, bar length. */
    this.volumeOpts = { threshold: 0.05, memory: 1000, intervalSec: 60, color: 'split', overlay: false };
    this.oiSeries = null;
    this.showOI = false;
    /** Oscillator panes under the rest: RSI period (null = off), MACD on/off. */
    this.indicatorOpts = { rsi: null, macd: false };
    this.rsi = null;
    this.macd = null;
    /** OHLC records aligned to `bars`, from open-interest.js; the line plots close. */
    this.oiData = [];

    /*
     * Wheel over the price axis scales price. The library has one wheel handler
     * for the whole chart and it only ever zooms *time*, wherever the pointer
     * is -- price axis included. Intercepting in the capture phase on the
     * container, ahead of the library's own listener, and only when the pointer
     * is over the main pane's price axis, leaves every other wheel alone.
     */
    this.onWheel = (event) => this.handlePriceAxisWheel(event);
    container.addEventListener('wheel', this.onWheel, { capture: true, passive: false });

    /** Called whenever the viewport changes -- pan, zoom, resize, rescale. */
    this.viewportListeners = new Set();
    const watcher = {
      updateAllViews: () => {
        for (const cb of this.viewportListeners) cb();
      },
      paneViews: () => [],
    };
    this.viewportWatcher = watcher;

    this.htf = new HtfPrimitive(this);
    this.htf.setColors(this.colors);
    this.squeezeBands = new SqueezeBandsPrimitive(this);
    this.vp = new VolumeProfilePrimitive(this);
    /** Per-price taker sells and buys inside each candle; off until given a book. */
    this.footprint = new FootprintPrimitive(this);
    this.footprint.setColors(this.colors);
    this.footprintOn = false;
    this.vranges = new VRangePrimitive(this);
    this.rects = new RectPrimitive(this);
    this.trends = new TrendPrimitive(this);
    this.fibLayer = new FibPrimitive(this);
    this.measureLayer = new MeasurePrimitive(this);
    this.periodLevels = new PeriodLevelsPrimitive(this);
    /** The on-screen high and low, tagged with their prices. */
    this.extremes = new ExtremesPrimitive(this);
    // Big orders and the position read (flow-primitive.js, flow-read.js).
    this.flow = new FlowPrimitive(this);
    this.flowOpts = { read: false, sens: 3 };
    /** The median |ΔOI| the read is scaled by; kept for the live bar. */
    this.flowScale = 0;
    this.tradeLayer = new TradePrimitive(this);
    // Price alerts reuse the trade layer's line-and-axis-tag drawing.
    this.alertLayer = new TradePrimitive(this);
    // ...and volume alerts the same, on the volume's own scale (VolumePane
    // attaches it to its bars).
    this.volumeAlertLayer = new TradePrimitive(this, {
      toY: (value) => (this.volume ? this.volume.total.priceToCoordinate(value) : null),
      format: (value) => formatCompact(value),
    });
    this.livePrice = new LivePricePrimitive(this);

    this.createPriceSeries();
    this.syncSubPanes();

    // autoSize handles the common case; this catches pane height ratios, which
    // are expressed in pixels and so must be recomputed per resize.
    this.resizeObserver = new ResizeObserver(() => {
      this.layoutPanes();
      // The window changes size after the form does: fit again, or -- back
      // to the full card -- reset again, as the library rescales the zoom with
      // the width and would blow the mini's few bars up across the full card.
      if (this.compact) this.fitMini();
      else if (Date.now() < this.resetOnResizeUntil) this.resetView();
    });
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
        // The live price layer draws these, for the newest bar (live-price-primitive.js).
        lastValueVisible: false,
        priceLineVisible: false,
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
        // The live price layer draws these, for the newest bar (live-price-primitive.js).
        lastValueVisible: false,
        priceLineVisible: false,
        priceLineColor: withAlpha(up, 0.5),
        priceLineWidth: 1,
        priceLineStyle: 2,
        crosshairMarkerRadius: 3,
      };
    }

    // Hollow while the footprint is on: its rows live where the body would be.
    const hollow = this.footprintOn ? 'rgba(0, 0, 0, 0)' : null;
    return {
      upColor: hollow || up,
      downColor: hollow || down,
      borderUpColor: up,
      borderDownColor: down,
      wickUpColor: withAlpha(up, 0.8),
      wickDownColor: withAlpha(down, 0.8),
      borderVisible: true,
      priceFormat,
      // The live price layer draws these, for the newest bar (live-price-primitive.js).
      lastValueVisible: false,
      priceLineVisible: false,
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
    this.priceSeries.attachPrimitive(this.squeezeBands);
    this.priceSeries.attachPrimitive(this.htf);
    this.priceSeries.attachPrimitive(this.vp);
    this.priceSeries.attachPrimitive(this.footprint);
    this.priceSeries.attachPrimitive(this.vranges);
    this.priceSeries.attachPrimitive(this.rects);
    this.priceSeries.attachPrimitive(this.trends);
    this.priceSeries.attachPrimitive(this.fibLayer);
    this.priceSeries.attachPrimitive(this.measureLayer);
    this.priceSeries.attachPrimitive(this.periodLevels);
    this.priceSeries.attachPrimitive(this.extremes);
    this.priceSeries.attachPrimitive(this.flow);
    this.priceSeries.attachPrimitive(this.tradeLayer);
    this.priceSeries.attachPrimitive(this.alertLayer);
    this.priceSeries.attachPrimitive(this.livePrice);
    this.priceSeries.attachPrimitive(this.viewportWatcher);
  }

  /**
   * Rebuild the sub-panes -- volume, then open interest -- in that order.
   *
   * Panes are addressed by index and the library drops a pane the moment its
   * last series goes, shifting the rest up. Toggling volume off with OI on
   * leaves OI at index 1, and toggling volume back on at index 1 would then
   * put the histogram *inside* the OI pane. Rebuilding both from scratch on
   * any change keeps the order fixed; both are re-fed from data we hold.
   */
  syncSubPanes() {
    this.clearSubPanes();

    // A mini card has room for the candles only; the choices come back with it.
    const showVolume = this.showVolume && !this.compact;
    const showOI = this.showOI && !this.compact;
    let pane = 1;
    const overlay = showVolume && this.volumeOpts.overlay;
    // Overlaid volume takes the bottom of the price pane: lift the candles
    // off most of it, as TradingView does, leaving a little overlap.
    this.chart.priceScale('right').applyOptions({
      scaleMargins: { top: 0.14, bottom: overlay ? OVERLAY_SHARE * 0.9 : 0.12 },
    });
    if (showVolume) {
      this.volume = new VolumePane(this, overlay ? 0 : pane++, this.volumeOpts);
      this.volume.render();
    }
    if (showOI) {
      this.oiSeries = this.chart.addSeries(
        LineSeries,
        {
          color: OI_COLOR,
          lineWidth: 1.5,
          title: 'OI',
          priceFormat: { type: 'custom', formatter: (v) => formatCompact(v), minMove: 0.001 },
          lastValueVisible: true,
          priceLineVisible: false,
          crosshairMarkerRadius: 2,
        },
        pane++
      );
      this.oiSeries.priceScale().applyOptions({
        scaleMargins: { top: 0.2, bottom: 0.1 },
        borderVisible: false,
      });
      this.oiSeries.setData(this.oiSeriesData());
    }
    if (!this.compact && this.indicatorOpts.rsi) {
      this.rsi = new RsiPane(this, pane++, this.indicatorOpts.rsi);
      this.rsi.render();
    }
    if (!this.compact && this.indicatorOpts.macd) {
      this.macd = new MacdPane(this, pane++);
      this.macd.render();
    }
    this.layoutPanes();
  }

  /** Every sub-pane's series gone (and so the panes), the price pane left alone. */
  clearSubPanes() {
    if (this.volume) this.volume.destroy();
    if (this.oiSeries) this.chart.removeSeries(this.oiSeries);
    if (this.rsi) this.rsi.destroy();
    if (this.macd) this.macd.destroy();
    this.volume = null;
    this.oiSeries = null;
    this.rsi = null;
    this.macd = null;
  }

  /** RSI period or null, MACD true/false. */
  setIndicators(opts) {
    const next = { ...this.indicatorOpts, ...opts };
    if (next.rsi === this.indicatorOpts.rsi && next.macd === this.indicatorOpts.macd) return;
    this.indicatorOpts = next;
    this.syncSubPanes();
  }

  /**
   * Pane heights, recomputed whenever we resize or the sub-panes change.
   *
   * Set as stretch factors -- relative sizes -- in pixels of the target
   * split, rather than with `setHeight()`. That one is not a plain setter: it
   * derives the new split from the panes' *current* heights, so on a pane not
   * laid out yet it silently did nothing (the "toggle volume on, nothing looks
   * right until I drag the corner" failure, once patched with a retry), and
   * with several sub-panes each call undid part of the last: RSI and MACD
   * together came out 34px and 109px instead of 91px each. Stretch factors
   * are plain proportions, independent of what the layout currently is.
   */
  layoutPanes() {
    const panes = this.chart.panes();
    if (panes.length < 2) return;
    const total = this.container.clientHeight || 200;
    // Several sub-panes share a little more than one would get, and never
    // more than half the card between them: the candles keep the majority.
    const subs = panes.length - 1;
    const ratio = subs === 1 ? VOLUME_PANE_RATIO : Math.min(VOLUME_PANE_RATIO * 0.75, 0.5 / subs);
    const subHeight = Math.max(MIN_VOLUME_PANE_PX, Math.round(total * ratio));

    try {
      panes[0].setStretchFactor(Math.max(subHeight, total - subs * subHeight));
      for (let i = 1; i < panes.length; i++) panes[i].setStretchFactor(subHeight);
    } catch (err) {
      // A pane really can vanish mid-resize during teardown. Anything else is
      // worth seeing.
      if (this.chart) console.warn('[chart] sub-pane layout failed', err);
    }
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
    if (this.compact) this.fitMini();
    else this.chart.timeScale().scrollToRealTime();
  }

  /** Merge one live bar into the cache and push it to the renderer. */
  update(bar) {
    if (!bar || !Number.isFinite(bar.time)) return;

    const last = this.bars[this.bars.length - 1];
    const isNew = !last || bar.time > last.time;
    if (isNew) {
      this.bars.push(bar);
      if (this.bars.length > MAX_BARS && this.trimBars()) return;
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
    if (this.volume) this.volume.update(bar, isNew);
    // From the state carried over the closed bars: a few multiplications.
    if (this.rsi) this.rsi.update(bar, isNew);
    if (this.macd) this.macd.update(bar, isNew);
    this.rereadLastFlow();
  }

  /**
   * Drop the oldest bars from the cache *and* the series, together.
   *
   * Trimming the cache alone left the series 500 bars longer than it: every
   * time -> logical lookup (logicalFromTime) then came out 500 bars short, so
   * the higher-timeframe boxes, profiles and drawings all jumped 500 bars to
   * the left -- off screen -- the moment a new candle opened. Like
   * prependBars, the series is re-fed and the viewport shifted to match.
   *
   * @returns {boolean} whether it trimmed (and so already drew the new bar)
   */
  trimBars() {
    const scale = this.chart.timeScale();
    const range = scale.getVisibleLogicalRange();
    let drop = this.bars.length - TRIM_TO;
    if (range) drop = Math.min(drop, Math.floor(range.from) - TRIM_MARGIN);
    if (drop <= 0) return false;

    this.bars.splice(0, drop);
    this.render();
    if (range && !this.paused) {
      try {
        scale.setVisibleLogicalRange({ from: range.from - drop, to: range.to - drop });
      } catch {
        /* range rejected mid-teardown */
      }
    }
    return true;
  }

  render() {
    if (this.paused) {
      this.dirtyWhilePaused = true;
      return;
    }
    this.priceSeries.setData(this.bars.map((b) => this.toPricePoint(b)));
    if (this.volume) this.volume.render();
    if (this.oiSeries) {
      this.oiSeries.setData(this.oiSeriesData());
    }
    if (this.rsi) this.rsi.render();
    if (this.macd) this.macd.render();
    this.rereadFlow();
  }

  /* ---------------------------------------------------------- order flow */

  /**
   * Big orders: `top` the rank to show up to (0.001 = top 0.1%) or null;
   * position read: `read` on or off, `sens` the multiple of the median |ΔOI|
   * a bar needs to be marked.
   */
  setFlowOptions({ top, read, sens } = {}) {
    if (top !== undefined && top !== this.flow.top) {
      this.flow.top = top;
      this.flow.cutoff = NaN; // until the cutoffs held say what this rank is
    }
    if (read !== undefined) this.flowOpts.read = read === true;
    if (sens !== undefined) this.flowOpts.sens = Number(sens) || 3;
    this.rereadFlow();
  }

  /** Every kept order from the hub, sorted by time, and the size each rank is now. */
  setSweeps(sweeps, cutoffs) {
    this.flow.sweeps = Array.isArray(sweeps) ? sweeps : [];
    this.setSweepCutoffs(cutoffs);
    this.flow.update();
  }

  addSweep(sweep, cutoffs) {
    const list = this.flow.sweeps;
    if (!sweep) return;
    const last = list[list.length - 1];
    if (!last || sweep.t > last.t) list.push(sweep);
    else if (!list.some((s) => s.t === sweep.t)) {
      list.push(sweep);
      list.sort((a, b) => a.t - b.t);
    }
    this.setSweepCutoffs(cutoffs);
    this.flow.update();
  }

  setSweepCutoffs(cutoffs) {
    if (cutoffs && this.flow.top !== null && cutoffs[this.flow.top] > 0) this.flow.cutoff = cutoffs[this.flow.top];
    if (cutoffs) this.sweepCutoffs = cutoffs;
  }

  /** Read every bar again: new bars, new OI, or new settings. */
  rereadFlow() {
    if (this.sweepCutoffs) this.setSweepCutoffs(this.sweepCutoffs);
    if (!this.flowOpts.read || !this.oiData.length) {
      this.flow.reads = this.flowOpts.read ? new Map() : null;
      this.flow.update();
      return;
    }
    const oiByTime = new Map(this.oiData.map((r) => [r.time, r]));
    const { reads, scale } = readPositions(this.bars, oiByTime, this.flowOpts.sens);
    this.flow.reads = reads;
    this.flowScale = scale;
    this.flow.update();
  }

  /** Only the forming bar moved: read it alone, against the scale already found. */
  rereadLastFlow() {
    const reads = this.flow.reads;
    if (!reads) return;
    const bar = this.bars[this.bars.length - 1];
    const oi = this.oiData[this.oiData.length - 1];
    if (!bar || !oi || oi.time !== bar.time) return;
    const r = readBar(bar, oi);
    if (!r) return;
    reads.set(bar.time, mark(r, this.flowScale, this.flowOpts.sens));
    this.flow.update();
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

    // Sub-panes first. The library drops a pane as soon as its last series
    // goes, so removing the price series while volume / OI still stood below
    // shifted them up into pane 0 -- and the new price series then landed in
    // the OI pane, on OI's scale: a price of 2,670 against an axis running to
    // 2.3M, flat along the bottom. Clear them, swap the price series in the
    // (now empty) top pane, and rebuild them underneath from the data held.
    this.clearSubPanes();
    this.chart.removeSeries(this.priceSeries);
    this.levels.clear();
    this.createPriceSeries();
    this.render();
    this.syncSubPanes();
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

  /** `color` is the level's own (#rrggbb) or null for the default blue. */
  levelOptions(id, color = null) {
    const active = id === this.activeLevelId;
    // A coloured level keeps its colour while dragged and thickens instead.
    const shown = color || (active ? LEVEL_COLOR_ACTIVE : LEVEL_COLOR);
    return {
      price: 0,
      color: shown,
      lineWidth: active && color ? 2 : 1,
      lineStyle: 2, // LineStyle.Dashed -- distinguishes a drawn level from the series
      lineVisible: !this.drawingsHidden,
      axisLabelVisible: !this.drawingsHidden,
      axisLabelColor: shown,
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
        existing.priceLine.applyOptions({ ...this.levelOptions(level.id, level.color), price: level.price });
        next.set(level.id, existing);
        this.levels.delete(level.id);
      } else {
        const priceLine = this.priceSeries.createPriceLine({
          ...this.levelOptions(level.id, level.color),
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
          ...this.levelOptions(key, entry.level.color),
          price: entry.priceLine.options().price,
        });
      }
    }
  }

  /**
   * Hide or show everything the user drew -- levels, trend lines, Fibonacci,
   * rectangles and range profiles -- without touching the stores. Hidden
   * drawings are not grabbable either, so a drag cannot move a line the user
   * cannot see.
   */
  setDrawingsHidden(hidden) {
    this.drawingsHidden = !!hidden;
    for (const [id, entry] of this.levels) {
      entry.priceLine.applyOptions({ ...this.levelOptions(id, entry.level.color), price: entry.priceLine.options().price });
    }
    this.rects.setHidden(hidden);
    this.trends.setHidden(hidden);
    this.fibLayer.setHidden(hidden);
    this.vranges.setHidden(hidden);
  }

  /** @returns {string|null} id of the level within grab distance of `y`. */
  levelAt(y) {
    if (!this.priceSeries || this.drawingsHidden) return null;
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

  /**
   * Thin-volume settings: `threshold` a rank (0.05 = 5%) or null for none,
   * `memory` the filter's memory in bars, `intervalSec` the bar length; and
   * how it looks: `color` 'split' | 'candle', `overlay` on the price pane.
   */
  setVolumeOptions(opts) {
    const next = { ...this.volumeOpts, ...opts };
    if (JSON.stringify(next) === JSON.stringify(this.volumeOpts)) return;
    const moved = next.overlay !== this.volumeOpts.overlay;
    this.volumeOpts = next;
    // Another pane, another scale: rebuild rather than restyle.
    if (moved) this.syncSubPanes();
    else if (this.volume) this.volume.setOptions(next);
  }

  setVolumeVisible(visible) {
    const next = visible === true;
    if (next === this.showVolume) return;
    this.showVolume = next;
    this.syncSubPanes();
  }

  /* ------------------------------------------------------ open interest */

  setOIVisible(visible) {
    const next = visible === true;
    if (next === this.showOI) return;
    this.showOI = next;
    this.syncSubPanes();
  }

  /** Replace the whole OI series: records {time, open, high, low, close}. */
  setOIData(records) {
    this.oiData = Array.isArray(records) ? records : [];
    this.rereadFlow();
    if (!this.oiSeries) return;
    if (this.paused) {
      this.dirtyWhilePaused = true;
      return;
    }
    this.oiSeries.setData(this.oiSeriesData());
  }

  /**
   * The OI records as line points, with a whitespace point on every bar in
   * between that has none. A line series joins whatever points it is given,
   * so a stretch with no measurement drew as a flat line -- reading as "OI
   * did not move" when the truth was "nobody measured it".
   */
  oiSeriesData() {
    const records = this.oiData;
    if (!records.length) return [];
    const byTime = new Map(records.map((r) => [r.time, r.close]));
    const first = records[0].time;
    const last = records[records.length - 1].time;
    const out = [];
    for (const bar of this.bars) {
      if (bar.time < first) continue;
      if (bar.time > last) break;
      const value = byTime.get(bar.time);
      out.push(value === undefined ? { time: bar.time } : { time: bar.time, value });
    }
    return out;
  }

  /** The live bar's OI moved. Same rules as update(): same bar replaces, newer appends. */
  updateOI(record) {
    if (!record) return;
    const last = this.oiData[this.oiData.length - 1];
    if (!last || record.time > last.time) this.oiData.push(record);
    else if (record.time === last.time) this.oiData[this.oiData.length - 1] = record;
    else return;
    this.rereadLastFlow();
    if (!this.oiSeries) return;
    if (this.paused) {
      this.dirtyWhilePaused = true;
      return;
    }
    this.oiSeries.update({ time: record.time, value: record.close });
  }

  /**
   * Footprint on (a FootprintBook) or off (null). `ratio` is the diagonal
   * imbalance multiple.
   */
  setFootprint(book, ratio = 3) {
    const on = !!book;
    this.footprint.setRatio(ratio);
    this.footprint.setBook(book);
    if (on === this.footprintOn) return;
    this.footprintOn = on;
    this.priceSeries.applyOptions(this.priceSeriesOptions());
  }

  /** The book has new minutes: repaint. */
  footprintChanged() {
    this.footprint.update();
  }

  /**
   * Zoom so the newest `count` bars fill the plot, right edge at the newest:
   * where the footprint has room for its rows.
   */
  focusRecent(count) {
    const width = this.plotWidth();
    if (!width || !this.bars.length) return;
    const ts = this.chart.timeScale();
    const spacing = Math.max(4, Math.min(160, width / (count + DEFAULT_RIGHT_OFFSET)));
    ts.applyOptions({ barSpacing: spacing, rightOffset: DEFAULT_RIGHT_OFFSET });
    ts.scrollToRealTime();
  }

  setUpDownColor(mode) {
    const next = mode === 'redUp' ? 'redUp' : 'greenUp';
    if (next === this.upDownColor) return;
    this.upDownColor = next;
    this.priceSeries.applyOptions(this.priceSeriesOptions());
    this.htf.setColors(this.colors);
    this.footprint.setColors(this.colors);
    if (this.volume) this.volume.render();
    if (this.macd) this.macd.render();
  }

  /**
   * Where the volume bars are, in chart pixels: the bottom of the price pane
   * when overlaid (the candles are lifted off it), else their own pane.
   * `origin` is the top of the pane they are drawn in, for converting to their
   * scale. Null with volume off.
   */
  volumeZone() {
    if (!this.volume) return null;
    try {
      const panes = this.chart.panes();
      if (this.volumeOpts.overlay) {
        const height = panes[0].getHeight();
        return { top: Math.round(height * (1 - OVERLAY_SHARE)), bottom: height, origin: 0 };
      }
      const pane = panes[1];
      const node = pane.getHTMLElement();
      const origin = node
        ? node.getBoundingClientRect().top - this.container.getBoundingClientRect().top
        : panes[0].getHeight() + 1;
      return { top: origin, bottom: origin + pane.getHeight(), origin };
    } catch {
      return null;
    }
  }

  /** The volume level under a point on the volume bars, or null anywhere else. */
  volumeAt(x, y) {
    const zone = this.volumeZone();
    if (!zone || x < 0 || x >= this.plotWidth() || y < zone.top || y >= zone.bottom) return null;
    const value = this.volume.total.coordinateToPrice(y - zone.origin);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  /**
   * Is a point in the main plot -- not on an axis, not in the volume pane?
   *
   * Drawing gestures must stay out of the axes. The level gestures went by y
   * alone, so double-clicking the price axis to reset its scale also dropped a
   * level at that price, and pressing on the axis at a level's height grabbed
   * the level instead of stretching the scale.
   */
  inPlot(x, y) {
    const width = this.plotWidth();
    let height = 0;
    try {
      height = this.chart.panes()[0].getHeight();
    } catch {
      return false;
    }
    return x >= 0 && x < width && y >= 0 && y < height;
  }

  handlePriceAxisWheel(event) {
    if (!event.deltaY || !this.priceSeries) return;
    const rect = this.container.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const width = this.plotWidth();
    let height = 0;
    try {
      height = this.chart.panes()[0].getHeight();
    } catch {
      return;
    }
    // Only the main pane's price axis. The time axis and the plot keep the
    // library's time zoom; the volume pane's scale is left to autoscale.
    if (!width || x < width || y < 0 || y > height) return;

    event.preventDefault();
    event.stopPropagation();

    const scale = this.priceSeries.priceScale();
    const range = scale.getVisibleRange();
    const anchor = this.priceSeries.coordinateToPrice(y);
    if (!range || anchor === null) return;
    // Wheel down widens the range (zoom out), up narrows it. Anchored on the
    // price under the pointer, so that price stays put while the rest moves.
    const delta = Math.sign(event.deltaY) * Math.min(Math.abs(event.deltaY), 300);
    const factor = Math.exp(delta * PRICE_WHEEL_RATE);
    const from = anchor - (anchor - range.from) * factor;
    const to = anchor + (range.to - anchor) * factor;
    if (!(to > from)) return;
    // Setting a range switches autoscale off, which is also what lets a plain
    // drag on the chart pan vertically from here on.
    scale.setVisibleRange({ from, to });
  }

  /** Has the user moved off the default view in a way worth a reset button? */
  isViewModified() {
    if (!this.priceSeries) return false;
    if (!this.priceSeries.priceScale().options().autoScale) return true;
    const ts = this.chart.timeScale();
    const spacing = ts.options().barSpacing;
    const width = ts.width();
    if (!width) return false;
    // lockVisibleTimeRangeOnResize scales the spacing with the width, so "not
    // the default spacing" is not the same as "zoomed" -- a card opened narrow
    // and then widened has never been touched. Follow resizes the same way the
    // library does and compare against that.
    const base = this.zoomBaseline;
    if (!base) {
      this.zoomBaseline = { spacing, width };
    } else if (base.width !== width) {
      base.spacing *= width / base.width;
      base.width = width;
    }
    if (Math.abs(spacing - this.zoomBaseline.spacing) > 0.25) return true;
    // Scrolled back into history by more than a couple of bars.
    return ts.scrollPosition() < DEFAULT_RIGHT_OFFSET - 2;
  }

  /**
   * The mini card: the newest few candles and the price axis -- no time axis,
   * no volume or OI panes.
   */
  setCompact(on) {
    const next = on === true;
    if (next === !!this.compact) return;
    this.compact = next;
    this.chart.timeScale().applyOptions({ visible: !next });
    this.syncSubPanes();
    if (next) {
      this.fitMini();
    } else {
      this.resetView();
      this.resetOnResizeUntil = Date.now() + 1000;
    }
  }

  fitMini() {
    const width = this.plotWidth();
    if (!width) return;
    const ts = this.chart.timeScale();
    ts.applyOptions({ barSpacing: width / (MINI_BARS + 1), rightOffset: 0.6 });
    ts.scrollToPosition(0.6, false);
    this.priceSeries.priceScale().setAutoScale(true);
  }

  /** Back to the view the chart opened with: autoscale, default zoom, live edge. */
  resetView() {
    if (!this.priceSeries) return;
    this.priceSeries.priceScale().setAutoScale(true);
    if (this.volume) this.volume.total.priceScale().setAutoScale(true);
    const ts = this.chart.timeScale();
    ts.applyOptions({ barSpacing: DEFAULT_BAR_SPACING, rightOffset: DEFAULT_RIGHT_OFFSET });
    // A jump, not scrollToRealTime(): that animates for 400ms from wherever
    // the view is, and from far back the history page that scrolling back
    // requested lands mid-animation -- prependBars re-pins the visible range
    // and cuts it short, so one press only got part of the way home.
    ts.scrollToPosition(DEFAULT_RIGHT_OFFSET, false);
    this.zoomBaseline = { spacing: DEFAULT_BAR_SPACING, width: ts.width() };
  }

  onViewportChange(cb) {
    this.viewportListeners.add(cb);
    return () => this.viewportListeners.delete(cb);
  }

  timeScaleHeight() {
    try {
      return this.chart.timeScale().height();
    } catch {
      return 0;
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

  /** Today's 1m bars as a ProfileSource; rows follow the on-screen height. */
  setDaySource(source) {
    this.vp.setDaySource(source);
  }

  /** Row height for every profile on the card: 'coarse' | 'normal' | 'fine' | 'ultra'. */
  setVolumeProfileDetail(detail) {
    this.vp.setDetail(detail);
    this.vranges.setDetail(detail);
  }

  setPeriodProfiles(list) {
    this.vp.setPeriodProfiles(list);
  }

  /** Opens and highs/lows of the day, week and month, from sessions.js. */
  setPeriodLevels(levels) {
    this.periodLevels.setLevels(levels);
  }

  /** Higher-timeframe candles, drawn by the chart itself beneath the series. */
  setHtf(bars, enabled, seconds = 4 * 3600) {
    this.htf.setPeriod(seconds);
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
    this.container.removeEventListener('wheel', this.onWheel, { capture: true });
    this.viewportListeners.clear();
    this.levels.clear();
    this.resizeObserver.disconnect();
    this.container.removeEventListener('mouseleave', this.onPointerLeave);
    try {
      this.chart.remove();
    } catch {
      /* already gone */
    }
    this.chart = null;
    this.priceSeries = null;
    this.volume = null;
    this.oiSeries = null;
    this.rsi = null;
    this.macd = null;
    this.bars = [];
    this.oiData = [];
  }
}
