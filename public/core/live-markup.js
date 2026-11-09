/**
 * 把 Markdown 块解析成“带隐藏符号”的结构树。
 *
 * 这棵树序列化后必须和原始块内容逐字节一致。DOM 层只负责把树变成可编辑元素，
 * 隐藏符号仍然留在 textContent 里，APPLY 时可以直接拿回源码。
 */

function tokensRaw(tokens) {
  if (!Array.isArray(tokens)) return null;
  return tokens.map((token) => String(token?.raw ?? '')).join('');
}

function parseInlineTokens(tokens, marked) {
  const parts = [];

  for (const token of tokens) {
    const raw = String(token?.raw ?? '');

    if (token?.type === 'text' || token?.type === 'br') {
      parts.push({ type: 'text', text: raw });
      continue;
    }

    if (token?.type === 'escape') {
      parts.push({ type: 'escape', marker: '\\', text: raw.slice(1) });
      continue;
    }

    if (token?.type === 'strong' || token?.type === 'em' || token?.type === 'del') {
      const inner = tokensRaw(token.tokens);
      if (inner == null || !inner) return null;
      const at = raw.indexOf(inner);
      if (at <= 0) return null;
      const open = raw.slice(0, at);
      const close = raw.slice(at + inner.length);
      if (!open || !close) return null;
      const children = parseInlineTokens(token.tokens, marked);
      if (!children) return null;
      parts.push({
        type: 'inline',
        kind: token.type,
        tag: token.type === 'del' ? 'del' : token.type,
        open,
        close,
        children,
      });
      continue;
    }

    if (token?.type === 'codespan') {
      const match = raw.match(/^(`+)([\s\S]*)\1$/);
      if (!match) return null;
      parts.push({
        type: 'inline',
        kind: 'code',
        tag: 'code',
        open: match[1],
        close: match[1],
        children: [{ type: 'text', text: match[2] }],
      });
      continue;
    }

    if (token?.type === 'link') {
      const inner = tokensRaw(token.tokens);
      if (inner == null || !inner) return null;

      if (token.autolink) {
        if (raw === inner) {
          parts.push({ type: 'link', open: '', close: '', children: parseInlineTokens(token.tokens, marked) });
          continue;
        }
        if (raw.startsWith('<') && raw.endsWith('>') && raw.slice(1, -1) === inner) {
          parts.push({ type: 'link', open: '<', close: '>', children: parseInlineTokens(token.tokens, marked) });
          continue;
        }
        return null;
      }

      const at = raw.indexOf(inner);
      if (at !== 1 || !raw.startsWith('[')) return null;
      const close = raw.slice(at + inner.length);
      if (!close.startsWith(']')) return null;
      const children = parseInlineTokens(token.tokens, marked);
      if (!children) return null;
      parts.push({ type: 'link', open: '[', close, children });
      continue;
    }

    return null;
  }

  return parts;
}

export function parseInlineParts(source, marked) {
  const text = String(source ?? '');
  let tokens;
  try {
    tokens = marked.Lexer.lexInline(text);
  } catch {
    return null;
  }
  if (tokensRaw(tokens) !== text) return null;
  return parseInlineTokens(tokens, marked);
}

export function serializePart(part) {
  if (!part) return '';

  switch (part.type) {
    case 'text':
      return String(part.text ?? '');
    case 'escape':
      return `${part.marker}${part.text}`;
    case 'inline':
    case 'link':
      return `${part.open}${serializeParts(part.children)}${part.close}`;
    case 'srcbreak':
      return String(part.text ?? '');
    case 'paragraph':
      return serializeParts(part.children);
    case 'heading':
      return `${part.prefix}${serializeParts(part.children)}`;
    case 'list':
      return part.items
        .map((item) => `${item.prefix}${serializeParts(item.children)}${item.trail || ''}`)
        .join('');
    case 'quote':
      return part.children.map(serializePart).join('');
    case 'quoteLine':
      return `${part.prefix}${serializeParts(part.children)}${part.trail || ''}`;
    case 'table': {
      const row = (value) => value.cells
        .map((cell) => `${cell.open}${serializeParts(cell.children)}${cell.close}`)
        .join('') + (value.trail || '');
      return row(part.header)
        + part.separator.raw
        + (part.separator.trail || '')
        + part.rows.map(row).join('');
    }
    default:
      return '';
  }
}

export function serializeParts(parts) {
  return (parts || []).map(serializePart).join('');
}

function headingParts(source, block, marked) {
  const match = source.match(/^(#{1,6})([ \t]+)([\s\S]*)$/);
  if (!match) return null;
  const inlineTokens = block.token?.tokens;
  const children = inlineTokens && tokensRaw(inlineTokens) === match[3]
    ? parseInlineTokens(inlineTokens, marked)
    : parseInlineParts(match[3], marked);
  if (!children) return null;
  return {
    type: 'heading',
    level: match[1].length,
    prefix: match[1] + match[2],
    children,
  };
}

function paragraphParts(source, block, marked) {
  const inlineTokens = block.token?.tokens;
  const children = inlineTokens && tokensRaw(inlineTokens) === source
    ? parseInlineTokens(inlineTokens, marked)
    : parseInlineParts(source, marked);
  if (!children) return null;
  return { type: 'paragraph', children };
}

function listParts(source, block, marked) {
  const lines = source.split('\n');
  const items = [];
  let current = null;

  for (const line of lines) {
    const match = line.match(/^([ \t]*)([-+*]|\d+[.)])([ \t]+)([\s\S]*)$/);
    if (match) {
      if (match[1]) return null;
      const content = match[4];
      if (/^\[[ xX]\][ \t]+/.test(content)) return null;
      if (current) {
        current.trail = '\n';
        items.push(current);
      }
      current = {
        prefix: match[1] + match[2] + match[3],
        lines: [content],
      };
      continue;
    }

    if (!current) return null;
    current.lines.push(line);
  }

  if (!current) return null;
  items.push(current);

  const parsedItems = items.map((item) => {
    const children = parseInlineParts(item.lines.join('\n'), marked);
    if (!children) return null;
    return {
      prefix: item.prefix,
      children,
      trail: item.trail || '',
    };
  });
  if (parsedItems.some((item) => !item)) return null;

  return {
    type: 'list',
    ordered: Boolean(block.token?.ordered),
    start: Number(block.token?.start) || 1,
    items: parsedItems,
  };
}

function quoteParts(source, marked) {
  const lines = source.split('\n');
  const children = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^>( ?)([\s\S]*)$/);
    if (!match) return null;
    const content = match[2];
    if (content.startsWith('>')) return null;
    const prefix = '>' + match[1];
    const trail = index < lines.length - 1 ? '\n' : '';

    if (!content) {
      children.push({ type: 'srcbreak', text: prefix + trail });
      continue;
    }

    const inline = parseInlineParts(content, marked);
    if (!inline) return null;
    children.push({
      type: 'quoteLine',
      prefix,
      children: inline,
      trail,
    });
  }

  return { type: 'quote', children };
}

function parseTableLine(line, tag, trail, marked) {
  if (!line.includes('|')) return null;
  if (line.includes('\\|')) return null;

  const leading = line.match(/^[ \t]*/)?.[0] || '';
  const body = line.slice(leading.length);
  if (!body.includes('|')) return null;

  const startsPipe = body.startsWith('|');
  const endsPipe = body.endsWith('|');
  const segments = body.split('|');
  if (startsPipe) segments.shift();
  if (endsPipe) segments.pop();
  if (!segments.length) return null;

  const cells = [];
  for (let index = 0; index < segments.length; index += 1) {
    const raw = segments[index];
    const lead = raw.match(/^[ \t]*/)?.[0] || '';
    const tail = raw.match(/[ \t]*$/)?.[0] || '';
    const visible = raw.slice(lead.length, raw.length - tail.length);
    const children = parseInlineParts(visible, marked);
    if (!children) return null;

    cells.push({
      open: (index === 0 ? leading + (startsPipe ? '|' : '') : '') + lead,
      children,
      close: tail + (index < segments.length - 1 || endsPipe ? '|' : ''),
    });
  }

  return { tag, cells, trail };
}

function separatorAlign(line) {
  if (!line.includes('|')) return null;
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = body.split('|');
  if (cells.some((cell) => !/^\s*:?-+:?\s*$/.test(cell))) return null;
  return cells.map((cell) => {
    const value = cell.trim();
    const left = value.startsWith(':');
    const right = value.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
}

function tableParts(source, marked) {
  if (source.includes('\\|')) return null;
  const lines = source.split('\n');
  if (lines.length < 2) return null;

  const align = separatorAlign(lines[1]);
  if (!align) return null;

  const header = parseTableLine(lines[0], 'th', '\n', marked);
  if (!header) return null;
  if (header.cells.length !== align.length) return null;
  if (align.some((value) => value === undefined)) return null;

  const rows = [];
  for (let index = 2; index < lines.length; index += 1) {
    const row = parseTableLine(lines[index], 'td', index < lines.length - 1 ? '\n' : '', marked);
    if (!row) return null;
    if (row.cells.length !== header.cells.length) return null;
    rows.push(row);
  }

  const applyAlign = (row) => {
    row.cells.forEach((cell, index) => {
      cell.align = align[index] || null;
    });
  };
  applyAlign(header);
  rows.forEach(applyAlign);

  return {
    type: 'table',
    cols: header.cells.length,
    header,
    separator: {
      raw: lines[1],
      trail: rows.length ? '\n' : '',
    },
    rows,
  };
}

export function parseBlockParts(block, marked) {
  if (!block || typeof block.content !== 'string') return null;
  const source = block.content;
  let part = null;

  switch (block.type) {
    case 'paragraph':
    case 'text':
      part = paragraphParts(source, block, marked);
      break;
    case 'heading':
      part = headingParts(source, block, marked);
      break;
    case 'list':
      part = listParts(source, block, marked);
      break;
    case 'blockquote':
      part = quoteParts(source, marked);
      break;
    case 'table':
      part = tableParts(source, marked);
      break;
    default:
      return null;
  }

  if (!part) return null;
  return serializePart(part) === source ? part : null;
}
