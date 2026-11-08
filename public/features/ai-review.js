import { state } from '../core/state.js';
import { $ } from '../core/dom.js';
import { marked, sanitizeHtml, renderBlockMath, renderMath } from '../core/markdown.js';
import { setAiState } from '../core/logger.js';
import { isNearBottom, scrollManuscriptToEnd, scrollToPendingChapter, scrollToReviewChange } from '../ui/layout.js';
import { renderProse, hideSelection, setManuscriptMode } from './manuscript.js';
import { reviewChangesSorted, updateReviewBar } from './review-view.js';
import { scheduleRulerRender } from './diff-ruler.js';
import { updateAiControls } from './ai-controls.js';

/* ---------- ai review ---------- */
export function startReview(action, { selectionWords = 0, preserveSelection = false, pendingQuotes = [], mode = 'diff' } = {}) {
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
    pendingQuotes: (Array.isArray(pendingQuotes) ? pendingQuotes : [])
      .map((quote) => String(quote || '').trim())
      .filter(Boolean),
  };
  state.aiProposal = null;

  if (state.manuscriptMode === 'edit') setManuscriptMode('read');
  hideSelection();
  updateReviewBar();
  if (!preserveSelection) renderProse();
  scheduleRulerRender();
}

export function clearReview({ render = true } = {}) {
  state.aiReview = null;
  state.aiProposal = null;
  clearTimeout(state.aiDraftTimer);
  state.aiDraftTimer = null;
  updateReviewBar();
  if (render) renderProse();
}

export function applyChangeToReview(review, op, opIndex = null) {
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

export function applyPreviewOp(op) {
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

export function openProposalReview(proposal) {
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

export function updateDraftPreview() {
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
      body.innerHTML = sanitizeHtml(review.draft.trim()
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

export function buildReviewDecisions() {
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
