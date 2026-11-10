import express from 'express';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createStore } from './lib/store.js';
import { searchBooks } from './lib/search.js';
import { createAiClient, sessionIdForBook } from './lib/ai.js';
import { createDebugLog } from './lib/debug-log.js';
import { runAgent, summarizeChapter } from './lib/agent.js';
import { runAudit } from './lib/audit.js';
import { analyzeMaterial } from './lib/material-keywords.js';
import { applyDecisions, applyOps, listProposals, getProposal, setProposalStatus } from './lib/proposals.js';
import { normalizeAgentSettings } from './lib/agent-settings.js';
import { parseChapters } from './lib/chapters.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '0.1.0';

/**
 * 接受提案后，取 accepted ops 里 append_chapter 对应的最后 N 章，交给前端后台生成摘要。
 */
function appendedChapterInfo(book, ops) {
  const count = (Array.isArray(ops) ? ops : [])
    .filter((op) => op && op.type === 'append_chapter').length;
  if (!count || !book) return [];

  const chapters = parseChapters(book.manuscript, book.meta.title).chapters;
  return chapters.slice(-count).map((chapter) => ({
    index: chapter.index,
    title: chapter.title,
  }));
}

function publicSummary(entry) {
  if (!entry) return null;
  const { stale, orphan, ...rest } = entry;
  return rest;
}

function aiForBook(ai, book) {
  const sessionId = sessionIdForBook(book?.meta?.id);
  return sessionId && typeof ai?.withSession === 'function'
    ? ai.withSession(sessionId)
    : ai;
}

export function buildChapterInstruction(extra = '') {
  const fixed = '写下一章，承接前文。';
  const value = String(extra || '').trim().slice(0, 8000);
  if (!value) return fixed;
  return `${fixed}\n\n【补充要求】\n${value}\n\n如果补充要求与整章正文的格式规则冲突，以整章正文的格式规则为准。`;
}

export function createApp({ dataDir, aiClient } = {}) {
  const resolvedDataDir = dataDir || process.env.DATA_DIR || path.join(__dirname, 'data');
  const store = createStore(resolvedDataDir);
  const debugLog = createDebugLog({ dir: path.join(resolvedDataDir, 'logs') });
  const ai = aiClient || createAiClient({ debugLog: debugLog.enabled ? debugLog.log : null });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32mb' }));

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, name: 'novelin', version: VERSION });
  });

  app.post('/api/debug/log', (req, res) => {
    const entries = Array.isArray(req.body?.entries) ? req.body.entries.slice(0, 100) : [];
    for (const entry of entries) {
      const level = ['info', 'warn', 'error'].includes(entry?.level) ? entry.level : 'info';
      debugLog.log('client.log', {
        source: 'client',
        at: String(entry?.at || '').slice(0, 40),
        time: String(entry?.time || '').slice(0, 20),
        tag: String(entry?.tag || '').slice(0, 40),
        text: String(entry?.text || '').slice(0, 8000),
        bookId: String(entry?.bookId || '').slice(0, 80),
        view: String(entry?.view || '').slice(0, 40),
      }, level);
    }
    res.json({ ok: true });
  });

  app.get('/api/models', async (req, res) => {
    try {
      const models = await ai.listModels();
      return res.json({ models });
    } catch (err) {
      return res.status(502).json({ error: err.message || '读取模型列表失败' });
    }
  });

  app.get('/api/search', async (req, res, next) => {
    try {
      const query = String(req.query.q || '').trim();
      if (!query) return res.status(400).json({ error: 'q 不能为空' });
      if (query.length > 200) return res.status(400).json({ error: 'q 太长' });

      const metas = await store.listBooks();
      const books = (await Promise.all(
        metas.map((meta) => store.getBook(meta.id).catch(() => null)),
      )).filter(Boolean);

      return res.json({ query, results: searchBooks(books, query) });
    } catch (err) {
      return next(err);
    }
  });

  app.get('/api/books', async (req, res, next) => {
    try {
      res.json({ books: await store.listBooks() });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/books/:id/ai', async (req, res, next) => {
    let book;
    try {
      book = await store.getBook(req.params.id);
    } catch (err) {
      return next(err);
    }
    if (!book) return res.status(404).json({ error: '书籍不存在' });
    if (!book.meta.aiEnabled) return res.status(400).json({ error: '这本书没有开启 AI' });

    const body = req.body || {};
    const mode = body.mode || book.meta.aiMode || 'diff';
    const action = body.action || 'chapter';
    const instruction = String(body.instruction || '').trim();
    const model = body.model ? String(body.model).slice(0, 200) : book.meta.model;
    const selection = body.selection || null;

    if (!['auto', 'diff'].includes(mode)) {
      return res.status(400).json({ error: 'mode 只能是 auto 或 diff' });
    }
    if (!['chapter', 'revise', 'chat', 'plot'].includes(action)) {
      return res.status(400).json({ error: 'action 只能是 chapter / revise / chat / plot' });
    }
    if (instruction.length > 8000) {
      return res.status(400).json({ error: 'instruction 太长' });
    }
    if (!instruction && action !== 'chapter') {
      return res.status(400).json({ error: 'instruction 不能为空' });
    }

    const rawPlotItems = Array.isArray(body.plotItems) ? body.plotItems.slice(0, 8) : [];
    const plotItems = [];    if (action === 'plot') {
      if (!rawPlotItems.length) {
        return res.status(400).json({ error: 'plotItems 不能为空' });
      }
      for (const raw of rawPlotItems) {
        const quote = String(raw?.quote || '').trim();
        if (!quote || quote.length > 400) continue;

        const first = book.manuscript.indexOf(quote);
        if (first < 0) continue;
        const second = book.manuscript.indexOf(quote, first + quote.length);
        if (second >= 0) continue;

        const chapterIndex = Number(raw.chapterIndex);
        plotItems.push({
          chapterIndex: Number.isInteger(chapterIndex) ? chapterIndex : null,
          quote,
          reason: String(raw.reason || '').trim().slice(0, 300),
          context: String(raw.context || '').slice(0, 2000),
          contextScope: ['paragraph', 'scene', 'chapter'].includes(raw.contextScope)
            ? raw.contextScope
            : 'paragraph',
        });
      }
      if (!plotItems.length) {
        return res.status(400).json({ error: '选中的段落已经对不上正文，请重新审查' });
      }
    }
    if (selection !== null) {
      if (
        typeof selection !== 'object'
        || typeof selection.text !== 'string'
        || selection.text.length > 8000
      ) {
        return res.status(400).json({ error: 'selection.text 必须是字符串，且不超过 8000 字' });
      }
      for (const key of ['before', 'after']) {
        if (selection[key] !== undefined) {
          if (typeof selection[key] !== 'string' || selection[key].length > 1000) {
            return res.status(400).json({ error: `selection.${key} 必须是字符串，且不超过 1000 字` });
          }
        }
      }
      if (selection.chapter !== undefined) {
        if (typeof selection.chapter !== 'string' || selection.chapter.length > 200) {
          return res.status(400).json({ error: 'selection.chapter 必须是不超过 200 字的字符串' });
        }
      }
    }

    if (body.materialIds !== undefined && !Array.isArray(body.materialIds)) {
      return res.status(400).json({ error: 'materialIds 必须是数组' });
    }
    if (Array.isArray(body.materialIds) && body.materialIds.length > 8) {
      return res.status(400).json({ error: '一次最多手动加入 8 份资料' });
    }
    const knownMaterialIds = new Set(
      (Array.isArray(book.materials) ? book.materials : [])
        .filter((material) => material.enabled !== false)
        .map((material) => material.id),
    );
    const materialIds = [...new Set(
      (Array.isArray(body.materialIds) ? body.materialIds : [])
        .map((id) => String(id || '').trim())
        .filter((id) => knownMaterialIds.has(id)),
    )];
    if (body.ignoredMaterialIds !== undefined && !Array.isArray(body.ignoredMaterialIds)) {
      return res.status(400).json({ error: 'ignoredMaterialIds 必须是数组' });
    }
    const ignoredMaterialIds = [...new Set(
      (Array.isArray(body.ignoredMaterialIds) ? body.ignoredMaterialIds : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean)
        .slice(0, 100),
    )];

    const settings = normalizeAgentSettings(book.meta);
    const finalInstruction = action === 'chapter' ? buildChapterInstruction(instruction) : instruction;

    const runId = randomUUID();
    const runStartedAt = Date.now();
    debugLog.log('ai.run.start', {
      runId,
      bookId: book.meta.id,
      title: book.meta.title || '',
      mode,
      action,
      model,
      maxTokens: settings.maxTokens,
      maxSteps: settings.maxSteps,
      reasoningEffort: settings.reasoningEffort,
      instruction: finalInstruction,
      selection: selection
        ? {
          chapter: String(selection.chapter || '').slice(0, 200),
          text: String(selection.text || '').slice(0, 8000),
          before: String(selection.before || '').slice(-1000),
          after: String(selection.after || '').slice(0, 1000),
        }
        : null,
      plotItems: plotItems.length,
      plotDropped: action === 'plot' ? rawPlotItems.length - plotItems.length : 0,
      materialIds,
      ignoredMaterialIds,
    });

    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    let closed = false;
    const controller = new AbortController();
    const onClose = () => {
      closed = true;
      controller.abort();
    };
    res.on('close', onClose);

    const send = (type, payload) => {
      if (closed || res.writableEnded) return;
      res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    send('meta', {
      bookId: book.meta.id,
      mode,
      action,
      model,
      maxTokens: settings.maxTokens,
      maxSteps: settings.maxSteps,
      reasoningEffort: settings.reasoningEffort,
      plotItems: plotItems.length,
      plotDropped: action === 'plot' ? rawPlotItems.length - plotItems.length : 0,
      materials: materialIds.length,
      materialsIgnored: ignoredMaterialIds.length,
    });

    try {
      const result = await runAgent({
        store,
        book,
        ai: aiForBook(ai, book),
        instruction: finalInstruction,
        mode,
        action,
        selection,
        plotItems,
        materialIds,
        ignoredMaterialIds,
        model,
        maxTokens: settings.maxTokens,
        maxSteps: settings.maxSteps,
        reasoningEffort: settings.reasoningEffort,
        researchModel: settings.researchModel,
        signal: controller.signal,
        onEvent: (event) => send(event.type, event),
      });

      debugLog.log('ai.run.done', {
        runId,
        ms: Date.now() - runStartedAt,
        written: Boolean(result.written),
        proposalId: result.proposal?.id || null,
        chapterTitle: result.chapterTitle || '',
        finalChars: String(result.finalText || '').length,
      });

      send('done', {
        ok: true,
        written: result.written,
        proposalId: result.proposal?.id || null,
        chapterTitle: result.chapterTitle,
        message: action === 'chat' && !result.proposal && !result.written
          ? String(result.finalText || '').slice(0, 4000)
          : '',
      });
    } catch (err) {
      if (controller.signal.aborted) {
        debugLog.log('ai.run.abort', { runId, ms: Date.now() - runStartedAt });
        return;
      }
      debugLog.log('ai.run.error', {
        runId,
        ms: Date.now() - runStartedAt,
        message: err.message || 'AI 运行失败',
        stack: String(err.stack || '').slice(0, 8000),
      }, 'error');
      const timedOut = err?.name === 'TimeoutError'
        || /aborted due to timeout/i.test(String(err?.message || ''));
      const message = timedOut && !err.code
        ? `模型 ${model || '未知'} 在超时时间内没有返回数据`
        : (err.message || 'AI 运行失败');
      send('error', {
        message,
        detail: err.stack ? String(err.stack).split('\n')[0] : undefined,
        code: err.code || (timedOut ? 'AI_TIMEOUT' : undefined),
        retryable: Boolean(err.retryable || timedOut),
        runId,
        model,
        elapsedMs: Date.now() - runStartedAt,
      });
    } finally {
      res.off('close', onClose);
      if (!res.writableEnded) res.end();
    }
  });

  app.get('/api/books/:id/chapters', async (req, res, next) => {
    try {
      const book = await store.getBook(req.params.id);
      if (!book) return res.status(404).json({ error: '书籍不存在' });

      const { chapters } = parseChapters(book.manuscript, book.meta.title);
      const byIndex = new Map();
      for (const item of book.summaries) {
        if (Number.isInteger(item.index)) byIndex.set(item.index, item);
      }

      const list = chapters.map((chapter) => {
        const summary = byIndex.get(chapter.index);
        return {
          index: chapter.index,
          title: chapter.title,
          chars: chapter.chars,
          hasSummary: Boolean(summary),
          summary: summary?.summary || '',
          tags: summary?.tags || {},
          at: summary?.at || '',
          source: summary?.source || '',
          stale: Boolean(summary?.stale),
        };
      });

      const orphans = book.summaries
        .filter((item) => item.index === null)
        .map((item) => publicSummary(item));

      return res.json({ chapters: list, orphans, updatedAt: book.meta.updatedAt });
    } catch (err) {
      return next(err);
    }
  });

  app.get('/api/books/:id/summaries', async (req, res, next) => {
    try {
      const book = await store.getBook(req.params.id);
      if (!book) return res.status(404).json({ error: '书籍不存在' });
      return res.json({
        version: 2,
        chapters: book.summaries.map(publicSummary),
      });
    } catch (err) {
      return next(err);
    }
  });

  app.get('/api/books/:id/materials', async (req, res, next) => {
    try {
      const book = await store.getBook(req.params.id);
      if (!book) return res.status(404).json({ error: '书籍不存在' });
      return res.json({ materials: book.materials });
    } catch (err) {
      return next(err);
    }
  });

  app.post('/api/books/:id/materials', async (req, res, next) => {
    try {
      const input = req.body?.material && typeof req.body.material === 'object'
        ? req.body.material
        : (req.body || {});
      const material = await store.createMaterial(req.params.id, input);
      return res.status(201).json({ material });
    } catch (err) {
      return next(err);
    }
  });

  const analyzeMaterialHandler = async (req, res, next) => {
    let controller = null;
    try {
      const book = await store.getBook(req.params.id);
      if (!book) return res.status(404).json({ error: '书籍不存在' });
      if (!book.meta.aiEnabled) return res.status(400).json({ error: '这本书没有开启 AI' });

      const title = String(req.body?.title || '').trim();
      if (!title) return res.status(400).json({ error: '标题不能为空' });
      const summary = String(req.body?.summary || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      const content = String(req.body?.content || '').replace(/\r\n?/g, '\n').slice(0, 12000);

      const settings = normalizeAgentSettings(book.meta);
      controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const onClose = () => controller.abort();
      res.on('close', onClose);
      try {
        const analysis = await analyzeMaterial({
          ai: aiForBook(ai, book),
          model: settings.researchModel,
          title,
          summary,
          content,
          signal: controller.signal,
        });
        debugLog.log('materials.analyze', {
          bookId: book.meta.id,
          model: settings.researchModel,
          summaryChars: analysis.summary.length,
          triggers: analysis.triggers.length,
        });
        return res.json({
          summary: analysis.summary,
          triggers: analysis.triggers,
          model: settings.researchModel,
        });
      } finally {
        clearTimeout(timeout);
        res.off('close', onClose);
      }
    } catch (err) {
      if (controller?.signal.aborted && !res.writableEnded) {
        return res.status(504).json({ error: '资料整理子代理超时或已取消' });
      }
      return next(err);
    }
  };

  app.post('/api/books/:id/materials/analyze', analyzeMaterialHandler);
  app.post('/api/books/:id/materials/suggest-triggers', analyzeMaterialHandler);

  app.put('/api/books/:id/materials/:mid', async (req, res, next) => {
    try {
      const input = req.body?.material && typeof req.body.material === 'object'
        ? req.body.material
        : (req.body || {});
      const material = await store.updateMaterial(req.params.id, req.params.mid, input);
      return res.json({ material });
    } catch (err) {
      return next(err);
    }
  });

  app.delete('/api/books/:id/materials/:mid', async (req, res, next) => {
    try {
      const result = await store.deleteMaterial(req.params.id, req.params.mid);
      return res.json(result);
    } catch (err) {
      return next(err);
    }
  });

  app.delete('/api/books/:id/summaries/orphans', async (req, res, next) => {
    try {
      const body = req.body || {};
      const all = body.all === true;
      const match = all
        ? null
        : {
          title: String(body.title || ''),
          at: String(body.at || ''),
          sourceHash: String(body.sourceHash || ''),
        };
      if (!all && !match.title && !match.at && !match.sourceHash) {
        return res.status(400).json({ error: '缺少要删除的摘要标识' });
      }
      const result = await store.deleteOrphanSummaries(req.params.id, match);
      return res.json({
        deleted: result.deleted,
        orphans: result.orphans.map(publicSummary),
      });
    } catch (err) {
      return next(err);
    }
  });

  app.put('/api/books/:id/summaries/:index', async (req, res, next) => {
    try {
      const index = Number(req.params.index);
      if (!Number.isInteger(index) || index < 1) {
        return res.status(400).json({ error: '章节号必须是正整数' });
      }

      const book = await store.getBook(req.params.id);
      if (!book) return res.status(404).json({ error: '书籍不存在' });

      const expected = req.body?.expectedUpdatedAt;
      if (expected !== undefined && String(expected) !== String(book.meta.updatedAt)) {
        return res.status(409).json({ error: '正文或摘要已经变过，请刷新后再改' });
      }

      const { chapters } = parseChapters(book.manuscript, book.meta.title);
      const chapter = chapters.find((item) => item.index === index);
      if (!chapter) return res.status(404).json({ error: '章节不存在' });

      const summary = String(req.body?.summary ?? '').trim();
      if (!summary) return res.status(400).json({ error: 'summary 不能为空' });
      if (summary.length > 4000) return res.status(400).json({ error: 'summary 太长' });

      const existing = book.summaries.find((item) => item.index === index);
      const tags = req.body?.tags && typeof req.body.tags === 'object'
        ? req.body.tags
        : (existing?.tags || {});

      const entry = {
        index,
        title: chapter.title,
        summary,
        tags,
        source: 'user',
        sourceHash: existing?.sourceHash || '',
        at: new Date().toISOString(),
      };

      await store.upsertSummary(req.params.id, entry);
      return res.json({ summary: entry });
    } catch (err) {
      return next(err);
    }
  });

  app.post('/api/books/:id/summaries/generate', async (req, res, next) => {
    try {
      const index = Number(req.body?.index);
      if (!Number.isInteger(index) || index < 1) {
        return res.status(400).json({ error: '章节号必须是正整数' });
      }

      const book = await store.getBook(req.params.id);
      if (!book) return res.status(404).json({ error: '书籍不存在' });

      const { chapters } = parseChapters(book.manuscript, book.meta.title);
      const chapter = chapters.find((item) => item.index === index);
      if (!chapter) return res.status(404).json({ error: '章节不存在' });

      const body = book.manuscript.slice(chapter.bodyStart, chapter.end).replace(/\s+$/, '');
      if (!body.trim()) return res.status(400).json({ error: '这一章还没有正文' });

      let generated = null;
      try {
        generated = await summarizeChapter({
          ai: aiForBook(ai, book),
          title: chapter.title,
          body,
          terms: book.meta?.terms || [],
        });
      } catch (err) {
        return res.status(502).json({ error: err.message || '摘要生成失败' });
      }
      if (!generated) return res.status(502).json({ error: '模型没有返回摘要' });

      const entry = {
        index,
        title: chapter.title,
        summary: generated.summary,
        tags: generated.tags,
        source: 'ai',
        sourceHash: generated.sourceHash,
        at: new Date().toISOString(),
      };

      await store.upsertSummary(req.params.id, entry);
      return res.json({
        summary: entry,
        degraded: Boolean(generated.degraded),
        chunks: generated.chunks || 1,
        mapFailures: generated.mapFailures || 0,
      });
    } catch (err) {
      return next(err);
    }
  });

  app.post('/api/books/:id/terms/preview', async (req, res, next) => {
    try {
      const result = await store.cleanTerms(req.params.id, { ...(req.body || {}), dryRun: true });
      return res.json(result);
    } catch (err) {
      return next(err);
    }
  });

  app.post('/api/books/:id/terms/apply', async (req, res, next) => {
    try {
      const result = await store.cleanTerms(req.params.id, req.body || {});
      return res.json(result);
    } catch (err) {
      return next(err);
    }
  });

  app.post('/api/books/:id/audit', async (req, res, next) => {
    try {
      const query = String(req.body?.query || '').trim();
      if (!query) return res.status(400).json({ error: 'query 不能为空' });
      if (query.length > 2000) return res.status(400).json({ error: 'query 太长' });

      const chapters = Array.isArray(req.body?.chapters)
        ? [...new Set(
          req.body.chapters
            .map((index) => Number(index))
            .filter((index) => Number.isInteger(index) && index > 0),
        )].sort((a, b) => a - b)
        : [];
      if (chapters.length > 1000) return res.status(400).json({ error: '章节选择太多' });

      const book = await store.getBook(req.params.id);
      if (!book) return res.status(404).json({ error: '书籍不存在' });
      if (!book.manuscript.trim()) return res.status(400).json({ error: '正文还是空的' });

      const settings = normalizeAgentSettings(book.meta);
      const state = {
        manuscript: book.manuscript,
        outline: book.outline,
        notes: book.notes,
        summaries: book.summaries.map((item) => ({ ...item })),
        chapters: [],
        chaptersDirty: true,
      };

      const controller = new AbortController();
      const onClose = () => controller.abort();
      res.on('close', onClose);

      try {
        let result;
        try {
          result = await runAudit({
            ai: aiForBook(ai, book),
            model: settings.researchModel,
            book,
            state,
            question: query,
            chapters,
            signal: controller.signal,
          });
        } catch (err) {
          if (controller.signal.aborted) return;
          throw err;
        }
        if (controller.signal.aborted) return;
        if (result.error) {
          return res.status(502).json({
            error: result.error,
            issues: result.issues || [],
            warnings: result.warnings || [],
            chunks: result.chunks,
            scanned: result.scanned,
            failedChunks: result.failedChunks,
            timedOut: result.timedOut,
            chapters: result.chapters || chapters,
          });
        }
        return res.json({
          query,
          issues: result.issues,
          warnings: result.warnings,
          chunks: result.chunks,
          scanned: result.scanned,
          failedChunks: result.failedChunks,
          timedOut: result.timedOut,
          chapters: result.chapters || chapters,
        });
      } finally {
        res.off('close', onClose);
      }
    } catch (err) {
      return next(err);
    }
  });

  app.get('/api/books/:id/proposals', async (req, res, next) => {
    try {
      const status = req.query.status ? String(req.query.status) : undefined;
      if (status && !['pending', 'accepted', 'rejected'].includes(status)) {
        return res.status(400).json({ error: 'status 无效' });
      }
      return res.json({ proposals: await listProposals(store, req.params.id, { status }) });
    } catch (err) {
      return next(err);
    }
  });

  app.get('/api/books/:id/proposals/:pid', async (req, res, next) => {
    try {
      const proposal = await getProposal(store, req.params.id, req.params.pid);
      if (!proposal) return res.status(404).json({ error: '提案不存在' });
      return res.json({ proposal });
    } catch (err) {
      return next(err);
    }
  });

  app.post('/api/books/:id/proposals/:pid/accept', async (req, res, next) => {
    try {
      const proposal = await getProposal(store, req.params.id, req.params.pid);
      if (!proposal) return res.status(404).json({ error: '提案不存在' });
      if (proposal.status !== 'pending') return res.status(409).json({ error: '提案已处理' });

      const edits = Array.isArray(req.body?.edits) ? req.body.edits : null;
      const ops = edits ? applyDecisions(proposal.ops, edits) : proposal.ops;
      const result = await applyOps(store, req.params.id, ops);
      const updated = await setProposalStatus(store, req.params.id, proposal.id, 'accepted');
      const fresh = await store.getBook(req.params.id);
      const appended = appendedChapterInfo(fresh, ops);

      return res.json({
        applied: true,
        ...result,
        proposal: updated,
        appended,
      });
    } catch (err) {
      return next(err);
    }
  });

  app.post('/api/books/:id/proposals/:pid/reject', async (req, res, next) => {
    try {
      const proposal = await getProposal(store, req.params.id, req.params.pid);
      if (!proposal) return res.status(404).json({ error: '提案不存在' });
      if (proposal.status !== 'pending') return res.status(409).json({ error: '提案已处理' });

      const updated = await setProposalStatus(store, req.params.id, proposal.id, 'rejected');
      return res.json({ proposal: updated });
    } catch (err) {
      return next(err);
    }
  });

  app.post('/api/books', async (req, res, next) => {
    try {
      const { title = '', content = '', usage = 'continue' } = req.body || {};
      if (typeof content !== 'string') {
        return res.status(400).json({ error: 'content 必须是字符串' });
      }
      const book = await store.createBook({ title, content, usage });
      return res.status(201).json({ book });
    } catch (err) {
      return next(err);
    }
  });

  app.get('/api/books/:id', async (req, res, next) => {
    try {
      const book = await store.getBook(req.params.id);
      if (!book) return res.status(404).json({ error: '书籍不存在' });
      return res.json({ book });
    } catch (err) {
      return next(err);
    }
  });

  app.put('/api/books/:id/meta', async (req, res, next) => {
    try {
      const meta = await store.updateMeta(req.params.id, req.body || {});
      return res.json({ meta });
    } catch (err) {
      return next(err);
    }
  });

  app.put('/api/books/:id/:section', async (req, res, next) => {
    try {
      const { section } = req.params;
      if (!['outline', 'notes', 'manuscript'].includes(section)) {
        return res.status(400).json({ error: '分区只能是 outline / notes / manuscript' });
      }
      const { content } = req.body || {};
      if (typeof content !== 'string') {
        return res.status(400).json({ error: 'content 必须是字符串' });
      }
      const result = await store.updateSection(req.params.id, section, content);
      return res.json(result);
    } catch (err) {
      return next(err);
    }
  });

  app.delete('/api/books/:id', async (req, res, next) => {
    try {
      const result = await store.deleteBook(req.params.id);
      return res.json(result);
    } catch (err) {
      return next(err);
    }
  });

  app.get('/api/books/:id/history', async (req, res, next) => {
    try {
      return res.json({ history: await store.listHistory(req.params.id) });
    } catch (err) {
      return next(err);
    }
  });

  app.get('/api/books/:id/history/:file', async (req, res, next) => {
    try {
      const result = await store.readHistory(req.params.id, req.params.file);
      return res.json(result);
    } catch (err) {
      return next(err);
    }
  });

  app.post('/api/books/:id/history/:file/restore', async (req, res, next) => {
    try {
      const result = await store.restoreHistory(req.params.id, req.params.file);
      return res.json(result);
    } catch (err) {
      return next(err);
    }
  });

  const katexDir = path.join(__dirname, 'node_modules', 'katex', 'dist');
  app.use('/vendor/katex', express.static(katexDir));

  const publicDir = path.join(__dirname, 'public');
  app.use(express.static(publicDir));

  app.get('/', (req, res) => {
    res.type('text/plain').send('NOVELIN API is running. UI not built yet.');
  });

  app.use('/api', (req, res) => {
    res.status(404).json({ error: '接口不存在' });
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || err.statusCode || 500;
    if (status >= 500) {
      console.error(err);
      debugLog.log('server.error', {
        method: req.method,
        path: req.originalUrl,
        status,
        message: err.message || '服务器内部错误',
        stack: String(err.stack || '').slice(0, 8000),
      }, 'error');
    }
    return res.status(status).json({
      error: status >= 500 ? '服务器内部错误' : (err.message || '请求错误'),
    });
  });

  return { app, store, debugLog };
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 4173);
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  const { app, debugLog } = createApp({ dataDir });

  app.listen(port, host, () => {
    console.log(`NOVELIN ${VERSION}`);
    console.log(`API  http://${host}:${port}/api/health`);
    console.log(`DATA ${dataDir}`);
    debugLog.log('server.start', { host, port, dataDir, version: VERSION });
  });
}
