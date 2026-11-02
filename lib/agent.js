import { applyOps, createProposal, replaceUnique } from './proposals.js';

const DEFAULT_MODEL = 'opencode-go/deepseek-v4.1-flash';
const MAX_STEPS = 10;
const MAX_READ = 4000;
const CONTEXT_OUTLINE = 6000;
const CONTEXT_NOTES = 8000;
const RECENT_TAIL = 1500;
const SUMMARY_BODY = 12000;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_manuscript',
      description: '按字符区间读取正文。offset 从 0 开始，一次最多 4000 字符。不要一次读整本。',
      parameters: {
        type: 'object',
        properties: {
          offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: MAX_READ },
        },
        required: ['offset', 'limit'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_manuscript',
      description: '在正文里搜索关键词，返回命中的字符位置和前后文片段。适合定位人物、地点或伏笔。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要搜索的词或句子' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_outline',
      description: '读取完整大纲。大纲通常不长，可以直接读。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_notes',
      description: '读取人物、设定和文风笔记。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_manuscript',
      description: '精确替换正文中的一段。old_string 必须在正文里唯一出现；先用 search_manuscript 或 read_manuscript 确认。不要用这个工具重写整章。',
      parameters: {
        type: 'object',
        properties: {
          old_string: { type: 'string', description: '要被替换的原文，尽量短且唯一' },
          new_string: { type: 'string', description: '替换后的文字' },
        },
        required: ['old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_outline',
      description: '精确替换大纲中的一段。old_string 必须唯一。只有用户明确要求改大纲时才用。',
      parameters: {
        type: 'object',
        properties: {
          old_string: { type: 'string' },
          new_string: { type: 'string' },
        },
        required: ['old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: '结束本次运行，并用一句话说明做了什么。正文已经写完或修改完时调用。',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string' },
        },
        required: ['message'],
      },
    },
  },
];

function agentError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  return err;
}

function clampInt(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function countWords(text) {
  return Array.from(String(text || '').replace(/[\s　]/g, '')).length;
}

function truncate(text, max) {
  const src = String(text || '');
  if (src.length <= max) return src;
  return `${src.slice(0, max)}\n…（已截断，需要更多内容用工具读取）`;
}

function systemPrompt(action) {
  const base = `你是 NOVELIN 的小说写作代理。人负责主题、情节走向和大纲；你负责写正文和做精确修改。

工作规则：
- 你看不到整本正文。需要细节时，用 read_manuscript 按区间读取，或用 search_manuscript 搜索。不要要求一次性读取全文。
- 改写已有正文时调用 edit_manuscript。old_string 必须唯一，尽量短。不要重写整章。
- 写新章时不要调用 edit_manuscript、edit_outline 或 finish；新章直接写在最终回复里。
- 修改大纲必须调用 edit_outline，同样要求 old_string 唯一。
- 不要输出解释、前言、Markdown 代码块或“好的”之类的客套。`;

  if (action === 'chapter') {
    return `${base}
- 写新章时只允许用 read/search/read_outline/read_notes 查资料。不要调用 edit_manuscript、edit_outline 或 finish。
- 最终回复必须直接是整章的 Markdown：第一行用二级标题，例如：## 第八章 潮汐线以下。正文承接上一章末尾，遵守大纲和人物设定。不要输出解释。`;
  }
  if (action === 'revise') {
    return `${base}
- 用户会给你选中的正文。先确认它在正文里的位置，再用 edit_manuscript 精确替换。改写幅度以用户指令为准，不要顺手改别处。`;
  }
  return `${base}
- 按用户指令处理。需要改正文或大纲时用工具；不需要改就正常回答。`;
}

function userPrompt(book, state, instruction, selection) {
  const theme = String(book.meta?.theme || '').trim() || '（未设置）';
  const outline = truncate(state.outline, CONTEXT_OUTLINE) || '（空）';
  const notes = truncate(state.notes, CONTEXT_NOTES) || '（空）';
  const summaries = state.summaries
    .slice(-20)
    .map((item) => `- ${item.chapter}：${truncate(item.summary, 300)}`)
    .join('\n') || '（暂无）';
  const tail = state.manuscript.slice(-RECENT_TAIL) || '（正文为空）';

  const parts = [
    `【主题】\n${theme}`,
    `【大纲】\n${outline}`,
    `【设定与人物】\n${notes}`,
    `【前情摘要】\n${summaries}`,
    `【正文规模】约 ${countWords(state.manuscript)} 字，${book.stats?.chapters || 0} 章，共 ${state.manuscript.length} 字符。`,
    `【上一章末尾】\n${tail}`,
  ];

  if (selection?.text) {
    const range = Number.isInteger(selection.start) && Number.isInteger(selection.end)
      ? `位置 ${selection.start}-${selection.end}，`
      : '';
    parts.push(`【选中文本】\n${range}${selection.text}`);
  }

  parts.push(`【指令】\n${instruction}`);
  return parts.join('\n\n');
}

function searchInText(text, query, limit = 8) {
  const haystack = String(text || '').toLowerCase();
  const needle = String(query || '').toLowerCase();
  const hits = [];
  let from = 0;

  while (hits.length < limit) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    const start = Math.max(0, at - 60);
    const end = Math.min(text.length, at + needle.length + 60);
    hits.push({
      at,
      snippet: text.slice(start, end).replace(/\s+/g, ' ').trim(),
    });
    from = at + Math.max(1, needle.length);
  }

  return hits;
}

function executeTool(name, args, state, ctx) {
  switch (name) {
    case 'read_manuscript': {
      const total = state.manuscript.length;
      const offset = clampInt(args.offset, 0, total);
      const limit = clampInt(args.limit, 1, MAX_READ);
      return {
        total,
        offset,
        limit,
        text: state.manuscript.slice(offset, offset + limit),
      };
    }
    case 'search_manuscript': {
      const query = String(args.query || '').trim();
      if (!query) return { error: 'query 不能为空' };
      return { hits: searchInText(state.manuscript, query) };
    }
    case 'read_outline':
      return { outline: state.outline };
    case 'read_notes':
      return { notes: truncate(state.notes, 12000) };
    case 'edit_manuscript': {
      const next = replaceUnique(state.manuscript, args.old_string, args.new_string, '正文');
      state.manuscript = next;
      ctx.ops.push({
        type: 'edit_manuscript',
        old_string: args.old_string,
        new_string: args.new_string,
      });
      return { ok: true, words: countWords(next) };
    }
    case 'edit_outline': {
      const next = replaceUnique(state.outline, args.old_string, args.new_string, '大纲');
      state.outline = next;
      ctx.ops.push({
        type: 'edit_outline',
        old_string: args.old_string,
        new_string: args.new_string,
      });
      return { ok: true };
    }
    case 'finish': {
      ctx.finished = true;
      ctx.finishMessage = String(args.message || '');
      return { ok: true };
    }
    default:
      return { error: `未知工具：${name}` };
  }
}

function compactToolResult(result) {
  if (!result || typeof result !== 'object') return result;
  if (typeof result.text === 'string') {
    return { ...result, text: `[${result.text.length} 字符]` };
  }
  if (Array.isArray(result.hits)) {
    return { ...result, hits: result.hits.length };
  }
  if (typeof result.outline === 'string') {
    return { outline: `[${result.outline.length} 字符]` };
  }
  if (typeof result.notes === 'string') {
    return { notes: `[${result.notes.length} 字符]` };
  }
  return result;
}

function splitChapter(text) {
  const match = text.match(/^\s*(?:#{1,6}\s+(.+?)|(第[一二三四五六七八九十百零\d]+章[^\n]*))\s*\n+/);
  if (match) {
    return {
      title: String(match[1] || match[2] || '').trim(),
      body: text.slice(match[0].length),
    };
  }
  return { title: '', body: text };
}

function upsertSummary(summaries, chapter, summary) {
  const entry = { chapter, summary, at: new Date().toISOString() };
  const index = summaries.findIndex((item) => item && item.chapter === chapter);
  if (index >= 0) summaries[index] = entry;
  else summaries.push(entry);
  return summaries;
}

async function summarizeChapter({ ai, model, title, body, signal }) {
  const fallback = String(body || '').replace(/\s+/g, ' ').slice(0, 180);
  if (!ai?.complete) return fallback;

  const timeout = AbortSignal.timeout(30000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  try {
    const { content } = await ai.complete({
      model,
      messages: [
        {
          role: 'system',
          content: '你是小说编辑。只输出一段 100 到 200 字的中文摘要，概括这一章发生了什么，保留人物、地点和关键转折。不要评价，不要标题。',
        },
        {
          role: 'user',
          content: `标题：${title}\n\n${String(body || '').slice(0, SUMMARY_BODY)}`,
        },
      ],
      temperature: 0.2,
      maxTokens: 400,
      signal: combined,
    });
    const text = String(content || '').trim();
    return text || fallback;
  } catch (err) {
    if (signal?.aborted) throw err;
    return fallback;
  }
}

export async function runAgent({
  store,
  book,
  ai,
  instruction,
  mode = 'diff',
  action = 'chapter',
  selection = null,
  model,
  signal,
  onEvent = () => {},
}) {
  if (!store || !book || !ai) throw agentError(500, 'runAgent 参数不完整');
  if (!['auto', 'diff'].includes(mode)) throw agentError(400, 'mode 只能是 auto 或 diff');
  if (!['chapter', 'revise', 'chat'].includes(action)) {
    throw agentError(400, 'action 只能是 chapter / revise / chat');
  }

  const chosenModel = String(model || book.meta?.model || DEFAULT_MODEL);
  const state = {
    manuscript: book.manuscript || '',
    outline: book.outline || '',
    notes: book.notes || '',
    summaries: Array.isArray(book.summaries) ? [...book.summaries] : [],
  };
  const ctx = { ops: [], finished: false, finishMessage: '' };
  const messages = [
    { role: 'system', content: systemPrompt(action) },
    { role: 'user', content: userPrompt(book, state, instruction, selection) },
  ];

  let lastAssistantText = '';
  let finalText = '';
  let loopExhausted = false;

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const turn = { text: '', calls: new Map() };

    for await (const event of ai.streamChat({
      model: chosenModel,
      messages,
      tools: TOOLS,
      temperature: 0.85,
      maxTokens: 8192,
      signal,
    })) {
      if (event.type === 'content') {
        turn.text += event.text;
        onEvent({ type: 'delta', text: event.text });
      } else if (event.type === 'tool_call') {
        const index = event.index ?? 0;
        let call = turn.calls.get(index);
        if (!call) {
          call = { index, id: '', name: '', arguments: '' };
          turn.calls.set(index, call);
        }
        if (event.id) call.id = event.id;
        if (event.name) call.name = event.name;
        if (event.argumentsDelta) call.arguments += event.argumentsDelta;
      }
    }

    if (turn.text) lastAssistantText = turn.text;

    if (turn.calls.size === 0) {
      finalText = turn.text;
      break;
    }

    const calls = [...turn.calls.values()]
      .sort((a, b) => a.index - b.index)
      .map((call) => ({
        id: call.id || `call_${step}_${call.index}`,
        type: 'function',
        function: { name: call.name, arguments: call.arguments || '{}' },
      }));

    messages.push({ role: 'assistant', content: turn.text || null, tool_calls: calls });

    for (const call of calls) {
      const name = call.function.name;
      let args = {};
      let parseError = null;

      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        parseError = '工具参数不是合法 JSON';
      }

      onEvent({
        type: 'tool',
        phase: 'start',
        name,
        id: call.id,
        args: parseError ? null : args,
      });

      let result;
      if (parseError) {
        result = { error: parseError };
      } else {
        try {
          result = executeTool(name, args, state, ctx);
        } catch (err) {
          result = { error: err.message };
        }
      }

      if (result?.error) {
        onEvent({ type: 'tool', phase: 'error', name, id: call.id, message: result.error });
      } else {
        onEvent({
          type: 'tool',
          phase: 'end',
          name,
          id: call.id,
          result: compactToolResult(result),
        });
      }

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }

    if (ctx.finished) break;
    if (step === MAX_STEPS - 1) loopExhausted = true;
  }

  if (loopExhausted) throw agentError(502, '工具调用次数过多，已停止');

  const ops = [...ctx.ops];
  const final = String(finalText || lastAssistantText || '').trim();
  let chapterTitle = '';
  let chapterBody = '';
  let summary = '';
  let proposal = null;
  let written = false;

  if (action === 'chapter') {
    if (!final) throw agentError(502, '模型没有返回章节正文');

    const split = splitChapter(final);
    chapterTitle = split.title || `第 ${(book.stats?.chapters || 0) + 1} 章`;
    chapterBody = split.body.trim();
    if (!chapterBody) throw agentError(502, '模型返回的章节为空');

    ops.push({ type: 'append_chapter', title: chapterTitle, content: chapterBody });

    if (mode === 'auto') {
      const applied = await applyOps(store, book.meta.id, ops);
      written = true;
      onEvent({ type: 'written', ...applied });

      summary = await summarizeChapter({
        ai,
        model: chosenModel,
        title: chapterTitle,
        body: chapterBody,
        signal,
      });
      try {
        await store.updateSummaries(
          book.meta.id,
          upsertSummary([...state.summaries], chapterTitle, summary),
        );
      } catch (err) {
        onEvent({ type: 'warning', message: `章节已写入，但摘要保存失败：${err.message}` });
      }
    } else {
      summary = await summarizeChapter({
        ai,
        model: chosenModel,
        title: chapterTitle,
        body: chapterBody,
        signal,
      });
      ops.push({ type: 'save_summary', chapter: chapterTitle, summary });
      proposal = await createProposal(store, book.meta.id, {
        mode,
        action,
        instruction,
        model: chosenModel,
        ops,
        summary: ctx.finishMessage,
      });
      onEvent({ type: 'proposal', proposal });
    }
  } else if (mode === 'auto') {
    if (ops.length) {
      const applied = await applyOps(store, book.meta.id, ops);
      written = true;
      onEvent({ type: 'written', ...applied });
    }
  } else if (ops.length) {
    proposal = await createProposal(store, book.meta.id, {
      mode,
      action,
      instruction,
      model: chosenModel,
      ops,
      summary: ctx.finishMessage,
    });
    onEvent({ type: 'proposal', proposal });
  }

  return {
    finalText: action === 'chapter' ? chapterBody : final,
    chapterTitle: chapterTitle || null,
    ops,
    summary,
    written,
    proposal,
    finishMessage: ctx.finishMessage,
  };
}

export { TOOLS, splitChapter };
