import { parseChapters } from './chapters.js';

export const TERM_SCOPES = ['manuscript', 'outline', 'notes', 'theme', 'summaries'];
const TAG_KEYS = ['characters', 'locations', 'items', 'hooks'];
const MAX_TERMS = 200;
const MAX_FIND = 200;
const MAX_REPLACE = 1000;

export class TermError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TermError';
    this.status = 400;
    this.expose = true;
  }
}

export function normalizeTerms(terms) {
  const list = Array.isArray(terms) ? terms : [];
  const out = [];
  const seen = new Set();

  for (const item of list) {
    const from = String(item?.from ?? '').trim();
    const to = String(item?.to ?? '');
    if (!from || from.length > MAX_FIND || /[\r\n]/.test(from)) continue;
    if (to.length > MAX_REPLACE || to.includes(from)) continue;
    if (seen.has(from)) continue;
    seen.add(from);
    out.push({ from, to });
  }

  return out.slice(0, MAX_TERMS);
}

export function upsertTerm(terms, from, to) {
  const list = normalizeTerms(terms).filter((item) => item.from !== from);
  list.push({ from, to });
  return normalizeTerms(list);
}

export function normalizeTermRequest({ find, replace = '', scopes } = {}) {
  const term = String(find ?? '').trim();
  if (!term) throw new TermError('find 不能为空');
  if (term.length > MAX_FIND) throw new TermError('find 太长');
  if (/[\r\n]/.test(term)) throw new TermError('find 不能包含换行');

  const to = String(replace ?? '');
  if (to.length > MAX_REPLACE) throw new TermError('replace 太长');
  if (to.includes(term)) throw new TermError('替换词不能包含原词');

  const requested = Array.isArray(scopes) && scopes.length ? scopes : TERM_SCOPES;
  const selected = requested.filter((scope) => TERM_SCOPES.includes(scope));
  if (!selected.length) throw new TermError('至少选择一个范围');

  return { find: term, replace: to, scopes: [...new Set(selected)] };
}

/** 把已保存的用词规则套到一段文字上。规则按原词长度从长到短应用。 */
export function applyTermRules(text, terms) {
  let out = String(text ?? '');
  const rules = normalizeTerms(terms).sort((a, b) => b.from.length - a.from.length);
  for (const rule of rules) {
    out = out.split(rule.from).join(rule.to);
  }
  return out;
}

export function countTerm(text, find) {
  const term = String(find ?? '');
  if (!term) return 0;
  const src = String(text ?? '');
  let count = 0;
  let at = 0;
  for (;;) {
    const index = src.indexOf(term, at);
    if (index < 0) break;
    count += 1;
    at = index + term.length;
  }
  return count;
}

export function replaceTerm(text, find, replace) {
  if (!find) return String(text ?? '');
  return String(text ?? '').split(find).join(replace);
}

function snippet(text, index, length, radius = 20) {
  const src = String(text ?? '');
  const start = Math.max(0, index - radius);
  const end = Math.min(src.length, index + length + radius);
  return `${start > 0 ? '…' : ''}${src.slice(start, end)}${end < src.length ? '…' : ''}`;
}

export function termSamples(text, find, limit = 3) {
  const src = String(text ?? '');
  const term = String(find ?? '');
  const out = [];
  if (!term) return out;

  let at = 0;
  while (out.length < limit) {
    const index = src.indexOf(term, at);
    if (index < 0) break;
    out.push(snippet(src, index, term.length));
    at = index + term.length;
  }
  return out;
}

function firstManuscriptTitle(text) {
  const match = String(text ?? '').match(/^(#{1,2})[ \t]+(.+)$/m);
  if (!match || match[1].length !== 1) return null;
  return { title: match[2].trim() };
}

function addScope(result, scope, text, limit = 3) {
  const count = countTerm(text, result.find);
  if (!count) return;
  result.counts[scope] = count;
  result.samples[scope] = termSamples(text, result.find, limit);
  result.total += count;
}

function addSummaries(result, summaries) {
  let summary = 0;
  let summaryTitle = 0;
  let tags = 0;
  const summarySamples = [];
  const titleSamples = [];
  const tagSamples = [];

  for (const entry of Array.isArray(summaries) ? summaries : []) {
    summary += countTerm(entry?.summary, result.find);
    summarySamples.push(...termSamples(entry?.summary, result.find, 2));
    summaryTitle += countTerm(entry?.title, result.find);
    titleSamples.push(...termSamples(entry?.title, result.find, 2));

    for (const key of TAG_KEYS) {
      for (const tag of Array.isArray(entry?.tags?.[key]) ? entry.tags[key] : []) {
        tags += countTerm(tag, result.find);
        tagSamples.push(...termSamples(tag, result.find, 2));
      }
    }
  }

  if (summary) {
    result.counts.summary = summary;
    result.samples.summary = summarySamples.slice(0, 3);
    result.total += summary;
  }
  if (summaryTitle) {
    result.counts.summaryTitle = summaryTitle;
    result.samples.summaryTitle = titleSamples.slice(0, 3);
    result.total += summaryTitle;
  }
  if (tags) {
    result.counts.tags = tags;
    result.samples.tags = tagSamples.slice(0, 3);
    result.total += tags;
  }
}

export function previewTermClean(book, options = {}) {
  const { find, replace, scopes } = normalizeTermRequest(options);
  const result = { find, replace, scopes, total: 0, counts: {}, samples: {} };

  if (scopes.includes('manuscript')) addScope(result, 'manuscript', book?.manuscript);
  if (scopes.includes('outline')) addScope(result, 'outline', book?.outline);
  if (scopes.includes('notes')) addScope(result, 'notes', book?.notes);
  if (scopes.includes('theme')) addScope(result, 'theme', book?.meta?.theme);
  if (scopes.includes('summaries')) addSummaries(result, book?.summaries);

  return result;
}

function replaceTags(tags, find, replace) {
  const out = {};
  for (const key of TAG_KEYS) {
    const list = Array.isArray(tags?.[key]) ? tags[key] : [];
    const mapped = list.map((tag) => replaceTerm(tag, find, replace));
    if (mapped.every((tag, index) => tag === list[index])) {
      out[key] = list;
      continue;
    }
    out[key] = [...new Set(mapped.map((tag) => tag.trim()).filter(Boolean))];
  }
  return out;
}

export function cleanBookTerms(book, options = {}) {
  const { find, replace, scopes } = normalizeTermRequest(options);
  const saveTerm = Boolean(options.saveTerm);
  const now = options.now || new Date().toISOString();

  const next = {
    ...book,
    meta: { ...(book?.meta || {}) },
    summaries: (Array.isArray(book?.summaries) ? book.summaries : []).map((entry) => ({
      ...entry,
      tags: { ...(entry?.tags || {}) },
    })),
  };

  let changed = false;

  if (scopes.includes('manuscript')) {
    const value = replaceTerm(next.manuscript, find, replace);
    if (value !== next.manuscript) {
      next.manuscript = value;
      changed = true;
    }

    const oldHeading = firstManuscriptTitle(book?.manuscript);
    const newHeading = firstManuscriptTitle(next.manuscript);
    const metaTitle = String(book?.meta?.title || '').trim();
    if (
      oldHeading
      && newHeading
      && metaTitle
      && oldHeading.title === metaTitle
      && newHeading.title !== oldHeading.title
    ) {
      next.meta.title = newHeading.title;
      changed = true;
    }
  }
  if (scopes.includes('outline')) {
    const value = replaceTerm(next.outline, find, replace);
    if (value !== next.outline) {
      next.outline = value;
      changed = true;
    }
  }
  if (scopes.includes('notes')) {
    const value = replaceTerm(next.notes, find, replace);
    if (value !== next.notes) {
      next.notes = value;
      changed = true;
    }
  }
  if (scopes.includes('theme')) {
    const value = replaceTerm(next.meta.theme, find, replace);
    if (value !== next.meta.theme) {
      next.meta.theme = value;
      changed = true;
    }
  }

  const touchedSummaries = new Set();
  if (scopes.includes('summaries')) {
    for (const entry of next.summaries) {
      let touched = false;

      const summary = replaceTerm(entry.summary, find, replace);
      if (summary !== entry.summary) {
        entry.summary = summary;
        touched = true;
      }

      const title = replaceTerm(entry.title, find, replace);
      if (title !== entry.title) {
        entry.title = title;
        changed = true;
      }

      const tags = replaceTags(entry.tags, find, replace);
      if (JSON.stringify(tags) !== JSON.stringify({
        characters: Array.isArray(entry.tags?.characters) ? entry.tags.characters : [],
        locations: Array.isArray(entry.tags?.locations) ? entry.tags.locations : [],
        items: Array.isArray(entry.tags?.items) ? entry.tags.items : [],
        hooks: Array.isArray(entry.tags?.hooks) ? entry.tags.hooks : [],
      })) {
        entry.tags = tags;
        touched = true;
      }

      if (touched) {
        entry.source = 'user';
        entry.at = now;
        touchedSummaries.add(entry);
        changed = true;
      }
    }
  }

  if (scopes.includes('manuscript') || scopes.includes('summaries')) {
    const oldChapters = parseChapters(book?.manuscript || '', book?.meta?.title).chapters;
    const newChapters = parseChapters(next.manuscript || '', next.meta.title).chapters;
    const oldByIndex = new Map(oldChapters.map((chapter) => [chapter.index, chapter]));
    const newByIndex = new Map(newChapters.map((chapter) => [chapter.index, chapter]));

    for (const entry of next.summaries) {
      if (!Number.isInteger(entry.index)) continue;
      const newChapter = newByIndex.get(entry.index);
      const oldChapter = oldByIndex.get(entry.index);

      if (scopes.includes('manuscript') && newChapter) {
        if (entry.title !== newChapter.title) {
          entry.title = newChapter.title;
          changed = true;
        }
      }

      if (touchedSummaries.has(entry)) {
        const hash = newChapter?.contentHash || oldChapter?.contentHash || entry.sourceHash || '';
        if (entry.sourceHash !== hash) {
          entry.sourceHash = hash;
          changed = true;
        }
      }
    }
  }

  if (saveTerm) {
    const current = normalizeTerms(next.meta.terms);
    const existing = current.find((item) => item.from === find);
    const terms = existing && existing.to === replace ? current : upsertTerm(current, find, replace);
    if (JSON.stringify(terms) !== JSON.stringify(current)) {
      next.meta.terms = terms;
      changed = true;
    }
  }

  if (changed) next.meta.updatedAt = now;

  return {
    book: next,
    changed,
    ...previewTermClean(book, { find, replace, scopes }),
  };
}
