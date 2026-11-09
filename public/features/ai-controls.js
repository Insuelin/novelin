import { state } from '../core/state.js';
import { $, $$, escapeHtml, setDisabled, setHidden, setText } from '../core/dom.js';
import { compactNumber } from '../core/format.js';
import { api } from '../core/api.js';
import { aiLog } from '../core/logger.js';
import { toast } from '../ui/toast.js';

const TOKEN_PRESETS = [2048, 4096, 8192, 16384];
const STEP_PRESETS = [6, 10, 16, 24, 32];
const TOKEN_MIN = 256;
const TOKEN_MAX = 65536;
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_MAX_STEPS = 16;
const REASONING_LABELS = {
  none: 'OFF',
  minimal: 'MIN',
  low: 'LOW',
  medium: 'MID',
  high: 'HIGH',
  xhigh: 'XHIGH',
  max: 'MAX',
  ultra: 'ULTRA',
};
const MODEL_GROUP_ORDER = ['opencode-go', 'auto'];

export function modelInfo(id) {
  return state.modelCatalog.get(id) || null;
}

export async function ensureModelCatalog() {
  if (state.modelCatalog.size || state.modelCatalogTried) return state.modelCatalog;
  if (!state.modelCatalogPromise) {
    state.modelCatalogPromise = (async () => {
      try {
        const { models } = await api('/models');
        const map = new Map();
        for (const model of Array.isArray(models) ? models : []) {
          if (model?.id) map.set(model.id, model);
        }
        state.modelCatalog = map;
      } catch {
        state.modelCatalog = new Map();
      } finally {
        state.modelCatalogTried = true;
        state.modelCatalogPromise = null;
      }
      return state.modelCatalog;
    })();
  }
  return state.modelCatalogPromise;
}

export function queueMetaPatch(patch) {
  const book = state.current;
  if (!book) return Promise.resolve();

  const bookId = book.meta.id;
  Object.assign(book.meta, patch);
  const seq = ++state.aiSettingsSeq;

  const run = async () => {
    try {
      const { meta } = await api(`/books/${encodeURIComponent(bookId)}/meta`, {
        method: 'PUT',
        body: patch,
      });
      state.aiSettingsError = false;
      if (state.current?.meta.id !== bookId) return;
      if (seq !== state.aiSettingsSeq) return;
      state.current.meta = { ...state.current.meta, ...meta };
      renderAgentSettings();
    } catch (err) {
      state.aiSettingsError = true;
      toast(`设置没保存：${err.message}`, 'error');
    }
  };

  state.aiSettingsSave = state.aiSettingsSave.then(run, run);
  return state.aiSettingsSave;
}

export function renderAgentSettings() {
  const book = state.current;
  const fieldset = $('#ai-settings');
  if (!book || !fieldset) return;

  const enabled = Boolean(book.meta.aiEnabled);
  const busy = state.aiRunning || state.aiProposal?.status === 'pending';
  setDisabled(fieldset, !enabled || busy);

  const maxTokens = Number(book.meta.maxTokens) || DEFAULT_MAX_TOKENS;
  const maxSteps = STEP_PRESETS.includes(Number(book.meta.maxSteps))
    ? Number(book.meta.maxSteps)
    : DEFAULT_MAX_STEPS;
  const info = modelInfo(book.meta.model);
  const maxOutput = Number(info?.maxOutput) || 0;

  $$('#ai-max-tokens [data-max-tokens]').forEach((button) => {
    const value = Number(button.dataset.maxTokens);
    setHidden(button, Boolean(maxOutput) && value > maxOutput && value !== TOKEN_PRESETS[0]);
    button.classList.toggle('on', value === maxTokens);
  });

  $$('#ai-max-steps [data-max-steps]').forEach((button) => {
    button.classList.toggle('on', Number(button.dataset.maxSteps) === maxSteps);
  });

  if (maxOutput && maxTokens > maxOutput) {
    const fits = TOKEN_PRESETS.filter((value) => value <= maxOutput);
    const next = fits.length ? fits[fits.length - 1] : Math.max(TOKEN_MIN, Math.min(TOKEN_MAX, maxOutput));
    if (next !== maxTokens && next >= TOKEN_MIN) queueMetaPatch({ maxTokens: next });
  }

  const levels = Array.isArray(info?.reasoningLevels) ? info.reasoningLevels : [];
  const row = $('#ai-reasoning-row');
  const container = $('#ai-reasoning');
  if (row && container) {
    setHidden(row, levels.length === 0);
    if (levels.length) {
      const current = String(book.meta.reasoningEffort || '');
      const values = ['', ...levels];
      const signature = values.join('|');
      if (container.dataset.signature !== signature) {
        container.dataset.signature = signature;
        container.innerHTML = values.map((value) => {
          const label = value ? (REASONING_LABELS[value] || value.toUpperCase()) : '默认';
          return `<button type="button" data-reasoning-effort="${escapeHtml(value)}" class="${value === current ? 'on' : ''}">${escapeHtml(label)}</button>`;
        }).join('');
      } else {
        $$('button', container).forEach((button) => {
          button.classList.toggle('on', button.dataset.reasoningEffort === current);
        });
      }
      if (current && !levels.includes(current)) {
        queueMetaPatch({ reasoningEffort: '' });
      }
    }
  }

  const summaries = Array.isArray(book.summaries) ? book.summaries : [];
  const count = summaries.filter((item) => Number.isInteger(item.index)).length;
  const pendingSet = state.summaryPending.get(book.meta.id);
  const pendingCount = pendingSet ? pendingSet.size : 0;
  const summaryButton = $('#ai-summary-count');
  setDisabled(summaryButton, !enabled);
  setText(summaryButton, pendingCount ? '生成中…' : `${count} 条`);
}

export function setMaxTokens(value) {
  const book = state.current;
  if (!book) return;
  const number = Math.max(TOKEN_MIN, Math.min(TOKEN_MAX, Math.trunc(Number(value) || DEFAULT_MAX_TOKENS)));
  if (number === Number(book.meta.maxTokens)) return;
  aiLog('SYS', `OUTPUT / ${number} tok`);
  queueMetaPatch({ maxTokens: number });
}

export function setMaxSteps(value) {
  const book = state.current;
  if (!book) return;
  const number = Number(value);
  if (!STEP_PRESETS.includes(number) || number === Number(book.meta.maxSteps)) return;
  aiLog('SYS', `ROUNDS / ${number}`);
  queueMetaPatch({ maxSteps: number });
}

export function setReasoningEffort(value) {
  const book = state.current;
  if (!book) return;
  const next = String(value || '');
  if (next === String(book.meta.reasoningEffort || '')) return;
  aiLog('SYS', `DEPTH / ${next || '默认'}`);
  queueMetaPatch({ reasoningEffort: next });
}

export function updateAiControls() {
  const book = state.current;
  const enabled = Boolean(book?.meta.aiEnabled);
  const running = state.aiRunning;
  const pending = state.aiProposal?.status === 'pending';
  const busy = running || pending;
  const hasSelection = Boolean(state.selectionText);

  const instruction = $('#ai-instruction');
  setDisabled(instruction, !enabled || busy);
  setDisabled($('#ai-run'), !enabled || busy);
  setDisabled($('#ai-next'), !enabled || busy);
  setDisabled($('#ai-revise'), !enabled || busy || !hasSelection);
  setDisabled($('#selection-revise'), !enabled || busy || !hasSelection);
  setDisabled($('#audit-btn'), !enabled || busy);
  $$('#ai-mode button').forEach((button) => {
    setDisabled(button, !enabled || busy);
  });
  setHidden($('#ai-stop'), !running);

  setDisabled($('#ai-model-label'), !enabled || busy);

  const note = $('#ai-note');
  if (note) {
    note.classList.toggle('busy', running);
    setText(note, running
      ? 'RUNNING / 运行中'
      : pending
        ? 'DIFF / 等待确认'
        : !enabled
          ? 'AI 未开启'
          : state.aiMode === 'auto'
            ? 'AUTO / 直接写入'
            : 'DIFF / 先看提案');
  }

  renderAgentSettings();
}

export function openModelDialog() {
  const book = state.current;
  if (!book) return;
  const dialog = $('#model-dialog');
  if (!dialog) return;
  if (!dialog.open) dialog.showModal();
  const list = $('#model-list');
  if (list) list.innerHTML = '<div class="model-empty">读取模型…</div>';
  loadModelList(book.meta.id);
}

export async function loadModelList(bookId) {
  try {
    const { models } = await api('/models');
    const list = Array.isArray(models) ? models : [];
    for (const model of list) {
      if (model?.id) state.modelCatalog.set(model.id, model);
    }
    state.modelCatalogTried = true;
    if (!state.current || state.current.meta.id !== bookId) return;
    renderModelList(list);
  } catch (err) {
    const list = $('#model-list');
    if (list) list.innerHTML = `<div class="model-empty">${escapeHtml(err.message || '读取模型失败')}</div>`;
  }
}

export function renderModelList(models) {
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

export async function selectModel(model) {
  const book = state.current;
  const dialog = $('#model-dialog');
  if (!book || !model) return;

  if (state.aiRunning || state.aiProposal?.status === 'pending') {
    toast('运行中或等待确认时不能切换模型', 'error');
    return;
  }

  if (model === book.meta.model) {
    if (dialog?.open) dialog.close();
    return;
  }

  await ensureModelCatalog();
  const info = modelInfo(model);
  const maxOutput = Number(info?.maxOutput) || 0;
  const patch = { model };

  if (maxOutput && Number(book.meta.maxTokens || DEFAULT_MAX_TOKENS) > maxOutput) {
    const fits = TOKEN_PRESETS.filter((value) => value <= maxOutput);
    patch.maxTokens = fits.length
      ? fits[fits.length - 1]
      : Math.max(TOKEN_MIN, Math.min(TOKEN_MAX, maxOutput));
  }

  const levels = Array.isArray(info?.reasoningLevels) ? info.reasoningLevels : [];
  if (book.meta.reasoningEffort && !levels.includes(book.meta.reasoningEffort)) {
    patch.reasoningEffort = '';
  }

  const label = $('#ai-model-label');
  if (label) label.textContent = model;
  aiLog('SYS', `MODEL / ${model}${patch.maxTokens ? ` · ${patch.maxTokens} tok` : ''}`);
  if (dialog?.open) dialog.close();
  renderAgentSettings();
  await queueMetaPatch(patch);
}
