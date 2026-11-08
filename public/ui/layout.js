import { state } from '../core/state.js';
import { $, $$ } from '../core/dom.js';

export function syncEditorHeight() {
  const editor = $('#manuscript-editor');
  const manuscript = $('.manuscript');
  if (!editor || !manuscript || state.manuscriptMode !== 'edit') return;
  const stickyHeight = $('.ms-sticky')?.getBoundingClientRect().height || 0;
  const height = Math.max(260, Math.round(manuscript.clientHeight - stickyHeight - 1));
  editor.style.height = `${height}px`;
  editor.style.minHeight = `${height}px`;
}

export function syncStickyHeight() {
  const sticky = $('.ms-sticky');
  const chrome = $('.ms-chrome');
  if (!sticky || !chrome) return;
  const height = Math.max(0, Math.round(sticky.getBoundingClientRect().height));
  chrome.style.setProperty('--ms-sticky-h', `${height}px`);
  if (state.manuscriptMode === 'edit') syncEditorHeight();
}

export function isNearBottom(element, distance = 180) {
  if (!element) return false;
  return element.scrollHeight - element.scrollTop - element.clientHeight < distance;
}

export function scrollManuscriptToEnd() {
  const manuscript = $('.manuscript');
  if (manuscript) manuscript.scrollTop = manuscript.scrollHeight;
}

export function scrollToPendingChapter() {
  const manuscript = $('.manuscript');
  const section = $('#ai-pending-chapter');
  if (!manuscript || !section) return;
  const sticky = $('.ms-sticky')?.getBoundingClientRect().height || 0;
  const top = manuscript.scrollTop
    + section.getBoundingClientRect().top
    - manuscript.getBoundingClientRect().top
    - sticky
    - 10;
  manuscript.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

export function scrollToReviewChange(last = false) {
  const manuscript = $('.manuscript');
  if (!manuscript) return;
  const marks = $$('#prose .ai-del, #prose .ai-ins, #prose .ai-change-block');
  if (!marks.length) return;
  const target = last ? marks[marks.length - 1] : marks[0];
  const sticky = $('.ms-sticky')?.getBoundingClientRect().height || 0;
  const top = manuscript.scrollTop
    + target.getBoundingClientRect().top
    - manuscript.getBoundingClientRect().top
    - sticky
    - 16;
  manuscript.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}
