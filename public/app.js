import { state } from './core/state.js';
import { $, $$, escapeHtml, escapeRegExp, setText, setDisabled, setHidden } from './core/dom.js';
import { countWords, getManuscriptTitle, parseChapterEntries, countChapters, pad2, formatNumber, compactNumber, timeAgo, deriveTitleFromContent, usageLabel, compactValue } from './core/format.js';
import { marked, sanitizeHtml, renderBlockMath, renderMath } from './core/markdown.js';
import { API, api, streamAiResponse } from './core/api.js';
import { aiLog, renderLog, setAiState } from './core/logger.js';
import { toast, setSaveState } from './ui/toast.js';
import { initDropdown, closeDropdowns, confirmDialog, settleConfirm, applyAccent, loadAccent, tickClock } from './ui/primitives.js';
import { syncStickyHeight, syncEditorHeight, isNearBottom, scrollManuscriptToEnd, scrollToPendingChapter, scrollToReviewChange } from './ui/layout.js';
import { ensureModelCatalog, queueMetaPatch, renderAgentSettings, setMaxTokens, setMaxSteps, setReasoningEffort, updateAiControls, openModelDialog, loadModelList, renderModelList, selectModel } from './features/ai-controls.js';

const SUMMARY_TAG_LABELS = { characters: '人物', locations: '地点', items: '道具', hooks: '伏笔' };
const SUMMARY_CONCURRENCY = 5;

/* ---------- views ---------- */
function showView(name) {
  if (name === 'workspace' && !state.current) name = 'library';
  state.view = name;
  $('#view-library').classList.toggle('active', name === 'library');
  $('#view-workspace').classList.toggle('active', name === 'workspace');
  $$('[data-nav]').forEach((button) => {
    button.classList.toggle('active', button.dataset.nav === name);
  });
  const workspaceButton = $('[data-nav="workspace"]');
  if (workspaceButton) workspaceButton.classList.toggle('disabled', !state.current);
  if (name === 'library') {
    closeChapterMenu();
    renderLibrary();
  }
  window.scrollTo(0, 0);
}

async function route() {
  const hash = location.hash || '#/library';
  if (hash.startsWith('#/book/')) {
    const id = decodeURIComponent(hash.slice(7));
    if (!id) {
      location.hash = '#/library';
      return;
    }
    if (!state.current || state.current.meta.id !== id) {
      await openBook(id);
    } else {
      showView('workspace');
    }
  } else {
    await flushSave();
    showView('library');
  }
}

async function openBook(id) {
  if (state.aiRunning) stopAi({ silent: true });
  if (state.current && state.current.meta.id !== id) await flushSave();
  try {
    const { book } = await api(`/books/${encodeURIComponent(id)}`);
    state.current = book;
    state.dirty.clear();
    state.manuscriptMode = 'read';
    renderWorkspace();
    showView('workspace');
    if (location.hash !== `#/book/${id}`) location.hash = `#/book/${id}`;
  } catch (err) {
    toast(err.message, 'error');
    state.current = null;
    if (location.hash !== '#/library') location.hash = '#/library';
    else showView('library');
  }
}

async function openBookById(id) {
  if (state.current?.meta.id === id) {
    await openBook(id);
    return;
  }
  location.hash = `#/book/${id}`;
}

/* ---------- library ---------- */
function filterBooks(books) {
  if (state.filter === 'writing') return books.filter((book) => book.aiEnabled);
  if (state.filter === 'reading') return books.filter((book) => !book.aiEnabled);
  return books;
}

function sortBooks(books) {
  const sorted = [...books];
  if (state.sort === 'words') {
    sorted.sort((a, b) => (Number(b.words) || 0) - (Number(a.words) || 0));
  } else if (state.sort === 'title') {
    sorted.sort((a, b) => String(a.title).localeCompare(String(b.title), 'zh-CN'));
  } else {
    sorted.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }
  return sorted;
}

function renderBookCard(book, index) {
  const words = Number(book.words) || 0;
  const chapters = Number(book.chapters) || 0;
  const goal = Number(book.goalWords) || 0;
  const progress = goal > 0 ? Math.min(100, Math.round((words / goal) * 100)) : 0;
  const statusLabel = book.aiEnabled ? 'WRITING' : 'READ ONLY';
  const theme = String(book.theme || '').trim() || '还没有写主题。';
  const indexLabel = String(index + 1).padStart(2, '0');

  return `<article class="book-card" data-id="${escapeHtml(book.id)}" data-title="${escapeHtml(book.title)}">
    <div class="card-cut"></div>
    <div class="card-top"><span>FILE ${indexLabel}</span><span class="status ${book.aiEnabled ? '' : 'done'}">${statusLabel}</span></div>
    <div class="book-body">
      <div class="book-no">${indexLabel}</div>
      <h2>${escapeHtml(book.title)}</h2>
      <div class="book-en">${escapeHtml(usageLabel(book.usage))} / ${escapeHtml(String(book.id).slice(0, 6).toUpperCase())}</div>
      <p>${escapeHtml(theme)}</p>
    </div>
    <div class="card-meta">
      <div><span>字数</span><b>${formatNumber(words)}</b></div>
      <div><span>章节</span><b>${String(chapters).padStart(2, '0')}</b></div>
      <div><span>更新</span><b>${timeAgo(book.updatedAt)}</b></div>
    </div>
    <div class="progress"><i style="width:${progress}%"></i></div>
    <div class="card-actions">
      <button class="text-btn" type="button" data-open>OPEN</button>
      <button class="text-btn danger" type="button" data-delete>DELETE</button>
    </div>
  </article>`;
}

function renderLibrary() {
  const books = state.books;
  $('#stat-books').textContent = pad2(books.length);
  $('#stat-words').textContent = compactNumber(books.reduce((sum, book) => sum + (Number(book.words) || 0), 0));
  $('#stat-chapters').textContent = pad2(books.reduce((sum, book) => sum + (Number(book.chapters) || 0), 0));

  const workspaceButton = $('[data-nav="workspace"]');
  if (workspaceButton) workspaceButton.classList.toggle('disabled', !state.current);

  renderSearchResults();
  if (state.query) return;

  const grid = $('#book-grid');
  const empty = $('#library-empty');
  const dropzone = $('#dropzone');

  grid.hidden = false;
  empty.hidden = true;
  dropzone.hidden = false;

  if (!books.length) {
    grid.innerHTML = '';
    grid.hidden = true;
    empty.hidden = false;
    return;
  }

  const filtered = sortBooks(filterBooks(books));
  if (!filtered.length) {
    grid.innerHTML = '<div class="empty" style="grid-column:1/-1"><h2>没有符合筛选的书</h2><p>换个筛选条件。</p></div>';
    return;
  }

  grid.innerHTML = filtered.map(renderBookCard).join('');
}

function renderSearchResults() {
  const box = $('#search-results');
  const grid = $('#book-grid');
  const empty = $('#library-empty');
  const dropzone = $('#dropzone');

  if (!state.query) {
    box.hidden = true;
    grid.hidden = !state.books.length;
    empty.hidden = !!state.books.length;
    dropzone.hidden = false;
    return;
  }

  box.hidden = false;
  grid.hidden = true;
  grid.innerHTML = '';
  empty.hidden = true;
  dropzone.hidden = true;

  const results = state.results;
  box.innerHTML = `<div class="results-head"><span>SEARCH RESULTS / 搜索结果</span><b>${results.length}</b></div>${
    results.length
      ? results.map((result, index) => renderSearchHit(result, index)).join('')
      : '<div class="empty" style="padding:44px 20px"><h2 style="font-size:24px">没有命中</h2><p>换个词试试。</p></div>'
  }`;
}

function renderSearchHit(result, index) {
  const sectionLabel = { manuscript: '正文', notes: '笔记', outline: '大纲' }[result.section] || result.section;
  return `<button class="search-hit" type="button" data-i="${index}">
    <div class="hit-top"><b>${escapeHtml(result.title)}</b><span>${escapeHtml(sectionLabel)}</span></div>
    <p>${highlightText(result.snippet, result.match)}</p>
  </button>`;
}

function highlightText(text, query) {
  const safe = escapeHtml(text);
  if (!query) return safe;
  return safe.replace(new RegExp(`(${escapeRegExp(query)})`, 'ig'), '<mark>$1</mark>');
}

function onSearchInput() {
  const query = $('#search-input').value.trim();
  state.query = query;
  clearTimeout(state.searchTimer);

  if (!query) {
    state.results = [];
    renderLibrary();
    return;
  }

  state.searchTimer = setTimeout(runSearch, 260);
}

async function runSearch() {
  const query = state.query;
  if (!query) return;
  try {
    const data = await api(`/search?q=${encodeURIComponent(query)}`);
    if (query !== state.query) return;
    state.results = data.results || [];
    renderSearchResults();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function openSearchResult(result) {
  state.pendingHighlight = result.section === 'manuscript' ? result.match : '';
  state.pendingSection = result.section;
  state.pendingQuery = result.match;

  if (state.current?.meta.id === result.bookId) {
    await openBook(result.bookId);
  } else {
    location.hash = `#/book/${result.bookId}`;
  }
}

/* ---------- workspace ---------- */
function updateTitleDisplay() {
  const book = state.current;
  const element = $('#ms-title');
  if (!book || !element) return;
  const title = getManuscriptTitle(book.manuscript)?.title || book.meta.title || '—';
  if (!state.titleEditing) element.textContent = title;
  element.title = title;
}

function startTitleEdit() {
  const book = state.current;
  const heading = $('#ms-title');
  const input = $('#ms-title-input');
  if (!book || !heading || !input || state.titleEditing || state.manuscriptMode === 'edit') return;

  state.titleEditing = true;
  input.value = getManuscriptTitle(book.manuscript)?.title || book.meta.title || '';
  heading.hidden = true;
  input.hidden = false;
  input.focus();
  input.select();
}

function stopTitleEdit({ restore = true } = {}) {
  state.titleEditing = false;
  const input = $('#ms-title-input');
  const heading = $('#ms-title');
  if (input) {
    input.hidden = true;
    input.value = '';
  }
  if (heading) heading.hidden = false;
  if (restore) updateTitleDisplay();
}

async function commitTitleEdit() {
  if (!state.titleEditing) return;

  const book = state.current;
  const input = $('#ms-title-input');
  const heading = $('#ms-title');
  if (!book || !input) {
    stopTitleEdit();
    return;
  }

  const nextTitle = input.value.trim();
  if (!nextTitle) {
    toast('书名不能为空', 'error');
    input.focus();
    return;
  }

  const info = getManuscriptTitle(book.manuscript);
  const currentTitle = info?.title || book.meta.title || '';
  if (nextTitle === currentTitle && nextTitle === book.meta.title) {
    stopTitleEdit();
    return;
  }

  const nextManuscript = info
    ? book.manuscript.slice(0, info.start) + `# ${nextTitle}` + book.manuscript.slice(info.end)
    : book.manuscript;
  const bookId = book.meta.id;

  state.titleEditing = false;
  if (input) {
    input.blur();
    input.hidden = true;
  }
  if (heading) heading.hidden = false;
  setSaveState('SAVING', '');

  let manuscriptSaved = false;
  try {
    let stats = book.stats || { words: 0, chapters: 0 };
    if (nextManuscript !== book.manuscript) {
      const result = await api(`/books/${encodeURIComponent(bookId)}/manuscript`, {
        method: 'PUT',
        body: { content: nextManuscript },
      });
      stats = {
        words: Number(result.words) || 0,
        chapters: Number(result.chapters) || 0,
      };
      if (state.current?.meta.id === bookId) {
        state.current.manuscript = nextManuscript;
        state.current.stats = stats;
        manuscriptSaved = true;
        updateTitleDisplay();
        $('#ms-words').textContent = `${formatNumber(stats.words)} 字`;
        const editor = $('#manuscript-editor');
        if (editor) editor.value = nextManuscript;
        refreshChapterNav();
      }
    }

    const { meta } = await api(`/books/${encodeURIComponent(bookId)}/meta`, {
      method: 'PUT',
      body: { title: nextTitle },
    });
    if (state.current?.meta.id !== bookId) return;

    state.current.meta = meta;
    state.titleDirty = false;
    state.loadedHeading = nextTitle;
    stopTitleEdit({ restore: false });
    updateTitleDisplay();
    const proseTitle = $('#prose h1.ms-book-title');
    if (proseTitle) proseTitle.textContent = nextTitle;
    $('#ws-breadcrumb').textContent = meta.title;
    updateBookSummary(bookId);
    setSaveState('SAVED', 'ok');
  } catch (err) {
    setSaveState('SAVE FAILED', 'error');
    if (manuscriptSaved) {
      state.titleDirty = true;
      toast(`正文标题已保存，书名没保存：${err.message}`, 'error');
      stopTitleEdit({ restore: false });
      updateTitleDisplay();
    } else {
      toast(err.message || '书名保存失败', 'error');
      stopTitleEdit();
    }
  }
}

async function syncMetaFromManuscript(bookId) {
  const book = state.current;
  if (!book || book.meta.id !== bookId || !state.titleDirty) return;

  const info = getManuscriptTitle(book.manuscript);
  if (!info?.title || info.title === book.meta.title) {
    state.titleDirty = false;
    return;
  }

  try {
    const { meta } = await api(`/books/${encodeURIComponent(bookId)}/meta`, {
      method: 'PUT',
      body: { title: info.title },
    });
    if (state.current?.meta.id !== bookId) return;
    state.current.meta = meta;
    state.titleDirty = false;
    state.loadedHeading = info.title;
    $('#ws-breadcrumb').textContent = meta.title;
    updateTitleDisplay();
    updateBookSummary(bookId);
  } catch (err) {
    toast(`书名同步失败：${err.message}`, 'error');
  }
}

function renderWorkspace() {
  const book = state.current;
  if (!book) {
    showView('library');
    return;
  }

  closeChapterMenu();
  if (state.termsBookId && state.termsBookId !== book.meta.id) {
    const termsDialog = $('#terms-dialog');
    if (termsDialog?.open) termsDialog.close();
    state.termsBookId = '';
  }
  if (state.auditBookId && state.auditBookId !== book.meta.id) {
    state.auditAbort?.abort();
    state.auditAbort = null;
    const auditDialog = $('#audit-dialog');
    if (auditDialog?.open) auditDialog.close();
    state.auditBookId = '';
    state.auditIssues = [];
  }
  if (state.summaryBookId && state.summaryBookId !== book.meta.id) {
    const summaryDialog = $('#summary-dialog');
    if (summaryDialog?.open) summaryDialog.close();
    state.summaryBookId = '';
    state.summaryChapters = [];
    state.summaryOrphans = [];
  }
  if (state.aiBookId && state.aiBookId !== book.meta.id) clearReview({ render: false });
  const stats = book.stats || { words: 0, chapters: 0 };
  const aiLabel = book.meta.aiEnabled
    ? `AI ${String(book.meta.aiMode || 'diff').toUpperCase()}`
    : 'READ ONLY';

  state.currentChapter = 0;
  state.titleEditing = false;
  state.titleDirty = false;
  state.loadedHeading = getManuscriptTitle(book.manuscript)?.title || '';
  const titleInput = $('#ms-title-input');
  if (titleInput) {
    titleInput.hidden = true;
    titleInput.value = '';
  }
  const titleElement = $('#ms-title');
  if (titleElement) titleElement.hidden = false;
  $('#ws-breadcrumb').textContent = book.meta.title;
  $('#ws-status').textContent = aiLabel;
  updateTitleDisplay();
  $('#ms-words').textContent = `${formatNumber(stats.words)} 字`;
  $('#theme-editor').value = book.meta.theme || '';
  $('#outline-editor').value = book.outline || '';
  $('#notes-editor').value = book.notes || '';
  $('#manuscript-editor').value = book.manuscript || '';
  $('#ai-model-label').textContent = book.meta.model || '—';

  setSaveState('SAVED', 'ok');
  activateTab('theme');
  setManuscriptMode('read');
  hideSelection();
  renderAgent();
  applyPendingSearch();
  requestAnimationFrame(syncStickyHeight);
}

function reviewChangeHtml(change, index) {
  const oldText = String(change.old || '');
  const newText = String(change.new || '');
  const blockLevel = /[\r\n]/.test(oldText) || /[\r\n]/.test(newText)
    || oldText.length + newText.length > 1600;

  if (blockLevel) {
    return `<div class="ai-change-block" data-change="${index}">
      <div class="ai-old"><span class="ai-diff-label">OLD / 原文</span>${marked.parse(oldText, { breaks: true, gfm: true })}</div>
      <div class="ai-new"><span class="ai-diff-label">NEW / 改写</span>${marked.parse(newText, { breaks: true, gfm: true })}</div>
    </div>`;
  }

  const oldHtml = oldText ? `<del class="ai-del">${escapeHtml(oldText)}</del>` : '';
  const newHtml = newText ? `<ins class="ai-ins" data-change="${index}">${marked.parseInline(newText)}</ins>` : '';
  return `${oldHtml}${newHtml}`;
}

function buildReviewSource(review) {
  let source = '';
  let cursor = 0;
  const changes = [...(review.changes || [])].sort((a, b) => a.start - b.start);
  changes.forEach((change, index) => {
    if (change.start < cursor) return;
    source += review.text.slice(cursor, change.start);
    source += reviewChangeHtml(change, index);
    cursor = Math.max(cursor, change.end);
  });
  source += review.text.slice(cursor);
  return source;
}

function reviewChangesSorted(review) {
  return [...(review.changes || [])].sort((a, b) => a.start - b.start);
}

function growReviewEditor(element) {
  element.style.height = 'auto';
  element.style.height = `${element.scrollHeight}px`;
}

function hydrateReviewEditors(root) {
  const review = state.aiReview;
  if (!review || !root) return;
  const changes = reviewChangesSorted(review);

  $$('.ai-change-block[data-change]', root).forEach((block) => {
    const change = changes[Number(block.dataset.change)];
    const box = block.querySelector('.ai-new');
    if (!change || !box) return;

    const label = box.querySelector('.ai-diff-label');
    [...box.childNodes].forEach((node) => {
      if (node !== label) node.remove();
    });

    const textarea = document.createElement('textarea');
    textarea.className = 'ai-new-input';
    textarea.dataset.change = block.dataset.change;
    textarea.spellcheck = false;
    textarea.rows = 1;
    textarea.value = change.edited !== undefined ? change.edited : change.new;
    box.appendChild(textarea);
    growReviewEditor(textarea);
  });

  $$('ins.ai-ins[data-change]', root).forEach((ins) => {
    const change = changes[Number(ins.dataset.change)];
    if (!change) return;
    if (change.edited !== undefined) ins.textContent = change.edited;
    ins.setAttribute('contenteditable', 'plaintext-only');
    ins.setAttribute('spellcheck', 'false');
  });
}

function renderPendingChapter(review) {
  if (!review || review.action !== 'chapter') return '';
  const body = review.draft.trim()
    ? marked.parse(review.draft, { breaks: true, gfm: true })
    : '<p class="ai-pending-empty">AI 正在写下一章…</p>';
  const heading = review.auto ? 'AI WRITING / 写入中' : 'PENDING CHAPTER / 待确认';
  return `<section class="ai-pending-chapter" id="ai-pending-chapter">
    <div class="ai-pending-head"><span>${heading}</span><span>${review.draftFinal ? 'READY' : 'STREAMING'}</span></div>
    <div class="ai-pending-body" id="ai-pending-body">${body}</div>
    ${review.draftFinal ? '' : '<span class="ai-pending-cursor" aria-hidden="true"></span>'}
  </section>`;
}

function renderProse() {
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

/* ---------- diff ruler ---------- */
function clusterRulerTops(values, tolerance) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const tops = [];
  for (const value of sorted) {
    if (!tops.length || value - tops[tops.length - 1] > tolerance) tops.push(value);
  }
  return tops;
}

function rulerGeometry() {
  const prose = $('#prose');
  const ms = $('.manuscript');
  const ruler = $('#diff-ruler');
  if (!prose || !ms || !ruler) return null;

  const paragraph = prose.querySelector('p');
  const lineHeight = parseFloat(paragraph ? getComputedStyle(paragraph).lineHeight : '');
  const tolerance = Math.max(6, (Number.isFinite(lineHeight) ? lineHeight : 24) * 0.45);
  const msRect = ms.getBoundingClientRect();
  const scrollTop = ms.scrollTop;
  const toContent = (top) => top - msRect.top + scrollTop;

  const values = [];
  const range = document.createRange();
  range.selectNodeContents(prose);
  [...range.getClientRects()].forEach((rect) => {
    if (rect.width > 0 && rect.height > 0) values.push(toContent(rect.top));
  });
  const tops = clusterRulerTops(values, tolerance);

  return {
    prose,
    ms,
    ruler,
    toContent,
    tolerance,
    tops,
    totalLines: tops.length,
    rulerHeight: ruler.clientHeight,
    scrollHeight: ms.scrollHeight,
  };
}

function nearestRulerLine(tops, value) {
  let best = 0;
  let distance = Infinity;
  tops.forEach((top, index) => {
    const next = Math.abs(top - value);
    if (next < distance) {
      distance = next;
      best = index;
    }
  });
  return best;
}

function rulerLineSpan(element, geometry) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const values = [...range.getClientRects()]
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .map((rect) => geometry.toContent(rect.top));
  const clusters = clusterRulerTops(values, geometry.tolerance);
  if (!clusters.length) return null;
  const indices = clusters.map((top) => nearestRulerLine(geometry.tops, top));
  return { start: Math.min(...indices), end: Math.max(...indices) };
}

function layoutRulerThumb() {
  const wrap = document.querySelector('.ms-wrap');
  const ms = $('.manuscript');
  const ruler = $('#diff-ruler');
  const thumb = $('#diff-ruler-thumb');
  if (!wrap?.classList.contains('ruler-on') || !ms || !ruler || !thumb) return;

  const total = ms.scrollHeight;
  const viewport = ms.clientHeight;
  const height = ruler.clientHeight;
  if (!total || !viewport || !height) return;
  const maxScroll = Math.max(1, total - viewport);
  const thumbHeight = total <= viewport
    ? height
    : Math.max(24, Math.round((viewport / total) * height));
  const thumbTop = total <= viewport
    ? 0
    : Math.round((ms.scrollTop / maxScroll) * (height - thumbHeight));

  thumb.style.height = `${thumbHeight}px`;
  thumb.style.top = `${thumbTop}px`;
  thumb.setAttribute('aria-valuenow', String(Math.round((ms.scrollTop / maxScroll) * 100)));
}

function renderRuler() {
  const wrap = document.querySelector('.ms-wrap');
  const ruler = $('#diff-ruler');
  const marks = $('#diff-ruler-marks');
  if (!wrap?.classList.contains('ruler-on') || !ruler || !marks) return;

  marks.innerHTML = '';
  const geometry = rulerGeometry();
  if (!geometry || !geometry.tops.length) {
    layoutRulerThumb();
    return;
  }

  const paragraphs = [...geometry.prose.querySelectorAll('p')];
  const elements = [...geometry.prose.querySelectorAll(
    '.ai-del, .ai-ins, .ai-selection-pending, .ai-change-block .ai-old, .ai-change-block .ai-new',
  )];
  const ranges = [];
  for (const element of elements) {
    const span = rulerLineSpan(element, geometry);
    if (!span) continue;
    const kind = element.classList.contains('ai-selection-pending')
      ? 'pending'
      : (element.classList.contains('ai-del') || element.classList.contains('ai-old') ? 'red' : 'green');
    ranges.push({ ...span, kind, element });
  }

  const merged = [];
  for (const range of ranges.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = merged[merged.length - 1];
    const sameState = last && ((range.kind === 'pending') === last.kinds.has('pending'));
    if (last && sameState && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
      last.kinds.add(range.kind);
    } else {
      merged.push({ ...range, kinds: new Set([range.kind]) });
    }
  }

  for (const range of merged) {
    const kinds = range.kinds;
    const kind = kinds.size === 1
      ? [...kinds][0]
      : (kinds.has('red') && kinds.has('green') ? 'blue' : [...kinds][0]);
    const rawTop = (geometry.tops[range.start] / geometry.scrollHeight) * geometry.rulerHeight;
    const rawHeight = ((range.end - range.start + 1) / geometry.totalLines) * geometry.rulerHeight;
    const block = Math.max(3, rawHeight);
    let top = rawTop;
    if (block > rawHeight) top -= (block - rawHeight) / 2;
    top = Math.max(0, Math.min(geometry.rulerHeight - block, top));

    const paragraph = range.element.closest('p');
    const paragraphIndex = paragraph ? paragraphs.indexOf(paragraph) + 1 : 0;
    const label = kind === 'red' ? '删除' : kind === 'green' ? '新增' : kind === 'blue' ? '修改' : '正在改写';

    const mark = document.createElement('button');
    mark.type = 'button';
    mark.className = 'diff-ruler-mark';
    mark.dataset.kind = kind;
    mark.dataset.scroll = String(Math.round(geometry.tops[range.start]));
    mark.title = paragraphIndex ? `第 ${paragraphIndex} 段 · ${label}` : label;
    mark.setAttribute('aria-label', mark.title);
    mark.style.top = `${Math.round(top)}px`;
    mark.style.height = `${Math.round(block)}px`;
    marks.appendChild(mark);
  }

  layoutRulerThumb();
}

function scheduleRulerRender() {
  if (state.rulerFrame) return;
  state.rulerFrame = requestAnimationFrame(() => {
    state.rulerFrame = 0;
    renderRuler();
  });
}

function setRulerEnabled() {
  const wrap = document.querySelector('.ms-wrap');
  const ruler = $('#diff-ruler');
  if (!wrap || !ruler) return;
  const singleColumn = window.matchMedia('(max-width: 1080px)').matches;
  const enabled = Boolean(state.current) && state.manuscriptMode === 'read' && !singleColumn;
  wrap.classList.toggle('ruler-on', enabled);
  ruler.hidden = !enabled;
  if (enabled) {
    scheduleRulerRender();
  } else {
    const marks = $('#diff-ruler-marks');
    if (marks) marks.innerHTML = '';
  }
}

function showRulerThumb() {
  const wrap = document.querySelector('.ms-wrap');
  if (!wrap) return;
  wrap.classList.add('ruler-show');
  clearTimeout(state.rulerThumbTimer);
  state.rulerThumbTimer = setTimeout(() => wrap.classList.remove('ruler-show'), 900);
}

function wireDiffRuler() {
  const ruler = $('#diff-ruler');
  const thumb = $('#diff-ruler-thumb');
  const ms = $('.manuscript');
  const prose = $('#prose');
  if (!ruler || !thumb || !ms || !prose) return;

  let drag = null;
  thumb.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    showRulerThumb();
    thumb.setPointerCapture(event.pointerId);
    thumb.classList.add('dragging');
    drag = { startY: event.clientY, startScroll: ms.scrollTop };
  });
  thumb.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const height = ruler.clientHeight;
    const maxScroll = Math.max(1, ms.scrollHeight - ms.clientHeight);
    const travel = Math.max(1, height - thumb.offsetHeight);
    const delta = ((event.clientY - drag.startY) / travel) * maxScroll;
    ms.scrollTop = Math.max(0, Math.min(maxScroll, drag.startScroll + delta));
  });
  const endDrag = (event) => {
    if (!drag) return;
    drag = null;
    thumb.classList.remove('dragging');
    if (event?.pointerId !== undefined && thumb.hasPointerCapture(event.pointerId)) {
      thumb.releasePointerCapture(event.pointerId);
    }
  };
  thumb.addEventListener('pointerup', endDrag);
  thumb.addEventListener('pointercancel', endDrag);

  ruler.addEventListener('click', (event) => {
    const mark = event.target.closest('.diff-ruler-mark');
    if (mark) {
      const target = Number(mark.dataset.scroll) || 0;
      ms.scrollTo({
        top: Math.max(0, target - ms.clientHeight / 2),
        behavior: 'smooth',
      });
      return;
    }
    if (event.target.closest('.diff-ruler-thumb')) return;
    const rect = ruler.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    ms.scrollTo({ top: ratio * ms.scrollHeight - ms.clientHeight / 2, behavior: 'smooth' });
  });

  let scrollFrame = 0;
  ms.addEventListener('scroll', () => {
    showRulerThumb();
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      layoutRulerThumb();
    });
  });
  ms.addEventListener('focus', showRulerThumb);
  prose.addEventListener('input', scheduleRulerRender);
  window.addEventListener('resize', () => {
    setRulerEnabled();
    scheduleRulerRender();
  });

  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => {
      if (document.querySelector('.ms-wrap')?.classList.contains('ruler-on')) {
        scheduleRulerRender();
      }
    });
    observer.observe(prose);
    observer.observe(ms);
  }
}

/* ---------- ai review ---------- */
function updateReviewBar() {
  const review = state.aiReview;
  const bar = $('#review-bar');
  if (bar) bar.hidden = !review;

  const editButton = $('#ms-mode [data-ms-mode="edit"]');
  if (editButton) editButton.disabled = Boolean(review);
  if (!review) return;

  const pending = review.proposal?.status === 'pending';
  const changeCount = review.changes.length;
  const prefix = review.auto ? 'AI WRITE' : 'AI DIFF';
  let label;

  if (review.status === 'proposal') {
    const bits = [];
    if (changeCount) bits.push(`${changeCount} 处修改`);
    if (review.draftFinal) bits.push('新章');
    if (review.notice) bits.push('大纲修改');
    label = `AI DIFF · ${bits.length ? `${bits.join(' · ')} · ` : ''}待确认`;
  } else if (review.action === 'revise' && review.selectionWords) {
    const progress = review.progress ? ` · ${review.progress}` : '';
    label = `${prefix} · 正在改写选中 · ${review.selectionWords} 字${progress}`;
  } else if (review.progress) {
    label = `${prefix} · ${review.progress}`;
  } else if (review.action === 'chapter') {
    label = `${prefix} · 新章生成中${review.draft ? ` · ${formatNumber(countWords(review.draft))} 字` : ''}`;
  } else {
    label = `${prefix} · ${changeCount ? `${changeCount} 处修改 · ` : ''}${review.auto ? '写入中' : '分析中'}`;
  }

  const labelElement = $('#review-label');
  if (labelElement) labelElement.textContent = label;
  if (bar) bar.dataset.state = review.status;

  const stop = $('#review-stop');
  if (stop) stop.hidden = review.status !== 'streaming';

  $$('#review-bar [data-review-action]').forEach((button) => {
    button.hidden = !pending;
    button.disabled = !pending;
  });
  requestAnimationFrame(syncStickyHeight);
}

function clearPendingMarks(root = $('#prose')) {
  if (!root) return;
  $$('.ai-selection-pending', root).forEach((mark) => {
    mark.replaceWith(...mark.childNodes);
  });
}

function wrapTextRange(range) {
  if (!range || range.collapsed) return null;
  const prose = $('#prose');
  if (!prose || !prose.contains(range.commonAncestorContainer)) return null;

  const nodes = [];
  const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  while (walker.nextNode()) nodes.push(walker.currentNode);

  let first = null;
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    let start = 0;
    let end = node.nodeValue.length;
    if (node === range.startContainer) start = range.startOffset;
    if (node === range.endContainer) end = range.endOffset;
    if (start >= end) continue;

    const target = start > 0 ? node.splitText(start) : node;
    if (end - start < target.nodeValue.length) target.splitText(end - start);

    const mark = document.createElement('span');
    mark.className = 'ai-selection-pending';
    target.parentNode.insertBefore(mark, target);
    mark.appendChild(target);
    first = mark;
  }
  return first;
}

function plainQuoteText(value) {
  return String(value)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-+*]\s+|\d+\.\s+)/gm, '')
    .replace(/[*_~`]+/g, '')
    .replace(/\\([\\`*_{}\[\]()#+\-.!])/g, '$1');
}

function findQuoteRange(prose, quote) {
  const value = String(quote || '');
  if (!prose || !value) return null;

  const nodes = [];
  let text = '';
  const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      if (node.parentElement?.closest('.ai-pending-chapter, .ai-review-note')) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  while (walker.nextNode()) {
    const node = walker.currentNode;
    nodes.push({ node, start: text.length });
    text += node.nodeValue;
  }

  let needle = value;
  let index = text.indexOf(needle);
  if (index < 0) {
    needle = plainQuoteText(value);
    if (needle && needle !== value) index = text.indexOf(needle);
  }
  if (index < 0) return null;

  const locate = (position, isEnd = false) => {
    for (const item of nodes) {
      const end = item.start + item.node.nodeValue.length;
      if (position < end || (isEnd && position === end)) {
        return { node: item.node, offset: position - item.start };
      }
    }
    const last = nodes[nodes.length - 1];
    return last ? { node: last.node, offset: last.node.nodeValue.length } : null;
  };

  const start = locate(index);
  const end = locate(index + needle.length, true);
  if (!start || !end) return null;

  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);

  const blocked = prose.querySelectorAll('.ai-del, .ai-ins, .ai-change-block, .ai-selection-pending');
  for (const element of blocked) {
    if (range.intersectsNode(element)) return null;
  }
  return range;
}

function markPendingQuotes(quotes, { scroll = false } = {}) {
  const prose = $('#prose');
  if (!prose) return 0;

  clearPendingMarks(prose);
  let first = null;
  let count = 0;
  for (const quote of quotes || []) {
    const range = findQuoteRange(prose, quote);
    if (!range) continue;
    const mark = wrapTextRange(range);
    if (!mark) continue;
    if (!first) first = mark;
    count += 1;
  }
  if (first && scroll) first.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return count;
}

function markReviewPending({ scroll = false } = {}) {
  const review = state.aiReview;
  if (!review || !Array.isArray(review.pendingQuotes) || !review.pendingQuotes.length) return 0;
  return markPendingQuotes(review.pendingQuotes, { scroll });
}

function markPendingSelection() {
  const prose = $('#prose');
  const selection = window.getSelection();
  if (!prose || !selection || selection.isCollapsed || !selection.rangeCount) return false;

  const range = selection.getRangeAt(0);
  if (!prose.contains(range.commonAncestorContainer)) return false;

  clearPendingMarks(prose);
  const first = wrapTextRange(range);
  selection.removeAllRanges();
  if (first) first.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return Boolean(first);
}

function startReview(action, { selectionWords = 0, preserveSelection = false, pendingQuotes = [], mode = 'diff' } = {}) {
  const book = state.current;
  if (!book) return;

  state.aiReview = {
    action,
    auto: mode === 'auto',
    base: book.manuscript || '',
    text: book.manuscript || '',
    changes: [],
    draft: '',
    draftFinal: false,
    status: 'streaming',
    proposal: null,
    notice: '',
    progress: '',
    selectionWords,
    pendingQuotes: (Array.isArray(pendingQuotes) ? pendingQuotes : [])
      .map((quote) => String(quote || '').trim())
      .filter(Boolean),
  };
  state.aiProposal = null;

  if (state.manuscriptMode === 'edit') setManuscriptMode('read');
  hideSelection();
  updateReviewBar();
  if (!preserveSelection) renderProse();
  scheduleRulerRender();
}

function clearReview({ render = true } = {}) {
  state.aiReview = null;
  state.aiProposal = null;
  clearTimeout(state.aiDraftTimer);
  state.aiDraftTimer = null;
  updateReviewBar();
  if (render) renderProse();
}

function applyChangeToReview(review, op, opIndex = null) {
  if (!review || !op || op.type !== 'edit_manuscript') return false;

  const oldText = String(op.old_string || '');
  const newText = String(op.new_string || '');
  if (!oldText) return false;

  const index = review.text.indexOf(oldText);
  if (index < 0) return false;

  const delta = newText.length - oldText.length;
  for (const change of review.changes) {
    if (index + oldText.length <= change.start) {
      change.start += delta;
      change.end += delta;
    }
  }

  review.text = review.text.slice(0, index) + newText + review.text.slice(index + oldText.length);
  review.changes.push({
    start: index,
    end: index + newText.length,
    old: oldText,
    new: newText,
    edited: undefined,
    accepted: true,
    opIndex,
  });
  review.changes.sort((a, b) => a.start - b.start);

  const merged = [];
  for (const change of review.changes) {
    const last = merged[merged.length - 1];
    if (last && change.start < last.end) {
      last.end = Math.max(last.end, change.end);
      last.old += change.old;
      last.new += change.new;
      review.overlap = true;
    } else {
      merged.push({ ...change });
    }
  }
  review.changes = merged;
  review.progress = '';
  return true;
}

function applyPreviewOp(op) {
  const review = state.aiReview;
  if (!review || review.status !== 'streaming' || !op) return false;

  if (op.type === 'edit_outline') {
    review.notice = '大纲有修改，确认后写入左侧大纲。';
    review.progress = '';
    updateReviewBar();
    renderProse();
    return true;
  }

  const applied = applyChangeToReview(review, op);
  if (applied) {
    updateReviewBar();
    renderProse();
    scrollToReviewChange(true);
  }
  return applied;
}

function openProposalReview(proposal) {
  const book = state.current;
  if (!book || !proposal) return;

  state.aiProposal = proposal;
  const review = {
    action: proposal.action || 'chat',
    base: book.manuscript || '',
    text: book.manuscript || '',
    changes: [],
    draft: '',
    draftFinal: false,
    status: 'proposal',
    proposal,
    notice: '',
    progress: '',
  };

  let hasOutline = false;
  const ops = Array.isArray(proposal.ops) ? proposal.ops : [];
  ops.forEach((op, index) => {
    if (op.type === 'edit_manuscript') applyChangeToReview(review, op, index);
    else if (op.type === 'edit_outline') hasOutline = true;
    else if (op.type === 'append_chapter') {
      review.draft = String(op.content || '');
      review.draftFinal = true;
    }
  });
  if (hasOutline) review.notice = '大纲有修改，确认后写入左侧大纲。';
  if (!review.changes.length && !review.draftFinal && !hasOutline) {
    review.notice = '这份提案没有可预览的改动。';
  }

  state.aiReview = review;
  if (state.manuscriptMode === 'edit') setManuscriptMode('read');
  updateReviewBar();
  renderProse();
  if (review.draftFinal) scrollToPendingChapter();
  else scrollToReviewChange(true);
  setAiState('PROPOSAL', 'proposal');
  updateAiControls();
}

function scheduleDraftRender() {
  if (state.aiDraftTimer) return;
  state.aiDraftTimer = setTimeout(() => {
    state.aiDraftTimer = null;
    updateDraftPreview();
  }, 80);
}

function updateDraftPreview() {
  const review = state.aiReview;
  if (!review) return;

  const manuscript = $('.manuscript');
  const nearBottom = isNearBottom(manuscript);
  let section = $('#ai-pending-chapter');
  const hadSection = Boolean(section);

  if (!section) {
    renderProse();
    section = $('#ai-pending-chapter');
  } else {
    const body = $('#ai-pending-body');
    if (body) {
      body.innerHTML = sanitizeHtml(review.draft.trim()
        ? marked.parse(review.draft, { breaks: true, gfm: true })
        : '<p class="ai-pending-empty">AI 正在写下一章…</p>');
      renderBlockMath(body);
      renderMath(body);
    }
    const status = section.querySelector('.ai-pending-head span:last-child');
    if (status) status.textContent = review.draftFinal ? 'READY' : 'STREAMING';
    const cursor = section.querySelector('.ai-pending-cursor');
    if (cursor) cursor.hidden = review.draftFinal;
  }

  if (!hadSection || nearBottom) scrollManuscriptToEnd();
  updateReviewBar();
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

function refreshChapterNav({ reset = false } = {}) {
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

function openChapterMenu(open) {
  const menu = $('#chapter-menu');
  const button = $('#chapter-btn');
  if (!menu || !button) return;
  menu.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
}

function closeChapterMenu() {
  openChapterMenu(false);
}

function jumpToChapter(index) {
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

function updateChapterFromScroll() {
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

function updateChapterFromCursor() {
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

function scheduleChapterRefresh() {
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

function setManuscriptMode(mode, { preservePosition = false } = {}) {
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

function activateTab(name) {
  $$('#briefing-tabs button').forEach((button) => {
    button.classList.toggle('on', button.dataset.tab === name);
  });
  $$('.tab-pane').forEach((pane) => {
    pane.classList.toggle('on', pane.dataset.pane === name);
  });
}

function selectInTextarea(textarea, query) {
  if (!textarea || !query) return;
  const index = textarea.value.indexOf(query);
  if (index >= 0) {
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(index, index + query.length);
  }
}

function applyPendingSearch() {
  if (!state.pendingSection) return;

  const section = state.pendingSection;
  const query = state.pendingQuery;

  if (section === 'outline' || section === 'notes') {
    activateTab(section);
    selectInTextarea(section === 'outline' ? $('#outline-editor') : $('#notes-editor'), query);
  }

  state.pendingSection = '';
  state.pendingQuery = '';
}

/* ---------- editing / saving ---------- */
function markDirty(section) {
  state.dirty.add(section);
  setSaveState('UNSAVED', 'warn');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    saveAll().catch(() => {});
  }, 1500);
}

async function saveSection(section) {
  const book = state.current;
  if (!book) return;

  const bookId = book.meta.id;
  const content = section === 'theme' ? book.meta.theme : book[section];

  if (state.saving.has(section)) {
    state.saveAgain.add(section);
    return;
  }

  state.saving.add(section);
  let saved = false;
  try {
    let result;
    if (section === 'theme') {
      result = await api(`/books/${bookId}/meta`, {
        method: 'PUT',
        body: { theme: content },
      });
      if (state.current?.meta.id === bookId) state.current.meta = result.meta;
    } else {
      result = await api(`/books/${bookId}/${section}`, {
        method: 'PUT',
        body: { content },
      });
      if (section === 'manuscript' && state.current?.meta.id === bookId) {
        state.current.stats = {
          words: Number(result.words) || 0,
          chapters: Number(result.chapters) || 0,
        };
      }
    }

    const stillCurrent = state.current?.meta.id === bookId;
    const latest = stillCurrent
      ? (section === 'theme' ? state.current.meta.theme : state.current[section])
      : null;

    if (stillCurrent) {
      if (latest === content) state.dirty.delete(section);
      else state.saveAgain.add(section);
    }
    if (section === 'manuscript' && stillCurrent) {
      await syncMetaFromManuscript(bookId);
    }
    updateBookSummary(bookId);
    saved = true;
  } finally {
    state.saving.delete(section);
    const again = state.saveAgain.delete(section);
    const canRetry = state.current?.meta.id === bookId;
    if (saved && again && canRetry) {
      await saveSection(section);
    }
  }
}

async function saveAll({ notify = false } = {}) {
  clearTimeout(state.saveTimer);
  const sections = [...state.dirty];

  if (!sections.length) {
    setSaveState('SAVED', 'ok');
    if (notify) toast('已保存', 'success');
    return;
  }

  setSaveState('SAVING', '');
  for (const section of sections) {
    try {
      await saveSection(section);
    } catch (err) {
      setSaveState('SAVE FAILED', 'error');
      toast(err.message, 'error');
      return;
    }
  }

  if (state.dirty.size) {
    setSaveState('UNSAVED', 'warn');
  } else {
    setSaveState('SAVED', 'ok');
    if (notify) toast('已保存', 'success');
  }
}

async function flushSave() {
  clearTimeout(state.saveTimer);
  if (state.dirty.size) await saveAll();
}

function updateBookSummary(bookId) {
  const current = state.current;
  if (!current || current.meta.id !== bookId) return;

  const entry = state.books.find((book) => book.id === bookId);
  if (!entry) return;

  entry.title = current.meta.title;
  entry.theme = current.meta.theme;
  entry.words = current.stats.words;
  entry.chapters = current.stats.chapters;
  entry.updatedAt = new Date().toISOString();

  if (state.view === 'library') renderLibrary();
}

/* ---------- selection ---------- */
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

function checkSelection() {
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

function hideSelection() {
  const note = $('#selection-note');
  const had = Boolean(state.selectionText || state.selectionContext) || Boolean(note && !note.hidden);
  state.selectionText = '';
  state.selectionContext = null;
  if (note && !note.hidden) note.hidden = true;
  if (had) updateAiControls();
}

/* ---------- agent settings ---------- */
/* ---------- agent ---------- */
function renderAgent({ reset = false } = {}) {
  const book = state.current;
  if (!book) return;

  const bookChanged = state.aiBookId !== book.meta.id;
  if (reset || bookChanged) {
    state.aiBookId = book.meta.id;
    state.aiProposal = null;
    aiLog('SYS', `BOOK / ${book.meta.title || '—'}`);
    aiLog('SYS', `MODE / ${String(book.meta.aiMode || 'diff').toUpperCase()}`);
    loadPendingProposals(book.meta.id);
  }

  state.aiMode = book.meta.aiMode || 'diff';
  $$('#ai-mode button').forEach((button) => {
    button.classList.toggle('on', button.dataset.aiMode === state.aiMode);
  });
  const model = $('#ai-model-label');
  if (model) model.textContent = book.meta.model || '—';

  if (!book.meta.aiEnabled) setAiState('READ ONLY', '');
  else if (!state.aiRunning && !state.aiProposal && (reset || bookChanged)) setAiState('STANDBY', '');

  updateAiControls();
  ensureModelCatalog().then(() => {
    if (state.current?.meta.id === book.meta.id) renderAgentSettings();
  });
  updateReviewBar();
}

async function setAiMode(mode) {
  if (!['auto', 'diff'].includes(mode) || state.aiRunning) return;
  const book = state.current;
  if (!book || !book.meta.aiEnabled || book.meta.aiMode === mode) return;

  book.meta.aiMode = mode;
  state.aiMode = mode;
  $$('#ai-mode button').forEach((button) => {
    button.classList.toggle('on', button.dataset.aiMode === mode);
  });
  const wsStatus = $('#ws-status');
  if (wsStatus) wsStatus.textContent = `AI ${mode.toUpperCase()}`;
  aiLog('SYS', `MODE / ${mode.toUpperCase()}`);
  updateAiControls();

  await queueMetaPatch({ aiMode: mode });
}

async function loadPendingProposals(bookId) {
  try {
    const data = await api(`/books/${encodeURIComponent(bookId)}/proposals?status=pending`);
    if (state.current?.meta.id !== bookId) return;
    const proposals = Array.isArray(data.proposals) ? data.proposals : [];
    if (!proposals.length) {
      if (state.aiReview?.status === 'proposal' && !state.aiRunning) {
        clearReview();
      }
      return;
    }

    const proposal = proposals[0];
    if (state.aiProposal?.id === proposal.id) return;
    aiLog('SYS', proposals.length > 1 ? `待确认提案 ${proposals.length} 个` : '待确认提案');
    openProposalReview(proposal);
    if (proposals.length > 1) toast(`还有 ${proposals.length - 1} 个待确认提案`, 'info');
  } catch (err) {
    toast(`读取提案失败：${err.message}`, 'error');
  }
}

function toolProgressLabel(name) {
  return {
    read_manuscript: '读取正文…',
    read_chapter: '读取章节…',
    read_summary: '读取摘要…',
    list_chapters: '查看章节…',
    research: '检索资料…',
    read_outline: '读取大纲…',
    read_notes: '读取设定…',
    edit_manuscript: '应用修改…',
    edit_outline: '修改大纲…',
    finish: '收尾…',
  }[name] || '处理中…';
}

function handleAiEvent(type, payload = {}) {
  if (type === 'delta') {
    const review = state.aiReview;
    if (review && review.status === 'streaming' && review.action === 'chapter') {
      review.draft += payload.text || '';
      scheduleDraftRender();
    }
    return;
  }

  if (type === 'meta') {
    const settings = [
      payload.maxTokens ? `${payload.maxTokens} tok` : '',
      payload.maxSteps ? `${payload.maxSteps} 轮` : '',
      payload.reasoningEffort ? `think ${payload.reasoningEffort}` : '',
    ].filter(Boolean).join(' · ');
    aiLog('SYS', `${String(payload.mode || '').toUpperCase()} / ${String(payload.action || '').toUpperCase()} / ${payload.model || '—'}${settings ? ` · ${settings}` : ''}`);
    if (payload.plotDropped > 0) {
      aiLog('WARN', `${payload.plotDropped} 条候选已经对不上正文，被丢弃`, 'warn');
      toast(`${payload.plotDropped} 条候选对不上正文，已丢弃`, 'warn');
    }
    setAiState('RUNNING', 'running');
    return;
  }

  if (type === 'research') {
    const question = payload.question ? String(payload.question) : '';
    if (payload.phase === 'start') {
      aiLog('RESEARCH', question || '检索');
    } else if (payload.phase === 'end') {
      const warnings = Array.isArray(payload.warnings) && payload.warnings.length
        ? ` · ${payload.warnings.length} 条引文被丢弃`
        : '';
      aiLog('RESEARCH', `${payload.rounds || 0} 轮 / ${payload.quotes || 0} 条引文${warnings}`, warnings ? 'warn' : 'ok');
    } else {
      aiLog('RESEARCH', payload.message || '检索失败', 'warn');
    }
    return;
  }

  if (type === 'preview') {
    if (payload.op) applyPreviewOp(payload.op);
    return;
  }

  if (type === 'tool') {
    const review = state.aiReview;
    if (review && review.status === 'streaming') {
      if (payload.phase === 'start') {
        if (review.action === 'chapter' && review.draft) {
          review.draft = '';
          scheduleDraftRender();
        }
        review.progress = toolProgressLabel(payload.name);
      } else {
        review.progress = '';
      }
      updateReviewBar();
    }
    if (payload.phase === 'start') {
      aiLog('TOOL', `${payload.name || 'tool'} ${compactValue(payload.args)}`);
    } else if (payload.phase === 'end') {
      aiLog('TOOL', `${payload.name || 'tool'} ✓ ${compactValue(payload.result)}`);
    } else if (payload.phase === 'error') {
      toast(`${payload.name || '工具'}：${payload.message || '失败'}`, 'error');
    }
    return;
  }

  if (type === 'written') {
    const changed = Array.isArray(payload.changed) ? payload.changed.join(' + ') : '正文';
    aiLog('OK', `写入 ${changed}`, 'ok');
    return;
  }

  if (type === 'proposal') {
    if (payload.proposal) {
      aiLog('SYS', `提案待确认 / ${payload.proposal.id || ''}`);
      openProposalReview(payload.proposal);
    }
    return;
  }

  if (type === 'warning') {
    aiLog('WARN', payload.message || '警告', 'warn');
    toast(payload.message || '警告', 'warn');
    return;
  }

  if (type === 'notice') {
    aiLog('SYS', payload.message || '', 'ok');
    return;
  }

  if (type === 'error') {
    setAiState('ERROR', 'error');
    toast(payload.message || 'AI 运行失败', 'error');
    if (payload.detail) aiLog('DETAIL', payload.detail, 'err');
    if (!state.aiProposal) clearReview();
    return;
  }

  if (type === 'done') {
    aiLog('SYS', payload.ok ? 'DONE' : 'FAILED');
    return;
  }
}

async function runAi({ action = 'chapter', useSelection = false, plotItems = [], instruction: presetInstruction = '' } = {}) {
  const book = state.current;
  if (!book) return;
  if (!book.meta.aiEnabled) {
    toast('这本书没有开启 AI', 'error');
    return;
  }
  if (state.aiRunning) return;
  if (state.aiProposal?.status === 'pending') {
    toast('先处理当前提案', 'error');
    return;
  }

  let instruction = String(presetInstruction || $('#ai-instruction')?.value || '').trim().slice(0, 8000);
  if (action === 'chapter') instruction = instruction || '写下一章，承接前文。';
  if (action === 'revise') {
    instruction = instruction || (useSelection
      ? '改写选中的文字，保持原意和文风。'
      : '按指令改写正文，保持人物、设定和文风一致。');
  }
  if (action === 'plot' && !instruction) {
    toast('先写审查要求', 'error');
    return;
  }

  const context = state.selectionContext;
  const selection = useSelection
    ? (state.selectionText && context
      ? {
        text: state.selectionText.slice(0, 8000),
        before: String(context.before || '').slice(-1000),
        after: String(context.after || '').slice(0, 1000),
        chapter: String(context.chapter || '').slice(0, 200),
        truncated: Boolean(context.truncated),
      }
      : (state.selectionText ? { text: state.selectionText.slice(0, 8000) } : null))
    : null;
  if (useSelection && !selection) {
    toast('先在正文里选中一段', 'error');
    return;
  }

  await flushSave();
  if (state.dirty.size) {
    toast('正文还没保存成功，先处理保存错误', 'error');
    return;
  }

  await state.aiSettingsSave;
  if (state.aiSettingsError) {
    toast('运行设置还没保存成功，稍后重试', 'error');
    return;
  }

  const bookId = book.meta.id;
  const mode = state.aiMode || book.meta.aiMode || 'diff';
  const model = book.meta.model || '';
  const controller = new AbortController();
  let written = false;
  let hadError = false;
  let noticedNoChange = false;

  state.aiRunning = true;
  state.aiAbort = controller;
  const selectionWords = useSelection ? countWords(selection?.text || '') : 0;
  const preserveSelection = action === 'revise' && useSelection
    ? markPendingSelection()
    : false;
  const pendingQuotes = action === 'plot'
    ? plotItems.map((item) => String(item?.quote || '')).filter(Boolean)
    : (preserveSelection && selection ? [selection.text] : []);
  const livePreview = mode === 'diff' || action === 'chapter' || action === 'revise' || action === 'plot';
  if (livePreview) startReview(action, { selectionWords, preserveSelection, pendingQuotes, mode });
  else clearReview({ render: false });
  if (action === 'plot') markReviewPending({ scroll: true });
  setAiState('RUNNING', 'running');
  updateAiControls();

  try {
    const response = await fetch(`${API}/books/${encodeURIComponent(bookId)}/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode,
        action,
        instruction,
        model,
        selection,
        ...(action === 'plot' ? { plotItems } : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `AI 请求失败 (${response.status})`);
    }

    await streamAiResponse(response, (type, payload) => {
      if (state.current?.meta.id !== bookId) return;
      if (type === 'written') written = true;
      if (type === 'error') hadError = true;
      if (type === 'notice' && /不需要修改/.test(String(payload.message || ''))) {
        noticedNoChange = true;
      }
      handleAiEvent(type, payload);
    });

    if (state.current?.meta.id !== bookId) return;

    if (written) {
      aiLog('OK', '正文已更新，正在刷新', 'ok');
      clearReview({ render: false });
      await refreshBookAfterAi({ scrollEnd: action === 'chapter' });
    }
    if (!state.aiProposal && !hadError) {
      if (state.aiReview) {
        clearReview();
        if (!written && !noticedNoChange) {
          aiLog('SYS', 'AI 没有产生修改');
          toast('AI 没有产生修改', 'info');
        }
      }
      setAiState('DONE', 'done');
    }
  } catch (err) {
    if (err.name === 'AbortError' || controller.signal.aborted) {
      aiLog('SYS', '已停止');
      if (state.current?.meta.id === bookId && !state.aiProposal) clearReview();
      if (state.current?.meta.id === bookId && !state.aiProposal) setAiState('STANDBY', '');
    } else {
      if (state.current?.meta.id === bookId && !state.aiProposal) clearReview();
      setAiState('ERROR', 'error');
      toast(err.message || 'AI 运行失败', 'error');
    }
  } finally {
    state.aiRunning = false;
    state.aiAbort = null;
    if (state.current?.meta.id === bookId) updateAiControls();
  }
}

function stopAi() {
  if (!state.aiRunning || !state.aiAbort) return;
  aiLog('SYS', '停止中…');
  state.aiAbort.abort();
}

function buildReviewDecisions() {
  const review = state.aiReview;
  if (!review || review.overlap) return null;

  const edits = [];
  for (const change of reviewChangesSorted(review)) {
    if (!Number.isInteger(change.opIndex)) continue;
    edits.push({
      opIndex: change.opIndex,
      accepted: change.accepted !== false,
      newString: change.edited !== undefined ? change.edited : change.new,
    });
  }
  return edits.length ? { edits } : null;
}

async function respondProposal(action) {
  const proposal = state.aiProposal || state.aiReview?.proposal;
  const book = state.current;
  if (!proposal || !book || proposal.status !== 'pending') return;

  const bookId = book.meta.id;
  $$('#review-bar [data-review-action]').forEach((button) => {
    button.disabled = true;
  });

  try {
    const result = await api(
      `/books/${encodeURIComponent(bookId)}/proposals/${encodeURIComponent(proposal.id)}/${action}`,
      { method: 'POST', body: action === 'accept' ? (buildReviewDecisions() || {}) : {} },
    );

    if (action === 'accept') {
      const appended = Array.isArray(result.appended) ? result.appended : [];
      if (appended.length) markSummaryPending(bookId, appended);
      aiLog('OK', '提案已写入', 'ok');
      toast('已写入正文', 'success');
      const scrollEnd = (proposal.ops || []).some((op) => op.type === 'append_chapter')
        || (Array.isArray(result.changed) && result.changed.includes('manuscript'));
      state.aiReview = null;
      state.aiProposal = null;
      updateReviewBar();
      setAiState('DONE', 'done');
      await refreshBookAfterAi({ scrollEnd });
      if (appended.length) startAppendedSummaries(bookId, appended);
    } else {
      aiLog('SYS', '提案已拒绝');
      toast('已拒绝提案');
      clearReview();
      if (!state.aiRunning) setAiState('STANDBY', '');
    }

    await loadPendingProposals(bookId);
  } catch (err) {
    toast(err.message || '提案处理失败', 'error');
    updateReviewBar();
  }
}

function markSummaryPending(bookId, chapters) {
  const pending = state.summaryPending.get(bookId) || new Set();
  for (const chapter of chapters) {
    if (Number.isInteger(chapter?.index)) pending.add(chapter.index);
  }
  if (!pending.size) return;
  state.summaryPending.set(bookId, pending);
  if (state.current?.meta.id === bookId) renderAgentSettings();
}

function startAppendedSummaries(bookId, chapters) {
  Promise.all(chapters.map((chapter) => generateSummaryForChapter(bookId, chapter)))
    .catch(() => {});
}

async function generateSummaryForChapter(bookId, chapter) {
  if (!Number.isInteger(chapter?.index)) return;
  if (state.current?.meta.id === bookId) {
    aiLog('SUMMARY', `第 ${chapter.index} 章摘要生成中…`);
  }

  try {
    const { summary } = await api(`/books/${encodeURIComponent(bookId)}/summaries/generate`, {
      method: 'POST',
      body: { index: chapter.index },
    });

    if (state.current?.meta.id === bookId) {
      updateSummaryEntry({
        index: chapter.index,
        title: summary.title || chapter.title || '',
        summary: summary.summary || '',
        tags: summary.tags || {},
        source: summary.source || 'ai',
        at: summary.at || '',
      });
      aiLog('OK', `第 ${chapter.index} 章摘要已生成`, 'ok');
    }
  } catch (err) {
    if (state.current?.meta.id === bookId) {
      aiLog('WARN', `第 ${chapter.index} 章摘要失败：${err.message}`, 'warn');
      toast(`第 ${chapter.index} 章摘要生成失败：${err.message || '未知错误'}`, 'error', 5000);
    }
  } finally {
    const pending = state.summaryPending.get(bookId);
    if (pending) {
      pending.delete(chapter.index);
      if (!pending.size) state.summaryPending.delete(bookId);
    }
    if (state.current?.meta.id === bookId) renderAgentSettings();
  }
}

async function refreshBookAfterAi({ scrollEnd = false } = {}) {
  const book = state.current;
  if (!book) return;

  const bookId = book.meta.id;
  const mode = state.manuscriptMode;
  const tab = $('#briefing-tabs button.on')?.dataset.tab || 'theme';
  const scroll = $('.manuscript')?.scrollTop || 0;

  try {
    const { book: next } = await api(`/books/${encodeURIComponent(bookId)}`);
    if (state.current?.meta.id !== bookId) return;
    state.current = next;
    state.dirty.clear();

    if (state.view === 'workspace') {
      renderWorkspace();
      activateTab(tab);
      if (mode === 'edit') setManuscriptMode('edit');
      requestAnimationFrame(() => {
        const manuscript = $('.manuscript');
        if (manuscript) manuscript.scrollTop = scrollEnd ? manuscript.scrollHeight : scroll;
        if (scrollEnd && state.manuscriptMode === 'edit') {
          const editor = $('#manuscript-editor');
          if (editor) editor.scrollTop = editor.scrollHeight;
        }
      });
    }

    updateBookSummary(bookId);
  } catch (err) {
    toast(`刷新失败：${err.message}`, 'error');
  }
}

/* ---------- dialogs ---------- */
function setDialogUsage(usage) {
  state.dialogUsage = usage;
  $$('#book-usage button').forEach((button) => {
    button.classList.toggle('on', button.dataset.usage === usage);
  });

  const hints = {
    continue: '导入的 md 会成为正文，AI 可以从后面继续写。',
    reference: '内容会放进笔记，作为设定和文风参考，不进入正文。',
    read: '只把 md 放进书架阅读，不开启 AI。',
  };
  $('#usage-hint').textContent = hints[usage] || '';
}

function openBookDialog({ title = '', content = '', usage = 'continue', hint = '' } = {}) {
  $('#book-title').value = title;
  $('#book-content').value = content;
  $('#file-hint').textContent = hint;
  $('#book-dialog-title').textContent = hint ? '导入作品' : '新建作品';
  $('#book-create').disabled = false;
  $('#book-create').textContent = '创建 / 导入';
  $('#open-after-create').checked = true;
  setDialogUsage(usage);

  const dialog = $('#book-dialog');
  if (!dialog.open) dialog.showModal();
  setTimeout(() => $('#book-title').focus(), 30);
}

async function createBookFromDialog() {
  if (state.creating) return;

  const content = $('#book-content').value;
  let title = $('#book-title').value.trim();
  if (!title) title = deriveTitleFromContent(content) || '未命名作品';
  const openAfterCreate = $('#open-after-create').checked;

  state.creating = true;
  const button = $('#book-create');
  button.disabled = true;
  button.textContent = '创建中…';

  try {
    const { book } = await api('/books', {
      method: 'POST',
      body: { title, content, usage: state.dialogUsage },
    });
    $('#book-dialog').close();
    toast('已创建', 'success');
    await loadBooks();
    if (openAfterCreate) {
      location.hash = `#/book/${book.meta.id}`;
    } else {
      location.hash = '#/library';
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    state.creating = false;
    button.disabled = false;
    button.textContent = '创建 / 导入';
  }
}

const BRIEFING_LABELS = {
  theme: '主题 / THEME',
  outline: '大纲 / OUTLINE',
  notes: '笔记 / NOTES',
};

function openBriefingEditor(section) {
  const book = state.current;
  if (!book) return;

  if (!BRIEFING_LABELS[section]) {
    section = $('#briefing-tabs button.on')?.dataset.tab || 'theme';
  }
  const value = section === 'theme' ? (book.meta.theme || '') : (book[section] || '');

  state.briefingSection = section;
  state.briefingBookId = book.meta.id;

  $('#briefing-dialog-title').textContent = BRIEFING_LABELS[section] || section;
  const textarea = $('#briefing-dialog-text');
  textarea.value = value;
  textarea.dataset.section = section;

  const dialog = $('#briefing-dialog');
  if (!dialog.open) dialog.showModal();
  setTimeout(() => {
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, 30);
}

function syncBriefingDialog() {
  const section = state.briefingSection;
  const book = state.current;
  if (!section || !book || book.meta.id !== state.briefingBookId) return;

  const value = $('#briefing-dialog-text').value;
  const inline = section === 'theme'
    ? $('#theme-editor')
    : section === 'outline'
      ? $('#outline-editor')
      : $('#notes-editor');
  if (inline) inline.value = value;

  if (section === 'theme') book.meta.theme = value;
  else book[section] = value;

  markDirty(section);
}

function flushBriefingDialog() {
  if (!state.briefingSection) return;
  saveAll().catch(() => {});
}

/* ---------- summaries ---------- */
function updateSummaryHint(text) {
  const hint = $('#summary-hint');
  if (hint) hint.textContent = text;
}

function normalizeSummaryTags(tags) {
  const out = {};
  for (const key of Object.keys(SUMMARY_TAG_LABELS)) {
    const list = Array.isArray(tags?.[key]) ? tags[key] : [];
    out[key] = [...new Set(list.map((item) => String(item).trim()).filter(Boolean))];
  }
  return out;
}

function summaryTagHtml(tags, chapterIndex, disabled = false) {
  const chips = [];
  for (const [key, label] of Object.entries(SUMMARY_TAG_LABELS)) {
    const list = Array.isArray(tags?.[key]) ? tags[key] : [];
    list.forEach((item, index) => {
      if (!item) return;
      if (disabled) {
        chips.push(`<span class="summary-tag is-static"><b>${escapeHtml(label)}</b>${escapeHtml(item)}</span>`);
        return;
      }
      chips.push(`<span class="summary-tag" data-tag-key="${key}" data-tag-index="${index}" data-tag-chapter="${chapterIndex}"><b>${escapeHtml(label)}</b><span class="summary-tag-text" role="button" tabindex="0" title="点击修改">${escapeHtml(item)}</span><button class="summary-tag-del" type="button" title="删除" aria-label="删除标签">×</button></span>`);
    });
  }
  return chips.length ? `<div class="summary-tags">${chips.join('')}</div>` : '';
}

function summaryTagChapter(element) {
  const index = Number(element?.closest('.summary-tag')?.dataset.tagChapter);
  if (!Number.isInteger(index)) return null;
  return state.summaryChapters.find((chapter) => chapter.index === index) || null;
}

function startSummaryTagEdit(span) {
  if (!span || state.summaryBusy || span.isContentEditable) return;
  span.dataset.original = span.textContent;
  span.setAttribute('contenteditable', 'plaintext-only');
  span.classList.add('is-editing');
  span.focus();
  const range = document.createRange();
  range.selectNodeContents(span);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function commitSummaryTagEdit(span, { cancel = false } = {}) {
  if (!span?.isContentEditable) return;
  const original = span.dataset.original || '';
  const chapter = summaryTagChapter(span);
  const chip = span.closest('.summary-tag');
  const key = chip?.dataset.tagKey;
  const tagIndex = Number(chip?.dataset.tagIndex);

  span.removeAttribute('contenteditable');
  span.classList.remove('is-editing');
  delete span.dataset.original;

  if (cancel) {
    span.textContent = original;
    return;
  }

  const value = span.textContent.replace(/\s+/g, ' ').trim();
  span.textContent = value || original;
  if (!chapter || !key || !Number.isInteger(tagIndex) || value === original) return;

  const list = Array.isArray(chapter.tags?.[key]) ? [...chapter.tags[key]] : [];
  if (!value) list.splice(tagIndex, 1);
  else list[tagIndex] = value;
  const before = Array.isArray(chapter.tags?.[key]) ? chapter.tags[key].length : 0;
  chapter.tags = { ...chapter.tags, [key]: [...new Set(list.map((item) => String(item).trim()).filter(Boolean))] };
  const after = chapter.tags[key].length;

  scheduleSummarySave(chapter.index);
  span.textContent = value;
  if (!value || after !== before) {
    const listEl = $('#summary-list');
    const scrollTop = listEl?.scrollTop || 0;
    renderSummaryList();
    if (listEl) listEl.scrollTop = scrollTop;
  }
}

function deleteSummaryTag(chapter, key, tagIndex) {
  if (!chapter || state.summaryBusy) return;
  const list = Array.isArray(chapter.tags?.[key]) ? [...chapter.tags[key]] : [];
  if (!Number.isInteger(tagIndex) || tagIndex < 0 || tagIndex >= list.length) return;
  list.splice(tagIndex, 1);
  chapter.tags = { ...chapter.tags, [key]: list };
  scheduleSummarySave(chapter.index);

  const listEl = $('#summary-list');
  const scrollTop = listEl?.scrollTop || 0;
  renderSummaryList();
  if (listEl) listEl.scrollTop = scrollTop;
}

function updateSummaryEntry(chapter) {
  const book = state.current;
  if (!book) return;
  if (!Array.isArray(book.summaries)) book.summaries = [];
  const entry = {
    index: chapter.index,
    title: chapter.title,
    summary: chapter.summary,
    tags: chapter.tags || {},
    source: chapter.source || 'ai',
    at: chapter.at || '',
  };
  const at = book.summaries.findIndex((item) => item?.index === chapter.index);
  if (at >= 0) book.summaries[at] = { ...book.summaries[at], ...entry };
  else book.summaries.push(entry);
  renderAgentSettings();
}

function renderSummaryList() {
  const list = $('#summary-list');
  const book = state.current;
  if (!list || !book) return;

  const chapters = state.summaryChapters;
  const busy = state.summaryBusy;
  const enabled = Boolean(book.meta.aiEnabled);
  const html = [];

  if (!chapters.length) {
    html.push('<div class="model-empty">正文还没有章节</div>');
  }

  for (const chapter of chapters) {
    const missing = !chapter.hasSummary || !String(chapter.summary || '').trim();
    const badges = [];
    if (missing) {
      badges.push('<span class="summary-badge missing">缺失</span>');
    } else {
      if (chapter.stale) badges.push('<span class="summary-badge stale">可能过期</span>');
      badges.push(`<span class="summary-badge ${chapter.source === 'user' ? 'user' : ''}">${chapter.source === 'user' ? '用户' : 'AI'}</span>`);
    }

    const empty = !chapter.chars;
    const disabled = busy || empty || !enabled;
    html.push(`<div class="summary-item" data-summary-item="${chapter.index}">
      <div class="summary-head">
        <span class="summary-no">CH ${pad2(chapter.index)}</span>
        <span class="summary-title">${escapeHtml(chapter.title)}</span>
        <span class="summary-badges">${badges.join('')}<span>${formatNumber(chapter.chars)} 字</span></span>
      </div>
      <textarea class="textarea summary-text" rows="3" data-summary-index="${chapter.index}" ${disabled ? 'disabled' : ''} placeholder="${empty ? '这一章还没有正文' : '还没有摘要'}">${escapeHtml(chapter.summary || '')}</textarea>
      ${summaryTagHtml(chapter.tags, chapter.index, disabled)}
      <div class="summary-item-actions">
        <button class="text-btn" type="button" data-summary-regenerate="${chapter.index}" ${disabled ? 'disabled' : ''}>重新生成</button>
      </div>
    </div>`);
  }

  if (state.summaryOrphans.length) {
    const orphans = state.summaryOrphans.map((item) => `<div class="summary-orphan">
      <div class="summary-head">
        <span class="summary-title">${escapeHtml(item.title || '未命名')}</span>
        <span class="summary-badges"><span class="summary-badge">未匹配</span></span>
      </div>
      <p>${escapeHtml(item.summary || '')}</p>
    </div>`).join('');
    html.push(`<div class="summary-orphans"><div class="summary-orphan-head">未匹配的旧摘要</div>${orphans}</div>`);
  }

  list.innerHTML = html.join('');

  const generate = $('#summary-generate-missing');
  if (generate) generate.disabled = busy || !enabled;
  const stop = $('#summary-stop');
  if (stop) stop.hidden = !busy;
}

async function loadSummaries() {
  const book = state.current;
  if (!book) return;
  const bookId = book.meta.id;
  state.summaryBookId = bookId;

  const list = $('#summary-list');
  if (list) list.innerHTML = '<div class="model-empty">读取章节…</div>';

  try {
    const data = await api(`/books/${encodeURIComponent(bookId)}/chapters`);
    if (state.summaryBookId !== bookId) return;

    state.summaryChapters = (Array.isArray(data.chapters) ? data.chapters : []).map((item) => ({
      ...item,
      summary: String(item.summary || ''),
      tags: item.tags || {},
    }));
    state.summaryOrphans = Array.isArray(data.orphans) ? data.orphans : [];
    state.summaryUpdatedAt = String(data.updatedAt || '');

    const missing = state.summaryChapters.filter((chapter) => chapter.chars > 0
      && (!chapter.hasSummary || !String(chapter.summary || '').trim())).length;
    updateSummaryHint(missing
      ? `${missing} 章还没有摘要。改过的摘要会标成用户。`
      : '每章都有摘要。改过的摘要会标成用户。');
    renderSummaryList();
  } catch (err) {
    if (list) list.innerHTML = `<div class="model-empty">${escapeHtml(err.message || '读取章节失败')}</div>`;
    toast(err.message || '读取章节失败', 'error');
  }
}

function openSummaryDialog() {
  const book = state.current;
  if (!book) return;
  const pending = state.summaryPending.get(book.meta.id);
  if (pending?.size) {
    toast('摘要生成中，稍等', 'info');
    return;
  }
  const dialog = $('#summary-dialog');
  if (!dialog) return;

  state.summaryStop = false;
  for (const timer of state.summaryTimers.values()) clearTimeout(timer);
  state.summaryTimers.clear();

  if (!dialog.open) dialog.showModal();
  updateSummaryHint('读取章节…');
  loadSummaries();
}

const TERM_SCOPE_LABELS = {
  manuscript: '正文',
  outline: '大纲',
  notes: '笔记',
  theme: '主题',
  summary: '摘要',
  summaryTitle: '摘要标题',
  tags: '标签',
};

function selectedTermScopes() {
  return $$('#terms-scopes [data-term-scope]')
    .filter((input) => input.checked)
    .map((input) => input.dataset.termScope);
}

function renderSavedTerms() {
  const box = $('#terms-saved');
  if (!box) return;
  const terms = Array.isArray(state.current?.meta?.terms) ? state.current.meta.terms : [];
  if (!terms.length) {
    box.innerHTML = '<span class="terms-saved-empty">还没有规则</span>';
    return;
  }
  box.innerHTML = terms.map((term, index) => `<span class="terms-saved-item"><b>${escapeHtml(term.from)}</b> → ${term.to ? escapeHtml(term.to) : '删除'}<button type="button" data-term-remove="${index}" title="删除规则" aria-label="删除规则">×</button></span>`).join('');
}

function openTermsDialog() {
  const book = state.current;
  const dialog = $('#terms-dialog');
  if (!book || !dialog) return;
  if (state.aiRunning || state.aiProposal?.status === 'pending') {
    toast('等 AI 处理完再用词替换', 'error');
    return;
  }
  if (state.summaryBusy) {
    toast('摘要任务还没结束，等它完成再用词替换', 'error');
    return;
  }

  state.termsBookId = book.meta.id;
  const find = $('#terms-find');
  const replace = $('#terms-replace');
  const result = $('#terms-result');
  if (find) find.value = '';
  if (replace) replace.value = '';
  if (result) result.innerHTML = '';
  $$('#terms-scopes [data-term-scope]').forEach((input) => { input.checked = true; });
  const save = $('#terms-save');
  if (save) save.checked = true;
  renderSavedTerms();
  if (!dialog.open) dialog.showModal();
  find?.focus();
}

function renderTermResult(result) {
  const box = $('#terms-result');
  if (!box) return;
  if (!result?.total) {
    box.innerHTML = '<div class="term-empty">没有命中。</div>';
    return;
  }

  const lines = [`<div class="term-total">共 ${formatNumber(result.total)} 处</div>`];
  for (const [key, count] of Object.entries(result.counts || {})) {
    lines.push(`<div><span class="term-scope">${escapeHtml(TERM_SCOPE_LABELS[key] || key)}</span> ${formatNumber(count)} 处</div>`);
    for (const sample of result.samples?.[key] || []) {
      lines.push(`<div class="term-sample">${escapeHtml(sample)}</div>`);
    }
  }
  box.innerHTML = lines.join('');
}

async function previewTermClean() {
  const book = state.current;
  if (!book) return null;

  const find = String($('#terms-find')?.value || '').trim();
  const replace = String($('#terms-replace')?.value || '');
  const scopes = selectedTermScopes();
  if (!find) {
    toast('先填要查找的词', 'error');
    return null;
  }
  if (!scopes.length) {
    toast('至少选一个范围', 'error');
    return null;
  }

  const result = await api(`/books/${encodeURIComponent(book.meta.id)}/terms/preview`, {
    method: 'POST',
    body: { find, replace, scopes },
  });
  renderTermResult(result);
  return result;
}

async function applyTermClean() {
  const book = state.current;
  if (!book) return;
  if (state.aiRunning || state.aiProposal?.status === 'pending' || state.summaryBusy) {
    toast('还有任务在跑，等它结束再替换', 'error');
    return;
  }

  let preview;
  try {
    preview = await previewTermClean();
  } catch (err) {
    toast(err.message || '预览失败', 'error');
    return;
  }
  if (!preview) return;

  const saveTerm = Boolean($('#terms-save')?.checked);
  if (!preview.total && !saveTerm) {
    toast('没有命中', 'info');
    return;
  }
  if (preview.total > 100 && !window.confirm(`会改动 ${preview.total} 处，确定继续？`)) return;

  try {
    const result = await api(`/books/${encodeURIComponent(book.meta.id)}/terms/apply`, {
      method: 'POST',
      body: {
        find: preview.find,
        replace: preview.replace,
        scopes: preview.scopes,
        saveTerm,
      },
    });
    renderTermResult(result);
    toast(result.total ? `已替换 ${result.total} 处` : '已保存用词规则', 'success');
    await refreshBookAfterAi({ scrollEnd: false });
    renderSavedTerms();
  } catch (err) {
    toast(err.message || '替换失败', 'error');
  }
}

async function removeSavedTerm(index) {
  const book = state.current;
  if (!book) return;
  const terms = (Array.isArray(book.meta.terms) ? book.meta.terms : [])
    .filter((_, at) => at !== index);

  try {
    const { meta } = await api(`/books/${encodeURIComponent(book.meta.id)}/meta`, {
      method: 'PUT',
      body: { terms },
    });
    if (state.current?.meta.id === book.meta.id) state.current.meta = meta;
    renderSavedTerms();
    toast('已删除用词规则', 'success');
  } catch (err) {
    toast(err.message || '删除规则失败', 'error');
  }
}

function updateAuditRewriteState() {
  const checked = $$('#audit-list [data-audit-index]').filter((input) => input.checked).length;
  setDisabled($('#audit-rewrite'), !checked || Boolean(state.auditAbort));
}

function renderAuditIssues() {
  const list = $('#audit-list');
  if (!list) return;

  if (!state.auditIssues.length) {
    list.innerHTML = '<div class="audit-empty">没找到需要改的段落。</div>';
    updateAuditRewriteState();
    return;
  }

  list.innerHTML = state.auditIssues.map((issue, index) => {
    const head = issue.chapterIndex
      ? `CH ${pad2(issue.chapterIndex)}${issue.chapterTitle ? ` · ${escapeHtml(issue.chapterTitle)}` : ''}`
      : escapeHtml(issue.chapterTitle || '前言');
    return `<label class="audit-item"><input type="checkbox" data-audit-index="${index}" checked><div class="audit-main"><div class="audit-head">${head}</div><div class="audit-quote">${escapeHtml(issue.text)}</div><div class="audit-reason">${escapeHtml(issue.reason)}</div><details class="audit-context"><summary>上下文${issue.truncated ? '（已截断）' : ''}</summary><pre>${escapeHtml(issue.context || '')}</pre></details></div></label>`;
  }).join('');
  updateAuditRewriteState();
}

function openAuditDialog() {
  const book = state.current;
  const dialog = $('#audit-dialog');
  if (!book || !dialog) return;
  if (state.aiRunning || state.aiProposal?.status === 'pending') {
    toast('等 AI 处理完再审查', 'error');
    return;
  }

  state.auditAbort?.abort();
  state.auditAbort = null;
  state.auditBookId = book.meta.id;
  state.auditIssues = [];
  state.auditQuery = '';

  const query = $('#audit-query');
  if (query) query.value = '';
  const list = $('#audit-list');
  if (list) list.innerHTML = '';
  const hint = $('#audit-hint');
  if (hint) hint.textContent = '先写审查要求，再扫描。审查会按块扫描全书，只读，不改正文。';
  setHidden($('#audit-stop'), true);
  setDisabled($('#audit-scan'), false);
  updateAuditRewriteState();

  if (!dialog.open) dialog.showModal();
  query?.focus();
}

async function scanPlotIssues() {
  const book = state.current;
  if (!book || state.auditBookId !== book.meta.id) return;

  const query = String($('#audit-query')?.value || '').trim();
  if (!query) {
    toast('先写审查要求', 'error');
    return;
  }

  state.auditAbort?.abort();
  const controller = new AbortController();
  state.auditAbort = controller;
  state.auditQuery = query;
  state.auditIssues = [];
  const list = $('#audit-list');
  if (list) list.innerHTML = '<div class="audit-empty">扫描中…</div>';
  updateAuditRewriteState();

  const hint = $('#audit-hint');
  if (hint) hint.textContent = '扫描中…按块并发，最多约 3 分钟，点停止可以中断。';
  setHidden($('#audit-stop'), false);
  setDisabled($('#audit-scan'), true);
  updateAuditRewriteState();

  try {
    const response = await fetch(`${API}/books/${encodeURIComponent(book.meta.id)}/audit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `审查失败 (${response.status})`);
    if (state.auditBookId !== book.meta.id) return;

    state.auditIssues = Array.isArray(data.issues) ? data.issues : [];
    renderAuditIssues();
    if (hint) {
      const warnings = Array.isArray(data.warnings) ? data.warnings : [];
      const failedChunks = Number(data.failedChunks) || 0;
      const dropped = Math.max(0, warnings.length - failedChunks);
      const chunks = Number(data.chunks) || 0;
      const scanned = Number(data.scanned) || 0;
      const parts = [];
      if (state.auditIssues.length) parts.push(`找到 ${state.auditIssues.length} 条候选`);
      if (data.timedOut) parts.push(`审查超时，已扫 ${scanned}/${chunks} 块，结果可能不全`);
      if (failedChunks) parts.push(`${failedChunks} 块审查失败`);
      if (dropped) parts.push(`${dropped} 条引文被丢弃`);
      hint.textContent = parts.length
        ? `${parts.join('；')}。${state.auditIssues.length ? '勾选后改写。' : ''}`
        : '没找到需要改的段落。';
    }
  } catch (err) {
    if (err.name === 'AbortError' || controller.signal.aborted) {
      if (hint) hint.textContent = '已停止。';
      return;
    }
    if (hint) hint.textContent = err.message || '审查失败';
    toast(err.message || '审查失败', 'error');
  } finally {
    if (state.auditAbort === controller) state.auditAbort = null;
    setHidden($('#audit-stop'), true);
    setDisabled($('#audit-scan'), false);
    updateAuditRewriteState();
  }
}

function stopAuditScan() {
  if (!state.auditAbort) return;
  const hint = $('#audit-hint');
  if (hint) hint.textContent = '停止中…';
  state.auditAbort.abort();
}

function selectedAuditItems() {
  return $$('#audit-list [data-audit-index]')
    .filter((input) => input.checked)
    .map((input) => state.auditIssues[Number(input.dataset.auditIndex)])
    .filter(Boolean)
    .map((issue) => ({
      chapterIndex: issue.chapterIndex,
      quote: issue.text,
      reason: issue.reason,
      context: issue.context,
      contextScope: issue.contextScope,
    }));
}

function rewriteAuditItems() {
  const book = state.current;
  if (!book || state.auditBookId !== book.meta.id) return;

  const items = selectedAuditItems();
  if (!items.length) {
    toast('先勾选要改的段落', 'error');
    return;
  }

  const query = state.auditQuery || String($('#audit-query')?.value || '').trim();
  const dialog = $('#audit-dialog');
  if (dialog?.open) dialog.close();
  runAi({ action: 'plot', plotItems: items, instruction: query });
}

function scheduleSummarySave(index) {
  clearTimeout(state.summaryTimers.get(index));
  state.summaryTimers.set(index, setTimeout(() => {
    state.summaryTimers.delete(index);
    saveSummary(index);
  }, 800));
}

async function saveSummary(index) {
  const book = state.current;
  const chapter = state.summaryChapters.find((item) => item.index === index);
  if (!book || !chapter || state.summaryBusy) return;

  const bookId = book.meta.id;
  const value = String(chapter.summary || '').trim();
  if (!value) {
    toast('摘要不能为空，没有保存', 'error');
    return;
  }

  if (state.summarySaving.has(index)) {
    state.summaryDirty.add(index);
    return;
  }

  state.summarySaving.add(index);
  try {
    const { summary } = await api(`/books/${encodeURIComponent(bookId)}/summaries/${index}`, {
      method: 'PUT',
      body: { summary: value, tags: normalizeSummaryTags(chapter.tags) },
    });
    if (state.summaryBookId !== bookId) return;

    const latest = state.summaryChapters.find((item) => item.index === index);
    if (!latest) return;
    latest.tags = summary.tags || latest.tags || {};
    latest.source = 'user';
    latest.at = summary.at || latest.at;
    latest.hasSummary = true;
    updateSummaryEntry(latest);

    const item = document.querySelector(`#summary-list [data-summary-item="${index}"]`);
    const sourceBadge = item?.querySelector('.summary-badge:not(.missing):not(.stale)');
    if (sourceBadge) {
      sourceBadge.textContent = '用户';
      sourceBadge.classList.add('user');
    }

    if (String(latest.summary || '').trim() !== value) {
      state.summaryDirty.add(index);
    }
  } catch (err) {
    toast(err.message || '摘要没保存成功', 'error');
  } finally {
    state.summarySaving.delete(index);
    if (state.summaryDirty.delete(index)) scheduleSummarySave(index);
    renderAgentSettings();
  }
}

async function flushSummaryTimers() {
  const indexes = [...state.summaryTimers.keys()];
  for (const index of indexes) {
    clearTimeout(state.summaryTimers.get(index));
    state.summaryTimers.delete(index);
  }
  await Promise.all(indexes.map((index) => saveSummary(index)));
}

async function regenerateSummary(index, { confirmUser = true, allowBusy = false, silent = false } = {}) {
  const book = state.current;
  const chapter = state.summaryChapters.find((item) => item.index === index);
  if (!book || !chapter) return { ok: false, error: '章节不存在' };
  if (state.summaryBusy && !allowBusy) return { ok: false, error: '正在补齐' };

  if (confirmUser && chapter.source === 'user') {
    const ok = await confirmDialog({
      title: '重新生成摘要',
      text: `第 ${index} 章摘要你手改过，重新生成会覆盖。继续？`,
      okLabel: '重新生成',
    });
    if (!ok) return { ok: false, error: '已取消' };
  }

  try {
    const { summary } = await api(`/books/${encodeURIComponent(book.meta.id)}/summaries/generate`, {
      method: 'POST',
      body: { index },
    });
    if (state.summaryBookId !== book.meta.id) return { ok: false, error: '已切换书籍' };

    Object.assign(chapter, {
      summary: String(summary.summary || ''),
      tags: summary.tags || {},
      source: 'ai',
      at: summary.at || '',
      hasSummary: true,
      stale: false,
    });
    updateSummaryEntry(chapter);
    if (!state.summaryBusy) renderSummaryList();
    return { ok: true };
  } catch (err) {
    if (!silent) toast(err.message || '摘要生成失败', 'error');
    return { ok: false, error: err.message || '摘要生成失败' };
  }
}

async function backfillSummaries() {
  const book = state.current;
  if (!book || state.summaryBusy) return;
  const bookId = book.meta.id;

  await flushSummaryTimers();
  const targets = state.summaryChapters.filter((chapter) => chapter.chars > 0
    && (!chapter.hasSummary || !String(chapter.summary || '').trim())
    && chapter.source !== 'user');

  if (!targets.length) {
    toast('没有缺失的摘要', 'info');
    return;
  }

  state.summaryBusy = true;
  state.summaryStop = false;
  renderSummaryList();

  const poolSize = Math.min(SUMMARY_CONCURRENCY, targets.length);
  updateSummaryHint(`补齐中 0/${targets.length} · 并发 ${poolSize}`);

  let cursor = 0;
  let done = 0;
  let failed = 0;
  let active = 0;
  let firstError = '';

  const worker = async () => {
    for (;;) {
      if (state.summaryStop || state.current?.meta.id !== bookId) return;
      const position = cursor;
      cursor += 1;
      if (position >= targets.length) return;

      const chapter = targets[position];
      active += 1;
      updateSummaryHint(`补齐中 ${done}/${targets.length} · 进行中 ${active}`);

      const result = await regenerateSummary(chapter.index, {
        confirmUser: false,
        allowBusy: true,
        silent: true,
      });

      active -= 1;
      if (result.ok) {
        done += 1;
      } else {
        failed += 1;
        if (!firstError) firstError = result.error || '';
      }
      updateSummaryHint(`补齐中 ${done}/${targets.length} · 进行中 ${active}`);
    }
  };

  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  const stopped = state.summaryStop;
  state.summaryBusy = false;
  state.summaryStop = false;
  if (state.current?.meta.id === bookId) {
    renderSummaryList();
    const suffix = failed ? ` · 失败 ${failed}` : '';
    updateSummaryHint(stopped
      ? `已停止 · 完成 ${done}/${targets.length}${suffix}`
      : `补齐完成 ${done}/${targets.length}${suffix}`);
  }
  if (failed) {
    toast(`有 ${failed} 章摘要没生成成功${firstError ? `：${firstError}` : ''}`, 'warn', 5000);
  }
}

/* ---------- files / delete ---------- */
async function handleFile(file) {
  if (!file) return;
  if (!/\.(md|markdown|txt)$/i.test(file.name)) {
    toast('只支持 .md / .markdown / .txt', 'error');
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    toast('文件太大，上限 20MB', 'error');
    return;
  }

  try {
    const text = await file.text();
    const base = file.name.replace(/\.(md|markdown|txt)$/i, '');
    openBookDialog({
      title: base,
      content: text,
      usage: 'continue',
      hint: `已读取 ${file.name} · ${formatNumber(text.length)} 字符`,
    });
  } catch (err) {
    toast(`读文件失败：${err.message}`, 'error');
  }
}

function triggerFileInput() {
  const input = $('#file-input');
  input.value = '';
  input.click();
}

async function deleteBookById(id, title) {
  const confirmed = await confirmDialog({
    title: '删除这本书？',
    text: `《${title}》和它的历史备份会被一起删掉，不能恢复。`,
    okLabel: '删除',
  });
  if (!confirmed) return;

  try {
    await api(`/books/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast('已删除', 'success');
    state.query = '';
    const searchInput = $('#search-input');
    if (searchInput) searchInput.value = '';
    if (state.current?.meta.id === id) {
      state.current = null;
      state.dirty.clear();
    }
    await loadBooks();
    if (location.hash.startsWith('#/book/')) location.hash = '#/library';
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ---------- load ---------- */
async function loadBooks() {
  try {
    const data = await api('/books');
    state.books = data.books || [];
  } catch (err) {
    state.books = [];
    toast(err.message, 'error');
  }
  renderLibrary();
}

/* ---------- events ---------- */
function wireEvents() {
  $$('[data-accent-btn]').forEach((button) => {
    button.addEventListener('click', () => applyAccent(button.dataset.accentBtn));
  });

  $$('[data-nav]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (button.dataset.nav === 'library') {
        await flushSave();
        location.hash = '#/library';
        return;
      }
      if (!state.current) {
        toast('先从书架选一本书', 'error');
        return;
      }
      await flushSave();
      location.hash = `#/book/${state.current.meta.id}`;
    });
  });

  $('#filters').addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    state.filter = button.dataset.filter;
    $$('#filters button').forEach((item) => {
      item.classList.toggle('on', item.dataset.filter === state.filter);
    });
    renderLibrary();
  });

  $('#search-input').addEventListener('input', onSearchInput);
  initDropdown($('#sort-dropdown'), {
    value: state.sort,
    onChange: (value) => {
      state.sort = value;
      renderLibrary();
    },
  });

  const LOG_LEVELS = ['info', 'warn', 'error'];
  $('#log-level')?.addEventListener('click', () => {
    const index = LOG_LEVELS.indexOf(state.logLevel);
    state.logLevel = LOG_LEVELS[(index + 1) % LOG_LEVELS.length];
    renderLog(true);
  });
  document.addEventListener('click', () => closeDropdowns());
  renderLog(true);
  window.addEventListener('error', (event) => {
    aiLog('ERR', event.message || '页面脚本错误', 'err');
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    aiLog('ERR', String(reason?.message || reason || '未处理的 Promise 错误'), 'err');
  });

  $('#new-book-btn').addEventListener('click', () => openBookDialog());
  $('#import-btn').addEventListener('click', triggerFileInput);
  $('#dropzone').addEventListener('click', triggerFileInput);
  $('#dropzone').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      triggerFileInput();
    }
  });

  $('#file-input').addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) handleFile(file);
    event.target.value = '';
  });

  document.addEventListener('click', (event) => {
    const newButton = event.target.closest('[data-new-book]');
    if (newButton) {
      openBookDialog();
      return;
    }
    const importButton = event.target.closest('[data-import-book]');
    if (importButton) {
      triggerFileInput();
      return;
    }
    const closeButton = event.target.closest('[data-close-dialog]');
    if (closeButton) {
      document.getElementById(closeButton.dataset.closeDialog)?.close();
    }
    if (!event.target.closest('#chapter-nav')) closeChapterMenu();
  });

  $('#book-grid').addEventListener('click', (event) => {
    const card = event.target.closest('.book-card');
    if (!card) return;
    if (event.target.closest('[data-delete]')) {
      deleteBookById(card.dataset.id, card.dataset.title || '这本书');
      return;
    }
    openBookById(card.dataset.id);
  });

  $('#search-results').addEventListener('click', (event) => {
    const hit = event.target.closest('.search-hit');
    if (!hit) return;
    const result = state.results[Number(hit.dataset.i)];
    if (result) openSearchResult(result);
  });

  $('#briefing-tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-tab]');
    if (button) activateTab(button.dataset.tab);
  });

  $('#ms-mode').addEventListener('click', (event) => {
    const button = event.target.closest('[data-ms-mode]');
    if (button) setManuscriptMode(button.dataset.msMode, { preservePosition: true });
  });

  $('#ms-title').addEventListener('click', startTitleEdit);
  $('#ms-title').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      startTitleEdit();
    }
  });
  $('#ms-title-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitTitleEdit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      stopTitleEdit();
    }
  });
  $('#ms-title-input').addEventListener('blur', () => {
    if (state.titleEditing) commitTitleEdit();
  });

  $('#chapter-btn').addEventListener('click', (event) => {
    event.stopPropagation();
    openChapterMenu($('#chapter-menu').hidden);
  });

  $('#chapter-menu').addEventListener('click', (event) => {
    const item = event.target.closest('[data-chapter]');
    if (item) jumpToChapter(Number(item.dataset.chapter));
  });

  $('#prose').addEventListener('input', (event) => {
    const review = state.aiReview;
    if (!review) return;
    const changes = reviewChangesSorted(review);

    const textarea = event.target.closest?.('.ai-new-input');
    if (textarea) {
      const change = changes[Number(textarea.dataset.change)];
      if (!change) return;
      change.edited = textarea.value;
      change.accepted = textarea.value.trim().length > 0;
      growReviewEditor(textarea);
      return;
    }

    const ins = event.target.closest?.('ins.ai-ins[contenteditable]');
    if (ins) {
      const change = changes[Number(ins.dataset.change)];
      if (!change) return;
      const text = ins.textContent || '';
      change.edited = text;
      change.accepted = text.trim().length > 0;
    }
  });

  const manuscriptEl = $('.manuscript');
  let chapterScrollFrame = 0;
  manuscriptEl.addEventListener('scroll', () => {
    if (chapterScrollFrame) return;
    chapterScrollFrame = requestAnimationFrame(() => {
      chapterScrollFrame = 0;
      updateChapterFromScroll();
    });
  }, { passive: true });

  ['click', 'keyup', 'select'].forEach((eventName) => {
    $('#manuscript-editor').addEventListener(eventName, updateChapterFromCursor);
  });
  wireDiffRuler();

  window.addEventListener('resize', () => {
    requestAnimationFrame(() => {
      syncStickyHeight();
      syncEditorHeight();
      updateChapterFromScroll();
    });
  });

  const sticky = $('.ms-sticky');
  if (sticky && typeof ResizeObserver !== 'undefined') {
    state.stickyObserver = new ResizeObserver(() => syncStickyHeight());
    state.stickyObserver.observe(sticky);
  }
  syncStickyHeight();

  $('#save-briefing').addEventListener('click', () => saveAll({ notify: true }));
  $$('.editor-box').forEach((box) => {
    box.addEventListener('mousedown', (event) => {
      const rect = box.getBoundingClientRect();
      if (event.clientX < rect.right - 26 || event.clientY < rect.bottom - 26) return;
      event.preventDefault();
      const section = box.querySelector('.editor')?.id.replace(/-editor$/, '');
      openBriefingEditor(section);
    });
  });
  $('#briefing-dialog-text').addEventListener('input', syncBriefingDialog);
  $('#briefing-dialog').addEventListener('close', flushBriefingDialog);
  $('#ai-model-label')?.addEventListener('click', openModelDialog);
  $('#model-list')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-model]');
    if (button) selectModel(button.dataset.model);
  });

  $('#ai-settings')?.addEventListener('click', (event) => {
    const token = event.target.closest('[data-max-tokens]');
    if (token) {
      setMaxTokens(token.dataset.maxTokens);
      return;
    }
    const step = event.target.closest('[data-max-steps]');
    if (step) {
      setMaxSteps(step.dataset.maxSteps);
      return;
    }
    const reasoning = event.target.closest('[data-reasoning-effort]');
    if (reasoning) {
      setReasoningEffort(reasoning.dataset.reasoningEffort);
      return;
    }
    if (event.target.closest('#ai-summary-count')) openSummaryDialog();
  });

  $('#summary-list')?.addEventListener('input', (event) => {
    const textarea = event.target.closest('[data-summary-index]');
    if (!textarea) return;
    const index = Number(textarea.dataset.summaryIndex);
    const chapter = state.summaryChapters.find((item) => item.index === index);
    if (!chapter) return;
    chapter.summary = textarea.value;
    chapter.hasSummary = Boolean(textarea.value.trim());
    scheduleSummarySave(index);
  });

  $('#summary-list')?.addEventListener('mousedown', (event) => {
    if (event.target.closest('.summary-tag-del')) event.preventDefault();
  });

  $('#summary-list')?.addEventListener('keydown', (event) => {
    const span = event.target.closest('.summary-tag-text');
    if (!span) return;
    if (!span.isContentEditable) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        startSummaryTagEdit(span);
      }
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      span.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      span.dataset.cancel = '1';
      span.blur();
    }
  });

  $('#summary-list')?.addEventListener('focusout', (event) => {
    const span = event.target.closest?.('.summary-tag-text');
    if (!span?.isContentEditable) return;
    const cancel = span.dataset.cancel === '1';
    delete span.dataset.cancel;
    commitSummaryTagEdit(span, { cancel });
  });

  $('#summary-list')?.addEventListener('click', (event) => {
    const del = event.target.closest('.summary-tag-del');
    if (del) {
      const chip = del.closest('.summary-tag');
      const chapter = summaryTagChapter(del);
      deleteSummaryTag(chapter, chip?.dataset.tagKey, Number(chip?.dataset.tagIndex));
      return;
    }

    const tagText = event.target.closest('.summary-tag-text');
    if (tagText) {
      event.preventDefault();
      startSummaryTagEdit(tagText);
      return;
    }

    const button = event.target.closest('[data-summary-regenerate]');
    if (!button) return;
    regenerateSummary(Number(button.dataset.summaryRegenerate));
  });

  $('#summary-generate-missing')?.addEventListener('click', backfillSummaries);
  $('#summary-stop')?.addEventListener('click', () => {
    state.summaryStop = true;
    updateSummaryHint('停止中…等已发出的章节完成');
  });
  $('#summary-dialog')?.addEventListener('close', () => {
    if (state.summaryBusy) state.summaryStop = true;
    flushSummaryTimers().catch(() => {});
  });

  $('#terms-btn')?.addEventListener('click', openTermsDialog);
  $('#terms-preview')?.addEventListener('click', () => {
    previewTermClean().catch((err) => toast(err.message || '预览失败', 'error'));
  });
  $('#terms-apply')?.addEventListener('click', applyTermClean);
  $('#terms-saved')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-term-remove]');
    if (!button) return;
    removeSavedTerm(Number(button.dataset.termRemove));
  });
  $('#terms-dialog')?.addEventListener('close', () => {
    state.termsBookId = '';
  });

  $('#audit-btn')?.addEventListener('click', openAuditDialog);
  $('#audit-scan')?.addEventListener('click', () => {
    scanPlotIssues().catch((err) => toast(err.message || '审查失败', 'error'));
  });
  $('#audit-stop')?.addEventListener('click', stopAuditScan);
  $('#audit-rewrite')?.addEventListener('click', rewriteAuditItems);
  $('#audit-list')?.addEventListener('change', updateAuditRewriteState);
  $('#audit-dialog')?.addEventListener('close', () => {
    state.auditAbort?.abort();
    state.auditAbort = null;
    state.auditBookId = '';
    state.auditIssues = [];
    state.auditQuery = '';
  });

  $('#save-manuscript').addEventListener('click', () => saveAll({ notify: true }));

  ['#ai-revise', '#selection-revise'].forEach((selector) => {
    const button = $(selector);
    if (button) button.addEventListener('mousedown', (event) => event.preventDefault());
  });

  $('#ai-mode').addEventListener('click', (event) => {
    const button = event.target.closest('[data-ai-mode]');
    if (button) setAiMode(button.dataset.aiMode);
  });

  $('#ai-next').addEventListener('click', () => runAi({ action: 'chapter' }));
  $('#ai-revise').addEventListener('click', () => runAi({ action: 'revise', useSelection: true }));
  $('#selection-revise').addEventListener('click', () => runAi({ action: 'revise', useSelection: true }));
  $('#ai-stop').addEventListener('click', () => stopAi());

  $('#review-bar').addEventListener('click', (event) => {
    const button = event.target.closest('[data-review-action]');
    if (button) {
      respondProposal(button.dataset.reviewAction);
      return;
    }
    if (event.target.closest('#review-stop')) stopAi();
  });

  $('#ai-instruction').addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      runAi({ action: 'chapter' });
    }
  });

  $('#theme-editor').addEventListener('input', () => {
    if (!state.current) return;
    state.current.meta.theme = $('#theme-editor').value;
    markDirty('theme');
  });

  $('#outline-editor').addEventListener('input', () => {
    if (!state.current) return;
    state.current.outline = $('#outline-editor').value;
    markDirty('outline');
  });

  $('#notes-editor').addEventListener('input', () => {
    if (!state.current) return;
    state.current.notes = $('#notes-editor').value;
    markDirty('notes');
  });

  $('#manuscript-editor').addEventListener('input', () => {
    if (!state.current) return;
    const value = $('#manuscript-editor').value;
    state.current.manuscript = value;
    state.current.stats = {
      words: countWords(value),
      chapters: countChapters(value, state.current.meta.title),
    };
    const heading = getManuscriptTitle(value);
    state.titleDirty = Boolean(heading?.title && heading.title !== state.loadedHeading);
    updateTitleDisplay();
    $('#ms-words').textContent = `${formatNumber(state.current.stats.words)} 字`;
    scheduleChapterRefresh();
    markDirty('manuscript');
  });

  $('#book-usage').addEventListener('click', (event) => {
    const button = event.target.closest('[data-usage]');
    if (button) setDialogUsage(button.dataset.usage);
  });

  $('#book-create').addEventListener('click', createBookFromDialog);

  $('#confirm-ok').addEventListener('click', () => settleConfirm(true));
  $('#confirm-cancel').addEventListener('click', () => settleConfirm(false));
  $('#confirm-dialog').addEventListener('cancel', (event) => {
    event.preventDefault();
    settleConfirm(false);
  });

  window.addEventListener('hashchange', route);
  document.addEventListener('selectionchange', checkSelection);

  window.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if ($('#briefing-dialog')?.open) {
        flushBriefingDialog();
        return;
      }
      if (state.view === 'workspace') saveAll({ notify: true });
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (state.view === 'library') $('#search-input').focus();
    }
    if (event.key === 'Escape') {
      closeChapterMenu();
      closeDropdowns();
    }
  });

  window.addEventListener('beforeunload', (event) => {
    if (state.dirty.size) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  const library = $('#view-library');
  ['dragenter', 'dragover'].forEach((name) => {
    library.addEventListener(name, (event) => {
      event.preventDefault();
      library.classList.add('dragging');
    });
  });
  ['dragleave', 'drop'].forEach((name) => {
    library.addEventListener(name, (event) => {
      event.preventDefault();
      library.classList.remove('dragging');
    });
  });
  library.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());
}

/* ---------- boot ---------- */
loadAccent();
wireEvents();
tickClock();
setInterval(tickClock, 15000);
loadBooks().then(route);
