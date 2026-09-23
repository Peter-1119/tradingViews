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
import {
  el,
  formatPrice,
  formatPercent,
  prettySymbol,
  STATUS_BADGES,
  STATUS_LABELS,
  INTERVAL_LABELS,
} from './util.js';

const HISTORY_LIMIT = 500;

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
    this.offLevels = window.stockcard.onLevelsChanged(({ symbol, levels }) => {
      if (this.destroyed || symbol !== this.card.symbol) return;
      this.chart.setLevels(levels);
    });
    this.loadLevels();

    await this.loadData();
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
      const { x, y } = local(event);
      const hit = this.chart.levelAt(y);
      if (hit) {
        await window.stockcard.removeLevel(this.card.symbol, hit);
        return;
      }
      const price = this.chart.priceAt(x, y, { magnet: event.ctrlKey });
      if (price !== null) await window.stockcard.addLevel(this.card.symbol, price);
    };

    this.onLevelDown = (event) => {
      if (event.button !== 0) return;
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
      if (!this.draggingLevel) {
        el.style.cursor = this.chart.levelAt(y) ? 'ns-resize' : '';
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
    el.addEventListener('mousedown', this.onLevelDown, true);
    el.addEventListener('mousemove', this.onLevelMove);
    // On window, not the element: a fast drag can release outside the chart.
    window.addEventListener('mouseup', this.onLevelUp);
  }

  destroy() {
    this.destroyed = true;
    this.loadSeq += 1; // invalidate any in-flight load
    if (this.offStatus) this.offStatus();
    if (this.offLevels) this.offLevels();
    if (this.onLevelDblClick) {
      this.chartEl.removeEventListener('dblclick', this.onLevelDblClick);
      this.chartEl.removeEventListener('mousedown', this.onLevelDown, true);
      this.chartEl.removeEventListener('mousemove', this.onLevelMove);
      window.removeEventListener('mouseup', this.onLevelUp);
    }
    this.provider.unsubscribe(this.card.id);
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

      if (!bars.length) {
        this.setOverlay('沒有資料', true);
        return;
      }

      this.chart.setData(bars);
      this.lastBar = bars[bars.length - 1];
      this.setOverlay(null);
      this.renderQuote();
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
      }
      this.loadData();
    }
  }
}
