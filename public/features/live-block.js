import { parseBlockParts } from '../core/live-markup.js';

function marker(text, side = '') {
  const span = document.createElement('span');
  span.className = side ? `live-mark live-mark-${side}` : 'live-mark';
  span.textContent = text;
  return span;
}

function sourceBreak(text) {
  const span = document.createElement('span');
  span.className = 'live-src-break';
  span.setAttribute('contenteditable', 'false');
  span.textContent = text;
  return span;
}

function appendInline(parent, parts) {
  for (const part of parts || []) {
    if (part.type === 'text') {
      parent.appendChild(document.createTextNode(part.text));
      continue;
    }

    if (part.type === 'escape') {
      const wrap = document.createElement('span');
      wrap.className = 'live-reveal live-escape';
      wrap.dataset.open = part.marker;
      wrap.appendChild(marker(part.marker, 'open'));
      wrap.appendChild(document.createTextNode(part.text));
      parent.appendChild(wrap);
      continue;
    }

    if (part.type === 'inline') {
      const wrap = document.createElement('span');
      wrap.className = `live-reveal live-${part.kind}`;
      wrap.dataset.open = part.open;
      wrap.dataset.close = part.close;
      wrap.appendChild(marker(part.open, 'open'));

      const formatted = document.createElement(part.tag);
      appendInline(formatted, part.children);
      wrap.appendChild(formatted);

      wrap.appendChild(marker(part.close, 'close'));
      parent.appendChild(wrap);
      continue;
    }

    if (part.type === 'link') {
      const wrap = document.createElement('span');
      wrap.className = 'live-link';
      wrap.appendChild(marker(part.open, 'open'));
      const text = document.createElement('span');
      text.className = 'live-link-text';
      appendInline(text, part.children);
      wrap.appendChild(text);
      wrap.appendChild(marker(part.close, 'close'));
      parent.appendChild(wrap);
    }
  }
}

function buildParagraph(part) {
  const root = document.createElement('p');
  root.className = 'live-block live-paragraph';
  appendInline(root, part.children);
  return root;
}

function buildHeading(part) {
  const root = document.createElement(`h${part.level}`);
  root.className = `live-block live-heading live-heading-h${part.level} live-reveal`;
  root.dataset.open = part.prefix;
  root.appendChild(marker(part.prefix, 'open'));
  appendInline(root, part.children);
  return root;
}

function buildList(part) {
  const root = document.createElement(part.ordered ? 'ol' : 'ul');
  root.className = `live-block live-list live-list-${part.ordered ? 'ordered' : 'unordered'}`;
  if (part.ordered) root.start = part.start;

  for (const item of part.items) {
    const li = document.createElement('li');
    li.className = 'live-list-item live-reveal';
    li.dataset.open = item.prefix;
    li.appendChild(marker(item.prefix, 'open'));
    appendInline(li, item.children);
    if (item.trail) li.appendChild(sourceBreak(item.trail));
    root.appendChild(li);
  }

  return root;
}

function buildQuote(part) {
  const root = document.createElement('blockquote');
  root.className = 'live-block live-quote';
  let paragraph = null;

  part.children.forEach((child, index) => {
    if (child.type === 'srcbreak') {
      paragraph = null;
      root.appendChild(sourceBreak(child.text));
      return;
    }

    if (child.type !== 'quoteLine') return;
    if (!paragraph) {
      paragraph = document.createElement('p');
      root.appendChild(paragraph);
    }

    const line = document.createElement('span');
    line.className = 'live-quote-line live-reveal';
    line.dataset.open = child.prefix;
    line.appendChild(marker(child.prefix, 'open'));
    appendInline(line, child.children);
    paragraph.appendChild(line);

    if (child.trail) {
      const next = part.children[index + 1];
      if (next?.type === 'quoteLine') {
        paragraph.appendChild(document.createTextNode(child.trail));
      } else {
        paragraph.appendChild(sourceBreak(child.trail));
      }
    }
  });

  return root;
}

function buildTableRow(row, tag) {
  const tr = document.createElement('tr');
  if (tag === 'th') tr.className = 'live-table-head';

  row.cells.forEach((cell, index) => {
    const el = document.createElement(tag);
    el.className = 'live-table-cell live-reveal';
    el.dataset.open = cell.open;
    el.dataset.close = cell.close;
    if (cell.align) el.style.textAlign = cell.align;

    if (cell.open) el.appendChild(marker(cell.open, 'open'));
    appendInline(el, cell.children);
    if (cell.close) el.appendChild(marker(cell.close, 'close'));

    if (index === row.cells.length - 1 && row.trail) {
      el.appendChild(sourceBreak(row.trail));
    }
    tr.appendChild(el);
  });

  return tr;
}

function buildTable(part) {
  const root = document.createElement('table');
  root.className = 'live-block live-table';
  root.dataset.separator = part.separator.raw;

  const thead = document.createElement('thead');
  thead.appendChild(buildTableRow(part.header, 'th'));
  root.appendChild(thead);

  const tbody = document.createElement('tbody');

  const sep = document.createElement('tr');
  sep.className = 'live-table-sep';
  const sepCell = document.createElement('td');
  sepCell.colSpan = part.cols;
  const sepMark = document.createElement('span');
  sepMark.className = 'live-mark live-mark-sep';
  sepMark.textContent = part.separator.raw;
  sepCell.appendChild(sepMark);
  if (part.separator.trail) sepCell.appendChild(sourceBreak(part.separator.trail));
  sep.appendChild(sepCell);
  tbody.appendChild(sep);

  part.rows.forEach((row, index) => {
    tbody.appendChild(buildTableRow(row, 'td'));
  });

  root.appendChild(tbody);

  root.addEventListener('click', (event) => {
    if (event.target.closest?.('.live-table-sep')) return;
    const head = root.tHead;
    if (!head) return;
    const rect = head.getBoundingClientRect();
    if (Math.abs(event.clientY - rect.bottom) > 5) return;
    openTableSeparator(root);
  });

  return root;
}

export function createLiveBlock(block, marked) {
  const part = parseBlockParts(block, marked);
  if (!part) return null;

  let root = null;
  if (part.type === 'paragraph') root = buildParagraph(part);
  else if (part.type === 'heading') root = buildHeading(part);
  else if (part.type === 'list') root = buildList(part);
  else if (part.type === 'quote') root = buildQuote(part);
  else if (part.type === 'table') root = buildTable(part);
  if (!root) return null;

  root.classList.add('live-block-root');
  root.dataset.liveBlock = 'true';
  root.setAttribute('contenteditable', 'true');
  root.setAttribute('spellcheck', 'false');
  root.setAttribute('role', 'textbox');
  root.setAttribute('aria-multiline', 'true');

  if (readLiveBlockSource(root) !== block.content) return null;
  return root;
}

export function readLiveBlockSource(root) {
  let out = '';
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue || '';
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.tagName === 'BR') {
      out += '\n';
      return;
    }
    node.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
  return out.replace(/ /g, ' ');
}

export function visibleTextNodes(root) {
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.parentElement?.closest?.('.live-mark, .live-src-break')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  let node = walker.nextNode();
  while (node) {
    nodes.push(node);
    node = walker.nextNode();
  }
  return nodes;
}

export function visibleTextLength(root) {
  return visibleTextNodes(root).reduce((sum, node) => sum + node.nodeValue.length, 0);
}

function offsetIn(el, container, offset) {
  const range = document.createRange();
  range.selectNodeContents(el);
  try {
    range.setEnd(container, offset);
  } catch {
    return null;
  }
  return visibleTextLength(range.cloneContents());
}

export function focusLiveOffset(root, offset = null) {
  try {
    root.focus({ preventScroll: true });
  } catch {
    root.focus();
  }

  const nodes = visibleTextNodes(root);
  const total = nodes.reduce((sum, node) => sum + node.nodeValue.length, 0);
  let remaining = Number.isFinite(offset) ? Math.max(0, Math.min(total, offset)) : total;
  const range = document.createRange();
  let placed = false;

  for (const node of nodes) {
    const length = node.nodeValue.length;
    if (remaining <= length) {
      range.setStart(node, remaining);
      range.collapse(true);
      placed = true;
      break;
    }
    remaining -= length;
  }

  if (!placed) {
    range.selectNodeContents(root);
    range.collapse(false);
  }

  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
}

function separatorValid(text) {
  const body = String(text || '').trim().replace(/^\|/, '').replace(/\|$/, '');
  if (!body) return false;
  return body.split('|').every((cell) => /^\s*:?-+:?\s*$/.test(cell));
}

function collect(root, selector) {
  const nodes = Array.from(root.querySelectorAll(selector));
  if (root.matches?.(selector)) nodes.unshift(root);
  return nodes;
}

export function syncLiveMarkup(root) {
  root.querySelectorAll('.live-strong, .live-em, .live-del, .live-code').forEach((el) => {
    const open = el.querySelector(':scope > .live-mark-open');
    const close = el.querySelector(':scope > .live-mark-close');
    const ok = open && close
      && open.textContent === el.dataset.open
      && close.textContent === el.dataset.close
      && visibleTextLength(el) > 0;
    el.classList.toggle('live-mark-gone', !ok);
  });

  collect(root, '.live-heading').forEach((el) => {
    const open = el.querySelector(':scope > .live-mark-open');
    const ok = Boolean(open && open.textContent === el.dataset.open);
    el.classList.toggle('live-mark-gone', !ok);
  });

  root.querySelectorAll('.live-list-item').forEach((el) => {
    const open = el.querySelector(':scope > .live-mark-open');
    const ok = Boolean(open && open.textContent === el.dataset.open);
    el.classList.toggle('live-mark-gone', !ok);
  });

  collect(root, '.live-quote').forEach((el) => {
    let ok = true;
    el.querySelectorAll('.live-quote-line').forEach((line) => {
      const open = line.querySelector(':scope > .live-mark-open');
      if (!open || open.textContent !== line.dataset.open) ok = false;
    });
    el.classList.toggle('live-mark-gone', !ok);
  });

  collect(root, '.live-table').forEach((table) => {
    let ok = true;
    const sep = table.querySelector('.live-table-sep .live-mark');
    if (!sep || !separatorValid(sep.textContent)) ok = false;
    if (sep && separatorValid(sep.textContent)) table.dataset.separator = sep.textContent;

    table.querySelectorAll('.live-table-cell').forEach((cell) => {
      if (cell.dataset.open) {
        const open = cell.querySelector(':scope > .live-mark-open');
        if (!open || open.textContent !== cell.dataset.open) ok = false;
      }
      if (cell.dataset.close) {
        const close = cell.querySelector(':scope > .live-mark-close');
        if (!close || close.textContent !== cell.dataset.close) ok = false;
      }
    });

    table.classList.toggle('live-mark-gone', !ok);
  });
}

function syncTableSeparator(root) {
  const selection = window.getSelection();
  const node = selection?.anchorNode;
  const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  const sep = element?.closest?.('.live-table-sep') || null;

  collect(root, '.live-table').forEach((table) => {
    table.classList.toggle('live-sep-open', Boolean(sep && table.contains(sep)));
  });
}

export function openTableSeparator(table) {
  if (!table) return false;
  table.classList.add('live-sep-open');

  const cell = table.querySelector('.live-table-sep td');
  if (!cell) return false;

  let mark = table.querySelector('.live-table-sep .live-mark');
  if (!mark || !mark.textContent.trim()) {
    if (!mark) {
      mark = document.createElement('span');
      mark.className = 'live-mark live-mark-sep';
    }
    mark.textContent = table.dataset.separator || '| --- | --- |';
    if (!mark.parentNode) cell.insertBefore(mark, cell.firstChild);
    syncLiveMarkup(table);
  }

  try {
    table.focus({ preventScroll: true });
  } catch {
    table.focus();
  }
  const range = document.createRange();
  range.selectNodeContents(mark);
  range.collapse(false);
  const selection = window.getSelection();
  if (!selection) return false;
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

export function revealLiveMarkers(root) {
  if (!root) return;
  root.querySelectorAll('.live-mark-on').forEach((el) => el.classList.remove('live-mark-on'));
  syncTableSeparator(root);

  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer)) return;

  const element = range.startContainer.nodeType === Node.ELEMENT_NODE
    ? range.startContainer
    : range.startContainer.parentElement;
  const inside = element?.closest?.('.live-mark');
  if (inside) {
    inside.classList.add('live-mark-on');
    return;
  }

  collect(root, '.live-reveal').forEach((el) => {
    if (!el.contains(range.startContainer)) return;
    const at = offsetIn(el, range.startContainer, range.startOffset);
    if (at == null) return;
    const length = visibleTextLength(el);
    if (at === 0) el.querySelector(':scope > .live-mark-open')?.classList.add('live-mark-on');
    if (at === length) el.querySelector(':scope > .live-mark-close')?.classList.add('live-mark-on');
  });
}
