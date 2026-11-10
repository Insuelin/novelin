import { state } from '../core/state.js';
import { $ } from '../core/dom.js';
import { getManuscriptTitle } from '../core/format.js';
import { applyManuscriptText, flushSave, saveAll } from './persistence.js';
import {
  Compartment,
  EditorState,
  EditorView,
  Transaction,
  drawSelection,
  dropCursor,
  history,
  historyKeymap,
  defaultKeymap,
  keymap,
  markdown,
  markdownLanguage,
  placeholder,
} from '../vendor/codemirror.js';
import { livePreview, selectionPlainText, titleBlock } from './editor-live.js';
import { tableBlocks } from './editor-tables.js';
import { mathField, mathInlinePreview } from './editor-math.js';
import { reviewFrameField, setReviewFrame } from './review-decorations.js';

let view = null;
let bookId = '';
let docBom = '';
let docEol = '\n';
let syncing = false;
let reviewActive = false;
let scrollCallback = null;
let scrollFrame = 0;
let viewportRestoreFrame = 0;
let scrollRestoreFrame = 0;
let revealToken = 0;

const previewCompartment = new Compartment();
const reviewModeCompartment = new Compartment();
const previewExtensions = [titleBlock, tableBlocks, mathField, mathInlinePreview, livePreview];
const editableExtensions = [
  EditorView.editable.of(true),
  EditorState.readOnly.of(false),
];
const reviewExtensions = [
  EditorView.editable.of(false),
  EditorState.readOnly.of(true),
];

function normalizeDocText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n');
}

function clampPos(value, length) {
  return Math.max(0, Math.min(length, Number(value) || 0));
}

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'transparent',
    color: 'var(--text)',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--accent)',
  },
  '.cm-dropCursor': {
    borderLeft: '2px solid var(--accent)',
  },
}, { dark: true });

function splitSource(value) {
  const input = String(value ?? '');
  const bom = input.charCodeAt(0) === 0xfeff ? '﻿' : '';
  const body = bom ? input.slice(1) : input;
  return {
    bom,
    eol: body.includes('\r\n') ? '\r\n' : '\n',
    text: body.replace(/\r\n?/g, '\n'),
  };
}

function joinSource(text) {
  const value = String(text ?? '');
  const body = docEol === '\r\n' ? value.replace(/\n/g, '\r\n') : value;
  return docBom + body;
}

function handleUpdate(update) {
  if (!update.docChanged || syncing || reviewActive) return;
  applyManuscriptText(joinSource(update.state.doc.toString()));
}

function handleScroll() {
  if (!scrollCallback || scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    scrollCallback?.();
  });
}

function saveNow() {
  if (!reviewActive) saveAll({ notify: true }).catch(() => {});
  return true;
}

export function mountEditor(prose, book, { onScroll = null } = {}) {
  if (!prose || !book) return null;
  scrollCallback = onScroll;

  if (view && bookId === book.meta.id) {
    if (!reviewActive) syncEditorSource(book.manuscript);
    return view;
  }

  destroyEditor();
  bookId = book.meta.id;
  const parsed = splitSource(book.manuscript);
  docBom = parsed.bom;
  docEol = parsed.eol;
  const title = getManuscriptTitle(parsed.text);
  const initial = title && parsed.text.length > title.end + 1
    ? Math.min(parsed.text.length, title.end + 1)
    : 0;

  prose.classList.add('prose-live');
  prose.replaceChildren();

  view = new EditorView({
    parent: prose,
    state: EditorState.create({
      doc: parsed.text,
      selection: { anchor: initial },
      extensions: [
        history(),
        drawSelection(),
        dropCursor(),
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage }),
        previewCompartment.of(previewExtensions),
        reviewModeCompartment.of(editableExtensions),
        reviewFrameField,
        editorTheme,
        EditorView.updateListener.of(handleUpdate),
        EditorView.domEventHandlers({
          blur(event, editor) {
            if (reviewActive) return false;
            const next = event.relatedTarget;
            if (next && editor.dom.contains(next)) return false;
            flushSave().catch(() => {});
            return false;
          },
        }),
        keymap.of([
          { key: 'Mod-s', run: saveNow, preventDefault: true },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        placeholder('正文还是空的。点这里开始写第一段。'),
      ],
    }),
  });

  view.scrollDOM.addEventListener('scroll', handleScroll, { passive: true });
  requestAnimationFrame(() => {
    if (view) view.requestMeasure();
  });
  return view;
}

export function syncEditorSource(value) {
  if (!view || reviewActive) return false;
  const parsed = splitSource(value);
  docBom = parsed.bom;
  docEol = parsed.eol;
  const current = view.state.doc.toString();
  if (current === parsed.text) return true;

  const head = Math.min(view.state.selection.main.head, parsed.text.length);
  const scrollTop = view.scrollDOM.scrollTop;
  syncing = true;
  try {
    view.dispatch({
      changes: { from: 0, to: current.length, insert: parsed.text },
      selection: { anchor: head },
      annotations: Transaction.addToHistory.of(false),
    });
    view.requestMeasure();
  } finally {
    syncing = false;
  }
  cancelAnimationFrame(scrollRestoreFrame);
  scrollRestoreFrame = requestAnimationFrame(() => {
    scrollRestoreFrame = 0;
    if (view) view.scrollDOM.scrollTop = scrollTop;
  });
  return true;
}

export function destroyEditor() {
  if (scrollFrame) cancelAnimationFrame(scrollFrame);
  scrollFrame = 0;
  cancelAnimationFrame(viewportRestoreFrame);
  viewportRestoreFrame = 0;
  cancelAnimationFrame(scrollRestoreFrame);
  scrollRestoreFrame = 0;
  revealToken += 1;
  if (view) {
    try {
      view.destroy();
    } catch {
      // The view may already be detached.
    }
    view = null;
  }
  bookId = '';
  reviewActive = false;
  scrollCallback = null;
  $('#prose')?.classList.remove('prose-live');
  return true;
}

export function editorIsActive() {
  return Boolean(view && view.dom.isConnected);
}

export function editorReviewActive() {
  return Boolean(view && reviewActive);
}

export function editorEnterReview() {
  if (!view) return false;
  if (reviewActive) return true;
  cancelAnimationFrame(scrollRestoreFrame);
  scrollRestoreFrame = 0;
  cancelAnimationFrame(viewportRestoreFrame);
  viewportRestoreFrame = 0;
  reviewActive = true;
  view.dispatch({
    effects: [
      reviewModeCompartment.reconfigure(reviewExtensions),
      previewCompartment.reconfigure([]),
    ],
  });
  return true;
}

export function editorExitReview() {
  const active = reviewActive;
  reviewActive = false;
  revealToken += 1;
  cancelAnimationFrame(scrollRestoreFrame);
  scrollRestoreFrame = 0;
  cancelAnimationFrame(viewportRestoreFrame);
  viewportRestoreFrame = 0;
  if (!view) return active;
  view.dispatch({
    effects: [
      reviewModeCompartment.reconfigure(editableExtensions),
      previewCompartment.reconfigure(previewExtensions),
      setReviewFrame.of(null),
    ],
  });
  view.requestMeasure();
  return active;
}

export function editorApplyReview(frame, handlers, { text = null, selection = null } = {}) {
  if (!view) return false;
  revealToken += 1;
  cancelAnimationFrame(scrollRestoreFrame);
  scrollRestoreFrame = 0;
  cancelAnimationFrame(viewportRestoreFrame);
  viewportRestoreFrame = 0;
  const current = view.state.doc.toString();
  const next = text === null ? current : normalizeDocText(text);
  const docChanged = current !== next;
  const oldSelection = view.state.selection.main;
  const nextLength = next.length;
  const anchor = clampPos(selection?.anchor ?? oldSelection.anchor, nextLength);
  const head = clampPos(selection?.head ?? oldSelection.head, nextLength);
  const nextSelection = docChanged || selection ? { anchor, head } : undefined;

  let scrollTop = 0;
  let anchorPos = 0;
  let viewportOffset = 0;
  if (docChanged) {
    scrollTop = view.scrollDOM.scrollTop;
    const block = view.lineBlockAtHeight(scrollTop);
    anchorPos = Math.min(block.from, nextLength);
    viewportOffset = scrollTop - block.top;
  }

  syncing = true;
  try {
    view.dispatch({
      changes: docChanged ? { from: 0, to: current.length, insert: next } : undefined,
      selection: nextSelection,
      annotations: Transaction.addToHistory.of(false),
      effects: setReviewFrame.of({ frame, handlers }),
    });
  } finally {
    syncing = false;
  }

  if (docChanged) {
    cancelAnimationFrame(viewportRestoreFrame);
    viewportRestoreFrame = requestAnimationFrame(() => {
      viewportRestoreFrame = 0;
      if (!view) return;
      const block = view.lineBlockAt(Math.min(anchorPos, view.state.doc.length));
      view.scrollDOM.scrollTop = Math.max(0, block.top + viewportOffset);
    });
  }
  view.requestMeasure();
  return true;
}

export function editorSetReviewFrame(frame, handlers) {
  if (!view) return false;
  view.dispatch({ effects: setReviewFrame.of({ frame, handlers }) });
  view.requestMeasure();
  return true;
}

export function editorRequestMeasure() {
  if (!view) return false;
  view.requestMeasure();
  return true;
}

export function editorRevealReviewRange(from, { y = 'center' } = {}) {
  if (!view) return false;
  revealToken += 1;
  cancelAnimationFrame(viewportRestoreFrame);
  viewportRestoreFrame = 0;
  const pos = clampPos(from, view.state.doc.length);
  view.dispatch({
    effects: EditorView.scrollIntoView(pos, { y, yMargin: 16 }),
  });
  return true;
}

export function editorRevealReviewAnchor(anchor = 'pending', version = null) {
  if (!view) return false;
  const token = ++revealToken;
  cancelAnimationFrame(viewportRestoreFrame);
  viewportRestoreFrame = 0;
  const reveal = () => {
    if (!view) return false;
    const elements = [...view.dom.querySelectorAll(`[data-review-anchor="${anchor}"]`)];
    const element = version === null
      ? elements.at(-1)
      : elements.find((item) => item.dataset.reviewVersion === String(version));
    if (!element) return false;
    const host = view.scrollDOM;
    const hostRect = host.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    const sticky = document.querySelector('.ms-sticky')?.getBoundingClientRect().height || 0;
    const top = host.scrollTop + rect.top - hostRect.top - sticky - 10;
    host.scrollTop = Math.max(0, top);
    return true;
  };

  view.requestMeasure();
  if (reveal()) return true;

  let attempts = 0;
  const revealAtEnd = () => {
    if (!view || token !== revealToken) return;
    if (reveal()) return;
    attempts += 1;
    if (attempts > 10) return;
    view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight;
    view.requestMeasure();
    requestAnimationFrame(revealAtEnd);
  };
  requestAnimationFrame(revealAtEnd);
  return true;
}

export function editorDocText() {
  return view ? view.state.doc.toString() : '';
}

export function editorSelectionRange() {
  if (!view) return null;
  const selection = view.state.selection.main;
  return { from: selection.from, to: selection.to, head: selection.head };
}

export function editorSelection() {
  if (!view) return null;
  const { from, to } = view.state.selection.main;
  if (from === to) return null;

  const doc = view.state.doc;
  const text = selectionPlainText(view.state, from, to);
  if (!text.trim()) return null;

  let chapter = '';
  for (const entry of state.chapters) {
    if ((entry.start || 0) <= from) chapter = entry.title;
    else break;
  }

  return {
    from,
    to,
    text,
    before: selectionPlainText(view.state, Math.max(0, from - 300), from).replace(/\s+/g, ' ').trim().slice(-300),
    after: selectionPlainText(view.state, to, Math.min(doc.length, to + 300)).replace(/\s+/g, ' ').trim().slice(0, 300),
    chapter: String(chapter || '').slice(0, 200),
    truncated: text.length > 8000,
  };
}

export function editorSelectText(query) {
  if (!view || !query) return false;
  const needle = String(query);
  const text = view.state.doc.toString();
  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return false;

  view.dispatch({
    selection: { anchor: at, head: at + needle.length },
    effects: EditorView.scrollIntoView(at, { y: 'center' }),
  });
  view.focus();
  return true;
}

export function editorScrollTo(offset) {
  if (!view) return false;
  const pos = Math.max(0, Math.min(view.state.doc.length, Number(offset) || 0));
  view.dispatch({
    effects: EditorView.scrollIntoView(pos, {
      y: pos >= view.state.doc.length ? 'end' : 'start',
      yMargin: 12,
    }),
  });
  return true;
}

export function editorScrollTop() {
  return view?.scrollDOM.scrollTop || 0;
}

export function editorSetScrollTop(value) {
  if (!view) return false;
  view.scrollDOM.scrollTop = Math.max(0, Number(value) || 0);
  return true;
}

export function editorScroller() {
  return view?.scrollDOM || null;
}

export function editorLineTop(offset) {
  if (!view) return 0;
  const pos = Math.max(0, Math.min(view.state.doc.length, Number(offset) || 0));
  return view.lineBlockAt(pos).top;
}

export function editorLineSpan(from, to) {
  if (!view) return null;
  const length = view.state.doc.length;
  const start = clampPos(from, length);
  const end = clampPos(Math.max(start, Number(to) || 0), length);
  const first = view.lineBlockAt(start);
  const last = view.lineBlockAt(end > start ? end - 1 : end);
  return {
    top: first.top,
    height: Math.max(0, last.top + last.height - first.top),
    scrollHeight: view.scrollDOM.scrollHeight,
  };
}

export function editorAtBottom() {
  if (!view) return false;
  const scroller = view.scrollDOM;
  if (scroller.scrollHeight <= scroller.clientHeight + 2) return false;
  return scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
}

export function focusEditor() {
  if (!view) return false;
  view.focus();
  return true;
}
