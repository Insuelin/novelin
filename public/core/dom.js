export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function setText(element, text) {
  const value = String(text ?? '');
  if (element && element.textContent !== value) element.textContent = value;
}

export function setDisabled(element, value) {
  if (element && element.disabled !== value) element.disabled = value;
}

export function setHidden(element, value) {
  if (element && element.hidden !== value) element.hidden = value;
}
