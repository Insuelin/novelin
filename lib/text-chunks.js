function safeCut(text, index) {
  const at = Math.max(0, Math.min(text.length, index));
  if (at <= 0 || at >= text.length) return at;
  const before = text.charCodeAt(at - 1);
  const after = text.charCodeAt(at);
  const beforeSurrogate = before >= 0xd800 && before <= 0xdbff;
  const afterSurrogate = after >= 0xdc00 && after <= 0xdfff;
  return beforeSurrogate && afterSurrogate ? at - 1 : at;
}

export function normalizeText(source) {
  let text = String(source ?? '');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n?/g, '\n');
}

export function splitParagraphBlocks(text) {
  const source = String(text ?? '');
  const blocks = [];
  let start = 0;
  for (;;) {
    const at = source.indexOf('\n\n', start);
    if (at < 0) {
      if (start < source.length) blocks.push({ start, end: source.length });
      break;
    }
    blocks.push({ start, end: at + 2 });
    start = at + 2;
  }
  return blocks;
}

const SENTENCE_END = new Set(['。', '！', '？', '…', '；', '!', '?', ';']);
const CLOSING = new Set(['”', '’', '」', '』', '）', '】', '》', ')', ']', '"', "'"]);

export function chooseSentenceCut(text, target, minCut = 0) {
  const source = String(text ?? '');
  const floor = Math.max(0, Math.min(source.length, minCut));
  const goal = Math.max(floor, Math.min(source.length, target));
  for (let at = goal; at > floor; at -= 1) {
    const char = source[at - 1];
    if (SENTENCE_END.has(char) || char === '\n' || CLOSING.has(char)) {
      return safeCut(source, at);
    }
  }
  return safeCut(source, goal);
}

export function planChunks(source, options = {}) {
  const text = normalizeText(source);
  const maxChunks = Math.max(1, Number(options.maxChunks) || 12);
  const baseChunkChars = Math.max(1, Number(options.chunkChars) || 6000);
  const maxChunkChars = Math.max(baseChunkChars, Number(options.maxChunkChars) || 16000);
  const overlap = Math.max(0, Math.min(
    Number(options.overlap) || 0,
    Math.floor(baseChunkChars / 2),
  ));

  if (!text.length) {
    return { chunks: [], degraded: false, chunkChars: baseChunkChars, overlap };
  }

  let chunkChars = baseChunkChars;
  if (text.length > baseChunkChars * maxChunks) {
    chunkChars = Math.max(
      baseChunkChars,
      Math.ceil((text.length + overlap * (maxChunks - 1)) / maxChunks),
    );
  }

  const chunks = [];
  let start = 0;
  while (start < text.length && chunks.length < maxChunks) {
    const last = chunks.length === maxChunks - 1;
    let end = last ? text.length : Math.min(text.length, start + chunkChars);
    if (!last && end < text.length) {
      end = chooseSentenceCut(text, end, start + Math.floor(chunkChars * 0.5));
    }
    end = Math.max(start + 1, safeCut(text, Math.min(text.length, end)));
    chunks.push({
      index: chunks.length,
      start,
      end,
      text: text.slice(start, end),
    });
    if (end >= text.length) break;

    let next = Math.max(start + 1, end - overlap);
    next = safeCut(text, Math.min(text.length - 1, next));
    if (next <= start) next = start + 1;
    start = next;
  }

  const covered = chunks.reduce((max, chunk) => Math.max(max, chunk.end), 0);
  const anyOversized = chunks.some((chunk) => chunk.end - chunk.start > maxChunkChars);
  const degraded = covered < text.length
    || anyOversized
    || text.length > maxChunkChars * maxChunks
    || chunkChars > maxChunkChars;

  return {
    chunks,
    degraded,
    chunkChars,
    overlap,
    text,
  };
}
