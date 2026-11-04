/**
 * The order ticket's warning for TradFi perpetuals (stocks, ETFs, metals,
 * oil, FX). They trade around the clock on Binance, but the underlying does
 * not: outside its session the price is Binance's own, on a thin book, and
 * it can jump when the session opens.
 *
 * US stocks say whether New York is in session now (Mon-Fri 9:30-16:00
 * America/New_York, so daylight saving is the time zone's business; market
 * holidays are not known here).
 */

import { t } from '../i18n.js';

/** Is the US stock market's regular session open at `now`? Holidays aside. */
export function usSessionOpen(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value])
  );
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

/** The ticket's note for a TradFi underlyingType, or '' for crypto. */
export function tradfiNote(kind, now = new Date()) {
  if (!kind) return '';
  const first = t('傳統資產永續：第一次交易需先在幣安同意 TradFi 合約條款。');
  if (kind === 'EQUITY') {
    return usSessionOpen(now)
      ? first + t('美股交易時段中。')
      : first + t('美股休市中：目前是幣安自己的報價，掛單少，開盤時可能跳空。');
  }
  return first + t('原市場休市時掛單少，開盤時可能跳空。');
}
