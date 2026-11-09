import { state } from '../core/state.js';
import { $ } from '../core/dom.js';
import { setAiState } from '../core/logger.js';
import {
  applyReviewChange as applyReviewChangeState,
  buildReviewDecisions as buildDecisions,
  buildReviewFrame,
  findQuoteRanges,
  mapRangeThroughEdit,
  normalizeReviewText,
} from '../core/review-frame.js';
import { hideSelection, refreshChapterNav, renderProse } from './manuscript.js';
import { updateReviewBar } from './review-view.js';
import { scheduleRulerRender } from './diff-ruler.js';
import { updateAiControls } from './ai-controls.js';
import {
  editorApplyReview,
  editorEnterReview,
  editorExitReview,
  editorIsActive,
  editorRequestMeasure,
  editorRevealReviewAnchor,
  editorSelectionRange,
  editorRevealReviewRange,
  editorScroller,
} from './editor.js';

let reviewVersion = 0;
let reviewHandlers = null;

function nextVersion() {
  reviewVersion += 1;
  return reviewVersion;
}

function sortedChanges(review) {
  return [...(review?.changes || [])].sort((a, b) => a.start - b.start);
}

function ensureChapterRoom(review) {
  if (review.action !== 'chapter' && !review.draftFinal) return;
  if (review.text.endsWith('\n\n')) return;
  review.text += review.text.endsWith('\n') ? '\n' : '\n\n';
}

function detachReviewScroll(review) {
  if (!review?.scroller || !review?.onScroll) return;
  review.scroller.removeEventListener('scroll', review.onScroll);
  review.scroller = null;
  review.onScroll = null;
}

function attachReviewScroll(review) {
  const scroller = editorScroller();
  if (!scroller) return;
  review.scroller = scroller;
  review.onScroll = () => {
    if (review.autoScrolling) return;
    review.follow = false;
  };
  scroller.addEventListener('scroll', review.onScroll, { passive: true });
}

function revealReview(review, { from = null, anchor = '' } = {}) {
  if (!review) return;
  review.autoScrolling = true;
  if (anchor) editorRevealReviewAnchor(anchor, review.version);
  else if (Number.isFinite(from)) editorRevealReviewRange(from);
  setTimeout(() => {
    if (state.aiReview === review) review.autoScrolling = false;
  }, 700);
}

function makeHandlers() {
  return {
    onEdit(id, value) {
      const review = state.aiReview;
      if (!review) return;
      const change = review.changes.find((item) => item.id === id);
      if (!change) return;
      change.edited = value;
      change.accepted = String(value).trim().length > 0;
    },
    measure() {
      editorRequestMeasure();
      scheduleRulerRender();
    },
  };
}

function syncReviewEditor(selection = null, { refreshChapters = true } = {}) {
  const review = state.aiReview;
  if (!review) return false;
  const frame = buildReviewFrame(review);
  editorApplyReview(frame, reviewHandlers, { text: review.text, selection });
  if (refreshChapters) refreshChapterNav();
  updateReviewBar();
  scheduleRulerRender();
  return true;
}

export function startReview(action, {
  selectionWords = 0,
  pendingQuotes = [],
  mode = 'diff',
  selection = null,
} = {}) {
  const book = state.current;
  if (!book) return;
  if (!editorIsActive()) renderProse();
  if (!editorIsActive()) return;

  const oldReview = state.aiReview;
  detachReviewScroll(oldReview);
  clearTimeout(state.aiDraftTimer);
  state.aiDraftTimer = null;

  const base = normalizeReviewText(book.manuscript || '');
  const review = {
    action,
    auto: mode === 'auto',
    base,
    text: base,
    changes: [],
    clusters: [],
    changeSeq: 0,
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
    pendingSelection: selection
      ? { from: Number(selection.from) || 0, to: Number(selection.to) || 0 }
      : null,
    quoteRanges: [],
    version: nextVersion(),
    follow: true,
    autoScrolling: false,
  };
  review.quoteRanges = findQuoteRanges(review.text, review.pendingQuotes);
  ensureChapterRoom(review);

  state.aiReview = review;
  state.aiProposal = null;
  reviewHandlers = makeHandlers();

  hideSelection();
  const modeLabel = $('#ms-mode-label');
  if (modeLabel) modeLabel.textContent = 'AI DIFF';
  updateReviewBar();
  editorEnterReview();
  attachReviewScroll(review);
  editorApplyReview(buildReviewFrame(review), reviewHandlers, {
    text: review.text,
    selection: review.pendingSelection
      ? { anchor: review.pendingSelection.from, head: review.pendingSelection.to }
      : null,
  });
  refreshChapterNav();
  updateReviewBar();
  scheduleRulerRender();

  if (action === 'chapter') {
    revealReview(review, { anchor: 'pending' });
  } else if (review.pendingSelection) {
    revealReview(review, { from: review.pendingSelection.from });
  } else if (review.quoteRanges.length) {
    revealReview(review, { from: review.quoteRanges[0].from });
  }
}

export function clearReview({ render = true } = {}) {
  const review = state.aiReview;
  detachReviewScroll(review);
  state.aiReview = null;
  state.aiProposal = null;
  clearTimeout(state.aiDraftTimer);
  state.aiDraftTimer = null;
  reviewHandlers = null;
  editorExitReview();
  const modeLabel = $('#ms-mode-label');
  if (modeLabel) modeLabel.textContent = 'EDIT';
  updateReviewBar();
  if (render) renderProse();
  updateAiControls();
  scheduleRulerRender();
}

export function applyChangeToReview(review, op, opIndex = null) {
  const applied = applyReviewChangeState(review, op, opIndex);
  if (applied) review.version = nextVersion();
  return applied;
}

export function applyPreviewOp(op) {
  const review = state.aiReview;
  if (!review || review.status !== 'streaming' || !op) return false;

  if (op.type === 'edit_outline') {
    review.notice = '大纲有修改，确认后写入左侧大纲。';
    review.progress = '';
    review.version = nextVersion();
    updateReviewBar();
    return true;
  }

  const nextId = `change-${(review.changeSeq || 0) + 1}`;
  const selectionBefore = editorSelectionRange();
  const applied = applyChangeToReview(review, op);
  if (!applied) return false;

  const appliedChange = review.changes.find((change) => change.id === nextId);
  let selection = null;
  if (selectionBefore && appliedChange) {
    const mapped = mapRangeThroughEdit(
      selectionBefore,
      appliedChange.start,
      appliedChange.old.length,
      appliedChange.new.length,
    );
    if (mapped) selection = { anchor: mapped.from, head: mapped.to };
  }
  syncReviewEditor(selection);
  if (review.follow) {
    const latest = review.changes.find((change) => change.id === nextId);
    if (latest) revealReview(review, { from: latest.start });
  }
  return true;
}

export function openProposalReview(proposal) {
  const book = state.current;
  if (!book || !proposal) return;
  if (!editorIsActive()) renderProse();
  if (!editorIsActive()) return;

  detachReviewScroll(state.aiReview);
  clearTimeout(state.aiDraftTimer);
  state.aiDraftTimer = null;

  state.aiProposal = proposal;
  const base = normalizeReviewText(book.manuscript || '');
  const review = {
    action: proposal.action || 'chat',
    auto: false,
    base,
    text: base,
    changes: [],
    clusters: [],
    changeSeq: 0,
    draft: '',
    draftFinal: false,
    status: 'proposal',
    proposal,
    notice: '',
    progress: '',
    selectionWords: 0,
    pendingQuotes: [],
    pendingSelection: null,
    quoteRanges: [],
    version: nextVersion(),
    follow: true,
    autoScrolling: false,
  };

  let hasOutline = false;
  const ops = Array.isArray(proposal.ops) ? proposal.ops : [];
  ops.forEach((op, index) => {
    if (op.type === 'edit_manuscript') applyReviewChangeState(review, op, index);
    else if (op.type === 'edit_outline') hasOutline = true;
    else if (op.type === 'append_chapter') {
      review.draft = normalizeReviewText(op.content || '');
      review.draftFinal = true;
    }
  });
  if (hasOutline) review.notice = '大纲有修改，确认后写入左侧大纲。';
  if (!review.changes.length && !review.draftFinal && !hasOutline) {
    review.notice = '这份提案没有可预览的改动。';
  }
  ensureChapterRoom(review);

  state.aiReview = review;
  reviewHandlers = makeHandlers();

  hideSelection();
  const modeLabel = $('#ms-mode-label');
  if (modeLabel) modeLabel.textContent = 'AI DIFF';
  updateReviewBar();
  editorEnterReview();
  attachReviewScroll(review);
  editorApplyReview(buildReviewFrame(review), reviewHandlers, { text: review.text });
  refreshChapterNav();
  updateReviewBar();
  scheduleRulerRender();

  if (review.draftFinal) revealReview(review, { anchor: 'pending' });
  else {
    const first = sortedChanges(review)[0];
    if (first) revealReview(review, { from: first.start });
  }

  setAiState('PROPOSAL', 'proposal');
  updateAiControls();
}

export function scheduleDraftRender() {
  if (state.aiDraftTimer) return;
  const version = state.aiReview?.version;
  state.aiDraftTimer = setTimeout(() => {
    state.aiDraftTimer = null;
    if (!state.aiReview || state.aiReview.version !== version) return;
    updateDraftPreview();
  }, 80);
}

export function updateDraftPreview() {
  const review = state.aiReview;
  if (!review) return;

  const scroller = editorScroller();
  const section = scroller?.querySelector('[data-review-anchor="pending"]');
  const rect = section?.getBoundingClientRect();
  const hostRect = scroller?.getBoundingClientRect();
  const headTop = rect?.top ?? null;
  const headVisible = Boolean(rect && hostRect && rect.bottom > hostRect.top && rect.top < hostRect.bottom);

  syncReviewEditor(null, { refreshChapters: false });
  updateReviewBar();

  if (scroller && headVisible && Number.isFinite(headTop)) {
    requestAnimationFrame(() => {
      if (!scroller.isConnected) return;
      const next = scroller.querySelector('[data-review-anchor="pending"]');
      if (!next) return;
      const delta = next.getBoundingClientRect().top - headTop;
      if (Math.abs(delta) > 1) scroller.scrollTop += delta;
    });
  }
}

export function buildReviewDecisions() {
  return buildDecisions(state.aiReview);
}
