import { marked } from './vendor/marked.esm.js';
import DOMPurify from './vendor/purify.es.js';
import katex from '/vendor/katex/katex.mjs';
import renderMathInElement from '/vendor/katex/contrib/auto-render.mjs';

const MATH_BLOCK_RE = /^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n|$)/;

marked.use({
  extensions: [{
    name: 'mathBlock',
    level: 'block',
    start(src) {
      return src.search(/\$\$|\\\[/);
    },
    tokenizer(src) {
      const match = MATH_BLOCK_RE.exec(src);
      if (!match) return undefined;
      return {
        type: 'mathBlock',
        raw: match[0],
        text: (match[1] ?? match[2] ?? '').trim(),
      };
    },
    renderer(token) {
      return `<div class="math-block" data-tex="${escapeHtml(token.text)}"></div>\n`;
    },
  }],
});

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
  titleEditing: false,
  titleDirty: false,
  loadedHeading: '',
  logLevel: 'info',
  aiLogs: [],
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
  briefingSection: '',
  briefingBookId: '',
  selectionText: '',
  aiRunning: false,
  aiAbort: null,
  aiMode: 'diff',
  aiBookId: '',
  aiProposal: null,
  aiReview: null,
  aiDraftTimer: null,
  stickyObserver: null,
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

function closeDropdowns(except = null) {
  $$('.dropdown.open').forEach((dropdown) => {
    if (dropdown === except) return;
    dropdown.classList.remove('open');
    const trigger = dropdown.querySelector('.dropdown-trigger');
    const menu = dropdown.querySelector('.dropdown-menu');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    if (menu) menu.hidden = true;
  });
}

function initDropdown(root, { value, onChange } = {}) {
  if (!root) return null;

  const trigger = root.querySelector('.dropdown-trigger');
  const menu = root.querySelector('.dropdown-menu');
  const label = root.querySelector('.dropdown-label');
  const items = $$('.dropdown-item', root);

  const setValue = (next, { silent = false } = {}) => {
    const item = items.find((button) => button.dataset.value === next) || items[0];
    if (!item) return;
    items.forEach((button) => button.classList.toggle('on', button === item));
    if (label) label.textContent = item.textContent.trim();
    root.dataset.value = item.dataset.value;
    if (!silent && onChange) onChange(item.dataset.value);
  };

  const open = (nextOpen) => {
    if (nextOpen) closeDropdowns(root);
    root.classList.toggle('open', nextOpen);
    if (trigger) trigger.setAttribute('aria-expanded', String(nextOpen));
    if (menu) menu.hidden = !nextOpen;
  };

  trigger?.addEventListener('click', (event) => {
    event.stopPropagation();
    open(menu.hidden);
  });

  trigger?.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open(true);
      const selected = items.find((item) => item.classList.contains('on')) || items[0];
      selected?.focus();
    }
  });

  items.forEach((item) => {
    item.addEventListener('click', () => {
      setValue(item.dataset.value);
      open(false);
      trigger?.focus();
    });
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        open(false);
        trigger?.focus();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const index = items.indexOf(item);
        const offset = event.key === 'ArrowDown' ? 1 : -1;
        items[(index + offset + items.length) % items.length]?.focus();
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setValue(item.dataset.value);
        open(false);
        trigger?.focus();
      }
    });
  });

  root.addEventListener('click', (event) => event.stopPropagation());
  if (value) setValue(value, { silent: true });
  return { setValue, open };
}

function countWords(text) {
  return Array.from(String(text || '').replace(/[\s　]/g, '')).length;
}

function getManuscriptTitle(manuscript) {
  const source = String(manuscript || '');
  const match = source.match(/^(#{1,2})\s+(.+)$/m);
  if (!match || match[1].length !== 1) return null;
  return {
    title: match[2].trim(),
    start: match.index,
    end: match.index + match[0].length,
  };
}

function parseChapterEntries(manuscript, bookTitle = '') {
  const source = String(manuscript || '');
  if (!source.trim()) return [];

  const headings = [...source.matchAll(/^(#{1,2})\s+(.+)$/gm)].map((match) => ({
    level: match[1].length,
    title: match[2].trim(),
    start: match.index,
  }));

  const title = getManuscriptTitle(source);
  let entries = headings;
  if (title) entries = entries.filter((entry) => entry.start !== title.start);
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
  if (type === 'error') aiLog('ERR', message, 'err');
  else if (type === 'warn') aiLog('WARN', message, 'warn');

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

function syncStickyHeight() {
  const sticky = $('.ms-sticky');
  const chrome = $('.ms-chrome');
  if (!sticky || !chrome) return;
  const height = Math.max(0, Math.round(sticky.getBoundingClientRect().height));
  chrome.style.setProperty('--ms-sticky-h', `${height}px`);
}

function isNearBottom(element, distance = 180) {
  if (!element) return false;
  return element.scrollHeight - element.scrollTop - element.clientHeight < distance;
}

function scrollManuscriptToEnd() {
  const manuscript = $('.manuscript');
  if (manuscript) manuscript.scrollTop = manuscript.scrollHeight;
}

function scrollToPendingChapter() {
  const manuscript = $('.manuscript');
  const section = $('#ai-pending-chapter');
  if (!manuscript || !section) return;
  const sticky = $('.ms-sticky')?.getBoundingClientRect().height || 0;
  const top = manuscript.scrollTop
    + section.getBoundingClientRect().top
    - manuscript.getBoundingClientRect().top
    - sticky
    - 10;
  manuscript.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

function scrollToReviewChange(last = false) {
  const manuscript = $('.manuscript');
  if (!manuscript) return;
  const marks = $$('#prose .ai-del, #prose .ai-ins, #prose .ai-change-block');
  if (!marks.length) return;
  const target = last ? marks[marks.length - 1] : marks[0];
  const sticky = $('.ms-sticky')?.getBoundingClientRect().height || 0;
  const top = manuscript.scrollTop
    + target.getBoundingClientRect().top
    - manuscript.getBoundingClientRect().top
    - sticky
    - 16;
  manuscript.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
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

const MATH_DELIMITERS = [
  { left: '$$', right: '$$', display: true },
  { left: '\\[', right: '\\]', display: true },
  { left: '\\(', right: '\\)', display: false },
  { left: '$', right: '$', display: false },
];

function renderBlockMath(root) {
  if (!root) return;
  $$('.math-block', root).forEach((element) => {
    const tex = element.dataset.tex || '';
    try {
      element.innerHTML = katex.renderToString(tex, {
        displayMode: true,
        throwOnError: false,
        strict: false,
        errorColor: 'rgba(255,85,68,.9)',
      });
    } catch {
      element.textContent = tex;
    }
  });
}

function renderMath(root) {
  if (!root) return;
  try {
    renderMathInElement(root, {
      delimiters: MATH_DELIMITERS,
      throwOnError: false,
      strict: false,
      errorColor: 'rgba(255,85,68,.9)',
      ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'option'],
    });
  } catch (err) {
    console.warn('KaTeX render failed', err);
  }
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
  prose.innerHTML = DOMPurify.sanitize(html.join(''));
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

function markPendingSelection() {
  const prose = $('#prose');
  const selection = window.getSelection();
  if (!prose || !selection || selection.isCollapsed || !selection.rangeCount) return false;

  const range = selection.getRangeAt(0);
  if (!prose.contains(range.commonAncestorContainer)) return false;

  $$('.ai-selection-pending', prose).forEach((mark) => {
    mark.replaceWith(...mark.childNodes);
  });

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

  selection.removeAllRanges();
  if (first) first.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return Boolean(first);
}

function startReview(action, { selectionWords = 0, preserveSelection = false, mode = 'diff' } = {}) {
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
  };
  state.aiProposal = null;

  if (state.manuscriptMode === 'edit') setManuscriptMode('read');
  hideSelection();
  updateReviewBar();
  if (!preserveSelection) renderProse();
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
      body.innerHTML = DOMPurify.sanitize(review.draft.trim()
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

function scrollEditorToPosition(editor, position) {
  const line = editor.value.slice(0, position).split('\n').length;
  const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 32;
  editor.scrollTop = Math.max(0, (line - 3) * lineHeight);
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

  const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 32;
  const topLine = Math.floor(editor.scrollTop / lineHeight);
  const caretLine = value.slice(0, position).split('\n').length - 1;
  const visibleLines = Math.max(1, Math.floor(editor.clientHeight / lineHeight));
  if (caretLine < topLine || caretLine > topLine + visibleLines - 1) {
    let nextPosition = 0;
    let line = 0;
    while (line < topLine && nextPosition < value.length) {
      const newline = value.indexOf('\n', nextPosition);
      if (newline < 0) break;
      nextPosition = newline + 1;
      line += 1;
    }
    position = nextPosition;
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
      if (anchor) applyReadAnchorToEditor(anchor);
      else updateChapterFromCursor();
    });
  }
  updateReviewBar();
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

function aiLog(tag, message, tone = '') {
  const level = tone === 'err' ? 'error' : tone === 'warn' ? 'warn' : 'info';
  const now = new Date();
  state.aiLogs.push({
    time: `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`,
    tag,
    text: String(message ?? ''),
    level,
  });
  if (state.aiLogs.length > 200) state.aiLogs.splice(0, state.aiLogs.length - 200);
  renderLog(level === 'error');
}

function renderLog(forceBottom = false) {
  const log = $('#ai-log');
  if (!log) return;

  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
  const matches = (entry) => {
    if (state.logLevel === 'warn') return entry.level === 'warn' || entry.level === 'error';
    if (state.logLevel === 'error') return entry.level === 'error';
    return entry.level === 'info';
  };

  const entries = state.aiLogs.filter(matches);
  log.innerHTML = entries.length
    ? entries.map((entry) => {
      const cls = entry.level === 'error' ? 'err' : entry.level;
      return `<div class="log-line ${cls}"><time>${entry.time}</time><span class="tag">${escapeHtml(entry.tag)}</span><span class="txt">${escapeHtml(entry.text)}</span></div>`;
    }).join('')
    : '<div class="log-empty">暂无日志</div>';

  const button = $('#log-level');
  if (button) {
    const label = state.logLevel === 'error' ? 'ERR' : state.logLevel.toUpperCase();
    button.dataset.level = state.logLevel;
    button.textContent = label;
    button.setAttribute('aria-label', `日志等级 ${label}，点击切换`);
  }

  if (forceBottom || nearBottom) log.scrollTop = log.scrollHeight;
}

function updateAiControls() {
  const book = state.current;
  const enabled = Boolean(book?.meta?.aiEnabled);
  const running = state.aiRunning;
  const pending = state.aiProposal?.status === 'pending';
  const busy = running || pending;
  const hasSelection = Boolean(state.selectionText);

  const instruction = $('#ai-instruction');
  if (instruction) instruction.disabled = !enabled || busy;
  ['#ai-next', '#ai-outline'].forEach((selector) => {
    const button = $(selector);
    if (button) button.disabled = !enabled || busy;
  });
  const revise = $('#ai-revise');
  if (revise) revise.disabled = !enabled || busy || !hasSelection;
  const selectionRevise = $('#selection-revise');
  if (selectionRevise) selectionRevise.disabled = !enabled || busy || !hasSelection;
  $$('#ai-mode button').forEach((button) => {
    button.disabled = !enabled || busy;
  });
  const stop = $('#ai-stop');
  if (stop) stop.hidden = !running;

  const note = $('#ai-note');
  if (note) {
    note.classList.toggle('busy', running);
    note.textContent = running
      ? 'RUNNING / 运行中'
      : pending
        ? 'DIFF / 等待确认'
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
    search_manuscript: '搜索正文…',
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
    aiLog('SYS', `${String(payload.mode || '').toUpperCase()} / ${String(payload.action || '').toUpperCase()} / ${payload.model || '—'}`);
    setAiState('RUNNING', 'running');
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
    toast(payload.message || '警告', 'warn');
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
  const selectionWords = useSelection ? countWords(selection?.text || '') : 0;
  const preserveSelection = action === 'revise' && useSelection
    ? markPendingSelection()
    : false;
  const livePreview = mode === 'diff' || action === 'chapter' || action === 'revise';
  if (livePreview) startReview(action, { selectionWords, preserveSelection, mode });
  else clearReview({ render: false });
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
      clearReview({ render: false });
      await refreshBookAfterAi({ scrollEnd: action === 'chapter' });
    }
    if (!state.aiProposal && !hadError) {
      if (state.aiReview) {
        clearReview();
        if (!written) {
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
      aiLog('OK', '提案已写入', 'ok');
      toast('已写入正文', 'success');
      const scrollEnd = (proposal.ops || []).some((op) => op.type === 'append_chapter')
        || (Array.isArray(result.changed) && result.changed.includes('manuscript'));
      state.aiReview = null;
      state.aiProposal = null;
      updateReviewBar();
      setAiState('DONE', 'done');
      await refreshBookAfterAi({ scrollEnd });
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

const MODEL_GROUP_ORDER = ['opencode-go', 'auto'];

function openModelDialog() {
  const book = state.current;
  if (!book) return;
  const dialog = $('#model-dialog');
  if (!dialog) return;
  if (!dialog.open) dialog.showModal();
  const list = $('#model-list');
  if (list) list.innerHTML = '<div class="model-empty">读取模型…</div>';
  loadModelList(book.meta.id);
}

async function loadModelList(bookId) {
  try {
    const { models } = await api('/models');
    if (!state.current || state.current.meta.id !== bookId) return;
    renderModelList(Array.isArray(models) ? models : []);
  } catch (err) {
    const list = $('#model-list');
    if (list) list.innerHTML = `<div class="model-empty">${escapeHtml(err.message || '读取模型失败')}</div>`;
  }
}

function renderModelList(models) {
  const list = $('#model-list');
  if (!list) return;

  const current = state.current?.meta.model || '';
  const usable = models.filter((model) => model && model.id && model.toolCall !== false);
  if (!usable.length) {
    list.innerHTML = '<div class="model-empty">没有可用模型</div>';
    return;
  }

  const groups = new Map();
  for (const model of usable) {
    const prefix = model.id.includes('/') ? model.id.split('/')[0] : 'models';
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push(model);
  }

  const ordered = [...groups.entries()].sort((a, b) => {
    const ai = MODEL_GROUP_ORDER.indexOf(a[0]);
    const bi = MODEL_GROUP_ORDER.indexOf(b[0]);
    if (ai >= 0 || bi >= 0) {
      if (ai < 0) return 1;
      if (bi < 0) return -1;
      return ai - bi;
    }
    return a[0].localeCompare(b[0]);
  });

  const html = [];
  for (const [prefix, items] of ordered) {
    html.push(`<div class="model-group">${escapeHtml(prefix.toUpperCase())}</div>`);
    for (const model of items) {
      const on = model.id === current ? ' on' : '';
      const ctx = model.contextWindow ? compactNumber(model.contextWindow) : '';
      html.push(`<button class="model-item${on}" type="button" data-model="${escapeHtml(model.id)}"><span class="id">${escapeHtml(model.id)}</span>${ctx ? `<span class="ctx">${ctx}</span>` : ''}</button>`);
    }
  }
  list.innerHTML = html.join('');
}

async function selectModel(model) {
  const book = state.current;
  const dialog = $('#model-dialog');
  if (!book || !model) return;

  if (model === book.meta.model) {
    if (dialog?.open) dialog.close();
    return;
  }

  try {
    const { meta } = await api(`/books/${encodeURIComponent(book.meta.id)}/meta`, {
      method: 'PUT',
      body: { model },
    });
    if (state.current?.meta.id === book.meta.id) state.current.meta = meta;
    const label = $('#ai-model-label');
    if (label) label.textContent = meta.model || '—';
    if (dialog?.open) dialog.close();
  } catch (err) {
    toast(err.message || '切换模型失败', 'error');
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

  window.addEventListener('resize', () => {
    requestAnimationFrame(() => {
      syncStickyHeight();
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
