/**
 * Float-mode entry point: one card filling one frameless transparent window.
 */

import { CardView } from './cardview.js';
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
  const grip = el('div.sc-grip', { title: '拖曳調整大小' });
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
  const params = new URLSearchParams(location.search);
  const cardId = params.get('cardId');

  const boot = await api.bootstrap({ cardId });
  if (!boot.card) {
    root.append(el('div.card__overlay-text', { text: '找不到這張卡片的設定。' }));
    return;
  }

  const provider = getProvider();

  const persist = createPatchQueue(async (patch) => {
    const updated = await api.updateCard(cardId, patch);
    if (updated) view.applyCard(updated);
  });

  const view = new CardView({
    card: boot.card,
    provider,
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
  root.append(el('div.card__overlay-text', { text: `啟動失敗:${err.message}` }));
  console.error(err);
});
