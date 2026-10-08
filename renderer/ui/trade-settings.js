/**
 * Settings → 交易: environment, API key, leverage, and the account's state.
 *
 * The secret is write-only from here. Once saved it is encrypted by the main
 * process and this section only ever shows the key's last four characters.
 * Going live takes a deliberate, separate confirmation; the default is the
 * Binance demo exchange, where nothing is real money.
 */

import { el } from '../util.js';

const api = () => window.stockcard.trading;

const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—');

const LINKS = {
  testnet: 'https://demo.binance.com/',
  live: 'https://www.binance.com/zh-TC/my/settings/api-management',
};

export class TradeSettings {
  constructor() {
    this.status = null;
    this.pendingLive = false;

    this.envBtns = new Map(
      ['testnet', 'live'].map((env) => [
        env,
        el('button.sc-seg__btn', {
          type: 'button',
          text: env === 'testnet' ? '測試網（模擬資金）' : '正式（真實資金）',
          onclick: () => this.chooseEnv(env),
        }),
      ])
    );

    this.liveConfirm = el('input', { type: 'checkbox' });
    this.liveConfirm.addEventListener('change', () => this.render());
    this.liveGo = el('button.sc-btn.ts-danger', { type: 'button', text: '切換到正式環境', onclick: () => this.goLive() });
    this.liveBox = el(
      'div.ts-warn',
      { hidden: true },
      el('div', { text: '正式環境會用你的真實資金下單。槓桿交易可能在短時間內虧損全部保證金。' }),
      el('label.ts-check', {}, this.liveConfirm, el('span', { text: '我了解，並自行承擔交易風險' })),
      el('div.ts-actions', {}, this.liveGo, el('button.sc-btn', { type: 'button', text: '取消', onclick: () => this.cancelLive() }))
    );

    this.dot = el('span.ts-dot');
    this.statusText = el('span');
    this.retryBtn = el('button.sc-btn', { type: 'button', text: '重新連線', onclick: () => this.run(() => api().test()) });
    this.statusRow = el('div.ts-status', {}, this.dot, this.statusText, this.retryBtn);

    this.keyInput = el('input.sc-search__input', { type: 'text', placeholder: 'API Key', autocomplete: 'off', spellcheck: 'false' });
    // Two ways to finish, matching the two kinds of key Binance issues.
    this.fileBtn = el('button.sc-btn', {
      type: 'button',
      text: '選擇私鑰檔案…',
      title: 'Self-generated（Ed25519 或 RSA）：選你產生的私鑰 .pem 檔',
      onclick: () => this.saveKeyFile(),
    });
    this.secretInput = el('input.sc-search__input', { type: 'password', placeholder: 'Secret Key（System generated 才需要）', autocomplete: 'off' });
    this.saveBtn = el('button.sc-btn', { type: 'button', text: '儲存並連線', onclick: () => this.saveKeys() });
    this.keyForm = el(
      'div.ts-form',
      {},
      this.keyInput,
      el('div.ts-help', { text: 'Self-generated：填 API Key，再選私鑰檔案' }),
      el('div.ts-actions', {}, this.fileBtn),
      el('div.ts-help', { text: 'System generated：填 API Key 和 Secret Key' }),
      this.secretInput,
      el('div.ts-actions', {}, this.saveBtn)
    );
    this.keyTail = el('span');
    this.keyType = el('span');
    this.keySaved = el(
      'div.ts-saved',
      { hidden: true },
      el('span', {}, '已設定 API Key ····', this.keyTail, this.keyType),
      el('button.sc-btn', { type: 'button', text: '移除', onclick: () => this.removeKeys() })
    );
    this.helpLink = el('a.ts-link', { href: '#', onclick: (e) => this.openHelp(e) });
    this.help = el(
      'div.ts-help',
      {},
      el('div', { text: '建立 API Key 時只勾「讀取」與「合約交易」，不要開啟提現，並建議綁定 IP。金鑰以 Windows 加密保存在本機，不會顯示或上傳。' }),
      this.helpLink
    );

    this.levRow = el('div.ts-help', {
      text: '每個幣種各自設定：在下單票標題的「全倉 Nx」調整，直接存在你的幣安帳戶（網頁、手機看到的都一樣）。保證金模式為全倉、單向持倉。',
    });

    this.oneWayBtn = el('button.sc-btn', { type: 'button', text: '切換為單向持倉', onclick: () => this.run(() => api().setOneWay()) });
    this.oneWayBox = el(
      'div.ts-warn',
      { hidden: true },
      el('div', { text: '帳戶目前是「雙向持倉」。這裡的下單介面使用單向持倉（需在沒有倉位與掛單時切換）。' }),
      el('div.ts-actions', {}, this.oneWayBtn)
    );

    this.error = el('div.ts-error', { hidden: true });

    const row = (label, ...children) =>
      el('div.sc-row', {}, el('div.sc-row__label', { text: label }), el('div.sc-row__control', {}, ...children));

    this.root = el(
      'div.ts',
      {},
      el('div.sc-divider', { text: '交易・幣安 U 本位永續' }),
      row('環境', el('div.sc-seg', {}, [...this.envBtns.values()]), this.liveBox),
      this.statusRow,
      row('API Key', this.keySaved, this.keyForm, this.help),
      row('槓桿', this.levRow),
      this.oneWayBox,
      this.error
    );

    // Typing a key must not trigger card shortcuts.
    this.root.addEventListener('keydown', (e) => e.stopPropagation());
    this.off = api().onStatus((s) => this.apply(s));
    this.load();
  }

  async load() {
    const res = await api().status();
    if (res.ok) this.apply(res.data);
  }

  apply(status) {
    this.status = status;
    this.render();
  }

  async run(fn) {
    this.error.hidden = true;
    const res = await fn();
    if (res && res.ok) this.apply(res.data);
    else if (res) {
      this.error.hidden = false;
      this.error.textContent = res.error;
    }
    return res;
  }

  render() {
    const s = this.status;
    if (!s) return;
    const env = this.pendingLive ? 'live' : s.env;
    for (const [id, btn] of this.envBtns) btn.classList.toggle('is-active', id === env);
    this.envBtns.get('live').classList.toggle('ts-live', env === 'live');
    this.liveBox.hidden = !this.pendingLive;
    this.liveGo.disabled = !this.liveConfirm.checked;

    const key = s.keys[s.env];
    this.keySaved.hidden = !key.configured;
    this.keyForm.hidden = key.configured;
    this.keyTail.textContent = key.keyTail;
    this.keyType.textContent = key.type ? `（${{ hmac: 'HMAC', ed25519: 'Ed25519', rsa: 'RSA' }[key.type] || key.type}）` : '';
    this.helpLink.textContent = s.env === 'testnet' ? '到幣安模擬交易（Demo Trading）建立測試用 API Key →' : '到幣安 API 管理建立 API Key →';
    this.help.hidden = key.configured;

    let text = '';
    let tone = 'off';
    if (!key.configured) text = '尚未設定 API Key';
    else if (s.env === 'live' && !s.liveConfirmed) text = '正式環境尚未確認';
    else if (s.connection === 'ready') {
      tone = 'ok';
      const a = s.account;
      text = `已連線${s.env === 'testnet' ? '（測試網）' : ''} · 可用 ${a ? fmt(a.availableBalance) : '—'} USDT`;
      if (s.stream !== 'live') text += ' · 即時推送連線中';
    } else if (s.connection === 'connecting') {
      tone = 'wait';
      text = '連線中…';
    } else if (s.connection === 'error') {
      tone = 'err';
      text = s.error || '連線失敗';
    } else text = '尚未連線（打開永續合約卡片時自動連線）';
    this.dot.className = `ts-dot is-${tone}`;
    this.statusText.textContent = text;
    this.retryBtn.hidden = !key.configured;


    this.oneWayBox.hidden = s.oneWay !== false;
  }

  chooseEnv(env) {
    if (!this.status) return;
    if (env === 'live' && !(this.status.env === 'live' && this.status.liveConfirmed)) {
      this.pendingLive = true;
      this.liveConfirm.checked = false;
      this.render();
      return;
    }
    this.pendingLive = false;
    if (env !== this.status.env) this.run(() => api().setEnv(env));
    else this.render();
  }

  async goLive() {
    if (!this.liveConfirm.checked) return;
    this.pendingLive = false;
    await this.run(() => api().setEnv('live', true));
  }

  cancelLive() {
    this.pendingLive = false;
    this.render();
  }

  /** Self-generated: the main process opens the file dialog and reads the key. */
  async saveKeyFile() {
    const env = this.status.env;
    this.fileBtn.disabled = true;
    this.fileBtn.textContent = '驗證中…';
    const res = await api().setKeyFile(env, this.keyInput.value);
    this.fileBtn.disabled = false;
    this.fileBtn.textContent = '選擇私鑰檔案…';
    // Closing the dialog is not an error, and not a status either.
    if (res && res.ok && res.data && res.data.canceled) return;
    await this.run(async () => res);
    if (res && res.ok) this.keyInput.value = '';
  }

  async saveKeys() {
    const env = this.status.env;
    this.saveBtn.disabled = true;
    this.saveBtn.textContent = '驗證中…';
    const res = await this.run(() => api().setKeys(env, this.keyInput.value, this.secretInput.value));
    this.saveBtn.disabled = false;
    this.saveBtn.textContent = '儲存並連線';
    if (res && res.ok) {
      // Never leave a secret sitting in a DOM input.
      this.keyInput.value = '';
      this.secretInput.value = '';
    }
  }

  removeKeys() {
    this.run(() => api().clearKeys(this.status.env));
  }


  openHelp(event) {
    event.preventDefault();
    window.stockcard.openExternal(LINKS[this.status ? this.status.env : 'testnet']);
  }

  destroy() {
    if (this.off) this.off();
  }
}
