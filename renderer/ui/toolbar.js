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
};

export const TOOLS = [
  { id: 'cursor', label: '游標', hint: '游標(雙擊加水平線、Shift 拖曳量測)' },
  { id: 'level', label: '水平線', hint: '水平支撐壓力線:點一下放線' },
  { id: 'measure', label: '量測', hint: '量測區間:直接拖曳' },
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
    this.buttons = new Map();
    this.root = el(
      'div.card__rail',
      {},
      TOOLS.map((tool) => {
        const button = el('button.card__rail-btn', {
          type: 'button',
          title: tool.hint,
          html: icon(tool.id),
          class: tool.id === active ? 'is-active' : '',
          onclick: () => onSelect(tool.id),
        });
        this.buttons.set(tool.id, button);
        return button;
      })
    );
    // Must be set up front: the "keep an armed tool visible" rule keys off
    // `data-tool`, and an *absent* attribute matches :not([data-tool='cursor']),
    // which pinned the whole rail visible before a tool was ever chosen.
    this.root.dataset.tool = active;
  }

  setActive(id) {
    this.active = id;
    for (const [key, button] of this.buttons) {
      button.classList.toggle('is-active', key === id);
    }
    // Lets the card style itself while a tool is armed (cursor, and keeping the
    // rail's active icon visible after the rest have faded out).
    this.root.dataset.tool = id;
  }
}
