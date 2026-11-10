const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const INDENTED_RE = /^(?: {4,}|\t)/;

function isEscaped(text, index) {
  let count = 0;
  for (let at = index - 1; at >= 0 && text[at] === '\\'; at -= 1) count += 1;
  return count % 2 === 1;
}

function runLength(text, index, char) {
  let at = index;
  while (at < text.length && text[at] === char) at += 1;
  return at - index;
}

export function rangesOverlap(aFrom, aTo, bFrom, bTo) {
  return aFrom < bTo && bFrom < aTo;
}

function lineEndAt(text, index) {
  const at = text.indexOf('\n', index);
  return at < 0 ? text.length : at;
}

function nextLine(text, lineEnd) {
  return lineEnd < text.length ? lineEnd + 1 : text.length;
}

function findUnescapedPair(text, from) {
  let at = from;
  while ((at = text.indexOf('$$', at)) >= 0) {
    if (!isEscaped(text, at)) return at;
    at += 1;
  }
  return -1;
}

function findEscapedClose(text, from, close) {
  let at = from;
  while ((at = text.indexOf(close, at)) >= 0) {
    if (!isEscaped(text, at)) return at;
    at += close.length;
  }
  return -1;
}

function hasFenceBetween(text, from, to) {
  return /(^|\n) {0,3}(?:`{3,}|~{3,})/.test(text.slice(from, to));
}

function computeCodeRanges(text) {
  const ranges = [];
  let fence = null;
  let offset = 0;

  while (offset < text.length) {
    const lineEnd = lineEndAt(text, offset);
    const line = text.slice(offset, lineEnd);
    const fenceMatch = FENCE_RE.exec(line);

    if (fence) {
      ranges.push({ from: offset, to: lineEnd });
      if (fenceMatch && fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.len) {
        fence = null;
      }
      offset = nextLine(text, lineEnd);
      continue;
    }

    if (fenceMatch) {
      fence = { char: fenceMatch[1][0], len: fenceMatch[1].length };
      ranges.push({ from: offset, to: lineEnd });
      offset = nextLine(text, lineEnd);
      continue;
    }

    if (INDENTED_RE.test(line)) {
      offset = nextLine(text, lineEnd);
      continue;
    }

    let at = offset;
    while (at < lineEnd) {
      if (text[at] !== '`') {
        at += 1;
        continue;
      }
      const length = runLength(text, at, '`');
      let cursor = at + length;
      let close = -1;
      while (cursor < lineEnd) {
        const next = text.indexOf('`', cursor);
        if (next < 0 || next >= lineEnd) break;
        const nextLength = runLength(text, next, '`');
        if (nextLength === length) {
          close = next;
          break;
        }
        cursor = next + nextLength;
      }
      if (close >= 0) {
        ranges.push({ from: at, to: close + length });
        at = close + length;
      } else {
        at += length;
      }
    }

    offset = nextLine(text, lineEnd);
  }

  return ranges;
}

function isIndentedLineAt(text, index) {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  return INDENTED_RE.test(text.slice(lineStart, index));
}

function pushRange(out, text, from, to, tex, display) {
  const body = String(tex).trim();
  if (!body) return false;
  out.push({ from, to, tex: body, display });
  return true;
}

export function scanMath(source) {
  const text = String(source ?? '');
  const out = [];
  const codeRanges = computeCodeRanges(text);
  const inCode = (from, to) => codeRanges.some((range) => (
    rangesOverlap(from, to, range.from, range.to)
  ));
  let i = 0;
  let lineStart = 0;
  let fence = null;

  const moveTo = (index) => {
    i = Math.max(0, Math.min(text.length, index));
    const newline = text.lastIndexOf('\n', i - 1);
    lineStart = newline + 1;
  };

  while (i < text.length) {
    if (i === lineStart) {
      const lineEnd = lineEndAt(text, i);
      const line = text.slice(i, lineEnd);
      const fenceMatch = FENCE_RE.exec(line);

      if (fence) {
        if (fenceMatch && fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.len) {
          fence = null;
        }
        i = nextLine(text, lineEnd);
        lineStart = i;
        continue;
      }

      if (fenceMatch) {
        fence = { char: fenceMatch[1][0], len: fenceMatch[1].length };
        i = nextLine(text, lineEnd);
        lineStart = i;
        continue;
      }

      if (INDENTED_RE.test(line)) {
        i = nextLine(text, lineEnd);
        lineStart = i;
        continue;
      }
    }

    const char = text[i];

    if (char === '`') {
      const length = runLength(text, i, '`');
      const limit = lineEndAt(text, i);
      let at = i + length;
      let close = -1;
      while (at < limit) {
        const next = text.indexOf('`', at);
        if (next < 0 || next >= limit) break;
        const nextLength = runLength(text, next, '`');
        if (nextLength === length) {
          close = next;
          break;
        }
        at = next + nextLength;
      }
      i = close >= 0 ? close + length : i + length;
      continue;
    }

    if (char === '\\' && text[i + 1] === '[' && !isEscaped(text, i)) {
      const close = findEscapedClose(text, i + 2, '\\]');
      if (close >= 0
        && !isIndentedLineAt(text, close)
        && !inCode(i, close + 2)
        && !hasFenceBetween(text, i + 2, close)) {
        if (pushRange(out, text, i, close + 2, text.slice(i + 2, close), true)) {
          moveTo(close + 2);
          continue;
        }
      }
      i += 2;
      continue;
    }

    if (char === '\\' && text[i + 1] === '(' && !isEscaped(text, i)) {
      const limit = lineEndAt(text, i);
      const close = findEscapedClose(text, i + 2, '\\)');
      if (close >= 0 && close < limit && !inCode(i, close + 2)) {
        if (pushRange(out, text, i, close + 2, text.slice(i + 2, close), false)) {
          moveTo(close + 2);
          continue;
        }
      }
      i += 2;
      continue;
    }

    if (char === '$' && text[i + 1] === '$' && !isEscaped(text, i)) {
      const close = findUnescapedPair(text, i + 2);
      if (close >= 0
        && !isIndentedLineAt(text, close)
        && !inCode(i, close + 2)
        && !hasFenceBetween(text, i + 2, close)) {
        if (pushRange(out, text, i, close + 2, text.slice(i + 2, close), true)) {
          moveTo(close + 2);
          continue;
        }
      }
      i += 2;
      continue;
    }

    if (char === '$' && !isEscaped(text, i)) {
      const limit = lineEndAt(text, i);
      if (i + 1 >= limit || /\s/.test(text[i + 1])) {
        i += 1;
        continue;
      }

      let close = -1;
      for (let at = i + 1; at < limit; at += 1) {
        if (text[at] !== '$' || isEscaped(text, at)) continue;
        if (text[at + 1] === '$') continue;
        if (/\s/.test(text[at - 1])) continue;
        if (/[0-9]/.test(text[at + 1] || '')) continue;
        close = at;
        break;
      }
      if (close > i + 1
        && !isIndentedLineAt(text, close)
        && !inCode(i, close + 1)) {
        if (pushRange(out, text, i, close + 1, text.slice(i + 1, close), false)) {
          moveTo(close + 1);
          continue;
        }
      }
      i += 1;
      continue;
    }

    i += 1;
    if (char === '\n') lineStart = i;
  }

  return out;
}
