const MIDDLE_MARK = '\n…（中间省略）…\n';

function safeCut(text, index) {
  const at = Math.max(0, Math.min(text.length, index));
  if (at <= 0 || at >= text.length) return at;
  const before = text.charCodeAt(at - 1);
  const after = text.charCodeAt(at);
  const beforeSurrogate = before >= 0xd800 && before <= 0xdbff;
  const afterSurrogate = after >= 0xdc00 && after <= 0xdfff;
  return beforeSurrogate && afterSurrogate ? at - 1 : at;
}

export function truncateMiddle(text, maxChars, headRatio = 0.7) {
  const source = String(text ?? '');
  const limit = Math.max(1, Math.trunc(Number(maxChars) || 0));
  if (source.length <= limit) return source;
  if (limit <= MIDDLE_MARK.length + 4) return source.slice(0, limit);

  const available = limit - MIDDLE_MARK.length;
  const head = Math.max(1, Math.floor(available * headRatio));
  const tail = Math.max(1, available - head);
  const headEnd = safeCut(source, head);
  const tailStart = safeCut(source, source.length - tail);
  const out = `${source.slice(0, headEnd)}${MIDDLE_MARK}${source.slice(tailStart)}`;
  return out.length <= limit ? out : out.slice(0, limit);
}

export function summaryBudgetFor(action) {
  if (action === 'chapter') return 12000;
  if (action === 'research') return 6000;
  return 10000;
}

function rangeLabel(range) {
  return range.from === range.to ? `第 ${range.from} 章` : `第 ${range.from}–${range.to} 章`;
}

export function formatOmittedRanges(ranges) {
  return (Array.isArray(ranges) ? ranges : []).map(rangeLabel).join('、');
}

function missingRanges(indexes, included) {
  const missing = indexes.filter((index) => !included.has(index));
  const out = [];
  for (const index of missing) {
    const last = out[out.length - 1];
    if (last && index === last.to + 1) last.to = index;
    else out.push({ from: index, to: index });
  }
  return out;
}

function itemLine(item, style, summaryText) {
  const stale = item.stale ? '[可能过期]' : '';
  if (style === 'research') {
    return `- 第 ${item.index} 章 ${item.title}：${summaryText}${stale}`;
  }
  return `- [${item.index}] ${item.title}：${summaryText}${stale}`;
}

function itemFor(summary, style, maxItemChars) {
  const index = Number(summary.index);
  const title = truncateMiddle(String(summary.title || ''), 120);
  const fullSummary = String(summary.summary || '');
  const summaryText = truncateMiddle(fullSummary, maxItemChars);
  const line = itemLine({ index, title, stale: summary.stale }, style, summaryText);
  return {
    index,
    stale: Boolean(summary.stale),
    rawSummary: fullSummary,
    title,
    line,
    length: line.length + 1,
  };
}

function fitItem(item, remaining, style, maxItemChars) {
  if (remaining < 200) return null;
  const prefix = itemLine({ index: item.index, title: item.title, stale: item.stale }, style, '');
  const allowed = remaining - prefix.length - 1;
  if (allowed < 200) return null;
  const summaryText = truncateMiddle(item.rawSummary, Math.min(maxItemChars, allowed));
  const line = itemLine({ index: item.index, title: item.title, stale: item.stale }, style, summaryText);
  return { ...item, line, length: line.length + 1 };
}

export function selectSummaries(summaries, options = {}) {
  const valid = (Array.isArray(summaries) ? summaries : [])
    .filter((item) => Number.isInteger(item?.index) && item.index > 0)
    .sort((a, b) => a.index - b.index);
  const style = options.style === 'research' ? 'research' : 'main';
  const budgetChars = Math.max(1, Number(options.budgetChars) || summaryBudgetFor(options.action));
  const maxItemChars = Math.max(200, Number(options.maxItemChars) || 800);
  const focusIndexes = [...new Set(
    (Array.isArray(options.focusIndexes) ? options.focusIndexes : [])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0),
  )].slice(0, 4);
  const byIndex = new Map();
  for (const summary of valid) byIndex.set(summary.index, itemFor(summary, style, maxItemChars));

  const included = new Set();
  const selected = new Map();
  let used = 0;

  const add = (index, { allowTruncate = false, limit = budgetChars } = {}) => {
    if (included.has(index)) return true;
    const item = byIndex.get(index);
    if (!item) return false;
    let next = item;
    if (used + item.length > limit) {
      if (!allowTruncate) return false;
      next = fitItem(item, limit - used, style, maxItemChars);
      if (!next) return false;
    }
    included.add(index);
    selected.set(index, next);
    used += next.length;
    return true;
  };

  const newest = valid[valid.length - 1]?.index;
  const newestItem = byIndex.get(newest);
  const reserve = Math.min(newestItem?.length || 0, budgetChars);
  for (const index of focusIndexes) {
    if (index === newest) continue;
    add(index, { allowTruncate: true, limit: Math.max(0, budgetChars - reserve) });
  }
  if (Number.isInteger(newest)) add(newest, { allowTruncate: true });

  for (let at = valid.length - 1; at >= 0; at -= 1) {
    const index = valid[at].index;
    if (included.has(index)) continue;
    if (used + byIndex.get(index).length > budgetChars) continue;
    add(index);
  }

  const lines = [...selected.values()]
    .sort((a, b) => a.index - b.index)
    .map((item) => item.line);
  const text = lines.join('\n');
  const staleCount = [...selected.values()].filter((item) => item.stale).length;
  const indexes = valid.map((item) => item.index);
  return {
    text,
    includedIndexes: [...selected.keys()].sort((a, b) => a - b),
    omittedRanges: missingRanges(indexes, included),
    staleCount,
    usedChars: text.length,
    total: valid.length,
    budgetChars,
  };
}
