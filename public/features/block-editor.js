import { state } from '../core/state.js';
import { $, escapeHtml } from '../core/dom.js';
import { toast } from '../ui/toast.js';
import { appendBlock, replaceBlock } from '../core/block-source.js';
import { diffSegments } from '../core/text-diff.js';
import { applyManuscriptText, saveAll } from './persistence.js';
import { hideSelection, renderProse } from './manuscript.js';
import { scheduleRulerRender } from './diff-ruler.js';
import { updateAiControls } from './ai-controls.js';
import { updateReviewBar } from './review-view.js';

function sameTarget(edit, { block = null, append = false } = {}) {
  if (!edit) return false;
  if (append) return edit.mode === 'append';
  return edit.mode === 'edit' && block && edit.block
    && edit.block.start === block.start
    && edit.block.end === block.end;
}

function setModeLabel(text) {
  const label = $('#ms-mode-label');
  if (label) label.textContent = text;
}

function restoreScroll(value, bottom = false) {
  requestAnimationFrame(() => {
    const manuscript = $('.manuscript');
    if (!manuscript) return;
    manuscript.scrollTop = bottom ? manuscript.scrollHeight : value;
  });
}

function editorTextNodes(root) {
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.parentElement?.closest?.('del.ai-del')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  let node = walker.nextNode();
  while (node) {
    nodes.push(node);
    node = walker.nextNode();
  }
  return nodes;
}

function readEditorText(root) {
  return editorTextNodes(root).map((node) => node.nodeValue || '').join('');
}

function offsetFor(root, container, offset) {
  const range = document.createRange();
  range.selectNodeContents(root);
  try {
    range.setEnd(container, offset);
  } catch {
    return readEditorText(root).length;
  }
  return readEditorText(range.cloneContents());
}

function selectionOffsets(root) {
  const total = readEditorText(root).length;
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return { start: total, end: total };

  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    return { start: total, end: total };
  }

  return {
    start: offsetFor(root, range.startContainer, range.startOffset),
    end: offsetFor(root, range.endContainer, range.endOffset),
  };
}

function locateOffset(nodes, root, target) {
  let remaining = Math.max(0, target);
  for (const node of nodes) {
    const length = node.nodeValue.length;
    if (remaining <= length) return { node, offset: remaining };
    remaining -= length;
  }
  const last = nodes[nodes.length - 1];
  if (last) return { node: last, offset: last.nodeValue.length };
  return { node: root, offset: 0 };
}

function restoreSelection(root, { start, end }) {
  const nodes = editorTextNodes(root);
  const from = locateOffset(nodes, root, start);
  const to = locateOffset(nodes, root, Math.max(start, end));

  const range = document.createRange();
  try {
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
  } catch {
    range.selectNodeContents(root);
    range.collapse(false);
  }

  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
}

function focusEditor(edit, offset = edit.draft.length) {
  const editor = edit.editor;
  try {
    editor.focus({ preventScroll: true });
  } catch {
    editor.focus();
  }
  restoreSelection(editor, { start: offset, end: offset });
}

function updateApplyState(edit) {
  if (!edit?.applyButton) return;
  edit.applyButton.disabled = !edit.dirty || edit.composing;
  if (edit.actions) edit.actions.hidden = !edit.dirty;
}

function renderDiff(edit) {
  if (!edit || state.blockEdit !== edit) return;

  const editor = edit.editor;
  const hadFocus = document.activeElement === editor || editor.contains(document.activeElement);
  const selection = hadFocus ? selectionOffsets(editor) : null;

  const parts = edit.dirty
    ? diffSegments(edit.original, edit.draft)
    : [{ type: 'same', text: edit.original }];

  editor.innerHTML = parts.map((part) => {
    const text = escapeHtml(part.text);
    if (part.type === 'del') return `<del class="ai-del" contenteditable="false">${text}</del>`;
    if (part.type === 'ins') return `<ins class="ai-ins">${text}</ins>`;
    return text;
  }).join('');
  edit.renderedDraft = edit.draft;

  if (hadFocus) {
    try {
      editor.focus({ preventScroll: true });
    } catch {
      editor.focus();
    }
    restoreSelection(editor, selection);
  }
  scheduleRulerRender();
}

function scheduleDiff(edit) {
  clearTimeout(edit.previewTimer);
  edit.previewTimer = setTimeout(() => renderDiff(edit), 80);
}

function syncDraft(edit, { preview = true } = {}) {
  edit.draft = readEditorText(edit.editor);
  edit.dirty = edit.draft !== edit.original;
  updateApplyState(edit);
  if (preview && !edit.composing) scheduleDiff(edit);
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
  clearTimeout(edit.previewTimer);
  edit.container?.remove();
  if (edit.tail) edit.tail.hidden = false;
  if (state.blockEdit === edit) state.blockEdit = null;
  setModeLabel('READ');
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

  const book = state.current;
  if (!book) return;
  const source = String(book.manuscript || '');
  const draft = edit.draft;
  let next;

  if (edit.mode === 'edit') {
    if (source.slice(edit.block.start, edit.block.end) !== edit.block.original) {
      toast('正文已经变了，重新打开这一段再改', 'error');
      cancelBlockEdit({ silent: true });
      return;
    }
    next = replaceBlock(source, edit.block, draft);
  } else {
    if (!draft.trim()) {
      cancelBlockEdit({ silent: true });
      return;
    }
    next = appendBlock(source, draft);
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
    toast('先 APPLY 或取消当前段落', 'error');
    return false;
  }

  if (!append && (!block || !element || !block.editable)) return false;

  hideSelection();
  const tail = $('#prose-tail');
  if (append && !tail) return false;

  const scroll = $('.manuscript')?.scrollTop || 0;
  const original = append ? '' : block.content;
  const container = document.createElement('div');
  container.className = append ? 'block-edit append' : 'block-edit';
  container.dataset.blockType = append ? 'paragraph' : block.type;
  if (!append && block.type === 'heading') {
    container.dataset.blockLevel = String(block.token?.depth || 2);
  }

  const editor = document.createElement('div');
  editor.className = 'block-inline-edit';
  editor.dataset.blockEditor = 'true';
  editor.setAttribute('contenteditable', 'plaintext-only');
  editor.setAttribute('spellcheck', 'false');
  editor.setAttribute('role', 'textbox');
  editor.setAttribute('aria-multiline', 'true');
  editor.setAttribute('aria-label', append ? '新增段落' : '编辑这一段 Markdown 源码');
  editor.dataset.placeholder = append ? '输入新段落，或者直接写 ## 新章。' : '';
  editor.textContent = original;

  const actions = document.createElement('div');
  actions.className = 'block-edit-actions';
  actions.hidden = true;
  actions.innerHTML = [
    '<span class="block-edit-hint">Ctrl+Enter APPLY · Esc 取消</span>',
    '<button class="block-edit-btn" type="button" data-block-cancel>取消</button>',
    '<button class="block-edit-btn" type="button" data-block-apply>APPLY</button>',
  ].join('');

  container.append(editor, actions);

  const edit = {
    mode: append ? 'append' : 'edit',
    block,
    element,
    original,
    draft: original,
    renderedDraft: original,
    dirty: false,
    composing: false,
    previewTimer: 0,
    container,
    editor,
    actions,
    tail: append ? tail : null,
    scroll,
    applyButton: actions.querySelector('[data-block-apply]'),
    cancelButton: actions.querySelector('[data-block-cancel]'),
  };

  if (append) {
    tail.parentNode.insertBefore(container, tail);
    tail.hidden = true;
  } else {
    element.replaceWith(container);
  }

  state.blockEdit = edit;
  setModeLabel('EDIT');
  updateAiControls();
  updateReviewBar();

  editor.addEventListener('input', () => {
    if (state.blockEdit !== edit) return;
    syncDraft(edit);
  });

  editor.addEventListener('compositionstart', () => {
    edit.composing = true;
    updateApplyState(edit);
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

  edit.cancelButton.addEventListener('click', () => cancelBlockEdit());
  edit.applyButton.addEventListener('click', () => applyBlockEdit());

  updateApplyState(edit);
  const offset = Number.isFinite(caret)
    ? Math.max(0, Math.min(original.length, caret))
    : original.length;
  focusEditor(edit, offset);
  container.scrollIntoView({ block: 'nearest' });

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

function handleProseDoubleClick(event) {
  if (state.aiReview || state.aiRunning || state.aiProposal?.status === 'pending') return;
  if (event.target.closest('.block-edit, a, img')) return;

  const appendTarget = event.target.closest('[data-block-append]');
  if (appendTarget) {
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
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
  window.getSelection()?.removeAllRanges();
  openBlockEditor({ block, element, caret });
}

export function wireBlockEditorEvents() {
  $('#prose')?.addEventListener('dblclick', handleProseDoubleClick);
  $('#prose-tail')?.addEventListener('dblclick', (event) => {
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    openBlockEditor({ append: true });
  });
}
