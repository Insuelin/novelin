import { state } from '../core/state.js';
import { $, $$, escapeHtml, setDisabled, setHidden } from '../core/dom.js';
import { pad2 } from '../core/format.js';
import { API } from '../core/api.js';
import { bus } from '../core/bus.js';
import { toast } from '../ui/toast.js';

export function updateAuditRewriteState() {
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

export function openAuditDialog() {
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

export async function scanPlotIssues() {
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

export function stopAuditScan() {
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

export function rewriteAuditItems() {
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
  bus.emit('ai:run', { action: 'plot', plotItems: items, instruction: query });
}
