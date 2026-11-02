import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './lib/store.js';
import { searchBooks } from './lib/search.js';
import { createAiClient } from './lib/ai.js';
import { runAgent } from './lib/agent.js';
import { applyOps, listProposals, getProposal, setProposalStatus } from './lib/proposals.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '0.1.0';

export function createApp({ dataDir, aiClient } = {}) {
  const store = createStore(dataDir || process.env.DATA_DIR || path.join(__dirname, 'data'));
  const ai = aiClient || createAiClient();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32mb' }));

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, name: 'novelin', version: VERSION });
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
    if (!['chapter', 'revise', 'chat'].includes(action)) {
      return res.status(400).json({ error: 'action 只能是 chapter / revise / chat' });
    }
    if (instruction.length > 8000) {
      return res.status(400).json({ error: 'instruction 太长' });
    }
    if (!instruction && action !== 'chapter') {
      return res.status(400).json({ error: 'instruction 不能为空' });
    }
    if (selection !== null) {
      if (
        typeof selection !== 'object'
        || typeof selection.text !== 'string'
        || selection.text.length > 8000
      ) {
        return res.status(400).json({ error: 'selection.text 必须是字符串，且不超过 8000 字' });
      }
    }

    const finalInstruction = instruction || '写下一章，承接前文。';

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

    send('meta', { bookId: book.meta.id, mode, action, model });

    try {
      const result = await runAgent({
        store,
        book,
        ai,
        instruction: finalInstruction,
        mode,
        action,
        selection,
        model,
        signal: controller.signal,
        onEvent: (event) => send(event.type, event),
      });

      send('done', {
        ok: true,
        written: result.written,
        proposalId: result.proposal?.id || null,
        chapterTitle: result.chapterTitle,
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      send('error', {
        message: err.message || 'AI 运行失败',
        detail: err.stack ? String(err.stack).split('\n')[0] : undefined,
      });
    } finally {
      res.off('close', onClose);
      if (!res.writableEnded) res.end();
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

      const result = await applyOps(store, req.params.id, proposal.ops);
      const updated = await setProposalStatus(store, req.params.id, proposal.id, 'accepted');
      return res.json({ applied: true, ...result, proposal: updated });
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
    if (status >= 500) console.error(err);
    return res.status(status).json({
      error: status >= 500 ? '服务器内部错误' : (err.message || '请求错误'),
    });
  });

  return { app, store };
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 4173);
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  const { app } = createApp({ dataDir });

  app.listen(port, host, () => {
    console.log(`NOVELIN ${VERSION}`);
    console.log(`API  http://${host}:${port}/api/health`);
    console.log(`DATA ${dataDir}`);
  });
}
