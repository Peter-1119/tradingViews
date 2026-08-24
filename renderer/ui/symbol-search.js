/**
 * Symbol autocomplete backed by the provider's `searchSymbols()`
 * (Binance exchangeInfo, cached for 24h in the hub — spec 6).
 */

import { el, debounce, prettySymbol } from '../util.js';

export class SymbolSearch {
  /**
   * @param {{provider: object, current: string, onPick: (symbol: string) => void}} options
   */
  constructor({ provider, current, onPick }) {
    this.provider = provider;
    this.onPick = onPick;
    this.results = [];
    this.activeIndex = -1;
    this.requestSeq = 0;

    this.input = el('input.sc-search__input', {
      type: 'text',
      value: current || '',
      placeholder: '搜尋交易對,例如 BTCUSDT',
      spellcheck: 'false',
      autocomplete: 'off',
      oninput: () => this.runSearch(this.input.value),
      onfocus: () => this.runSearch(this.input.value),
      onkeydown: (e) => this.onKeyDown(e),
    });

    this.list = el('ul.sc-search__list', { role: 'listbox' });
    this.hint = el('div.sc-search__hint', { text: '' });

    this.root = el('div.sc-search', {}, this.input, this.hint, this.list);

    this.runSearch = debounce((q) => this.search(q), 180);
  }

  focus() {
    this.input.focus();
    this.input.select();
  }

  async search(query) {
    const seq = ++this.requestSeq;
    this.setHint('搜尋中…');
    try {
      const results = await this.provider.searchSymbols(query);
      if (seq !== this.requestSeq) return; // a newer keystroke won
      this.results = results;
      this.activeIndex = results.length ? 0 : -1;
      this.setHint(results.length ? '' : '找不到符合的交易對');
      this.renderList();
    } catch (err) {
      if (seq !== this.requestSeq) return;
      this.results = [];
      this.renderList();
      this.setHint(`交易對清單載入失敗:${err.message}`);
    }
  }

  setHint(text) {
    this.hint.textContent = text;
    this.hint.style.display = text ? 'block' : 'none';
  }

  renderList() {
    this.list.replaceChildren(
      ...this.results.map((item, index) =>
        el(
          'li.sc-search__item',
          {
            role: 'option',
            class: index === this.activeIndex ? 'is-active' : '',
            onmousedown: (e) => {
              // mousedown, not click: the input's blur must not close us first.
              e.preventDefault();
              this.pick(index);
            },
            onmouseenter: () => {
              this.activeIndex = index;
              this.syncActive();
            },
          },
          el('span.sc-search__symbol', { text: prettySymbol(item.symbol) }),
          el('span.sc-search__raw', { text: item.symbol })
        )
      )
    );
  }

  syncActive() {
    [...this.list.children].forEach((node, index) => {
      node.classList.toggle('is-active', index === this.activeIndex);
    });
    const active = this.list.children[this.activeIndex];
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  onKeyDown(event) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!this.results.length) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      this.activeIndex = (this.activeIndex + delta + this.results.length) % this.results.length;
      this.syncActive();
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      if (this.activeIndex >= 0) {
        this.pick(this.activeIndex);
      } else {
        // Let a fully-typed symbol through even with no list selection.
        const typed = this.input.value.trim().toUpperCase();
        if (typed) this.onPick(typed);
      }
      return;
    }

    if (event.key === 'Escape') {
      this.results = [];
      this.renderList();
    }
  }

  pick(index) {
    const item = this.results[index];
    if (!item) return;
    this.input.value = item.symbol;
    this.results = [];
    this.renderList();
    this.setHint('');
    this.onPick(item.symbol);
  }
}
