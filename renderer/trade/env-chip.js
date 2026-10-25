/**
 * The small badge that says the money is not real: 模擬 on the paper
 * account, 測試網 on Binance's demo exchange, nothing at all when live.
 */
import { t } from '../i18n.js';

export function envChip(node, env) {
  node.hidden = env !== 'testnet' && env !== 'paper';
  node.textContent = env === 'paper' ? t('模擬') : t('測試網');
}
