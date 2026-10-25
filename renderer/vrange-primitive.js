/**
 * Range volume profiles: the volume traded at each price between two times
 * the user picked -- TradingView's Fixed Range Volume Profile.
 *
 * The fixed modes (4h blocks, today, the visible range) answer "where did
 * volume trade" for windows the clock chose. The question at a key level is
 * usually about a window the chart chose instead: the run-up into a top, the
 * week of chop before a breakout, everything since a crash low. So the user
 * drags it out, from x1 to x2; price plays no part in the gesture.
 *
 * On the chart, each range is:
 *
 *   a faint band over its time span, with dashed edges
 *   the histogram, growing right from the band's left edge, buying (teal)
 *     against the edge and selling (red) after it, brighter in the value area
 *   POC (solid amber), VAH and VAL (dotted), each labelled at the band's right
 *   a header tag at the top: span, total volume, which bars it was built from
 *
 * A range whose right edge reaches the newest bar is "至今": it stays open and
 * grows with the market.
 *
 * Grabbing is by the edges (resize) and the header tag (move); double-click
 * either to delete. Not the interior, for the same reason as rectangles:
 * a range is wide, and the inside is where the user pans from.
 */

import { formatCompact } from './util.js';
import { t } from './i18n.js';
import { paintRows, projectRows, rowsOnScreen } from './vp-primitive.js';

const BAND = 'rgba(148, 163, 184, 0.05)';
const BAND_ACTIVE = 'rgba(148, 163, 184, 0.1)';
const EDGE = 'rgba(148, 163, 184, 0.45)';
const EDGE_ACTIVE = 'rgba(203, 213, 225, 0.9)';
const POC = 'rgba(240, 180, 90, 0.95)';
const POC_TEXT = 'rgba(245, 200, 130, 1)';
const VA_LINE = 'rgba(160, 180, 210, 0.75)';
const TAG_BG = 'rgba(11, 15, 23, 0.88)';
const TAG_TEXT = '#cbd5e1';

const FONT_PX = 10;
const FONT = (px) => `${px}px 'Segoe UI', 'Microsoft JhengHei', sans-serif`;
const TAG_H = 16;
const TAG_TOP = 6;

/** How near, in px, the pointer must be to take an edge. */
export const VRANGE_EDGE_PX = 5;

/** The histogram uses most of the band, within limits a narrow band can still read. */
const MIN_LENGTH = 70;
const MAX_SHARE_OF_BAND = 0.72;
const MAX_SHARE_OF_PLOT = 0.45;

let measureCtx = null;
function textWidth(text) {
  if (!measureCtx) {
    measureCtx = document.createElement('canvas').getContext('2d');
    measureCtx.font = FONT(FONT_PX);
  }
  return measureCtx.measureText(text).width;
}

/** 2天6時, 5時20分, 45分 -- the span of a range, in the card's language. */
export function formatSpan(seconds) {
  const total = Math.max(0, Math.round(seconds / 60)) * 60;
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d) return h ? t('{d}天{h}時', { d, h }) : t('{d}天', { d });
  if (h) return m ? t('{h}時{m}分', { h, m }) : t('{h}時', { h });
  return t('{m}分', { m });
}

const INTERVAL_TEXT = {
  '1m': t('1分K'),
  '5m': t('5分K'),
  '15m': t('15分K'),
  '1h': t('1時K'),
  '4h': t('4時K'),
  '1d': t('日K'),
};

class VRangeRenderer {
  constructor(source) {
    this.source = source;
  }

  /** Band and histogram behind the candles. */
  drawBackground(target) {
    const items = this.source.items;
    if (!items.length) return;
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      for (const it of items) {
        const x0 = Math.round(it.left * hr);
        const x1 = Math.round(it.right * hr);
        ctx.fillStyle = it.active ? BAND_ACTIVE : BAND;
        ctx.fillRect(x0, 0, Math.max(1, x1 - x0), bitmapSize.height);
        paintRows(ctx, it.rows, x0, false, hr, vr);
      }
    });
  }

  /** Edges, value lines, labels and the tag above the candles. */
  draw(target) {
    const items = this.source.items;
    if (!items.length) return;
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      const thin = Math.max(1, Math.floor(hr));
      ctx.font = FONT(Math.round(FONT_PX * vr));
      ctx.textBaseline = 'bottom';
      for (const it of items) {
        const x0 = Math.round(it.left * hr);
        const x1 = Math.round(it.right * hr);

        // Edges: dashed at rest, solid with grips under the pointer.
        ctx.strokeStyle = it.active ? EDGE_ACTIVE : EDGE;
        ctx.lineWidth = thin;
        ctx.setLineDash(it.active ? [] : [4 * hr, 3 * hr]);
        for (const x of [x0, x1]) {
          ctx.beginPath();
          ctx.moveTo(x + thin / 2, 0);
          ctx.lineTo(x + thin / 2, bitmapSize.height);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        if (it.active) {
          const gh = Math.round(22 * vr);
          const gw = Math.round(4 * hr);
          const gy = Math.round(bitmapSize.height / 2 - gh / 2);
          ctx.fillStyle = EDGE_ACTIVE;
          for (const x of [x0, x1]) ctx.fillRect(x - gw / 2 + thin / 2, gy, gw, gh);
        }

        // Value area edges, then the POC over them.
        ctx.textAlign = 'right';
        const labelX = x1 - Math.round(4 * hr);
        const lineSpan = Math.max(1, x1 - x0);
        for (const [y, text] of [[it.vahY, it.vahText], [it.valY, it.valText]]) {
          if (y === null) continue;
          const by = Math.round(y * vr);
          ctx.fillStyle = VA_LINE;
          for (let x = x0; x < x1; x += Math.round(5 * hr)) ctx.fillRect(x, by, Math.max(1, Math.round(2 * hr)), thin);
          if (lineSpan > 90 * hr) ctx.fillText(text, labelX, by - Math.round(2 * vr));
        }
        if (it.pocY !== null) {
          const line = Math.max(2, Math.round(1.5 * vr));
          const by = Math.round(it.pocY * vr) - Math.floor(line / 2);
          ctx.fillStyle = POC;
          ctx.fillRect(x0, by, lineSpan, line);
          ctx.fillStyle = POC_TEXT;
          ctx.fillText(it.pocText, labelX, by - Math.round(2 * vr));
        }

        // Header tag.
        const tag = it.tag;
        const tx = Math.round(tag.x * hr);
        const ty = Math.round(tag.y * vr);
        const tw = Math.round(tag.w * hr);
        const th = Math.round(tag.h * vr);
        ctx.fillStyle = TAG_BG;
        ctx.fillRect(tx, ty, tw, th);
        ctx.strokeStyle = it.active ? EDGE_ACTIVE : EDGE;
        ctx.lineWidth = thin;
        ctx.strokeRect(tx + thin / 2, ty + thin / 2, tw - thin, th - thin);
        ctx.fillStyle = TAG_TEXT;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(tag.text, tx + Math.round(6 * hr), ty + th / 2);
        ctx.textBaseline = 'bottom';
      }
    });
  }
}

class VRangePaneView {
  constructor(source) {
    this.rendererInstance = new VRangeRenderer(source);
  }

  renderer() {
    return this.rendererInstance;
  }
}

export class VRangePrimitive {
  /** @param {import('./chart.js').CardChart} card */
  constructor(card) {
    this.card = card;
    /** [{id, from, to|null}] -- times in seconds; to is exclusive, null = 至今 */
    this.ranges = [];
    /** id -> {source: ProfileSource|null, interval, loading, error} */
    this.data = new Map();
    this.draft = null;
    this.activeId = null;
    this.detail = 'normal';
    this.items = [];
    this.requestUpdate = null;
    this.views = [new VRangePaneView(this)];
    /** Hidden by the rail's eye: kept, not drawn, and not grabbable. */
    this.hidden = false;
  }

  attached({ requestUpdate }) {
    this.requestUpdate = requestUpdate;
  }

  detached() {
    this.requestUpdate = null;
  }

  paneViews() {
    return this.hidden ? [] : this.views;
  }

  setHidden(hidden) {
    if (this.hidden === !!hidden) return;
    this.hidden = !!hidden;
    this.update();
  }

  updateAllViews() {
    this.items = this.computeItems();
  }

  /* ----------------------------------------------------------- public */

  set(ranges, data) {
    this.ranges = Array.isArray(ranges) ? ranges : [];
    if (data) this.data = data;
    this.update();
  }

  /** A range being dragged out, moved or resized, drawn ahead of the store. */
  setDraft(draft) {
    this.draft = draft;
    this.update();
  }

  setActive(id) {
    if (this.activeId === id) return;
    this.activeId = id;
    this.update();
  }

  setDetail(detail) {
    this.detail = detail;
    this.update();
  }

  update() {
    if (this.requestUpdate) this.requestUpdate();
  }

  /* ---------------------------------------------------------- geometry */

  /** Left and right edge x of a range, or null when it cannot be placed. */
  edges(range) {
    const card = this.card;
    if (!card.bars.length) return null;
    const fromLogical = card.logicalFromTime(range.from);
    const toLogical = range.to === null ? card.bars.length : card.logicalFromTime(range.to);
    if (fromLogical === null || toLogical === null) return null;
    const left = card.logicalToX(fromLogical - 0.5);
    const right = card.logicalToX(toLogical - 0.5);
    if (left === null || right === null) return null;
    return { left: Math.min(left, right), right: Math.max(left, right) };
  }

  layoutOne(range, isDraft) {
    const card = this.card;
    const box = this.edges(range);
    if (!box) return null;
    const plotWidth = card.plotWidth();
    if (box.right < 0 || box.left > plotWidth) return null;

    const now = Math.floor(Date.now() / 1000);
    const span = (range.to === null ? now : range.to) - range.from;
    const info = isDraft ? null : this.data.get(range.id);
    const source = info && info.source;
    const profile = source ? source.at(rowsOnScreen(card, source, this.detail)) : null;

    const width = box.right - box.left;
    const maxLength = Math.min(Math.max(width * MAX_SHARE_OF_BAND, MIN_LENGTH), plotWidth * MAX_SHARE_OF_PLOT);

    let text = formatSpan(span) + (range.to === null ? ' ' + t('至今') : '');
    if (profile) {
      text += ' · ' + t('量 {v}', { v: formatCompact(profile.total) });
      if (info.interval) text += ` · ${INTERVAL_TEXT[info.interval] || info.interval}`;
    } else if (info && info.error) {
      text += ' · ' + t('載入失敗');
    } else if (!isDraft) {
      text += ' · ' + t('計算中…');
    }
    const tagW = Math.ceil(textWidth(text)) + 12;
    // The tag follows the band but stays on screen while any of it is.
    const tagX = Math.max(4, box.left + 4);

    const y = (price) => (profile ? card.priceToY(price) : null);
    return {
      id: range.id,
      left: box.left,
      right: box.right,
      live: range.to === null,
      active: isDraft || range.id === this.activeId,
      rows: profile ? projectRows(card, profile, maxLength) : [],
      pocY: y(profile && profile.poc),
      vahY: y(profile && profile.vah),
      valY: y(profile && profile.val),
      pocText: profile ? `POC ${card.formatPrice(profile.poc)}` : '',
      vahText: profile ? `VAH ${card.formatPrice(profile.vah)}` : '',
      valText: profile ? `VAL ${card.formatPrice(profile.val)}` : '',
      tag: { x: tagX, y: TAG_TOP, w: tagW, h: TAG_H, text },
      draft: isDraft,
    };
  }

  computeItems() {
    const out = [];
    for (const range of this.ranges) {
      // While a stored range is being moved, the draft stands in for it.
      if (this.draft && this.draft.id === range.id) continue;
      const item = this.layoutOne(range, false);
      if (item) out.push(item);
    }
    if (this.draft) {
      // A moved range keeps its profile while it slides; only a new one has none.
      const stored = this.draft.id !== '__draft__';
      const item = this.layoutOne(this.draft, !stored);
      if (item) out.push({ ...item, active: true });
    }
    return out;
  }

  /**
   * What the pointer is over, topmost range first:
   *   { id, part: 'tag' }            the header: move
   *   { id, part: 'left' | 'right' } an edge: resize
   */
  hitTest(x, y) {
    if (this.hidden) return null;
    const items = this.computeItems().filter((it) => !it.draft);
    for (let i = items.length - 1; i >= 0; i--) {
      const t = items[i].tag;
      if (x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h) return { id: items[i].id, part: 'tag' };
    }
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (Math.abs(x - it.left) <= VRANGE_EDGE_PX) return { id: it.id, part: 'left' };
      if (Math.abs(x - it.right) <= VRANGE_EDGE_PX) return { id: it.id, part: 'right' };
    }
    return null;
  }
}
