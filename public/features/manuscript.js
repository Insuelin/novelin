import { state } from '../core/state.js';
import { $, $$, escapeHtml, setText } from '../core/dom.js';
import { countWords, getManuscriptTitle, parseChapterEntries, pad2 } from '../core/format.js';
import { marked, sanitizeHtml, renderBlockMath, renderMath } from '../core/markdown.js';
import { toast } from '../ui/toast.js';
import { syncEditorHeight } from '../ui/layout.js';
import { buildReviewSource, hydrateReviewEditors, renderPendingChapter, updateReviewBar } from './review-view.js';
import { scheduleRulerRender, setRulerEnabled } from './diff-ruler.js';
import { markReviewPending } from './pending-marks.js';
import { updateAiControls } from './ai-controls.js';

export function renderProse() {
  const book = state.current;
  if (!book) return;

  const prose = $('#prose');
  const review = state.aiReview;
  const source = review ? buildReviewSource(review) : (book.manuscript || '');

  if (!source.trim() && !review) {
    prose.innerHTML = '<div class="prose-empty">正文还是空的。切到 EDIT 写第一段，或者等 AI 写下一章。</div>';
    state.chapterEls = [];
    refreshChapterNav();
    return;
  }

  const html = [];
  if (review?.notice) {
    html.push(`<div class="ai-review-note">${escapeHtml(review.notice)}</div>`);
  }
  if (source.trim()) {
    html.push(marked.parse(source, { breaks: true, gfm: true }));
  }
  if (review) html.push(renderPendingChapter(review));
  prose.innerHTML = sanitizeHtml(html.join(''));
  hydrateReviewEditors(prose);
  renderBlockMath(prose);
  renderMath(prose);

  $$('a', prose).forEach((link) => {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  });

  if (getManuscriptTitle(source)) {
    const firstH1 = prose.querySelector('h1');
    if (firstH1) {
      firstH1.hidden = true;
      firstH1.classList.add('ms-book-title');
    }
  }

  const allHeadings = $$('#prose h1, #prose h2')
    .filter((element) => !element.closest('.ai-pending-chapter') && !element.classList.contains('ms-book-title'));
  const bookTitle = String(state.current.meta.title || '').trim();
  const skipFirst = allHeadings.length > 1 && bookTitle && allHeadings[0].textContent.trim() === bookTitle;
  state.chapterEls = allHeadings.slice(skipFirst ? 1 : 0);
  state.chapterEls.forEach((element, index) => {
    element.id = `chapter-${index}`;
  });
  refreshChapterNav();
  requestAnimationFrame(updateChapterFromScroll);

  if (state.pendingHighlight) {
    const mark = highlightFirst(prose, state.pendingHighlight);
    if (mark) mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
    state.pendingHighlight = '';
  }
  markReviewPending();
  scheduleRulerRender();
}


function highlightFirst(root, query) {
  if (!query) return null;
  const needle = query.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();

  while (node) {
    const text = node.nodeValue || '';
    if (text) {
      const at = text.toLowerCase().indexOf(needle);
      if (at >= 0) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + query.length);
        const mark = document.createElement('mark');
        mark.className = 'hit';
        range.surroundContents(mark);
        return mark;
      }
    }
    node = walker.nextNode();
  }

  return null;
}


export function refreshChapterNav({ reset = false } = {}) {
  const book = state.current;
  if (!book) return;

  state.chapters = parseChapterEntries(book.manuscript, book.meta.title);
  if (reset) state.currentChapter = 0;

  renderChapterMenu();
  setCurrentChapter(Math.min(state.currentChapter, Math.max(0, state.chapters.length - 1)));
}

function renderChapterMenu() {
  const menu = $('#chapter-menu');
  if (!menu) return;

  if (!state.chapters.length) {
    menu.innerHTML = '<div class="chapter-menu-list"><div class="chapter-empty">还没有章节。用 ## 写章节标题。</div></div>';
    return;
  }

  menu.innerHTML = `<div class="chapter-menu-list">${state.chapters.map((chapter, index) => `
    <button class="chapter-item" type="button" role="option" data-chapter="${index}">
      <span>${pad2(index + 1)}</span><b>${escapeHtml(chapter.title)}</b>
    </button>
  `).join('')}</div>`;
}

function setCurrentChapter(index) {
  if (!state.chapters.length) {
    const label = $('#chapter-label');
    if (label) label.textContent = 'CH / —';
    return;
  }

  const clamped = Math.max(0, Math.min(state.chapters.length - 1, index));
  state.currentChapter = clamped;
  const chapter = state.chapters[clamped];
  const label = $('#chapter-label');
  if (label) label.textContent = `CH ${pad2(clamped + 1)} / ${chapter.title}`;

  $$('#chapter-menu .chapter-item').forEach((item) => {
    item.classList.toggle('active', Number(item.dataset.chapter) === clamped);
  });
}

export function openChapterMenu(open) {
  const menu = $('#chapter-menu');
  const button = $('#chapter-btn');
  if (!menu || !button) return;
  menu.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
}

export function closeChapterMenu() {
  openChapterMenu(false);
}

export function jumpToChapter(index) {
  if (!state.chapters.length) return;

  setCurrentChapter(index);
  closeChapterMenu();

  if (state.manuscriptMode === 'read') {
    const manuscript = $('.manuscript');
    const element = state.chapterEls[index];
    if (!manuscript) return;

    state.chapterJumping = true;
    state.chapterJumpToken += 1;
    const token = state.chapterJumpToken;

    if (!element) {
      manuscript.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      const stickyHeight = $('.ms-sticky')?.getBoundingClientRect().height || 0;
      const target = manuscript.scrollTop
        + element.getBoundingClientRect().top
        - manuscript.getBoundingClientRect().top
        - stickyHeight
        - 8;
      manuscript.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    }

    setTimeout(() => {
      if (token !== state.chapterJumpToken) return;
      state.chapterJumping = false;
      setCurrentChapter(index);
      updateChapterFromScroll();
    }, 700);
    return;
  }

  const entry = state.chapters[index];
  const editor = $('#manuscript-editor');
  if (!editor) return;
  const position = Math.max(0, Math.min(editor.value.length, entry?.start || 0));
  editor.focus();
  editor.setSelectionRange(position, position);
  scrollEditorToPosition(editor, position);
}

export function updateChapterFromScroll() {
  if (state.chapterJumping) return;
  if (state.view !== 'workspace' || state.manuscriptMode !== 'read' || !state.chapters.length) return;
  const manuscript = $('.manuscript');
  if (!manuscript) return;

  const stickyHeight = $('.ms-sticky')?.getBoundingClientRect().height || 0;
  const threshold = manuscript.getBoundingClientRect().top + stickyHeight + 12;
  let index = 0;

  state.chapterEls.forEach((element, position) => {
    if (element && element.getBoundingClientRect().top <= threshold) index = position;
  });

  setCurrentChapter(Math.min(index, state.chapters.length - 1));
}

export function updateChapterFromCursor() {
  if (state.view !== 'workspace' || state.manuscriptMode !== 'edit' || !state.chapters.length) return;
  const editor = $('#manuscript-editor');
  if (!editor) return;

  const position = editor.selectionStart || 0;
  let index = 0;
  state.chapters.forEach((chapter, chapterIndex) => {
    if (chapter.start <= position) index = chapterIndex;
  });
  setCurrentChapter(index);
}

export function scheduleChapterRefresh() {
  clearTimeout(state.chapterTimer);
  state.chapterTimer = setTimeout(() => {
    refreshChapterNav();
    if (state.manuscriptMode === 'edit') updateChapterFromCursor();
    else updateChapterFromScroll();
  }, 250);
}

const READ_BLOCK_SELECTOR = '#prose p, #prose h1, #prose h2, #prose h3, #prose h4, #prose li, #prose blockquote, #prose pre';

function captureReadAnchor() {
  const book = state.current;
  const manuscript = $('.manuscript');
  const prose = $('#prose');
  if (!book || !manuscript || !prose || !state.chapters.length) return null;

  const source = String(book.manuscript || '');
  const stickyHeight = $('.ms-sticky')?.getBoundingClientRect().height || 0;
  const viewportTop = manuscript.getBoundingClientRect().top + stickyHeight + 8;

  let chapterIndex = 0;
  state.chapterEls.forEach((element, index) => {
    if (element && element.getBoundingClientRect().top <= viewportTop) chapterIndex = index;
  });
  chapterIndex = Math.max(0, Math.min(state.chapters.length - 1, chapterIndex));

  const start = Math.max(0, state.chapters[chapterIndex]?.start || 0);
  const end = state.chapters[chapterIndex + 1]?.start ?? source.length;

  let fraction = 0;
  const chapterEl = state.chapterEls[chapterIndex];
  const nextEl = state.chapterEls[chapterIndex + 1];
  if (chapterEl) {
    const top = chapterEl.getBoundingClientRect().top;
    const nextTop = nextEl ? nextEl.getBoundingClientRect().top : prose.getBoundingClientRect().bottom;
    fraction = Math.max(0, Math.min(1, (viewportTop - top) / Math.max(1, nextTop - top)));
  }

  let block = null;
  for (const element of $$(READ_BLOCK_SELECTOR, prose)) {
    if (element.getBoundingClientRect().bottom > viewportTop + 1) {
      block = element;
      break;
    }
  }

  let needle = '';
  if (block && !block.closest('.ai-pending-chapter')) {
    needle = String(block.textContent || '').trim().slice(0, 40);
  }

  let offset = Math.round(start + fraction * Math.max(0, end - start));
  if (needle) {
    const windowText = source.slice(start, end);
    for (const length of [needle.length, 24, 16, 10, 6]) {
      if (length <= 0) continue;
      const at = windowText.indexOf(needle.slice(0, length));
      if (at >= 0) {
        offset = start + at;
        break;
      }
    }
  }

  return {
    chapterIndex,
    offset: Math.max(0, Math.min(source.length, offset)),
    fraction,
    needle,
  };
}

let editorMirror = null;

function getEditorMirror(editor) {
  if (!editorMirror) {
    editorMirror = document.createElement('div');
    editorMirror.setAttribute('aria-hidden', 'true');
    editorMirror.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;box-sizing:content-box;margin:0;border:0;padding:0;overflow:visible;';
    document.body.appendChild(editorMirror);
  }

  const style = getComputedStyle(editor);
  const paddingLeft = parseFloat(style.paddingLeft) || 0;
  const paddingRight = parseFloat(style.paddingRight) || 0;
  editorMirror.style.width = `${Math.max(0, editor.clientWidth - paddingLeft - paddingRight)}px`;
  editorMirror.style.fontFamily = style.fontFamily;
  editorMirror.style.fontSize = style.fontSize;
  editorMirror.style.fontWeight = style.fontWeight;
  editorMirror.style.fontStyle = style.fontStyle;
  editorMirror.style.lineHeight = style.lineHeight;
  editorMirror.style.letterSpacing = style.letterSpacing;
  editorMirror.style.wordSpacing = style.wordSpacing;
  editorMirror.style.textTransform = style.textTransform;
  editorMirror.style.textIndent = style.textIndent;
  editorMirror.style.whiteSpace = style.whiteSpace;
  editorMirror.style.overflowWrap = style.overflowWrap;
  editorMirror.style.wordBreak = style.wordBreak;
  editorMirror.style.tabSize = style.tabSize;
  return editorMirror;
}

function editorLineTop(editor, position) {
  const mirror = getEditorMirror(editor);
  const value = editor.value;
  const at = Math.max(0, Math.min(value.length, position));
  mirror.textContent = '';
  mirror.appendChild(document.createTextNode(value.slice(0, at)));
  const marker = document.createElement('span');
  marker.textContent = String.fromCharCode(0x200b);
  mirror.appendChild(marker);
  mirror.appendChild(document.createTextNode(value.slice(at)));
  return marker.offsetTop;
}

function scrollEditorToPosition(editor, position) {
  if (!editor) return;
  const style = getComputedStyle(editor);
  const paddingTop = parseFloat(style.paddingTop) || 0;
  const top = editorLineTop(editor, position) + paddingTop;
  editor.scrollTop = Math.max(0, top);
}

function applyReadAnchorToEditor(anchor) {
  const editor = $('#manuscript-editor');
  const manuscript = $('.manuscript');
  if (!editor || !anchor) return;
  if (manuscript) manuscript.scrollTop = 0;

  const position = Math.max(0, Math.min(editor.value.length, anchor.offset || 0));
  editor.focus();
  editor.setSelectionRange(position, position);
  scrollEditorToPosition(editor, position);
  setCurrentChapter(anchor.chapterIndex || 0);
}

function captureEditAnchor() {
  const editor = $('#manuscript-editor');
  const book = state.current;
  if (!editor || !book) return null;

  const value = editor.value;
  let position = Math.max(0, Math.min(value.length, editor.selectionStart || 0));

  const style = getComputedStyle(editor);
  const lineHeight = parseFloat(style.lineHeight) || 32;
  const paddingTop = parseFloat(style.paddingTop) || 0;
  const caretTop = editorLineTop(editor, position) + paddingTop;
  if (caretTop < editor.scrollTop || caretTop + lineHeight > editor.scrollTop + editor.clientHeight) {
    const maxScroll = Math.max(1, editor.scrollHeight - editor.clientHeight);
    const ratio = Math.min(1, Math.max(0, editor.scrollTop / maxScroll));
    position = Math.round(ratio * value.length);
  }

  let chapterIndex = 0;
  state.chapters.forEach((chapter, index) => {
    if (chapter.start <= position) chapterIndex = index;
  });
  chapterIndex = Math.max(0, Math.min(state.chapters.length - 1, chapterIndex));

  const start = state.chapters[chapterIndex]?.start || 0;
  const end = state.chapters[chapterIndex + 1]?.start ?? value.length;
  const fraction = Math.max(0, Math.min(1, (position - start) / Math.max(1, end - start)));

  const lineStart = value.lastIndexOf('\n', Math.max(0, position - 1)) + 1;
  let lineEnd = value.indexOf('\n', position);
  if (lineEnd < 0) lineEnd = value.length;
  const needle = value.slice(lineStart, lineEnd).trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*>]\s+/, '')
    .slice(0, 40);

  return { chapterIndex, offset: position, fraction, needle };
}

function blockInChapter(element, chapterEl, nextEl) {
  if (!chapterEl) return true;
  if (element === chapterEl) return true;
  if (!(chapterEl.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
  if (nextEl && !(nextEl.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_PRECEDING)) return false;
  return true;
}

function applyEditAnchorToReader(anchor) {
  const manuscript = $('.manuscript');
  const prose = $('#prose');
  if (!manuscript || !prose || !anchor) return;

  const stickyHeight = $('.ms-sticky')?.getBoundingClientRect().height || 0;
  const topOffset = stickyHeight + 8;
  const chapterEl = state.chapterEls[anchor.chapterIndex];
  const nextEl = state.chapterEls[anchor.chapterIndex + 1];
  const blocks = $$(READ_BLOCK_SELECTOR, prose);
  let target = null;

  if (anchor.needle) {
    const candidates = anchor.needle.length > 12
      ? [anchor.needle, anchor.needle.slice(0, 12)]
      : [anchor.needle];
    for (const needle of candidates) {
      target = blocks.find((block) => blockInChapter(block, chapterEl, nextEl)
        && String(block.textContent || '').includes(needle)) || null;
      if (target) break;
    }
  }

  if (target) {
    const top = manuscript.scrollTop
      + target.getBoundingClientRect().top
      - manuscript.getBoundingClientRect().top
      - topOffset;
    manuscript.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
    updateChapterFromScroll();
    return;
  }

  if (chapterEl) {
    const chapterTop = chapterEl.getBoundingClientRect().top;
    const nextTop = nextEl ? nextEl.getBoundingClientRect().top : prose.getBoundingClientRect().bottom;
    const targetY = chapterTop + Math.max(0, nextTop - chapterTop) * anchor.fraction;
    const top = manuscript.scrollTop
      + targetY
      - manuscript.getBoundingClientRect().top
      - topOffset;
    manuscript.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
    updateChapterFromScroll();
    return;
  }

  manuscript.scrollTo({ top: 0, behavior: 'auto' });
  updateChapterFromScroll();
}

export function setManuscriptMode(mode, { preservePosition = false } = {}) {
  if (mode === 'edit' && state.aiReview) {
    toast('先处理 AI 提案，再手动编辑', 'error');
    return;
  }

  const previousMode = state.manuscriptMode;
  let anchor = null;
  if (preservePosition) {
    if (previousMode === 'read' && mode === 'edit') anchor = captureReadAnchor();
    else if (previousMode === 'edit' && mode === 'read') anchor = captureEditAnchor();
  }

  state.manuscriptMode = mode;
  const editing = mode === 'edit';

  $('#prose').hidden = editing;
  $('#manuscript-editor').hidden = !editing;
  $('#save-manuscript').hidden = !editing;
  hideSelection();
  $('#ms-mode-label').textContent = editing ? 'EDIT' : 'READ';

  $$('#ms-mode button').forEach((button) => {
    button.classList.toggle('on', button.dataset.msMode === mode);
  });

  if (!editing) {
    renderProse();
    if (anchor) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => applyEditAnchorToReader(anchor));
      });
    }
  } else {
    const manuscript = $('.manuscript');
    if (manuscript) manuscript.scrollTop = 0;
    requestAnimationFrame(() => {
      syncEditorHeight();
      if (anchor) applyReadAnchorToEditor(anchor);
      else updateChapterFromCursor();
    });
  }
  updateReviewBar();
  setRulerEnabled();
}


function blockElementFor(node, prose) {
  const element = node?.nodeType === 1 ? node : node?.parentElement;
  return element?.closest(READ_BLOCK_SELECTOR, prose) || null;
}

function selectionSurroundings(range, prose) {
  const blocks = $$(READ_BLOCK_SELECTOR, prose);
  const startBlock = blockElementFor(range.startContainer, prose);
  const endBlock = blockElementFor(range.endContainer, prose);
  let before = '';
  let after = '';

  if (startBlock) {
    const prefixRange = document.createRange();
    prefixRange.selectNodeContents(startBlock);
    try {
      prefixRange.setEnd(range.startContainer, range.startOffset);
      before = prefixRange.toString();
    } catch {
      before = '';
    }
  }
  if (endBlock) {
    const suffixRange = document.createRange();
    suffixRange.selectNodeContents(endBlock);
    try {
      suffixRange.setStart(range.endContainer, range.endOffset);
      after = suffixRange.toString();
    } catch {
      after = '';
    }
  }

  const startIndex = startBlock ? blocks.indexOf(startBlock) : -1;
  const endIndex = endBlock ? blocks.indexOf(endBlock) : -1;
  if (startIndex >= 0) {
    for (let i = startIndex - 1; i >= 0 && before.length < 300; i -= 1) {
      before = `${blocks[i].textContent}\n${before}`;
    }
  }
  if (endIndex >= 0) {
    for (let i = endIndex + 1; i < blocks.length && after.length < 300; i += 1) {
      after = `${after}\n${blocks[i].textContent}`;
    }
  }

  return {
    before: before.replace(/\s+/g, ' ').trim().slice(-300),
    after: after.replace(/\s+/g, ' ').trim().slice(0, 300),
  };
}

function selectionChapterTitle(range, prose) {
  const headings = $$('h1, h2, h3, h4, h5, h6', prose);
  let title = '';
  for (const heading of headings) {
    if (heading.contains(range.startContainer)) {
      title = heading.textContent.trim();
      continue;
    }
    if (heading.compareDocumentPosition(range.startContainer) & Node.DOCUMENT_POSITION_FOLLOWING) {
      title = heading.textContent.trim();
    } else {
      break;
    }
  }
  return title.slice(0, 200);
}

export function checkSelection() {
  if (state.view !== 'workspace' || state.manuscriptMode !== 'read') {
    hideSelection();
    return;
  }

  const selection = window.getSelection();
  const prose = $('#prose');

  if (!selection || selection.isCollapsed || !selection.rangeCount || !prose.contains(selection.anchorNode)) {
    hideSelection();
    return;
  }

  const rawText = selection.toString().trim();
  if (!rawText) {
    hideSelection();
    return;
  }

  const range = selection.getRangeAt(0);
  const surroundings = selectionSurroundings(range, prose);
  state.selectionText = rawText.slice(0, 8000);
  state.selectionContext = {
    text: state.selectionText,
    before: surroundings.before,
    after: surroundings.after,
    chapter: selectionChapterTitle(range, prose),
    truncated: rawText.length > 8000,
  };
  setText($('#selection-info'), `SELECTED · ${countWords(rawText)} 字`);
  $('#selection-note').hidden = false;
  updateAiControls();
}

export function hideSelection() {
  const note = $('#selection-note');
  const had = Boolean(state.selectionText || state.selectionContext) || Boolean(note && !note.hidden);
  state.selectionText = '';
  state.selectionContext = null;
  if (note && !note.hidden) note.hidden = true;
  if (had) updateAiControls();
}
