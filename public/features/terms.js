import { state } from '../core/state.js';
import { $, $$, escapeHtml } from '../core/dom.js';
import { formatNumber } from '../core/format.js';
import { api } from '../core/api.js';
import { bus } from '../core/bus.js';
import { toast } from '../ui/toast.js';

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

export function openTermsDialog() {
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

export async function previewTermClean() {
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

export async function applyTermClean() {
  const book = state.current;
  if (!book) return;
  if (state.aiRunning || state.aiProposal?.status === 'pending' || state.summaryBusy || state.blockEdit) {
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
    await bus.emit('book:refresh', { scrollEnd: false });
    renderSavedTerms();
  } catch (err) {
    toast(err.message || '替换失败', 'error');
  }
}

export async function removeSavedTerm(index) {
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
