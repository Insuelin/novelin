export const DEFAULT_MAX_TOKENS = 8192;
export const DEFAULT_MAX_STEPS = 16;

export const TOKEN_PRESETS = [2048, 4096, 8192, 16384];
export const TOKEN_MIN = 256;
export const TOKEN_MAX = 65536;

export const STEP_PRESETS = [6, 10, 16, 24, 32];
/** 轮次是软预算；用满后自动续到两倍，但总共不超过这个硬上限。 */
export const MAX_TOTAL_STEPS = 64;
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export const DEFAULT_RESEARCH_MODEL = 'opencode-go/deepseek-v4.1-flash';
export const SUMMARY_MODEL = 'opencode-go/deepseek-v4.1-flash';
export const SUMMARY_SINGLE_PASS_CHARS = 12000;
export const SUMMARY_CHUNK_CHARS = 6000;
export const SUMMARY_CHUNK_OVERLAP = 400;
export const SUMMARY_MAX_CHUNKS = 12;
export const SUMMARY_CHUNK_MAX_CHARS = 16000;
export const SUMMARY_MAP_PARALLEL = 3;
export const SUMMARY_CALL_TIMEOUT_MS = 40000;
export const SUMMARY_MAP_ATTEMPTS = 1;
export const SUMMARY_REDUCE_ATTEMPTS = 2;
export const SUMMARY_MAX_TOKENS = 2500;
export const SUMMARY_REASONING_EFFORT = 'low';
export const SUMMARY_CONCURRENCY = 5;

/** chat 的 append_chapter 工具参数上限；正文仍受模型输出上限约束。 */
export const MAX_APPEND_CHARS = 20000;
export const MAX_APPEND_TITLE = 200;
export const MAX_TOOL_ARG_CHARS = 128 * 1024;

export const MAX_RESEARCH_CALLS = 3;
export const RESEARCH_MAX_STEPS = 20;
export const RESEARCH_MAX_READS = 6;
export const RESEARCH_MAX_CHARS = 24000;
export const RESEARCH_TIMEOUT_MS = 90000;

export const AUDIT_FULL_TEXT_CHARS = 60000;
export const AUDIT_CHUNK_CHARS = 10000;
export const AUDIT_CONCURRENCY = 4;
export const AUDIT_CHUNK_TIMEOUT_MS = 60000;
export const AUDIT_TIMEOUT_MS = 180000;
export const AUDIT_MAX_ISSUES = 8;
export const AUDIT_MAX_ISSUES_PER_CHUNK = 4;
export const AUDIT_MAX_TOKENS = 3072;

export const MAX_STOP_RETRIES = 2;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

export function normalizeAgentSettings(meta = {}) {
  const token = Number(meta.maxTokens);
  const maxTokens = Number.isFinite(token)
    ? clamp(token, TOKEN_MIN, TOKEN_MAX)
    : DEFAULT_MAX_TOKENS;

  const steps = Number(meta.maxSteps);
  const maxSteps = STEP_PRESETS.includes(steps) ? steps : DEFAULT_MAX_STEPS;

  const reasoningEffort = REASONING_EFFORTS.includes(meta.reasoningEffort)
    ? meta.reasoningEffort
    : '';

  const researchModel = String(meta.researchModel || '').trim() || DEFAULT_RESEARCH_MODEL;

  return { maxTokens, maxSteps, reasoningEffort, researchModel };
}
