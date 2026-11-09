import { state } from '../core/state.js';
import { $ } from '../core/dom.js';
import { toast } from '../ui/toast.js';
import { applyManuscriptText, flushSave, saveAll } from './persistence.js';
import { hideSelection, renderProse } from './manuscript.js';

let sourceScroll = 0;
let wired = false;

function withDocumentEol(text) {
  const source = String(state.current?.manuscript || '');
  if (!source.includes('\r\n')) return text;
  return String(text ?? '').replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n');
}

function canOpen() {
  if (!state.current || state.view !== 'workspace') {
    toast('先打开一本书', 'error');
    return false;
  }
  if (state.aiRunning || state.aiReview || state.aiProposal?.status === 'pending') {
    toast('先处理 AI 提案，再手动编辑', 'error');
    return false;
  }
  if (state.blockEdit) {
    toast('先 APPLY 或取消当前段落', 'error');
    return false;
  }
  return true;
}

export function openSourceDialog() {
  if (!canOpen()) return false;
  const dialog = $('#source-dialog');
  const editor = $('#manuscript-editor');
  if (!dialog || !editor) return false;

  hideSelection();
  sourceScroll = $('.manuscript')?.scrollTop || 0;
  editor.value = state.current.manuscript || '';
  const label = $('#ms-mode-label');
  if (label) label.textContent = 'SOURCE';

  if (!dialog.open) dialog.showModal();
  const chapterStart = state.chapters[state.currentChapter]?.start || 0;
  const position = Math.max(0, Math.min(editor.value.length, chapterStart));
  requestAnimationFrame(() => {
    editor.focus();
    editor.setSelectionRange(position, position);
    const ratio = editor.scrollHeight ? position / Math.max(1, editor.value.length) : 0;
    editor.scrollTop = ratio * editor.scrollHeight;
  });
  return true;
}

export function closeSourceDialog() {
  const dialog = $('#source-dialog');
  if (dialog?.open) dialog.close();
}

export function wireSourceDialog() {
  if (wired) return;
  wired = true;

  $('#source-btn')?.addEventListener('click', openSourceDialog);

  const editor = $('#manuscript-editor');
  editor?.addEventListener('input', () => {
    if (!state.current) return;
    applyManuscriptText(withDocumentEol(editor.value));
  });

  $('#source-save')?.addEventListener('click', () => {
    saveAll({ notify: true }).catch(() => {});
  });

  const dialog = $('#source-dialog');
  dialog?.addEventListener('close', () => {
    if (!state.current) return;
    const label = $('#ms-mode-label');
    if (label) label.textContent = 'READ';
    flushSave().catch(() => {});
    renderProse();
    requestAnimationFrame(() => {
      const manuscript = $('.manuscript');
      if (manuscript) manuscript.scrollTop = sourceScroll;
    });
  });
}
