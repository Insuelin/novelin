import { Decoration, EditorView, StateField, WidgetType } from '../vendor/codemirror.js';
import { marked } from '../core/marked.js';
import DOMPurify from '../vendor/purify.es.js';

const DELIM_CELL = /^:?-{1,}:?$/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const LIST_START = /^\s*([-*+>]|\d+[.)])\s/;

function selectionTouches(cs, from, to) {
  return cs.selection.ranges.some((range) => {
    if (range.empty) return range.head >= from && range.head <= to;
    return range.from <= to && range.to >= from;
  });
}

function splitRow(text) {
  const cells = [];
  const length = text.length;
  let start = 0;
  let at = 0;
  while (at < length && (text[at] === ' ' || text[at] === '\t')) at += 1;
  if (text[at] === '|') start = at + 1;

  for (let i = start; i < length; i += 1) {
    const char = text[i];
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (char === '|') {
      cells.push({ text: text.slice(start, i), start, end: i });
      start = i + 1;
    }
  }

  const tail = text.slice(start);
  const trimmedEnd = text.replace(/[ \t]+$/, '');
  if (tail.trim() || !trimmedEnd.endsWith('|')) {
    cells.push({ text: tail, start, end: length });
  }
  return cells;
}

function isDelimiterRow(text) {
  if (!text || !text.includes('|')) return false;
  const cells = splitRow(text);
  if (!cells.length) return false;
  return cells.every((cell) => DELIM_CELL.test(cell.text.trim()));
}

function alignmentOf(text) {
  const value = text.trim();
  const left = value.startsWith(':');
  const right = value.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return 'left';
}

function parseTable(source, basePos) {
  const lines = source.split('\n');
  let offset = 0;
  const lineOffsets = lines.map((line) => {
    const at = offset;
    offset += line.length + 1;
    return at;
  });
  const rows = lines.map((line) => splitRow(line));
  const header = rows[0] || [];
  const delimiter = rows[1] || [];
  const columns = Math.max(header.length, delimiter.length);
  const align = [];
  for (let index = 0; index < columns; index += 1) {
    align.push(delimiter[index] ? alignmentOf(delimiter[index].text) : 'left');
  }

  return {
    rows,
    columns,
    align,
    cellPos(cell, rowIndex) {
      const lead = (cell.text.match(/^[ \t]*/) || [''])[0].length;
      return basePos + lineOffsets[rowIndex] + cell.start + lead;
    },
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[char]));
}

function renderInline(text) {
  const value = text.replace(/\\\|/g, '|').trim();
  if (!value) return '';
  try {
    return DOMPurify.sanitize(marked.parseInline(value));
  } catch {
    return escapeHtml(value);
  }
}

function renderedCaretOffset(cell, x, y) {
  if (typeof document.caretRangeFromPoint !== 'function') return 0;
  const range = document.caretRangeFromPoint(x, y);
  if (!range || !cell.contains(range.startContainer)) return 0;
  const before = document.createRange();
  before.selectNodeContents(cell);
  try {
    before.setEnd(range.startContainer, range.startOffset);
  } catch {
    return 0;
  }
  return before.toString().length;
}

function sourceOffsetForRendered(sourceText, renderedOffset) {
  if (!renderedOffset) return 0;
  const source = sourceText.trim();
  let sourceIndex = 0;
  let renderedIndex = 0;

  while (renderedIndex < renderedOffset && sourceIndex < source.length) {
    const char = source[sourceIndex];
    if (char === '\\' && sourceIndex + 1 < source.length) {
      renderedIndex += 1;
      sourceIndex += 2;
      continue;
    }
    if (char === ']' && source[sourceIndex + 1] === '(') {
      let depth = 1;
      sourceIndex += 2;
      while (sourceIndex < source.length && depth > 0) {
        if (source[sourceIndex] === '(') depth += 1;
        else if (source[sourceIndex] === ')') depth -= 1;
        sourceIndex += 1;
      }
      continue;
    }
    if (char === '[' || '*_~`'.includes(char)) {
      sourceIndex += 1;
      continue;
    }
    renderedIndex += 1;
    sourceIndex += 1;
  }

  return sourceIndex;
}

class TableWidget extends WidgetType {
  constructor(source, from) {
    super();
    this.source = source;
    this.from = from;
  }

  eq(other) {
    return other.source === this.source && other.from === this.from;
  }

  toDOM(view) {
    const wrap = document.createElement('div');
    wrap.className = 'cm-md-table-widget';
    wrap.setAttribute('contenteditable', 'false');
    wrap.title = '点击编辑表格';

    const parsed = parseTable(this.source, this.from);
    const cellSources = new Map();
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');

    for (let column = 0; column < parsed.columns; column += 1) {
      const th = document.createElement('th');
      const cell = parsed.rows[0]?.[column];
      th.innerHTML = cell ? renderInline(cell.text) : '';
      th.style.textAlign = parsed.align[column];
      if (cell) {
        th.dataset.pos = String(parsed.cellPos(cell, 0));
        cellSources.set(th, cell.text);
      }
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (let rowIndex = 2; rowIndex < parsed.rows.length; rowIndex += 1) {
      const tr = document.createElement('tr');
      for (let column = 0; column < parsed.columns; column += 1) {
        const td = document.createElement('td');
        const cell = parsed.rows[rowIndex][column];
        td.innerHTML = cell ? renderInline(cell.text) : '';
        td.style.textAlign = parsed.align[column];
        if (cell) {
          td.dataset.pos = String(parsed.cellPos(cell, rowIndex));
          cellSources.set(td, cell.text);
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);

    wrap.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const cell = event.target.closest?.('th,td');
      let pos = this.from;
      if (cell && cellSources.has(cell)) {
        const base = Number(cell.dataset.pos);
        const offset = sourceOffsetForRendered(
          cellSources.get(cell),
          renderedCaretOffset(cell, event.clientX, event.clientY),
        );
        if (Number.isFinite(base)) {
          pos = Math.max(this.from, Math.min(this.from + this.source.length, base + offset));
        }
      }
      view.dispatch({ selection: { anchor: pos } });
      view.focus();
    });

    return wrap;
  }

  ignoreEvent() {
    return true;
  }
}

export function findTables(doc) {
  const tables = [];
  let fenceChar = '';
  let fenceLength = 0;

  for (let number = 1; number < doc.lines; number += 1) {
    const line = doc.line(number);
    const text = line.text;

    const fenceMatch = text.match(FENCE);
    if (fenceMatch) {
      const run = fenceMatch[1];
      if (!fenceChar) {
        fenceChar = run[0];
        fenceLength = run.length;
      } else if (run[0] === fenceChar && run.length >= fenceLength) {
        fenceChar = '';
        fenceLength = 0;
      }
      continue;
    }
    if (fenceChar) continue;
    if (!text.includes('|')) continue;
    if (/^\s{4,}/.test(text)) continue;
    if (/^\s*#/.test(text)) continue;
    if (LIST_START.test(text)) continue;
    if (isDelimiterRow(text)) continue;

    const delimiter = doc.line(number + 1);
    if (!delimiter || !isDelimiterRow(delimiter.text)) continue;

    let end = number + 1;
    let next = number + 2;
    while (next <= doc.lines) {
      const row = doc.line(next);
      if (!row.text.trim() || !row.text.includes('|')) break;
      if (FENCE.test(row.text) || LIST_START.test(row.text) || /^\s*#/.test(row.text)) break;
      end = next;
      next += 1;
    }

    tables.push({ from: line.from, to: doc.line(end).to });
    number = end;
  }

  return tables;
}

export function tableAt(tables, pos) {
  for (const table of tables) {
    if (pos >= table.from && pos <= table.to) return table;
  }
  return null;
}

function buildTableBlocks(state) {
  const tables = findTables(state.doc);
  if (!tables.length) return Decoration.none;

  const decorations = [];
  for (const table of tables) {
    if (selectionTouches(state, table.from, table.to)) continue;
    const lastLine = state.doc.lineAt(Math.min(table.to, state.doc.length));
    const from = state.doc.lineAt(table.from).from;
    const to = Math.min(state.doc.length, lastLine.to + 1);
    if (to <= from) continue;

    const source = state.doc.sliceString(from, lastLine.to);
    decorations.push(Decoration.replace({
      block: true,
      widget: new TableWidget(source, from),
    }).range(from, to));
  }

  return decorations.length ? Decoration.set(decorations, true) : Decoration.none;
}

export const tableBlocks = StateField.define({
  create: buildTableBlocks,
  update(value, transaction) {
    if (!transaction.docChanged && !transaction.selection) return value;
    return buildTableBlocks(transaction.state);
  },
  provide: (field) => EditorView.decorations.from(field),
});
