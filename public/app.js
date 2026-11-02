import { marked } from './vendor/marked.esm.js';
import DOMPurify from './vendor/purify.es.js';

const API = '/api';
const ACCENT_KEY = 'novelin.accent';
const ACCENTS = ['amber', 'orange', 'white', 'cyan'];

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const state = {
  books: [],
  current: null,
  view: 'library',
  filter: 'all',
  sort: 'recent',
  query: '',
  results: [],
  accent: 'amber',
  manuscriptMode: 'read',
  dirty: new Set(),
  saving: new Set(),
  saveAgain: new Set(),
  saveTimer: null,
  searchTimer: null,
  chapterTimer: null,
  chapters: [],
  chapterEls: [],
  currentChapter: 0,
  chapterJumping: false,
  chapterJumpToken: 0,
  pendingHighlight: '',
  pendingSection: '',
  pendingQuery: '',
  dialogUsage: 'continue',
  creating: false,
  confirmResolve: null,
  selectionText: '',
  aiRunning: false,
  aiAbort: null,
  aiMode: 'diff',
  aiBookId: '',
  aiStreamText: '',
  aiProposal: null,
};

/* ---------- helpers ---------- */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countWords(text) {
  return Array.from(String(text || '').replace(/[\s　]/g, '')).length;
}

function parseChapterEntries(manuscript, bookTitle = '') {
  const source = String(manuscript || '');
  if (!source.trim()) return [];

  const headings = [...source.matchAll(/^(#{1,2})\s+(.+)$/gm)].map((match) => ({
    level: match[1].length,
    title: match[2].trim(),
    start: match.index,
  }));

  let entries = headings;
  const cleanTitle = String(bookTitle || '').trim();
  if (entries.length > 1 && cleanTitle && entries[0].level === 1 && entries[0].title === cleanTitle) {
    entries = entries.slice(1);
  }
  if (!entries.length) entries = [{ level: 0, title: '正文', start: 0 }];
  return entries;
}

function countChapters(text, title = '') {
  return parseChapterEntries(text, title).length;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(Number(value) || 0);
}

function compactNumber(value) {
  const number = Number(value) || 0;
  if (number >= 1000000) return `${(number / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
  if (number >= 1000) return `${(number / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(number);
}

function timeAgo(iso) {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return '—';
  const diff = Math.max(0, Date.now() - time);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'JUST NOW';
  if (minutes < 60) return `${minutes}M AGO`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}H AGO`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}D AGO`;
  const date = new Date(time);
  return `${date.getFullYear()}.${pad2(date.getMonth() + 1)}.${pad2(date.getDate())}`;
}

function deriveTitleFromContent(content) {
  const match = String(content || '').match(/^\s*#{1,6}\s+(.+)$/m);
  return match ? match[1].trim() : '';
}

function usageLabel(usage) {
  return { continue: 'CONTINUE', reference: 'REFERENCE', read: 'READ ONLY' }[usage] || 'MANUSCRIPT';
}

function toast(message, type = 'info', duration = 2800) {
  const container = $('#toasts');
  if (!container) return;
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.textContent = message;
  container.appendChild(element);
  requestAnimationFrame(() => element.classList.add('show'));
  setTimeout(() => {
    element.classList.remove('show');
    setTimeout(() => element.remove(), 240);
  }, duration);
}

function setSaveState(label, tone = '') {
  const element = $('#save-state');
  if (!element) return;
  element.textContent = label;
  element.className = `save-state ${tone}`.trim();
}

async function api(path, options = {}) {
  const request = { ...options };
  if (request.body && typeof request.body !== 'string') {
    request.body = JSON.stringify(request.body);
  }
  request.headers = {
    ...(request.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {}),
  };

  let response;
  try {
    response = await fetch(`${API}${path}`, request);
  } catch {
    throw new Error('连不上本地服务，确认 npm start 还在跑');
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `请求失败 (${response.status})`);
  }
  return data;
}

/* ---------- accent ---------- */
function applyAccent(name) {
  const valid = ACCENTS.includes(name) ? name : 'amber';
  state.accent = valid;
  document.documentElement.dataset.accent = valid;
  try {
    localStorage.setItem(ACCENT_KEY, valid);
  } catch {
    // 隐私模式里 localStorage 可能不可用。
  }
  $$('[data-accent-btn]').forEach((button) => {
    button.classList.toggle('active', button.dataset.accentBtn === valid);
  });
}

function loadAccent() {
  let saved = 'amber';
  try {
    saved = localStorage.getItem(ACCENT_KEY) || 'amber';
  } catch {
    // 用默认色。
  }
  applyAccent(saved);
}

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
function renderWorkspace() {
  const book = state.current;
  if (!book) {
    showView('library');
    return;
  }

  closeChapterMenu();
  const stats = book.stats || { words: 0, chapters: 0 };
  const aiLabel = book.meta.aiEnabled
    ? `AI ${String(book.meta.aiMode || 'diff').toUpperCase()}`
    : 'READ ONLY';

  state.currentChapter = 0;
  $('#ws-breadcrumb').textContent = book.meta.title;
  $('#ws-status').textContent = aiLabel;
  $('#ms-title').textContent = book.meta.title;
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
}

function renderProse() {
  const book = state.current;
  if (!book) return;

  const prose = $('#prose');
  const source = book.manuscript || '';

  if (!source.trim()) {
    prose.innerHTML = '<div class="prose-empty">正文还是空的。切到 EDIT 写第一段，或者等 AI 写下一章。</div>';
    state.chapterEls = [];
    refreshChapterNav();
    return;
  }

  const html = marked.parse(source, { breaks: true, gfm: true });
  prose.innerHTML = DOMPurify.sanitize(html);
  $$('a', prose).forEach((link) => {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  });

  const allHeadings = $$('#prose h1, #prose h2');
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
  const line = editor.value.slice(0, position).split('\n').length;
  const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 32;
  editor.scrollTop = Math.max(0, (line - 3) * lineHeight);
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

function setManuscriptMode(mode) {
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
  } else {
    requestAnimationFrame(updateChapterFromCursor);
  }
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

  const text = selection.toString().trim();
  if (!text) {
    hideSelection();
    return;
  }

  state.selectionText = text;
  $('#selection-info').textContent = `SELECTED · ${countWords(text)} 字`;
  $('#selection-note').hidden = false;
  updateAiControls();
}

function hideSelection() {
  state.selectionText = '';
  const note = $('#selection-note');
  if (note) note.hidden = true;
  updateAiControls();
}

/* ---------- agent ---------- */
function setAiState(label, tone = '') {
  const stateElement = $('#ai-state');
  const text = $('#ai-state-text');
  if (text) text.textContent = label;
  if (stateElement) stateElement.dataset.state = tone;
}

function aiLog(tag, message, tone = '') {
  const log = $('#ai-log');
  if (!log) return;
  const line = document.createElement('div');
  line.className = `log-line${tone ? ` ${tone}` : ''}`;
  const time = document.createElement('time');
  const now = new Date();
  time.textContent = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  const tagElement = document.createElement('span');
  tagElement.className = 'tag';
  tagElement.textContent = tag;
  const text = document.createElement('span');
  text.className = 'txt';
  text.textContent = String(message ?? '');
  line.append(time, tagElement, text);
  log.appendChild(line);
  while (log.children.length > 80) log.firstElementChild.remove();
  log.scrollTop = log.scrollHeight;
}

function updateAiControls() {
  const book = state.current;
  const enabled = Boolean(book?.meta?.aiEnabled);
  const running = state.aiRunning;
  const hasSelection = Boolean(state.selectionText);

  const instruction = $('#ai-instruction');
  if (instruction) instruction.disabled = !enabled || running;
  ['#ai-next', '#ai-outline'].forEach((selector) => {
    const button = $(selector);
    if (button) button.disabled = !enabled || running;
  });
  const revise = $('#ai-revise');
  if (revise) revise.disabled = !enabled || running || !hasSelection;
  const selectionRevise = $('#selection-revise');
  if (selectionRevise) selectionRevise.disabled = !enabled || running || !hasSelection;
  $$('#ai-mode button').forEach((button) => {
    button.disabled = !enabled || running;
  });
  const stop = $('#ai-stop');
  if (stop) stop.hidden = !running;

  const note = $('#ai-note');
  if (note) {
    note.classList.toggle('busy', running);
    note.textContent = running
      ? 'RUNNING / 运行中'
      : !enabled
        ? 'AI 未开启'
        : state.aiMode === 'auto'
          ? 'AUTO / 直接写入'
          : 'DIFF / 先看提案';
  }
}

function renderAgent({ reset = false } = {}) {
  const book = state.current;
  if (!book) return;

  const bookChanged = state.aiBookId !== book.meta.id;
  if (reset || bookChanged) {
    state.aiBookId = book.meta.id;
    state.aiStreamText = '';
    state.aiProposal = null;
    const log = $('#ai-log');
    if (log) log.innerHTML = '';
    const stream = $('#ai-stream');
    if (stream) stream.hidden = true;
    const streamText = $('#ai-stream-text');
    if (streamText) streamText.textContent = '';
    const proposal = $('#ai-proposal');
    if (proposal) {
      proposal.hidden = true;
      proposal.innerHTML = '';
    }
    aiLog('SYS', `BOOK / ${book.meta.title || '—'}`);
    if (book.meta.aiEnabled) aiLog('SYS', `MODE / ${String(book.meta.aiMode || 'diff').toUpperCase()}`);
    else aiLog('SYS', 'AI 未开启 / READ ONLY');
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

  try {
    const { meta } = await api(`/books/${encodeURIComponent(book.meta.id)}/meta`, {
      method: 'PUT',
      body: { aiMode: mode },
    });
    if (state.current?.meta.id === book.meta.id) state.current.meta = meta;
  } catch (err) {
    toast(`模式没保存：${err.message}`, 'error');
  }
}

async function loadPendingProposals(bookId) {
  try {
    const data = await api(`/books/${encodeURIComponent(bookId)}/proposals?status=pending`);
    if (state.current?.meta.id !== bookId) return;
    const proposals = Array.isArray(data.proposals) ? data.proposals : [];
    if (!proposals.length) {
      if (!state.aiProposal) {
        const panel = $('#ai-proposal');
        if (panel) {
          panel.hidden = true;
          panel.innerHTML = '';
        }
      }
      return;
    }

    const proposal = proposals[0];
    if (state.aiProposal?.id === proposal.id) return;
    state.aiProposal = proposal;
    renderProposal(proposal);
    setAiState('PROPOSAL', 'proposal');
    aiLog('SYS', proposals.length > 1 ? `待确认提案 ${proposals.length} 个` : '待确认提案');
  } catch (err) {
    aiLog('WARN', `读取提案失败：${err.message}`, 'warn');
  }
}

function compactValue(value) {
  if (value === null || value === undefined) return '';
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function handleAiEvent(type, payload = {}) {
  if (type === 'delta') {
    state.aiStreamText += payload.text || '';
    const stream = $('#ai-stream');
    const text = $('#ai-stream-text');
    if (stream) stream.hidden = false;
    if (text) {
      text.textContent = state.aiStreamText;
      text.scrollTop = text.scrollHeight;
    }
    return;
  }

  if (type === 'meta') {
    aiLog('SYS', `${String(payload.mode || '').toUpperCase()} / ${String(payload.action || '').toUpperCase()} / ${payload.model || '—'}`);
    setAiState('RUNNING', 'running');
    return;
  }

  if (type === 'tool') {
    const name = payload.name || 'tool';
    if (payload.phase === 'start') aiLog('TOOL', `${name} ${compactValue(payload.args)}`);
    else if (payload.phase === 'error') aiLog('ERR', `${name}: ${payload.message || '失败'}`, 'err');
    else aiLog('TOOL', `${name} ✓ ${compactValue(payload.result)}`);
    return;
  }

  if (type === 'written') {
    const changed = Array.isArray(payload.changed) ? payload.changed.join(' + ') : '正文';
    aiLog('OK', `写入 ${changed}`, 'ok');
    return;
  }

  if (type === 'proposal') {
    if (!payload.proposal) return;
    state.aiProposal = payload.proposal;
    const stream = $('#ai-stream');
    if (stream) stream.hidden = true;
    renderProposal(payload.proposal);
    setAiState('PROPOSAL', 'proposal');
    aiLog('SYS', `提案待确认 / ${payload.proposal.id || ''}`);
    return;
  }

  if (type === 'warning') {
    aiLog('WARN', payload.message || '警告', 'warn');
    return;
  }

  if (type === 'error') {
    aiLog('ERR', payload.message || 'AI 运行失败', 'err');
    setAiState('ERROR', 'error');
    toast(payload.message || 'AI 运行失败', 'error');
    return;
  }

  if (type === 'done') {
    aiLog('SYS', payload.ok ? 'DONE' : 'FAILED');
  }
}

async function streamAiResponse(response, onEvent) {
  if (!response.body) throw new Error('浏览器不支持流式响应');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const dispatch = (raw) => {
    let eventName = 'message';
    const data = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!data.length) return;
    let payload;
    try {
      payload = JSON.parse(data.join('\n'));
    } catch {
      return;
    }
    onEvent(eventName, payload);
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (raw.trim()) dispatch(raw);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    for (const raw of buffer.split('\n\n')) {
      if (raw.trim()) dispatch(raw);
    }
  }
}

async function runAi({ action = 'chapter', useSelection = false } = {}) {
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

  let instruction = String($('#ai-instruction')?.value || '').trim().slice(0, 8000);
  if (action === 'chapter') instruction = instruction || '写下一章，承接前文。';
  if (action === 'revise') {
    instruction = instruction || (useSelection
      ? '改写选中的文字，保持原意和文风。'
      : '按大纲重写当前章节，保持人物、设定和文风一致。');
  }

  const selection = useSelection
    ? (state.selectionText ? { text: state.selectionText.slice(0, 8000) } : null)
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

  const bookId = book.meta.id;
  const mode = state.aiMode || book.meta.aiMode || 'diff';
  const model = book.meta.model || '';
  const controller = new AbortController();
  let written = false;
  let hadError = false;

  state.aiRunning = true;
  state.aiAbort = controller;
  state.aiStreamText = '';
  state.aiProposal = null;
  const stream = $('#ai-stream');
  const streamText = $('#ai-stream-text');
  const proposalPanel = $('#ai-proposal');
  if (stream) stream.hidden = false;
  if (streamText) streamText.textContent = '';
  if (proposalPanel) {
    proposalPanel.hidden = true;
    proposalPanel.innerHTML = '';
  }
  setAiState('RUNNING', 'running');
  updateAiControls();

  try {
    const response = await fetch(`${API}/books/${encodeURIComponent(bookId)}/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, action, instruction, model, selection }),
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
      handleAiEvent(type, payload);
    });

    if (state.current?.meta.id !== bookId) return;

    if (written) {
      aiLog('OK', '正文已更新，正在刷新', 'ok');
      await refreshBookAfterAi({ scrollEnd: action === 'chapter' });
    }
    if (!state.aiProposal && !hadError) setAiState('DONE', 'done');
  } catch (err) {
    if (err.name === 'AbortError' || controller.signal.aborted) {
      aiLog('SYS', '已停止');
      if (state.current?.meta.id === bookId && !state.aiProposal) setAiState('STANDBY', '');
    } else {
      aiLog('ERR', err.message || 'AI 运行失败', 'err');
      setAiState('ERROR', 'error');
      toast(err.message || 'AI 运行失败', 'error');
    }
  } finally {
    state.aiRunning = false;
    state.aiAbort = null;
    if (state.current?.meta.id === bookId) updateAiControls();
  }
}

function stopAi({ silent = false } = {}) {
  if (!state.aiRunning || !state.aiAbort) return;
  if (!silent) aiLog('SYS', '停止中…');
  state.aiAbort.abort();
}

function proposalOpHtml(op = {}) {
  const type = String(op.type || '');
  if (type === 'append_chapter') {
    return `<div class="op">
      <div class="op-head"><span>APPEND CHAPTER</span><b>${escapeHtml(op.title || '未命名章节')}</b></div>
      <pre class="op-body">${escapeHtml(op.content || '')}</pre>
    </div>`;
  }
  if (type === 'edit_manuscript' || type === 'edit_outline') {
    const label = type === 'edit_manuscript' ? '正文' : '大纲';
    return `<div class="op">
      <div class="op-head"><span>EDIT ${label}</span><b>${escapeHtml(String(op.old_string || '').slice(0, 42))}</b></div>
      <div class="diff">
        <div class="diff-old"><span class="diff-label">OLD / 原文</span><pre>${escapeHtml(op.old_string || '')}</pre></div>
        <div class="diff-new"><span class="diff-label">NEW / 改写</span><pre>${escapeHtml(op.new_string || '')}</pre></div>
      </div>
    </div>`;
  }
  if (type === 'save_summary') {
    return `<div class="op">
      <div class="op-head"><span>SUMMARY</span><b>${escapeHtml(op.chapter || '')}</b></div>
      <div class="op-summary">${escapeHtml(op.summary || '')}</div>
    </div>`;
  }
  return `<div class="op">
    <div class="op-head"><span>${escapeHtml(type || 'OP')}</span></div>
    <pre class="op-body">${escapeHtml(JSON.stringify(op, null, 2))}</pre>
  </div>`;
}

function renderProposal(proposal) {
  const panel = $('#ai-proposal');
  if (!panel || !proposal) return;

  const ops = Array.isArray(proposal.ops) ? proposal.ops : [];
  const summary = String(proposal.summary || proposal.instruction || '').trim();
  const action = String(proposal.action || 'change').toUpperCase();
  const mode = String(proposal.mode || 'diff').toUpperCase();
  const pending = proposal.status === 'pending';
  const actions = pending
    ? `<div class="proposal-actions">
        <button class="btn danger" type="button" data-proposal-action="reject">拒绝 / REJECT</button>
        <button class="btn" type="button" data-proposal-action="accept">写入 / APPLY</button>
      </div>`
    : `<div class="proposal-status">${escapeHtml(String(proposal.status || '').toUpperCase())}</div>`;

  panel.innerHTML = `
    <div class="proposal-head"><span>/// DIFF PROPOSAL</span><span>${escapeHtml(mode)} / ${escapeHtml(action)}</span></div>
    ${summary ? `<div class="proposal-meta">${escapeHtml(summary)}</div>` : ''}
    ${ops.map(proposalOpHtml).join('') || '<div class="op"><div class="op-summary">没有可预览的修改。</div></div>'}
    ${actions}
  `;
  panel.hidden = false;
}

async function respondProposal(action) {
  const proposal = state.aiProposal;
  const book = state.current;
  if (!proposal || !book || proposal.status !== 'pending') return;

  const bookId = book.meta.id;
  const buttons = $$('#ai-proposal [data-proposal-action]');
  buttons.forEach((button) => {
    button.disabled = true;
  });

  try {
    const result = await api(
      `/books/${encodeURIComponent(bookId)}/proposals/${encodeURIComponent(proposal.id)}/${action}`,
      { method: 'POST', body: {} },
    );

    if (action === 'accept') {
      aiLog('OK', '提案已写入', 'ok');
      toast('已写入正文', 'success');
      const scrollEnd = (proposal.ops || []).some((op) => op.type === 'append_chapter')
        || (Array.isArray(result.changed) && result.changed.includes('manuscript'));
      state.aiProposal = null;
      const panel = $('#ai-proposal');
      if (panel) {
        panel.hidden = true;
        panel.innerHTML = '';
      }
      const stream = $('#ai-stream');
      if (stream) stream.hidden = true;
      setAiState('DONE', 'done');
      await refreshBookAfterAi({ scrollEnd });
    } else {
      aiLog('SYS', '提案已拒绝');
      toast('已拒绝提案');
      state.aiProposal = null;
      const panel = $('#ai-proposal');
      if (panel) {
        panel.hidden = true;
        panel.innerHTML = '';
      }
      const stream = $('#ai-stream');
      if (stream) stream.hidden = true;
      if (!state.aiRunning) setAiState('STANDBY', '');
    }

    await loadPendingProposals(bookId);
  } catch (err) {
    aiLog('ERR', err.message || '提案处理失败', 'err');
    toast(err.message || '提案处理失败', 'error');
    renderProposal(proposal);
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
    aiLog('WARN', `刷新失败：${err.message}`, 'warn');
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

function confirmDialog({ title, text, okLabel = '确认' }) {
  return new Promise((resolve) => {
    state.confirmResolve = resolve;
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    $('#confirm-ok').textContent = okLabel;
    const dialog = $('#confirm-dialog');
    if (!dialog.open) dialog.showModal();
  });
}

function settleConfirm(value) {
  const resolve = state.confirmResolve;
  state.confirmResolve = null;
  const dialog = $('#confirm-dialog');
  if (dialog.open) dialog.close();
  if (resolve) resolve(value);
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
  $('#sort-select').addEventListener('change', (event) => {
    state.sort = event.target.value;
    renderLibrary();
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
    if (button) setManuscriptMode(button.dataset.msMode);
  });

  $('#chapter-btn').addEventListener('click', (event) => {
    event.stopPropagation();
    openChapterMenu($('#chapter-menu').hidden);
  });

  $('#chapter-menu').addEventListener('click', (event) => {
    const item = event.target.closest('[data-chapter]');
    if (item) jumpToChapter(Number(item.dataset.chapter));
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

  window.addEventListener('resize', () => {
    requestAnimationFrame(updateChapterFromScroll);
  });

  $('#save-briefing').addEventListener('click', () => saveAll({ notify: true }));
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
  $('#ai-outline').addEventListener('click', () => runAi({ action: 'revise' }));
  $('#ai-revise').addEventListener('click', () => runAi({ action: 'revise', useSelection: true }));
  $('#selection-revise').addEventListener('click', () => runAi({ action: 'revise', useSelection: true }));
  $('#ai-stop').addEventListener('click', () => stopAi());

  $('#ai-copy').addEventListener('click', async () => {
    if (!state.aiStreamText) return;
    try {
      await navigator.clipboard.writeText(state.aiStreamText);
      toast('已复制', 'success');
    } catch {
      toast('复制失败，浏览器没有剪贴板权限', 'error');
    }
  });

  $('#ai-proposal').addEventListener('click', (event) => {
    const button = event.target.closest('[data-proposal-action]');
    if (button) respondProposal(button.dataset.proposalAction);
  });

  $('#ai-instruction').addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      runAi({ action: 'chapter' });
    }
  });

  $('#back-btn').addEventListener('click', async () => {
    await flushSave();
    location.hash = '#/library';
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
      if (state.view === 'workspace') saveAll({ notify: true });
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (state.view === 'library') $('#search-input').focus();
    }
    if (event.key === 'Escape') closeChapterMenu();
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

function tickClock() {
  const now = new Date();
  $('#clock').textContent = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  $('#date').textContent = `${now.getFullYear()}.${pad2(now.getMonth() + 1)}.${pad2(now.getDate())}`;
}

/* ---------- boot ---------- */
loadAccent();
wireEvents();
tickClock();
setInterval(tickClock, 15000);
loadBooks().then(route);
