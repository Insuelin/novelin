import { getManuscriptTitle } from '../core/format.js';
import {
  Decoration,
  EditorView,
  StateField,
  WidgetType,
  ViewPlugin,
  syntaxTree,
} from '../vendor/codemirror.js';
import { findTables, tableAt } from './editor-tables.js';

class VoidBlockWidget extends WidgetType {
  toDOM() {
    const div = document.createElement('div');
    div.className = 'cm-md-void';
    return div;
  }

  get estimatedHeight() {
    return 0;
  }

  eq() {
    return true;
  }

  ignoreEvent() {
    return true;
  }
}

function selectionTouches(cs, from, to) {
  return cs.selection.ranges.some((range) => {
    if (range.empty) return range.head >= from && range.head <= to;
    return range.from <= to && range.to >= from;
  });
}

function skipSpaces(doc, pos, limit) {
  let at = pos;
  while (at < limit) {
    const char = doc.sliceString(at, at + 1);
    if (char !== ' ' && char !== '\t') break;
    at += 1;
  }
  return at;
}

function trimSpacesBefore(doc, pos, floor) {
  let at = pos;
  while (at > floor && /[ \t]/.test(doc.sliceString(at - 1, at))) at -= 1;
  return at;
}

function marker(kind, side, level = '') {
  const attributes = { 'data-kind': kind, 'data-side': side };
  if (level) attributes['data-level'] = String(level);
  return Decoration.mark({ class: 'cm-md-mark-visible', attributes });
}

function buildDecorations(view) {
  const cs = view.state;
  const doc = cs.doc;
  const tree = syntaxTree(cs);
  const ranges = view.visibleRanges.length ? view.visibleRanges : [{ from: 0, to: doc.length }];
  const decorations = [];
  const lineMap = new Map();
  const gridTables = findTables(doc).filter((table) => (
    !selectionTouches(cs, table.from, table.to)
  ));
  let firstParagraph = null;

  const addLine = (pos, value, attributes = null) => {
    if (!doc.length) return;
    const line = doc.lineAt(Math.max(0, Math.min(doc.length, pos)));
    let info = lineMap.get(line.from);
    if (!info) {
      info = { classes: new Set(), attributes: {} };
      lineMap.set(line.from, info);
    }
    for (const cls of String(value).split(/\s+/)) {
      if (cls) info.classes.add(cls);
    }
    if (attributes) Object.assign(info.attributes, attributes);
  };

  const reveal = (from, to, kind, side, level = '') => marker(kind, side, level).range(from, to);
  const hide = (from, to) => Decoration.replace({}).range(from, to);

  const title = getManuscriptTitle(doc.toString());
  const titleLine = title ? doc.lineAt(title.start) : null;
  const titleTouched = titleLine
    ? cs.selection.ranges.some((range) => (
      range.from <= titleLine.to && range.to >= titleLine.from
    ))
    : false;
  const hideTitle = Boolean(titleLine && doc.length > title.end + 1 && !titleTouched);
  const hiddenTitleFrom = hideTitle ? titleLine.from : -1;

  const inline = (node, markerName, className) => {
    const source = node.node;
    const open = source.firstChild;
    const close = source.lastChild;
    if (!open || !close || open === close) return;
    if (open.name !== markerName || close.name !== markerName) return;
    const innerFrom = open.to;
    const innerTo = close.from;
    if (innerTo <= innerFrom) return;

    decorations.push(Decoration.mark({ class: className }).range(innerFrom, innerTo));
    if (selectionTouches(cs, open.from, innerFrom)) {
      decorations.push(reveal(open.from, open.to, 'inline', 'open'));
    } else {
      decorations.push(hide(open.from, open.to));
    }
    if (selectionTouches(cs, innerTo, close.to)) {
      decorations.push(reveal(close.from, close.to, 'inline', 'close'));
    } else {
      decorations.push(hide(close.from, close.to));
    }
  };

  for (const range of ranges) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter(node) {
        const source = node.node;

        if (/^ATXHeading[1-6]$/.test(node.name)) {
          if (doc.lineAt(node.from).from === hiddenTitleFrom) return;
          const level = Number(node.name.slice(-1));
          const line = doc.lineAt(node.from);
          addLine(line.from, `cm-md-heading cm-md-h${level}`);
          const marks = source.getChildren('HeaderMark');
          if (!marks.length) return;

          const open = marks[0];
          const contentFrom = skipSpaces(doc, open.to, line.to);
          if (selectionTouches(cs, line.from, contentFrom)) {
            decorations.push(reveal(line.from, contentFrom, 'heading', 'open', level));
          } else {
            decorations.push(hide(line.from, contentFrom));
          }

          if (marks.length > 1) {
            const close = marks[marks.length - 1];
            const closeFrom = trimSpacesBefore(doc, close.from, open.to);
            if (selectionTouches(cs, closeFrom, line.to)) {
              decorations.push(reveal(closeFrom, line.to, 'heading', 'close', level));
            } else {
              decorations.push(hide(closeFrom, line.to));
            }
          }
          return;
        }

        if (node.name === 'SetextHeading1' || node.name === 'SetextHeading2') {
          const level = node.name.endsWith('1') ? 1 : 2;
          const headingLine = doc.lineAt(node.from);
          const underlineLine = doc.lineAt(Math.max(node.from, Math.min(doc.length, node.to - 1)));
          addLine(headingLine.from, `cm-md-heading cm-md-h${level}`);
          addLine(underlineLine.from, 'cm-md-setext-underline');
          if (selectionTouches(cs, underlineLine.from, underlineLine.to)) {
            decorations.push(reveal(underlineLine.from, underlineLine.to, 'setext', 'open', level));
          } else {
            decorations.push(hide(underlineLine.from, underlineLine.to));
          }
          return;
        }

        if (node.name === 'StrongEmphasis') {
          inline(node, 'EmphasisMark', 'cm-md-strong');
          return;
        }

        if (node.name === 'Emphasis') {
          inline(node, 'EmphasisMark', 'cm-md-em');
          return;
        }

        if (node.name === 'InlineCode') {
          inline(node, 'CodeMark', 'cm-md-inline-code');
          return;
        }

        if (node.name === 'Strikethrough') {
          inline(node, 'StrikethroughMark', 'cm-md-strike');
          return;
        }

        if (node.name === 'Link' || node.name === 'Autolink') {
          const marks = source.getChildren('LinkMark');
          if (marks.length < 2) return;
          const open = marks[0];
          const close = marks[1];
          if (open.from !== node.from || close.from <= open.to) return;
          const innerFrom = open.to;
          const innerTo = close.from;
          decorations.push(Decoration.mark({ class: 'cm-md-link' }).range(innerFrom, innerTo));
          if (selectionTouches(cs, open.from, innerFrom)) {
            decorations.push(reveal(open.from, open.to, 'inline', 'open'));
          } else {
            decorations.push(hide(open.from, open.to));
          }
          if (selectionTouches(cs, innerTo, node.to)) {
            decorations.push(reveal(close.from, node.to, 'inline', 'close'));
          } else {
            decorations.push(hide(close.from, node.to));
          }
          return;
        }

        if (node.name === 'URL' && source.parent?.name === 'Paragraph') {
          if (node.to > node.from) {
            decorations.push(Decoration.mark({ class: 'cm-md-link' }).range(node.from, node.to));
          }
          return;
        }

        if (node.name === 'ListItem') {
          const mark = source.getChild('ListMark');
          const ordered = source.parent?.name === 'OrderedList';
          const itemFirstLine = doc.lineAt(node.from);
          const visibleFirst = doc.lineAt(Math.max(node.from, range.from));
          const lastLine = doc.lineAt(Math.min(node.to, range.to, doc.length));
          const markerText = mark ? doc.sliceString(mark.from, mark.to) : '';
          addLine(itemFirstLine.from, `cm-md-list-item cm-md-list-first${ordered ? ' cm-md-list-ordered' : ''}`, {
            'data-md-marker': ordered ? markerText : '•',
          });
          for (let number = visibleFirst.number; number <= lastLine.number; number += 1) {
            const line = doc.line(number);
            if (line.from !== itemFirstLine.from) {
              addLine(line.from, 'cm-md-list-item cm-md-list-cont');
            }
          }
          if (!mark) return;

          const contentFrom = skipSpaces(doc, mark.to, itemFirstLine.to);
          if (selectionTouches(cs, mark.from, contentFrom)) {
            addLine(itemFirstLine.from, 'cm-md-li-open');
            decorations.push(reveal(mark.from, contentFrom, 'list', 'open'));
          } else {
            decorations.push(hide(mark.from, contentFrom));
          }
          return;
        }

        if (node.name === 'Blockquote') {
          const first = doc.lineAt(Math.max(node.from, range.from));
          const last = doc.lineAt(Math.min(node.to, range.to, doc.length));
          for (let number = first.number; number <= last.number; number += 1) {
            addLine(doc.line(number).from, 'cm-md-quote');
          }
          return;
        }

        if (node.name === 'QuoteMark') {
          const line = doc.lineAt(node.from);
          const contentFrom = skipSpaces(doc, node.to, line.to);
          addLine(line.from, 'cm-md-quote');
          if (selectionTouches(cs, line.from, contentFrom)) {
            decorations.push(reveal(line.from, contentFrom, 'quote', 'open'));
          } else {
            decorations.push(hide(line.from, contentFrom));
          }
          return;
        }

        if (node.name === 'TableHeader' || node.name === 'TableRow') {
          if (tableAt(gridTables, node.from)) return;
          addLine(node.from, 'cm-md-table-line');
          return;
        }

        if (node.name === 'TableDelimiter' && source.parent?.name === 'Table') {
          if (tableAt(gridTables, node.from)) return;
          const line = doc.lineAt(node.from);
          addLine(line.from, 'cm-md-table-sep');
          if (selectionTouches(cs, line.from, line.to)) {
            decorations.push(reveal(line.from, line.to, 'table', 'open'));
          } else {
            decorations.push(hide(line.from, line.to));
          }
          return;
        }

        if (node.name === 'FencedCode') {
          const first = doc.lineAt(Math.max(node.from, range.from));
          const last = doc.lineAt(Math.min(node.to, range.to, doc.length));
          for (let number = first.number; number <= last.number; number += 1) {
            addLine(doc.line(number).from, 'cm-md-codeblock');
          }

          const marks = source.getChildren('CodeMark');
          if (marks.length) {
            const open = marks[0];
            const openLine = doc.lineAt(open.from);
            addLine(openLine.from, 'cm-md-fence');
            if (selectionTouches(cs, openLine.from, openLine.to)) {
              decorations.push(reveal(openLine.from, openLine.to, 'fence', 'open'));
            } else {
              decorations.push(hide(openLine.from, openLine.to));
            }

            if (marks.length > 1) {
              const close = marks[marks.length - 1];
              const closeLine = doc.lineAt(close.from);
              addLine(closeLine.from, 'cm-md-fence');
              if (selectionTouches(cs, closeLine.from, closeLine.to)) {
                decorations.push(reveal(closeLine.from, closeLine.to, 'fence', 'close'));
              } else {
                decorations.push(hide(closeLine.from, closeLine.to));
              }
            }
          }
          return false;
        }

        if (node.name === 'Paragraph' && source.parent?.name === 'Document' && firstParagraph === null) {
          firstParagraph = node.from;
        }
      },
    });
  }

  if (firstParagraph !== null) {
    addLine(firstParagraph, 'cm-md-lead');
    const firstChar = doc.sliceString(firstParagraph, Math.min(doc.length, firstParagraph + 1));
    if (firstChar && /[\p{L}\p{N}]/u.test(firstChar)) {
      decorations.push(Decoration.mark({ class: 'cm-md-dropcap' }).range(firstParagraph, firstParagraph + 1));
    }
  }

  for (const [from, info] of lineMap) {
    const attributes = Object.keys(info.attributes).length ? info.attributes : undefined;
    decorations.push(Decoration.line({
      class: [...info.classes].join(' '),
      attributes,
    }).range(from));
  }

  return decorations.length ? Decoration.set(decorations, true) : Decoration.none;
}

function buildTitleBlock(state) {
  const doc = state.doc;
  const title = getManuscriptTitle(doc.toString());
  if (!title || doc.length <= title.end + 1) return Decoration.none;

  const line = doc.lineAt(title.start);
  const touched = state.selection.ranges.some((range) => (
    range.from <= line.to && range.to >= line.from
  ));
  if (touched) return Decoration.none;

  return Decoration.set([
    Decoration.replace({
      block: true,
      widget: new VoidBlockWidget(),
    }).range(line.from, Math.min(doc.length, line.to + 1)),
  ]);
}

export const titleBlock = StateField.define({
  create: buildTitleBlock,
  update(value, transaction) {
    if (!transaction.docChanged && !transaction.selection) return value;
    return buildTitleBlock(transaction.state);
  },
  provide: (field) => EditorView.decorations.from(field),
});

export const livePreview = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = buildDecorations(view);
    this.composing = Boolean(view.composing);
  }

  update(update) {
    if (update.view.composing) {
      this.composing = true;
      if (update.docChanged) this.decorations = this.decorations.map(update.changes);
      return;
    }

    const treeChanged = syntaxTree(update.startState) !== syntaxTree(update.state);
    if (this.composing || update.docChanged || update.selectionSet || update.viewportChanged || treeChanged) {
      this.composing = false;
      this.decorations = buildDecorations(update.view);
    }
  }
}, {
  decorations: (plugin) => plugin.decorations,
});

export function selectionPlainText(cs, from, to) {
  const doc = cs.doc;
  const start = Math.max(0, Math.min(doc.length, from));
  const end = Math.max(start, Math.min(doc.length, to));
  if (start === end) return '';

  const cuts = [];
  const cut = (a, b) => {
    const left = Math.max(start, a);
    const right = Math.min(end, b);
    if (right > left) cuts.push([left, right]);
  };

  syntaxTree(cs).iterate({
    from: start,
    to: end,
    enter(node) {
      const source = node.node;
      if (/^ATXHeading[1-6]$/.test(node.name) || node.name === 'SetextHeading1' || node.name === 'SetextHeading2') {
        const marks = source.getChildren('HeaderMark');
        for (const mark of marks) {
          const line = doc.lineAt(mark.from);
          cut(mark.from, skipSpaces(doc, mark.to, line.to));
        }
        return;
      }
      if (node.name === 'ListItem') {
        const mark = source.getChild('ListMark');
        if (mark) {
          const line = doc.lineAt(node.from);
          cut(mark.from, skipSpaces(doc, mark.to, line.to));
        }
        return;
      }
      if (node.name === 'QuoteMark') {
        const line = doc.lineAt(node.from);
        cut(node.from, skipSpaces(doc, node.to, line.to));
        return;
      }
      if (node.name === 'EmphasisMark' || node.name === 'CodeMark' || node.name === 'StrikethroughMark') {
        cut(node.from, node.to);
        return;
      }
      if (node.name === 'Link' || node.name === 'Autolink') {
        const marks = source.getChildren('LinkMark');
        if (marks.length >= 2) {
          cut(marks[0].from, marks[0].to);
          cut(marks[1].from, node.to);
        }
      }
    },
  });

  cuts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let out = '';
  let cursor = start;
  for (const [a, b] of cuts) {
    if (b <= cursor) continue;
    if (a > cursor) out += doc.sliceString(cursor, a);
    cursor = Math.max(cursor, b);
  }
  out += doc.sliceString(cursor, end);
  return out;
}
