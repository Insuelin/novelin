export const DEFAULT_MAX_TOKENS = 8192;
export const DEFAULT_MAX_STEPS = 10;

export const TOKEN_PRESETS = [2048, 4096, 8192, 16384];
export const TOKEN_MIN = 256;
export const TOKEN_MAX = 65536;

export const STEP_PRESETS = [6, 10, 16];
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export const DEFAULT_RESEARCH_MODEL = 'opencode-go/deepseek-v4.1-flash';
export const SUMMARY_MODEL = 'opencode-go/deepseek-v4.1-flash';
export const SUMMARY_HEAD = 8000;
export const SUMMARY_TAIL = 4000;
export const SUMMARY_MAX_TOKENS = 800;

export const MAX_RESEARCH_CALLS = 3;
export const RESEARCH_MAX_STEPS = 20;
export const RESEARCH_MAX_READS = 6;
export const RESEARCH_MAX_CHARS = 24000;
export const RESEARCH_TIMEOUT_MS = 90000;
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
