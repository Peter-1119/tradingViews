'use strict';

/**
 * System tray (spec 4.4). The tray is the only persistent affordance: cards use
 * `skipTaskbar`, so if every card is hidden this menu is the way back in.
 */

const path = require('path');
const { Tray, Menu, nativeImage, app } = require('electron');
const store = require('./store');
const windows = require('./windows');

let tray = null;

function iconPath() {
  return path.join(__dirname, '..', 'build', 'tray.png');
}

function setLaunchAtStartup(enabled) {
  store.set('launchAtStartup', !!enabled);
  // Only meaningful for a packaged build; in dev this would point at electron.exe.
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: !!enabled, args: [] });
  }
  return !!enabled;
}

function buildMenu() {
  const mode = windows.getMode();
  const hidden = windows.isHidden();
  const prefs = store.getGlobalPrefs();
  const cards = store.getCards();

  return Menu.buildFromTemplate([
    {
      label: 'StockCard',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: '新增卡片',
      click: () => {
        windows.addCard();
        refresh();
      },
    },
    {
      label: '卡片',
      enabled: cards.length > 0,
      submenu: cards.map((card) => ({
        label: `${card.symbol}${card.market === 'perp' ? ' 永續' : ''}  ·  ${card.interval}`,
        submenu: [
          {
            label: '移除這張卡片',
            click: () => {
              windows.removeCard(card.id);
              refresh();
            },
          },
        ],
      })),
    },
    { type: 'separator' },
    {
      label: '顯示模式',
      submenu: [
        {
          label: 'Float(每張圖獨立視窗)',
          type: 'radio',
          checked: mode === 'float',
          click: () => {
            windows.applyMode('float');
            refresh();
          },
        },
        {
          label: 'Board(單一視窗多卡)',
          type: 'radio',
          checked: mode === 'board',
          click: () => {
            windows.applyMode('board');
            refresh();
          },
        },
      ],
    },
    {
      label: hidden ? '顯示全部卡片' : '隱藏全部卡片',
      accelerator: prefs.shortcuts.toggleShow,
      click: () => {
        windows.toggleShowAll('tray menu');
        refresh();
      },
    },
    {
      label: '全部置頂',
      type: 'checkbox',
      checked:
        mode === 'board'
          ? store.getBoard().alwaysOnTop
          : cards.length > 0 && cards.every((c) => c.alwaysOnTop),
      click: (item) => {
        windows.setAlwaysOnTopAll(item.checked);
        refresh();
      },
    },
    {
      label: '滑鼠穿透',
      type: 'checkbox',
      checked: windows.isClickThrough(),
      accelerator: prefs.shortcuts.toggleClickThrough,
      click: (item) => {
        windows.setClickThrough(item.checked);
        refresh();
      },
    },
    { type: 'separator' },
    {
      label: '漲跌顏色',
      submenu: [
        {
          label: '綠漲紅跌',
          type: 'radio',
          checked: prefs.upDownColor === 'greenUp',
          click: () => {
            store.set('upDownColor', 'greenUp');
            windows.broadcast('app:prefs', store.getGlobalPrefs());
            refresh();
          },
        },
        {
          label: '紅漲綠跌',
          type: 'radio',
          checked: prefs.upDownColor === 'redUp',
          click: () => {
            store.set('upDownColor', 'redUp');
            windows.broadcast('app:prefs', store.getGlobalPrefs());
            refresh();
          },
        },
      ],
    },
    {
      label: '開機自動啟動',
      type: 'checkbox',
      checked: prefs.launchAtStartup,
      click: (item) => {
        setLaunchAtStartup(item.checked);
        refresh();
      },
    },
    { type: 'separator' },
    {
      label: '結束程式',
      click: () => {
        app.quit();
      },
    },
  ]);
}

function refresh() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(buildMenu());
  const hiddenNote = windows.isHidden() ? ' · 已隱藏(點圖示顯示)' : '';
  tray.setToolTip(`StockCard — ${store.getCards().length} 張卡片 · ${windows.getMode()} 模式${hiddenNote}`);
}

function create() {
  if (tray && !tray.isDestroyed()) return tray;

  const image = nativeImage.createFromPath(iconPath());
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);

  // Left click toggles visibility; the menu stays on right click.
  tray.on('click', () => {
    windows.toggleShowAll('tray icon click');
    refresh();
  });

  refresh();
  return tray;
}

function destroy() {
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
}

module.exports = { create, refresh, destroy, setLaunchAtStartup };
