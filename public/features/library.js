import { state } from '../core/state.js';
import { $, $$, escapeHtml, escapeRegExp } from '../core/dom.js';
import { timeAgo, formatNumber, compactNumber, pad2, usageLabel, deriveTitleFromContent } from '../core/format.js';
import { api } from '../core/api.js';
import { toast } from '../ui/toast.js';
import { initDropdown, confirmDialog } from '../ui/primitives.js';
import { bus } from '../core/bus.js';

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

export function renderLibrary() {
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

function openSearchResult(result) {
  state.pendingHighlight = result.section === 'manuscript' ? result.match : '';
  state.pendingSection = result.section;
  state.pendingQuery = result.match;
  bus.emit('book:open', { id: result.bookId });
}

export async function loadBooks() {
  try {
    const data = await api('/books');
    state.books = data.books || [];
  } catch (err) {
    state.books = [];
    toast(err.message, 'error');
  }
  renderLibrary();
}

export function updateBookSummary(bookId) {
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

/* ---------- book dialog / files ---------- */
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
      bus.emit('book:open', { id: book.meta.id });
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

/* ---------- events ---------- */
export function wireLibraryEvents() {
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
    if (event.target.closest('[data-new-book]')) {
      openBookDialog();
      return;
    }
    if (event.target.closest('[data-import-book]')) triggerFileInput();
  });

  $('#book-grid').addEventListener('click', (event) => {
    const card = event.target.closest('.book-card');
    if (!card) return;
    if (event.target.closest('[data-delete]')) {
      deleteBookById(card.dataset.id, card.dataset.title || '这本书');
      return;
    }
    bus.emit('book:open', { id: card.dataset.id });
  });

  $('#search-results').addEventListener('click', (event) => {
    const hit = event.target.closest('.search-hit');
    if (!hit) return;
    const result = state.results[Number(hit.dataset.i)];
    if (result) openSearchResult(result);
  });

  $('#book-usage').addEventListener('click', (event) => {
    const button = event.target.closest('[data-usage]');
    if (button) setDialogUsage(button.dataset.usage);
  });

  $('#book-create').addEventListener('click', createBookFromDialog);

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
}
