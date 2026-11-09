const EDITABLE_TYPES = new Set([
  'heading',
  'paragraph',
  'text',
  'list',
  'blockquote',
  'code',
  'table',
  'mathBlock',
  'hr',
]);

const BOM = 0xfeff;

/** 把 CRLF / 孤立 CR 规范成 LF，并记录 normalized 边界到原始字符串边界的映射。 */
export function normalizeWithMap(source) {
  const input = String(source ?? '');
  let at = input.charCodeAt(0) === BOM ? 1 : 0;
  const start = at;
  const map = [start];
  let text = '';

  while (at < input.length) {
    const char = input[at];
    if (char === '\r') {
      at += input[at + 1] === '\n' ? 2 : 1;
      text += '\n';
      map.push(at);
      continue;
    }
    text += char;
    at += 1;
    map.push(at);
  }

  return { text, map, start };
}

function blockEol(source, start, end, fallback) {
  return source.slice(start, end).includes('\r\n') ? '\r\n' : fallback;
}

/**
 * 用 marked 顶层 token 把 Markdown 切成可编辑块。
 * token.raw 拼接必须与规范化后的源码完全一致；否则返回 fallback，调用方退回整篇渲染。
 */
export function analyzeBlocks(source, marked) {
  const input = String(source ?? '');
  const { text, map, start: bomLength } = normalizeWithMap(input);

  if (!text.trim()) {
    return {
      source: input,
      normalized: text,
      tokens: [],
      blocks: [],
      links: null,
      fallback: false,
      bomLength,
    };
  }

  let tokens;
  try {
    tokens = marked.lexer(text, { ...marked.defaults, breaks: true, gfm: true });
  } catch {
    return {
      source: input,
      normalized: text,
      tokens: [],
      blocks: [],
      links: null,
      fallback: true,
      bomLength,
    };
  }

  const joined = tokens.map((token) => String(token?.raw ?? '')).join('');
  if (joined !== text) {
    return {
      source: input,
      normalized: text,
      tokens,
      blocks: [],
      links: tokens.links || null,
      fallback: true,
      bomLength,
    };
  }

  const documentEol = input.includes('\r\n') ? '\r\n' : '\n';
  const blocks = [];
  let offset = 0;

  for (const token of tokens) {
    const raw = String(token?.raw ?? '');
    const normStart = offset;
    const normEnd = offset + raw.length;
    offset = normEnd;

    if (token.type === 'space' || token.type === 'def') continue;

    const start = map[normStart];
    const end = map[normEnd];
    blocks.push({
      type: token.type,
      start,
      end,
      original: input.slice(start, end),
      content: text.slice(normStart, normEnd),
      token,
      normStart,
      normEnd,
      eol: blockEol(input, start, end, documentEol),
      editable: EDITABLE_TYPES.has(token.type),
    });
  }

  return {
    source: input,
    normalized: text,
    tokens,
    blocks,
    links: tokens.links || null,
    fallback: false,
    bomLength,
  };
}

function convertEol(text, eol) {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n');
  return eol === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized;
}

/** 只替换一个块；块外字节不动。 */
export function replaceBlock(source, block, text) {
  const input = String(source ?? '');
  if (!block) return input;
  const start = Math.max(0, Math.min(input.length, block.start));
  const end = Math.max(start, Math.min(input.length, block.end));
  return input.slice(0, start) + convertEol(text, block.eol || '\n') + input.slice(end);
}

/** 在文末追加内容，保证和上一块之间有空行。 */
export function appendBlock(source, text) {
  const input = String(source ?? '');
  const eol = input.includes('\r\n') ? '\r\n' : '\n';
  const body = convertEol(text, eol)
    .replace(/^(?:\r?\n)+/, '')
    .replace(/(?:\r?\n)+$/, '');
  if (!body) return input;
  if (!input) return body;
  if (input.endsWith(eol + eol)) return input + body;
  if (input.endsWith(eol)) return input + eol + body;
  return input + eol + eol + body;
}
