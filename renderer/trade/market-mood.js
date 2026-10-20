/**
 * Which side is leaning, for the order ticket: the funding rate read against
 * its neutral level, and the exchange's long/short ratios.
 *
 * Funding is premium + clamp(interest - premium, +-0.05%), the interest part
 * being 0.01% per 8 hours. So with the perpetual trading at the index the
 * rate sits at exactly the neutral 0.01% (scaled to the symbol's interval):
 * above it, longs are paying up to hold the perpetual over spot; below it --
 * even while still positive -- the perpetual is at a discount, shorts pressing.
 * Positive rates are paid by longs to shorts, negative ones the other way.
 */

/** The interest part of funding: 0.01% per 8 hours. */
const NEUTRAL_PER_8H = 0.0001;

/**
 * @param {{fundingRate: number, intervalHours?: number}} funding
 * @param {number} notional  the ticket's amount in USDT; 0 for none
 * @returns {null|{
 *   rate: number, neutral: number, intervalHours: number,
 *   mood: 'long'|'short'|'neutral',
 *   payer: 'long'|'short'|null,   // who pays at the next settlement
 *   perSettle: number,            // |notional * rate|, USDT, 0 without a notional
 * }}
 */
export function fundingSummary(funding, notional = 0) {
  if (!funding || !Number.isFinite(funding.fundingRate)) return null;
  const rate = funding.fundingRate;
  const intervalHours = funding.intervalHours > 0 ? funding.intervalHours : 8;
  const neutral = (NEUTRAL_PER_8H * intervalHours) / 8;
  // Exactly neutral is common (the clamp pins it there); allow for rounding.
  const eps = 1e-8;
  const mood = rate > neutral + eps ? 'long' : rate < neutral - eps ? 'short' : 'neutral';
  const payer = rate > 0 ? 'long' : rate < 0 ? 'short' : null;
  const n = Number(notional);
  const perSettle = n > 0 ? Math.abs(n * rate) : 0;
  return { rate, neutral, intervalHours, mood, payer, perSettle };
}

export const MOOD_TEXT = {
  long: '多方偏熱',
  short: '空方偏熱',
  neutral: '中性',
};

/** 0.6218 -> "62%". */
export function share(x) {
  return Number.isFinite(x) ? `${Math.round(x * 100)}%` : '—';
}
