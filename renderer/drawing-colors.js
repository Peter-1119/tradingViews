/**
 * Colours a drawing can be given (right-click a level, trend line or
 * rectangle). A drawing with no colour keeps the original blue, so lines
 * drawn before colours existed look exactly as they did.
 *
 * Stored as `#rrggbb`; the renderers derive their fills and the highlighted
 * (hovered or dragged) look from it with `tint`.
 */

import { t } from './i18n.js';

export const DRAWING_COLORS = [
  { value: null, label: t('預設（藍）') },
  { value: '#26c281', label: t('綠：支撐') },
  { value: '#ed5465', label: t('紅：壓力') },
  { value: '#f5a623', label: t('橘') },
  { value: '#f2d54b', label: t('黃') },
  { value: '#a77bf3', label: t('紫') },
  { value: '#d6dde6', label: t('白') },
];

/** `#rrggbb` with an alpha, as an rgba() string. */
export function tint(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
