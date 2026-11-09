const BLOCK_CHANGE_CHARS = 1600;
const MAX_QUOTE_LENGTH = 4000;

export function normalizeReviewText(value) {
  let text = String(value ?? '');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n?/g, '\n');
}

export function plainQuoteText(value) {
  return String(value)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-+*]\s+|\d+\.\s+)/gm, '')
    .replace(/[*_~`]+/g, '')
    .replace(/\\([\\`*_{}\[\]()#+\-.!])/g, '$1');
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function adjustRange(range, at, oldLength, newLength) {
  if (!range) return null;
  const delta = newLength - oldLength;
  const from = Number(range.from);
  const to = Number(range.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;

  let nextFrom;
  let nextTo;
  if (at + oldLength <= from) {
    nextFrom = from + delta;
    nextTo = to + delta;
  } else if (at >= to) {
    nextFrom = from;
    nextTo = to;
  } else {
    nextFrom = Math.min(from, at);
    nextTo = Math.max(to, at + newLength);
  }

  return {
    ...range,
    from: Math.max(0, nextFrom),
    to: Math.max(0, nextTo),
  };
}

function overlap(a, b) {
  return a.from < b.to && b.from < a.to;
}

function sameEmptyPoint(a, b) {
  return a.from === a.to && b.from === b.to && a.from === b.from;
}

export function computeReviewClusters(changes) {
  const sorted = [...(changes || [])].sort((a, b) => a.start - b.start || a.end - b.end);
  const groups = [];

  for (const change of sorted) {
    const last = groups[groups.length - 1];
    const range = { from: change.start, to: change.end };
    const lastRange = last ? { from: last.start, to: last.end } : null;
    if (last && (overlap(range, lastRange) || sameEmptyPoint(range, lastRange))) {
      last.end = Math.max(last.end, change.end);
      last.changes.push(change);
    } else {
      groups.push({ start: change.start, end: change.end, changes: [change] });
    }
  }

  const seen = new Set();
  return groups.map((group, index) => {
    const id = `cluster-${index + 1}`;
    for (const change of group.changes) {
      change.clusterId = id;
      change.editable = group.changes.length === 1;
      seen.add(change.id);
    }
    return {
      id,
      start: group.start,
      end: group.end,
      editable: group.changes.length === 1,
      changeIds: group.changes.map((change) => change.id),
      opIndexes: group.changes
        .map((change) => change.opIndex)
        .filter((value) => Number.isInteger(value)),
    };
  });
}

export function findQuoteRanges(text, quotes) {
  const source = String(text || '');
  const ranges = [];
  for (const raw of Array.isArray(quotes) ? quotes : []) {
    const quote = String(raw || '').trim().slice(0, MAX_QUOTE_LENGTH);
    if (!quote) continue;
    let at = source.indexOf(quote);
    let length = quote.length;
    if (at < 0) {
      const plain = plainQuoteText(quote).trim();
      if (!plain) continue;
      at = source.indexOf(plain);
      length = plain.length;
    }
    if (at < 0) continue;
    const range = { from: at, to: at + length, quote };
    if (ranges.some((item) => overlap(item, range))) continue;
    ranges.push(range);
  }
  return ranges;
}

export function mapRangeThroughEdit(range, at, oldLength, newLength) {
  return adjustRange(range, at, oldLength, newLength);
}

export function applyReviewChange(review, op, opIndex = null) {
  if (!review || !op || op.type !== 'edit_manuscript') return false;

  const oldText = normalizeReviewText(op.old_string || '');
  const newText = normalizeReviewText(op.new_string || '');
  if (!oldText) return false;

  const index = review.text.indexOf(oldText);
  if (index < 0) return false;

  const delta = newText.length - oldText.length;
  for (const change of review.changes || []) {
    if (index + oldText.length <= change.start) {
      change.start += delta;
      change.end += delta;
    }
  }
  if (review.pendingSelection) {
    review.pendingSelection = adjustRange(review.pendingSelection, index, oldText.length, newText.length);
  }
  if (Array.isArray(review.quoteRanges)) {
    review.quoteRanges = review.quoteRanges
      .map((range) => adjustRange(range, index, oldText.length, newText.length))
      .filter(Boolean);
  }

  review.text = review.text.slice(0, index) + newText + review.text.slice(index + oldText.length);
  review.changeSeq = (review.changeSeq || 0) + 1;
  review.changes = review.changes || [];
  review.changes.push({
    id: `change-${review.changeSeq}`,
    start: index,
    end: index + newText.length,
    old: oldText,
    new: newText,
    edited: undefined,
    accepted: true,
    opIndex,
  });
  review.changes.sort((a, b) => a.start - b.start || a.end - b.end);
  review.clusters = computeReviewClusters(review.changes);
  review.overlap = review.clusters.some((cluster) => cluster.changeIds.length > 1);
  review.progress = '';
  return true;
}

function isBlockChange(change) {
  return Boolean(change?.block)
    || /[\n\r]/.test(change?.old || '')
    || /[\n\r]/.test(change?.new || '')
    || (String(change?.old || '').length + String(change?.new || '').length) > BLOCK_CHANGE_CHARS;
}

function frameChange(change, cluster, text) {
  const start = clamp(change.start, 0, text.length);
  const end = clamp(change.end, start, text.length);
  return {
    id: change.id,
    opIndex: Number.isInteger(change.opIndex) ? change.opIndex : null,
    start,
    end,
    old: normalizeReviewText(change.old),
    new: normalizeReviewText(change.new),
    edited: change.edited,
    accepted: change.accepted !== false,
    editable: Boolean(cluster?.editable),
    clusterId: cluster?.id || '',
    block: isBlockChange(change),
  };
}

function frameCluster(cluster, changes, text) {
  const start = clamp(cluster.start, 0, text.length);
  const end = clamp(cluster.end, start, text.length);
  const editable = cluster.changeIds.length === 1;
  return {
    id: cluster.id,
    start,
    end,
    old: '',
    new: text.slice(start, end),
    edited: undefined,
    accepted: true,
    editable,
    clusterId: cluster.id,
    block: !editable || changes.some((change) => isBlockChange(change)),
    changeIds: [...cluster.changeIds],
    opIndexes: [...cluster.opIndexes],
  };
}

export function buildReviewFrame(review) {
  if (!review) return null;
  const text = normalizeReviewText(review.text);
  const changes = Array.isArray(review.changes) ? review.changes : [];
  const clusters = Array.isArray(review.clusters) && review.clusters.length
    ? review.clusters
    : computeReviewClusters(changes);
  const byId = new Map(changes.map((change) => [change.id, change]));

  const frameChanges = [];
  for (const cluster of clusters) {
    const members = cluster.changeIds.map((id) => byId.get(id)).filter(Boolean);
    if (!members.length) continue;
    if (members.length === 1) frameChanges.push(frameChange(members[0], cluster, text));
    else frameChanges.push(frameCluster(cluster, members, text));
  }

  const pendingSelection = review.pendingSelection
    ? {
      from: clamp(review.pendingSelection.from, 0, text.length),
      to: clamp(review.pendingSelection.to, 0, text.length),
    }
    : null;
  if (pendingSelection && pendingSelection.from > pendingSelection.to) {
    [pendingSelection.from, pendingSelection.to] = [pendingSelection.to, pendingSelection.from];
  }

  const pendingQuotes = (Array.isArray(review.quoteRanges) ? review.quoteRanges : [])
    .map((range) => ({
      from: clamp(range.from, 0, text.length),
      to: clamp(range.to, 0, text.length),
    }))
    .filter((range) => range.to > range.from);

  const pendingChapter = (review.action === 'chapter' || review.draftFinal)
    ? {
      draft: normalizeReviewText(review.draft),
      final: Boolean(review.draftFinal),
      auto: Boolean(review.auto),
      version: review.version || 0,
    }
    : null;

  return {
    version: review.version || 0,
    action: review.action || 'chat',
    status: review.status || '',
    length: text.length,
    notice: String(review.notice || ''),
    changes: frameChanges,
    pendingSelection,
    pendingQuotes,
    pendingChapter,
    overlap: frameChanges.some((change) => !change.editable),
  };
}

export function buildReviewDecisions(review) {
  if (!review) return null;
  const changes = [...(review.changes || [])].sort((a, b) => a.start - b.start);
  const clusterById = new Map((review.clusters || []).map((cluster) => [cluster.id, cluster]));
  const edits = [];

  for (const change of changes) {
    if (!Number.isInteger(change.opIndex)) continue;
    const cluster = clusterById.get(change.clusterId);
    const grouped = cluster && cluster.changeIds.length > 1;
    if (grouped) {
      edits.push({ opIndex: change.opIndex, accepted: true });
      continue;
    }
    edits.push({
      opIndex: change.opIndex,
      accepted: change.accepted !== false,
      newString: change.edited !== undefined ? change.edited : change.new,
    });
  }

  return edits.length ? { edits } : null;
}
