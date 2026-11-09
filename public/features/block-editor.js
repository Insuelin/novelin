import { state } from '../core/state.js';
import { $ } from '../core/dom.js';
import { marked } from '../core/markdown.js';
import { toast } from '../ui/toast.js';
import { appendBlock, replaceBlock } from '../core/block-source.js';
import { applyManuscriptText, saveAll } from './persistence.js';
import { hideSelection, renderProse } from './manuscript.js';
import { updateAiControls } from './ai-controls.js';
import { updateReviewBar } from './review-view.js';
import {
  createLiveBlock,
  focusLiveOffset,
  readLiveBlockSource,
  revealLiveMarkers,
  syncLiveMarkup,
} from './live-block.js';

function sameTarget(edit, { block = null, append = false } = {}) {
  if (!edit) return false;
  if (append) return edit.mode === 'append';
  return edit.mode === 'edit' && block && edit.block
    && edit.block.start === block.start
    && edit.block.end === block.end;
}

function restoreScroll(value, bottom = false) {
  requestAnimationFrame(() => {
    const manuscript = $('.manuscript');
    if (!manuscript) return;
    manuscript.scrollTop = bottom ? manuscript.scrollHeight : value;
  });
}

function syncDraft(edit) {
  edit.draft = readLiveBlockSource(edit.editor);
  edit.dirty = edit.draft !== edit.original;
  syncLiveMarkup(edit.editor);
}

function insertPlainText(edit, text) {
  const editor = edit.editor;
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount || !editor.contains(selection.anchorNode)) return;

  const value = String(text ?? '').replace(/\r\n?/g, '\n');
  const range = selection.getRangeAt(0);
  range.deleteContents();

  if (value) {
    const node = document.createTextNode(value);
    range.insertNode(node);
    range.setStartAfter(node);
  }
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  syncDraft(edit);
}

function teardown(edit) {
  if (!edit) return;
  edit.container?.remove();
  if (edit.tail) edit.tail.hidden = false;
  if (state.blockEdit === edit) state.blockEdit = null;
  updateAiControls();
  updateReviewBar();
}

export function cancelBlockEdit({ silent = false } = {}) {
  const edit = state.blockEdit;
  if (!edit) return false;
  const scroll = edit.scroll;
  const dirty = edit.dirty;
  teardown(edit);
  renderProse();
  restoreScroll(scroll);
  if (!silent && dirty) toast('已取消这一段修改', 'info');
  return true;
}

export async function applyBlockEdit() {
  const edit = state.blockEdit;
  if (!edit || edit.composing) return;
  syncDraft(edit);

  const book = state.current;
  if (!book) return;
  const source = String(book.manuscript || '');
  let next;

  if (edit.mode === 'edit') {
    if (source.slice(edit.block.start, edit.block.end) !== edit.block.original) {
      toast('正文已经变了，重新打开这一段再改', 'error');
      cancelBlockEdit({ silent: true });
      return;
    }
    next = replaceBlock(source, edit.block, edit.draft);
  } else {
    if (!edit.draft.trim()) {
      cancelBlockEdit({ silent: true });
      return;
    }
    next = appendBlock(source, edit.draft);
  }

  if (next === source) {
    cancelBlockEdit({ silent: true });
    return;
  }

  const append = edit.mode === 'append';
  const scroll = edit.scroll;
  teardown(edit);
  applyManuscriptText(next);
  renderProse();
  restoreScroll(scroll, append);
  saveAll().catch(() => {});
}

function createAppendEditor() {
  const editor = document.createElement('p');
  editor.className = 'live-block live-paragraph live-append';
  editor.dataset.placeholder = '输入新段落，或者直接写 ## 新章。';
  editor.setAttribute('contenteditable', 'true');
  editor.setAttribute('spellcheck', 'false');
  editor.setAttribute('role', 'textbox');
  editor.setAttribute('aria-multiline', 'true');
  return editor;
}

export function openBlockEditor({ block = null, element = null, append = false, caret = null } = {}) {
  const book = state.current;
  if (!book) return false;
  if (state.aiReview || state.aiRunning || state.aiProposal?.status === 'pending') {
    toast('先处理 AI 提案，再手动编辑', 'error');
    return false;
  }

  const current = state.blockEdit;
  if (current) {
    if (sameTarget(current, { block, append })) {
      current.editor.focus();
      return true;
    }
    toast('先 Ctrl+S 保存或 Esc 取消当前段落', 'error');
    return false;
  }

  if (!append && (!block || !element || !block.editable)) return false;

  hideSelection();
  const tail = $('#prose-tail');
  if (append && !tail) return false;

  const scroll = $('.manuscript')?.scrollTop || 0;
  const original = append ? '' : block.content;
  let editor;

  if (append) {
    editor = createAppendEditor();
    tail.parentNode.insertBefore(editor, tail);
    tail.hidden = true;
  } else {
    try {
      editor = createLiveBlock(block, marked);
    } catch {
      editor = null;
    }
    if (!editor) {
      toast('这一段结构暂时用“源码 / SOURCE”改', 'error');
      return false;
    }
    if (element.classList.contains('lead')) editor.classList.add('lead');
    element.replaceWith(editor);
  }

  const edit = {
    mode: append ? 'append' : 'edit',
    block,
    element,
    original,
    draft: original,
    dirty: false,
    composing: false,
    container: editor,
    editor,
    tail: append ? tail : null,
    scroll,
  };

  state.blockEdit = edit;
  updateAiControls();
  updateReviewBar();

  editor.addEventListener('input', () => {
    if (state.blockEdit !== edit) return;
    syncDraft(edit);
  });

  editor.addEventListener('compositionstart', () => {
    edit.composing = true;
  });
  editor.addEventListener('compositionend', () => {
    edit.composing = false;
    syncDraft(edit);
  });

  editor.addEventListener('paste', (event) => {
    const text = event.clipboardData?.getData('text/plain');
    if (text == null) return;
    event.preventDefault();
    insertPlainText(edit, text);
  });

  editor.addEventListener('keydown', (event) => {
    if (event.isComposing) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelBlockEdit();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && (event.key === 'Enter' || event.key.toLowerCase() === 's')) {
      event.preventDefault();
      event.stopPropagation();
      applyBlockEdit();
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      insertPlainText(edit, '\n');
    }
  });

  const offset = Number.isFinite(caret) ? caret : null;
  focusLiveOffset(editor, offset);
  editor.scrollIntoView({ block: 'nearest' });
  revealLiveMarkers(editor);

  return true;
}

function caretOffsetIn(element) {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer)) return null;

  const prefix = document.createRange();
  prefix.selectNodeContents(element);
  try {
    prefix.setEnd(range.startContainer, range.startOffset);
  } catch {
    return null;
  }
  return prefix.toString().length;
}

let prosePress = null;

function movedFromPress(event) {
  if (!prosePress) return false;
  const moved = Math.hypot(event.clientX - prosePress.x, event.clientY - prosePress.y) > 4;
  prosePress = null;
  return moved;
}

function handleProseClick(event) {
  if (movedFromPress(event)) return;
  if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
  if (state.aiReview || state.aiRunning || state.aiProposal?.status === 'pending') return;
  if (event.target.closest('.live-block[contenteditable="true"], a, img')) return;

  const selection = window.getSelection();
  if (selection && !selection.isCollapsed) return;

  const appendTarget = event.target.closest('[data-block-append]');
  if (appendTarget) {
    event.preventDefault();
    selection?.removeAllRanges();
    openBlockEditor({ append: true });
    return;
  }

  const element = event.target.closest('[data-block-start]');
  if (!element || element.dataset.blockEditable === 'false') return;

  const index = Number(element.dataset.blockIndex);
  const block = state.proseBlocks[index];
  if (!block || !block.editable) return;

  event.preventDefault();
  const caret = caretOffsetIn(element);
  selection?.removeAllRanges();
  openBlockEditor({ block, element, caret });
}

export function wireBlockEditorEvents() {
  $('#prose')?.addEventListener('mousedown', (event) => {
    prosePress = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
  });
  $('#prose')?.addEventListener('click', handleProseClick);
  $('#prose-tail')?.addEventListener('click', (event) => {
    if (state.aiReview || state.aiRunning || state.aiProposal?.status === 'pending') return;
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    openBlockEditor({ append: true });
  });

  document.addEventListener('selectionchange', () => {
    const edit = state.blockEdit;
    if (edit?.editor) revealLiveMarkers(edit.editor);
  });
}
