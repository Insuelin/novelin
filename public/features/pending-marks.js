import { state } from '../core/state.js';
import { $, $$ } from '../core/dom.js';

export function clearPendingMarks(root = $('#prose')) {
  if (!root) return;
  $$('.ai-selection-pending', root).forEach((mark) => {
    mark.replaceWith(...mark.childNodes);
  });
}

export function wrapTextRange(range) {
  if (!range || range.collapsed) return null;
  const prose = $('#prose');
  if (!prose || prose.querySelector('.cm-editor')) return null;
  if (!prose.contains(range.commonAncestorContainer)) return null;

  const nodes = [];
  const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  while (walker.nextNode()) nodes.push(walker.currentNode);

  let first = null;
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    let start = 0;
    let end = node.nodeValue.length;
    if (node === range.startContainer) start = range.startOffset;
    if (node === range.endContainer) end = range.endOffset;
    if (start >= end) continue;

    const target = start > 0 ? node.splitText(start) : node;
    if (end - start < target.nodeValue.length) target.splitText(end - start);

    const mark = document.createElement('span');
    mark.className = 'ai-selection-pending';
    target.parentNode.insertBefore(mark, target);
    mark.appendChild(target);
    first = mark;
  }
  return first;
}

export function plainQuoteText(value) {
  return String(value)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-+*]\s+|\d+\.\s+)/gm, '')
    .replace(/[*_~`]+/g, '')
    .replace(/\\([\\`*_{}\[\]()#+\-.!])/g, '$1');
}

export function findQuoteRange(prose, quote) {
  const value = String(quote || '');
  if (!prose || !value) return null;

  const nodes = [];
  let text = '';
  const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      if (node.parentElement?.closest('.ai-pending-chapter, .ai-review-note')) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  while (walker.nextNode()) {
    const node = walker.currentNode;
    nodes.push({ node, start: text.length });
    text += node.nodeValue;
  }

  let needle = value;
  let index = text.indexOf(needle);
  if (index < 0) {
    needle = plainQuoteText(value);
    if (needle && needle !== value) index = text.indexOf(needle);
  }
  if (index < 0) return null;

  const locate = (position, isEnd = false) => {
    for (const item of nodes) {
      const end = item.start + item.node.nodeValue.length;
      if (position < end || (isEnd && position === end)) {
        return { node: item.node, offset: position - item.start };
      }
    }
    const last = nodes[nodes.length - 1];
    return last ? { node: last.node, offset: last.node.nodeValue.length } : null;
  };

  const start = locate(index);
  const end = locate(index + needle.length, true);
  if (!start || !end) return null;

  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);

  const blocked = prose.querySelectorAll('.ai-del, .ai-ins, .ai-change-block, .ai-selection-pending');
  for (const element of blocked) {
    if (range.intersectsNode(element)) return null;
  }
  return range;
}

export function markPendingQuotes(quotes, { scroll = false } = {}) {
  const prose = $('#prose');
  if (!prose) return 0;

  clearPendingMarks(prose);
  let first = null;
  let count = 0;
  for (const quote of quotes || []) {
    const range = findQuoteRange(prose, quote);
    if (!range) continue;
    const mark = wrapTextRange(range);
    if (!mark) continue;
    if (!first) first = mark;
    count += 1;
  }
  if (first && scroll) first.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return count;
}

export function markReviewPending({ scroll = false } = {}) {
  const review = state.aiReview;
  if (!review || !Array.isArray(review.pendingQuotes) || !review.pendingQuotes.length) return 0;
  return markPendingQuotes(review.pendingQuotes, { scroll });
}

export function markPendingSelection() {
  const prose = $('#prose');
  const selection = window.getSelection();
  if (!prose || prose.querySelector('.cm-editor')) return false;
  if (!selection || selection.isCollapsed || !selection.rangeCount) return false;

  const range = selection.getRangeAt(0);
  if (!prose.contains(range.commonAncestorContainer)) return false;

  clearPendingMarks(prose);
  const first = wrapTextRange(range);
  selection.removeAllRanges();
  if (first) first.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return Boolean(first);
}
