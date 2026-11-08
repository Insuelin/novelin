import { state } from '../core/state.js';
import { $, $$ } from '../core/dom.js';
import { pad2 } from '../core/format.js';

const ACCENT_KEY = 'novelin.accent';
const ACCENTS = ['amber', 'orange', 'white', 'cyan'];

export function closeDropdowns(except = null) {
  $$('.dropdown.open').forEach((dropdown) => {
    if (dropdown === except) return;
    dropdown.classList.remove('open');
    const trigger = dropdown.querySelector('.dropdown-trigger');
    const menu = dropdown.querySelector('.dropdown-menu');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    if (menu) menu.hidden = true;
  });
}

export function initDropdown(root, { value, onChange } = {}) {
  if (!root) return null;

  const trigger = root.querySelector('.dropdown-trigger');
  const menu = root.querySelector('.dropdown-menu');
  const label = root.querySelector('.dropdown-label');
  const items = $$('.dropdown-item', root);

  const setValue = (next, { silent = false } = {}) => {
    const item = items.find((button) => button.dataset.value === next) || items[0];
    if (!item) return;
    items.forEach((button) => button.classList.toggle('on', button === item));
    if (label) label.textContent = item.textContent.trim();
    root.dataset.value = item.dataset.value;
    if (!silent && onChange) onChange(item.dataset.value);
  };

  const open = (nextOpen) => {
    if (nextOpen) closeDropdowns(root);
    root.classList.toggle('open', nextOpen);
    if (trigger) trigger.setAttribute('aria-expanded', String(nextOpen));
    if (menu) menu.hidden = !nextOpen;
  };

  trigger?.addEventListener('click', (event) => {
    event.stopPropagation();
    open(menu.hidden);
  });

  trigger?.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open(true);
      const selected = items.find((item) => item.classList.contains('on')) || items[0];
      selected?.focus();
    }
  });

  items.forEach((item) => {
    item.addEventListener('click', () => {
      setValue(item.dataset.value);
      open(false);
      trigger?.focus();
    });
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        open(false);
        trigger?.focus();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const index = items.indexOf(item);
        const offset = event.key === 'ArrowDown' ? 1 : -1;
        items[(index + offset + items.length) % items.length]?.focus();
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setValue(item.dataset.value);
        open(false);
        trigger?.focus();
      }
    });
  });

  root.addEventListener('click', (event) => event.stopPropagation());
  if (value) setValue(value, { silent: true });
  return { setValue, open };
}

export function applyAccent(name) {
  const valid = ACCENTS.includes(name) ? name : 'amber';
  state.accent = valid;
  document.documentElement.dataset.accent = valid;
  try {
    localStorage.setItem(ACCENT_KEY, valid);
  } catch {
    // 隐私模式里 localStorage 可能不可用。
  }
  $$('[data-accent-btn]').forEach((button) => {
    button.classList.toggle('active', button.dataset.accentBtn === valid);
  });
}

export function loadAccent() {
  let saved = 'amber';
  try {
    saved = localStorage.getItem(ACCENT_KEY) || 'amber';
  } catch {
    // 用默认色。
  }
  applyAccent(saved);
}

export function confirmDialog({ title, text, okLabel = '确认' }) {
  return new Promise((resolve) => {
    state.confirmResolve = resolve;
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    $('#confirm-ok').textContent = okLabel;
    const dialog = $('#confirm-dialog');
    if (!dialog.open) dialog.showModal();
  });
}

export function settleConfirm(value) {
  const resolve = state.confirmResolve;
  state.confirmResolve = null;
  const dialog = $('#confirm-dialog');
  if (dialog.open) dialog.close();
  if (resolve) resolve(value);
}

export function tickClock() {
  const now = new Date();
  $('#clock').textContent = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  $('#date').textContent = `${now.getFullYear()}.${pad2(now.getMonth() + 1)}.${pad2(now.getDate())}`;
}
