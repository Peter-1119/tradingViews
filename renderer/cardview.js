/**
 * CardView — one chart card, rendered identically in Float and Board mode.
 *
 * Both modes share this component so that switching between them is purely a
 * window-management concern: card behaviour, settings and data wiring have a
 * single implementation, which is what keeps settings intact across a mode
 * switch (spec 4.1).
 */

import { CardChart } from './chart.js';
import { t } from './i18n.js';
import { SettingsPanel } from './ui/settings-panel.js';
import { TradeController } from './trade/trade-controller.js';
import { PriceAlertController } from './price-alerts.js';
import { Toolbar } from './ui/toolbar.js';
import { WatchlistMenu, WATCHLIST_MAX, sameEntry, entryLabel, watchIndex } from './ui/watchlist.js';
import { DRAWING_COLORS } from './drawing-colors.js';
import { FootprintBook } from './footprint.js';
import { buildPeriodProfiles, sessionBounds, PERIOD_4H, ProfileSource, rangeInterval } from './volume-profile.js';
import { intervalToMs } from './datafeed/provider.js';
import { oiPoints, bucketOI, historyRecords, onHistoryGrid, OI_MAX_GAP_SEC, OI_HISTORY_STEP_SEC } from './open-interest.js';
import { WINDOWS as POSITION_WINDOWS } from './position.js';
import { periodStart, periodLevels, updateCurrentExtremes, barsIntervalFor } from './sessions.js';
import {
  el,
  formatPrice,
  formatPercent,
  prettySymbol,
  STATUS_BADGES,
  STATUS_LABELS,
  INTERVAL_LABELS,
  MARKET_LABELS,
  formatFundingRate,
  formatCountdown,
} from './util.js';

// 1000: enough closed bars to seed the thin-volume distribution (volume-stats.js).
const HISTORY_LIMIT = 1000;
/** Rail tools that add a drawing; arming one shows hidden drawings again. */
const DRAWING_TOOLS = ['level', 'trend', 'fib', 'rect', 'vrange'];

/** How far back Ctrl+Z reaches. Plenty for "I just grabbed the wrong line". */
const UNDO_DEPTH = 50;

/**
 * The card the user last pressed a mouse button on. Board mode puts several
 * CardViews in one window, and they all hear the same keydown -- only the one
 * the user was actually working in should undo.
 */
let lastActive = null;
/** How many more bars to pull per backfill, and how near the edge triggers one. */
const HISTORY_PAGE = 500;
const HISTORY_PREFETCH_BARS = 20;

/**
 * Higher-timeframe overlay. 4h is the one worth a fixed slot: long enough to
 * frame a session on a 1m chart, short enough that ten of them still mean
 * something. Only drawn under 4h -- on a 4h chart the box is the candle.
 */
const HTF_COUNT = 10;
/** Card intervals a 4h block is more than one candle on (the 4H-session profile). */
const BELOW_4H = ['1m', '5m', '15m', '1h'];

const MARKET_IDS = Object.keys(MARKET_LABELS);
const otherMarket = (market) => (market === 'perp' ? 'spot' : 'perp');

/** How long "no perpetual for this symbol" and the like stay on screen. */
const NOTICE_MS = 2200;

/** Binance keeps OI history this long; the margin keeps a request inside it. */
const OI_HISTORY_SEC = 30 * 24 * 3600 - 120;
/** Our own per-minute OI is only worth reading this far back; beyond, 5m is plenty. */
const OI_MINUTES_SEC = 3 * 24 * 3600;
/** Live samples kept in memory, so a reload does not lose the current minute. */
const OI_LIVE_KEEP_SEC = 2 * 3600;
/** Head, tail and holes fetched per load; the rest wait for the next one. */
const OI_MAX_FETCH_RANGES = 8;
/**
 * Binance revises its OI history after the fact. On 2026-10-15, roughly
 * 10:55-18:00 UTC, it served wrong samples for every symbol -- XRP 36% low,
 * then back -- and later corrected them; but a cached sample is never asked
 * for again, so ours kept the wrong ones and drew a 10-60% cliff. So the
 * whole 30 days is checked against the exchange once a session per symbol
 * (recheckOIHistory), and the last day fetched again now and then and written
 * over what is cached, for corrections that land while the app runs.
 */
const OI_RECHECK_SEC = 24 * 3600;
const OI_RECHECK_EVERY_MS = 30 * 60 * 1000;
/**
 * A recheck replaces the cached span only when the exchange answered with at
 * least this share of the samples the span should hold -- a short answer is
 * more likely a hiccup than a better history, and must not wipe the cache.
 */
const OI_RECHECK_MIN_SHARE = 0.9;

/**
 * Footprint: the newest this-many bars, and never further back than the
 * cap -- it is minute data at full price resolution, kept in memory twice
 * (hub and card), and short-term entries are what it is for.
 */
const FOOTPRINT_BARS = 30;
const FOOTPRINT_MAX_SEC = 6 * 3600;
/** Below this bar spacing the rows have no room; turning it on zooms in. */
const FOOTPRINT_MIN_SPACING = 8;

export class CardView {
  /**
   * @param {{
   *   card: object,
   *   feedFor: (market: string) => object,   // the DataProvider for a market
   *   prefs: object,
   *   intervals: string[],
   *   chartTypes: string[],
   *   windowControls?: boolean,   // pin / window-opacity / drag chrome (Float only)
   *   onPatch: (patch: object) => void,
   *   onRemove: () => void,
   * }} options
   */
  constructor({
    card,
    feedFor,
    prefs,
    intervals,
    chartTypes,
    windowControls = false,
    onPatch,
    onRemove,
  }) {
    this.card = card;
    this.feedFor = feedFor;
    this.prefs = prefs;
    this.windowControls = windowControls;
    this.onPatch = onPatch;
    this.onRemove = onRemove;

    this.loadSeq = 0;
    this.destroyed = false;
    this.lastBar = null;
    this.ticker = null;
    this.funding = null;
    /** Open interest points {t, v} behind the OI pane, and this session's live ones. */
    this.oiPoints = [];
    this.oiLive = [];
    /** Cache holes already asked of the exchange this session; see backfillOIHistory. */
    this.oiHolesTried = new Set();
    /** symbol -> when its recent OI history was last fetched again. */
    this.oiRecheckedAt = new Map();
    /** Symbols whose whole cached history was checked against the exchange this session. */
    this.oiRechecked = new Set();
    this.oiSeq = 0;
    /** Footprint minutes from the hub, merged into bars on draw. */
    this.fpBook = new FootprintBook();
    this.fpSeq = 0;
    /** {key, promise} -- the other market's name for this symbol, being looked up. */
    this.counterpartJob = null;
    this.status = this.feed.getStatus();

    this.buildDom(intervals, chartTypes);
  }

  /**
   * The provider for the market this card is on right now. A getter, not a
   * field: the market is part of the card record and changes under us.
   */
  get feed() {
    return this.feedFor(this.card.market);
  }

  /** What the loaded data belongs to. Async work compares it before landing. */
  dataKey() {
    return `${this.card.market}:${this.card.symbol}`;
  }

  /* ----------------------------------------------------------------- DOM */

  buildDom(intervals, chartTypes) {
    // The symbol name opens the watchlist; the star beside it adds or removes
    // the current symbol. Both sit in the drag region, so both are no-drag.
    this.symbolText = el('span', { text: prettySymbol(this.card.symbol) });
    this.symbolEl = el(
      'button.card__symbol',
      {
        type: 'button',
        title: t('常用幣種 (Alt+1~9、0 快速切換)'),
        onclick: () => this.watchlist.toggle(),
      },
      this.symbolText,
      el('span.card__symbol-caret', { text: '▾' })
    );
    this.starBtn = el('button.sc-icon-btn.card__star', {
      type: 'button',
      onclick: () => this.toggleWatch(),
    });
    this.watchlist = new WatchlistMenu({
      feedFor: this.feedFor,
      onPick: (entry) => this.switchTo(entry),
      onRemove: (entry) => this.setWatchlist(this.watchlistEntries().filter((e) => !sameEntry(e, entry))),
      onAdd: () => this.toggleWatch(),
      onToggleAlert: (entry) =>
        this.setWatchlist(this.watchlistEntries().map((e) => (sameEntry(e, entry) ? { ...e, alert: entry.alert } : e))),
      onSearch: () => this.panel.open(),
    });
    this.watchlist.setAnchor(this.symbolEl);
    // One click flips between spot and the perpetual of the same coin. The
    // chip names the market the card is on, not the one it would switch to --
    // it doubles as the only label saying which one this is.
    this.marketBtn = el('button.card__market', {
      type: 'button',
      onclick: () => this.setMarket(otherMarket(this.card.market)),
    });
    this.intervalEl = el('span.card__interval', {
      text: INTERVAL_LABELS[this.card.interval] || this.card.interval,
    });
    this.priceEl = el('span.card__price', { text: '—' });
    this.changeEl = el('span.card__change', { text: '—' });

    this.pinBtn = el('button.sc-icon-btn', {
      type: 'button',
      title: t('切換置頂'),
      text: '📌',
      onclick: () => this.onPatch({ alwaysOnTop: !this.card.alwaysOnTop }),
    });

    this.gearBtn = el('button.sc-icon-btn', {
      type: 'button',
      title: t('設定'),
      text: '⚙',
      onclick: () => this.panel.toggle(),
    });

    this.lockBtn = el('button.sc-icon-btn', {
      type: 'button',
      title: t('滑鼠穿透(可用 Ctrl+Alt+C 解除)'),
      text: '🖱',
      onclick: () => window.stockcard.toggleClickThrough(),
    });

    this.closeBtn = el('button.sc-icon-btn.sc-icon-btn--danger', {
      type: 'button',
      title: t('關閉這張卡片'),
      text: '✕',
      onclick: () => this.onRemove(),
    });

    this.tools = el(
      'div.card__tools',
      {},
      this.windowControls ? this.pinBtn : null,
      this.gearBtn,
      this.lockBtn,
      this.closeBtn
    );

    // Sits *in* the bar rather than over it, and outside the hover-fade group:
    // a dropped feed is the one thing the card must be able to say unprompted.
    this.link = el('span.card__link', { hidden: true });

    // The bar keeps its box at all times so the Float drag region never moves;
    // only its contents fade in on hover (spec 4.3, "hover 才浮現").
    this.bar = el(
      'div.card__bar',
      { class: this.windowControls ? 'is-draggable' : '' },
      this.link,
      el('div.card__id', {}, this.starBtn, this.symbolEl, this.marketBtn, this.intervalEl),
      el('div.card__quote', {}, this.priceEl, this.changeEl),
      this.tools
    );

    this.dot = el('span.card__dot', { title: STATUS_LABELS[this.status] || '' });

    this.chartEl = el('div.card__chart');

    this.fibs = [];
    this.rects = [];
    this.trends = [];
    /** Range volume profiles of this symbol, and their bars by range id. */
    this.vranges = [];
    this.vrangeData = new Map();

    this.htfBars = [];

    /** blockStart -> per-4h profile, for the current symbol. Closed blocks never change. */
    this.periodCache = new Map();

    this.activeTool = 'cursor';
    this.toolbar = new Toolbar({
      active: this.activeTool,
      onSelect: (id, value) => this.setActiveTool(id, value),
    });
    this.chartEl.append(this.toolbar.root);
    this.toolbar.fitTo(this.chartEl);

    // Shown only once the view has been moved off its default -- a stretched
    // price axis, a zoom, a scroll into history -- tucked into the corner where
    // the two axes meet. Alt+R does the same.
    this.resetBtn = el('button.card__reset', {
      type: 'button',
      title: t('重置圖表視圖 (Alt+R)'),
      hidden: true,
      onclick: () => this.resetView(),
    });
    this.resetBtn.innerHTML =
      '<svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 7a4.5 4.5 0 1 0 1.3-3.2"/><path d="M2.5 1.8v2.4h2.4"/></svg>';
    this.chartEl.append(this.resetBtn);

    // Perpetuals only: the funding rate and the time until it is charged, in
    // the corner by the price axis where TradingView keeps its bar countdown.
    this.fundingRateEl = el('span.card__funding-rate');
    this.fundingTimeEl = el('span.card__funding-time');
    this.fundingEl = el(
      'div.card__funding',
      { hidden: true, title: t('資金費率 · 距離下次結算') },
      this.fundingRateEl,
      this.fundingTimeEl
    );
    this.noticeEl = el('div.card__notice', { hidden: true });
    this.chartEl.append(this.fundingEl, this.noticeEl);

    // Where price sits in its 4H / 24H / 72H volume distribution. Watchlist
    // symbols only: those are the ones the hub monitors. Always visible, unlike
    // the rest of the chrome -- it is the thing to glance at before an entry.
    this.positionCells = new Map();
    this.positionEl = el(
      'div.card__position',
      { hidden: true, title: t('目前價格在最近 4H / 24H / 72H 成交量分布中的位置（以下成交量佔比）') },
      Object.keys(POSITION_WINDOWS).map((name) => {
        const value = el('span.card__position-value', { text: '—' });
        const cell = el('span.card__position-cell', {}, el('span.card__position-label', { text: name }), value);
        this.positionCells.set(name, { cell, value });
        return cell;
      })
    );
    this.chartEl.append(this.positionEl);
    /** The latest position state for this card's symbol, and an unacknowledged alert. */
    this.position = null;
    this.alerting = null;

    this.overlayText = el('div.card__overlay-text', { text: t('載入中…') });
    this.retryBtn = el('button.sc-btn', {
      type: 'button',
      text: t('重試'),
      hidden: true,
      onclick: () => this.loadData(),
    });
    this.overlay = el('div.card__overlay', {}, this.overlayText, this.retryBtn);

    // Only rendered while click-through is on: the one place guaranteed to
    // accept a click, so the user can never lock themselves out (spec 4.2).
    this.unlock = el('button.card__unlock', {
      type: 'button',
      text: t('解除穿透'),
      title: t('滑鼠穿透中,點此解除(或按 Ctrl+Alt+C)'),
      hidden: true,
      onmouseenter: () => window.stockcard.setIgnoreMouse(false),
      onmouseleave: () => window.stockcard.setIgnoreMouse(true),
      onclick: () => window.stockcard.setClickThrough(false),
    });

    this.panel = new SettingsPanel({
      card: this.card,
      // Search follows the card's market, so it only offers what can be shown.
      provider: { searchSymbols: (query) => this.feed.searchSymbols(query) },
      prefs: this.prefs,
      intervals,
      chartTypes,
      showWindowOpacity: this.windowControls,
      onPatch: (patch) => this.onPatch(patch),
      onMarket: (market) => this.setMarket(market),
      onPrefs: (patch) => window.stockcard.setPrefs(patch),
      onShortcut: async (name, accelerator) => {
        const response = await window.stockcard.updateShortcuts({ [name]: accelerator });
        return response && response.result ? response.result[name] : { ok: true };
      },
      onClose: () => this.panel.close(),
    });

    this.root = el(
      'div.card',
      { dataset: { cardId: this.card.id } },
      this.bar,
      this.dot,
      this.chartEl,
      this.watchlist.root,
      this.overlay,
      this.unlock,
      this.panel.root
    );

    this.applyOpacity();
    this.renderIdentity();
  }

  /* ------------------------------------------------------------ lifecycle */

  async mount() {
    this.chart = new CardChart(this.chartEl, {
      chartType: this.card.chartType,
      showVolume: this.card.showVolume,
      upDownColor: this.prefs.upDownColor,
      timezone: this.prefs.timezone,
    });
    this.chart.setOIVisible(this.oiApplies());
    this.chart.setDrawingsHidden(this.card.hideDrawings);
    this.applyVolumeOptions();

    // Each market has its own connection and so its own health; the dot
    // reports the one this card is on.
    this.offStatus = MARKET_IDS.map((market) =>
      this.feedFor(market).onStatusChange((status) => {
        if (market === this.card.market) this.setStatus(status);
      })
    );
    this.setStatus(this.feed.getStatus());
    this.refreshCounterpart();
    this.fundingTimer = setInterval(() => this.renderFunding(), 1000);

    this.offAlertState = window.stockcard.onAlertState((state) => this.applyPosition(state));
    this.offAlertFired = window.stockcard.onAlertFired((alert) => this.applyAlert(alert));
    this.loadPosition();
    // Any press on the card acknowledges: clears the glow and stops the
    // taskbar flash for this window.
    this.onAcknowledge = () => this.acknowledgeAlert();
    this.root.addEventListener('pointerdown', this.onAcknowledge, true);

    this.bindUndo();
    this.bindLevelInput();
    this.bindFibInput();
    // Order entry, positions and orders on the chart -- perpetual cards only.
    this.trade = new TradeController(this);
    // Price alerts: the bell on the rail, Alt+A, and their lines.
    this.priceAlerts = new PriceAlertController(this);
    this.offFibs = window.stockcard.onFibsChanged(({ symbol, fibs }) => {
      if (this.destroyed || symbol !== this.card.symbol) return;
      this.fibs = fibs;
      this.renderFibs();
    });
    this.loadFibs();
    this.bindRectInput();
    this.offRects = window.stockcard.onRectsChanged(({ symbol, rects }) => {
      if (this.destroyed || symbol !== this.card.symbol) return;
      this.rects = rects;
      this.chart.rects.setRects(rects);
    });
    this.loadRects();
    this.bindTrendInput();
    this.bindColorInput();
    this.offTrends = window.stockcard.onTrendlinesChanged(({ symbol, trendlines }) => {
      if (this.destroyed || symbol !== this.card.symbol) return;
      this.trends = trendlines;
      this.chart.trends.setLines(trendlines);
    });
    this.loadTrends();
    this.bindVRangeInput();
    this.offVRanges = window.stockcard.onVRangesChanged(({ symbol, vranges }) => {
      if (this.destroyed || symbol !== this.card.symbol) return;
      this.vranges = vranges;
      this.syncVRanges();
    });
    this.loadVRanges();
    this.applyVolumeProfile(this.card.volumeProfile || 'off');
    this.applyVpDetail();
    if (this.card.showHtf) this.setHtfEnabled(true);
    this.renderRail();
    this.periodLevelsData = [];
    this.periodLevelsSeq = 0;
    if (this.levelsWanted()) this.loadPeriodLevels();
    this.offLevels = window.stockcard.onLevelsChanged(({ symbol, levels }) => {
      if (this.destroyed || symbol !== this.card.symbol) return;
      this.chart.setLevels(levels);
    });
    this.loadLevels();

    await this.loadData();
  }

  /* ----------------------------------------------------------------- tools */

  /**
   * Arm a drawing tool. Selecting the same one again disarms it, so the rail
   * is a toggle rather than a trap -- on a card this small, hunting for the
   * cursor icon to escape a mode is a poor use of the only 22px of chrome.
   */
  setActiveTool(id, value) {
    if (id === 'vp') {
      // A display layer, not a drawing mode -- choosing a variant must not
      // disarm whatever tool the user currently has in hand.
      if (value.startsWith('detail:')) {
        window.stockcard.updateCard(this.card.id, { vpDetail: value.slice(7) });
        return;
      }
      window.stockcard.updateCard(this.card.id, { volumeProfile: value });
      return;
    }
    if (id === 'htf') {
      // A display layer with a choice of interval; 'off' keeps the interval.
      this.onPatch(value === 'off' ? { showHtf: false } : { showHtf: true, htfInterval: value });
      return;
    }
    if (id === 'opens') {
      // Which opens (this period's, the previous one's, both) turns them on
      // at the current boundary, so one click is enough from 'off'.
      if (value.startsWith('which:')) {
        this.onPatch({ showOpens: true, opensWhich: value.slice(6) });
        return;
      }
      // A boundary choice turns the opens on; 'off' keeps the boundary for the
      // highs and lows, which share it.
      this.onPatch(value === 'off' ? { showOpens: false } : { showOpens: true, levelAnchor: value });
      return;
    }
    if (id === 'hilo') {
      this.onPatch({ hilo: value });
      return;
    }
    // Sub-panes, the same switches as in the settings panel, one click away.
    if (id === 'volume') {
      // A threshold or memory choice turns the pane on too: it is what shows them.
      if (value.startsWith('sq:')) this.onPatch({ showVolume: true, volSqueeze: value.slice(3) });
      else if (value.startsWith('mem:')) this.onPatch({ showVolume: true, volMemory: value.slice(4) });
      else this.onPatch({ showVolume: value === 'on' });
      return;
    }
    if (id === 'oi') {
      this.onPatch({ showOI: !this.card.showOI });
      return;
    }
    if (id === 'drawings') {
      this.setDrawingsHidden(!this.card.hideDrawings);
      return;
    }
    if (id === 'footprint') {
      if (value.startsWith('ratio:')) {
        this.onPatch({ footprint: true, fpRatio: value.slice(6) });
      } else if (value === 'focus') {
        if (!this.card.footprint) this.onPatch({ footprint: true });
        if (this.chart) this.chart.focusRecent(FOOTPRINT_BARS);
      } else {
        const on = value === 'on';
        this.onPatch({ footprint: on });
        // Too narrow to show anything: bring the bars it covers into view.
        if (on && this.chart && this.chart.chart.timeScale().options().barSpacing < FOOTPRINT_MIN_SPACING) {
          this.chart.focusRecent(FOOTPRINT_BARS);
        }
      }
      return;
    }
    const next = id === this.activeTool ? 'cursor' : id;
    // Picking up a drawing tool brings the drawings back: a new line drawn
    // onto a hidden layer would vanish the moment it was let go.
    if (DRAWING_TOOLS.includes(next)) this.revealDrawings();
    this.activeTool = next;
    this.toolbar.setActive(next);
    this.dismissMeasure();
    // A line waiting for its second click belongs to the tool being put down.
    this.cancelTrend();
    // The chart's own cursor would otherwise stay a crosshair over a tool.
    this.chartEl.style.cursor = next === 'cursor' ? '' : 'crosshair';
  }

  /* ------------------------------------------------------------- drawings */

  /** Hide or show the drawings on this card; they are kept either way. */
  setDrawingsHidden(hidden) {
    if (!!this.card.hideDrawings === !!hidden) return;
    // The chart and the rail follow when the store echoes the change back.
    this.onPatch({ hideDrawings: !!hidden });
  }

  /* --------------------------------------------------------------- colours */

  /**
   * Right-click a level, trend line or rectangle for a row of colours --
   * green for support, red for resistance, and a few more to tell, say, a
   * weekly level from an intraday one. Anywhere else, right-click still
   * opens the settings panel (card.js listens on the window; this stops
   * the event before it gets there).
   */
  bindColorInput() {
    this.onDrawingContext = (event) => {
      if (this.offChart(event)) return;
      const box = this.chartEl.getBoundingClientRect();
      const x = event.clientX - box.left;
      const y = event.clientY - box.top;
      if (!this.chart.inPlot(x, y)) return;
      const hit = this.drawingAt(x, y);
      if (!hit) return;
      event.preventDefault();
      event.stopPropagation();
      this.openPalette(hit, event.clientX, event.clientY);
    };
    this.chartEl.addEventListener('contextmenu', this.onDrawingContext);
    this.onPaletteOutside = (event) => {
      if (this.palette && !this.palette.contains(event.target)) this.closePalette();
    };
    this.onPaletteKey = (event) => {
      if (event.key === 'Escape') this.closePalette();
    };
  }

  /** The colourable drawing under (x, y): trend lines, then rectangles, then levels. */
  drawingAt(x, y) {
    const trend = this.chart.trends.hitTest(x, y);
    if (trend) return { kind: 'trend', id: trend.id };
    const rect = this.chart.rects.hitTest(x, y);
    if (rect) return { kind: 'rect', id: rect.id };
    const level = this.chart.levelAt(y);
    if (level) return { kind: 'level', id: level };
    return null;
  }

  drawingColor({ kind, id }) {
    if (kind === 'level') {
      const entry = this.chart.levels.get(id);
      return (entry && entry.level.color) || null;
    }
    const list = kind === 'rect' ? this.rects : this.trends;
    const found = (list || []).find((d) => d.id === id);
    return (found && found.color) || null;
  }

  async writeDrawingColor(kind, id, color) {
    const s = this.card.symbol;
    if (kind === 'level') return window.stockcard.setLevelColor(s, id, color);
    if (kind === 'rect') return window.stockcard.updateRect(s, id, { color });
    if (kind === 'trend') return window.stockcard.updateTrendline(s, id, { color });
    return null;
  }

  openPalette(hit, clientX, clientY) {
    this.closePalette();
    const current = this.drawingColor(hit);
    const palette = el(
      'div.card__palette',
      { role: 'menu' },
      DRAWING_COLORS.map((c) =>
        el('button.card__swatch', {
          type: 'button',
          title: c.label,
          class: (c.value || null) === current ? 'is-current' : '',
          style: `--swatch: ${c.value || '#7f9dc4'}`,
          onclick: async () => {
            this.closePalette();
            if ((c.value || null) === current) return;
            const done = await this.writeDrawingColor(hit.kind, hit.id, c.value);
            if (done) this.pushUndo({ kind: 'color', drawing: hit.kind, id: hit.id, from: current });
          },
        })
      )
    );
    this.root.append(palette);
    // Next to the pointer, kept inside the card.
    const card = this.root.getBoundingClientRect();
    const left = Math.min(clientX - card.left + 4, card.width - palette.offsetWidth - 4);
    const top = Math.min(clientY - card.top + 4, card.height - palette.offsetHeight - 4);
    palette.style.left = `${Math.max(4, left)}px`;
    palette.style.top = `${Math.max(4, top)}px`;
    this.palette = palette;
    window.addEventListener('mousedown', this.onPaletteOutside, true);
    window.addEventListener('keydown', this.onPaletteKey);
  }

  closePalette() {
    if (!this.palette) return;
    this.palette.remove();
    this.palette = null;
    window.removeEventListener('mousedown', this.onPaletteOutside, true);
    window.removeEventListener('keydown', this.onPaletteKey);
  }

  /** About to add or bring back a drawing: show the layer it lands on. */
  revealDrawings() {
    if (this.card.hideDrawings) this.setDrawingsHidden(false);
  }

  /* --------------------------------------------------------------- levels */

  async loadLevels() {
    const symbol = this.card.symbol;
    const levels = await window.stockcard.listLevels(symbol);
    // A symbol switch could have landed while this was in flight.
    if (this.destroyed || symbol !== this.card.symbol) return;
    this.chart.setLevels(levels);
  }

  /**
   * Support/resistance levels, with no toolbar -- there is no room for one on a
   * card this size, so the whole interaction is three gestures on the chart:
   *
   *   double-click empty space  -> add a level there
   *   double-click a level      -> delete it
   *   drag a level              -> move it
   *
   * Hold Ctrl for any of them to magnet onto the nearest OHLC, exactly as the
   * crosshair does, so a level lands on the wick you are aiming at.
   */
  bindLevelInput() {
    const el = this.chartEl;
    const local = (event) => {
      const rect = el.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    this.onLevelDblClick = async (event) => {
      if (this.offChart(event)) return; // the rail, reset button and such are not the chart
      if (event.shiftKey) return; // Shift belongs to the measure tool
      const { x, y } = local(event);
      if (!this.chart.inPlot(x, y)) return; // the axes belong to the chart
      const hit = this.chart.levelAt(y);
      if (hit) {
        const removed = this.chart.levels.get(hit);
        await window.stockcard.removeLevel(this.card.symbol, hit);
        if (removed) this.pushUndo({ kind: 'level-remove', id: hit, price: removed.level.price, color: removed.level.color });
        return;
      }
      const price = this.chart.priceAt(x, y, { magnet: event.ctrlKey });
      if (price === null) return;
      this.revealDrawings();
      const added = await window.stockcard.addLevel(this.card.symbol, price);
      if (added) this.pushUndo({ kind: 'level-add', id: added.id });
    };

    this.onLevelClick = async (event) => {
      if (this.offChart(event)) return; // the rail, reset button and such are not the chart
      if (this.activeTool !== 'level' || event.shiftKey) return;
      const { x, y } = local(event);
      if (!this.chart.inPlot(x, y)) return; // the axes belong to the chart
      // Clicking an existing level selects nothing and deletes nothing here --
      // that stays on double-click, so a mis-click while armed cannot destroy
      // a line the user just placed.
      if (this.chart.levelAt(y)) return;
      const price = this.chart.priceAt(x, y, { magnet: event.ctrlKey });
      if (price === null) return;
      this.revealDrawings();
      const added = await window.stockcard.addLevel(this.card.symbol, price);
      if (added) this.pushUndo({ kind: 'level-add', id: added.id });
    };

    this.onLevelDown = (event) => {
      if (this.offChart(event)) return; // the rail, reset button and such are not the chart
      if (event.button !== 0) return;
      if (event.shiftKey) return; // ditto -- measuring beats grabbing a level
      const { x, y } = local(event);
      if (!this.chart.inPlot(x, y)) return; // the axes belong to the chart
      const hit = this.chart.levelAt(y);
      if (!hit) return;
      // Freeze the chart's own pan/zoom for the duration, rather than trying to
      // out-manoeuvre its handlers with stopPropagation.
      this.chart.setInteractionEnabled(false);
      this.chart.setActiveLevel(hit);
      const entry = this.chart.levels.get(hit);
      this.draggingLevel = { id: hit, price: null, from: entry ? entry.level.price : null };
      event.preventDefault();
    };

    this.onLevelMove = (event) => {
      const { x, y } = local(event);
      if (this.measuring) return;
      if (!this.draggingLevel) {
        // Anything not over a level falls back to the armed tool's cursor, not
        // to the default -- otherwise arming a tool showed a crosshair only
        // until the pointer first moved.
        el.style.cursor = !this.chart.inPlot(x, y)
          ? ''
          : event.shiftKey || this.activeTool !== 'cursor'
          ? 'crosshair'
          : this.chart.levelAt(y)
            ? 'ns-resize'
            : '';
        return;
      }
      const price = this.chart.priceAt(x, y, { magnet: event.ctrlKey });
      if (price === null) return;
      this.draggingLevel.price = price;
      this.chart.previewLevel(this.draggingLevel.id, price);
    };

    this.onLevelUp = async () => {
      const drag = this.draggingLevel;
      if (!drag) return;
      this.draggingLevel = null;
      this.chart.setInteractionEnabled(true);
      this.chart.setActiveLevel(null);
      // Only one write, on release -- not one per pixel of the drag.
      if (drag.price !== null && drag.price !== drag.from) {
        await window.stockcard.updateLevel(this.card.symbol, drag.id, drag.price);
        // This is the one the feature exists for: a pan that started a few
        // pixels too close to a line and dragged it along instead.
        if (drag.from !== null) this.pushUndo({ kind: 'level-move', id: drag.id, from: drag.from });
      }
    };

    el.addEventListener('dblclick', this.onLevelDblClick);
    el.addEventListener('click', this.onLevelClick);
    el.addEventListener('mousedown', this.onLevelDown, true);
    el.addEventListener('mousemove', this.onLevelMove);
    // On window, not the element: a fast drag can release outside the chart.
    window.addEventListener('mouseup', this.onLevelUp);

    this.bindMeasureInput(local);
  }

  /* ------------------------------------------------- higher timeframe */

  /** The overlay's interval: 1h, 4h (the default), 1d or 1w. */
  htfInterval() {
    return this.card.htfInterval || '4h';
  }

  /** Only over a finer chart: on a 4h chart a 4h box is the candle itself. */
  htfApplies() {
    return this.card.showHtf && intervalToMs(this.card.interval) < intervalToMs(this.htfInterval());
  }

  /**
   * The last N higher-timeframe candles (1h, 4h, 1d or 1w), drawn as
   * translucent boxes over the lower timeframe.
   *
   * The forming one is fed by its own subscription on that interval's stream
   * rather than being aggregated out of the card's own bars: the card may be
   * showing 1m, where 500 bars is only eight hours, and the exchange's own
   * candle is authoritative anyway. Streams are ref-counted in the hub, so a second
   * subscription on the same symbol costs one extra kline stream, not a second
   * connection.
   */
  async setHtfEnabled(enabled) {
    if (!enabled) {
      this.feed.unsubscribe(`${this.card.id}:htf`);
      this.htfBars = [];
      this.renderHtf();
      return;
    }
    await this.loadHtf();
    this.feed.subscribe(`${this.card.id}:htf`, this.card.symbol, this.htfInterval(), {
      onBar: (bar) => {
        if (this.destroyed || !this.htfApplies()) return;
        const last = this.htfBars[this.htfBars.length - 1];
        if (last && last.time === bar.time) this.htfBars[this.htfBars.length - 1] = bar;
        else if (!last || bar.time > last.time) {
          this.htfBars.push(bar);
          if (this.htfBars.length > HTF_COUNT) this.htfBars.shift();
        }
        this.renderHtf();
      },
    });
  }

  async loadHtf() {
    const key = this.dataKey();
    try {
      const interval = this.htfInterval();
      const bars = await this.feed.getHistory(this.card.symbol, interval, HTF_COUNT);
      // The overlay's interval may have been switched while this was in flight.
      if (this.destroyed || key !== this.dataKey() || interval !== this.htfInterval()) return;
      this.htfBars = bars.slice(-HTF_COUNT);
      this.renderHtf();
    } catch (err) {
      console.error('[card] higher-timeframe overlay failed', err);
    }
  }

  /**
   * Hand the bars to the chart, which draws them itself (htf-primitive.js).
   * Positioning is no longer this method's job -- the chart recomputes it on
   * every viewport change, in the same frame as the candles.
   */
  renderHtf() {
    if (!this.chart) return;
    this.chart.setHtf(this.htfBars, this.htfApplies(), intervalToMs(this.htfInterval()) / 1000);
  }

  /* -------------------------------------------------------------- history */

  /**
   * Older bars, on demand, once the view nears the left edge of what is loaded.
   *
   * Cache first, network only for what is missing -- and whatever the network
   * returns is written back, so the second visit to a range is a file read. The
   * guards matter more than the fetch: one request in flight at a time, and a
   * range that comes back empty is remembered as exhausted, otherwise scrolling
   * past the start of an instrument's history retries forever.
   */
  async extendHistory() {
    if (this.loadingMore || this.historyExhausted || !this.chart) return;
    const bars = this.chart.bars;
    if (!bars.length) return;

    const { market, symbol, interval } = this.card;
    const feed = this.feed;
    const step = intervalToMs(interval) / 1000;
    const oldest = bars[0].time;
    const from = oldest - step * HISTORY_PAGE;
    const to = oldest - step;
    if (to <= 0) return;

    this.loadingMore = true;
    const seq = this.loadSeq;
    try {
      /*
       * The cache only holds what was fetched while the app was running, so
       * holes in it are normal -- the app was closed overnight, a symbol went
       * unwatched for a day. What must not happen is trusting a page that is
       * only partly cached: that drew a 38h blank on ZEC perp 5m, where the
       * cache had the first few hours of the page and the exchange had all of
       * it. So a page short of its full count goes to the network, and what
       * comes back is written over the hole, which heals it for good.
       */
      const expected = Math.floor((to - from) / step) + 1;
      const cached = await window.stockcard.readBars(market, symbol, interval, from, to);
      let older = cached;
      if (cached.length < expected) {
        try {
          const fresh = await feed.getRange(symbol, interval, from * 1000, to * 1000);
          const keep = fresh.filter((b) => b.closed);
          if (keep.length) window.stockcard.writeBars(market, symbol, interval, keep);
          if (fresh.length) older = fresh;
        } catch (err) {
          // Offline: what the cache has beats nothing.
          if (!cached.length) throw err;
        }
      }
      // The card may have changed symbol or interval while this was in flight.
      if (this.destroyed || seq !== this.loadSeq) return;
      if (!older.length) {
        this.historyExhausted = true;
        return;
      }
      this.chart.prependBars(older);
      this.renderFibs();
      // The OI pane has to cover the bars that just arrived too.
      this.loadOI();
    } catch (err) {
      console.error('[card] history extend failed', err);
    } finally {
      this.loadingMore = false;
    }
  }

  /* --------------------------------------------------------- volume profile */

  /**
   * Bars for a time range: cache first, network when the cache is short.
   *
   * `expect` is how many bars a complete range holds. A cache that has fewer is
   * treated as missing rather than trusted, since a partly-cached block would
   * otherwise produce a profile that silently leaves out hours of volume.
   */
  async fetchBars(market, symbol, interval, fromSec, toSec, expect = 0) {
    const cached = await window.stockcard.readBars(market, symbol, interval, fromSec, toSec);
    if (expect && cached.length >= expect) return cached;
    const fresh = await this.feedFor(market).getRange(symbol, interval, fromSec * 1000, toSec * 1000);
    const closed = fresh.filter((b) => b.closed);
    if (closed.length) window.stockcard.writeBars(market, symbol, interval, closed);
    return fresh;
  }

  /**
   * Switch the profile layer. Drawing is the chart's job (vp-primitive.js);
   * this only decides what data it needs and keeps it fresh:
   *
   *   day        today's 1m bars, refreshed every 2 minutes
   *   visible    nothing -- computed from the card's own bars on every repaint
   *   session4h  5m bars per 4h block in view; closed blocks cached for good,
   *              the one still trading refreshed every minute
   */
  applyVolumeProfile(mode) {
    clearInterval(this.profileTimer);
    this.profileTimer = null;
    this.toolbar.setMenuValue('vp', mode);
    if (!this.chart) return;
    this.chart.setVolumeProfileMode(mode);

    if (mode === 'day') {
      this.loadDayProfile();
      this.profileTimer = setInterval(() => this.loadDayProfile(), 120000);
    } else if (mode === 'session4h') {
      this.loadPeriodProfiles();
      this.profileTimer = setInterval(() => this.loadPeriodProfiles({ liveOnly: true }), 60000);
    }
  }

  /** Row height for every profile on the card, and the tick in the menu. */
  applyVpDetail() {
    const detail = this.card.vpDetail || 'normal';
    this.toolbar.setMenuValue('vp', `detail:${detail}`, 'detail');
    if (this.chart) this.chart.setVolumeProfileDetail(detail);
  }

  async loadDayProfile() {
    const key = this.dataKey();
    const { start, end } = sessionBounds();
    try {
      const bars = await this.feed.getRange(this.card.symbol, '1m', start, end);
      if (this.destroyed || key !== this.dataKey() || this.card.volumeProfile !== 'day') return;
      this.chart.setDaySource(new ProfileSource(bars));
    } catch (err) {
      console.error('[card] day profile failed', err);
    }
  }

  /** 4h blocks overlapping the visible range, oldest first, capped. */
  visibleBlocks() {
    const range = this.chart.chart.timeScale().getVisibleLogicalRange();
    if (!range) return [];
    const from = this.chart.timeFromLogical(range.from);
    const to = this.chart.timeFromLogical(range.to);
    if (from === null || to === null) return [];
    const now = Date.now() / 1000;
    const out = [];
    for (let t = Math.floor(from / PERIOD_4H) * PERIOD_4H; t <= Math.min(to, now); t += PERIOD_4H) {
      out.push(t);
    }
    // Zoomed right out on 1h that is ~20 blocks; the cap is a backstop.
    return out.slice(-30);
  }

  async loadPeriodProfiles({ liveOnly = false } = {}) {
    if (!this.chart || this.card.volumeProfile !== 'session4h') return;
    // A 4h block on a 4h-or-coarser chart is a single candle, or less.
    if (!BELOW_4H.includes(this.card.interval)) {
      this.chart.setPeriodProfiles([]);
      return;
    }
    if (this.loadingPeriods) return;
    this.loadingPeriods = true;
    const { market, symbol } = this.card;
    const key = this.dataKey();
    const now = Date.now() / 1000;
    const liveStart = Math.floor(now / PERIOD_4H) * PERIOD_4H;

    try {
      const wanted = this.visibleBlocks();
      // Closed blocks: one request for the whole missing run, then split.
      const missing = liveOnly ? [] : wanted.filter((t) => t !== liveStart && !this.periodCache.has(t));
      if (missing.length) {
        const from = missing[0];
        const to = missing[missing.length - 1] + PERIOD_4H - 1;
        const expect = ((to + 1 - from) / 300) | 0;
        const bars = await this.fetchBars(market, symbol, '5m', from, to, expect);
        if (key !== this.dataKey()) return;
        for (const block of buildPeriodProfiles(bars, PERIOD_4H, 14)) {
          if (block.start !== liveStart) this.periodCache.set(block.start, block);
        }
      }
      // The live block always comes from the network: the cache only ever
      // holds closed bars, so it is by construction missing the newest one.
      if (wanted.includes(liveStart)) {
        const bars = await this.feedFor(market).getRange(symbol, '5m', liveStart * 1000, now * 1000);
        if (key !== this.dataKey()) return;
        const [block] = buildPeriodProfiles(bars, PERIOD_4H, 14);
        if (block) this.periodCache.set(liveStart, { ...block, live: true });
      }
      if (this.destroyed || this.card.volumeProfile !== 'session4h') return;
      this.chart.setPeriodProfiles(wanted.map((t) => this.periodCache.get(t)).filter(Boolean));
    } catch (err) {
      console.error('[card] 4h profiles failed', err);
    } finally {
      this.loadingPeriods = false;
    }
  }

  /* --------------------------------------------------------- open interest */

  /** Thin-volume settings from the card, and the bar length its live estimate needs. */
  applyVolumeOptions() {
    if (!this.chart) return;
    const sq = this.card.volSqueeze || '5';
    this.chart.setVolumeOptions({
      threshold: sq === 'off' ? null : Number(sq) / 100,
      memory: Number(this.card.volMemory) || 1000,
      intervalSec: intervalToMs(this.card.interval) / 1000,
    });
  }

  oiApplies() {
    return this.card.market === 'perp' && this.card.showOI === true;
  }

  /** The rail's sub-pane switches follow the card; OI exists only on perp. */
  renderRail() {
    this.toolbar.setMenuValue('opens', this.card.showOpens ? this.card.levelAnchor : 'off');
    this.toolbar.setMenuValue('opens', `which:${this.card.opensWhich || 'current'}`, 'which');
    this.toolbar.setMenuValue('hilo', this.card.hilo);
    this.toolbar.setMenuValue('volume', this.card.showVolume ? 'on' : 'off');
    this.toolbar.setMenuValue('volume', `sq:${this.card.volSqueeze || '5'}`, 'sq');
    this.toolbar.setMenuValue('volume', `mem:${this.card.volMemory || '1000'}`, 'mem');
    this.toolbar.setToggled('oi', this.card.showOI);
    this.toolbar.setMenuValue('htf', this.card.showHtf ? this.htfInterval() : 'off');
    this.toolbar.setToggled('drawings', this.card.hideDrawings);
    this.toolbar.setHidden('oi', this.card.market !== 'perp');
    this.toolbar.setMenuValue('footprint', this.card.footprint ? 'on' : 'off');
    this.toolbar.setMenuValue('footprint', `ratio:${this.card.fpRatio || '3'}`, 'ratio');
  }

  /* ------------------------------------------------------------ footprint */

  /**
   * Turn the footprint on or off for what the card shows now. On, it asks
   * the hub for the newest FOOTPRINT_BARS bars' minutes; the hub answers with
   * what it has (memory and disk) and then streams the rest -- live minutes,
   * and the ones it fetches -- through onFootprint.
   */
  async loadFootprint() {
    const seq = ++this.fpSeq;
    this.fpBook.clear();
    this.fpBook.setInterval(intervalToMs(this.card.interval) / 1000);
    if (!this.chart) return;
    if (!this.card.footprint) {
      this.chart.setFootprint(null);
      this.feed.setFootprint(this.card.id, false).catch(() => {});
      return;
    }
    const bars = this.chart.bars;
    if (!bars.length) return;
    this.chart.setFootprint(this.fpBook, Number(this.card.fpRatio) || 3);
    try {
      const records = await this.feed.setFootprint(this.card.id, true, this.footprintFrom());
      if (seq !== this.fpSeq || this.destroyed) return;
      if (this.fpBook.put(records)) this.chart.footprintChanged();
    } catch (err) {
      console.error('[card] footprint failed', err);
    }
  }

  /** The earliest bar the footprint covers, in seconds. */
  footprintFrom() {
    const bars = this.chart.bars;
    const first = bars[Math.max(0, bars.length - FOOTPRINT_BARS)].time;
    return Math.max(first, Math.floor(Date.now() / 1000 - FOOTPRINT_MAX_SEC));
  }

  /** Minutes from the hub: the forming one, a closed one, or a fetched one. */
  applyFootprint(records) {
    if (this.destroyed || !this.card.footprint || !this.chart || !this.chart.bars.length) return;
    this.fpBook.trim(this.footprintFrom() - 60);
    if (this.fpBook.put(records)) this.chart.footprintChanged();
  }

  /** Forget the OI of the previous symbol or market. */
  resetOI() {
    this.oiSeq += 1;
    this.oiPoints = [];
    this.oiLive = [];
    if (this.chart) this.chart.setOIData([]);
  }

  /**
   * Build the OI pane for every bar on the chart, from what is stored plus
   * what the exchange still has. See open-interest.js for the two sources.
   *
   * Only the 5m history is fetched; the per-minute series is ours, recorded by
   * the hub while the app runs, so there is nothing to fetch for it.
   */
  async loadOI() {
    if (!this.chart || !this.oiApplies()) return;
    const bars = this.chart.bars;
    if (!bars.length) return;
    const seq = ++this.oiSeq;
    const key = this.dataKey();
    const { symbol, interval } = this.card;
    const now = Date.now() / 1000;
    const from = bars[0].time - OI_MAX_GAP_SEC;

    try {
      // Off-grid records are the exchange's bad samples of 2026-10-15; until
      // the recheck below drops them from disk, they are skipped here.
      let history = (await window.stockcard.readBars('perp', symbol, 'oi_5m', from, now)).filter(onHistoryGrid);
      const fetched = await this.backfillOIHistory(symbol, from, now, history);
      if (fetched.length) {
        const byTime = new Map(history.map((r) => [r.time, r]));
        for (const r of fetched) byTime.set(r.time, r);
        history = [...byTime.values()].sort((a, b) => a.time - b.time);
      }
      const minutes = await window.stockcard.readBars(
        'perp',
        symbol,
        'oi_1m',
        Math.max(from, now - OI_MINUTES_SEC),
        now
      );
      if (this.destroyed || seq !== this.oiSeq || key !== this.dataKey()) return;
      this.oiPoints = oiPoints(minutes, history, this.oiLive);
      const step = intervalToMs(interval) / 1000;
      this.chart.setOIData(bucketOI(this.oiPoints, this.chart.bars.map((b) => b.time), step));
    } catch (err) {
      console.error('[card] open interest failed', err);
      return;
    }
    if (!this.oiRechecked.has(symbol)) {
      this.oiRechecked.add(symbol);
      this.recheckOIHistory(symbol)
        .then((changed) => {
          if (changed && !this.destroyed && key === this.dataKey()) this.loadOI();
        })
        .catch((err) => console.error('[card] open interest recheck failed', err));
    }
  }

  /**
   * Once a session per symbol, after the pane is drawn: fetch the whole
   * history the exchange still has and make the cache match it.
   *
   * The cache otherwise only grows -- a span stored once is never asked for
   * again. That is right for history that does not change, and wrong when it
   * does: on 2026-10-15 the exchange served bad samples for hours (see
   * onHistoryGrid) and corrected them later, and the cache kept the bad ones,
   * drawing ETH's OI falling from 2.31M to 1.88M when it had barely moved.
   *
   * 30 days of 5m is 18 requests at weight 0 against their own per-IP
   * limit (1000 per 5 minutes), so once per session is cheap. Resolves to
   * true when the cache changed.
   */
  async recheckOIHistory(symbol) {
    const now = Math.floor(Date.now() / 1000);
    const start = now - OI_HISTORY_SEC;
    const cached = await window.stockcard.readBars('perp', symbol, 'oi_5m', start, now);
    if (!cached.length) return false;
    const rows = await this.feed.getOpenInterestHist(symbol, '5m', start * 1000, now * 1000);
    const records = historyRecords(rows);
    if (!records.length) return false;

    const from = records[0].time;
    const to = records[records.length - 1].time;
    const expected = Math.floor((to - from) / OI_HISTORY_STEP_SEC) + 1;
    if (records.length < expected * OI_RECHECK_MIN_SHARE) return false;

    // Nothing to do when the span already holds exactly these values.
    const stored = cached.filter((r) => r.time >= from && r.time <= to);
    const byTime = new Map(stored.map((r) => [r.time, r.close]));
    const same =
      stored.length === records.length && records.every((r) => byTime.get(r.time) === r.close);
    if (same) return false;
    await window.stockcard.replaceBars('perp', symbol, 'oi_5m', from, to, records);
    return true;
  }

  /**
   * Fetch the 5m history the cache is missing and store it: the head, the
   * tail since the last visit, and any hole in between -- as long as it is
   * still inside the exchange's 30 days. So as long as the app is opened at
   * least once every 30 days, the cache keeps growing past that window.
   *
   * Holes used to be left alone: only the tail after the newest cached
   * sample was fetched. But the range asked about is the chart's, not the
   * cache's -- open a 1m chart the next morning and it covers only the last
   * ~8h, fetches just that, and the evening before is never asked for again
   * once older samples sit on both sides of it. The OI line then ran flat
   * across the missing hours.
   */
  async backfillOIHistory(symbol, from, now, cached) {
    const want = Math.max(from, now - OI_HISTORY_SEC);
    const have = cached.filter((r) => r.time >= want);
    let ranges = [];
    if (!have.length) {
      ranges.push([want, now]);
    } else {
      if (have[0].time > want + 300) ranges.push([want, have[0].time - 1]);
      for (let i = 1; i < have.length; i++) {
        const a = have[i - 1].time;
        const b = have[i].time;
        if (b - a <= OI_MAX_GAP_SEC) continue;
        // A hole the exchange itself has would otherwise be asked for again on
        // every load; one try per session is enough.
        const key = `${symbol}:${a}:${b}`;
        if (this.oiHolesTried.has(key)) continue;
        this.oiHolesTried.add(key);
        ranges.push([a + 1, b - 1]);
      }
      ranges.push([have[have.length - 1].time + 1, now]);
    }

    // The last day again, over the cache, to pick up the exchange's corrections.
    const recheckAt = this.oiRecheckedAt.get(symbol) || 0;
    if (have.length && Date.now() - recheckAt > OI_RECHECK_EVERY_MS) {
      this.oiRecheckedAt.set(symbol, Date.now());
      const since = Math.max(want, now - OI_RECHECK_SEC);
      ranges = [[since, now], ...ranges.filter(([start]) => start < since).map(([a, b]) => [a, Math.min(b, since - 1)])];
    }

    const records = [];
    for (const [start, end] of ranges.slice(0, OI_MAX_FETCH_RANGES)) {
      // Samples land on 5m boundaries, a few minutes late; nothing new yet.
      if (end - start < 300) continue;
      const rows = await this.feed.getOpenInterestHist(symbol, '5m', start * 1000, end * 1000);
      records.push(...historyRecords(rows));
    }
    if (records.length) window.stockcard.writeBars('perp', symbol, 'oi_5m', records);
    return records;
  }

  /** A live OI sample: keep it, and move the forming bar's OI. */
  applyLiveOI(sample) {
    if (!sample || sample.symbol !== this.card.symbol || this.card.market !== 'perp') return;
    const point = { t: sample.time / 1000, v: sample.value };
    const last = this.oiLive[this.oiLive.length - 1];
    if (last && point.t <= last.t) return;
    this.oiLive.push(point);
    while (this.oiLive.length && this.oiLive[0].t < point.t - OI_LIVE_KEEP_SEC) this.oiLive.shift();

    if (!this.chart || !this.oiApplies()) return;
    const tail = this.oiPoints[this.oiPoints.length - 1];
    if (!tail || point.t > tail.t) this.oiPoints.push(point);
    const bars = this.chart.bars;
    const lastBar = bars[bars.length - 1];
    if (!lastBar) return;
    // Only the points that can touch the last bar: one gap's worth before it.
    let k = this.oiPoints.length;
    while (k > 0 && this.oiPoints[k - 1].t >= lastBar.time - OI_MAX_GAP_SEC) k--;
    const step = intervalToMs(this.card.interval) / 1000;
    const [record] = bucketOI(this.oiPoints.slice(k), [lastBar.time], step);
    if (record) this.chart.updateOI(record);
  }

  /* -------------------------------------------------------- period levels */

  levelsWanted() {
    return this.card.showOpens || (this.card.hilo && this.card.hilo !== 'off');
  }

  /**
   * Opens and highs/lows of the day, week and month, in the card's chosen
   * clock (sessions.js). Built from bars back to the start of the previous
   * month, at the resolution that lands exactly on the anchor's boundaries,
   * and fetched again just after the next day boundary, the
   * soonest any of them can roll over. Current highs and lows also move live,
   * in subscribe().
   */
  async loadPeriodLevels() {
    clearTimeout(this.levelsTimer);
    if (!this.chart) return;
    const seq = ++this.periodLevelsSeq;
    if (!this.levelsWanted()) {
      this.periodLevelsData = [];
      this.chart.setPeriodLevels([]);
      return;
    }
    const key = this.dataKey();
    const feed = this.feed;
    const { symbol, levelAnchor: anchor, hilo, levelPeriods, showOpens } = this.card;
    const which = this.card.opensWhich || 'current';
    const now = Date.now();
    try {
      // 30m for the 09:30 New York open, 1h for every other boundary.
      const bars = await feed.getRange(symbol, barsIntervalFor(anchor), periodStart('M', anchor, now, -1), now);
      if (this.destroyed || key !== this.dataKey() || seq !== this.periodLevelsSeq) return;
      this.periodLevelsData = periodLevels(bars, {
        anchor,
        periods: levelPeriods,
        opens: showOpens && which !== 'prev',
        prevOpens: showOpens && which !== 'current',
        previous: hilo === 'prev' || hilo === 'both',
        current: hilo === 'current' || hilo === 'both',
        now,
      });
      this.chart.setPeriodLevels(this.periodLevelsData);
    } catch (err) {
      console.error('[card] period levels failed', err);
    }
    const nextDay = periodStart('D', anchor, Date.now(), 1);
    this.levelsTimer = setTimeout(() => this.loadPeriodLevels(), Math.max(1000, nextDay - Date.now() + 5000));
  }

  /* ------------------------------------------------------------ position */

  /** A card opened mid-session asks for what the hub has already said. */
  async loadPosition() {
    const key = this.dataKey();
    const states = await window.stockcard.alertStates();
    if (this.destroyed || key !== this.dataKey()) return;
    for (const state of states) this.applyPosition(state);
  }

  isMine(entry) {
    return entry && entry.symbol === this.card.symbol && entry.market === this.card.market;
  }

  applyPosition(state) {
    if (!this.isMine(state)) return;
    this.position = state;
    this.renderPosition();
  }

  applyAlert(alert) {
    if (!this.isMine(alert)) return;
    this.alerting = alert;
    this.root.classList.add('is-alerting');
    this.root.dataset.alertSide = alert.side;
    this.renderPosition();
  }

  acknowledgeAlert() {
    window.stockcard.ackAlert();
    if (!this.alerting) return;
    this.alerting = null;
    this.root.classList.remove('is-alerting');
    delete this.root.dataset.alertSide;
    this.renderPosition();
  }

  /** Called up to 4x a second: only text and classes change, never the DOM. */
  renderPosition() {
    const watched = this.watchlistEntries().some((e) => sameEntry(e, this.currentEntry()));
    const state = watched ? this.position : null;
    this.positionEl.hidden = !state;
    if (!state) return;
    for (const [name, { cell, value }] of this.positionCells) {
      const pct = state.pcts ? state.pcts[name] : null;
      const shown = pct === null || pct === undefined ? '—' : Math.round(pct * 100);
      const alert = this.alerting && this.alerting.window === name ? this.alerting : null;
      value.textContent = alert ? `${shown} ${alert.side === 'high' ? '↑' : '↓'}${alert.level}` : String(shown);
      const zone =
        pct === null || pct === undefined
          ? ''
          : pct >= 0.95
            ? 'hot'
            : pct >= 0.8
              ? 'high'
              : pct <= 0.05
                ? 'cold'
                : pct <= 0.2
                  ? 'low'
                  : '';
      if (cell.dataset.zone !== zone) cell.dataset.zone = zone;
      cell.classList.toggle('is-alert', !!alert);
    }
  }

  /* ------------------------------------------------------------------ undo */

  pushUndo(op) {
    this.undoStack.push({ ...op, symbol: this.card.symbol });
    if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift();
  }

  /**
   * Undoing a delete re-creates the drawing, and the store hands it a new id.
   * Any older entry still naming the old id -- say, the move that preceded the
   * delete -- has to follow it, or undoing further back would target a line
   * that no longer exists and silently do nothing.
   */
  remapUndo(oldId, newId) {
    for (const op of this.undoStack) if (op.id === oldId) op.id = newId;
  }

  async undo() {
    const op = this.undoStack.pop();
    if (!op) return;
    // Entries are recorded against the symbol on screen at the time. The stack
    // is cleared on a symbol switch, so this is a backstop, not a path.
    if (op.symbol !== this.card.symbol) return;
    // Undo edits a drawing; show it, or the undo would look like it did nothing.
    this.revealDrawings();
    const s = op.symbol;
    try {
      switch (op.kind) {
        case 'level-add':
          await window.stockcard.removeLevel(s, op.id);
          break;
        case 'level-remove': {
          const back = await window.stockcard.addLevel(s, op.price, op.color);
          if (back) this.remapUndo(op.id, back.id);
          break;
        }
        case 'level-move':
          await window.stockcard.updateLevel(s, op.id, op.from);
          break;
        case 'fib-add':
          await window.stockcard.removeFib(s, op.id);
          break;
        case 'fib-remove': {
          const back = await window.stockcard.addFib(s, op.a, op.b);
          if (back) this.remapUndo(op.id, back.id);
          break;
        }
        case 'fib-move':
          await window.stockcard.updateFib(s, op.id, { [op.end]: op.from });
          break;
        case 'rect-add':
          await window.stockcard.removeRect(s, op.id);
          break;
        case 'rect-remove': {
          const back = await window.stockcard.addRect(s, op.a, op.b, op.color);
          if (back) this.remapUndo(op.id, back.id);
          break;
        }
        case 'rect-move':
          await window.stockcard.updateRect(s, op.id, op.from);
          break;
        case 'trend-add':
          await window.stockcard.removeTrendline(s, op.id);
          break;
        case 'trend-remove': {
          const back = await window.stockcard.addTrendline(s, op.a, op.b, op.color);
          if (back) this.remapUndo(op.id, back.id);
          break;
        }
        case 'trend-move':
          await window.stockcard.updateTrendline(s, op.id, op.from);
          break;
        case 'vrange-add':
          await window.stockcard.removeVRange(s, op.id);
          break;
        case 'vrange-remove': {
          const back = await window.stockcard.addVRange(s, op.from, op.to);
          if (back) this.remapUndo(op.id, back.id);
          break;
        }
        case 'color':
          await this.writeDrawingColor(op.drawing, op.id, op.from);
          break;
        case 'vrange-move':
          await window.stockcard.updateVRange(s, op.id, op.from);
          break;
        default:
          break;
      }
    } catch (err) {
      console.error('[card] undo failed', err);
    }
  }

  /**
   * Ctrl+Z, scoped to this card's window. A global shortcut would steal Ctrl+Z
   * from every other application on the machine.
   *
   * Cards are shown without taking focus, but pressing a mouse button on one
   * activates its window -- and the mistake this undoes is always a drag, so
   * by the time the user reaches for Ctrl+Z the card has the keyboard.
   * `event.code` rather than `event.key`: with a Chinese IME active, `key`
   * can come through as "Process" instead of "z".
   */
  bindUndo() {
    this.undoStack = [];
    lastActive = this;
    this.onActivate = () => {
      lastActive = this;
    };
    this.root.addEventListener('pointerdown', this.onActivate, true);
    this.onUndoKey = (event) => {
      if (lastActive !== this) return;
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
      if (event.code !== 'KeyZ') return;
      // Inside a text field, Ctrl+Z belongs to the text.
      const t = event.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      event.preventDefault();
      this.undo();
    };
    window.addEventListener('keydown', this.onUndoKey);

    this.onResetKey = (event) => {
      if (lastActive !== this || !event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.code === 'KeyR') {
        event.preventDefault();
        this.resetView();
        return;
      }
      if (event.code === 'KeyH') {
        event.preventDefault();
        this.setDrawingsHidden(!this.card.hideDrawings);
        return;
      }
      // Alt+1..9, 0: the watchlist, in keyboard order (0 is the tenth).
      // `code` rather than `key`, so it works the same whatever the keyboard
      // layout or IME state.
      const digit = /^Digit([0-9])$/.exec(event.code);
      if (!digit) return;
      const entry = this.watchlistEntries()[watchIndex(digit[1])];
      if (!entry) return;
      event.preventDefault();
      this.watchlist.close();
      this.switchTo(entry);
    };
    window.addEventListener('keydown', this.onResetKey);

    // Escape puts any armed tool down and goes back to the cursor -- and gives
    // up a trend line drawn halfway (the measure box and open panels have
    // their own Escape, which still runs).
    this.onToolEscape = (event) => {
      if (event.key !== 'Escape' || lastActive !== this) return;
      this.cancelTrend();
      if (this.activeTool !== 'cursor') this.setActiveTool('cursor');
    };
    window.addEventListener('keydown', this.onToolEscape);

    this.offViewport = this.chart.onViewportChange(() => this.syncResetButton());
  }

  /**
   * True for a pointer event on something laid over the chart inside its
   * element -- the tool rail, the reset button, the funding chip -- rather
   * than on the chart itself. The drawing gestures listen on the chart
   * element in the capture phase, so without this a click on the rail was
   * also a click on the chart: with the trend tool armed, pressing the rail's
   * cursor button placed (or finished) a line under the rail.
   */
  offChart(event) {
    const root = this.chart && this.chart.chart.chartElement();
    return !root || !root.contains(event.target);
  }

  resetView() {
    if (!this.chart) return;
    this.chart.resetView();
    this.syncResetButton();
  }

  /** Called on every repaint, so it only touches the DOM when something changed. */
  syncResetButton() {
    if (!this.chart) return;
    const show = this.chart.isViewModified();
    if (this.resetBtn.hidden === !show && !show) return;
    this.resetBtn.hidden = !show;
    if (!show) return;
    const right = `${this.chart.priceScaleWidth() + 6}px`;
    const bottom = `${this.chart.timeScaleHeight() + 6}px`;
    if (this.resetBtn.style.right !== right) this.resetBtn.style.right = right;
    if (this.resetBtn.style.bottom !== bottom) this.resetBtn.style.bottom = bottom;
  }

  /* ----------------------------------------------------------------- rects */

  async loadRects() {
    const symbol = this.card.symbol;
    const rects = await window.stockcard.listRects(symbol);
    if (this.destroyed || symbol !== this.card.symbol) return;
    this.rects = rects;
    this.chart.rects.setRects(rects);
  }

  /**
   * Rectangles: arm the tool and drag one out. Afterwards:
   *
   *   drag a corner  reshape -- the opposite corner stays where it is
   *   drag an edge   move the whole zone
   *   double-click   delete (anywhere on it, inside included)
   *
   * The interior is not grabbable, on purpose. A zone is large and it is where
   * the user pans from; a grabbable interior would turn every pan that starts
   * inside a zone into dragging the zone -- the accidental-drag problem again,
   * only bigger. Ctrl magnets anchors to OHLC with the weak magnet, as for fibs.
   */
  bindRectInput() {
    const el = this.chartEl;
    const local = (event) => {
      const rect = el.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const prim = () => this.chart.rects;

    this.onRectDown = (event) => {
      if (this.offChart(event)) return; // the rail, reset button and such are not the chart
      if (event.button !== 0 || event.shiftKey) return;
      // Other armed tools own the pointer; only the cursor and rect tools may
      // grab or draw rectangles.
      if (this.activeTool !== 'cursor' && this.activeTool !== 'rect') return;
      const { x, y } = local(event);
      if (!this.chart.inPlot(x, y)) return; // the axes belong to the chart

      const hit = prim().hitTest(x, y);
      if (hit && hit.part !== 'inside') {
        const rect = this.rects.find((r) => r.id === hit.id);
        if (!rect) return;
        const orig = { a: { ...rect.a }, b: { ...rect.b } };
        if (hit.part === 'corner') {
          const minT = Math.min(rect.a.time, rect.b.time);
          const maxT = Math.max(rect.a.time, rect.b.time);
          const minP = Math.min(rect.a.price, rect.b.price);
          const maxP = Math.max(rect.a.price, rect.b.price);
          // Corners run clockwise from top-left; hold the diagonal opposite.
          const fixed = [
            { time: maxT, price: minP },
            { time: minT, price: minP },
            { time: minT, price: maxP },
            { time: maxT, price: maxP },
          ][hit.corner];
          // The corner being dragged, as it was: what Shift locks one axis to.
          const grab = { time: fixed.time === minT ? maxT : minT, price: fixed.price === minP ? maxP : minP };
          this.draggingRect = { id: hit.id, mode: 'corner', fixed, grab, orig, next: null };
        } else {
          // No magnet on the reference point: it only measures the offset, and
          // snapping it would make the zone jump the moment it is grabbed.
          const start = this.chart.anchorAt(x, y);
          if (!start) return;
          this.draggingRect = { id: hit.id, mode: 'move', start, startX: x, startY: y, orig, next: null };
        }
        prim().setActive(hit.id);
        this.chart.setInteractionEnabled(false);
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (this.activeTool !== 'rect') return;
      const anchor = this.chart.anchorAt(x, y, { magnet: event.ctrlKey });
      if (!anchor) return;
      this.drawingRect = { id: '__draft__', a: anchor, b: { ...anchor } };
      prim().setDraft({ ...this.drawingRect });
      this.chart.setInteractionEnabled(false);
      event.preventDefault();
      event.stopPropagation();
    };

    this.onRectMove = (event) => {
      const { x, y } = local(event);
      if (this.drawingRect) {
        const anchor = this.chart.anchorAt(x, y, { magnet: event.ctrlKey });
        if (!anchor) return;
        this.drawingRect.b = anchor;
        prim().setDraft({ ...this.drawingRect });
        return;
      }
      if (this.draggingRect) {
        this.rectPointer = { x, y, ctrlKey: event.ctrlKey };
        this.updateRectDrag(x, y, event.ctrlKey, event.shiftKey);
        return;
      }
      // Hover feedback -- but never while another tool is mid-gesture.
      if (this.draggingLevel || this.measuring || this.drawingFib || this.draggingFib || this.drawingTrend || this.draggingTrend) return;
      if (event.target !== el && !el.contains(event.target)) {
        prim().setActive(null);
        return;
      }
      const hit = prim().hitTest(x, y);
      const grabbable = hit && hit.part !== 'inside';
      prim().setActive(grabbable ? hit.id : null);
      if (hit && hit.part === 'corner') el.style.cursor = hit.corner % 2 === 0 ? 'nwse-resize' : 'nesw-resize';
      else if (hit && hit.part === 'edge') el.style.cursor = 'move';
    };

    this.onRectUp = async () => {
      if (this.drawingRect) {
        const draft = this.drawingRect;
        this.drawingRect = null;
        this.chart.setInteractionEnabled(true);
        prim().setDraft(null);
        // A click with no drag is not a zone; drop it.
        if (draft.a.price === draft.b.price || draft.a.time === draft.b.time) return;
        const added = await window.stockcard.addRect(this.card.symbol, draft.a, draft.b);
        if (added) this.pushUndo({ kind: 'rect-add', id: added.id });
        return;
      }
      if (this.draggingRect) {
        const d = this.draggingRect;
        this.draggingRect = null;
        this.rectPointer = null;
        this.chart.setInteractionEnabled(true);
        // The first click of a double-click arrives here without moving; not
        // an edit, and must not cost an undo step.
        if (!d.next) {
          prim().setDraft(null);
          return;
        }
        await window.stockcard.updateRect(this.card.symbol, d.id, d.next);
        // The store's broadcast has landed by the time the invoke resolves, so
        // dropping the draft now does not flash the old position.
        prim().setDraft(null);
        this.pushUndo({ kind: 'rect-move', id: d.id, from: d.orig });
      }
    };

    this.onRectDblClick = async (event) => {
      if (this.offChart(event)) return; // the rail, reset button and such are not the chart
      const { x, y } = local(event);
      const hit = prim().hitTest(x, y);
      if (!hit) return;
      // Otherwise the double-click falls through and drops a level as well.
      event.stopPropagation();
      const rect = this.rects.find((r) => r.id === hit.id);
      await window.stockcard.removeRect(this.card.symbol, hit.id);
      prim().setActive(null);
      if (rect) this.pushUndo({ kind: 'rect-remove', id: rect.id, a: { ...rect.a }, b: { ...rect.b }, color: rect.color });
    };

    // Pressing or releasing Shift mid-drag applies straight away, without
    // waiting for the pointer to move.
    this.onRectShift = (event) => {
      if (event.key !== 'Shift' || !this.draggingRect || !this.rectPointer) return;
      const p = this.rectPointer;
      this.updateRectDrag(p.x, p.y, p.ctrlKey, event.type === 'keydown');
    };

    el.addEventListener('mousedown', this.onRectDown, true);
    el.addEventListener('dblclick', this.onRectDblClick, true);
    window.addEventListener('mousemove', this.onRectMove);
    window.addEventListener('mouseup', this.onRectUp);
    window.addEventListener('keydown', this.onRectShift);
    window.addEventListener('keyup', this.onRectShift);
  }

  /**
   * One step of a rectangle drag, pointer at (x, y) in chart coordinates.
   *
   * Shift locks the drag to one axis, whichever the pointer has moved further
   * along: a corner then stretches only the time span or only the price span,
   * and a move slides only sideways or only up and down. So widening a zone no
   * longer means re-placing its corner by eye to keep the other edge where it
   * was. (Shift at *mousedown* is still the measure tool; the lock only
   * applies once a drag has started.)
   */
  updateRectDrag(x, y, ctrlKey, shiftKey) {
    const d = this.draggingRect;
    if (!d || !this.chart) return;
    if (d.mode === 'corner') {
      const anchor = this.chart.anchorAt(x, y, { magnet: ctrlKey });
      if (!anchor) return;
      let b = anchor;
      if (shiftKey) {
        const from = this.chart.anchorToPixel(d.grab);
        const horizontal = !from || Math.abs(x - from.x) >= Math.abs(y - from.y);
        b = horizontal ? { time: anchor.time, price: d.grab.price } : { time: d.grab.time, price: anchor.price };
      }
      d.next = { a: { ...d.fixed }, b };
    } else {
      const now = this.chart.anchorAt(x, y);
      if (!now) return;
      let dt = now.time - d.start.time;
      let dp = now.price - d.start.price;
      if (shiftKey) {
        if (Math.abs(x - d.startX) >= Math.abs(y - d.startY)) dp = 0;
        else dt = 0;
      }
      const move = (p) => ({ time: Math.round(p.time + dt), price: Number((p.price + dp).toFixed(this.chart.precision)) });
      d.next = { a: move(d.orig.a), b: move(d.orig.b) };
    }
    this.chart.rects.setDraft({ id: d.id, ...d.next });
  }

  /* ----------------------------------------------------------- trend lines */

  async loadTrends() {
    const symbol = this.card.symbol;
    const trendlines = await window.stockcard.listTrendlines(symbol);
    if (this.destroyed || symbol !== this.card.symbol) return;
    this.trends = trendlines;
    this.chart.trends.setLines(trendlines);
  }

  /**
   * Trend lines: a solid segment between two points, for sloped support.
   *
   *   draw          with the tool armed, drag from one end to the other -- or
   *                 click once for each end (the line follows the pointer in
   *                 between; Escape gives up)
   *   drag an end   move that end, the other stays put
   *   drag the line move the whole line
   *   double-click  delete
   *
   * Ctrl magnets an end to the nearest OHLC, as for rectangles and fibs.
   * Ends and the line are grabbable from the cursor tool too, like rectangles.
   */
  bindTrendInput() {
    const el = this.chartEl;
    const local = (event) => {
      const rect = el.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const prim = () => this.chart.trends;
    const otherGesture = () =>
      this.draggingLevel || this.measuring || this.drawingFib || this.draggingFib || this.drawingRect || this.draggingRect;

    this.onTrendDown = (event) => {
      if (this.offChart(event)) return; // the rail, reset button and such are not the chart
      if (event.button !== 0) return;
      // Shift is the measure gesture -- except with the trend tool armed, where
      // it straightens the line instead.
      if (event.shiftKey && this.activeTool !== 'trend') return;
      if (this.activeTool !== 'cursor' && this.activeTool !== 'trend') return;
      const { x, y } = local(event);
      if (!this.chart.inPlot(x, y)) return;

      // The second click of a click-click line places its far end.
      if (this.drawingTrend && this.drawingTrend.awaitingSecond) {
        const anchor = this.chart.anchorAt(x, y, { magnet: event.ctrlKey });
        if (anchor) this.drawingTrend.b = event.shiftKey ? this.straighten(this.drawingTrend.a, anchor, x, y) : anchor;
        this.finishTrend();
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const hit = prim().hitTest(x, y);
      if (hit) {
        const line = this.trends.find((l) => l.id === hit.id);
        if (!line) return;
        const orig = { a: { ...line.a }, b: { ...line.b } };
        if (hit.part === 'line') {
          // No magnet on the reference point: it only measures the offset.
          const start = this.chart.anchorAt(x, y);
          if (!start) return;
          this.draggingTrend = { id: hit.id, mode: 'move', start, startX: x, startY: y, orig, next: null };
        } else {
          this.draggingTrend = { id: hit.id, mode: 'end', end: hit.part, orig, next: null };
        }
        prim().setActive(hit.id);
        this.chart.setInteractionEnabled(false);
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (this.activeTool !== 'trend') return;
      const anchor = this.chart.anchorAt(x, y, { magnet: event.ctrlKey });
      if (!anchor) return;
      this.drawingTrend = { id: '__draft__', a: anchor, b: { ...anchor }, startX: x, startY: y, awaitingSecond: false };
      prim().setDraft({ id: '__draft__', a: anchor, b: { ...anchor } });
      this.chart.setInteractionEnabled(false);
      event.preventDefault();
      event.stopPropagation();
    };

    this.onTrendMove = (event) => {
      const { x, y } = local(event);
      if (this.drawingTrend || this.draggingTrend) {
        this.trendPointer = { x, y, ctrlKey: event.ctrlKey };
        this.updateTrendPointer(x, y, event.ctrlKey, event.shiftKey);
        return;
      }
      // Hover feedback -- never while another tool is mid-gesture.
      if (otherGesture()) return;
      if (event.target !== el && !el.contains(event.target)) {
        prim().setActive(null);
        return;
      }
      const hit = prim().hitTest(x, y);
      prim().setActive(hit ? hit.id : null);
      if (hit) el.style.cursor = hit.part === 'line' ? 'move' : 'grab';
    };

    this.onTrendUp = async (event) => {
      const t = this.drawingTrend;
      if (t && !t.awaitingSecond) {
        const { x, y } = local(event);
        if (Math.hypot(x - t.startX, y - t.startY) <= 4) {
          // A click, not a drag: the far end goes where the next click lands.
          t.awaitingSecond = true;
          return;
        }
        await this.finishTrend();
        return;
      }
      const d = this.draggingTrend;
      if (!d) return;
      this.draggingTrend = null;
      this.trendPointer = null;
      this.chart.setInteractionEnabled(true);
      // The first click of a double-click arrives here without moving; not
      // an edit, and must not cost an undo step.
      if (!d.next) {
        prim().setDraft(null);
        return;
      }
      await window.stockcard.updateTrendline(this.card.symbol, d.id, d.next);
      prim().setDraft(null);
      this.pushUndo({ kind: 'trend-move', id: d.id, from: d.orig });
    };

    this.onTrendDblClick = async (event) => {
      if (this.offChart(event)) return; // the rail, reset button and such are not the chart
      const { x, y } = local(event);
      const hit = prim().hitTest(x, y);
      if (!hit) return;
      // Otherwise the double-click falls through and drops a level as well.
      event.stopPropagation();
      const line = this.trends.find((l) => l.id === hit.id);
      await window.stockcard.removeTrendline(this.card.symbol, hit.id);
      prim().setActive(null);
      if (line) this.pushUndo({ kind: 'trend-remove', id: line.id, a: { ...line.a }, b: { ...line.b }, color: line.color });
    };

    // Pressing or releasing Shift mid-gesture applies at once, without
    // waiting for the pointer to move.
    this.onTrendKey = (event) => {
      if (event.key === 'Escape' && this.drawingTrend) {
        this.cancelTrend();
        return;
      }
      const p = this.trendPointer;
      if (event.key !== 'Shift' || !p || !(this.drawingTrend || this.draggingTrend)) return;
      this.updateTrendPointer(p.x, p.y, p.ctrlKey, event.type === 'keydown');
    };

    el.addEventListener('mousedown', this.onTrendDown, true);
    el.addEventListener('dblclick', this.onTrendDblClick, true);
    window.addEventListener('mousemove', this.onTrendMove);
    window.addEventListener('mouseup', this.onTrendUp);
    window.addEventListener('keydown', this.onTrendKey);
    window.addEventListener('keyup', this.onTrendKey);
  }

  /**
   * Lock `b` to the horizontal or the vertical through `a` -- whichever the
   * pointer at (x, y) is nearer to -- for Shift. Horizontal keeps a's price,
   * which is the straight line one usually wants; vertical keeps its time.
   */
  straighten(a, b, x, y) {
    const from = this.chart.anchorToPixel(a);
    const horizontal = !from || Math.abs(x - from.x) >= Math.abs(y - from.y);
    return horizontal ? { time: b.time, price: a.price } : { time: a.time, price: b.price };
  }

  /** One step of drawing or dragging a trend line, pointer at (x, y) in chart coordinates. */
  updateTrendPointer(x, y, ctrlKey, shiftKey) {
    const prim = this.chart.trends;
    const t = this.drawingTrend;
    if (t) {
      const anchor = this.chart.anchorAt(x, y, { magnet: ctrlKey });
      if (!anchor) return;
      t.b = shiftKey ? this.straighten(t.a, anchor, x, y) : anchor;
      prim.setDraft({ id: '__draft__', a: t.a, b: t.b });
      return;
    }
    const d = this.draggingTrend;
    if (!d) return;
    if (d.mode === 'end') {
      const anchor = this.chart.anchorAt(x, y, { magnet: ctrlKey });
      if (!anchor) return;
      const fixed = d.orig[d.end === 'a' ? 'b' : 'a'];
      d.next = { ...d.orig, [d.end]: shiftKey ? this.straighten(fixed, anchor, x, y) : anchor };
    } else {
      const now = this.chart.anchorAt(x, y);
      if (!now) return;
      let dt = now.time - d.start.time;
      let dp = now.price - d.start.price;
      // Shift slides the line only sideways or only up and down.
      if (shiftKey) {
        if (Math.abs(x - d.startX) >= Math.abs(y - d.startY)) dp = 0;
        else dt = 0;
      }
      const move = (p) => ({ time: Math.round(p.time + dt), price: Number((p.price + dp).toFixed(this.chart.precision)) });
      d.next = { a: move(d.orig.a), b: move(d.orig.b) };
    }
    prim.setDraft({ id: d.id, ...d.next });
  }

  async finishTrend() {
    const t = this.drawingTrend;
    this.drawingTrend = null;
    this.trendPointer = null;
    this.chart.setInteractionEnabled(true);
    this.chart.trends.setDraft(null);
    if (!t || (t.a.time === t.b.time && t.a.price === t.b.price)) return;
    const added = await window.stockcard.addTrendline(this.card.symbol, t.a, t.b);
    if (added) this.pushUndo({ kind: 'trend-add', id: added.id });
  }

  cancelTrend() {
    if (!this.drawingTrend) return;
    this.drawingTrend = null;
    this.chart.setInteractionEnabled(true);
    this.chart.trends.setDraft(null);
  }

  /* ------------------------------------------------------ range profiles */

  async loadVRanges() {
    const symbol = this.card.symbol;
    const vranges = await window.stockcard.listVRanges(symbol);
    if (this.destroyed || symbol !== this.card.symbol) return;
    this.vranges = vranges;
    this.syncVRanges();
  }

  /**
   * Fetch what each range needs and hand the lot to the chart. A range's bars
   * are keyed by market and span, so moving it, resizing it or switching the
   * card between spot and perp refetches, and nothing else does.
   *
   * Bars are the finest interval that keeps the span near 3,000 of them
   * (rangeInterval): 1m for up to two days. A closed range is read through
   * the bar cache; a "至今" one fetches only its tail each minute.
   */
  syncVRanges() {
    if (!this.chart) return;
    const ids = new Set(this.vranges.map((r) => r.id));
    for (const id of this.vrangeData.keys()) if (!ids.has(id)) this.vrangeData.delete(id);
    for (const range of this.vranges) {
      const key = `${this.card.market}|${range.from}|${range.to === null ? 'live' : range.to}`;
      const have = this.vrangeData.get(range.id);
      if (!have || have.key !== key) this.loadVRange(range, key);
    }
    clearInterval(this.vrangeTimer);
    this.vrangeTimer = null;
    if (this.vranges.some((r) => r.to === null)) {
      this.vrangeTimer = setInterval(() => this.refreshLiveVRanges(), 60000);
    }
    this.chart.vranges.set(this.vranges, this.vrangeData);
  }

  async loadVRange(range, key) {
    const { market, symbol } = this.card;
    const now = Math.floor(Date.now() / 1000);
    const to = range.to === null ? now : range.to;
    const interval = rangeInterval(to - range.from);
    const sec = intervalToMs(interval) / 1000;
    const entry = { key, interval, source: null, bars: [], loading: true, error: false };
    this.vrangeData.set(range.id, entry);
    try {
      let bars;
      if (range.to === null) {
        bars = await this.feedFor(market).getRange(symbol, interval, range.from * 1000, now * 1000);
      } else {
        const expect = Math.floor((range.to - range.from) / sec);
        bars = await this.fetchBars(market, symbol, interval, range.from, range.to - 1, expect);
      }
      if (this.destroyed || this.vrangeData.get(range.id) !== entry) return;
      entry.bars = bars.filter((b) => b.time >= range.from && (range.to === null || b.time < range.to));
      entry.source = new ProfileSource(entry.bars);
    } catch (err) {
      console.error('[card] range profile failed', err);
      entry.error = true;
    }
    entry.loading = false;
    if (this.chart) this.chart.vranges.update();
  }

  /** "至今" ranges: fetch from their newest bar on, replace it, rebuild. */
  async refreshLiveVRanges() {
    const { market, symbol } = this.card;
    for (const range of this.vranges) {
      if (range.to !== null) continue;
      const entry = this.vrangeData.get(range.id);
      if (!entry || entry.loading || !entry.bars.length) continue;
      const last = entry.bars[entry.bars.length - 1].time;
      try {
        const tail = await this.feedFor(market).getRange(symbol, entry.interval, last * 1000, Date.now());
        if (this.destroyed || this.vrangeData.get(range.id) !== entry || !tail.length) continue;
        entry.bars = [...entry.bars.filter((b) => b.time < tail[0].time), ...tail];
        entry.source = new ProfileSource(entry.bars);
      } catch (err) {
        console.error('[card] range profile refresh failed', err);
      }
    }
    if (this.chart) this.chart.vranges.update();
  }

  /**
   * Range profiles: arm the tool and drag across the chart, x1 to x2. Only
   * time matters, so the pointer's height is ignored. Edges snap to whole
   * bars of the card's interval, both end bars included; dragging onto the
   * newest bar makes the range "至今". The tool disarms after one range --
   * the next drag on the chart should pan, not draw a second.
   *
   *   drag an edge      resize that side
   *   drag the tag      move the whole range
   *   double-click      delete (edge or tag)
   */
  bindVRangeInput() {
    const el = this.chartEl;
    const local = (event) => {
      const rect = el.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const prim = () => this.chart.vranges;
    // Bar index under x, and the time a bar index starts at. An index at or
    // past the end of the loaded bars is "now": the range stays open.
    const indexAt = (x) => {
      const logical = this.chart.chart.timeScale().coordinateToLogical(x);
      return logical === null ? null : Math.round(logical);
    };
    const count = () => this.chart.bars.length;
    const timeOf = (i) => (i >= count() ? null : this.chart.timeFromLogical(i));
    const indexOf = (time) => (time === null ? count() : Math.round(this.chart.logicalFromTime(time)));
    const span = (a, b) => {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b) + 1;
      return { from: this.chart.timeFromLogical(lo), to: timeOf(hi) };
    };

    this.onVRangeDown = (event) => {
      if (this.offChart(event)) return; // the rail, reset button and such are not the chart
      if (event.button !== 0 || event.shiftKey || event.defaultPrevented) return;
      if (this.activeTool !== 'cursor' && this.activeTool !== 'vrange') return;
      const { x, y } = local(event);
      if (!this.chart.inPlot(x, y) || !this.chart.bars.length) return;
      const at = indexAt(x);
      if (at === null) return;

      const hit = prim().hitTest(x, y);
      if (hit) {
        const range = this.vranges.find((r) => r.id === hit.id);
        if (!range) return;
        this.draggingVRange = {
          id: range.id,
          part: hit.part,
          start: at,
          fromIdx: indexOf(range.from),
          toIdx: indexOf(range.to),
          orig: { from: range.from, to: range.to },
          next: null,
        };
      } else if (this.activeTool === 'vrange') {
        this.drawingVRange = { anchor: at };
        prim().setDraft({ id: '__draft__', ...span(at, at) });
      } else {
        return;
      }
      prim().setActive(hit ? hit.id : null);
      this.chart.setInteractionEnabled(false);
      event.preventDefault();
      event.stopPropagation();
    };

    this.onVRangeMove = (event) => {
      const { x, y } = local(event);
      if (this.drawingVRange) {
        const at = indexAt(x);
        if (at === null) return;
        this.drawingVRange.end = at;
        prim().setDraft({ id: '__draft__', ...span(this.drawingVRange.anchor, at) });
        return;
      }
      const d = this.draggingVRange;
      if (d) {
        const at = indexAt(x);
        if (at === null) return;
        const delta = at - d.start;
        let fromIdx = d.fromIdx;
        let toIdx = d.toIdx; // exclusive
        if (d.part === 'left') fromIdx = Math.min(d.fromIdx + delta, toIdx - 1);
        else if (d.part === 'right') toIdx = Math.min(count(), Math.max(d.toIdx + delta, fromIdx + 1));
        else {
          // Moving: never past the newest bar. A "至今" range moved left
          // becomes a closed one of the same width.
          const shift = Math.min(delta, count() - d.toIdx);
          fromIdx += shift;
          toIdx += shift;
        }
        d.next = { from: this.chart.timeFromLogical(fromIdx), to: timeOf(toIdx) };
        prim().setDraft({ id: d.id, ...d.next });
        return;
      }
      // Hover: light the range under the pointer and show what a drag does.
      if (this.draggingLevel || this.measuring || this.drawingFib || this.draggingFib || this.drawingRect || this.draggingRect || this.drawingTrend || this.draggingTrend) return;
      if (event.target !== el && !el.contains(event.target)) {
        prim().setActive(null);
        return;
      }
      const hit = this.chart.inPlot(x, y) ? prim().hitTest(x, y) : null;
      prim().setActive(hit ? hit.id : null);
      if (hit) el.style.cursor = hit.part === 'tag' ? 'move' : 'ew-resize';
    };

    this.onVRangeUp = async () => {
      if (this.drawingVRange) {
        const draw = this.drawingVRange;
        this.drawingVRange = null;
        this.chart.setInteractionEnabled(true);
        prim().setDraft(null);
        // A click with no drag is not a range.
        if (draw.end === undefined || draw.end === draw.anchor) return;
        const { from, to } = span(draw.anchor, draw.end);
        const added = await window.stockcard.addVRange(this.card.symbol, from, to);
        if (added) this.pushUndo({ kind: 'vrange-add', id: added.id });
        if (this.activeTool === 'vrange') this.setActiveTool('vrange');
        return;
      }
      const d = this.draggingVRange;
      if (d) {
        this.draggingVRange = null;
        this.chart.setInteractionEnabled(true);
        // The first click of a double-click arrives here without moving.
        if (!d.next || (d.next.from === d.orig.from && d.next.to === d.orig.to)) {
          prim().setDraft(null);
          return;
        }
        await window.stockcard.updateVRange(this.card.symbol, d.id, d.next);
        prim().setDraft(null);
        this.pushUndo({ kind: 'vrange-move', id: d.id, from: d.orig });
      }
    };

    this.onVRangeDblClick = async (event) => {
      if (this.offChart(event)) return; // the rail, reset button and such are not the chart
      const { x, y } = local(event);
      const hit = prim().hitTest(x, y);
      if (!hit) return;
      // Otherwise the double-click falls through and drops a level as well.
      event.stopPropagation();
      const range = this.vranges.find((r) => r.id === hit.id);
      await window.stockcard.removeVRange(this.card.symbol, hit.id);
      prim().setActive(null);
      if (range) this.pushUndo({ kind: 'vrange-remove', id: range.id, from: range.from, to: range.to });
    };

    el.addEventListener('mousedown', this.onVRangeDown, true);
    el.addEventListener('dblclick', this.onVRangeDblClick, true);
    window.addEventListener('mousemove', this.onVRangeMove);
    window.addEventListener('mouseup', this.onVRangeUp);
  }

  /* ------------------------------------------------------------------ fibs */

  async loadFibs() {
    const symbol = this.card.symbol;
    const fibs = await window.stockcard.listFibs(symbol);
    if (this.destroyed || symbol !== this.card.symbol) return;
    this.fibs = fibs;
    this.renderFibs();
  }

  /**
   * Hand the retracements to the chart, which draws them (fib-primitive.js).
   * Positioning is not this method's job any more: the chart re-projects them
   * on every viewport change, in the same frame as the candles.
   */
  renderFibs() {
    if (!this.chart) return;
    this.chart.fibLayer.set(this.fibs, this.drawingFib, this.activeFibId);
  }

  /**
   * Fibonacci: arm the tool, then drag out the swing. Ctrl magnets both ends,
   * which is the point -- a retracement is only worth anything if it is pinned
   * to the actual swing high and low rather than near them.
   *
   * Dragging either handle afterwards re-anchors that end; double-clicking a
   * handle deletes the whole retracement.
   */
  bindFibInput() {
    const el = this.chartEl;
    const local = (event) => {
      const rect = el.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    this.onFibDown = (event) => {
      if (this.offChart(event)) return; // the rail, reset button and such are not the chart
      if (event.button !== 0 || event.shiftKey) return;
      const { x, y } = local(event);
      if (!this.chart.inPlot(x, y)) return; // the axes belong to the chart

      // Grabbing an existing handle takes priority over starting a new one, so
      // an armed tool can still adjust what is already on the chart.
      const grabbed = this.fibHandleAt(event);
      if (grabbed) {
        const fib = this.fibs.find((f) => f.id === grabbed.id);
        // Copy, not reference: the drag mutates this anchor in place.
        this.draggingFib = { ...grabbed, from: fib ? { ...fib[grabbed.end] } : null };
        this.activeFibId = grabbed.id;
        this.chart.setInteractionEnabled(false);
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (this.activeTool !== 'fib') return;
      const anchor = this.chart.anchorAt(x, y, { magnet: event.ctrlKey });
      if (!anchor) return;
      this.drawingFib = { id: '__draft__', a: anchor, b: { ...anchor } };
      this.chart.setInteractionEnabled(false);
      this.renderFibs();
      event.preventDefault();
      event.stopPropagation();
    };

    this.onFibMove = (event) => {
      if (!this.drawingFib && !this.draggingFib) {
        if (this.draggingLevel || this.measuring || this.drawingRect || this.draggingRect || this.drawingTrend || this.draggingTrend) return;
        const inside = event.target === el || el.contains(event.target);
        const hit = inside ? this.fibHandleAt(event) : null;
        this.chart.fibLayer.setHover(hit);
        if (hit) el.style.cursor = 'grab';
        return;
      }
      const { x, y } = local(event);
      const anchor = this.chart.anchorAt(x, y, { magnet: event.ctrlKey });
      if (!anchor) return;
      if (this.drawingFib) {
        this.drawingFib.b = anchor;
      } else {
        const fib = this.fibs.find((f) => f.id === this.draggingFib.id);
        if (fib) fib[this.draggingFib.end] = anchor;
      }
      this.renderFibs();
    };

    this.onFibUp = async () => {
      if (this.drawingFib) {
        const draft = this.drawingFib;
        this.drawingFib = null;
        this.chart.setInteractionEnabled(true);
        // A click with no drag is not a retracement; drop it silently.
        if (draft.a.price !== draft.b.price) {
          const added = await window.stockcard.addFib(this.card.symbol, draft.a, draft.b);
          if (added) this.pushUndo({ kind: 'fib-add', id: added.id });
        } else {
          this.renderFibs();
        }
        return;
      }
      if (this.draggingFib) {
        const { id, end, from } = this.draggingFib;
        this.draggingFib = null;
        this.activeFibId = null;
        this.chart.setInteractionEnabled(true);
        const fib = this.fibs.find((f) => f.id === id);
        if (!fib) return;
        // The first click of a double-click lands here too, without moving
        // anything; that is not an edit and must not cost an undo step.
        const moved = from && (fib[end].time !== from.time || fib[end].price !== from.price);
        if (!moved) return;
        await window.stockcard.updateFib(this.card.symbol, id, { [end]: fib[end] });
        this.pushUndo({ kind: 'fib-move', id, end, from });
      }
    };

    this.onFibDblClick = async (event) => {
      if (this.offChart(event)) return; // the rail, reset button and such are not the chart
      const grabbed = this.fibHandleAt(event);
      if (!grabbed) return;
      event.stopPropagation();
      const fib = this.fibs.find((f) => f.id === grabbed.id);
      await window.stockcard.removeFib(this.card.symbol, grabbed.id);
      if (fib) this.pushUndo({ kind: 'fib-remove', id: fib.id, a: { ...fib.a }, b: { ...fib.b } });
    };

    el.addEventListener('mousedown', this.onFibDown, true);
    el.addEventListener('dblclick', this.onFibDblClick, true);
    window.addEventListener('mousemove', this.onFibMove);
    window.addEventListener('mouseup', this.onFibUp);
  }

  /**
   * The retracement handle under a pointer event, by distance. The handles are
   * painted on the chart's canvas now, so there is no DOM element to ask.
   */
  fibHandleAt(event) {
    if (!this.chart) return null;
    const rect = this.chartEl.getBoundingClientRect();
    return this.chart.fibLayer.hitTest(event.clientX - rect.left, event.clientY - rect.top);
  }

  /* -------------------------------------------------------------- measure */

  /**
   * Shift-drag to measure, the way TradingView does it.
   *
   * Deliberately a gesture and not a toolbar button: TradingView puts its own
   * quick measure on Shift-drag too, and on a card this size a gesture costs no
   * pixels. Ctrl still magnets, so Shift+Ctrl measures wick to wick.
   *
   * Anchors are logical (fractional bar index) rather than pixels, so the box
   * tracks the candles through panning and zooming instead of floating in
   * place, and still resolves out in the rightOffset gap past the last bar.
   */
  bindMeasureInput(local) {
    const el = this.chartEl;

    this.onMeasureDown = (event) => {
      if (this.offChart(event)) return; // the rail, reset button and such are not the chart
      // Shift is the shortcut and works in any mode; the armed tool needs no
      // modifier at all.
      if (event.button !== 0) return;
      if (!event.shiftKey && this.activeTool !== 'measure') return;
      // With the trend tool armed, Shift straightens the line instead.
      if (this.activeTool === 'trend') return;
      const { x, y } = local(event);
      if (!this.chart.inPlot(x, y)) return; // the axes belong to the chart
      const from = this.chart.pointAt(x, y, { magnet: event.ctrlKey });
      if (!from) return;
      this.measuring = { from, to: from };
      this.chart.setInteractionEnabled(false);
      this.renderMeasure();
      event.preventDefault();
      event.stopPropagation();
    };

    this.onMeasureMove = (event) => {
      if (!this.measuring || this.measuring.held) return;
      const { x, y } = local(event);
      const to = this.chart.pointAt(x, y, { magnet: event.ctrlKey });
      if (!to) return;
      this.measuring.to = to;
      this.renderMeasure();
    };

    this.onMeasureUp = () => {
      if (!this.measuring) return;
      // The readout stays after release so it can actually be read; any plain
      // click or Escape clears it.
      this.chart.setInteractionEnabled(true);
      this.measuring.held = true;
    };

    this.onMeasureDismiss = (event) => {
      if (!this.measuring || !this.measuring.held) return;
      if (event && event.shiftKey) return;
      this.measuring = null;
      this.chart.measureLayer.set(null);
    };

    // The drawings follow the viewport by themselves now (they are painted by
    // the chart); what is left here is data that depends on the visible range.
    this.offRangeChange = this.chart.onVisibleRangeChange((range) => {
      this.renderHtf();
      if (this.card.volumeProfile === 'session4h') {
        clearTimeout(this.periodScrollTimer);
        this.periodScrollTimer = setTimeout(() => this.loadPeriodProfiles(), 300);
      }
      // `from` is a logical index; negative means the view has run off the
      // start of the loaded data.
      if (range && range.from < HISTORY_PREFETCH_BARS) this.extendHistory();
    });

    el.addEventListener('mousedown', this.onMeasureDown, true);
    window.addEventListener('mousemove', this.onMeasureMove);
    window.addEventListener('mouseup', this.onMeasureUp);
    window.addEventListener('mousedown', this.onMeasureDismiss);
  }

  dismissMeasure() {
    if (!this.measuring) return;
    this.measuring = null;
    this.chart.measureLayer.set(null);
    this.chart.setInteractionEnabled(true);
  }

  /** Hand the span to the chart, which draws it (measure-primitive.js). */
  renderMeasure() {
    const m = this.measuring;
    if (!m || !this.chart) return;
    this.chart.measureLayer.set({ from: m.from, to: m.to });
  }

  destroy() {
    this.destroyed = true;
    this.loadSeq += 1; // invalidate any in-flight load
    if (this.offStatus) this.offStatus.forEach((off) => off());
    clearInterval(this.fundingTimer);
    clearTimeout(this.noticeTimer);
    clearTimeout(this.levelsTimer);
    if (this.offAlertState) this.offAlertState();
    if (this.offAlertFired) this.offAlertFired();
    if (this.onAcknowledge) this.root.removeEventListener('pointerdown', this.onAcknowledge, true);
    if (this.offLevels) this.offLevels();
    this.closePalette();
    if (this.onDrawingContext) this.chartEl.removeEventListener('contextmenu', this.onDrawingContext);
    if (this.onLevelDblClick) {
      this.chartEl.removeEventListener('dblclick', this.onLevelDblClick);
      this.chartEl.removeEventListener('click', this.onLevelClick);
      this.chartEl.removeEventListener('mousedown', this.onLevelDown, true);
      this.chartEl.removeEventListener('mousemove', this.onLevelMove);
      window.removeEventListener('mouseup', this.onLevelUp);
    }
    if (this.onMeasureDown) {
      this.chartEl.removeEventListener('mousedown', this.onMeasureDown, true);
      window.removeEventListener('mousemove', this.onMeasureMove);
      window.removeEventListener('mouseup', this.onMeasureUp);
      window.removeEventListener('mousedown', this.onMeasureDismiss);
    }
    if (this.onFibDown) {
      this.chartEl.removeEventListener('mousedown', this.onFibDown, true);
      this.chartEl.removeEventListener('dblclick', this.onFibDblClick, true);
      window.removeEventListener('mousemove', this.onFibMove);
      window.removeEventListener('mouseup', this.onFibUp);
    }
    clearTimeout(this.fibProjectTimer);
    clearInterval(this.profileTimer);
    clearTimeout(this.periodScrollTimer);
    this.toolbar.destroy();
    this.watchlist.destroy();
    if (this.offFibs) this.offFibs();
    if (this.offRects) this.offRects();
    if (this.offVRanges) this.offVRanges();
    clearInterval(this.vrangeTimer);
    if (this.onVRangeDown) {
      this.chartEl.removeEventListener('mousedown', this.onVRangeDown, true);
      this.chartEl.removeEventListener('dblclick', this.onVRangeDblClick, true);
      window.removeEventListener('mousemove', this.onVRangeMove);
      window.removeEventListener('mouseup', this.onVRangeUp);
    }
    if (this.offTrends) this.offTrends();
    if (this.onTrendDown) {
      this.chartEl.removeEventListener('mousedown', this.onTrendDown, true);
      this.chartEl.removeEventListener('dblclick', this.onTrendDblClick, true);
      window.removeEventListener('mousemove', this.onTrendMove);
      window.removeEventListener('mouseup', this.onTrendUp);
      window.removeEventListener('keydown', this.onTrendKey);
      window.removeEventListener('keyup', this.onTrendKey);
    }
    if (this.onRectDown) {
      this.chartEl.removeEventListener('mousedown', this.onRectDown, true);
      this.chartEl.removeEventListener('dblclick', this.onRectDblClick, true);
      window.removeEventListener('mousemove', this.onRectMove);
      window.removeEventListener('mouseup', this.onRectUp);
      window.removeEventListener('keydown', this.onRectShift);
      window.removeEventListener('keyup', this.onRectShift);
    }
    if (this.onUndoKey) window.removeEventListener('keydown', this.onUndoKey);
    if (this.onResetKey) window.removeEventListener('keydown', this.onResetKey);
    if (this.onToolEscape) window.removeEventListener('keydown', this.onToolEscape);
    if (this.offViewport) this.offViewport();
    if (this.onActivate) this.root.removeEventListener('pointerdown', this.onActivate, true);
    if (lastActive === this) lastActive = null;
    if (this.offRangeChange) this.offRangeChange();
    if (this.trade) this.trade.destroy();
    if (this.priceAlerts) this.priceAlerts.destroy();
    this.feed.unsubscribe(this.card.id);
    this.feed.unsubscribe(`${this.card.id}:htf`);
    if (this.chart) this.chart.destroy();
    this.root.remove();
  }

  pause() {
    if (this.chart) this.chart.pause();
  }

  resume() {
    if (this.chart) this.chart.resume();
  }

  resize() {
    if (this.chart) this.chart.resize();
  }

  /* ----------------------------------------------------------------- data */

  async loadData() {
    const seq = ++this.loadSeq;
    const { market, symbol, interval } = this.card;
    const feed = this.feed;

    this.setOverlay(t('載入中…'));
    try {
      const bars = await feed.getHistory(symbol, interval, HISTORY_LIMIT);
      if (seq !== this.loadSeq || this.destroyed) return;
      // Everything closed goes to disk, so the next launch starts from a file.
      const closed = bars.filter((b) => b.closed);
      if (closed.length) window.stockcard.writeBars(market, symbol, interval, closed);

      if (!bars.length) {
        this.setOverlay(t('沒有資料'), true);
        return;
      }

      this.chart.setData(bars);
      this.historyExhausted = false;
      this.loadOI();
      this.lastBar = bars[bars.length - 1];
      this.setOverlay(null);
      this.renderQuote();
      // The per-4h profiles depend on which blocks are in view, and right
      // after setData the time scale has not laid out, so the visible range
      // is not there to ask yet. Wait a tick. setTimeout and not
      // requestAnimationFrame, because a hidden card's frames are throttled
      // and this still has to happen when it comes back.
      this.dismissMeasure();
      clearTimeout(this.fibProjectTimer);
      this.fibProjectTimer = setTimeout(() => {
        this.renderHtf();
        if (this.card.volumeProfile === 'session4h') this.loadPeriodProfiles();
      }, 0);
      this.subscribe();
      if (this.card.footprint) this.loadFootprint();

      feed
        .getTicker(symbol)
        .then((ticker) => {
          if (seq === this.loadSeq && !this.destroyed) this.applyTicker(ticker);
        })
        .catch(() => {
          /* the miniTicker stream will fill this in shortly */
        });

      if (market === 'perp') {
        feed
          .getFunding(symbol)
          .then((funding) => {
            if (seq === this.loadSeq && !this.destroyed) this.applyFunding(funding);
          })
          .catch(() => {
            /* the markPrice stream carries it too, every 3s */
          });
      }
    } catch (err) {
      if (seq !== this.loadSeq || this.destroyed) return;
      this.setOverlay(t('載入失敗:{error}', { error: err.message }), true);
    }
  }

  subscribe() {
    // subId is the card id, so re-subscribing after a symbol change replaces
    // the previous stream instead of stacking a second one.
    this.feed.subscribe(this.card.id, this.card.symbol, this.card.interval, {
      onBar: (bar) => {
        if (this.destroyed) return;
        this.chart.update(bar);
        this.lastBar = bar;
        this.renderQuote();
        if (this.periodLevelsData && this.periodLevelsData.length) {
          const moved = updateCurrentExtremes(this.periodLevelsData, bar);
          if (moved) {
            this.periodLevelsData = moved;
            this.chart.setPeriodLevels(moved);
          }
        }
      },
      onTicker: (ticker) => {
        if (this.destroyed) return;
        if (ticker.symbol === this.card.symbol) this.applyTicker(ticker);
      },
      onFunding: (funding) => {
        if (this.destroyed) return;
        if (funding.symbol === this.card.symbol) this.applyFunding(funding);
      },
      onOI: (oi) => {
        if (!this.destroyed) this.applyLiveOI(oi);
      },
      onFootprint: (records) => this.applyFootprint(records),
    });
  }

  applyTicker(ticker) {
    this.ticker = ticker;
    this.renderQuote();
  }

  applyFunding(funding) {
    this.funding = funding && this.card.market === 'perp' ? funding : null;
    this.renderFunding();
    if (this.trade && this.funding) {
      this.trade.setMark(this.funding.markPrice);
      this.trade.setFunding();
    }
  }

  /**
   * Ticks once a second for the countdown. The rate itself only changes when
   * the markPrice stream says so; the clock is computed here, so it keeps
   * counting between frames and through a dropped feed.
   */
  renderFunding() {
    const f = this.funding;
    if (!f || this.card.market !== 'perp' || !Number.isFinite(f.fundingRate)) {
      this.fundingEl.hidden = true;
      return;
    }
    this.fundingEl.hidden = false;
    this.fundingRateEl.textContent = formatFundingRate(f.fundingRate);
    const left = f.nextFundingTime - Date.now();
    // Zero until the exchange rolls nextFundingTime forward, a few seconds on.
    this.fundingTimeEl.textContent = left > 0 ? formatCountdown(left) : t('結算中');
    if (this.chart) {
      const right = `${this.chart.priceScaleWidth() + 6}px`;
      if (this.fundingEl.style.right !== right) this.fundingEl.style.right = right;
    }
  }

  /* --------------------------------------------------------------- market */

  /**
   * Look up this symbol's name on the other market, ahead of any click, so the
   * chip can say up front when there is nothing to switch to.
   *
   * Resolves to the symbol, null when the other market does not list it, or
   * undefined when the lookup itself failed (offline) and is worth retrying.
   */
  refreshCounterpart() {
    const key = this.dataKey();
    const job = {
      key,
      promise: this.feed.counterpart(this.card.symbol, otherMarket(this.card.market)).catch(() => undefined),
    };
    this.counterpartJob = job;
    this.renderMarket();
    job.promise.then((symbol) => {
      job.symbol = symbol;
      if (!this.destroyed && this.counterpartJob === job) this.renderMarket();
    });
    return job;
  }

  /**
   * Move the card to `market`, taking the symbol along -- including where the
   * other market names it differently (PEPEUSDT on spot is 1000PEPEUSDT on
   * perp). Drawings are keyed by symbol, so plain BTCUSDT keeps every line.
   */
  async setMarket(market) {
    if (!MARKET_IDS.includes(market) || market === this.card.market) return;
    const key = this.dataKey();
    let job = this.counterpartJob && this.counterpartJob.key === key ? this.counterpartJob : this.refreshCounterpart();
    let target = await job.promise;
    if (target === undefined) {
      job = this.refreshCounterpart();
      target = await job.promise;
    }
    // Another switch landed while we were waiting; that one wins.
    if (this.destroyed || key !== this.dataKey()) return;
    if (!target) {
      this.notify(
        target === null
          ? t('{symbol} 沒有{market}', { symbol: prettySymbol(this.card.symbol), market: MARKET_LABELS[market] })
          : t('無法取得交易對清單，請稍後再試')
      );
      this.panel.update(this.card); // put the panel's market control back
      return;
    }
    this.onPatch({ market, symbol: target });
  }

  renderMarket() {
    const { market, symbol } = this.card;
    const other = MARKET_LABELS[otherMarket(market)];
    const job = this.counterpartJob;
    const resolved = job && job.key === this.dataKey() ? job.symbol : undefined;
    this.marketBtn.textContent = MARKET_LABELS[market] || market;
    this.marketBtn.classList.toggle('is-perp', market === 'perp');
    this.marketBtn.classList.toggle('is-unavailable', resolved === null);
    this.marketBtn.title =
      resolved === null
        ? t('{symbol} 沒有{market}', { symbol: prettySymbol(symbol), market: other })
        : resolved && resolved !== symbol
          ? t('切換到{market} ({symbol})', { market: other, symbol: prettySymbol(resolved) })
          : t('切換到{market}', { market: other });
  }

  /** A short message over the chart that clears itself. */
  notify(text) {
    clearTimeout(this.noticeTimer);
    this.noticeEl.textContent = text;
    this.noticeEl.hidden = false;
    this.noticeTimer = setTimeout(() => {
      this.noticeEl.hidden = true;
    }, NOTICE_MS);
  }

  /* --------------------------------------------------------------- render */

  renderIdentity() {
    this.symbolText.textContent = prettySymbol(this.card.symbol);
    this.renderMarket();
    this.renderWatch();
    this.intervalEl.textContent = INTERVAL_LABELS[this.card.interval] || this.card.interval;
    this.pinBtn.classList.toggle('is-active', this.card.alwaysOnTop);
    this.root.title = '';
  }

  renderQuote() {
    const last = this.lastBar ? this.lastBar.close : this.ticker ? this.ticker.last : null;
    this.priceEl.textContent = last === null ? '—' : formatPrice(last);

    const change = this.ticker ? this.ticker.changePercent : null;
    this.changeEl.textContent = change === null ? '—' : formatPercent(change);

    if (change === null) {
      this.changeEl.classList.remove('is-up', 'is-down');
      return;
    }

    // `.is-up` is the green class. Under the "red means up" convention a rising
    // price should be red, so the two flags must agree for green to win.
    const rising = change >= 0;
    const upIsGreen = this.prefs.upDownColor !== 'redUp';
    this.changeEl.classList.toggle('is-up', rising === upIsGreen);
    this.changeEl.classList.toggle('is-down', rising !== upIsGreen);
  }

  /**
   * Instant local feedback for a control whose store write is debounced,
   * so an opacity slider tracks the pointer instead of the disk.
   */
  preview(patch) {
    if ('cardOpacity' in patch) {
      this.card = { ...this.card, cardOpacity: patch.cardOpacity };
      this.applyOpacity();
    }
  }

  /** @param {string|null} message  null clears the overlay */
  setOverlay(message, showRetry = false) {
    if (!message) {
      this.overlay.hidden = true;
      return;
    }
    this.overlay.hidden = false;
    this.overlayText.textContent = message;
    this.retryBtn.hidden = !showRetry;
  }

  setStatus(status) {
    this.status = status;
    this.dot.dataset.status = status;
    this.dot.title = STATUS_LABELS[status] || status;

    // The dot is 6px and its tooltip needs a hover that click-through mode will
    // never deliver, so trouble gets said in words as well.
    const badge = STATUS_BADGES[status];
    this.link.hidden = !badge;
    this.link.textContent = badge || '';
    this.link.title = badge ? STATUS_LABELS[status] || status : '';
    if (badge) this.link.dataset.status = status;
    else delete this.link.dataset.status;
  }

  setClickThrough(enabled) {
    this.unlock.hidden = !enabled;
    this.root.classList.toggle('is-click-through', !!enabled);
  }

  applyOpacity() {
    // Only the card background alpha changes; text and chart stay fully opaque.
    this.root.style.setProperty('--card-alpha', String(this.card.cardOpacity));
  }

  setPrefs(prefs) {
    this.prefs = prefs;
    if (this.chart) {
      this.chart.setUpDownColor(prefs.upDownColor);
      this.chart.setTimezone(prefs.timezone);
    }
    this.panel.updatePrefs(prefs);
    this.renderQuote();
    this.renderWatch();
    this.renderPosition();
  }

  /* ------------------------------------------------------------ watchlist */

  watchlistEntries() {
    return Array.isArray(this.prefs && this.prefs.watchlist) ? this.prefs.watchlist : [];
  }

  currentEntry() {
    return { symbol: this.card.symbol, market: this.card.market };
  }

  /** Persisted globally; every card's star and dropdown follow via onPrefs. */
  setWatchlist(list) {
    window.stockcard.setPrefs({ watchlist: list.slice(0, WATCHLIST_MAX) });
  }

  toggleWatch() {
    const list = this.watchlistEntries();
    const current = this.currentEntry();
    if (list.some((e) => sameEntry(e, current))) {
      this.setWatchlist(list.filter((e) => !sameEntry(e, current)));
    } else if (list.length < WATCHLIST_MAX) {
      this.setWatchlist([...list, current]);
    } else {
      // Full: show the list, which is where one can be removed to make room.
      this.watchlist.open();
    }
  }

  /** A watchlist pick: symbol and market together. */
  switchTo(entry) {
    if (!entry || sameEntry(entry, this.currentEntry())) return;
    this.onPatch({ symbol: entry.symbol, market: entry.market });
  }

  renderWatch() {
    const list = this.watchlistEntries();
    const current = this.currentEntry();
    const watched = list.some((e) => sameEntry(e, current));
    this.starBtn.textContent = watched ? '★' : '☆';
    this.starBtn.classList.toggle('is-active', watched);
    this.starBtn.title = watched
      ? t('把 {name} 從常用清單移除', { name: entryLabel(current) })
      : list.length >= WATCHLIST_MAX
        ? t('常用清單已滿 (最多 {max} 個)', { max: WATCHLIST_MAX })
        : t('把 {name} 加入常用清單（並監控 4H / 24H / 72H 位置）', { name: entryLabel(current) });
    this.watchlist.setState(list, current, !this.prefs.alerts || this.prefs.alerts.enabled !== false);
  }

  /**
   * Apply a new card record (from the store) and do only the work each change
   * actually requires — a chart-type switch must not refetch history.
   */
  applyCard(next) {
    const prev = this.card;
    this.card = next;

    const marketChanged = next.market !== prev.market;
    const symbolChanged = marketChanged || next.symbol !== prev.symbol || next.interval !== prev.interval;

    if (marketChanged) {
      // Both streams move to the other market's socket. subscribe() on the new
      // side does not reach the old one, so release it here, explicitly.
      const old = this.feedFor(prev.market);
      old.unsubscribe(prev.id);
      old.unsubscribe(`${prev.id}:htf`);
      this.setStatus(this.feed.getStatus());
      this.funding = null;
      this.renderFunding();
    }

    if (next.cardOpacity !== prev.cardOpacity) this.applyOpacity();
    if (this.chart) {
      if (next.chartType !== prev.chartType) this.chart.setChartType(next.chartType);
      if (next.showVolume !== prev.showVolume) this.chart.setVolumeVisible(next.showVolume);
      if (next.volSqueeze !== prev.volSqueeze || next.volMemory !== prev.volMemory || next.interval !== prev.interval) {
        this.applyVolumeOptions();
      }
      if (next.volumeProfile !== prev.volumeProfile) this.applyVolumeProfile(next.volumeProfile);
      if (next.vpDetail !== prev.vpDetail) this.applyVpDetail();
      // A symbol or market change reloads opens below. An interval change does
      // not -- the opens are the same on every interval -- so it must not stop
      // a toggle that arrives in the same patch from loading them.
      const identityChanged = next.symbol !== prev.symbol || marketChanged;
      const levelsChanged =
        next.showOpens !== prev.showOpens ||
        next.levelAnchor !== prev.levelAnchor ||
        next.opensWhich !== prev.opensWhich ||
        next.hilo !== prev.hilo ||
        String(next.levelPeriods) !== String(prev.levelPeriods);
      if (levelsChanged && !identityChanged) this.loadPeriodLevels();
      if (next.showOI !== prev.showOI || marketChanged) {
        this.chart.setOIVisible(this.oiApplies());
        // A symbol or market change reloads it with the bars, below.
        if (!symbolChanged && this.oiApplies()) this.loadOI();
      }
      // A symbol, market or interval change reloads it with the bars, below.
      if ((next.footprint !== prev.footprint || next.fpRatio !== prev.fpRatio) && !symbolChanged) {
        if (next.footprint !== prev.footprint) this.loadFootprint();
        else this.chart.setFootprint(this.fpBook, Number(next.fpRatio) || 3);
      }
      if (!!next.hideDrawings !== !!prev.hideDrawings) this.chart.setDrawingsHidden(next.hideDrawings);
      const htfChanged = next.showHtf !== prev.showHtf || (next.htfInterval || '4h') !== (prev.htfInterval || '4h');
      if (htfChanged && !marketChanged) {
        // A new interval is a new stream and new bars: drop the old first.
        this.feed.unsubscribe(`${this.card.id}:htf`);
        this.htfBars = [];
        this.renderHtf();
        if (next.showHtf) this.setHtfEnabled(true);
      }
    }

    this.renderIdentity();
    this.renderRail();
    this.panel.update(next);
    if (this.trade && (next.symbol !== prev.symbol || marketChanged)) this.trade.sync();
    if (this.priceAlerts && (next.symbol !== prev.symbol || marketChanged)) this.priceAlerts.render();

    if (symbolChanged) {
      this.ticker = null;
      this.lastBar = null;
      this.renderQuote();
      if (next.symbol !== prev.symbol || marketChanged) {
        this.refreshCounterpart();
        this.resetOI();
        this.periodLevelsData = [];
        this.chart.setPeriodLevels([]);
        if (this.levelsWanted()) this.loadPeriodLevels();
        this.position = null;
        this.alerting = null;
        this.root.classList.remove('is-alerting');
        delete this.root.dataset.alertSide;
        this.renderPosition();
        this.loadPosition();
      }
      // Levels belong to the symbol, so a symbol switch swaps the whole set.
      // A market switch that keeps the name keeps them too: BTCUSDT's lines
      // are the same lines on spot and perp, and so is its undo history.
      if (next.symbol !== prev.symbol) {
        this.chart.setLevels([]);
        this.loadLevels();
        this.fibs = [];
        this.chart.fibLayer.set([]);
        this.loadFibs();
        this.rects = [];
        this.chart.rects.setRects([]);
        this.loadRects();
        this.cancelTrend();
        this.trends = [];
        this.chart.trends.setLines([]);
        this.loadTrends();
        this.vranges = [];
        this.vrangeData.clear();
        this.chart.vranges.set([], this.vrangeData);
        this.loadVRanges();
        // Undo entries belong to the symbol they were recorded on; replaying
        // them after a switch would edit drawings that are not on screen.
        this.undoStack = [];
      }
      // Profiles and the 4h overlay are built from the market's own candles.
      if (next.symbol !== prev.symbol || marketChanged) {
        this.periodCache.clear();
        this.applyVolumeProfile(this.card.volumeProfile || 'off');
        // Same ranges, the other market's volume: the data key has changed.
        if (next.symbol === prev.symbol) this.syncVRanges();
        this.htfBars = [];
        this.renderHtf();
        if (this.card.showHtf) this.setHtfEnabled(true);
      }
      this.loadData();
    }
  }
}
