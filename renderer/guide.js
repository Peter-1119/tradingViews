/**
 * Shortcuts & tips: every gesture and key the cards answer to, on one page.
 *
 * Read at a glance, not studied: each row is the input -- key caps, or a
 * mouse chip for click / double-click / drag / wheel / right-click -- and a
 * few words on what it does, with where to do it in fainter text. Grouped by
 * what one is doing (reading the chart, drawing, switching symbols, trading,
 * the windows), and filtered as you type.
 *
 * The two global shortcuts are user-set, so they are read from the prefs
 * rather than written in.
 */

import { el } from './util.js';
import { t } from './i18n.js';

document.title = t('快捷鍵與提示');

/* --------------------------------------------------------------- inputs */

const MOUSE_ICONS = {
  click: '<rect x="4" y="1.5" width="8" height="13" rx="4"/><path d="M8 1.5v5" /><path d="M4.4 6.5H8V2" class="fill"/>',
  dbl: '<rect x="4" y="1.5" width="8" height="13" rx="4"/><path d="M8 1.5v5"/><path d="M4.4 6.5H8V2" class="fill"/><path d="M14 2.5v3M15.5 4h-3"/>',
  right: '<rect x="4" y="1.5" width="8" height="13" rx="4"/><path d="M8 1.5v5"/><path d="M11.6 6.5H8V2" class="fill"/>',
  wheel: '<rect x="4" y="1.5" width="8" height="13" rx="4"/><path d="M8 3.5v3" stroke-width="2"/>',
  drag: '<path d="M8 1.5v13M1.5 8h13M8 1.5l-2 2M8 1.5l2 2M8 14.5l-2-2M8 14.5l2-2M1.5 8l2-2M1.5 8l2 2M14.5 8l-2-2M14.5 8l-2 2"/>',
};

const MOUSE_WORDS = {
  click: t('點擊'),
  dbl: t('雙擊'),
  right: t('右鍵'),
  wheel: t('滾輪'),
  drag: t('拖曳'),
};

/** One input token: a key cap, or a mouse chip ('@drag'). */
function token(spec) {
  if (spec.startsWith('@')) {
    const kind = spec.slice(1);
    return el(
      'span.gd-mouse',
      { class: `gd-mouse--${kind}` },
      el('span.gd-mouse__icon', {
        html: `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${MOUSE_ICONS[kind]}</svg>`,
      }),
      MOUSE_WORDS[kind]
    );
  }
  if (spec === '…') return el('span.gd-sep', { text: '…' });
  if (spec === '/') return el('span.gd-sep', { text: '/' });
  return el('kbd.gd-key', { text: spec });
}

/** 'Ctrl+Alt+S' -> ['Ctrl', '+', 'Alt', '+', 'S'] as nodes; tokens in an array stay apart. */
function combo(keys) {
  const out = [];
  keys.forEach((k, i) => {
    if (i && k !== '…' && k !== '/' && keys[i - 1] !== '…' && keys[i - 1] !== '/') out.push(el('span.gd-plus', { text: '+' }));
    out.push(token(k));
  });
  return out;
}

/** Electron accelerator -> key cap names. */
function accelKeys(accel) {
  return String(accel || '')
    .split('+')
    .filter(Boolean)
    .map((k) => (/^(CommandOrControl|CmdOrCtrl|Control)$/i.test(k) ? 'Ctrl' : k));
}

/* -------------------------------------------------------------- content */

function sections(prefs) {
  const showKeys = accelKeys(prefs.shortcuts && prefs.shortcuts.toggleShow);
  const passKeys = accelKeys(prefs.shortcuts && prefs.shortcuts.toggleClickThrough);
  return [
    {
      id: 'chart',
      title: t('看圖'),
      rows: [
        { keys: ['@wheel'], what: t('縮放時間'), where: t('圖表上，或拖曳時間軸') },
        { keys: ['@wheel', '/', '@drag'], what: t('縮放價格'), where: t('右側價格軸') },
        { keys: ['@dbl'], what: t('價格恢復自動縮放'), where: t('右側價格軸') },
        { keys: ['Alt', 'R'], what: t('重置視圖，回到最新 K 棒') },
        { keys: ['Ctrl'], what: t('十字線吸附最近的開高低收'), where: t('按住') },
        { keys: ['Shift', '@drag'], what: t('量測價差、漲跌幅與時間') },
        { keys: ['Esc'], what: t('清除量測，回到游標') },
      ],
    },
    {
      id: 'draw',
      title: t('畫線'),
      rows: [
        { keys: ['@dbl'], what: t('新增水平線'), where: t('圖表空白處；加 Ctrl 吸附') },
        { keys: ['@drag'], what: t('移動線條'), where: t('拖線本身') },
        { keys: ['@dbl'], what: t('刪除線條'), where: t('在線上') },
        { keys: ['@right'], what: t('換顏色'), where: t('水平線、趨勢線、矩形') },
        { keys: ['Shift'], what: t('趨勢線鎖成水平或垂直'), where: t('畫趨勢線時按住') },
        { keys: ['Ctrl', 'Z'], what: t('復原') },
        { keys: ['Alt', 'H'], what: t('隱藏／顯示所有繪圖') },
      ],
    },
    {
      id: 'symbols',
      title: t('商品與提醒'),
      rows: [
        { keys: ['Alt', '1', '…', '0'], what: t('切換到常用幣種第 1～10 個') },
        { keys: ['@click'], what: t('開啟常用清單'), where: t('標題列的幣種名稱') },
        { keys: ['@drag'], what: t('調整常用清單順序'), where: t('按住清單裡的一列上下拖') },
        { keys: ['@click'], what: t('現貨 ⇄ 永續'), where: t('幣種名稱旁的市場標籤') },
        { keys: ['Alt', 'A'], what: t('在游標價格設價格提醒') },
        { keys: ['Alt', 'A'], what: t('在成交量上設提醒'), where: t('鈴鐺或 Alt+A，點在成交量柱上') },
        { keys: ['@drag'], what: t('改提醒價格'), where: t('金色提醒標籤') },
        { keys: ['@click'], what: t('停止位置提醒的閃爍'), where: t('點一下卡片') },
      ],
    },
    {
      id: 'trade',
      title: t('交易（永續）'),
      rows: [
        { keys: ['@click'], what: t('開下單面板'), where: t('價格軸左側跟著滑鼠的 ＋') },
        { keys: ['@click'], what: t('鎖定價格，方便點 ＋'), where: t('圖表上單擊') },
        { keys: ['Enter'], what: t('確認送出'), where: t('按下做多／做空後 3 秒內') },
        { keys: ['@drag'], what: t('改委託或止盈止損價'), where: t('拖曳圖上的標籤') },
        { keys: ['@click'], what: t('限價單拆成幾筆'), where: t('下單面板的「拆單」，之後在圖上拖開') },
        { keys: ['@click'], what: t('取消委託'), where: t('標籤上的 ✕') },
        { keys: ['@dbl'], what: t('平倉／市價反手'), where: t('倉位列的按鈕連按兩次') },
        { keys: ['Esc'], what: t('拖曳中取消，不送出') },
      ],
    },
    {
      id: 'window',
      title: t('視窗'),
      rows: [
        { keys: showKeys.length ? showKeys : ['Ctrl', 'Alt', 'S'], what: t('顯示／隱藏全部卡片'), where: t('全域，可在設定更改') },
        { keys: passKeys.length ? passKeys : ['Ctrl', 'Alt', 'C'], what: t('滑鼠穿透開關'), where: t('全域，可在設定更改') },
        { keys: ['@right'], what: t('開啟設定'), where: t('卡片任意處') },
        { keys: ['@drag'], what: t('移動卡片'), where: t('卡片頂端') },
        { keys: ['@drag'], what: t('調整大小'), where: t('右下角斜紋') },
        { keys: ['Alt', 'M'], what: t('縮成迷你 K 線（最新 5 根）'), where: t('再按一次還原；浮動模式') },
        { keys: ['Alt', 'T'], what: t('縮成只顯示價格'), where: t('再按一次還原；浮動模式') },
        { keys: ['F1'], what: t('開啟這份說明') },
      ],
    },
  ];
}

const TIPS = [
  t('滑鼠移到卡片上，左側會出現工具列；同一個工具再點一次就放下。'),
  t('繪圖依幣種儲存：現貨、永續與各個週期都看得到同一條線。'),
  t('價格提醒在卡片隱藏或關閉時也會通知。'),
  t('交易預設連到幣安測試網；設定 → 交易可改用不需要 API Key 的本機模擬。'),
];

/* --------------------------------------------------------------- render */

function render(prefs) {
  const search = el('input.gd-search', { type: 'search', placeholder: t('搜尋操作…'), spellcheck: 'false' });
  const grid = el('div.gd-grid');
  const empty = el('div.gd-empty', { hidden: true, text: t('沒有符合的操作') });
  const rowsByText = [];

  for (const section of sections(prefs)) {
    const list = el('div.gd-rows');
    for (const row of section.rows) {
      const node = el(
        'div.gd-row',
        {},
        el('div.gd-keys', {}, combo(row.keys)),
        el('div.gd-what', {}, el('span', { text: row.what }), row.where ? el('span.gd-where', { text: row.where }) : null)
      );
      list.append(node);
      rowsByText.push({ node, section: null, text: `${row.what} ${row.where || ''} ${row.keys.join(' ')}`.toLowerCase() });
    }
    const panel = el('section.gd-panel', { dataset: { section: section.id } }, el('h2.gd-panel__title', { text: section.title }), list);
    for (const r of rowsByText) if (!r.section) r.section = panel;
    grid.append(panel);
  }

  const tips = el(
    'section.gd-panel.gd-panel--tips',
    { dataset: { section: 'tips' } },
    el('h2.gd-panel__title', { text: t('小提示') }),
    el('ul.gd-tips', {}, TIPS.map((tip) => el('li', { text: tip })))
  );
  grid.append(tips);

  const filter = () => {
    const q = search.value.trim().toLowerCase();
    const shown = new Set();
    for (const r of rowsByText) {
      const hit = !q || r.text.includes(q);
      r.node.hidden = !hit;
      if (hit) shown.add(r.section);
    }
    for (const panel of grid.querySelectorAll('.gd-panel')) {
      panel.hidden = panel === tips ? !!q : !shown.has(panel);
    }
    empty.hidden = !q || shown.size > 0;
  };
  search.addEventListener('input', filter);

  // Typing anywhere searches; Esc clears, then closes.
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (search.value) {
        search.value = '';
        filter();
      } else window.close();
      return;
    }
    if ((event.ctrlKey && event.code === 'KeyF') || (event.key.length === 1 && !event.ctrlKey && !event.altKey && document.activeElement !== search)) {
      if (event.ctrlKey) event.preventDefault();
      search.focus();
    }
  });

  document.getElementById('root').append(
    el(
      'div.gd',
      {},
      el(
        'header.gd-head',
        {},
        el('div.gd-title', {}, el('h1', { text: t('快捷鍵與提示') }), el('span.gd-sub', { text: t('在任一張卡片上按 F1 都能打開這裡') })),
        search
      ),
      grid,
      empty
    )
  );
}

window.stockcard
  .getPrefs()
  .catch(() => ({}))
  .then((prefs) => render(prefs || {}));
