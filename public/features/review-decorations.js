import {
  Decoration,
  EditorView,
  StateEffect,
  StateField,
  WidgetType,
} from '../vendor/codemirror.js';
import { marked, sanitizeHtml } from '../core/markdown.js';

export const setReviewFrame = StateEffect.define();

function safeMarkdown(value) {
  const text = String(value || '');
  if (!text.trim()) return '';
  return sanitizeHtml(marked.parse(text, { breaks: true, gfm: true }));
}

function growTextarea(textarea, measure) {
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight}px`;
  measure?.();
}

function bindEditor(textarea, change, handlers) {
  textarea.className = 'ai-new-input';
  textarea.dataset.change = change.id;
  textarea.spellcheck = false;
  textarea.rows = 1;
  textarea.value = change.edited !== undefined ? change.edited : change.new;
  textarea.addEventListener('input', () => {
    if (textarea.dataset.composing === '1') return;
    handlers?.onEdit?.(change.id, textarea.value);
    growTextarea(textarea, handlers?.measure);
  });
  textarea.addEventListener('compositionstart', () => {
    textarea.dataset.composing = '1';
  });
  textarea.addEventListener('compositionend', () => {
    delete textarea.dataset.composing;
    handlers?.onEdit?.(change.id, textarea.value);
    growTextarea(textarea, handlers?.measure);
  });
  requestAnimationFrame(() => growTextarea(textarea, handlers?.measure));
  return textarea;
}

function setTextareaValue(textarea, value) {
  if (document.activeElement === textarea) return;
  if (textarea.dataset.composing === '1') return;
  const next = String(value ?? '');
  if (textarea.value === next) return;
  textarea.value = next;
}

class InlineDiffWidget extends WidgetType {
  constructor(change, handlers) {
    super();
    this.change = change;
    this.handlers = handlers;
  }

  eq(other) {
    return other instanceof InlineDiffWidget
      && other.change.id === this.change.id
      && other.change.old === this.change.old
      && other.change.new === this.change.new
      && other.change.edited === this.change.edited;
  }

  toDOM() {
    const wrap = document.createElement('span');
    wrap.className = 'ai-change-inline';
    wrap.dataset.change = this.change.id;

    if (this.change.old) {
      const del = document.createElement('del');
      del.className = 'ai-del';
      del.textContent = this.change.old;
      wrap.append(del);
    }

    if (this.change.new || this.change.edited !== undefined) {
      const ins = document.createElement('ins');
      ins.className = 'ai-ins';
      ins.dataset.change = this.change.id;
      ins.contentEditable = 'plaintext-only';
      ins.spellcheck = false;
      ins.textContent = this.change.edited !== undefined ? this.change.edited : this.change.new;
      ins.addEventListener('input', () => {
        if (ins.dataset.composing === '1') return;
        this.handlers?.onEdit?.(this.change.id, ins.textContent || '');
        this.handlers?.measure?.();
      });
      ins.addEventListener('compositionstart', () => {
        ins.dataset.composing = '1';
      });
      ins.addEventListener('compositionend', () => {
        delete ins.dataset.composing;
        this.handlers?.onEdit?.(this.change.id, ins.textContent || '');
        this.handlers?.measure?.();
      });
      wrap.append(ins);
    }

    return wrap;
  }

  updateDOM(dom, from) {
    const del = dom.querySelector('.ai-del');
    if (del) del.textContent = this.change.old;
    const ins = dom.querySelector('.ai-ins');
    if (ins && document.activeElement !== ins && ins.dataset.composing !== '1') {
      const next = this.change.edited !== undefined ? this.change.edited : this.change.new;
      if (ins.textContent !== next) {
        ins.textContent = next;
        requestAnimationFrame(() => this.handlers?.measure?.());
      }
    }
    return true;
  }

  ignoreEvent() {
    return true;
  }
}

class BlockDiffWidget extends WidgetType {
  constructor(change, handlers) {
    super();
    this.change = change;
    this.handlers = handlers;
  }

  eq(other) {
    return other instanceof BlockDiffWidget
      && other.change.id === this.change.id
      && other.change.old === this.change.old
      && other.change.new === this.change.new
      && other.change.edited === this.change.edited;
  }

  toDOM() {
    const block = document.createElement('div');
    block.className = 'ai-change-block';
    block.dataset.change = this.change.id;

    const oldBox = document.createElement('div');
    oldBox.className = 'ai-old';
    oldBox.innerHTML = `<span class="ai-diff-label">OLD / 原文</span>${safeMarkdown(this.change.old)}`;
    block.append(oldBox);

    const newBox = document.createElement('div');
    newBox.className = 'ai-new';
    newBox.innerHTML = '<span class="ai-diff-label">NEW / 改写</span>';
    newBox.append(bindEditor(document.createElement('textarea'), this.change, this.handlers));
    block.append(newBox);
    return block;
  }

  updateDOM(dom, from) {
    const oldBox = dom.querySelector('.ai-old');
    if (oldBox && from.change.old !== this.change.old) {
      oldBox.innerHTML = `<span class="ai-diff-label">OLD / 原文</span>${safeMarkdown(this.change.old)}`;
    }
    const textarea = dom.querySelector('textarea');
    if (textarea) {
      const next = this.change.edited !== undefined ? this.change.edited : this.change.new;
      setTextareaValue(textarea, next);
      requestAnimationFrame(() => growTextarea(textarea, this.handlers?.measure));
    }
    return true;
  }

  ignoreEvent() {
    return true;
  }
}

class ClusterWidget extends WidgetType {
  constructor(change) {
    super();
    this.change = change;
  }

  eq(other) {
    return other instanceof ClusterWidget
      && other.change.id === this.change.id
      && other.change.new === this.change.new;
  }

  toDOM() {
    const block = document.createElement('div');
    block.className = 'ai-change-block ai-change-cluster';
    block.dataset.change = this.change.id;
    block.innerHTML = `<span class="ai-diff-label">DEPENDENT / ${this.change.changeIds?.length || 0} 处相互依赖的修改 · 只能整组写入</span>${safeMarkdown(this.change.new)}`;
    return block;
  }

  updateDOM(dom, from) {
    dom.innerHTML = `<span class="ai-diff-label">DEPENDENT / ${this.change.changeIds?.length || 0} 处相互依赖的修改 · 只能整组写入</span>${safeMarkdown(this.change.new)}`;
    return true;
  }

  ignoreEvent() {
    return true;
  }
}

class PendingChapterWidget extends WidgetType {
  constructor(chapter, handlers) {
    super();
    this.chapter = chapter;
    this.handlers = handlers;
  }

  eq(other) {
    return other instanceof PendingChapterWidget
      && other.chapter.draft === this.chapter.draft
      && other.chapter.final === this.chapter.final
      && other.chapter.auto === this.chapter.auto
      && other.chapter.version === this.chapter.version;
  }

  toDOM() {
    const section = document.createElement('section');
    section.className = 'ai-pending-chapter';
    section.id = 'ai-pending-chapter';
    section.dataset.reviewAnchor = 'pending';
    section.dataset.reviewVersion = String(this.chapter.version || 0);
    section.innerHTML = `<div class="ai-pending-head"><span>PENDING CHAPTER / 待确认</span><span></span></div>
      <div class="ai-pending-body" id="ai-pending-body"></div>
      <span class="ai-pending-cursor" aria-hidden="true"></span>`;
    this.updateDOM(section, this);
    return section;
  }

  updateDOM(dom, from) {
    const chapter = this.chapter;
    const head = dom.querySelector('.ai-pending-head span:first-child');
    if (head) head.textContent = chapter.auto ? 'AI WRITING / 写入中' : 'PENDING CHAPTER / 待确认';
    const status = dom.querySelector('.ai-pending-head span:last-child');
    if (status) status.textContent = chapter.final ? 'READY' : 'STREAMING';
    const body = dom.querySelector('.ai-pending-body');
    if (body) {
      body.innerHTML = safeMarkdown(chapter.draft)
        || '<p class="ai-pending-empty">AI 正在写下一章…</p>';
    }
    const cursor = dom.querySelector('.ai-pending-cursor');
    if (cursor) cursor.hidden = Boolean(chapter.final);
    dom.dataset.reviewVersion = String(chapter.version || 0);
    requestAnimationFrame(() => this.handlers?.measure?.());
    return true;
  }

  ignoreEvent() {
    return true;
  }
}

function intersects(ranges, from, to) {
  return ranges.some((range) => from < range.to && range.from < to);
}

function widgetFor(change, handlers) {
  if (!change.editable) return new ClusterWidget(change);
  return change.block
    ? new BlockDiffWidget(change, handlers)
    : new InlineDiffWidget(change, handlers);
}

function buildDecorations(frame, handlers) {
  if (!frame) return Decoration.none;
  const ranges = [];
  const changedRanges = [];

  for (const change of frame.changes || []) {
    const from = Math.max(0, change.start);
    const to = Math.max(from, change.end);
    const widget = widgetFor(change, handlers);
    if (from === to) {
      ranges.push(Decoration.widget({ widget, block: Boolean(change.block), side: 1 }).range(from));
    } else {
      ranges.push(Decoration.replace({ widget, block: Boolean(change.block) }).range(from, to));
      changedRanges.push({ from, to });
    }
  }

  if (frame.pendingSelection?.to > frame.pendingSelection?.from) {
    const { from, to } = frame.pendingSelection;
    if (!intersects(changedRanges, from, to)) {
      ranges.push(Decoration.mark({ class: 'ai-selection-pending' }).range(from, to));
    }
  }

  for (const quote of frame.pendingQuotes || []) {
    if (quote.to <= quote.from) continue;
    if (intersects(changedRanges, quote.from, quote.to)) continue;
    ranges.push(Decoration.mark({ class: 'ai-selection-pending' }).range(quote.from, quote.to));
  }

  if (frame.pendingChapter) {
    const chapter = new PendingChapterWidget(frame.pendingChapter, handlers);
    const pos = Math.max(0, frame.length ?? 0);
    ranges.push(Decoration.widget({ widget: chapter, block: true, side: 1 }).range(pos));
  }

  return ranges.length ? Decoration.set(ranges, true) : Decoration.none;
}

export const reviewFrameField = StateField.define({
  create() {
    return { frame: null, decorations: Decoration.none, handlers: null };
  },
  update(value, transaction) {
    let frame = value.frame;
    let decorations = value.decorations;
    let handlers = value.handlers;
    let rebuilt = false;

    for (const effect of transaction.effects) {
      if (!effect.is(setReviewFrame)) continue;
      const payload = effect.value || {};
      frame = payload.frame || null;
      handlers = payload.handlers || null;
      decorations = buildDecorations(frame, handlers);
      rebuilt = true;
    }

    if (!rebuilt && !transaction.docChanged) return value;
    if (transaction.docChanged && !rebuilt && decorations !== Decoration.none) {
      decorations = decorations.map(transaction.changes);
    }

    return { frame, decorations, handlers };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

export function clearReviewFrame(view) {
  view?.dispatch({ effects: setReviewFrame.of(null) });
}
