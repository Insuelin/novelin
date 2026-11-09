import { state } from '../core/state.js';
import { $, $$, escapeHtml } from '../core/dom.js';
import { countWords, formatNumber } from '../core/format.js';
import { marked } from '../core/markdown.js';
import { syncStickyHeight } from '../ui/layout.js';

export function reviewChangeHtml(change, index) {
  const oldText = String(change.old || '');
  const newText = String(change.new || '');
  const blockLevel = /[\r\n]/.test(oldText) || /[\r\n]/.test(newText)
    || oldText.length + newText.length > 1600;

  if (blockLevel) {
    return `<div class="ai-change-block" data-change="${index}">
      <div class="ai-old"><span class="ai-diff-label">OLD / 原文</span>${marked.parse(oldText, { breaks: true, gfm: true })}</div>
      <div class="ai-new"><span class="ai-diff-label">NEW / 改写</span>${marked.parse(newText, { breaks: true, gfm: true })}</div>
    </div>`;
  }

  const oldHtml = oldText ? `<del class="ai-del">${escapeHtml(oldText)}</del>` : '';
  const newHtml = newText ? `<ins class="ai-ins" data-change="${index}">${marked.parseInline(newText)}</ins>` : '';
  return `${oldHtml}${newHtml}`;
}

export function buildReviewSource(review) {
  let source = '';
  let cursor = 0;
  const changes = [...(review.changes || [])].sort((a, b) => a.start - b.start);
  changes.forEach((change, index) => {
    if (change.start < cursor) return;
    source += review.text.slice(cursor, change.start);
    source += reviewChangeHtml(change, index);
    cursor = Math.max(cursor, change.end);
  });
  source += review.text.slice(cursor);
  return source;
}

export function reviewChangesSorted(review) {
  return [...(review.changes || [])].sort((a, b) => a.start - b.start);
}

export function growReviewEditor(element) {
  element.style.height = 'auto';
  element.style.height = `${element.scrollHeight}px`;
}

export function hydrateReviewEditors(root) {
  const review = state.aiReview;
  if (!review || !root) return;
  const changes = reviewChangesSorted(review);

  $$('.ai-change-block[data-change]', root).forEach((block) => {
    const change = changes[Number(block.dataset.change)];
    const box = block.querySelector('.ai-new');
    if (!change || !box) return;

    const label = box.querySelector('.ai-diff-label');
    [...box.childNodes].forEach((node) => {
      if (node !== label) node.remove();
    });

    const textarea = document.createElement('textarea');
    textarea.className = 'ai-new-input';
    textarea.dataset.change = block.dataset.change;
    textarea.spellcheck = false;
    textarea.rows = 1;
    textarea.value = change.edited !== undefined ? change.edited : change.new;
    box.appendChild(textarea);
    growReviewEditor(textarea);
  });

  $$('ins.ai-ins[data-change]', root).forEach((ins) => {
    const change = changes[Number(ins.dataset.change)];
    if (!change) return;
    if (change.edited !== undefined) ins.textContent = change.edited;
    ins.setAttribute('contenteditable', 'plaintext-only');
    ins.setAttribute('spellcheck', 'false');
  });
}

export function renderPendingChapter(review) {
  if (!review || review.action !== 'chapter') return '';
  const body = review.draft.trim()
    ? marked.parse(review.draft, { breaks: true, gfm: true })
    : '<p class="ai-pending-empty">AI 正在写下一章…</p>';
  const heading = review.auto ? 'AI WRITING / 写入中' : 'PENDING CHAPTER / 待确认';
  return `<section class="ai-pending-chapter" id="ai-pending-chapter">
    <div class="ai-pending-head"><span>${heading}</span><span>${review.draftFinal ? 'READY' : 'STREAMING'}</span></div>
    <div class="ai-pending-body" id="ai-pending-body">${body}</div>
    ${review.draftFinal ? '' : '<span class="ai-pending-cursor" aria-hidden="true"></span>'}
  </section>`;
}

export function updateReviewBar() {
  const review = state.aiReview;
  const bar = $('#review-bar');
  if (bar) bar.hidden = !review;

  if (!review) return;

  const pending = review.proposal?.status === 'pending';
  const changeCount = review.changes.length;
  const prefix = review.auto ? 'AI WRITE' : 'AI DIFF';
  let label;

  if (review.status === 'proposal') {
    const bits = [];
    if (changeCount) bits.push(`${changeCount} 处修改`);
    if (review.draftFinal) bits.push('新章');
    if (review.notice) bits.push('大纲修改');
    label = `AI DIFF · ${bits.length ? `${bits.join(' · ')} · ` : ''}待确认`;
  } else if (review.action === 'revise' && review.selectionWords) {
    const progress = review.progress ? ` · ${review.progress}` : '';
    label = `${prefix} · 正在改写选中 · ${review.selectionWords} 字${progress}`;
  } else if (review.progress) {
    label = `${prefix} · ${review.progress}`;
  } else if (review.action === 'chapter') {
    label = `${prefix} · 新章生成中${review.draft ? ` · ${formatNumber(countWords(review.draft))} 字` : ''}`;
  } else {
    label = `${prefix} · ${changeCount ? `${changeCount} 处修改 · ` : ''}${review.auto ? '写入中' : '分析中'}`;
  }

  const labelElement = $('#review-label');
  if (labelElement) labelElement.textContent = label;
  if (bar) bar.dataset.state = review.status;

  const stop = $('#review-stop');
  if (stop) stop.hidden = review.status !== 'streaming';

  $$('#review-bar [data-review-action]').forEach((button) => {
    button.hidden = !pending;
    button.disabled = !pending;
  });
  requestAnimationFrame(syncStickyHeight);
}
