const DEFAULT_BASE_URL = 'http://127.0.0.1:3425/v1';
const DEFAULT_API_KEY = 'magpie';
const DEFAULT_TIMEOUT_MS = 180000;
const REASONING_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

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
} = {}) {
  const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;

  async function request(body, { signal } = {}) {
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
          },
          body: JSON.stringify(body),
          signal: combined,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
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
  async function* streamChat({
    model,
    messages,
    tools,
    toolChoice = 'auto',
    temperature = 0.8,
    maxTokens = 8192,
    reasoningEffort = '',
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

    const response = await request(body, { signal });
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

  /** 非流式请求，用于生成章节摘要这类短输出。 */
  async function complete({
    model,
    messages,
    temperature = 0.3,
    maxTokens = 400,
    signal,
  } = {}) {
    const response = await request(
      { model, messages, temperature, max_tokens: maxTokens, stream: false },
      { signal },
    );
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

  return { endpoint, streamChat, complete, listModels };
}
