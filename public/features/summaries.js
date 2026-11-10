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
const SUMMARY_STALE_CONCURRENCY = 4;
const SUMMARY_APPEND_CONCURRENCY = 2;
const SUMMARY_RETRY_DELAY = 700;

function summaryRunMap(bookId, create = false) {
  if (!bookId) return null;
  let map = state.summaryRuns.get(bookId);
  if (!map && create) {
    map = new Map();
    state.summaryRuns.set(bookId, map);
  }
  return map || null;
}

function getSummaryRun(bookId, index) {
  return summaryRunMap(bookId)?.get(index) || null;
}

function setSummaryRun(bookId, index, run) {
  const map = summaryRunMap(bookId, true);
  if (!map) return;
  if (run) map.set(index, run);
  else map.delete(index);
  if (state.summaryBookId === bookId) updateSummaryItemState(index);
}

function runIsActive(run) {
  return Boolean(run && run.status !== 'failed');
}

function summaryStatusHtml(index, run) {
  if (!run) return '';
  const label = run.status === 'queued'
    ? '排队'
    : run.status === 'retrying'
      ? `重试中 ${run.attempt}/2`
      : run.status === 'failed'
        ? '失败'
        : '生成中';
  const title = run.error ? ` title="${escapeHtml(run.error)}"` : '';
  return `<span class="summary-status ${run.status}" data-summary-status="${index}"${title}><i aria-hidden="true"></i>${label}</span>`;
}

function updateSummaryItemState(index) {
  const item = document.querySelector(`#summary-list [data-summary-item="${index}"]`);
  if (!item) return;
  const chapter = state.summaryChapters.find((entry) => entry.index === index);
  const run = getSummaryRun(state.summaryBookId, index);
  const badges = item.querySelector('.summary-badges');
  if (badges) {
    const current = badges.querySelector('[data-summary-status]');
    if (!run) {
      current?.remove();
    } else {
      const wrapper = document.createElement('span');
      wrapper.innerHTML = summaryStatusHtml(index, run);
      const next = wrapper.firstElementChild;
      if (current) current.replaceWith(next);
      else badges.prepend(next);
    }
  }

  const generating = runIsActive(run);
  item.classList.toggle('is-generating', generating);
  item.classList.toggle('is-failed', run?.status === 'failed');
  const blocked = state.summaryBusy || !chapter?.chars || !state.current?.meta.aiEnabled || generating;
  const textarea = item.querySelector('.summary-text');
  if (textarea) textarea.disabled = blocked;
  const button = item.querySelector('[data-summary-regenerate]');
  if (button) button.disabled = blocked;
}

function isRetryableSummaryError(error) {
  const status = Number(error?.status);
  return !status || status >= 500;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function markSummaryPending(bookId, chapters) {
  const pending = state.summaryPending.get(bookId) || new Set();
  for (const chapter of chapters) {
    if (!Number.isInteger(chapter?.index)) continue;
    pending.add(chapter.index);
    if (!getSummaryRun(bookId, chapter.index)) {
      setSummaryRun(bookId, chapter.index, { status: 'queued', attempt: 1, error: '' });
    }
  }
  if (!pending.size) return;
  state.summaryPending.set(bookId, pending);
  if (state.current?.meta.id === bookId) renderAgentSettings();
}

export function startAppendedSummaries(bookId, chapters) {
  const targets = (Array.isArray(chapters) ? chapters : [])
    .filter((chapter) => Number.isInteger(chapter?.index));
  if (!targets.length) return;
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const at = cursor;
      cursor += 1;
      if (at >= targets.length) return;
      await generateSummaryForChapter(bookId, targets[at]);
    }
  };
  Promise.all(
    Array.from(
      { length: Math.min(SUMMARY_APPEND_CONCURRENCY, targets.length) },
      () => worker(),
    ),
  ).catch(() => {});
}

async function generateSummaryForChapter(bookId, chapter) {
  if (!Number.isInteger(chapter?.index)) return;
  setSummaryRun(bookId, chapter.index, { status: 'generating', attempt: 1, error: '' });
  if (state.current?.meta.id === bookId) {
    aiLog('SUMMARY', `第 ${chapter.index} 章摘要生成中…`);
  }

  try {
    const generated = await api(`/books/${encodeURIComponent(bookId)}/summaries/generate`, {
      method: 'POST',
      body: { index: chapter.index },
    });
    const summary = generated.summary;

    if (state.current?.meta.id === bookId) {
      const latest = state.summaryChapters.find((entry) => entry.index === chapter.index);
      if (latest) {
        Object.assign(latest, {
          summary: String(summary.summary || ''),
          tags: summary.tags || {},
          source: summary.source || 'ai',
          at: summary.at || '',
          hasSummary: true,
          stale: false,
        });
      }
      updateSummaryEntry({
        index: chapter.index,
        title: summary.title || chapter.title || '',
        summary: summary.summary || '',
        tags: summary.tags || {},
        source: summary.source || 'ai',
        at: summary.at || '',
      });
      setSummaryRun(bookId, chapter.index, null);
      if (state.summaryBookId === bookId && $('#summary-dialog')?.open) renderSummaryList();
      aiLog('OK', `第 ${chapter.index} 章摘要已生成`, 'ok');
      if (generated.degraded) {
        const detail = generated.mapFailures
          ? `${generated.mapFailures} 个片段使用原文摘录兜底`
          : '章节很长，摘要按大块合并';
        aiLog('WARN', `第 ${chapter.index} 章摘要：${detail}`, 'warn');
      }
    }
  } catch (err) {
    setSummaryRun(bookId, chapter.index, {
      status: 'failed',
      attempt: 1,
      error: err.message || '摘要生成失败',
    });
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

function summaryBadges(chapter) {
  const missing = !chapter.hasSummary || !String(chapter.summary || '').trim();
  if (missing) return '<span class="summary-badge missing">缺失</span>';
  const stale = chapter.stale ? '<span class="summary-badge stale">可能过期</span>' : '';
  const source = chapter.source === 'user'
    ? '<span class="summary-badge user">用户</span>'
    : '<span class="summary-badge">AI</span>';
  return `${stale}${source}`;
}

function summaryStaleTargets() {
  return state.summaryChapters.filter((chapter) => chapter.stale
    && chapter.hasSummary
    && chapter.chars > 0
    && String(chapter.summary || '').trim());
}

function updateStaleButton() {
  const staleButton = $('#summary-regenerate-stale');
  if (!staleButton) return;
  const count = summaryStaleTargets().length;
  staleButton.disabled = state.summaryBusy || !state.current?.meta.aiEnabled || !count;
  staleButton.textContent = count ? `重生成过期 (${count})` : '重生成过期';
}

function updateSummaryItemContent(index) {
  const chapter = state.summaryChapters.find((entry) => entry.index === index);
  if (!chapter) return;
  updateStaleButton();

  const item = document.querySelector(`#summary-list [data-summary-item="${index}"]`);
  if (!item) return;
  const run = getSummaryRun(state.summaryBookId, index);
  if (run?.status === 'failed') return;

  const list = $('#summary-list');
  const scrollTop = list?.scrollTop || 0;

  const badges = item.querySelector('.summary-badges');
  if (badges) {
    const status = badges.querySelector('[data-summary-status]');
    for (const badge of badges.querySelectorAll('.summary-badge')) badge.remove();
    const holder = document.createElement('span');
    holder.innerHTML = summaryBadges(chapter);
    const nodes = [...holder.childNodes];
    if (status) status.after(...nodes);
    else badges.prepend(...nodes);
  }

  const textarea = item.querySelector('.summary-text');
  if (textarea) {
    textarea.value = String(chapter.summary || '');
    textarea.placeholder = chapter.chars ? '还没有摘要' : '这一章还没有正文';
  }

  const disabled = state.summaryBusy || !chapter.chars || !state.current?.meta.aiEnabled;
  const tagsHtml = summaryTagHtml(chapter.tags, chapter.index, disabled);
  const tagsEl = item.querySelector('.summary-tags');
  if (tagsEl) {
    if (tagsHtml) tagsEl.outerHTML = tagsHtml;
    else tagsEl.remove();
  } else if (tagsHtml && textarea) {
    textarea.insertAdjacentHTML('afterend', tagsHtml);
  }

  if (list) list.scrollTop = scrollTop;
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
    const badges = summaryBadges(chapter);

    const empty = !chapter.chars;
    const disabled = busy || empty || !enabled;
    const run = getSummaryRun(state.summaryBookId, chapter.index);
    const controlsDisabled = disabled || runIsActive(run);
    const itemClass = `summary-item${runIsActive(run) ? ' is-generating' : ''}${run?.status === 'failed' ? ' is-failed' : ''}`;
    html.push(`<div class="${itemClass}" data-summary-item="${chapter.index}">
      <div class="summary-head">
        <span class="summary-no">CH ${pad2(chapter.index)}</span>
        <span class="summary-title">${escapeHtml(chapter.title)}</span>
        <span class="summary-badges">${summaryStatusHtml(chapter.index, run)}${badges}<span>${formatNumber(chapter.chars)} 字</span></span>
      </div>
      <textarea class="textarea summary-text" rows="3" data-summary-index="${chapter.index}" ${controlsDisabled ? 'disabled' : ''} placeholder="${empty ? '这一章还没有正文' : '还没有摘要'}">${escapeHtml(chapter.summary || '')}</textarea>
      ${summaryTagHtml(chapter.tags, chapter.index, disabled)}
      <div class="summary-item-actions">
        <button class="text-btn" type="button" data-summary-regenerate="${chapter.index}" ${controlsDisabled ? 'disabled' : ''}>重新生成</button>
      </div>
    </div>`);
  }

  if (state.summaryOrphans.length) {
    const orphans = state.summaryOrphans.map((item) => `<div class="summary-orphan">
      <div class="summary-head">
        <span class="summary-title">${escapeHtml(item.title || '未命名')}</span>
        <span class="summary-badges">
          <span class="summary-badge">未匹配</span>
          <button class="text-btn summary-orphan-del" type="button" data-orphan-delete="1" data-orphan-title="${escapeHtml(item.title || '')}" data-orphan-at="${escapeHtml(item.at || '')}" data-orphan-hash="${escapeHtml(item.sourceHash || '')}">删除</button>
        </span>
      </div>
      <p>${escapeHtml(item.summary || '')}</p>
    </div>`).join('');
    html.push(`<div class="summary-orphans"><div class="summary-orphan-head">未匹配的旧摘要</div>${orphans}</div>`);
  }

  list.innerHTML = html.join('');

  updateStaleButton();
  const pendingSet = state.summaryPending.get(book.meta.id);
  const generate = $('#summary-generate-missing');
  if (generate) generate.disabled = busy || !enabled || Boolean(pendingSet?.size);
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
  const dialog = $('#summary-dialog');
  if (!dialog) return;

  if (!state.summaryBusy) state.summaryStop = false;
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
    setSummaryRun(bookId, index, null);
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

export async function regenerateSummary(index, {
  confirmUser = true,
  allowBusy = false,
  silent = false,
  retries = 0,
} = {}) {
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

  const bookId = book.meta.id;
  const timer = state.summaryTimers.get(index);
  if (timer) {
    clearTimeout(timer);
    state.summaryTimers.delete(index);
  }

  const maxAttempts = 1 + Math.max(0, Math.trunc(Number(retries) || 0));
  let lastError = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (state.summaryBookId !== bookId || state.current?.meta.id !== bookId) {
      setSummaryRun(bookId, index, null);
      return { ok: false, error: '已切换书籍', attempts: attempt - 1 };
    }

    setSummaryRun(bookId, index, {
      status: attempt === 1 ? 'generating' : 'retrying',
      attempt,
      error: lastError,
    });

    try {
      const { summary } = await api(`/books/${encodeURIComponent(bookId)}/summaries/generate`, {
        method: 'POST',
        body: { index },
      });
      if (state.summaryBookId !== bookId || state.current?.meta.id !== bookId) {
        setSummaryRun(bookId, index, null);
        return { ok: false, error: '已切换书籍', attempts: attempt };
      }

      const latest = state.summaryChapters.find((item) => item.index === index);
      if (!latest) {
        setSummaryRun(bookId, index, null);
        return { ok: false, error: '章节已经变化', attempts: attempt };
      }
      Object.assign(latest, {
        summary: String(summary.summary || ''),
        tags: summary.tags || {},
        source: 'ai',
        at: summary.at || '',
        hasSummary: true,
        stale: false,
      });
      updateSummaryEntry(latest);
      setSummaryRun(bookId, index, null);
      if (state.summaryBookId === bookId) {
        updateSummaryItemContent(index);
        if (!state.summaryBusy) renderSummaryList();
      }
      return { ok: true, attempts: attempt, retried: attempt > 1 };
    } catch (err) {
      lastError = err.message || '摘要生成失败';
      if (attempt < maxAttempts
        && !state.summaryStop
        && state.summaryBookId === bookId
        && isRetryableSummaryError(err)) {
        setSummaryRun(bookId, index, {
          status: 'retrying',
          attempt: attempt + 1,
          error: lastError,
        });
        await wait(SUMMARY_RETRY_DELAY);
        if (state.summaryStop) {
          setSummaryRun(bookId, index, null);
          return { ok: false, error: '已停止', attempts: attempt, retried: true };
        }
        continue;
      }
      setSummaryRun(bookId, index, {
        status: 'failed',
        attempt,
        error: lastError,
      });
      if (!silent) toast(lastError, 'error');
      return { ok: false, error: lastError, attempts: attempt, retried: attempt > 1 };
    }
  }

  return { ok: false, error: lastError || '摘要生成失败', attempts: maxAttempts };
}

async function runSummaryPool({
  bookId,
  targets,
  concurrency,
  retries = 0,
  label,
  shouldRun = null,
}) {
  let cursor = 0;
  let done = 0;
  let failed = 0;
  let retried = 0;
  let active = 0;
  let firstError = '';
  const total = targets.length;

  const worker = async () => {
    for (;;) {
      if (state.summaryStop || state.current?.meta.id !== bookId || state.summaryBookId !== bookId) return;
      const position = cursor;
      cursor += 1;
      if (position >= total) return;

      const chapter = targets[position];
      const latest = state.summaryChapters.find((item) => item.index === chapter.index);
      if (!latest) continue;
      if (shouldRun && !shouldRun(latest)) {
        setSummaryRun(bookId, chapter.index, null);
        done += 1;
        continue;
      }

      active += 1;
      updateSummaryHint(`${label} ${done}/${total} · 进行中 ${active}${retried ? ` · 重试 ${retried}` : ''}`);
      const result = await regenerateSummary(latest.index, {
        confirmUser: false,
        allowBusy: true,
        silent: true,
        retries,
      });

      active -= 1;
      if (result.ok) done += 1;
      else {
        failed += 1;
        if (!firstError) firstError = result.error || '';
      }
      if (result.retried) retried += 1;
      updateSummaryHint(`${label} ${done}/${total} · 进行中 ${active}${retried ? ` · 重试 ${retried}` : ''}`);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));
  return { done, failed, retried, total, firstError };
}

export async function backfillSummaries() {
  const book = state.current;
  if (!book || state.summaryBusy) return;
  const bookId = book.meta.id;

  await flushSummaryTimers();
  const pending = state.summaryPending.get(bookId) || new Set();
  const targets = state.summaryChapters.filter((chapter) => chapter.chars > 0
    && !pending.has(chapter.index)
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

  const result = await runSummaryPool({
    bookId,
    targets,
    concurrency: SUMMARY_CONCURRENCY,
    label: '补齐中',
    shouldRun: (chapter) => chapter.chars > 0
      && !pending.has(chapter.index)
      && (!chapter.hasSummary || !String(chapter.summary || '').trim())
      && chapter.source !== 'user',
  });

  const stopped = state.summaryStop;
  state.summaryBusy = false;
  state.summaryStop = false;
  if (state.current?.meta.id === bookId) {
    renderSummaryList();
    const suffix = result.failed ? ` · 失败 ${result.failed}` : '';
    updateSummaryHint(stopped
      ? `已停止 · 完成 ${result.done}/${result.total}${suffix}`
      : `补齐完成 ${result.done}/${result.total}${suffix}`);
  }
  if (result.failed) {
    toast(`有 ${result.failed} 章摘要没生成成功${result.firstError ? `：${result.firstError}` : ''}`, 'warn', 5000);
  }
}

export async function regenerateStaleSummaries() {
  const book = state.current;
  if (!book) return;
  if (state.summaryBusy) {
    toast('摘要任务正在跑，稍等', 'info');
    return;
  }

  const bookId = book.meta.id;
  await flushSummaryTimers();
  const targets = state.summaryChapters.filter((chapter) => chapter.stale
    && chapter.hasSummary
    && chapter.chars > 0
    && String(chapter.summary || '').trim());

  if (!targets.length) {
    toast('没有可能过期的摘要', 'info');
    return;
  }

  const userCount = targets.filter((chapter) => chapter.source === 'user').length;
  const ok = await confirmDialog({
    title: '重新生成可能过期的摘要',
    text: `将重新生成 ${targets.length} 条可能过期的摘要${userCount ? `，其中 ${userCount} 条是你手改过的，会被覆盖` : ''}。继续？`,
    okLabel: '开始生成',
  });
  if (!ok) return;

  state.summaryBusy = true;
  state.summaryStop = false;
  for (const chapter of targets) {
    setSummaryRun(bookId, chapter.index, { status: 'queued', attempt: 1, error: '' });
  }
  renderSummaryList();

  const poolSize = Math.min(SUMMARY_STALE_CONCURRENCY, targets.length);
  updateSummaryHint(`重生成过期 0/${targets.length} · 并发 ${poolSize}`);
  const result = await runSummaryPool({
    bookId,
    targets,
    concurrency: SUMMARY_STALE_CONCURRENCY,
    retries: 1,
    label: '重生成过期',
    shouldRun: (chapter) => chapter.stale
      && chapter.hasSummary
      && chapter.chars > 0
      && String(chapter.summary || '').trim(),
  });

  const stopped = state.summaryStop;
  state.summaryBusy = false;
  state.summaryStop = false;
  if (state.current?.meta.id === bookId) {
    renderSummaryList();
    const suffix = result.failed ? ` · 失败 ${result.failed}` : '';
    const retried = result.retried ? ` · 重试 ${result.retried}` : '';
    updateSummaryHint(stopped
      ? `已停止 · 完成 ${result.done}/${result.total}${retried}${suffix}`
      : `重生成完成 ${result.done}/${result.total}${retried}${suffix}`);
  }
  if (result.failed) {
    toast(`有 ${result.failed} 条过期摘要没生成成功${result.firstError ? `：${result.firstError}` : ''}`, 'warn', 5000);
  }
}

export async function deleteSummaryOrphan({ title = '', at = '', sourceHash = '' } = {}) {
  const book = state.current;
  if (!book) return;
  const ok = await confirmDialog({
    title: '删除未匹配的旧摘要',
    text: `删除「${title || '未命名'}」这条旧摘要？删除后不会影响正文和现有章节摘要。`,
    okLabel: '删除',
  });
  if (!ok) return;

  const bookId = book.meta.id;
  try {
    const data = await api(`/books/${encodeURIComponent(bookId)}/summaries/orphans`, {
      method: 'DELETE',
      body: { title, at, sourceHash },
    });
    if (state.current?.meta.id !== bookId) return;
    if (!data.deleted) {
      toast('没有找到这条旧摘要，已经刷新列表', 'info');
      await loadSummaries();
      return;
    }

    state.summaryOrphans = Array.isArray(data.orphans)
      ? data.orphans
      : state.summaryOrphans.filter((item) => !(String(item.title || '') === title
        && String(item.at || '') === at
        && String(item.sourceHash || '') === sourceHash));
    if (Array.isArray(book.summaries)) {
      book.summaries = [
        ...book.summaries.filter((item) => item.index !== null),
        ...state.summaryOrphans,
      ];
    }

    const listEl = $('#summary-list');
    const scrollTop = listEl?.scrollTop || 0;
    renderSummaryList();
    if (listEl) listEl.scrollTop = scrollTop;
    toast(`已删除 ${data.deleted} 条未匹配摘要`, 'success');
  } catch (err) {
    toast(err.message || '删除旧摘要失败', 'error');
  }
}
