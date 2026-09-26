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

/** 14x14 viewBox, 1.5px stroke -- legible at the size the card can spare. */
const ICONS = {
  cursor: '<path d="M3 2l8 5-3.2 1.1L6.6 11.5z"/>',
  level: '<path d="M1.5 7h11"/><circle cx="4.5" cy="7" r="1.6"/>',
  measure: '<path d="M2 12V4h8"/><path d="M2 12l9-9"/><path d="M6.5 7.5l1.6 1.6"/>',
  fib: '<path d="M1.5 2.5h11"/><path d="M1.5 5.5h11"/><path d="M1.5 8.5h11"/><path d="M1.5 11.5h11"/>',
  rect: '<rect x="2" y="3.5" width="10" height="7" rx="0.5"/>',
  vp: '<path d="M12.5 2.5h-5"/><path d="M12.5 5h-9"/><path d="M12.5 7.5h-11"/><path d="M12.5 10h-7"/><path d="M12.5 12.5h-4"/>',
  htf: '<rect x="1.5" y="4" width="4.5" height="6" rx="1"/><path d="M3.75 1.5v2.5M3.75 10v2.5"/>'
    + '<rect x="8" y="5.5" width="4.5" height="5" rx="1"/><path d="M10.25 3v2.5M10.25 10.5v2"/>',
  // Vertical bars from a baseline -- the volume pane itself, and unlike the
  // horizontal bars of the volume *profile* above.
  volume: '<path d="M1.5 12.5h11"/><path d="M3.5 10.5V8" stroke-width="2.2"/>'
    + '<path d="M7 10.5V3.5" stroke-width="2.2"/><path d="M10.5 10.5V6" stroke-width="2.2"/>',
  // The letters: no glyph says "open interest", and traders read OI at a glance.
  oi: '<text x="7" y="10.2" text-anchor="middle" font-size="7.5" font-weight="700" letter-spacing="-0.2"'
    + ' font-family="Segoe UI, sans-serif" fill="currentColor" stroke="none">OI</text>',
};

export const TOOLS = [
  { id: 'cursor', label: '游標', hint: '游標(雙擊加水平線、Shift 拖曳量測)' },
  { id: 'level', label: '水平線', hint: '水平支撐壓力線:點一下放線' },
  { id: 'measure', label: '量測', hint: '量測區間:直接拖曳' },
  { id: 'fib', label: '斐波那契', hint: '斐波那契回撤:拖曳畫出波段' },
  { id: 'rect', label: '矩形', hint: '矩形區間:拖曳畫出。拖邊框移動、拖角調整、雙擊內部刪除' },
  {
    id: 'vp',
    label: '成交量分布',
    hint: '成交量分布(點一下選模式)',
    // Not a drawing mode -- a display layer with several variants, so it opens
    // a menu instead of arming a tool. It lights up while any variant is on.
    toggle: true,
    menu: [
      { value: 'off', label: '關閉' },
      { value: 'session4h', label: '每 4H 分段' },
      { value: 'visible', label: '可見範圍' },
      { value: 'day', label: '本日 (UTC)' },
    ],
  },
  {
    id: 'htf',
    label: '4H 疊圖',
    hint: '把最近 10 根 4 小時 K 棒疊在小週期圖上，未收盤的那根會跟著跳',
    toggle: true,
  },
  { id: 'volume', label: '成交量', hint: '成交量副圖', toggle: true },
  // Hidden on spot cards: there is no open interest to show.
  { id: 'oi', label: '未平倉量', hint: '未平倉量 (OI) 副圖，約每 3 秒更新', toggle: true },
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
        const item = el('button.card__rail-menu-item', {
          type: 'button',
          text: option.label,
          onclick: () => {
            this.closeMenu();
            this.onSelect(tool.id, option.value);
          },
        });
        items.set(option.value, item);
        return item;
      })
    );
    return { root, items };
  }

  toggleMenu(id) {
    if (this.openMenuId === id) {
      this.closeMenu();
      return;
    }
    this.closeMenu();
    const menu = this.menus.get(id);
    const button = this.buttons.get(id);
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

  /** Tick the current option; light the rail button unless it is 'off'. */
  setMenuValue(id, value) {
    const menu = this.menus.get(id);
    if (!menu) return;
    for (const [key, item] of menu.items) item.classList.toggle('is-current', key === value);
    this.setToggled(id, value && value !== 'off');
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
