import { state } from '../core/state.js';
import { $ } from '../core/dom.js';
import { getManuscriptTitle } from '../core/format.js';
import { applyManuscriptText, flushSave, saveAll } from './persistence.js';
import {
  EditorState,
  EditorView,
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

let view = null;
let bookId = '';
let docBom = '';
let docEol = '\n';
let syncing = false;
let scrollCallback = null;
let scrollFrame = 0;

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
  if (!update.docChanged || syncing) return;
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
  saveAll({ notify: true }).catch(() => {});
  return true;
}

export function mountEditor(prose, book, { onScroll = null } = {}) {
  if (!prose || !book) return null;
  scrollCallback = onScroll;

  if (view && bookId === book.meta.id) {
    syncEditorSource(book.manuscript);
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
        titleBlock,
        tableBlocks,
        livePreview,
        editorTheme,
        EditorView.updateListener.of(handleUpdate),
        EditorView.domEventHandlers({
          blur(event, editor) {
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
  if (!view) return false;
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
    });
    view.requestMeasure();
  } finally {
    syncing = false;
  }
  requestAnimationFrame(() => {
    if (view) view.scrollDOM.scrollTop = scrollTop;
  });
  return true;
}

export function destroyEditor() {
  if (scrollFrame) cancelAnimationFrame(scrollFrame);
  scrollFrame = 0;
  if (view) {
    try {
      view.destroy();
    } catch {
      // The view may already be detached.
    }
    view = null;
  }
  bookId = '';
  scrollCallback = null;
  $('#prose')?.classList.remove('prose-live');
  return true;
}

export function editorIsActive() {
  return Boolean(view && view.dom.isConnected);
}

export function editorDocText() {
  return view ? view.state.doc.toString() : '';
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
  const top = Math.max(0, view.lineBlockAt(pos).top - 12);
  view.scrollDOM.scrollTo({ top, behavior: 'smooth' });
  return true;
}

export function editorScrollTop() {
  return view?.scrollDOM.scrollTop || 0;
}

export function editorLineTop(offset) {
  if (!view) return 0;
  const pos = Math.max(0, Math.min(view.state.doc.length, Number(offset) || 0));
  return view.lineBlockAt(pos).top;
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
