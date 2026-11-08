import { state } from '../core/state.js';
import { $, $$, escapeHtml } from '../core/dom.js';
import { formatNumber, pad2 } from '../core/format.js';
import { api } from '../core/api.js';
import { aiLog } from '../core/logger.js';
import { toast } from '../ui/toast.js';
import { confirmDialog } from '../ui/primitives.js';
import { renderAgentSettings } from './ai-controls.js';

const SUMMARY_TAG_LABELS = { characters: '人物', locations: '地点', items: '道具', hooks: '伏笔' };
const SUMMARY_CONCURRENCY = 5;

export function markSummaryPending(bookId, chapters) {
  const pending = state.summaryPending.get(bookId) || new Set();
  for (const chapter of chapters) {
    if (Number.isInteger(chapter?.index)) pending.add(chapter.index);
  }
  if (!pending.size) return;
  state.summaryPending.set(bookId, pending);
  if (state.current?.meta.id === bookId) renderAgentSettings();
}

export function startAppendedSummaries(bookId, chapters) {
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


/* ---------- summaries ---------- */
export function updateSummaryHint(text) {
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

export function summaryTagChapter(element) {
  const index = Number(element?.closest('.summary-tag')?.dataset.tagChapter);
  if (!Number.isInteger(index)) return null;
  return state.summaryChapters.find((chapter) => chapter.index === index) || null;
}

export function startSummaryTagEdit(span) {
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

export function commitSummaryTagEdit(span, { cancel = false } = {}) {
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

export function deleteSummaryTag(chapter, key, tagIndex) {
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

export function openSummaryDialog() {
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


export function scheduleSummarySave(index) {
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

export async function flushSummaryTimers() {
  const indexes = [...state.summaryTimers.keys()];
  for (const index of indexes) {
    clearTimeout(state.summaryTimers.get(index));
    state.summaryTimers.delete(index);
  }
  await Promise.all(indexes.map((index) => saveSummary(index)));
}

export async function regenerateSummary(index, { confirmUser = true, allowBusy = false, silent = false } = {}) {
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

export async function backfillSummaries() {
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
