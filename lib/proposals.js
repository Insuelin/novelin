import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const BOOK_ID_RE = /^[a-z0-9]{10,32}$/;
const PROPOSAL_ID_RE = /^[a-z0-9]{10,40}$/;
const MAX_DECISION_STRING = 2 * 1024 * 1024;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  return err;
}

function genId() {
  return Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

function proposalDir(store, bookId) {
  if (typeof bookId !== 'string' || !BOOK_ID_RE.test(bookId)) {
    throw httpError(400, '无效的书籍 id');
  }
  return path.join(store.booksDir, bookId, 'proposals');
}

function proposalPath(store, bookId, proposalId) {
  if (typeof proposalId !== 'string' || !PROPOSAL_ID_RE.test(proposalId)) {
    throw httpError(400, '无效的提案 id');
  }
  return path.join(proposalDir(store, bookId), `${proposalId}.json`);
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' || err instanceof SyntaxError) return null;
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
    await fs.rm(file, { force: true });
    await fs.rename(tmp, file);
  }
}

export function replaceUnique(text, oldString, newString, label = '文本') {
  if (typeof oldString !== 'string' || oldString.length === 0) {
    throw httpError(400, `${label}的 old_string 不能为空`);
  }
  if (typeof newString !== 'string') {
    throw httpError(400, `${label}的 new_string 必须是字符串`);
  }

  const first = text.indexOf(oldString);
  if (first < 0) throw httpError(409, `${label}里找不到 old_string`);
  const second = text.indexOf(oldString, first + oldString.length);
  if (second >= 0) throw httpError(409, `${label}里 old_string 不唯一，请加长`);

  return text.slice(0, first) + newString + text.slice(first + oldString.length);
}

function stripLeadingHeading(content) {
  return String(content || '')
    .replace(/^\s*#{1,6}\s+[^\n]*\n+/, '')
    .replace(/^\s*第[一二三四五六七八九十百零〇两\d]+章[^\n]*\n+/, '');
}

export function appendChapter(manuscript, title, content) {
  const body = stripLeadingHeading(content).trim();
  if (!body) throw httpError(400, '章节内容为空');

  const base = String(manuscript || '').replace(/\s+$/, '');
  const block = `## ${title || '未命名章节'}\n\n${body}`;
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}

export async function createProposal(store, bookId, data = {}) {
  if (!(await store.bookExists(bookId))) throw httpError(404, '书籍不存在');

  const dir = proposalDir(store, bookId);
  await fs.mkdir(dir, { recursive: true });

  const proposal = {
    id: genId(),
    bookId,
    status: 'pending',
    createdAt: new Date().toISOString(),
    mode: data.mode || 'diff',
    action: data.action || 'chat',
    instruction: String(data.instruction || ''),
    model: String(data.model || ''),
    summary: String(data.summary || ''),
    ops: Array.isArray(data.ops) ? data.ops : [],
  };

  await writeAtomic(path.join(dir, `${proposal.id}.json`), JSON.stringify(proposal, null, 2));
  return proposal;
}

export async function listProposals(store, bookId, { status } = {}) {
  const dir = proposalDir(store, bookId);
  let files = [];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }

  const out = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const proposal = await readJson(path.join(dir, file));
    if (!proposal) continue;
    if (status && proposal.status !== status) continue;
    out.push(proposal);
  }
  out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return out;
}

export async function getProposal(store, bookId, proposalId) {
  return readJson(proposalPath(store, bookId, proposalId));
}

export async function setProposalStatus(store, bookId, proposalId, status) {
  const file = proposalPath(store, bookId, proposalId);
  const proposal = await readJson(file);
  if (!proposal) throw httpError(404, '提案不存在');

  proposal.status = status;
  proposal.updatedAt = new Date().toISOString();
  await writeAtomic(file, JSON.stringify(proposal, null, 2));
  return proposal;
}

/**
 * 按前端逐块决定筛选 ops：拒绝的跳过，改过的新文本替换 new_string。
 * edits: [{ opIndex, accepted, newString }]
 */
export function applyDecisions(ops, edits) {
  if (!Array.isArray(ops)) throw httpError(400, '提案格式错误');
  if (!Array.isArray(edits)) throw httpError(400, 'edits 必须是数组');
  if (edits.length > ops.length) throw httpError(400, 'edits 数量超出提案');

  const decisions = new Map();
  for (const edit of edits) {
    if (!edit || typeof edit !== 'object') throw httpError(400, 'edit 格式错误');
    const index = edit.opIndex;
    if (!Number.isInteger(index) || index < 0 || index >= ops.length) {
      throw httpError(400, 'edit.opIndex 无效');
    }
    if (decisions.has(index)) throw httpError(400, 'edit.opIndex 重复');

    let newString = null;
    if ('newString' in edit) {
      if (typeof edit.newString !== 'string') throw httpError(400, 'newString 必须是字符串');
      if (edit.newString.length > MAX_DECISION_STRING) throw httpError(400, 'newString 太长');
      newString = edit.newString;
    }
    decisions.set(index, { accepted: edit.accepted !== false, newString });
  }

  const next = [];
  for (let index = 0; index < ops.length; index += 1) {
    const op = ops[index];
    const decision = decisions.get(index);
    if (!decision) {
      next.push(op);
      continue;
    }
    if (!decision.accepted) continue;
    if (op.type === 'edit_manuscript' && decision.newString !== null) {
      next.push({ ...op, new_string: decision.newString });
    } else {
      next.push(op);
    }
  }

  if (!next.length) throw httpError(400, '没有可应用的修改');
  return next;
}

/**
 * 先校验所有操作，再一次性写盘。任何一步失败都不会留下半套修改。
 */
export async function applyOps(store, bookId, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    throw httpError(400, '没有可应用的修改');
  }

  const book = await store.getBook(bookId);
  if (!book) throw httpError(404, '书籍不存在');

  let manuscript = book.manuscript;
  let outline = book.outline;
  let summaries = Array.isArray(book.summaries) ? [...book.summaries] : [];
  const changed = new Set();

  for (const op of ops) {
    if (!op || typeof op !== 'object') throw httpError(400, '操作格式错误');

    switch (op.type) {
      case 'append_chapter': {
        manuscript = appendChapter(manuscript, op.title, op.content);
        changed.add('manuscript');
        break;
      }
      case 'edit_manuscript': {
        manuscript = replaceUnique(manuscript, op.old_string, op.new_string, '正文');
        changed.add('manuscript');
        break;
      }
      case 'edit_outline': {
        outline = replaceUnique(outline, op.old_string, op.new_string, '大纲');
        changed.add('outline');
        break;
      }
      case 'save_summary': {
        const summary = String(op.summary || '').trim();
        if (summary) {
          const index = Number.isInteger(op.index) ? op.index : null;
          const title = String(op.title || op.chapter || '').trim();
          const entry = {
            index,
            title,
            summary,
            tags: op.tags && typeof op.tags === 'object' ? op.tags : {},
            source: op.source === 'user' ? 'user' : 'ai',
            sourceHash: typeof op.sourceHash === 'string' ? op.sourceHash : '',
            at: new Date().toISOString(),
          };

          let at = -1;
          if (index !== null) at = summaries.findIndex((item) => item && item.index === index);
          if (at < 0 && title) {
            at = summaries.findIndex((item) => item && String(item.title || item.chapter || '') === title);
          }
          if (at >= 0) summaries[at] = { ...summaries[at], ...entry };
          else summaries.push(entry);
          changed.add('summaries');
        }
        break;
      }
      default:
        throw httpError(400, `未知操作：${op.type}`);
    }
  }

  const result = { changed: [...changed] };

  if (changed.has('manuscript')) {
    result.manuscript = await store.updateSection(bookId, 'manuscript', manuscript);
  }
  if (changed.has('outline')) {
    result.outline = await store.updateSection(bookId, 'outline', outline);
  }
  if (changed.has('summaries')) {
    await store.updateSummaries(bookId, summaries);
  }

  return result;
}
