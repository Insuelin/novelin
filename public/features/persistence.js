import { state } from '../core/state.js';
import { $ } from '../core/dom.js';
import { getManuscriptTitle, formatNumber, countWords, countChapters } from '../core/format.js';
import { api } from '../core/api.js';
import { toast, setSaveState } from '../ui/toast.js';
import { renderProse, scheduleChapterRefresh } from './manuscript.js';
import { updateBookSummary } from './library.js';

/* ---------- title ---------- */
export function updateTitleDisplay() {
  const book = state.current;
  const element = $('#ms-title');
  if (!book || !element) return;
  const title = getManuscriptTitle(book.manuscript)?.title || book.meta.title || '—';
  if (!state.titleEditing) element.textContent = title;
  element.title = title;
}

export function startTitleEdit() {
  const book = state.current;
  const heading = $('#ms-title');
  const input = $('#ms-title-input');
  if (!book || !heading || !input || state.titleEditing) return;
  if (state.blockEdit) {
    toast('先 APPLY 或取消当前段落', 'error');
    return;
  }

  state.titleEditing = true;
  input.value = getManuscriptTitle(book.manuscript)?.title || book.meta.title || '';
  heading.hidden = true;
  input.hidden = false;
  input.focus();
  input.select();
}

export function stopTitleEdit({ restore = true } = {}) {
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

export async function commitTitleEdit() {
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
        renderProse();
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
      renderProse();
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

/** 正文改动统一入口：块 APPLY、源码框、AI 刷新后的本地状态都走这里。 */
export function applyManuscriptText(value, { mark = true } = {}) {
  const book = state.current;
  if (!book) return;

  const text = String(value ?? '');
  book.manuscript = text;
  book.stats = {
    words: countWords(text),
    chapters: countChapters(text, book.meta.title),
  };

  const heading = getManuscriptTitle(text);
  state.titleDirty = Boolean(heading?.title && heading.title !== state.loadedHeading);
  updateTitleDisplay();
  const words = $('#ms-words');
  if (words) words.textContent = `${formatNumber(book.stats.words)} 字`;
  scheduleChapterRefresh();
  if (mark) markDirty('manuscript');
}

/* ---------- saving ---------- */
export function markDirty(section) {
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

export async function saveAll({ notify = false } = {}) {
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

export async function flushSave() {
  clearTimeout(state.saveTimer);
  if (state.dirty.size) await saveAll();
}
