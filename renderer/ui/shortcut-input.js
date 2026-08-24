/**
 * Accelerator capture control for the global shortcuts (spec 4.4).
 *
 * Click it, press a combination, and it hands the Electron-format accelerator
 * (e.g. "Ctrl+Alt+S") to `onChange`. Registration can legitimately fail when
 * another application already owns the combination, so `onChange` reports back
 * and the control shows why rather than silently pretending it worked.
 */

import { el } from '../util.js';

/** event.key -> the token Electron expects in an accelerator. */
const KEY_ALIASES = {
  ' ': 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Esc',
  '+': 'Plus',
};

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta']);

function toAccelerator(event) {
  if (MODIFIER_KEYS.has(event.key)) return null;

  const parts = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Super');

  // A modifier-less global shortcut would swallow that key everywhere.
  if (!parts.length) return null;

  let key = KEY_ALIASES[event.key] || event.key;
  if (key.length === 1) key = key.toUpperCase();
  parts.push(key);
  return parts.join('+');
}

export class ShortcutInput {
  /**
   * @param {{value: string, onChange: (accel: string) => Promise<{ok: boolean, reason?: string}>}} options
   */
  constructor({ value, onChange }) {
    this.value = value;
    this.onChange = onChange;
    this.recording = false;

    this.button = el('button.sc-accel', {
      type: 'button',
      text: value || '未設定',
      title: '點一下,然後按下想要的組合鍵',
      onclick: () => this.startRecording(),
      onblur: () => this.stopRecording(),
      onkeydown: (event) => this.handleKey(event),
    });

    this.error = el('div.sc-accel__error', { text: '' });
    this.root = el('div.sc-accel__wrap', {}, this.button, this.error);
  }

  startRecording() {
    this.recording = true;
    this.button.classList.add('is-recording');
    this.button.textContent = '按下組合鍵…';
    this.setError('');
  }

  stopRecording() {
    this.recording = false;
    this.button.classList.remove('is-recording');
    this.button.textContent = this.value || '未設定';
  }

  async handleKey(event) {
    if (!this.recording) return;
    event.preventDefault();
    event.stopPropagation();

    if (event.key === 'Escape') {
      this.stopRecording();
      return;
    }

    const accelerator = toAccelerator(event);
    if (!accelerator) {
      if (!MODIFIER_KEYS.has(event.key)) this.setError('請至少搭配一個 Ctrl / Alt / Shift');
      return;
    }

    const previous = this.value;
    this.value = accelerator;
    this.stopRecording();

    const result = await this.onChange(accelerator);
    if (result && result.ok === false) {
      this.value = previous;
      this.button.textContent = previous || '未設定';
      this.setError(
        result.reason === 'taken' ? '這組快捷鍵已被其他程式佔用' : `註冊失敗:${result.reason}`
      );
    }
  }

  setValue(value) {
    this.value = value;
    if (!this.recording) this.button.textContent = value || '未設定';
  }

  setError(message) {
    this.error.textContent = message;
    this.error.style.display = message ? 'block' : 'none';
  }
}
