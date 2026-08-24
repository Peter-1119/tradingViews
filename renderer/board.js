/**
 * Board-mode entry point: every card in one transparent window, laid out on a
 * CSS grid, reorderable by dragging a card's title bar (spec 4.1).
 *
 * Cards here are the exact same CardView used in Float mode, minus the
 * window-level controls — which is why a mode switch loses nothing.
 */

import { CardView } from './cardview.js';
import { getProvider } from './datafeed/remote.js';
import { el, clamp, createPatchQueue } from './util.js';

const api = window.stockcard;
const root = document.getElementById('root');

const MIN_COLUMNS = 1;
const MAX_COLUMNS = 6;

/** Same pointer-driven grip as Float mode, resizing the board window itself. */
function attachResizeGrip(container) {
  const grip = el('div.sc-grip', { title: '拖曳調整視窗大小' });
  let origin = null;

  grip.addEventListener('pointerdown', async (event) => {
    event.preventDefault();
    const bounds = await api.getBounds();
    if (!bounds) return;
    origin = {
      screenX: event.screenX,
      screenY: event.screenY,
      width: bounds.width,
      height: bounds.height,
    };
    grip.setPointerCapture(event.pointerId);
  });

  grip.addEventListener('pointermove', (event) => {
    if (!origin) return;
    api.setSize(
      origin.width + (event.screenX - origin.screenX),
      origin.height + (event.screenY - origin.screenY)
    );
  });

  const end = (event) => {
    if (!origin) return;
    origin = null;
    if (grip.hasPointerCapture(event.pointerId)) grip.releasePointerCapture(event.pointerId);
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);

  container.append(grip);
}

async function main() {
  const boot = await api.bootstrap({});
  const provider = getProvider();

  let prefs = boot.prefs;
  let columns = clamp(prefs.boardColumns || 2, MIN_COLUMNS, MAX_COLUMNS);
  let clickThrough = boot.clickThrough;

  /** @type {Map<string, CardView>} */
  const views = new Map();

  /* ------------------------------------------------------------ chrome */

  const countEl = el('span.board__count', { text: '' });
  const colsValue = el('span.board__cols-value', { text: String(columns) });

  const setColumns = (next) => {
    columns = clamp(next, MIN_COLUMNS, MAX_COLUMNS);
    colsValue.textContent = String(columns);
    grid.style.setProperty('--cols', String(columns));
    api.setPrefs({ boardColumns: columns });
  };

  const grid = el('div.board__grid');

  const bar = el(
    'div.board__bar',
    {},
    el('span.board__title', { text: 'StockCard' }),
    countEl,
    el(
      'div.board__tools',
      {},
      el(
        'div.board__cols',
        {},
        el('button.sc-icon-btn', {
          type: 'button',
          text: '−',
          title: '減少欄數',
          onclick: () => setColumns(columns - 1),
        }),
        colsValue,
        el('button.sc-icon-btn', {
          type: 'button',
          text: '+',
          title: '增加欄數',
          onclick: () => setColumns(columns + 1),
        })
      ),
      el('button.sc-icon-btn', {
        type: 'button',
        text: '＋',
        title: '新增卡片',
        onclick: () => api.addCard({}),
      }),
      el('button.sc-icon-btn', {
        type: 'button',
        text: '⧉',
        title: '切換為 Float 模式(每張圖獨立視窗)',
        onclick: () => api.setMode('float'),
      }),
      el('button.sc-icon-btn', {
        type: 'button',
        text: '🖱',
        title: '滑鼠穿透(Ctrl+Alt+C 解除)',
        onclick: () => api.toggleClickThrough(),
      }),
      el('button.sc-icon-btn', {
        type: 'button',
        text: '—',
        title: '隱藏全部(Ctrl+Alt+S 叫回)',
        onclick: () => api.hideAll(),
      })
    )
  );

  const board = el('div.board', {}, bar, grid);
  root.append(board);
  attachResizeGrip(board);
  grid.style.setProperty('--cols', String(columns));

  /* ------------------------------------------------------------- cards */

  function createView(card) {
    const persist = createPatchQueue(async (patch) => {
      const updated = await api.updateCard(card.id, patch);
      if (updated) view.applyCard(updated);
    });

    const view = new CardView({
      card,
      provider,
      prefs,
      intervals: boot.intervals,
      chartTypes: boot.chartTypes,
      windowControls: false,
      onPatch: (patch) => {
        view.preview(patch);
        persist(patch);
      },
      onRemove: () => api.removeCard(card.id),
    });
    view.setClickThrough(clickThrough);
    view.mount();
    attachReorder(view);
    return view;
  }

  /** Reconcile the grid against the store's card list. */
  function syncCards(cards) {
    const wanted = new Set(cards.map((c) => c.id));

    for (const [id, view] of [...views]) {
      if (!wanted.has(id)) {
        view.destroy();
        views.delete(id);
      }
    }

    for (const card of cards) {
      const existing = views.get(card.id);
      if (existing) existing.applyCard(card);
      else views.set(card.id, createView(card));
    }

    // Re-append in store order; appending an existing node moves it.
    grid.replaceChildren(...cards.map((c) => views.get(c.id).root));

    if (!cards.length) {
      grid.append(el('div.board__empty', { text: '還沒有卡片,點右上角的 ＋ 新增一張。' }));
    }

    countEl.textContent = `${cards.length} 張卡片`;
    for (const view of views.values()) view.resize();
  }

  /* ---------------------------------------------------------- reorder */

  let dragState = null;

  function attachReorder(view) {
    view.bar.addEventListener('pointerdown', (event) => {
      // Buttons and the settings panel must keep their own behaviour.
      if (event.target.closest('button, input, .sc-panel')) return;
      if (event.button !== 0) return;

      event.preventDefault();
      dragState = { view, pointerId: event.pointerId, moved: false };
      view.root.classList.add('is-dragging');
      view.bar.setPointerCapture(event.pointerId);
    });

    view.bar.addEventListener('pointermove', (event) => {
      if (!dragState || dragState.view !== view) return;
      dragState.moved = true;

      const under = document
        .elementsFromPoint(event.clientX, event.clientY)
        .find((node) => node.classList && node.classList.contains('card') && node !== view.root);
      if (!under) return;

      for (const node of grid.children) node.classList.remove('is-drop-target');
      under.classList.add('is-drop-target');

      const children = [...grid.children];
      const from = children.indexOf(view.root);
      const to = children.indexOf(under);
      if (from === -1 || to === -1) return;
      if (from < to) under.after(view.root);
      else under.before(view.root);
    });

    const finish = (event) => {
      if (!dragState || dragState.view !== view) return;
      view.root.classList.remove('is-dragging');
      for (const node of grid.children) node.classList.remove('is-drop-target');
      if (view.bar.hasPointerCapture(event.pointerId)) {
        view.bar.releasePointerCapture(event.pointerId);
      }
      const moved = dragState.moved;
      dragState = null;

      if (moved) {
        const ids = [...grid.children].map((node) => node.dataset.cardId).filter(Boolean);
        api.reorderCards(ids);
      }
    };

    view.bar.addEventListener('pointerup', finish);
    view.bar.addEventListener('pointercancel', finish);
  }

  /* ------------------------------------------------------------ events */

  syncCards(boot.cards);

  api.onCardsChanged((cards) => syncCards(cards));

  api.onCardChanged((card) => {
    const view = views.get(card.id);
    if (view) view.applyCard(card);
  });

  api.onPrefs((next) => {
    prefs = next;
    for (const view of views.values()) view.setPrefs(next);
    if (next.boardColumns && next.boardColumns !== columns) {
      columns = next.boardColumns;
      colsValue.textContent = String(columns);
      grid.style.setProperty('--cols', String(columns));
    }
  });

  api.onClickThrough((payload) => {
    clickThrough = payload.clickThrough;
    for (const view of views.values()) view.setClickThrough(clickThrough);
  });

  api.onVisibility(({ hidden }) => {
    for (const view of views.values()) {
      if (hidden) view.pause();
      else view.resume();
    }
  });

  document.addEventListener('visibilitychange', () => {
    for (const view of views.values()) {
      if (document.hidden) view.pause();
      else view.resume();
    }
  });

  window.addEventListener('resize', () => {
    for (const view of views.values()) view.resize();
  });

  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    for (const view of views.values()) view.panel.close();
  });

  window.addEventListener('beforeunload', () => {
    for (const view of views.values()) view.destroy();
  });
}

main().catch((err) => {
  root.append(el('div.card__overlay-text', { text: `啟動失敗:${err.message}` }));
  console.error(err);
});
