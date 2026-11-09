import { state } from '../core/state.js';
import { $, $$ } from '../core/dom.js';
import { countWords, formatNumber } from '../core/format.js';
import { syncStickyHeight } from '../ui/layout.js';

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
    if (review.notice) bits.push(review.notice);
    label = `AI DIFF · ${bits.length ? `${bits.join(' · ')} · ` : ''}待确认`;
  } else if (review.action === 'revise' && review.selectionWords) {
    const progress = review.progress ? ` · ${review.progress}` : '';
    label = `${prefix} · 正在改写选中 · ${review.selectionWords} 字${progress}`;
  } else if (review.progress) {
    label = `${prefix} · ${review.progress}`;
  } else if (review.action === 'chapter') {
    label = `${prefix} · 新章生成中${review.draft ? ` · ${formatNumber(countWords(review.draft))} 字` : ''}`;
  } else if (review.notice) {
    label = `${prefix} · ${review.notice}`;
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
