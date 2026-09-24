/**
 * Per-card settings panel (spec 4.3): market, symbol, interval, chart type,
 * opacity, volume sub-pane, always-on-top.
 *
 * Every control reports through `onPatch`, which the card turns into a store
 * write — the panel holds no state of its own beyond the DOM.
 */

import { el, clamp, INTERVAL_LABELS, CHART_TYPE_LABELS, MARKET_LABELS } from '../util.js';
import { SymbolSearch } from './symbol-search.js';
import { ShortcutInput } from './shortcut-input.js';

const UP_DOWN_LABELS = { greenUp: '綠漲紅跌', redUp: '紅漲綠跌' };
/**
 * 'auto' follows the machine, which is the friendly default. 'UTC' is there
 * because that is the exchange's own clock -- Binance daily candles open at
 * 00:00 UTC -- so it is the one zone where the bar boundaries line up.
 */
const TIMEZONE_VALUES = ['auto', 'Asia/Taipei', 'UTC'];
const TIMEZONE_LABELS = { auto: '本機', 'Asia/Taipei': '台北', UTC: 'UTC' };

function segmented(values, labels, current, onSelect) {
  const buttons = new Map();
  const root = el(
    'div.sc-seg',
    {},
    values.map((value) => {
      const button = el('button.sc-seg__btn', {
        type: 'button',
        text: labels[value] || value,
        class: value === current ? 'is-active' : '',
        onclick: () => onSelect(value),
      });
      buttons.set(value, button);
      return button;
    })
  );

  return {
    root,
    setValue(value) {
      for (const [key, button] of buttons) button.classList.toggle('is-active', key === value);
    },
  };
}

function slider({ min, max, step, value, format, onInput }) {
  const readout = el('span.sc-slider__value', { text: format(value) });
  const input = el('input.sc-slider__input', {
    type: 'range',
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(value),
    oninput: () => {
      const next = Number(input.value);
      readout.textContent = format(next);
      onInput(next);
    },
  });
  return {
    root: el('div.sc-slider', {}, input, readout),
    setValue(next) {
      input.value = String(next);
      readout.textContent = format(next);
    },
  };
}

function toggle({ label, checked, onChange }) {
  const input = el('input', {
    type: 'checkbox',
    checked: checked ? true : null,
    onchange: () => onChange(input.checked),
  });
  const root = el('label.sc-toggle', {}, input, el('span.sc-toggle__track'), el('span', { text: label }));
  return {
    root,
    setValue(next) {
      input.checked = !!next;
    },
  };
}

function row(label, control) {
  return el('div.sc-row', {}, el('div.sc-row__label', { text: label }), el('div.sc-row__control', {}, control));
}

export class SettingsPanel {
  /**
   * @param {{
   *   card: object, provider: object, intervals: string[], chartTypes: string[],
   *   showWindowOpacity: boolean, onPatch: Function, onMarket: Function, onClose: Function
   * }} options
   *
   * `provider` only has to answer searchSymbols(); the card hands in one that
   * follows its current market, so search lists what the card can show.
   * A market change goes through `onMarket` rather than `onPatch`, because the
   * symbol may have to change with it (PEPEUSDT <-> 1000PEPEUSDT).
   */
  constructor({
    card,
    provider,
    prefs,
    intervals,
    chartTypes,
    showWindowOpacity,
    onPatch,
    onMarket,
    onPrefs,
    onShortcut,
    onClose,
  }) {
    this.card = card;
    this.onPatch = onPatch;

    this.symbolSearch = new SymbolSearch({
      provider,
      current: card.symbol,
      onPick: (symbol) => onPatch({ symbol }),
    });

    this.marketSeg = segmented(Object.keys(MARKET_LABELS), MARKET_LABELS, card.market, (market) =>
      onMarket(market)
    );

    this.intervalSeg = segmented(intervals, INTERVAL_LABELS, card.interval, (interval) =>
      onPatch({ interval })
    );

    this.typeSeg = segmented(chartTypes, CHART_TYPE_LABELS, card.chartType, (chartType) =>
      onPatch({ chartType })
    );

    this.cardOpacity = slider({
      min: 10,
      max: 100,
      step: 5,
      value: Math.round(card.cardOpacity * 100),
      format: (v) => `${v}%`,
      onInput: (v) => onPatch({ cardOpacity: clamp(v / 100, 0.1, 1) }),
    });

    this.windowOpacity = slider({
      min: 20,
      max: 100,
      step: 5,
      value: Math.round(card.windowOpacity * 100),
      format: (v) => `${v}%`,
      onInput: (v) => onPatch({ windowOpacity: clamp(v / 100, 0.2, 1) }),
    });

    this.volumeToggle = toggle({
      label: '顯示成交量副圖',
      checked: card.showVolume,
      onChange: (showVolume) => onPatch({ showVolume }),
    });

    this.onTopToggle = toggle({
      label: '視窗置頂',
      checked: card.alwaysOnTop,
      onChange: (alwaysOnTop) => onPatch({ alwaysOnTop }),
    });

    /* ---- global settings: shared by every card, edited from any of them ---- */

    this.upDownSeg = segmented(['greenUp', 'redUp'], UP_DOWN_LABELS, prefs.upDownColor, (value) =>
      onPrefs({ upDownColor: value })
    );

    this.timezoneSeg = segmented(TIMEZONE_VALUES, TIMEZONE_LABELS, prefs.timezone, (value) =>
      onPrefs({ timezone: value })
    );

    this.startupToggle = toggle({
      label: '開機自動啟動',
      checked: prefs.launchAtStartup,
      onChange: (launchAtStartup) => onPrefs({ launchAtStartup }),
    });

    this.showAccel = new ShortcutInput({
      value: prefs.shortcuts.toggleShow,
      onChange: (accel) => onShortcut('toggleShow', accel),
    });

    this.clickThroughAccel = new ShortcutInput({
      value: prefs.shortcuts.toggleClickThrough,
      onChange: (accel) => onShortcut('toggleClickThrough', accel),
    });

    this.root = el(
      'div.sc-panel',
      { hidden: true },
      el(
        'div.sc-panel__head',
        {},
        el('span.sc-panel__title', { text: '卡片設定' }),
        el('button.sc-icon-btn', {
          type: 'button',
          title: '關閉設定',
          text: '✕',
          onclick: () => onClose(),
        })
      ),
      el('div.sc-panel__body', {},
        row('市場', this.marketSeg.root),
        row('交易對', this.symbolSearch.root),
        row('週期', this.intervalSeg.root),
        row('圖型', this.typeSeg.root),
        row('卡片透明度', this.cardOpacity.root),
        showWindowOpacity ? row('整體透明度', this.windowOpacity.root) : null,
        el('div.sc-row.sc-row--stack', {}, this.volumeToggle.root, showWindowOpacity ? this.onTopToggle.root : null),
        el('div.sc-divider', { text: '全域設定' }),
        row('漲跌顏色', this.upDownSeg.root),
        row('時間顯示', this.timezoneSeg.root),
        row('顯示/隱藏全部卡片', this.showAccel.root),
        row('切換滑鼠穿透', this.clickThroughAccel.root),
        el('div.sc-row.sc-row--stack', {}, this.startupToggle.root)
      )
    );
  }

  /** Re-sync the global controls after a change made from another card or the tray. */
  updatePrefs(prefs) {
    this.upDownSeg.setValue(prefs.upDownColor);
    this.timezoneSeg.setValue(prefs.timezone);
    this.startupToggle.setValue(prefs.launchAtStartup);
    this.showAccel.setValue(prefs.shortcuts.toggleShow);
    this.clickThroughAccel.setValue(prefs.shortcuts.toggleClickThrough);
  }

  get isOpen() {
    return !this.root.hidden;
  }

  open() {
    this.root.hidden = false;
    this.symbolSearch.focus();
  }

  close() {
    this.root.hidden = true;
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  /** Re-sync every control after an external change to the card. */
  update(card) {
    this.card = card;
    if (document.activeElement !== this.symbolSearch.input) {
      this.symbolSearch.input.value = card.symbol;
    }
    this.marketSeg.setValue(card.market);
    this.intervalSeg.setValue(card.interval);
    this.typeSeg.setValue(card.chartType);
    this.cardOpacity.setValue(Math.round(card.cardOpacity * 100));
    this.windowOpacity.setValue(Math.round(card.windowOpacity * 100));
    this.volumeToggle.setValue(card.showVolume);
    this.onTopToggle.setValue(card.alwaysOnTop);
  }
}
