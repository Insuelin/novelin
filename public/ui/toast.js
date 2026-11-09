import { $ } from '../core/dom.js';
import { aiLog } from '../core/logger.js';

export function toast(message, type = 'info', duration = 2800) {
  if (type === 'error') aiLog('ERR', message, 'err');
  else if (type === 'warn') aiLog('WARN', message, 'warn');

  const container = $('#toasts');
  if (!container) return;
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.textContent = message;
  container.appendChild(element);
  requestAnimationFrame(() => element.classList.add('show'));
  setTimeout(() => {
    element.classList.remove('show');
    setTimeout(() => element.remove(), 240);
  }, duration);
}

export function setSaveState(label, tone = '') {
  const element = $('#save-state');
  if (!element) return;

  const text = String(label ?? '');
  const state = /FAIL|ERROR/i.test(text)
    ? 'error'
    : /SAVING/i.test(text)
      ? 'saving'
      : /UNSAVED/i.test(text)
        ? 'unsaved'
        : 'saved';

  element.dataset.state = state;
  element.className = `save-state ${tone}`.trim();
  element.title = text;
  element.setAttribute('aria-label', text);

  const labelElement = element.querySelector('.save-label');
  if (labelElement) labelElement.textContent = text;
  else element.textContent = text;
}
