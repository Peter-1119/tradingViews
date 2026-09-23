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
import { FibOverlay } from './ui/fib-overlay.js';
import { buildProfile, buildPeriodProfiles, sessionBounds, PERIOD_4H } from './volume-profile.js';
import { intervalToMs } from './datafeed/provider.js';
import {
  el,
  formatPrice,
  formatPercent,
  formatDuration,
  formatAtPrecision,
  prettySymbol,
  STATUS_BADGES,
  STATUS_LABELS,
  INTERVAL_LABELS,
} from './util.js';

const HISTORY_LIMIT = 500;
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

export class CardView {
  /**
   * @param {{
   *   card: object,
   *   provider: object,
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
    provider,
    prefs,
    intervals,
    chartTypes,
    windowControls = false,
    onPatch,
    onRemove,
  }) {
    this.card = card;
    this.provider = provider;
    this.prefs = prefs;
    this.windowControls = windowControls;
    this.onPatch = onPatch;
    this.onRemove = onRemove;

    this.loadSeq = 0;
    this.destroyed = false;
    this.lastBar = null;
    this.ticker = null;
    this.status = provider.getStatus();

    this.buildDom(intervals, chartTypes);
  }

  /* ----------------------------------------------------------------- DOM */

  buildDom(intervals, chartTypes) {
    this.symbolEl = el('span.card__symbol', { text: prettySymbol(this.card.symbol) });
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
      el('div.card__id', {}, this.symbolEl, this.intervalEl),
      el('div.card__quote', {}, this.priceEl, this.changeEl),
      this.tools
    );

    this.dot = el('span.card__dot', { title: STATUS_LABELS[this.status] || '' });

    this.chartEl = el('div.card__chart');

    // Measure readout. Lives in the chart box (which is position:relative) and
    // is hidden until a Shift-drag starts.
    this.measureBox = el('div.card__measure', { hidden: true });
    this.measureLabel = el('div.card__measure-label');
    this.measureBox.append(this.measureLabel);
    this.chartEl.append(this.measureBox);

    this.fibs = [];
    this.fibOverlay = new FibOverlay();
    this.chartEl.append(this.fibOverlay.root);

    this.htfBars = [];

    /** blockStart -> per-4h profile, for the current symbol. Closed blocks never change. */
    this.periodCache = new Map();

    this.activeTool = 'cursor';
    this.toolbar = new Toolbar({
      active: this.activeTool,
      onSelect: (id, value) => this.setActiveTool(id, value),
    });
    this.chartEl.append(this.toolbar.root);

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
      provider: this.provider,
      prefs: this.prefs,
      intervals,
      chartTypes,
      showWindowOpacity: this.windowControls,
      onPatch: (patch) => this.onPatch(patch),
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

    this.offStatus = this.provider.onStatusChange((status) => this.setStatus(status));
    this.setStatus(this.provider.getStatus());

    this.bindLevelInput();
    this.bindFibInput();
    this.offFibs = window.stockcard.onFibsChanged(({ symbol, fibs }) => {
      if (this.destroyed || symbol !== this.card.symbol) return;
      this.fibs = fibs;
      this.renderFibs();
    });
    this.loadFibs();
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
      const hit = this.chart.levelAt(y);
      if (hit) {
        await window.stockcard.removeLevel(this.card.symbol, hit);
        return;
      }
      const price = this.chart.priceAt(x, y, { magnet: event.ctrlKey });
      if (price !== null) await window.stockcard.addLevel(this.card.symbol, price);
    };

    this.onLevelClick = async (event) => {
      if (this.activeTool !== 'level' || event.shiftKey) return;
      const { x, y } = local(event);
      // Clicking an existing level selects nothing and deletes nothing here --
      // that stays on double-click, so a mis-click while armed cannot destroy
      // a line the user just placed.
      if (this.chart.levelAt(y)) return;
      const price = this.chart.priceAt(x, y, { magnet: event.ctrlKey });
      if (price !== null) await window.stockcard.addLevel(this.card.symbol, price);
    };

    this.onLevelDown = (event) => {
      if (event.button !== 0) return;
      if (event.shiftKey) return; // ditto -- measuring beats grabbing a level
      const { y } = local(event);
      const hit = this.chart.levelAt(y);
      if (!hit) return;
      // Freeze the chart's own pan/zoom for the duration, rather than trying to
      // out-manoeuvre its handlers with stopPropagation.
      this.chart.setInteractionEnabled(false);
      this.chart.setActiveLevel(hit);
      this.draggingLevel = { id: hit, price: null };
      event.preventDefault();
    };

    this.onLevelMove = (event) => {
      const { x, y } = local(event);
      if (this.measuring) return;
      if (!this.draggingLevel) {
        el.style.cursor = event.shiftKey
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
      if (drag.price !== null) {
        await window.stockcard.updateLevel(this.card.symbol, drag.id, drag.price);
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
      this.provider.unsubscribe(`${this.card.id}:htf`);
      this.htfBars = [];
      this.renderHtf();
      return;
    }
    await this.loadHtf();
    this.provider.subscribe(`${this.card.id}:htf`, this.card.symbol, HTF_INTERVAL, {
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
    const symbol = this.card.symbol;
    try {
      const bars = await this.provider.getHistory(symbol, HTF_INTERVAL, HTF_COUNT);
      if (this.destroyed || symbol !== this.card.symbol) return;
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

    const { symbol, interval } = this.card;
    const step = intervalToMs(interval) / 1000;
    const oldest = bars[0].time;
    const from = oldest - step * HISTORY_PAGE;
    const to = oldest - step;
    if (to <= 0) return;

    this.loadingMore = true;
    const seq = this.loadSeq;
    try {
      let older = await window.stockcard.readBars(symbol, interval, from, to);
      if (!older.length) {
        older = await this.provider.getRange(symbol, interval, from * 1000, to * 1000);
        const keep = older.filter((b) => b.closed);
        if (keep.length) window.stockcard.writeBars(symbol, interval, keep);
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
  async fetchBars(symbol, interval, fromSec, toSec, expect = 0) {
    const cached = await window.stockcard.readBars(symbol, interval, fromSec, toSec);
    if (expect && cached.length >= expect) return cached;
    const fresh = await this.provider.getRange(symbol, interval, fromSec * 1000, toSec * 1000);
    const closed = fresh.filter((b) => b.closed);
    if (closed.length) window.stockcard.writeBars(symbol, interval, closed);
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
    const symbol = this.card.symbol;
    const { start, end } = sessionBounds();
    try {
      const bars = await this.provider.getRange(symbol, '1m', start, end);
      if (this.destroyed || symbol !== this.card.symbol || this.card.volumeProfile !== 'day') return;
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
    const symbol = this.card.symbol;
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
        const bars = await this.fetchBars(symbol, '5m', from, to, expect);
        if (symbol !== this.card.symbol) return;
        for (const block of buildPeriodProfiles(bars, PERIOD_4H, 14)) {
          if (block.start !== liveStart) this.periodCache.set(block.start, block);
        }
      }
      // The live block always comes from the network: the cache only ever
      // holds closed bars, so it is by construction missing the newest one.
      if (wanted.includes(liveStart)) {
        const bars = await this.provider.getRange(symbol, '5m', liveStart * 1000, now * 1000);
        if (symbol !== this.card.symbol) return;
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

  /* ------------------------------------------------------------------ fibs */

  async loadFibs() {
    const symbol = this.card.symbol;
    const fibs = await window.stockcard.listFibs(symbol);
    if (this.destroyed || symbol !== this.card.symbol) return;
    this.fibs = fibs;
    this.renderFibs();
  }

  renderFibs() {
    if (!this.chart) return;
    this.fibOverlay.render(
      this.drawingFib ? [...this.fibs, this.drawingFib] : this.fibs,
      (fib) => {
        const a = this.chart.anchorToPixel(fib.a);
        const b = this.chart.anchorToPixel(fib.b);
        if (!a || !b) return null;
        return { a, b, priceToY: (price) => this.chart.priceToY(price) };
      },
      (price) => this.chart.formatPrice(price),
      this.activeFibId
    );
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

      // Grabbing an existing handle takes priority over starting a new one, so
      // an armed tool can still adjust what is already on the chart.
      const grabbed = this.fibHandleAt(event.target);
      if (grabbed) {
        this.draggingFib = grabbed;
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
      if (!this.drawingFib && !this.draggingFib) return;
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
          await window.stockcard.addFib(this.card.symbol, draft.a, draft.b);
        } else {
          this.renderFibs();
        }
        return;
      }
      if (this.draggingFib) {
        const { id, end } = this.draggingFib;
        this.draggingFib = null;
        this.activeFibId = null;
        this.chart.setInteractionEnabled(true);
        const fib = this.fibs.find((f) => f.id === id);
        if (fib) await window.stockcard.updateFib(this.card.symbol, id, { [end]: fib[end] });
      }
    };

    this.onFibDblClick = async (event) => {
      const grabbed = this.fibHandleAt(event.target);
      if (!grabbed) return;
      event.stopPropagation();
      await window.stockcard.removeFib(this.card.symbol, grabbed.id);
    };

    el.addEventListener('mousedown', this.onFibDown, true);
    el.addEventListener('dblclick', this.onFibDblClick, true);
    window.addEventListener('mousemove', this.onFibMove);
    window.addEventListener('mouseup', this.onFibUp);
  }

  /** Map a DOM target back to the retracement handle it belongs to. */
  fibHandleAt(target) {
    if (!target || !target.classList || !target.classList.contains('card__fib-handle')) return null;
    for (const [id, entry] of this.fibOverlay.rendered) {
      const index = entry.handles.indexOf(target);
      if (index >= 0) return { id, end: index === 0 ? 'a' : 'b' };
    }
    return null;
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
      this.measureBox.hidden = true;
    };

    // Panning or zooming after a measure must keep the box on its candles.
    this.offRangeChange = this.chart.onVisibleRangeChange((range) => {
      this.renderMeasure();
      this.renderFibs();
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
    this.measureBox.hidden = true;
    this.chart.setInteractionEnabled(true);
  }

  renderMeasure() {
    const m = this.measuring;
    if (!m) return;
    const a = this.chart.pointToPixel(m.from);
    const b = this.chart.pointToPixel(m.to);
    if (!a || !b) {
      this.measureBox.hidden = true;
      return;
    }

    const left = Math.min(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const box = this.measureBox;
    box.hidden = false;
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${Math.abs(b.x - a.x)}px`;
    box.style.height = `${Math.abs(b.y - a.y)}px`;

    const stats = this.chart.measureStats(m.from, m.to);
    // Respect the up/down colour convention rather than hardcoding green=up.
    const upIsGreen = this.prefs.upDownColor !== 'redUp';
    box.classList.toggle('is-up', stats.rising === upIsGreen);
    box.classList.toggle('is-down', stats.rising !== upIsGreen);
    // The label hangs off whichever end the pointer is at.
    box.classList.toggle('is-below', b.y > a.y);

    // Plain ASCII sign, to match the one formatPercent emits.
    const sign = stats.priceDelta >= 0 ? '+' : '-';
    const delta = formatAtPrecision(Math.abs(stats.priceDelta), this.chart.precision);
    this.measureLabel.textContent =
      `${sign}${delta} (${formatPercent(stats.percent)})
` +
      `${stats.bars} bars · ${formatDuration(stats.seconds)}`;

    this.clampMeasureLabel(left, Math.abs(b.x - a.x));
  }

  /**
   * Keep the readout inside the chart.
   *
   * The label is centred on the box, which pushes it off the card whenever the
   * box sits near an edge -- and on a ~340px card that is most of the time.
   * Nudge it back by however much it overhangs.
   */
  clampMeasureLabel(boxLeft, boxWidth) {
    const label = this.measureLabel;
    label.style.transform = 'translateX(-50%)';
    const chartWidth = this.chartEl.clientWidth;
    const labelWidth = label.offsetWidth;
    const centre = boxLeft + boxWidth / 2;
    const overflowLeft = Math.max(0, labelWidth / 2 - centre);
    const overflowRight = Math.max(0, centre + labelWidth / 2 - chartWidth);
    const nudge = overflowLeft - overflowRight;
    if (nudge) label.style.transform = `translateX(calc(-50% + ${Math.round(nudge)}px))`;
  }

  destroy() {
    this.destroyed = true;
    this.loadSeq += 1; // invalidate any in-flight load
    if (this.offStatus) this.offStatus();
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
    if (this.offFibs) this.offFibs();
    if (this.offRangeChange) this.offRangeChange();
    this.provider.unsubscribe(this.card.id);
    this.provider.unsubscribe(`${this.card.id}:htf`);
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
    const { symbol, interval } = this.card;

    this.setOverlay('載入中…');
    try {
      const bars = await this.provider.getHistory(symbol, interval, HISTORY_LIMIT);
      if (seq !== this.loadSeq || this.destroyed) return;
      // Everything closed goes to disk, so the next launch starts from a file.
      const closed = bars.filter((b) => b.closed);
      if (closed.length) window.stockcard.writeBars(symbol, interval, closed);

      if (!bars.length) {
        this.setOverlay('沒有資料', true);
        return;
      }

      this.chart.setData(bars);
      this.historyExhausted = false;
      this.lastBar = bars[bars.length - 1];
      this.setOverlay(null);
      this.renderQuote();
      // Anchors are timestamps, so they stay valid across an interval change,
      // but they resolve to different pixels against the new bars. Re-project
      // on the next tick rather than now: immediately after setData the time
      // scale has not laid out, so logicalToCoordinate answers 0 for every
      // anchor and the whole retracement stacks on the left edge. setTimeout
      // and not requestAnimationFrame, because a hidden card's frames are
      // throttled and this still has to be right when it comes back.
      this.dismissMeasure();
      clearTimeout(this.fibProjectTimer);
      this.fibProjectTimer = setTimeout(() => {
        this.renderFibs();
        this.renderHtf();
        if (this.card.volumeProfile === 'session4h') this.loadPeriodProfiles();
      }, 0);
      this.subscribe();

      this.provider
        .getTicker(symbol)
        .then((ticker) => {
          if (seq === this.loadSeq && !this.destroyed) this.applyTicker(ticker);
        })
        .catch(() => {
          /* the miniTicker stream will fill this in shortly */
        });
    } catch (err) {
      if (seq !== this.loadSeq || this.destroyed) return;
      this.setOverlay(`載入失敗:${err.message}`, true);
    }
  }

  subscribe() {
    // subId is the card id, so re-subscribing after a symbol change replaces
    // the previous stream instead of stacking a second one.
    this.provider.subscribe(this.card.id, this.card.symbol, this.card.interval, {
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
    });
  }

  applyTicker(ticker) {
    this.ticker = ticker;
    this.renderQuote();
  }

  /* --------------------------------------------------------------- render */

  renderIdentity() {
    this.symbolEl.textContent = prettySymbol(this.card.symbol);
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
  }

  /**
   * Apply a new card record (from the store) and do only the work each change
   * actually requires — a chart-type switch must not refetch history.
   */
  applyCard(next) {
    const prev = this.card;
    this.card = next;

    const symbolChanged = next.symbol !== prev.symbol || next.interval !== prev.interval;

    if (next.cardOpacity !== prev.cardOpacity) this.applyOpacity();
    if (this.chart) {
      if (next.chartType !== prev.chartType) this.chart.setChartType(next.chartType);
      if (next.showVolume !== prev.showVolume) this.chart.setVolumeVisible(next.showVolume);
      if (next.volumeProfile !== prev.volumeProfile) this.applyVolumeProfile(next.volumeProfile);
      if (next.showHtf !== prev.showHtf) {
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
      // Levels belong to the symbol, so a symbol switch swaps the whole set.
      // The interval half of `symbolChanged` is a harmless no-op reload.
      if (next.symbol !== prev.symbol) {
        this.chart.setLevels([]);
        this.loadLevels();
        this.fibs = [];
        this.fibOverlay.clear();
        this.loadFibs();
        this.periodCache.clear();
        this.applyVolumeProfile(this.card.volumeProfile || 'off');
        if (this.card.showHtf) this.setHtfEnabled(true);
      }
      this.loadData();
    }
  }
}
