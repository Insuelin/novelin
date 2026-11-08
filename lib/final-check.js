const REFUSAL_RE = /(抱歉|对不起|很遗憾|我不能|无法继续|不能继续|无法协助|不能协助|作为\s*AI|作为一个\s*AI)/;
const CLARIFY_RE = /(你希望|你想|请确认|要不要|是否需要我|需要我|请告诉我|可以告诉我)/;
const PREAMBLE_RE = /(我先|我来|让我|接下来|好的|收到|明白|稍等)/;
const NO_CHANGE_RE = /(不需要修改|无需修改|原文已经符合|原文已符合|无需改动|不需要改动)/;
const TOOL_TEXT_RE = /(?:read_manuscript|read_chapter|read_summary|list_chapters|search_manuscript|search_summaries|read_outline|read_notes|edit_manuscript|edit_outline|research|finish)\s*\(/;

export function hasChapterHeading(text) {
  return /^\s*(?:#{1,6}[ \t]+.+|第[一二三四五六七八九十百零〇两\d]+章[^\n]*)(?:\r?\n|$)/.test(String(text || ''));
}

function trimText(text) {
  return String(text || '').trim();
}

/**
 * 结束前的机械性检查。只做结构判断，不判断改得对不对。
 * 返回 { kind, fatal, retry, warning, notice, message, nudge }。
 */
export function classifyFinal({ action, text, ops = [], finishReason = 'stop' } = {}) {
  const value = trimText(text);
  const heading = hasChapterHeading(value);
  const short = value.length < 500;

  if (finishReason === 'content_filter') {
    return {
      kind: 'content_filter',
      fatal: true,
      message: '模型输出被内容过滤中断，请调整指令后重试。',
    };
  }

  if (finishReason === 'length') {
    if (action === 'chapter') {
      return {
        kind: 'truncated',
        fatal: true,
        message: '输出达到上限，章节未写完；请提高输出上限后重试。',
      };
    }
    if (action === 'revise' || action === 'plot') {
      if (ops.length > 0) {
        return { kind: 'ok', warning: '输出达到上限，后面的内容可能被截断。' };
      }
      return {
        kind: 'truncated',
        fatal: true,
        message: '输出达到上限，修改没有完成。',
      };
    }
    return { kind: 'truncated', warning: '输出达到上限，回答可能不完整。' };
  }

  if (!value) {
    return {
      kind: 'empty',
      retry: true,
      message: '模型没有返回内容',
      nudge: '你还没有返回内容。继续，直接给出最终结果。',
    };
  }

  if (action === 'chapter') {
    if (!heading && TOOL_TEXT_RE.test(value)) {
      return {
        kind: 'tool_text',
        retry: true,
        message: '模型把工具调用写成了文字',
        nudge: '不要输出工具调用的文字或 JSON。请使用真正的工具调用，或直接写正文。',
      };
    }
    if (!heading && short && REFUSAL_RE.test(value)) {
      return {
        kind: 'refusal',
        fatal: true,
        message: `模型拒绝继续：${value.slice(0, 200)}`,
      };
    }
    if (!heading && short && CLARIFY_RE.test(value)) {
      return {
        kind: 'clarify',
        retry: true,
        message: '模型在反问',
        nudge: '不要向用户提问。按现有信息直接完成；缺少的信息做合理假设，并在最后一句说明。',
      };
    }
    if (!heading && value.length < 200) {
      return {
        kind: 'preamble',
        retry: true,
        message: '模型只说了开场白',
        nudge: '你还没有完成。不要只说要做什么，直接给出整章正文。',
      };
    }
    return { kind: 'ok' };
  }

  if (action === 'revise' || action === 'plot') {
    if (ops.length > 0) return { kind: 'ok' };
    if (short && REFUSAL_RE.test(value)) {
      return {
        kind: 'refusal',
        fatal: true,
        message: `模型拒绝继续：${value.slice(0, 200)}`,
      };
    }
    if (short && CLARIFY_RE.test(value)) {
      return {
        kind: 'clarify',
        retry: true,
        message: '模型在反问',
        nudge: '不要向用户提问。按现有信息直接完成修改；缺少的信息做合理假设。',
      };
    }
    if (TOOL_TEXT_RE.test(value)) {
      return {
        kind: 'tool_text',
        retry: true,
        message: '模型把工具调用写成了文字',
        nudge: '不要输出工具调用的文字或 JSON。请使用真正的工具调用，或直接说明不需要修改。',
      };
    }
    if (NO_CHANGE_RE.test(value)) {
      return { kind: 'no_change', notice: '模型认为不需要修改' };
    }
    return {
      kind: 'preamble',
      retry: true,
      message: '模型没有修改正文',
      nudge: '你还没有修改正文。请调用 edit_manuscript 完成修改，或明确说明不需要修改。',
    };
  }

  if (short && REFUSAL_RE.test(value)) {
    return {
      kind: 'refusal',
      fatal: true,
      message: `模型拒绝继续：${value.slice(0, 200)}`,
    };
  }

  return { kind: 'ok' };
}

export { NO_CHANGE_RE };
