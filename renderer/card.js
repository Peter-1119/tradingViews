/**
 * Float-mode entry point: one card filling one frameless transparent window.
 */

import { CardView } from './cardview.js';
import { t } from './i18n.js';
import { getProvider } from './datafeed/remote.js';
import { el, createPatchQueue } from './util.js';

const api = window.stockcard;
const root = document.getElementById('root');

/**
 * Explicit resize grip.
 *
 * A frameless transparent window's native resize border is a few pixels wide
 * and easy to miss on a small card, so we drive `setSize` from pointer deltas
 * in screen coordinates instead.
 */
function attachResizeGrip(container) {
  const grip = el('div.sc-grip', { title: t('拖曳調整大小') });
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

/**
 * Moving the window when Windows stops treating the title bar as one.
 *
 * A press on a `-webkit-app-region: drag` area is normally taken by Windows
 * as a caption drag and never reaches the page. After the window goes to a
 * compact form and back, Windows can lose that region (seen on a 125% display
 * with window opacity set): the press lands in the page, which starts a
 * drag-and-drop with the "not allowed" cursor and the window stays put. So a
 * press the page does receive there is proof the native drag missed, and the
 * window is moved from pointer deltas instead.
 */
function attachMoveFallback(container) {
  // The region an element is in: its own, or the nearest ancestor's that sets one.
  const inDragRegion = (node) => {
    for (let n = node; n && n !== container.parentNode; n = n.parentElement) {
      const region = getComputedStyle(n).webkitAppRegion;
      if (region === 'drag') return true;
      if (region === 'no-drag') return false;
    }
    return false;
  };
  let origin = null;
  let frame = 0;
  let next = null;

  container.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0 || !inDragRegion(event.target)) return;
      event.preventDefault();
      origin = { screenX: event.screenX, screenY: event.screenY, x: window.screenX, y: window.screenY, start: true };
      container.setPointerCapture(event.pointerId);
    },
    true
  );

  container.addEventListener('pointermove', (event) => {
    if (!origin) return;
    next = { x: origin.x + event.screenX - origin.screenX, y: origin.y + event.screenY - origin.screenY };
    // One move per frame: the IPC round trip is slower than the pointer.
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!next || !origin) return;
        api.moveTo({ ...next, start: origin.start });
        origin.start = false;
      });
    }
  });

  const end = (event) => {
    if (!origin) return;
    origin = null;
    if (container.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId);
  };
  container.addEventListener('pointerup', end);
  container.addEventListener('pointercancel', end);
  container.addEventListener('dragstart', (event) => {
    if (inDragRegion(event.target)) event.preventDefault();
  });
}

async function main() {
  const params = new URLSearchParams(location.search);
  const cardId = params.get('cardId');

  const boot = await api.bootstrap({ cardId });
  if (!boot.card) {
    root.append(el('div.card__overlay-text', { text: t('找不到這張卡片的設定。') }));
    return;
  }


  const persist = createPatchQueue(async (patch) => {
    const updated = await api.updateCard(cardId, patch);
    if (updated) view.applyCard(updated);
  });

  const view = new CardView({
    card: boot.card,
    feedFor: getProvider,
    prefs: boot.prefs,
    intervals: boot.intervals,
    chartTypes: boot.chartTypes,
    windowControls: true,
    onPatch: (patch) => {
      // Window-level effects apply straight away so sliders and toggles feel
      // instant; the (possibly debounced) store write is what persists them.
      if ('windowOpacity' in patch) api.setWindowOpacity(patch.windowOpacity);
      if ('alwaysOnTop' in patch) api.setAlwaysOnTop(patch.alwaysOnTop);
      view.preview(patch);
      persist(patch);
    },
    onRemove: () => api.closeWindow({ cardId }),
  });

  root.append(view.root);
  attachResizeGrip(view.root);
  attachMoveFallback(view.root);

  view.setClickThrough(boot.clickThrough);
  await view.mount();

  /* ------------------------------------------------------------- events */

  api.onCardChanged((card) => {
    if (card && card.id === cardId) view.applyCard(card);
  });

  api.onPrefs((prefs) => view.setPrefs(prefs));

  api.onClickThrough(({ clickThrough }) => view.setClickThrough(clickThrough));

  api.onAlwaysOnTop(({ alwaysOnTop }) => {
    view.applyCard({ ...view.card, alwaysOnTop });
  });

  // Stop rendering while hidden but keep caching bars (spec 5).
  api.onVisibility(({ hidden }) => (hidden ? view.pause() : view.resume()));
  document.addEventListener('visibilitychange', () => {
    // Chromium also sets this on its own when it decides the window is fully
    // covered (native occlusion), and then stops painting it; logged so a
    // trace can tell that apart from the window really being hidden.
    console.log(`[page] visibility ${document.visibilityState}`);
    if (document.hidden) view.pause();
    else view.resume();
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      view.dismissMeasure();
      view.panel.close();
    }
  });

  // Keep the chart's pane heights correct as the window resizes.
  window.addEventListener('resize', () => view.resize());

  // A frameless window has no OS context menu; offer the settings panel instead.
  // Right-clicking inside the panel itself must not slam it shut mid-edit.
  window.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (event.target.closest && event.target.closest('.sc-panel')) return;
    view.panel.toggle();
  });

  window.addEventListener('beforeunload', () => view.destroy());
}

main().catch((err) => {
  root.append(el('div.card__overlay-text', { text: t('啟動失敗:{error}', { error: err.message }) }));
  console.error(err);
});
