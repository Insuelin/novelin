import katex from '/vendor/katex/katex.mjs';
import {
  Decoration,
  EditorView,
  StateField,
  ViewPlugin,
  WidgetType,
} from '../vendor/codemirror.js';
import { getManuscriptTitle } from '../core/format.js';
import { rangesOverlap, scanMath } from '../core/math-scan.js';
import { selectionTouches } from '../core/selection.js';
import { findTables } from './editor-tables.js';

const MAX_TEX_CHARS = 8000;

function renderMathWidget(tex, displayMode) {
  if (tex.length > MAX_TEX_CHARS) return null;
  try {
    return katex.renderToString(tex, {
      displayMode,
      throwOnError: false,
      strict: false,
      trust: false,
      errorColor: 'rgba(255,85,68,.9)',
    });
  } catch {
    return null;
  }
}

function requestMathMeasure(view) {
  requestAnimationFrame(() => {
    if (view.dom.isConnected) view.requestMeasure();
  });
  const fontsReady = document.fonts?.ready;
  if (fontsReady) {
    fontsReady.then(() => {
      if (view.dom.isConnected) view.requestMeasure();
    }).catch(() => {});
  }
}

function widgetPosition(view, dom) {
  let pos = -1;
  try {
    pos = view.posAtDOM(dom, 0);
  } catch {
    pos = -1;
  }
  if (!Number.isInteger(pos) || pos < 0) {
    pos = Number(dom.dataset.from);
    if (!Number.isInteger(pos) || pos < 0) pos = 0;
  }
  const doc = view.state.doc;
  while (pos < doc.length && /[ \t]/.test(doc.sliceString(pos, pos + 1))) pos += 1;
  return Math.max(0, Math.min(doc.length, pos));
}

function focusMathSource(view, dom) {
  const pos = widgetPosition(view, dom);
  view.dispatch({ selection: { anchor: pos } });
  view.focus();
}

function bindMathClick(dom, view) {
  dom.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    focusMathSource(view, dom);
  });
}

class MathBlockWidget extends WidgetType {
  constructor(tex, from) {
    super();
    this.tex = tex;
    this.from = from;
  }

  eq(other) {
    return other.tex === this.tex;
  }

  get estimatedHeight() {
    return 56 + 18 * Math.min(this.tex.split('\n').length, 8);
  }

  toDOM(view) {
    const dom = document.createElement('div');
    dom.className = 'cm-md-math-block';
    dom.contentEditable = 'false';
    dom.dataset.from = String(this.from);
    dom.title = '点击编辑公式';
    const html = renderMathWidget(this.tex, true);
    if (html) {
      dom.innerHTML = html;
      requestMathMeasure(view);
    } else {
      dom.textContent = this.tex;
    }
    bindMathClick(dom, view);
    return dom;
  }

  updateDOM(dom, view, oldWidget) {
    dom.dataset.from = String(this.from);
    if (oldWidget.tex !== this.tex) {
      const html = renderMathWidget(this.tex, true);
      if (html) dom.innerHTML = html;
      else dom.textContent = this.tex;
      requestMathMeasure(view);
    }
    return true;
  }

  ignoreEvent() {
    return true;
  }
}

class MathInlineWidget extends WidgetType {
  constructor(tex, from, display) {
    super();
    this.tex = tex;
    this.from = from;
    this.display = display;
  }

  eq(other) {
    return other.tex === this.tex && other.display === this.display;
  }

  toDOM(view) {
    const dom = document.createElement('span');
    dom.className = this.display
      ? 'cm-md-math-inline cm-md-math-inline-display'
      : 'cm-md-math-inline';
    dom.contentEditable = 'false';
    dom.dataset.from = String(this.from);
    dom.title = '点击编辑公式';
    const html = renderMathWidget(this.tex, this.display);
    if (html) {
      dom.innerHTML = html;
      requestMathMeasure(view);
    } else {
      dom.textContent = this.tex;
    }
    bindMathClick(dom, view);
    return dom;
  }

  updateDOM(dom, view, oldWidget) {
    dom.dataset.from = String(this.from);
    if (oldWidget.tex !== this.tex || oldWidget.display !== this.display) {
      const html = renderMathWidget(this.tex, this.display);
      if (html) dom.innerHTML = html;
      else dom.textContent = this.tex;
      requestMathMeasure(view);
    }
    return true;
  }

  ignoreEvent() {
    return true;
  }
}

function blockSpan(doc, range) {
  if (!range.display) return null;
  const first = doc.lineAt(range.from);
  const last = doc.lineAt(range.to);
  const prefix = doc.sliceString(first.from, range.from);
  const suffix = doc.sliceString(range.to, last.to);
  if (!/^[ \t]{0,3}$/.test(prefix)) return null;
  if (!/^[ \t]*$/.test(suffix)) return null;
  return {
    from: first.from,
    to: Math.min(doc.length, last.to + 1),
  };
}

function buildBlockDecorations(state, blocks) {
  if (!blocks.length) return Decoration.none;
  const decorations = [];
  for (const block of blocks) {
    const end = block.to > block.from
      && state.doc.sliceString(block.to - 1, block.to) === '\n'
      ? block.to - 1
      : block.to;
    if (selectionTouches(state, block.from, end)) continue;
    decorations.push(Decoration.replace({
      block: true,
      widget: new MathBlockWidget(block.range.tex, block.range.from),
    }).range(block.from, block.to));
  }
  return decorations.length ? Decoration.set(decorations, true) : Decoration.none;
}

function buildMathState(state) {
  const text = state.doc.toString();
  const all = scanMath(text);
  const tables = findTables(state.doc);
  const title = getManuscriptTitle(text);
  const titleLine = title ? state.doc.lineAt(title.start) : null;
  const blocks = [];
  const inline = [];

  for (const range of all) {
    if (titleLine && rangesOverlap(range.from, range.to, titleLine.from, titleLine.to)) continue;
    if (tables.some((table) => rangesOverlap(range.from, range.to, table.from, table.to))) continue;

    if (range.display) {
      const span = blockSpan(state.doc, range);
      if (span) {
        blocks.push({ range, ...span });
        continue;
      }
      const first = state.doc.lineAt(range.from);
      const last = state.doc.lineAt(range.to);
      if (first.number !== last.number) continue;
    }

    inline.push(range);
  }

  return {
    all,
    blocks,
    inline,
    decorations: buildBlockDecorations(state, blocks),
  };
}

export const mathField = StateField.define({
  create: buildMathState,
  update(value, transaction) {
    if (!transaction.docChanged && !transaction.selection) return value;
    if (transaction.docChanged) return buildMathState(transaction.state);
    return {
      ...value,
      decorations: buildBlockDecorations(transaction.state, value.blocks),
    };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

function buildInlineDecorations(view) {
  const field = view.state.field(mathField, false);
  if (!field) return Decoration.none;
  const visible = view.visibleRanges.length
    ? view.visibleRanges
    : [{ from: 0, to: view.state.doc.length }];
  const decorations = [];

  for (const range of field.inline) {
    if (!visible.some((part) => range.to > part.from && range.from < part.to)) continue;
    if (selectionTouches(view.state, range.from, range.to)) continue;
    decorations.push(Decoration.replace({
      widget: new MathInlineWidget(range.tex, range.from, range.display),
    }).range(range.from, range.to));
  }

  return decorations.length ? Decoration.set(decorations, true) : Decoration.none;
}

export const mathInlinePreview = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = buildInlineDecorations(view);
    this.composing = Boolean(view.composing);
  }

  update(update) {
    if (update.view.composing) {
      this.composing = true;
      if (update.docChanged) this.decorations = this.decorations.map(update.changes);
      return;
    }

    if (this.composing || update.docChanged || update.selectionSet || update.viewportChanged) {
      this.composing = false;
      this.decorations = buildInlineDecorations(update.view);
    }
  }
}, {
  decorations: (plugin) => plugin.decorations,
});

export const mathPreview = [mathField, mathInlinePreview];
