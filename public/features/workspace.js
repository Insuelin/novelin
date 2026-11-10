import { state } from '../core/state.js';
import { $, $$ } from '../core/dom.js';
import { bus } from '../core/bus.js';
import { getManuscriptTitle, formatNumber } from '../core/format.js';
import { api } from '../core/api.js';
import { toast, setSaveState } from '../ui/toast.js';
import { syncStickyHeight } from '../ui/layout.js';
import { setMaxTokens, setMaxSteps, setReasoningEffort, openModelDialog, selectModel } from './ai-controls.js';
import { wireDiffRuler } from './diff-ruler.js';
import {
  updateSummaryHint,
  scheduleSummarySave,
  openSummaryDialog,
  startSummaryTagEdit,
  commitSummaryTagEdit,
  deleteSummaryTag,
  summaryTagChapter,
  regenerateSummary,
  backfillSummaries,
  regenerateStaleSummaries,
  deleteSummaryOrphan,
  flushSummaryTimers,
} from './summaries.js';
import { openTermsDialog, previewTermClean, applyTermClean, removeSavedTerm } from './terms.js';
import {
  updateAuditRewriteState,
  updateAuditScopeState,
  selectAllAuditChapters,
  clearAuditChapters,
  openAuditDialog,
  scanPlotIssues,
  stopAuditScan,
  rewriteAuditItems,
} from './audit.js';
import {
  openChapterMenu,
  closeChapterMenu,
  jumpToChapter,
  updateChapterFromScroll,
  renderProse,
  hideSelection,
} from './manuscript.js';
import { clearReview } from './ai-review.js';
import {
  editorIsActive,
  editorScrollTo,
  editorScrollTop,
  editorSetScrollTop,
} from './editor.js';
import { renderAgent, setAiMode, runAi, stopAi, respondProposal } from './ai-agent.js';
import { syncMaterials } from './materials.js';
import { updateBookSummary } from './library.js';
import { updateTitleDisplay, startTitleEdit, stopTitleEdit, commitTitleEdit, markDirty, saveAll } from './persistence.js';

function activateTab(name) {
  $$('#briefing-tabs button').forEach((button) => {
    button.classList.toggle('on', button.dataset.tab === name);
  });
  $$('.tab-pane').forEach((pane) => {
    pane.classList.toggle('on', pane.dataset.pane === name);
  });
}

function selectInTextarea(textarea, query) {
  if (!textarea || !query) return;
  const index = textarea.value.indexOf(query);
  if (index >= 0) {
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(index, index + query.length);
  }
}

function applyPendingSearch() {
  if (!state.pendingSection) return;

  const section = state.pendingSection;
  const query = state.pendingQuery;

  if (section === 'outline' || section === 'notes') {
    activateTab(section);
    selectInTextarea(section === 'outline' ? $('#outline-editor') : $('#notes-editor'), query);
  }

  state.pendingSection = '';
  state.pendingQuery = '';
}

/* ---------- workspace ---------- */
export function renderWorkspace() {
  const book = state.current;
  if (!book) return;

  closeChapterMenu();
  if (state.termsBookId && state.termsBookId !== book.meta.id) {
    const termsDialog = $('#terms-dialog');
    if (termsDialog?.open) termsDialog.close();
    state.termsBookId = '';
  }
  if (state.auditBookId && state.auditBookId !== book.meta.id) {
    state.auditAbort?.abort();
    state.auditAbort = null;
    const auditDialog = $('#audit-dialog');
    if (auditDialog?.open) auditDialog.close();
    state.auditBookId = '';
    state.auditIssues = [];
  }
  if (state.summaryBookId && state.summaryBookId !== book.meta.id) {
    const summaryDialog = $('#summary-dialog');
    if (summaryDialog?.open) summaryDialog.close();
    state.summaryBookId = '';
    state.summaryChapters = [];
    state.summaryOrphans = [];
  }
  if (state.aiBookId && state.aiBookId !== book.meta.id) clearReview({ render: false });
  const stats = book.stats || { words: 0, chapters: 0 };
  const aiLabel = book.meta.aiEnabled
    ? `AI ${String(book.meta.aiMode || 'diff').toUpperCase()}`
    : 'READ ONLY';

  state.currentChapter = 0;
  state.titleEditing = false;
  state.titleDirty = false;
  state.loadedHeading = getManuscriptTitle(book.manuscript)?.title || '';
  const titleInput = $('#ms-title-input');
  if (titleInput) {
    titleInput.hidden = true;
    titleInput.value = '';
  }
  const titleElement = $('#ms-title');
  if (titleElement) titleElement.hidden = false;
  $('#ws-breadcrumb').textContent = book.meta.title;
  $('#ws-status').textContent = aiLabel;
  updateTitleDisplay();
  $('#ms-words').textContent = `${formatNumber(stats.words)} 字`;
  $('#theme-editor').value = book.meta.theme || '';
  $('#outline-editor').value = book.outline || '';
  $('#notes-editor').value = book.notes || '';
  $('#ai-model-label').textContent = book.meta.model || '—';

  setSaveState('SAVED', 'ok');
  activateTab('theme');
  renderProse();
  hideSelection();
  renderAgent();
  syncMaterials();
  applyPendingSearch();
  requestAnimationFrame(syncStickyHeight);
}

export async function refreshBookAfterAi({ scrollToChapter = null } = {}) {
  const book = state.current;
  if (!book) return;

  const bookId = book.meta.id;
  const tab = $('#briefing-tabs button.on')?.dataset.tab || 'theme';
  const editorMode = editorIsActive();
  const scroll = editorMode ? editorScrollTop() : ($('.manuscript')?.scrollTop || 0);

  try {
    const { book: next } = await api(`/books/${encodeURIComponent(bookId)}`);
    if (state.current?.meta.id !== bookId) return;
    state.current = next;
    state.dirty.clear();

    if (state.view === 'workspace') {
      renderWorkspace();
      activateTab(tab);
      requestAnimationFrame(() => {
        if (editorIsActive()) {
          if (Number.isInteger(scrollToChapter)) {
            const chapter = state.chapters[scrollToChapter - 1];
            editorScrollTo(chapter?.start || 0);
          } else {
            editorSetScrollTop(scroll);
          }
          return;
        }
        const manuscript = $('.manuscript');
        if (manuscript) manuscript.scrollTop = scroll;
      });
    }

    updateBookSummary(bookId);
  } catch (err) {
    toast(`刷新失败：${err.message}`, 'error');
  }
}

/* ---------- briefing ---------- */
const BRIEFING_LABELS = {
  theme: '主题 / THEME',
  outline: '大纲 / OUTLINE',
  notes: '笔记 / NOTES',
};

function openBriefingEditor(section) {
  const book = state.current;
  if (!book) return;

  if (!BRIEFING_LABELS[section]) {
    section = $('#briefing-tabs button.on')?.dataset.tab || 'theme';
  }
  const value = section === 'theme' ? (book.meta.theme || '') : (book[section] || '');

  state.briefingSection = section;
  state.briefingBookId = book.meta.id;

  $('#briefing-dialog-title').textContent = BRIEFING_LABELS[section] || section;
  const textarea = $('#briefing-dialog-text');
  textarea.value = value;
  textarea.dataset.section = section;

  const dialog = $('#briefing-dialog');
  if (!dialog.open) dialog.showModal();
  setTimeout(() => {
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, 30);
}

function syncBriefingDialog() {
  const section = state.briefingSection;
  const book = state.current;
  if (!section || !book || book.meta.id !== state.briefingBookId) return;

  const value = $('#briefing-dialog-text').value;
  const inline = section === 'theme'
    ? $('#theme-editor')
    : section === 'outline'
      ? $('#outline-editor')
      : $('#notes-editor');
  if (inline) inline.value = value;

  if (section === 'theme') book.meta.theme = value;
  else book[section] = value;

  markDirty(section);
}

export function flushBriefingDialog() {
  if (!state.briefingSection) return;
  saveAll().catch(() => {});
}

/* ---------- events ---------- */
export function wireWorkspaceEvents() {
  bus.on('book:refresh', (payload = {}) => refreshBookAfterAi(payload));

  $('#briefing-tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-tab]');
    if (button) activateTab(button.dataset.tab);
  });

  $('#ms-title').addEventListener('click', startTitleEdit);
  $('#ms-title').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      startTitleEdit();
    }
  });
  $('#ms-title-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitTitleEdit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      stopTitleEdit();
    }
  });
  $('#ms-title-input').addEventListener('blur', () => {
    if (state.titleEditing) commitTitleEdit();
  });

  $('#chapter-btn').addEventListener('click', (event) => {
    event.stopPropagation();
    openChapterMenu($('#chapter-menu').hidden);
  });

  $('#chapter-menu').addEventListener('click', (event) => {
    const item = event.target.closest('[data-chapter]');
    if (item) jumpToChapter(Number(item.dataset.chapter));
  });

  const manuscriptEl = $('.manuscript');
  let chapterScrollFrame = 0;
  manuscriptEl.addEventListener('scroll', () => {
    if (chapterScrollFrame) return;
    chapterScrollFrame = requestAnimationFrame(() => {
      chapterScrollFrame = 0;
      updateChapterFromScroll();
    });
  }, { passive: true });

  wireDiffRuler();

  window.addEventListener('resize', () => {
    requestAnimationFrame(() => {
      syncStickyHeight();
      updateChapterFromScroll();
    });
  });

  const sticky = $('.ms-sticky');
  if (sticky && typeof ResizeObserver !== 'undefined') {
    state.stickyObserver = new ResizeObserver(() => syncStickyHeight());
    state.stickyObserver.observe(sticky);
  }
  syncStickyHeight();

  $('#save-briefing').addEventListener('click', () => saveAll({ notify: true }));
  $$('.editor-box').forEach((box) => {
    box.addEventListener('mousedown', (event) => {
      const rect = box.getBoundingClientRect();
      if (event.clientX < rect.right - 26 || event.clientY < rect.bottom - 26) return;
      event.preventDefault();
      const section = box.querySelector('.editor')?.id.replace(/-editor$/, '');
      openBriefingEditor(section);
    });
  });
  $('#briefing-dialog-text').addEventListener('input', syncBriefingDialog);
  $('#briefing-dialog').addEventListener('close', flushBriefingDialog);
  $('#ai-model-label')?.addEventListener('click', openModelDialog);
  $('#model-list')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-model]');
    if (button) selectModel(button.dataset.model);
  });

  $('#ai-settings')?.addEventListener('click', (event) => {
    const token = event.target.closest('[data-max-tokens]');
    if (token) {
      setMaxTokens(token.dataset.maxTokens);
      return;
    }
    const step = event.target.closest('[data-max-steps]');
    if (step) {
      setMaxSteps(step.dataset.maxSteps);
      return;
    }
    const reasoning = event.target.closest('[data-reasoning-effort]');
    if (reasoning) {
      setReasoningEffort(reasoning.dataset.reasoningEffort);
      return;
    }
    if (event.target.closest('#ai-summary-count')) openSummaryDialog();
  });

  $('#summary-list')?.addEventListener('input', (event) => {
    const textarea = event.target.closest('[data-summary-index]');
    if (!textarea) return;
    const index = Number(textarea.dataset.summaryIndex);
    const chapter = state.summaryChapters.find((item) => item.index === index);
    if (!chapter) return;
    chapter.summary = textarea.value;
    chapter.hasSummary = Boolean(textarea.value.trim());
    scheduleSummarySave(index);
  });

  $('#summary-list')?.addEventListener('mousedown', (event) => {
    if (event.target.closest('.summary-tag-del')) event.preventDefault();
  });

  $('#summary-list')?.addEventListener('keydown', (event) => {
    const span = event.target.closest('.summary-tag-text');
    if (!span) return;
    if (!span.isContentEditable) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        startSummaryTagEdit(span);
      }
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      span.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      span.dataset.cancel = '1';
      span.blur();
    }
  });

  $('#summary-list')?.addEventListener('focusout', (event) => {
    const span = event.target.closest?.('.summary-tag-text');
    if (!span?.isContentEditable) return;
    const cancel = span.dataset.cancel === '1';
    delete span.dataset.cancel;
    commitSummaryTagEdit(span, { cancel });
  });

  $('#summary-list')?.addEventListener('click', (event) => {
    const del = event.target.closest('.summary-tag-del');
    if (del) {
      const chip = del.closest('.summary-tag');
      const chapter = summaryTagChapter(del);
      deleteSummaryTag(chapter, chip?.dataset.tagKey, Number(chip?.dataset.tagIndex));
      return;
    }

    const tagText = event.target.closest('.summary-tag-text');
    if (tagText) {
      event.preventDefault();
      startSummaryTagEdit(tagText);
      return;
    }

    const orphan = event.target.closest('[data-orphan-delete]');
    if (orphan) {
      event.preventDefault();
      deleteSummaryOrphan({
        title: orphan.dataset.orphanTitle || '',
        at: orphan.dataset.orphanAt || '',
        sourceHash: orphan.dataset.orphanHash || '',
      });
      return;
    }

    const button = event.target.closest('[data-summary-regenerate]');
    if (!button) return;
    regenerateSummary(Number(button.dataset.summaryRegenerate));
  });

  $('#summary-generate-missing')?.addEventListener('click', backfillSummaries);
  $('#summary-regenerate-stale')?.addEventListener('click', regenerateStaleSummaries);
  $('#summary-stop')?.addEventListener('click', () => {
    state.summaryStop = true;
    updateSummaryHint('停止中…等已发出的章节完成');
  });
  $('#summary-dialog')?.addEventListener('close', () => {
    if (state.summaryBusy) state.summaryStop = true;
    flushSummaryTimers().catch(() => {});
  });

  $('#terms-btn')?.addEventListener('click', openTermsDialog);
  $('#terms-preview')?.addEventListener('click', () => {
    previewTermClean().catch((err) => toast(err.message || '预览失败', 'error'));
  });
  $('#terms-apply')?.addEventListener('click', applyTermClean);
  $('#terms-saved')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-term-remove]');
    if (!button) return;
    removeSavedTerm(Number(button.dataset.termRemove));
  });
  $('#terms-dialog')?.addEventListener('close', () => {
    state.termsBookId = '';
  });

  $('#audit-btn')?.addEventListener('click', openAuditDialog);
  $('#audit-chapters')?.addEventListener('change', updateAuditScopeState);
  $('#audit-scope-all')?.addEventListener('click', selectAllAuditChapters);
  $('#audit-scope-none')?.addEventListener('click', clearAuditChapters);
  $('#audit-scan')?.addEventListener('click', () => {
    scanPlotIssues().catch((err) => toast(err.message || '审查失败', 'error'));
  });
  $('#audit-stop')?.addEventListener('click', stopAuditScan);
  $('#audit-rewrite')?.addEventListener('click', rewriteAuditItems);
  $('#audit-list')?.addEventListener('change', updateAuditRewriteState);
  $('#audit-dialog')?.addEventListener('close', () => {
    state.auditAbort?.abort();
    state.auditAbort = null;
    state.auditBookId = '';
    state.auditIssues = [];
    state.auditQuery = '';
  });

  ['#ai-revise', '#selection-revise'].forEach((selector) => {
    const button = $(selector);
    if (button) button.addEventListener('mousedown', (event) => event.preventDefault());
  });

  $('#ai-mode').addEventListener('click', (event) => {
    const button = event.target.closest('[data-ai-mode]');
    if (button) setAiMode(button.dataset.aiMode);
  });

  $('#ai-run').addEventListener('click', () => runAi({ action: 'chat' }));
  $('#ai-next').addEventListener('click', () => runAi({ action: 'chapter' }));
  $('#ai-revise').addEventListener('click', () => runAi({ action: 'revise', useSelection: true }));
  $('#selection-revise').addEventListener('click', () => runAi({ action: 'revise', useSelection: true }));
  $('#ai-stop').addEventListener('click', () => stopAi());

  $('#review-bar').addEventListener('click', (event) => {
    const button = event.target.closest('[data-review-action]');
    if (button) {
      respondProposal(button.dataset.reviewAction);
      return;
    }
    if (event.target.closest('#review-stop')) stopAi();
  });

  $('#ai-instruction').addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      runAi({ action: 'chat' });
    }
  });

  $('#theme-editor').addEventListener('input', () => {
    if (!state.current) return;
    state.current.meta.theme = $('#theme-editor').value;
    markDirty('theme');
  });

  $('#outline-editor').addEventListener('input', () => {
    if (!state.current) return;
    state.current.outline = $('#outline-editor').value;
    markDirty('outline');
  });

  $('#notes-editor').addEventListener('input', () => {
    if (!state.current) return;
    state.current.notes = $('#notes-editor').value;
    markDirty('notes');
  });

}
