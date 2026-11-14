const DEFAULT_BASE_URL = 'http://127.0.0.1:3425/v1';
const DEFAULT_API_KEY = 'magpie';
const DEFAULT_TIMEOUT_MS = 180000;
const REASONING_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export function sessionIdForBook(bookId) {
  const id = String(bookId || '').trim();
  return id ? `novelin-${id}` : '';
}

export function subagentSessionIdForBook(bookId) {
  const id = String(bookId || '').trim();
  return id ? `novelin-${id}-sub` : '';
}

export function summarySessionIdForBook(bookId) {
  const id = String(bookId || '').trim();
  return id ? `novelin-${id}-summary` : '';
}

function normalizeReasoningLevels(value) {
  if (!value) return [];

  let levels = [];
  if (Array.isArray(value)) {
    levels = value.map((item) => {
      if (typeof item === 'string') return item;
      return item?.effort || item?.value || item?.id || item?.name || item?.level || '';
    });
  } else if (typeof value === 'object') {
    levels = Object.keys(value);
  }

  return [...new Set(levels.map((item) => String(item).trim().toLowerCase()).filter(Boolean))]
    .sort((a, b) => {
      const ai = REASONING_ORDER.indexOf(a);
      const bi = REASONING_ORDER.indexOf(b);
      if (ai >= 0 || bi >= 0) {
        if (ai < 0) return 1;
        if (bi < 0) return -1;
        return ai - bi;
      }
      return a.localeCompare(b);
    });
}

export class AiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'AiError';
    this.status = status;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createAiClient({
  baseUrl = process.env.MAGPIE_BASE_URL || DEFAULT_BASE_URL,
  apiKey = process.env.MAGPIE_API_KEY || DEFAULT_API_KEY,
  timeoutMs = Number(process.env.MAGPIE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  retryDelayMs = 800,
  fetchImpl = globalThis.fetch,
  debugLog = null,
} = {}) {
  const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;

  function record(evt, data = {}, level = 'info') {
    if (!debugLog) return;
    try {
      debugLog(evt, data, level);
    } catch {
      // 调试日志不能影响正常请求。
    }
  }

  async function request(body, { signal, sessionId = '' } = {}) {
    const startedAt = Date.now();
    const session = String(sessionId || '').trim();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            ...(session ? { 'x-opencode-session': session } : {}),
          },
          body: JSON.stringify(body),
          signal: combined,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        if (timeoutSignal.aborted || err?.name === 'TimeoutError') {
          const timeoutError = new AiError(
            `模型 ${body.model || '未知'} 在 ${Math.round(timeoutMs / 1000)} 秒内没有返回响应`,
            504,
          );
          timeoutError.code = 'AI_TIMEOUT';
          timeoutError.retryable = true;
          timeoutError.model = body.model || '';
          timeoutError.elapsedMs = Date.now() - startedAt;
          throw timeoutError;
        }
        if (attempt === 0) {
          await sleep(retryDelayMs);
          continue;
        }
        throw new AiError(`连接 magpie 失败：${err.message}`, 502);
      }

      if (response.ok) return response;

      const text = await response.text().catch(() => '');
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt === 0) {
        await sleep(retryDelayMs);
        continue;
      }
      throw new AiError(
        `magpie 返回 ${response.status}${text ? `：${text.slice(0, 300)}` : ''}`,
        response.status,
      );
    }

    throw new AiError('magpie 请求失败', 502);
  }

  /**
   * 流式请求。产出：
   *   {type:'content', text}
   *   {type:'tool_call', index, id, name, argumentsDelta}
   *   {type:'finish', reason}
   *   {type:'usage', usage}
   */
  async function* streamChatRaw({
    model,
    messages,
    tools,
    toolChoice = 'auto',
    temperature = 0.8,
    maxTokens = 8192,
    reasoningEffort = '',
    sessionId = '',
    signal,
  } = {}) {
    const body = {
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: true,
    };
    if (reasoningEffort) body.reasoning_effort = reasoningEffort;
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = toolChoice;
    }

    const response = await request(body, { signal, sessionId });
    const contentType = response.headers.get('content-type') || '';

    if (!contentType.includes('text/event-stream')) {
      const data = await response.json().catch(() => null);
      if (!data) throw new AiError('magpie 返回了无法解析的响应', 502);
      if (data.error) {
        throw new AiError(data.error.message || String(data.error), 502);
      }
      const choice = data.choices?.[0];
      if (choice?.message?.content) {
        yield { type: 'content', text: choice.message.content };
      }
      if (Array.isArray(choice?.message?.tool_calls)) {
        for (let index = 0; index < choice.message.tool_calls.length; index += 1) {
          const call = choice.message.tool_calls[index];
          yield {
            type: 'tool_call',
            index,
            id: call.id,
            name: call.function?.name,
            argumentsDelta: call.function?.arguments || '',
          };
        }
      }
      if (choice?.finish_reason) yield { type: 'finish', reason: choice.finish_reason };
      if (data.usage) yield { type: 'usage', usage: data.usage };
      return;
    }

    if (!response.body) throw new AiError('magpie 没有返回流', 502);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    function* handleLine(rawLine) {
      const line = rawLine.replace(/\r$/, '');
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return;

      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        return;
      }

      if (chunk.error) {
        throw new AiError(chunk.error.message || String(chunk.error), 502);
      }

      const choice = chunk.choices?.[0];
      if (!choice) return;

      const delta = choice.delta || {};
      if (delta.content) {
        yield { type: 'content', text: delta.content };
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          yield {
            type: 'tool_call',
            index: call.index ?? 0,
            id: call.id,
            name: call.function?.name,
            argumentsDelta: call.function?.arguments || '',
          };
        }
      }
      if (choice.finish_reason) {
        yield { type: 'finish', reason: choice.finish_reason };
      }
      if (chunk.usage) {
        yield { type: 'usage', usage: chunk.usage };
      }
    }

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          yield* handleLine(line);
        }
      }

      buffer += decoder.decode();
      if (buffer.trim()) {
        yield* handleLine(buffer);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // 已经释放就忽略。
      }
    }
  }

  async function* streamChat(options = {}) {
    const {
      model,
      messages,
      tools,
      temperature = 0.8,
      maxTokens = 8192,
      reasoningEffort = '',
      sessionId = '',
      signal,
    } = options;

    const startedAt = Date.now();
    const track = {
      content: '',
      calls: new Map(),
      finishReason: null,
      usage: null,
      error: null,
      events: 0,
      firstEventMs: null,
      lastEventType: null,
    };

    record('ai.request', {
      stream: true,
      model,
      messages,
      temperature,
      maxTokens,
      reasoningEffort,
      sessionId,
      tools: Array.isArray(tools)
        ? tools.map((tool) => tool?.function?.name).filter(Boolean)
        : [],
    });

    try {
      for await (const event of streamChatRaw(options)) {
        track.events += 1;
        if (track.firstEventMs === null) track.firstEventMs = Date.now() - startedAt;
        track.lastEventType = event.type || track.lastEventType;
        if (event.type === 'content') {
          track.content += event.text || '';
        } else if (event.type === 'tool_call') {
          const index = event.index ?? 0;
          let call = track.calls.get(index);
          if (!call) {
            call = { index, id: '', name: '', arguments: '' };
            track.calls.set(index, call);
          }
          if (event.id) call.id = event.id;
          if (event.name) call.name = event.name;
          if (event.argumentsDelta) call.arguments += event.argumentsDelta;
        } else if (event.type === 'finish') {
          track.finishReason = event.reason || null;
        } else if (event.type === 'usage') {
          track.usage = event.usage || null;
        }
        yield event;
      }
    } catch (err) {
      let failure = err;
      const timedOut = !signal?.aborted
        && (err?.code === 'AI_TIMEOUT'
          || err?.name === 'TimeoutError'
          || /aborted due to timeout/i.test(String(err?.message || '')));
      if (timedOut) {
        const elapsedMs = Date.now() - startedAt;
        if (err?.code === 'AI_TIMEOUT') {
          failure = err;
        } else {
          failure = new AiError(
            `模型 ${model || '未知'} 在 ${Math.round(timeoutMs / 1000)} 秒内没有返回数据（最后事件：${track.lastEventType || '无'}）`,
            504,
          );
          failure.code = 'AI_STREAM_TIMEOUT';
          failure.retryable = true;
          failure.model = model || '';
          failure.elapsedMs = elapsedMs;
          failure.events = track.events;
          failure.lastEventType = track.lastEventType;
        }
      }
      track.error = failure?.message || String(failure);
      throw failure;
    } finally {
      record('ai.response', {
        stream: true,
        model,
        ms: Date.now() - startedAt,
        content: track.content,
        toolCalls: [...track.calls.values()].sort((a, b) => a.index - b.index),
        finishReason: track.finishReason,
        usage: track.usage,
        error: track.error,
        aborted: Boolean(signal?.aborted),
        events: track.events,
        firstEventMs: track.firstEventMs,
        lastEventType: track.lastEventType,
      }, track.error ? 'error' : 'info');
    }
  }

  /** 非流式请求，用于生成章节摘要这类短输出。 */
  async function completeRaw({
    model,
    messages,
    temperature = 0.3,
    maxTokens = 400,
    reasoningEffort = '',
    sessionId = '',
    signal,
  } = {}) {
    const body = {
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
    };
    if (reasoningEffort) body.reasoning_effort = reasoningEffort;
    const response = await request(body, { signal, sessionId });
    const data = await response.json().catch(() => null);
    if (!data) throw new AiError('magpie 返回了无法解析的响应', 502);
    if (data.error) throw new AiError(data.error.message || String(data.error), 502);

    const choice = data.choices?.[0];
    return {
      content: choice?.message?.content || '',
      reasoning: choice?.message?.reasoning_content || '',
      finishReason: choice?.finish_reason || null,
      usage: data.usage || null,
    };
  }

  async function complete(options = {}) {
    if (!debugLog) return completeRaw(options);

    const {
      model,
      messages,
      temperature = 0.3,
      maxTokens = 400,
      reasoningEffort = '',
      sessionId = '',
      signal,
    } = options;
    const startedAt = Date.now();

    record('ai.request', {
      stream: false,
      model,
      messages,
      temperature,
      maxTokens,
      reasoningEffort,
      sessionId,
    });

    try {
      const result = await completeRaw(options);
      record('ai.response', {
        stream: false,
        model,
        ms: Date.now() - startedAt,
        content: result.content,
        reasoning: result.reasoning,
        finishReason: result.finishReason,
        usage: result.usage,
        error: null,
        aborted: Boolean(signal?.aborted),
      });
      return result;
    } catch (err) {
      record('ai.response', {
        stream: false,
        model,
        ms: Date.now() - startedAt,
        content: '',
        error: err?.message || String(err),
        aborted: Boolean(signal?.aborted),
      }, 'error');
      throw err;
    }
  }

  /** 读取网关模型列表。 */
  async function listModels({ signal } = {}) {
    const url = `${String(baseUrl).replace(/\/+$/, '')}/models`;
    const timeoutSignal = AbortSignal.timeout(Math.min(timeoutMs, 15000));
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    let response;
    try {
      response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: combined,
      });
    } catch (err) {
      throw new AiError(`连接 magpie 失败：${err.message}`, 502);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new AiError(
        `magpie 返回 ${response.status}${text ? `：${text.slice(0, 300)}` : ''}`,
        response.status,
      );
    }

    const data = await response.json().catch(() => null);
    if (!data) throw new AiError('magpie 返回了无法解析的模型列表', 502);

    const list = Array.isArray(data.data)
      ? data.data
      : (Array.isArray(data.models) ? data.models : []);

    return list
      .map((item) => (typeof item === 'string' ? { id: item } : item))
      .filter((item) => item && typeof item.id === 'string' && item.id.trim())
      .map((item) => ({
        id: item.id.trim(),
        displayName: String(item.display_name || item.id).trim(),
        contextWindow: Number(item.context_window || item.context_length) || 0,
        maxOutput: Number(item.max_output_tokens) || 0,
        toolCall: item.tool_call !== false,
        reasoning: Boolean(item.reasoning),
        reasoningLevels: normalizeReasoningLevels(item.supported_reasoning_levels),
        ownedBy: item.owned_by || '',
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  function withSession(sessionId) {
    const bound = String(sessionId || '').trim();
    if (!bound) return api;
    return {
      endpoint,
      async *streamChat(options = {}) {
        yield* streamChat({ ...options, sessionId: bound });
      },
      async complete(options = {}) {
        return complete({ ...options, sessionId: bound });
      },
      listModels,
      withSession,
    };
  }

  const api = { endpoint, streamChat, complete, listModels, withSession };
  return api;
}
