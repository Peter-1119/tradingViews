/**
 * The drawing-tool rail (spec: card UI).
 *
 * A vertical strip of icons down the left of the chart. It exists because
 * modifier keys ran out: Ctrl magnets and Shift measures, which leaves one
 * spare, and every tool after that needs somewhere to live. Selecting a tool
 * puts the card into that mode; the gesture shortcuts keep working in any mode,
 * the same split TradingView uses.
 *
 * Reveal follows the *same* rule as the title bar -- fade in while the card is
 * hovered -- rather than a second rule like "hover the left edge". One card
 * this small should not teach two ways to summon its chrome, and at 45% opacity
 * the outer 20px is the least forgiving target on it.
 *
 * The rail overlays the chart instead of taking layout width, so it costs zero
 * pixels when idle and the chart never reflows as it appears.
 */

import { el } from '../util.js';
import { anchorLabel } from '../sessions.js';
import { t } from '../i18n.js';

/** 14x14 viewBox, 1.5px stroke -- legible at the size the card can spare. */
const ICONS = {
  cursor: '<path d="M3 2l8 5-3.2 1.1L6.6 11.5z"/>',
  level: '<path d="M1.5 7h11"/><circle cx="4.5" cy="7" r="1.6"/>',
  // A segment with its two ends: the trend line.
  trend: '<path d="M3 11l8-8"/><circle cx="2.6" cy="11.4" r="1.4"/><circle cx="11.4" cy="2.6" r="1.4"/>',
  // A bell: the price alert.
  alert: '<path d="M4 9.5V6.5a3 3 0 0 1 6 0v3l1.2 1.5H2.8z"/><path d="M5.8 12.3a1.3 1.3 0 0 0 2.4 0"/>',
  measure: '<path d="M2 12V4h8"/><path d="M2 12l9-9"/><path d="M6.5 7.5l1.6 1.6"/>',
  fib: '<path d="M1.5 2.5h11"/><path d="M1.5 5.5h11"/><path d="M1.5 8.5h11"/><path d="M1.5 11.5h11"/>',
  rect: '<rect x="2" y="3.5" width="10" height="7" rx="0.5"/>',
  // Two edges and the profile between them: a volume profile over a chosen span.
  vrange: '<path d="M1.5 1.5v11" stroke-dasharray="1.6 1.4"/><path d="M12.5 1.5v11" stroke-dasharray="1.6 1.4"/>'
    + '<path d="M3.5 4h4"/><path d="M3.5 6.5h7"/><path d="M3.5 9h5"/><path d="M3.5 11.5h2.5"/>',
  // An eye with a slash: hide the drawings (lit while they are hidden).
  drawings: '<path d="M1.5 7s2-3.8 5.5-3.8S12.5 7 12.5 7 10.5 10.8 7 10.8 1.5 7 1.5 7z"/>'
    + '<circle cx="7" cy="7" r="1.6"/><path d="M2.5 12l9-10"/>',
  vp: '<path d="M12.5 2.5h-5"/><path d="M12.5 5h-9"/><path d="M12.5 7.5h-11"/><path d="M12.5 10h-7"/><path d="M12.5 12.5h-4"/>',
  htf: '<rect x="1.5" y="4" width="4.5" height="6" rx="1"/><path d="M3.75 1.5v2.5M3.75 10v2.5"/>'
    + '<rect x="8" y="5.5" width="4.5" height="5" rx="1"/><path d="M10.25 3v2.5M10.25 10.5v2"/>',
  // Three rays to the right edge, starting later as the period gets shorter:
  // month, week, day.
  opens: '<path d="M1.5 3.5h11"/><path d="M1.5 2v3"/><path d="M5 7h7.5"/><path d="M5 5.5v3"/>'
    + '<path d="M8.5 10.5h4"/><path d="M8.5 9v3"/>',
  // A high and a low, dashed, with the range between them.
  hilo: '<path d="M1.5 2.5h11" stroke-dasharray="2 1.6"/><path d="M1.5 11.5h11" stroke-dasharray="2 1.6"/>'
    + '<path d="M7 4.5v5"/><path d="M5.5 6l1.5-1.5L8.5 6"/>',
  // Vertical bars from a baseline -- the volume pane itself, and unlike the
  // horizontal bars of the volume *profile* above.
  volume: '<path d="M1.5 12.5h11"/><path d="M3.5 10.5V8" stroke-width="2.2"/>'
    + '<path d="M7 10.5V3.5" stroke-width="2.2"/><path d="M10.5 10.5V6" stroke-width="2.2"/>',
  // The letters: no glyph says "open interest", and traders read OI at a glance.
  // A candle split down the middle, rows of selling left and buying right.
  footprint: '<path d="M7 1.5v11"/><path d="M6 3.5H3.5"/><path d="M8 3.5h2"/><path d="M6 6H2"/>'
    + '<path d="M8 6h4.5"/><path d="M6 8.5H4"/><path d="M8 8.5h3"/><path d="M6 11H5"/><path d="M8 11h1.5"/>',
  oi: '<text x="7" y="10.2" text-anchor="middle" font-size="7.5" font-weight="700" letter-spacing="-0.2"'
    + ' font-family="Segoe UI, sans-serif" fill="currentColor" stroke="none">OI</text>',
};

export const TOOLS = [
  { id: 'cursor', label: t('游標'), hint: t('游標(雙擊加水平線、Shift 拖曳量測)') },
  { id: 'level', label: t('水平線'), hint: t('水平支撐壓力線:點一下放線') },
  { id: 'trend', label: t('趨勢線'), hint: t('趨勢線（兩點連線）：拖曳畫出，或點兩下各點一個端點。拖端點調整、拖線移動、雙擊刪除') },
  { id: 'alert', label: t('價格提醒'), hint: t('價格提醒：點一下設定（或滑鼠在圖上按 Alt+A）。到價時通知一次，卡片隱藏時也會提醒') },
  { id: 'measure', label: t('量測'), hint: t('量測區間:直接拖曳') },
  { id: 'fib', label: t('斐波那契'), hint: t('斐波那契回撤:拖曳畫出波段') },
  { id: 'rect', label: t('矩形'), hint: t('矩形區間:拖曳畫出。拖邊框移動、拖角調整、雙擊內部刪除') },
  {
    id: 'vp',
    label: t('成交量分布'),
    hint: t('成交量分布(點一下選模式)'),
    // Not a drawing mode -- a display layer with several variants, so it opens
    // a menu instead of arming a tool. It lights up while any variant is on.
    toggle: true,
    menu: [
      { value: 'off', label: t('關閉') },
      { value: 'session4h', label: t('每 4H 分段') },
      { value: 'visible', label: t('可見範圍') },
      { value: 'day', label: t('本日 (UTC)') },
      // Row height, for these and for the range profiles alike.
      { heading: t('精細度') },
      { value: 'detail:coarse', group: 'detail', label: t('粗　10px') },
      { value: 'detail:normal', group: 'detail', label: t('標準　6px') },
      { value: 'detail:fine', group: 'detail', label: t('細　4px') },
      { value: 'detail:ultra', group: 'detail', label: t('極細　2px') },
    ],
  },
  {
    id: 'vrange',
    label: t('區間成交量分布'),
    hint: t('區間成交量分布：在圖上左右拖曳，選出要看的時間範圍（x1 到 x2）。拖到最新 K 棒就是「至今」，會持續更新。拖左右邊線調整、拖上方標籤移動、雙擊邊線或標籤刪除'),
  },
  {
    id: 'drawings',
    label: t('隱藏繪圖'),
    hint: t('隱藏 / 顯示畫的線和圖形（Alt+H）：水平線、趨勢線、斐波那契、矩形、區間成交量分布。只是藏起來，不會刪除，再按一次就回來。隱藏時拿起畫圖工具或新增水平線，會自動顯示'),
    toggle: true,
  },
  {
    id: 'htf',
    label: t('4H 疊圖'),
    hint: t('把最近 10 根 4 小時 K 棒疊在小週期圖上，未收盤的那根會跟著跳'),
    toggle: true,
  },
  {
    id: 'opens',
    label: t('開盤價'),
    hint: t('日開 / 週開 / 月開，也可看昨日開 / 前週開 / 前月開（點一下選分界時區）'),
    toggle: true,
    // Also where the day starts for the highs and lows below.
    // Labels are functions: the local time of each changes with daylight saving.
    // A second group picks which opens; it ticks on its own, apart from the
    // boundary above it.
    menu: [
      { value: 'off', label: t('關閉') },
      ...['utc', 'ny', 'nyse', 'london', 'lse'].map((value) => ({ value, label: () => anchorLabel(value) })),
      { heading: t('顯示') },
      { value: 'which:current', group: 'which', label: t('本期開（日／週／月開）') },
      { value: 'which:prev', group: 'which', label: t('前期開（昨日／前週／前月）') },
      { value: 'which:both', group: 'which', label: t('兩者') },
    ],
  },
  {
    id: 'hilo',
    label: t('高低點'),
    hint: t('日 / 週 / 月的高低點（分界時區跟開盤價相同）'),
    toggle: true,
    menu: [
      { value: 'off', label: t('關閉') },
      { value: 'prev', label: t('前一期（前日／週／月）') },
      { value: 'current', label: t('本期至今') },
      { value: 'both', label: t('兩者') },
    ],
  },
  {
    id: 'volume',
    label: t('成交量'),
    hint: t('成交量副圖：主動買／賣拆分與縮量標示'),
    toggle: true,
    menu: [
      { value: 'off', label: t('關閉') },
      { value: 'on', label: t('顯示成交量') },
      { heading: t('縮量門檻 PR ≤') },
      { value: 'sq:off', group: 'sq', label: t('不標示') },
      { value: 'sq:2', group: 'sq', label: '2%' },
      { value: 'sq:3', group: 'sq', label: '3%' },
      { value: 'sq:5', group: 'sq', label: '5%' },
      { value: 'sq:10', group: 'sq', label: '10%' },
      { heading: t('分布記憶長度') },
      { value: 'mem:500', group: 'mem', label: t('約 500 根') },
      { value: 'mem:1000', group: 'mem', label: t('約 1000 根') },
      { value: 'mem:2000', group: 'mem', label: t('約 2000 根') },
    ],
  },
  {
    id: 'footprint',
    label: t('足跡圖'),
    hint: t('足跡圖：每根 K 棒裡各價位的主動賣（左）和主動買（右）。K 棒夠寬時顯示數字，底下是 Delta（買 − 賣）'),
    toggle: true,
    menu: [
      { value: 'off', label: t('關閉') },
      { value: 'on', label: t('顯示足跡圖') },
      { value: 'focus', group: 'act', label: t('放大到最近 30 根') },
      { heading: t('失衡倍數（斜對角）') },
      { value: 'ratio:2', group: 'ratio', label: t('2 倍') },
      { value: 'ratio:3', group: 'ratio', label: t('3 倍') },
      { value: 'ratio:4', group: 'ratio', label: t('4 倍') },
    ],
  },
  // Hidden on spot cards: there is no open interest to show.
  { id: 'oi', label: t('未平倉量'), hint: t('未平倉量 (OI) 副圖，約每 3 秒更新'), toggle: true },
];

function icon(name) {
  return `<svg viewBox="0 0 14 14" width="14" height="14" fill="none"
    stroke="currentColor" stroke-width="1.5" stroke-linecap="round"
    stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
}

export class Toolbar {
  /**
   * @param {{active?: string, onSelect: (id: string) => void}} options
   */
  constructor({ active = 'cursor', onSelect }) {
    this.active = active;
    this.onSelect = onSelect;
    this.buttons = new Map();
    this.menus = new Map();
    this.openMenuId = null;
    this.root = el(
      'div.card__rail',
      {},
      TOOLS.map((tool) => {
        const button = el('button.card__rail-btn', {
          type: 'button',
          title: tool.hint,
          html: icon(tool.id),
          class: tool.id === active ? 'is-active' : '',
          onclick: () => (tool.menu ? this.toggleMenu(tool.id) : onSelect(tool.id)),
        });
        this.buttons.set(tool.id, button);
        if (tool.menu) this.menus.set(tool.id, this.buildMenu(tool));
        return button;
      })
    );
    for (const menu of this.menus.values()) this.root.append(menu.root);

    // Any press outside an open menu closes it. Capture phase, so a click on
    // the chart dismisses the menu before the chart acts on it.
    this.onOutside = (event) => {
      if (!this.openMenuId) return;
      const menu = this.menus.get(this.openMenuId);
      const button = this.buttons.get(this.openMenuId);
      if (menu.root.contains(event.target) || button.contains(event.target)) return;
      this.closeMenu();
    };
    window.addEventListener('mousedown', this.onOutside, true);
    // Must be set up front: the "keep an armed tool visible" rule keys off
    // `data-tool`, and an *absent* attribute matches :not([data-tool='cursor']),
    // which pinned the whole rail visible before a tool was ever chosen.
    this.root.dataset.tool = active;
  }

  /* ------------------------------------------------------------- menus */

  buildMenu(tool) {
    const items = new Map();
    const root = el(
      'div.card__rail-menu',
      { hidden: true },
      tool.menu.map((option) => {
        if (option.heading) return el('div.card__rail-menu-heading', { text: option.heading });
        const item = el('button.card__rail-menu-item', {
          type: 'button',
          text: typeof option.label === 'function' ? option.label() : option.label,
          onclick: () => {
            this.closeMenu();
            this.onSelect(tool.id, option.value);
          },
        });
        item.dataset.group = option.group || '';
        items.set(option.value, item);
        return item;
      })
    );
    const refresh = () => {
      for (const option of tool.menu) {
        if (option.heading) continue;
        if (typeof option.label === 'function') items.get(option.value).textContent = option.label();
      }
    };
    return { root, items, refresh };
  }

  toggleMenu(id) {
    if (this.openMenuId === id) {
      this.closeMenu();
      return;
    }
    this.closeMenu();
    const menu = this.menus.get(id);
    const button = this.buttons.get(id);
    menu.refresh();
    menu.root.hidden = false;
    this.openMenuId = id;
    this.root.classList.add('is-menu-open');

    // Level with its button, but clamped inside the chart: on a 220px card the
    // lower rail buttons sit close enough to the bottom that an unclamped menu
    // would be cut off by the card's clip.
    const chart = this.root.parentElement;
    const railTop = this.root.offsetTop;
    const room = (chart ? chart.clientHeight : 0) - railTop - menu.root.offsetHeight - 4;
    menu.root.style.top = `${Math.max(-railTop + 4, Math.min(button.offsetTop, room))}px`;
  }

  closeMenu() {
    if (!this.openMenuId) return;
    this.menus.get(this.openMenuId).root.hidden = true;
    this.openMenuId = null;
    this.root.classList.remove('is-menu-open');
  }

  /**
   * Tick the current option; light the rail button unless it is 'off'. A
   * named group (a second set of choices in the same menu) ticks on its own
   * and does not light the button.
   */
  setMenuValue(id, value, group = '') {
    const menu = this.menus.get(id);
    if (!menu) return;
    for (const [key, item] of menu.items) {
      if (item.dataset.group === group) item.classList.toggle('is-current', key === value);
    }
    if (!group) this.setToggled(id, value && value !== 'off');
  }

  /**
   * Fit the rail to the chart's height: as many rows as fit below its top
   * offset with room left for the time axis, then a new column. Re-run on
   * every resize of the card.
   */
  fitTo(container) {
    const ROW = 24; // 22px button + 2px gap
    const CHROME = 8; // rail padding and border
    const RESERVED = 64; // offset from the top, time axis at the bottom
    const apply = () => {
      const room = container.clientHeight - RESERVED - CHROME + 2;
      this.root.style.setProperty('--rail-rows', String(Math.max(3, Math.floor(room / ROW))));
    };
    this.resizeObserver = new ResizeObserver(apply);
    this.resizeObserver.observe(container);
    apply();
  }

  destroy() {
    window.removeEventListener('mousedown', this.onOutside, true);
    if (this.resizeObserver) this.resizeObserver.disconnect();
  }

  /**
   * Toggle-style entries light up independently of the armed drawing tool, so
   * a display layer can be on while the cursor is still the active tool.
   */
  setToggled(id, on) {
    const button = this.buttons.get(id);
    if (button) button.classList.toggle('is-on', !!on);
  }

  /** Take a button off the rail, e.g. OI on a spot card. */
  setHidden(id, hidden) {
    const button = this.buttons.get(id);
    if (button) button.hidden = !!hidden;
  }

  setActive(id) {
    this.active = id;
    for (const [key, button] of this.buttons) {
      const tool = TOOLS.find((t) => t.id === key);
      if (tool && tool.toggle) continue;
      button.classList.toggle('is-active', key === id);
    }
    // Lets the card style itself while a tool is armed (cursor, and keeping the
    // rail's active icon visible after the rest have faded out).
    this.root.dataset.tool = id;
  }
}
