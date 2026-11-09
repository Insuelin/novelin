import { state } from '../core/state.js';
import { $, $$ } from '../core/dom.js';
import { compactValue, countWords } from '../core/format.js';
import { API, api, streamAiResponse } from '../core/api.js';
import { aiLog, setAiState } from '../core/logger.js';
import { toast } from '../ui/toast.js';
import { ensureModelCatalog, queueMetaPatch, renderAgentSettings, updateAiControls } from './ai-controls.js';
import { markPendingSelection, markReviewPending } from './pending-marks.js';
import { startReview, clearReview, applyPreviewOp, openProposalReview, buildReviewDecisions, scheduleDraftRender } from './ai-review.js';
import { updateReviewBar } from './review-view.js';
import { markSummaryPending, startAppendedSummaries } from './summaries.js';
import { flushSave } from './persistence.js';
import { bus } from '../core/bus.js';

/* ---------- agent ---------- */
export function renderAgent({ reset = false } = {}) {
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

export async function setAiMode(mode) {
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
    append_chapter: '撰写新章…',
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
    const appended = Array.isArray(payload.appended) ? payload.appended : [];
    const bookId = state.current?.meta.id;
    if (appended.length && bookId) {
      markSummaryPending(bookId, appended);
      startAppendedSummaries(bookId, appended);
    }
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
    const message = String(payload.message || '').trim();
    if (message) aiLog('AI', message);
    return;
  }
}

export async function runAi({ action = 'chapter', useSelection = false, plotItems = [], instruction: presetInstruction = '' } = {}) {
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

  const typed = String(presetInstruction || $('#ai-instruction')?.value || '').trim().slice(0, 8000);
  let instruction = typed;
  if (action === 'chat' && !instruction) {
    toast('先在指令框写要做什么', 'error');
    return;
  }
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
  let appendedWritten = false;
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
      if (type === 'written') {
        written = true;
        if (Array.isArray(payload.appended) && payload.appended.length) appendedWritten = true;
      }
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
      await bus.emit('book:refresh', { scrollEnd: action === 'chapter' || appendedWritten });
    }
    if (!state.aiProposal && !hadError) {
      if (state.aiReview) {
        clearReview();
        if (!written && !noticedNoChange && action !== 'chat') {
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

export function stopAi() {
  if (!state.aiRunning || !state.aiAbort) return;
  aiLog('SYS', '停止中…');
  state.aiAbort.abort();
}

export async function respondProposal(action) {
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
      await bus.emit('book:refresh', { scrollEnd });
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
