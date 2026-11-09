import { state } from '../core/state.js';
import { $, $$, escapeHtml, setText } from '../core/dom.js';
import { countWords, getManuscriptTitle, parseChapterEntries, pad2 } from '../core/format.js';
import { marked, sanitizeHtml, renderBlockMath, renderMath } from '../core/markdown.js';
import { buildReviewSource, hydrateReviewEditors, renderPendingChapter } from './review-view.js';
import { scheduleRulerRender, setRulerEnabled } from './diff-ruler.js';
import { markReviewPending } from './pending-marks.js';
import { updateAiControls } from './ai-controls.js';
import {
  destroyEditor,
  editorAtBottom,
  editorIsActive,
  editorLineTop,
  editorScrollTo,
  editorScrollTop,
  editorSelectText,
  editorSelection,
  mountEditor,
} from './editor.js';

export function renderProse() {
  const book = state.current;
  if (!book) return;

  const prose = $('#prose');
  const manuscript = $('.manuscript');
  const review = state.aiReview;
  const modeLabel = $('#ms-mode-label');

  if (review) {
    destroyEditor();
    manuscript?.classList.remove('editor-mode');
    prose.classList.remove('prose-live');
    if (modeLabel) modeLabel.textContent = 'AI DIFF';
    renderReviewProse(prose, review);
    return;
  }

  manuscript?.classList.add('editor-mode');
  if (modeLabel) modeLabel.textContent = 'EDIT';
  state.chapterEls = [];
  mountEditor(prose, book, { onScroll: updateChapterFromScroll });
  refreshChapterNav();
  requestAnimationFrame(updateChapterFromScroll);

  if (state.pendingHighlight) {
    const query = state.pendingHighlight;
    state.pendingHighlight = '';
    requestAnimationFrame(() => editorSelectText(query));
  }

  setRulerEnabled();
}

function renderReviewProse(prose, review) {
  const source = buildReviewSource(review);
  const html = [];
  if (review.notice) {
    html.push(`<div class="ai-review-note">${escapeHtml(review.notice)}</div>`);
  }
  if (source.trim()) {
    html.push(marked.parse(source, { breaks: true, gfm: true }));
  }
  html.push(renderPendingChapter(review));
  prose.innerHTML = sanitizeHtml(html.join(''));
  hydrateReviewEditors(prose);
  renderBlockMath(prose);
  renderMath(prose);

  const lead = prose.querySelector(':scope > p');
  if (lead) lead.classList.add('lead');

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
  const bookTitle = String(state.current?.meta.title || '').trim();
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
  setRulerEnabled();
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

  const source = String(book.manuscript || '').replace(/\r\n?/g, '\n');
  state.chapters = parseChapterEntries(source, book.meta.title);
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

  state.chapterJumping = true;
  state.chapterJumpToken += 1;
  const token = state.chapterJumpToken;
  const chapter = state.chapters[index];

  if (editorIsActive()) {
    editorScrollTo(chapter?.start || 0);
  } else {
    const manuscript = $('.manuscript');
    const element = state.chapterEls[index];
    if (!manuscript) return;

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
  }

  setTimeout(() => {
    if (token !== state.chapterJumpToken) return;
    state.chapterJumping = false;
    setCurrentChapter(index);
  }, 700);
}

export function updateChapterFromScroll() {
  if (state.chapterJumping) return;
  if (state.view !== 'workspace' || !state.chapters.length) return;

  if (editorIsActive()) {
    if (editorAtBottom()) {
      setCurrentChapter(state.chapters.length - 1);
      return;
    }
    const threshold = editorScrollTop() + 12;
    let index = 0;
    state.chapters.forEach((chapter, position) => {
      if (editorLineTop(chapter.start || 0) <= threshold) index = position;
    });
    setCurrentChapter(Math.min(index, state.chapters.length - 1));
    return;
  }

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

export function scheduleChapterRefresh() {
  clearTimeout(state.chapterTimer);
  state.chapterTimer = setTimeout(() => {
    refreshChapterNav();
    updateChapterFromScroll();
  }, 250);
}

const READ_BLOCK_SELECTOR = '#prose p, #prose h1, #prose h2, #prose h3, #prose h4, #prose li, #prose blockquote, #prose pre';

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
  if (state.view !== 'workspace') {
    hideSelection();
    return;
  }

  if (editorIsActive()) {
    const selected = editorSelection();
    if (!selected || !selected.text.trim()) {
      hideSelection();
      return;
    }
    state.selectionText = selected.text.slice(0, 8000);
    state.selectionContext = {
      text: state.selectionText,
      before: selected.before,
      after: selected.after,
      chapter: selected.chapter,
      truncated: selected.truncated,
    };
    setText($('#selection-info'), `SELECTED · ${countWords(selected.text)} 字`);
    $('#selection-note').hidden = false;
    updateAiControls();
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
