const TOKEN_RE = /[㐀-鿿]|[A-Za-z0-9_]+|\s+|[^\s]/gu;
const MAX_LCS_CELLS = 400000;

export function tokenizeText(text) {
  return String(text ?? '').match(TOKEN_RE) || [];
}

function push(parts, type, text) {
  if (!text) return;
  const last = parts[parts.length - 1];
  if (last && last.type === type) last.text += text;
  else parts.push({ type, text });
}

function lcsSegments(a, b) {
  const n = a.length;
  const m = b.length;
  const parts = [];

  if (n * m > MAX_LCS_CELLS) {
    if (n) push(parts, 'del', a.join(''));
    if (m) push(parts, 'ins', b.join(''));
    return parts;
  }

  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push(parts, 'same', a[i]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push(parts, 'del', a[i]);
      i += 1;
    } else {
      push(parts, 'ins', b[j]);
      j += 1;
    }
  }
  while (i < n) {
    push(parts, 'del', a[i]);
    i += 1;
  }
  while (j < m) {
    push(parts, 'ins', b[j]);
    j += 1;
  }
  return parts;
}

/** 源码级 diff，返回 [{type:'same'|'del'|'ins', text}]。 */
export function diffSegments(before, after) {
  const left = String(before ?? '');
  const right = String(after ?? '');
  if (left === right) return left ? [{ type: 'same', text: left }] : [];

  const a = tokenizeText(left);
  const b = tokenizeText(right);

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;

  let endA = a.length;
  let endB = b.length;
  while (endA > prefix && endB > prefix && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const parts = [];
  if (prefix) push(parts, 'same', a.slice(0, prefix).join(''));
  for (const segment of lcsSegments(a.slice(prefix, endA), b.slice(prefix, endB))) {
    push(parts, segment.type, segment.text);
  }
  if (endA < a.length) push(parts, 'same', a.slice(endA).join(''));
  return parts;
}
