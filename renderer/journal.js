/**
 * The paper account's journal: how the strategy is doing, in numbers a
 * trader reads -- return, hit rate, how big the wins are against the
 * losses, what fees and funding cost, the worst drawdown -- then the
 * wallet's curve, the positions still open, every closed position, and
 * every movement of money.
 *
 * Everything comes from the main process (paper:journal) and is redrawn
 * when the account changes (paper:changed).
 */

import { el } from './util.js';
import { createChart, BaselineSeries } from './vendor/lightweight-charts.mjs';

const api = () => window.stockcard.trading;

const REASONS = {
  manual: '手動',
  close: '平倉鍵',
  limit: '限價',
  tp: '止盈',
  sl: '止損',
  reverse: '反手',
  liquidation: '強平',
};
const LEDGER_TYPES = {
  DEPOSIT: '入金',
  REALIZED_PNL: '已實現損益',
  COMMISSION: '手續費',
  FUNDING_FEE: '資金費',
  LIQUIDATION_FEE: '強平清算費',
  INSURANCE: '穿倉補足',
};

const num = (n, d = 2) =>
  Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
const signed = (n, d = 2) => (Number.isFinite(n) ? `${n > 0 ? '+' : n < 0 ? '−' : ''}${num(Math.abs(n), d)}` : '—');
const tone = (n) => (n > 0 ? 'is-up' : n < 0 ? 'is-down' : '');
/** Prices at a sensible precision: more digits for small numbers. */
const price = (p) => (Number.isFinite(p) && p > 0 ? num(p, p >= 1000 ? 2 : p >= 1 ? 4 : 6) : '—');
const pad = (n) => String(n).padStart(2, '0');
const when = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
function duration(ms) {
  if (!(ms > 0)) return '—';
  const m = Math.round(ms / 60e3);
  if (m < 60) return `${m} 分`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} 時 ${m % 60} 分`;
  return `${Math.floor(h / 24)} 天 ${h % 24} 時`;
}

class Journal {
  constructor(root) {
    this.data = null;
    this.tab = 'history';
    this.symbol = '';

    this.sinceEl = el('span.jr-since');
    this.kpis = el('div.jr-kpis');
    this.curveEmpty = el('div.jr-curve__empty', { text: '還沒有資金變動' });
    this.curveEl = el('div.jr-curve__chart');
    this.openBox = el('div.jr-open', { hidden: true });
    this.filter = el('select.jr-tabs__filter', { title: '只看這個幣種' });
    this.filter.addEventListener('change', () => {
      this.symbol = this.filter.value;
      this.renderTable();
    });
    this.tabs = [
      ['history', '歷史倉位'],
      ['ledger', '資金明細'],
    ].map(([id, text]) => el('button.jr-tab', { type: 'button', text, onclick: () => this.setTab(id) }));
    this.tableWrap = el('div.jr-table-wrap');

    root.append(
      el(
        'div.jr',
        {},
        el(
          'div.jr-head',
          {},
          el('h1.jr-title', { text: '模擬交易紀錄' }),
          this.sinceEl,
          el(
            'div.jr-head__tools',
            {},
            el('button.jr-btn', { type: 'button', text: '匯出 CSV', title: '歷史倉位存成 CSV，可用 Excel 開啟', onclick: () => this.exportCsv() })
          )
        ),
        this.kpis,
        el('div.jr-curve', {}, el('div.jr-curve__label', { text: '資金曲線（已實現，含手續費與資金費）' }), this.curveEl, this.curveEmpty),
        this.openBox,
        el('div.jr-tabs', {}, this.tabs, this.filter),
        this.tableWrap
      )
    );

    this.chart = createChart(this.curveEl, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: 'rgba(203, 213, 225, 0.62)', fontSize: 11, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: 'rgba(148, 163, 184, 0.08)' } },
      rightPriceScale: { borderVisible: false },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        // The library labels in UTC; the tables are in local time, so the axis is too.
        tickMarkFormatter: (t, type) => {
          const d = new Date(t * 1000);
          if (type <= 1) return `${d.getFullYear()}/${pad(d.getMonth() + 1)}`;
          if (type === 2) return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
          return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
        },
      },
      crosshair: { horzLine: { labelBackgroundColor: '#1e293b' }, vertLine: { labelBackgroundColor: '#1e293b' } },
      localization: {
        timeFormatter: (t) => when(t * 1000),
        priceFormatter: (p) => num(p),
      },
    });
    this.series = this.chart.addSeries(BaselineSeries, {
      topLineColor: '#26c281',
      topFillColor1: 'rgba(38, 194, 129, 0.28)',
      topFillColor2: 'rgba(38, 194, 129, 0.02)',
      bottomLineColor: '#ed5465',
      bottomFillColor1: 'rgba(237, 84, 101, 0.02)',
      bottomFillColor2: 'rgba(237, 84, 101, 0.28)',
      lineWidth: 2,
      priceLineVisible: false,
    });

    api().onJournalChanged(() => this.load());
    this.load();
  }

  async load() {
    const res = await api().paperJournal();
    if (!res || !res.ok) return;
    this.data = res.data;
    this.render();
  }

  setTab(id) {
    this.tab = id;
    this.renderTable();
  }

  async exportCsv() {
    await api().exportJournalCsv();
  }

  render() {
    const d = this.data;
    this.sinceEl.textContent = `自 ${when(d.createdAt)} 起 · 初始資金 ${num(d.capital)} USDT · 手續費 Maker ${(d.settings.makerFee * 100).toFixed(3)}% / Taker ${(d.settings.takerFee * 100).toFixed(3)}%`;
    this.renderKpis();
    this.renderCurve();
    this.renderOpen();
    const symbols = [...new Set(d.history.map((h) => h.symbol).concat(d.ledger.map((e) => e.symbol)).filter(Boolean))].sort();
    const keep = symbols.includes(this.symbol) ? this.symbol : '';
    this.filter.replaceChildren(el('option', { value: '', text: '全部幣種' }), ...symbols.map((s) => el('option', { value: s, text: s })));
    this.filter.value = keep;
    this.symbol = keep;
    this.renderTable();
  }

  renderKpis() {
    const s = this.data.stats;
    const tile = (label, value, cls = '', sub = '') =>
      el('div.jr-kpi', {}, el('span.jr-kpi__label', { text: label }), el(`span.jr-kpi__value${cls ? `.${cls}` : ''}`, { text: value }), sub ? el('span.jr-kpi__sub', { text: sub }) : null);
    const pf = s.profitFactor === Infinity ? '∞' : s.trades ? num(s.profitFactor) : '—';
    this.kpis.replaceChildren(
      tile('目前資金', `${num(s.wallet)}`, '', `淨值 ${num(s.equity)}（未實現 ${signed(s.upnl)}）`),
      tile('淨損益', signed(s.net), tone(s.net), `報酬率 ${signed(s.returnPct)}%`),
      tile('勝率', s.trades ? `${num(s.winRate, 1)}%` : '—', '', `${s.wins} 勝 ${s.losses} 敗 · 共 ${s.trades} 筆`),
      tile('盈虧比 (Profit Factor)', pf, s.profitFactor >= 1 ? 'is-up' : s.trades ? 'is-down' : '', '總獲利 ÷ 總虧損'),
      tile('平均獲利 / 虧損', s.trades ? `${signed(s.avgWin)} / ${signed(s.avgLoss)}` : '—', '', s.avgLoss ? `賺賠比 ${num(Math.abs(s.avgWin / s.avgLoss))}` : ''),
      tile('每筆期望值', s.trades ? signed(s.expectancy) : '—', tone(s.expectancy), `最好 ${signed(s.best)} · 最差 ${signed(s.worst)}`),
      tile('最大回撤', s.maxDrawdown ? `−${num(s.maxDrawdown)}` : '0.00', s.maxDrawdown ? 'is-down' : '', `${num(s.maxDrawdownPct)}%（從資金高點）`),
      tile('手續費', `−${num(s.fees)}`, s.fees ? 'is-down' : '', s.liquidationFees ? `另有強平清算費 −${num(s.liquidationFees)}` : `價差損益 ${signed(s.realized)}`),
      tile('資金費', signed(s.funding), tone(s.funding), '正數是收到、負數是支付'),
      tile('平均持倉', duration(s.avgHoldMs), '', `多 ${s.long.count} 筆 ${signed(s.long.net)} · 空 ${s.short.count} 筆 ${signed(s.short.net)}`)
    );
  }

  renderCurve() {
    const d = this.data;
    // Oldest first, one point per second (the last balance in it).
    const points = new Map();
    for (const e of d.ledger.slice().reverse()) points.set(Math.floor(e.time / 1000), e.balance);
    const data = [...points.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value }));
    this.curveEmpty.hidden = data.length > 1;
    this.series.applyOptions({ baseValue: { type: 'price', price: d.stats.deposits || d.capital } });
    this.series.setData(data);
    this.chart.timeScale().fitContent();
  }

  renderOpen() {
    const open = this.data.open || [];
    this.openBox.hidden = !open.length;
    if (!open.length) return;
    const head = ['幣種', '方向', '數量', '開倉均價', '標記價格', '未實現損益', '已付手續費', '資金費', '開倉時間'];
    const rows = open.map((p) =>
      el(
        'tr',
        {},
        el('td', { text: p.symbol }),
        el('td', {}, sideTag(p.amt > 0 ? 'LONG' : 'SHORT')),
        el('td', { text: String(Math.abs(p.amt)) }),
        el('td', { text: price(p.entry) }),
        el('td', { text: price(p.mark) }),
        el('td', { class: tone(p.upnl), text: signed(p.upnl) }),
        el('td', { text: p.trip ? `−${num(p.trip.fees)}` : '—' }),
        el('td', { class: p.trip ? tone(p.trip.funding) : '', text: p.trip ? signed(p.trip.funding) : '—' }),
        el('td', { text: p.trip ? when(p.trip.openedAt) : '—' })
      )
    );
    this.openBox.replaceChildren(
      el('h2.jr-section-title', { text: `持倉中（${open.length}）` }),
      el('div.jr-table-wrap', {}, table(head, rows))
    );
  }

  renderTable() {
    this.tabs.forEach((b, i) => b.classList.toggle('is-active', ['history', 'ledger'][i] === this.tab));
    const d = this.data;
    if (!d) return;
    const pick = (list) => (this.symbol ? list.filter((x) => x.symbol === this.symbol) : list);
    if (this.tab === 'history') {
      const list = pick(d.history);
      const head = ['平倉時間', '幣種', '方向', '數量', '槓桿', '開倉均價', '平倉均價', '價差損益', '手續費', '資金費', '淨損益', 'ROE', '持倉', '原因'];
      const rows = list.map((h) =>
        el(
          'tr',
          {},
          el('td', { text: when(h.closedAt), title: `開倉 ${when(h.openedAt)}` }),
          el('td', { text: h.symbol }),
          el('td', {}, sideTag(h.side)),
          el('td', { text: String(h.qty) }),
          el('td', { text: `${h.leverage}x` }),
          el('td', { text: price(h.entry) }),
          el('td', { text: price(h.exit) }),
          el('td', { class: tone(h.realized), text: signed(h.realized) }),
          el('td', { text: `−${num(h.fees)}` }),
          el('td', { class: tone(h.funding), text: h.funding ? signed(h.funding) : '0.00' }),
          el('td', { class: tone(h.net), text: signed(h.net) }),
          el('td', { class: tone(h.roe), text: `${signed(h.roe)}%` }),
          el('td', { text: duration(h.closedAt - h.openedAt) }),
          el('td.is-text', { text: REASONS[h.reason] || h.reason })
        )
      );
      this.tableWrap.replaceChildren(list.length ? table(head, rows) : el('div.jr-empty', { text: '還沒有平倉的紀錄。開一個模擬倉位、平倉後就會出現在這裡。' }));
      return;
    }
    const list = pick(d.ledger);
    const head = ['時間', '類型', '幣種', '金額', '餘額', '備註'];
    const rows = list.map((e) =>
      el(
        'tr',
        {},
        el('td', { text: when(e.time) }),
        el('td', { text: LEDGER_TYPES[e.type] || e.type }),
        el('td', { text: e.symbol || '—' }),
        el('td', { class: tone(e.amount), text: signed(e.amount, Math.abs(e.amount) < 1 ? 4 : 2) }),
        el('td', { text: num(e.balance) }),
        el('td.is-text', { text: REASONS[e.note] || e.note || '' })
      )
    );
    this.tableWrap.replaceChildren(list.length ? table(head, rows) : el('div.jr-empty', { text: '沒有資金變動' }));
  }
}

function sideTag(side) {
  return el(`span.jr-side.jr-side--${side === 'LONG' ? 'long' : 'short'}`, { text: side === 'LONG' ? '多' : '空' });
}

function table(head, rows) {
  return el('table.jr-table', {}, el('thead', {}, el('tr', {}, head.map((h) => el('th', { text: h })))), el('tbody', {}, rows));
}

new Journal(document.getElementById('root'));
