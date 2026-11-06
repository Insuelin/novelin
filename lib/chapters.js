import crypto from 'node:crypto';

const HEADING_RE = /^(#{1,2})[ \t]+(.+?)[ \t]*$/;
const CN_CHAPTER_RE = /^第[一二三四五六七八九十百零〇两\d]+章(?:[ \t].*)?$/;

export function normalizeBody(body) {
  return String(body || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

export function contentHash(body) {
  return crypto.createHash('sha1').update(normalizeBody(body)).digest('hex');
}

function normalizeTitle(title) {
  return String(title || '').replace(/\s+/g, ' ').trim();
}

function scanHeadings(src) {
  const lines = src.split('\n');
  const headings = [];
  let offset = 0;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    const lineStart = offset;
    const lineEnd = lineStart + line.length;
    let level = 0;
    let title = '';

    const match = line.match(HEADING_RE);
    if (match) {
      level = match[1].length;
      title = match[2].trim();
    } else if (CN_CHAPTER_RE.test(line)) {
      level = 2;
      title = line.trim();
    }

    if (title) headings.push({ level, title, start: lineStart, lineEnd });
    offset = lineEnd + 1;
  }

  return headings;
}

/**
 * 从正文解析章节。章节标题只认 `##` / `第X章`；第一个 `#` 在能判断为书名时跳过。
 * 返回的 start 是标题行起点，bodyStart 是标题后正文起点，end 是下一章标题起点或文末。
 */
export function parseChapters(manuscript, bookTitle = '') {
  const src = String(manuscript || '');
  if (!src.trim()) return { chapters: [], preamble: null };

  const headings = scanHeadings(src);
  const book = normalizeTitle(bookTitle);
  const hasLevel2 = headings.some((heading) => heading.level === 2);

  let skipTitle = -1;
  if (headings.length && headings[0].level === 1) {
    const first = normalizeTitle(headings[0].title);
    if (book && first === book) skipTitle = 0;
    else if (!book && hasLevel2) skipTitle = 0;
  }

  const chapterHeads = headings.filter((_, index) => index !== skipTitle);

  if (!chapterHeads.length) {
    const titleHead = skipTitle === 0 ? headings[0] : null;
    const bodyStart = titleHead ? titleHead.lineEnd + 1 : 0;
    const body = src.slice(bodyStart).trim();
    return {
      chapters: [{
        index: 1,
        title: book || titleHead?.title || '全文',
        start: 0,
        bodyStart,
        end: src.length,
        chars: body.length,
        contentHash: contentHash(body),
      }],
      preamble: null,
    };
  }

  const chapters = [];
  for (let i = 0; i < chapterHeads.length; i += 1) {
    const head = chapterHeads[i];
    const next = chapterHeads[i + 1];
    const end = next ? next.start : src.length;

    let bodyStart = head.lineEnd;
    while (bodyStart < end) {
      const char = src[bodyStart];
      if (char === '\n' || char === '\r' || char === ' ' || char === '\t' || char === '　') {
        bodyStart += 1;
      } else {
        break;
      }
    }

    const body = src.slice(bodyStart, end).replace(/\s+$/, '');
    chapters.push({
      index: chapters.length + 1,
      title: head.title,
      start: head.start,
      bodyStart,
      end,
      chars: body.length,
      contentHash: contentHash(body),
    });
  }

  const first = chapterHeads[0];
  let preambleFrom = 0;
  if (skipTitle === 0) preambleFrom = headings[0].lineEnd + 1;
  const preambleText = src.slice(preambleFrom, first.start);
  const preamble = preambleText.trim() ? { start: preambleFrom, end: first.start } : null;

  return { chapters, preamble };
}

function pickClosest(candidates, oldIndex, claimed) {
  if (!candidates?.length) return null;
  const free = candidates.filter((chapter) => !claimed.has(chapter.index));
  if (!free.length) return null;
  if (!Number.isInteger(oldIndex)) return free[0];
  return free
    .slice()
    .sort((a, b) => Math.abs(a.index - oldIndex) - Math.abs(b.index - oldIndex) || a.index - b.index)[0];
}

/**
 * 摘要对齐：hash 优先；hash 不中再按标题+旧序号邻近；最后按旧序号兜底。
 * 返回的 summaries 带运行时 stale / orphan 标记，写盘前要去掉。
 */
export function alignSummaries(summaries, chapters) {
  const list = (Array.isArray(summaries) ? summaries : []).map((item) => ({ ...item }));
  const byHash = new Map();
  const byTitle = new Map();

  for (const chapter of chapters) {
    if (chapter.contentHash) {
      if (!byHash.has(chapter.contentHash)) byHash.set(chapter.contentHash, []);
      byHash.get(chapter.contentHash).push(chapter);
    }
    const key = normalizeTitle(chapter.title);
    if (!key) continue;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(chapter);
  }

  const claimed = new Set();
  let changed = false;

  for (const summary of list) {
    const wasOrphan = summary.index === null;
    const oldIndex = summary.index;

    let chapter = null;

    if (summary.sourceHash) {
      chapter = pickClosest(byHash.get(summary.sourceHash), oldIndex, claimed);
    }
    if (!chapter) {
      chapter = pickClosest(byTitle.get(normalizeTitle(summary.title)), oldIndex, claimed);
    }
    if (!chapter && Number.isInteger(oldIndex)) {
      chapter = chapters.find((item) => item.index === oldIndex && !claimed.has(item.index)) || null;
    }

    if (!chapter) {
      if (!wasOrphan) changed = true;
      summary.index = null;
      summary.orphan = true;
      summary.stale = true;
      continue;
    }

    claimed.add(chapter.index);
    if (summary.index !== chapter.index || normalizeTitle(summary.title) !== normalizeTitle(chapter.title)) {
      changed = true;
    }
    summary.index = chapter.index;
    summary.title = chapter.title;
    summary.orphan = false;

    if (!summary.sourceHash && chapter.contentHash) {
      // 旧版摘要没有版本信息，按当前正文补一个，避免一迁移就全部过期。
      summary.sourceHash = chapter.contentHash;
      summary.stale = false;
      changed = true;
    } else {
      summary.stale = Boolean(summary.sourceHash) && summary.sourceHash !== chapter.contentHash;
    }
  }

  return { summaries: list, changed };
}
