import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { alignSummaries, parseChapters } from './chapters.js';
import {
  cleanBookTerms,
  normalizeTermRequest,
  normalizeTerms,
  previewTermClean,
} from './terms.js';
import {
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_RESEARCH_MODEL,
  REASONING_EFFORTS,
  STEP_PRESETS,
  TOKEN_MAX,
  TOKEN_MIN,
} from './agent-settings.js';

const ID_RE = /^[a-z0-9]{10,32}$/;
const HIST_RE = /^[0-9]{8}-[0-9]{6}-(manuscript|outline|notes)(?:-\d+)?\.md$/;
const SECTIONS = {
  outline: 'outline.md',
  notes: 'notes.md',
  manuscript: 'manuscript.md',
};
const DEFAULT_MODEL = 'opencode-go/deepseek-v4.1-flash';
const MAX_HISTORY = 50;
const MAX_CONTENT = 32 * 1024 * 1024;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  return err;
}

function nowIso() {
  return new Date().toISOString();
}

function genId() {
  return Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

function countWords(text) {
  return Array.from(String(text || '').replace(/[\s　]/g, '')).length;
}

function countChapters(text, title = '') {
  return parseChapters(text, title).chapters.length;
}

function statsOf(manuscript, title = '') {
  return { words: countWords(manuscript), chapters: countChapters(manuscript, title) };
}

const TAG_KEYS = ['characters', 'locations', 'items', 'hooks'];

function normalizeTags(tags) {
  const out = {};
  for (const key of TAG_KEYS) {
    const list = Array.isArray(tags?.[key]) ? tags[key] : [];
    out[key] = list
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .slice(0, key === 'hooks' ? 3 : 6);
  }
  return out;
}

function normalizeSummaryEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const summary = String(raw.summary || '').trim();
  if (!summary) return null;

  return {
    index: Number.isInteger(raw.index) && raw.index > 0 ? raw.index : null,
    title: String(raw.title || raw.chapter || '').trim().slice(0, 200),
    summary: summary.slice(0, 4000),
    tags: normalizeTags(raw.tags),
    source: raw.source === 'user' ? 'user' : 'ai',
    sourceHash: typeof raw.sourceHash === 'string' ? raw.sourceHash.slice(0, 64) : '',
    at: String(raw.at || ''),
  };
}

function stripRuntimeSummary(entry) {
  const { stale, orphan, ...rest } = entry;
  return rest;
}

function parseSummaryFile(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { entries: [], migrated: false };
  }

  if (Array.isArray(parsed)) {
    return {
      entries: parsed.map(normalizeSummaryEntry).filter(Boolean),
      migrated: true,
    };
  }
  if (parsed && parsed.version === 2 && Array.isArray(parsed.chapters)) {
    return {
      entries: parsed.chapters.map(normalizeSummaryEntry).filter(Boolean),
      migrated: false,
    };
  }
  return { entries: [], migrated: false };
}

async function readText(file, fallback = '') {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeAtomic(file, content) {
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    if (err.code !== 'EPERM' && err.code !== 'EEXIST') {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    // Windows 上覆盖已有文件偶尔会拒绝，退一步先删再改名。
    await fs.rm(file, { force: true });
    await fs.rename(tmp, file);
  }
}

export function createStore(dataDir) {
  if (!dataDir) throw new Error('createStore 需要一个 dataDir');

  const root = path.resolve(dataDir);
  const booksDir = path.join(root, 'books');
  let initPromise;

  function init() {
    if (!initPromise) initPromise = fs.mkdir(booksDir, { recursive: true });
    return initPromise;
  }

  function bookDir(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) {
      throw httpError(400, '无效的书籍 id');
    }
    return path.join(booksDir, id);
  }

  const summaryLocks = new Map();

  function withSummaryLock(id, task) {
    const previous = summaryLocks.get(id) || Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.then(() => {}, () => {});
    summaryLocks.set(id, settled);
    settled.then(() => {
      if (summaryLocks.get(id) === settled) summaryLocks.delete(id);
    });
    return next;
  }

  async function readSummaryEntries(id) {
    const raw = await readText(path.join(bookDir(id), 'summaries.json'), '[]');
    return parseSummaryFile(raw).entries;
  }

  async function persistAlignedSummaries(id, chapters, { forceMigration = false } = {}) {
    return withSummaryLock(id, async () => {
      const entries = await readSummaryEntries(id);
      const latest = alignSummaries(entries, chapters);
      if (latest.changed || forceMigration) {
        await writeAtomic(
          path.join(bookDir(id), 'summaries.json'),
          JSON.stringify({
            version: 2,
            chapters: latest.summaries.map(stripRuntimeSummary),
          }, null, 2),
        );
      }
      return latest.summaries;
    });
  }

  async function readMetaById(id) {
    const dir = bookDir(id);
    try {
      const raw = await fs.readFile(path.join(dir, 'meta.json'), 'utf8');
      const meta = JSON.parse(raw);
      if (!meta || meta.id !== id) return null;
      return meta;
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      if (err instanceof SyntaxError) return null;
      throw err;
    }
  }

  async function listBooks() {
    await init();
    let entries = [];
    try {
      entries = await fs.readdir(booksDir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }

    const out = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
      try {
        const meta = await readMetaById(entry.name);
        if (!meta) continue;
        const manuscript = await readText(path.join(booksDir, entry.name, 'manuscript.md'));
        out.push({ ...meta, ...statsOf(manuscript, meta.title) });
      } catch {
        // 单本书坏了不影响整个书架。
      }
    }

    out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || b.id.localeCompare(a.id));
    return out;
  }

  async function getBook(id) {
    const meta = await readMetaById(id);
    if (!meta) return null;

    const dir = bookDir(id);
    const [outline, notes, manuscript, summariesRaw] = await Promise.all([
      readText(path.join(dir, 'outline.md')),
      readText(path.join(dir, 'notes.md')),
      readText(path.join(dir, 'manuscript.md')),
      readText(path.join(dir, 'summaries.json'), '[]'),
    ]);

    const parsedSummaries = parseSummaryFile(summariesRaw);
    const { chapters } = parseChapters(manuscript, meta.title);
    const aligned = alignSummaries(parsedSummaries.entries, chapters);

    let summaries = aligned.summaries;
    if (parsedSummaries.migrated || aligned.changed) {
      summaries = await persistAlignedSummaries(id, chapters, {
        forceMigration: parsedSummaries.migrated,
      });
    }

    const normalizedMeta = { ...meta, terms: normalizeTerms(meta.terms) };
    return {
      meta: normalizedMeta,
      outline,
      notes,
      manuscript,
      summaries,
      stats: statsOf(manuscript, normalizedMeta.title),
    };
  }

  async function createBook({ title = '', content = '', usage = 'continue' } = {}) {
    await init();

    if (!['continue', 'reference', 'read'].includes(usage)) {
      throw httpError(400, 'usage 只能是 continue / reference / read');
    }
    const text = String(content ?? '');
    if (text.length > MAX_CONTENT) throw httpError(413, '文稿太大');

    const cleanTitle = String(title || '').trim().slice(0, 200) || '未命名作品';

    let id = '';
    let dir = '';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = genId();
      const candidateDir = path.join(booksDir, candidate);
      try {
        await fs.mkdir(candidateDir);
        id = candidate;
        dir = candidateDir;
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
    if (!dir) throw httpError(500, '无法生成书籍 id');

    await fs.mkdir(path.join(dir, 'history'), { recursive: true });

    const now = nowIso();
    const meta = {
      id,
      title: cleanTitle,
      theme: '',
      usage,
      aiEnabled: usage !== 'read',
      aiMode: 'diff',
      model: DEFAULT_MODEL,
      goalWords: 0,
      maxTokens: DEFAULT_MAX_TOKENS,
      maxSteps: DEFAULT_MAX_STEPS,
      reasoningEffort: '',
      researchModel: DEFAULT_RESEARCH_MODEL,
      terms: [],
      createdAt: now,
      updatedAt: now,
    };

    const manuscript = usage === 'reference' ? '' : (text || `# ${cleanTitle}\n\n`);
    const notes = usage === 'reference' ? text : '';

    await Promise.all([
      writeAtomic(path.join(dir, 'manuscript.md'), manuscript),
      writeAtomic(path.join(dir, 'outline.md'), ''),
      writeAtomic(path.join(dir, 'notes.md'), notes),
      writeAtomic(path.join(dir, 'summaries.json'), JSON.stringify({ version: 2, chapters: [] }, null, 2)),
    ]);
    await writeAtomic(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));

    return getBook(id);
  }

  async function updateMeta(id, patch = {}) {
    const meta = await readMetaById(id);
    if (!meta) throw httpError(404, '书籍不存在');

    const next = { ...meta };

    if ('title' in patch) {
      if (typeof patch.title !== 'string' || !patch.title.trim()) {
        throw httpError(400, 'title 不能为空');
      }
      next.title = patch.title.trim().slice(0, 200);
    }
    if ('theme' in patch) {
      if (typeof patch.theme !== 'string') throw httpError(400, 'theme 必须是字符串');
      next.theme = patch.theme.slice(0, 10000);
    }
    if ('goalWords' in patch) {
      if (!Number.isInteger(patch.goalWords) || patch.goalWords < 0 || patch.goalWords > 1e9) {
        throw httpError(400, 'goalWords 必须是非负整数');
      }
      next.goalWords = patch.goalWords;
    }
    if ('model' in patch) {
      if (typeof patch.model !== 'string' || !patch.model.trim()) {
        throw httpError(400, 'model 不能为空');
      }
      next.model = patch.model.trim().slice(0, 200);
    }
    if ('aiEnabled' in patch) {
      if (typeof patch.aiEnabled !== 'boolean') throw httpError(400, 'aiEnabled 必须是布尔值');
      next.aiEnabled = patch.aiEnabled;
    }
    if ('aiMode' in patch) {
      if (!['auto', 'diff'].includes(patch.aiMode)) {
        throw httpError(400, 'aiMode 只能是 auto 或 diff');
      }
      next.aiMode = patch.aiMode;
    }
    if ('maxTokens' in patch) {
      const value = Number(patch.maxTokens);
      if (!Number.isInteger(value) || value < TOKEN_MIN || value > TOKEN_MAX) {
        throw httpError(400, `maxTokens 必须是 ${TOKEN_MIN}–${TOKEN_MAX} 的整数`);
      }
      next.maxTokens = value;
    }
    if ('maxSteps' in patch) {
      const value = Number(patch.maxSteps);
      if (!STEP_PRESETS.includes(value)) {
        throw httpError(400, `maxSteps 只能是 ${STEP_PRESETS.join(' / ')}`);
      }
      next.maxSteps = value;
    }
    if ('reasoningEffort' in patch) {
      const value = String(patch.reasoningEffort || '').trim();
      if (value && !REASONING_EFFORTS.includes(value)) {
        throw httpError(400, 'reasoningEffort 无效');
      }
      next.reasoningEffort = value;
    }
    if ('researchModel' in patch) {
      if (typeof patch.researchModel !== 'string') {
        throw httpError(400, 'researchModel 必须是字符串');
      }
      next.researchModel = patch.researchModel.trim().slice(0, 200);
    }
    if ('terms' in patch) {
      if (!Array.isArray(patch.terms)) throw httpError(400, 'terms 必须是数组');
      next.terms = normalizeTerms(patch.terms);
    }

    next.updatedAt = nowIso();
    await writeAtomic(path.join(bookDir(id), 'meta.json'), JSON.stringify(next, null, 2));
    return next;
  }

  async function pruneHistory(historyDir) {
    let files = [];
    try {
      files = await fs.readdir(historyDir);
    } catch {
      return;
    }
    const list = files.filter((file) => HIST_RE.test(file)).sort().reverse();
    for (const file of list.slice(MAX_HISTORY)) {
      await fs.rm(path.join(historyDir, file), { force: true }).catch(() => {});
    }

    const terms = files
      .filter((file) => /^[0-9]{8}-[0-9]{6}-terms(?:-\d+)?\.json$/.test(file))
      .sort()
      .reverse();
    for (const file of terms.slice(20)) {
      await fs.rm(path.join(historyDir, file), { force: true }).catch(() => {});
    }
  }

  async function backup(id, section, content, dir = bookDir(id)) {
    if (content === null || content === undefined || content.length === 0) return null;

    const historyDir = path.join(dir, 'history');
    await fs.mkdir(historyDir, { recursive: true });

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    let file = `${stamp}-${section}.md`;
    let suffix = 1;
    for (;;) {
      try {
        await fs.writeFile(path.join(historyDir, file), content, { encoding: 'utf8', flag: 'wx' });
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        suffix += 1;
        file = `${stamp}-${section}-${suffix}.md`;
      }
    }

    await pruneHistory(historyDir);
    return file;
  }

  async function updateSection(id, section, content) {
    const fileName = SECTIONS[section];
    if (!fileName) throw httpError(400, '未知分区');
    if (typeof content !== 'string') throw httpError(400, 'content 必须是字符串');
    if (content.length > MAX_CONTENT) throw httpError(413, '文稿太大');

    const meta = await readMetaById(id);
    if (!meta) throw httpError(404, '书籍不存在');

    const dir = bookDir(id);
    const target = path.join(dir, fileName);
    const old = await readText(target, null);

    if (old === content) {
      return { section, unchanged: true, ...statsOf(section === 'manuscript' ? content : '', meta.title) };
    }

    await backup(id, section, old, dir);
    await writeAtomic(target, content);

    const next = { ...meta, updatedAt: nowIso() };
    await writeAtomic(path.join(dir, 'meta.json'), JSON.stringify(next, null, 2));

    return { section, unchanged: false, ...statsOf(section === 'manuscript' ? content : '', meta.title) };
  }

  async function listHistory(id) {
    const meta = await readMetaById(id);
    if (!meta) throw httpError(404, '书籍不存在');

    const historyDir = path.join(bookDir(id), 'history');
    let files = [];
    try {
      files = await fs.readdir(historyDir);
    } catch {
      return [];
    }

    const out = [];
    for (const file of files) {
      const match = file.match(HIST_RE);
      if (!match) continue;
      const stat = await fs.stat(path.join(historyDir, file));
      out.push({
        file,
        section: match[1],
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      });
    }
    out.sort((a, b) => b.mtime.localeCompare(a.mtime) || b.file.localeCompare(a.file));
    return out;
  }

  async function readHistory(id, file) {
    const meta = await readMetaById(id);
    if (!meta) throw httpError(404, '书籍不存在');
    if (typeof file !== 'string' || !HIST_RE.test(file)) {
      throw httpError(400, '无效的备份文件名');
    }

    const content = await readText(path.join(bookDir(id), 'history', file), null);
    if (content === null) throw httpError(404, '备份不存在');
    return { file, content };
  }

  async function restoreHistory(id, file) {
    const { file: name, content } = await readHistory(id, file);
    const section = name.match(HIST_RE)[1];
    const result = await updateSection(id, section, content);
    return { ...result, restoredFrom: name };
  }

  async function deleteBook(id) {
    const meta = await readMetaById(id);
    if (!meta) throw httpError(404, '书籍不存在');
    await fs.rm(bookDir(id), { recursive: true, force: true });
    return { id, deleted: true };
  }

  async function bookExists(id) {
    try {
      return (await readMetaById(id)) !== null;
    } catch {
      return false;
    }
  }

  async function updateSummaries(id, summaries) {
    const meta = await readMetaById(id);
    if (!meta) throw httpError(404, '书籍不存在');

    const input = Array.isArray(summaries)
      ? summaries
      : (summaries && summaries.version === 2 && Array.isArray(summaries.chapters)
        ? summaries.chapters
        : null);
    if (!input) throw httpError(400, 'summaries 必须是数组或 v2 对象');
    if (input.length > 500) throw httpError(400, '摘要最多 500 条');

    const entries = input.map(normalizeSummaryEntry).filter(Boolean);
    const seen = new Set();
    for (const entry of entries) {
      if (entry.index === null) continue;
      if (seen.has(entry.index)) throw httpError(400, `摘要章节号重复：${entry.index}`);
      seen.add(entry.index);
    }

    const dir = bookDir(id);
    return withSummaryLock(id, async () => {
      const fresh = await readMetaById(id);
      if (!fresh) throw httpError(404, '书籍不存在');

      await writeAtomic(
        path.join(dir, 'summaries.json'),
        JSON.stringify({ version: 2, chapters: entries }, null, 2),
      );

      const next = { ...fresh, updatedAt: nowIso() };
      await writeAtomic(path.join(dir, 'meta.json'), JSON.stringify(next, null, 2));
      return entries;
    });
  }

  async function upsertSummary(id, entry) {
    const normalized = normalizeSummaryEntry(entry);
    if (!normalized) throw httpError(400, '摘要内容为空');
    if (normalized.index === null) throw httpError(400, '摘要缺少章节号');

    return withSummaryLock(id, async () => {
      const meta = await readMetaById(id);
      if (!meta) throw httpError(404, '书籍不存在');

      const dir = bookDir(id);
      const entries = await readSummaryEntries(id);
      const at = entries.findIndex((item) => item.index === normalized.index);
      if (at >= 0) entries[at] = { ...entries[at], ...normalized };
      else entries.push(normalized);

      await writeAtomic(
        path.join(dir, 'summaries.json'),
        JSON.stringify({ version: 2, chapters: entries }, null, 2),
      );

      const next = { ...meta, updatedAt: nowIso() };
      await writeAtomic(path.join(dir, 'meta.json'), JSON.stringify(next, null, 2));
      return at >= 0 ? entries[at] : entries[entries.length - 1];
    });
  }

  async function writeTermSnapshot(dir, snapshot) {
    const historyDir = path.join(dir, 'history');
    await fs.mkdir(historyDir, { recursive: true });

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    let file = `${stamp}-terms.json`;
    let suffix = 1;
    for (;;) {
      try {
        await fs.writeFile(path.join(historyDir, file), JSON.stringify(snapshot, null, 2), {
          encoding: 'utf8',
          flag: 'wx',
        });
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        suffix += 1;
        file = `${stamp}-terms-${suffix}.json`;
      }
    }
    await pruneHistory(historyDir);
    return file;
  }

  async function cleanTerms(id, options = {}) {
    const request = normalizeTermRequest(options);

    return withSummaryLock(id, async () => {
      const meta = await readMetaById(id);
      if (!meta) throw httpError(404, '书籍不存在');

      const dir = bookDir(id);
      const [outline, notes, manuscript, summariesRaw] = await Promise.all([
        readText(path.join(dir, 'outline.md')),
        readText(path.join(dir, 'notes.md')),
        readText(path.join(dir, 'manuscript.md')),
        readText(path.join(dir, 'summaries.json'), '[]'),
      ]);

      const parsed = parseSummaryFile(summariesRaw);
      const chapters = parseChapters(manuscript, meta.title).chapters;
      const summaries = alignSummaries(parsed.entries, chapters).summaries;
      const book = {
        meta: { ...meta, terms: normalizeTerms(meta.terms) },
        outline,
        notes,
        manuscript,
        summaries,
      };

      if (options.dryRun) {
        return { ...previewTermClean(book, request), changed: false };
      }

      const result = cleanBookTerms(book, { ...request, saveTerm: Boolean(options.saveTerm) });
      const { book: _next, ...counts } = result;

      if (!result.changed) {
        return { ...counts, changed: false, meta: book.meta };
      }

      for (const section of ['manuscript', 'outline', 'notes']) {
        if (book[section] !== result.book[section]) {
          await backup(id, section, book[section], dir);
        }
      }

      await writeTermSnapshot(dir, {
        version: 1,
        at: new Date().toISOString(),
        meta: book.meta,
        summaries: book.summaries,
      });

      if (book.manuscript !== result.book.manuscript) {
        await writeAtomic(path.join(dir, 'manuscript.md'), result.book.manuscript);
      }
      if (book.outline !== result.book.outline) {
        await writeAtomic(path.join(dir, 'outline.md'), result.book.outline);
      }
      if (book.notes !== result.book.notes) {
        await writeAtomic(path.join(dir, 'notes.md'), result.book.notes);
      }
      if (JSON.stringify(book.summaries) !== JSON.stringify(result.book.summaries)) {
        await writeAtomic(
          path.join(dir, 'summaries.json'),
          JSON.stringify({
            version: 2,
            chapters: result.book.summaries.map(stripRuntimeSummary),
          }, null, 2),
        );
      }
      if (JSON.stringify(book.meta) !== JSON.stringify(result.book.meta)) {
        await writeAtomic(path.join(dir, 'meta.json'), JSON.stringify(result.book.meta, null, 2));
      }

      return { ...counts, changed: true, meta: result.book.meta };
    });
  }

  return {
    dataDir: root,
    booksDir,
    listBooks,
    getBook,
    createBook,
    updateMeta,
    updateSection,
    updateSummaries,
    upsertSummary,
    cleanTerms,
    listHistory,
    readHistory,
    restoreHistory,
    deleteBook,
    bookExists,
  };
}
