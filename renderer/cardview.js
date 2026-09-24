/**
 * CardView — one chart card, rendered identically in Float and Board mode.
 *
 * Both modes share this component so that switching between them is purely a
 * window-management concern: card behaviour, settings and data wiring have a
 * single implementation, which is what keeps settings intact across a mode
 * switch (spec 4.1).
 */

import { CardChart } from './chart.js';
import { SettingsPanel } from './ui/settings-panel.js';
import { Toolbar } from './ui/toolbar.js';
import { WatchlistMenu, WATCHLIST_MAX, sameEntry, entryLabel } from './ui/watchlist.js';
import { buildProfile, buildPeriodProfiles, sessionBounds, PERIOD_4H } from './volume-profile.js';
import { intervalToMs } from './datafeed/provider.js';
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

const HISTORY_LIMIT = 500;

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
const HTF_INTERVAL = '4h';
const HTF_SECONDS = 4 * 3600;
const HTF_COUNT = 10;
const HTF_BELOW = ['1m', '5m', '15m', '1h'];

const MARKET_IDS = Object.keys(MARKET_LABELS);
const otherMarket = (market) => (market === 'perp' ? 'spot' : 'perp');

/** How long "no perpetual for this symbol" and the like stay on screen. */
const NOTICE_MS = 2200;

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
        title: '常用幣種 (Alt+1~6 快速切換)',
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
      title: '切換置頂',
      text: '📌',
      onclick: () => this.onPatch({ alwaysOnTop: !this.card.alwaysOnTop }),
    });

    this.gearBtn = el('button.sc-icon-btn', {
      type: 'button',
      title: '設定',
      text: '⚙',
      onclick: () => this.panel.toggle(),
    });

    this.lockBtn = el('button.sc-icon-btn', {
      type: 'button',
      title: '滑鼠穿透(可用 Ctrl+Alt+C 解除)',
      text: '🖱',
      onclick: () => window.stockcard.toggleClickThrough(),
    });

    this.closeBtn = el('button.sc-icon-btn.sc-icon-btn--danger', {
      type: 'button',
      title: '關閉這張卡片',
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

    this.htfBars = [];

    /** blockStart -> per-4h profile, for the current symbol. Closed blocks never change. */
    this.periodCache = new Map();

    this.activeTool = 'cursor';
    this.toolbar = new Toolbar({
      active: this.activeTool,
      onSelect: (id, value) => this.setActiveTool(id, value),
    });
    this.chartEl.append(this.toolbar.root);

    // Shown only once the view has been moved off its default -- a stretched
    // price axis, a zoom, a scroll into history -- tucked into the corner where
    // the two axes meet. Alt+R does the same.
    this.resetBtn = el('button.card__reset', {
      type: 'button',
      title: '重置圖表視圖 (Alt+R)',
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
      { hidden: true, title: '資金費率 · 距離下次結算' },
      this.fundingRateEl,
      this.fundingTimeEl
    );
    this.noticeEl = el('div.card__notice', { hidden: true });
    this.chartEl.append(this.fundingEl, this.noticeEl);

    this.overlayText = el('div.card__overlay-text', { text: '載入中…' });
    this.retryBtn = el('button.sc-btn', {
      type: 'button',
      text: '重試',
      hidden: true,
      onclick: () => this.loadData(),
    });
    this.overlay = el('div.card__overlay', {}, this.overlayText, this.retryBtn);

    // Only rendered while click-through is on: the one place guaranteed to
    // accept a click, so the user can never lock themselves out (spec 4.2).
    this.unlock = el('button.card__unlock', {
      type: 'button',
      text: '解除穿透',
      title: '滑鼠穿透中,點此解除(或按 Ctrl+Alt+C)',
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

    this.bindUndo();
    this.bindLevelInput();
    this.bindFibInput();
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
    this.applyVolumeProfile(this.card.volumeProfile || 'off');
    this.toolbar.setToggled('htf', this.card.showHtf);
    if (this.card.showHtf) this.setHtfEnabled(true);
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
      window.stockcard.updateCard(this.card.id, { volumeProfile: value });
      return;
    }
    if (id === 'htf') {
      const next = !this.card.showHtf;
      this.toolbar.setToggled('htf', next);
      window.stockcard.updateCard(this.card.id, { showHtf: next });
      return;
    }
    const next = id === this.activeTool ? 'cursor' : id;
    this.activeTool = next;
    this.toolbar.setActive(next);
    this.dismissMeasure();
    // The chart's own cursor would otherwise stay a crosshair over a tool.
    this.chartEl.style.cursor = next === 'cursor' ? '' : 'crosshair';
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
      if (event.shiftKey) return; // Shift belongs to the measure tool
      const { x, y } = local(event);
      if (!this.chart.inPlot(x, y)) return; // the axes belong to the chart
      const hit = this.chart.levelAt(y);
      if (hit) {
        const removed = this.chart.levels.get(hit);
        await window.stockcard.removeLevel(this.card.symbol, hit);
        if (removed) this.pushUndo({ kind: 'level-remove', id: hit, price: removed.level.price });
        return;
      }
      const price = this.chart.priceAt(x, y, { magnet: event.ctrlKey });
      if (price === null) return;
      const added = await window.stockcard.addLevel(this.card.symbol, price);
      if (added) this.pushUndo({ kind: 'level-add', id: added.id });
    };

    this.onLevelClick = async (event) => {
      if (this.activeTool !== 'level' || event.shiftKey) return;
      const { x, y } = local(event);
      if (!this.chart.inPlot(x, y)) return; // the axes belong to the chart
      // Clicking an existing level selects nothing and deletes nothing here --
      // that stays on double-click, so a mis-click while armed cannot destroy
      // a line the user just placed.
      if (this.chart.levelAt(y)) return;
      const price = this.chart.priceAt(x, y, { magnet: event.ctrlKey });
      if (price === null) return;
      const added = await window.stockcard.addLevel(this.card.symbol, price);
      if (added) this.pushUndo({ kind: 'level-add', id: added.id });
    };

    this.onLevelDown = (event) => {
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

  htfApplies() {
    return this.card.showHtf && HTF_BELOW.includes(this.card.interval);
  }

  /**
   * The last N 4h candles, drawn as translucent boxes over the lower timeframe.
   *
   * The forming one is fed by its own subscription on the 4h stream rather than
   * being aggregated out of the card's own bars: the card may be showing 1m,
   * where 500 bars is only eight hours, and the exchange's own 4h candle is
   * authoritative anyway. Streams are ref-counted in the hub, so a second
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
    this.feed.subscribe(`${this.card.id}:htf`, this.card.symbol, HTF_INTERVAL, {
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
      const bars = await this.feed.getHistory(this.card.symbol, HTF_INTERVAL, HTF_COUNT);
      if (this.destroyed || key !== this.dataKey()) return;
      this.htfBars = bars.slice(-HTF_COUNT);
      this.renderHtf();
    } catch (err) {
      console.error('[card] 4h overlay failed', err);
    }
  }

  /**
   * Hand the bars to the chart, which draws them itself (htf-primitive.js).
   * Positioning is no longer this method's job -- the chart recomputes it on
   * every viewport change, in the same frame as the candles.
   */
  renderHtf() {
    if (!this.chart) return;
    this.chart.setHtf(this.htfBars, this.htfApplies());
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
      let older = await window.stockcard.readBars(market, symbol, interval, from, to);
      if (!older.length) {
        older = await feed.getRange(symbol, interval, from * 1000, to * 1000);
        const keep = older.filter((b) => b.closed);
        if (keep.length) window.stockcard.writeBars(market, symbol, interval, keep);
      }
      // The card may have changed symbol or interval while this was in flight.
      if (this.destroyed || seq !== this.loadSeq) return;
      if (!older.length) {
        this.historyExhausted = true;
        return;
      }
      this.chart.prependBars(older);
      this.renderFibs();
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

  async loadDayProfile() {
    const key = this.dataKey();
    const { start, end } = sessionBounds();
    try {
      const bars = await this.feed.getRange(this.card.symbol, '1m', start, end);
      if (this.destroyed || key !== this.dataKey() || this.card.volumeProfile !== 'day') return;
      this.chart.setDayProfile(buildProfile(bars, 26));
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
    if (!HTF_BELOW.includes(this.card.interval)) {
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
    const s = op.symbol;
    try {
      switch (op.kind) {
        case 'level-add':
          await window.stockcard.removeLevel(s, op.id);
          break;
        case 'level-remove': {
          const back = await window.stockcard.addLevel(s, op.price);
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
          const back = await window.stockcard.addRect(s, op.a, op.b);
          if (back) this.remapUndo(op.id, back.id);
          break;
        }
        case 'rect-move':
          await window.stockcard.updateRect(s, op.id, op.from);
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
      // Alt+1..6: the watchlist, in order. `code` rather than `key`, so it
      // works the same whatever the keyboard layout or IME state.
      const digit = /^Digit([1-9])$/.exec(event.code);
      if (!digit) return;
      const entry = this.watchlistEntries()[Number(digit[1]) - 1];
      if (!entry) return;
      event.preventDefault();
      this.watchlist.close();
      this.switchTo(entry);
    };
    window.addEventListener('keydown', this.onResetKey);

    this.offViewport = this.chart.onViewportChange(() => this.syncResetButton());
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
          this.draggingRect = { id: hit.id, mode: 'corner', fixed, orig, next: null };
        } else {
          // No magnet on the reference point: it only measures the offset, and
          // snapping it would make the zone jump the moment it is grabbed.
          const start = this.chart.anchorAt(x, y);
          if (!start) return;
          this.draggingRect = { id: hit.id, mode: 'move', start, orig, next: null };
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
        const d = this.draggingRect;
        if (d.mode === 'corner') {
          const anchor = this.chart.anchorAt(x, y, { magnet: event.ctrlKey });
          if (!anchor) return;
          d.next = { a: { ...d.fixed }, b: anchor };
        } else {
          const now = this.chart.anchorAt(x, y);
          if (!now) return;
          const dt = now.time - d.start.time;
          const dp = now.price - d.start.price;
          const shift = (p) => ({ time: Math.round(p.time + dt), price: Number((p.price + dp).toFixed(this.chart.precision)) });
          d.next = { a: shift(d.orig.a), b: shift(d.orig.b) };
        }
        prim().setDraft({ id: d.id, ...d.next });
        return;
      }
      // Hover feedback -- but never while another tool is mid-gesture.
      if (this.draggingLevel || this.measuring || this.drawingFib || this.draggingFib) return;
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
      const { x, y } = local(event);
      const hit = prim().hitTest(x, y);
      if (!hit) return;
      // Otherwise the double-click falls through and drops a level as well.
      event.stopPropagation();
      const rect = this.rects.find((r) => r.id === hit.id);
      await window.stockcard.removeRect(this.card.symbol, hit.id);
      prim().setActive(null);
      if (rect) this.pushUndo({ kind: 'rect-remove', id: rect.id, a: { ...rect.a }, b: { ...rect.b } });
    };

    el.addEventListener('mousedown', this.onRectDown, true);
    el.addEventListener('dblclick', this.onRectDblClick, true);
    window.addEventListener('mousemove', this.onRectMove);
    window.addEventListener('mouseup', this.onRectUp);
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
        if (this.draggingLevel || this.measuring || this.drawingRect || this.draggingRect) return;
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
      // Shift is the shortcut and works in any mode; the armed tool needs no
      // modifier at all.
      if (event.button !== 0) return;
      if (!event.shiftKey && this.activeTool !== 'measure') return;
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
    if (this.offLevels) this.offLevels();
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
    if (this.onRectDown) {
      this.chartEl.removeEventListener('mousedown', this.onRectDown, true);
      this.chartEl.removeEventListener('dblclick', this.onRectDblClick, true);
      window.removeEventListener('mousemove', this.onRectMove);
      window.removeEventListener('mouseup', this.onRectUp);
    }
    if (this.onUndoKey) window.removeEventListener('keydown', this.onUndoKey);
    if (this.onResetKey) window.removeEventListener('keydown', this.onResetKey);
    if (this.offViewport) this.offViewport();
    if (this.onActivate) this.root.removeEventListener('pointerdown', this.onActivate, true);
    if (lastActive === this) lastActive = null;
    if (this.offRangeChange) this.offRangeChange();
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

    this.setOverlay('載入中…');
    try {
      const bars = await feed.getHistory(symbol, interval, HISTORY_LIMIT);
      if (seq !== this.loadSeq || this.destroyed) return;
      // Everything closed goes to disk, so the next launch starts from a file.
      const closed = bars.filter((b) => b.closed);
      if (closed.length) window.stockcard.writeBars(market, symbol, interval, closed);

      if (!bars.length) {
        this.setOverlay('沒有資料', true);
        return;
      }

      this.chart.setData(bars);
      this.historyExhausted = false;
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
      this.setOverlay(`載入失敗:${err.message}`, true);
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
      },
      onTicker: (ticker) => {
        if (this.destroyed) return;
        if (ticker.symbol === this.card.symbol) this.applyTicker(ticker);
      },
      onFunding: (funding) => {
        if (this.destroyed) return;
        if (funding.symbol === this.card.symbol) this.applyFunding(funding);
      },
    });
  }

  applyTicker(ticker) {
    this.ticker = ticker;
    this.renderQuote();
  }

  applyFunding(funding) {
    this.funding = funding && this.card.market === 'perp' ? funding : null;
    this.renderFunding();
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
    this.fundingTimeEl.textContent = left > 0 ? formatCountdown(left) : '結算中';
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
          ? `${prettySymbol(this.card.symbol)} 沒有${MARKET_LABELS[market]}`
          : '無法取得交易對清單，請稍後再試'
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
        ? `${prettySymbol(symbol)} 沒有${other}`
        : resolved && resolved !== symbol
          ? `切換到${other} (${prettySymbol(resolved)})`
          : `切換到${other}`;
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
      ? `把 ${entryLabel(current)} 從常用清單移除`
      : list.length >= WATCHLIST_MAX
        ? `常用清單已滿 (最多 ${WATCHLIST_MAX} 個)`
        : `把 ${entryLabel(current)} 加入常用清單`;
    this.watchlist.setState(list, current);
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
      if (next.volumeProfile !== prev.volumeProfile) this.applyVolumeProfile(next.volumeProfile);
      if (next.showHtf !== prev.showHtf && !marketChanged) {
        this.toolbar.setToggled('htf', next.showHtf);
        this.setHtfEnabled(next.showHtf);
      }
    }

    this.renderIdentity();
    this.panel.update(next);

    if (symbolChanged) {
      this.ticker = null;
      this.lastBar = null;
      this.renderQuote();
      if (next.symbol !== prev.symbol || marketChanged) this.refreshCounterpart();
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
        // Undo entries belong to the symbol they were recorded on; replaying
        // them after a switch would edit drawings that are not on screen.
        this.undoStack = [];
      }
      // Profiles and the 4h overlay are built from the market's own candles.
      if (next.symbol !== prev.symbol || marketChanged) {
        this.periodCache.clear();
        this.applyVolumeProfile(this.card.volumeProfile || 'off');
        this.toolbar.setToggled('htf', this.card.showHtf);
        this.htfBars = [];
        this.renderHtf();
        if (this.card.showHtf) this.setHtfEnabled(true);
      }
      this.loadData();
    }
  }
}
