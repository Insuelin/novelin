import { state } from './state.js';
import { $, escapeHtml } from './dom.js';
import { pad2 } from './format.js';

const MAX_LOG_TEXT = 2000;
const MAX_LOG_BATCH = 20;
const pendingDebugLogs = [];
let debugFlushTimer = 0;

function flushDebugLogs({ beacon = false } = {}) {
  if (!pendingDebugLogs.length) return;

  const entries = pendingDebugLogs.splice(0, MAX_LOG_BATCH);
  const body = JSON.stringify({ entries });

  if (beacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    try {
      navigator.sendBeacon('/api/debug/log', new Blob([body], { type: 'application/json' }));
    } catch {
      // 调试日志发不出去就算了。
    }
    if (pendingDebugLogs.length) flushDebugLogs({ beacon: true });
    return;
  }

  fetch('/api/debug/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => {});
}

function queueDebugLog(entry) {
  pendingDebugLogs.push(entry);

  if (pendingDebugLogs.length >= MAX_LOG_BATCH) {
    if (debugFlushTimer) {
      clearTimeout(debugFlushTimer);
      debugFlushTimer = 0;
    }
    flushDebugLogs();
    return;
  }

  if (debugFlushTimer) return;
  debugFlushTimer = setTimeout(() => {
    debugFlushTimer = 0;
    flushDebugLogs();
  }, 600);
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => flushDebugLogs({ beacon: true }));
  window.addEventListener('pagehide', () => flushDebugLogs({ beacon: true }));
}

export function setAiState(label, tone = '') {
  const stateElement = $('#ai-state');
  const text = $('#ai-state-text');
  if (text) text.textContent = label;
  if (stateElement) stateElement.dataset.state = tone;
}

export function aiLog(tag, message, tone = '') {
  const level = tone === 'err' ? 'error' : tone === 'warn' ? 'warn' : 'info';
  const now = new Date();
  const text = String(message ?? '');
  const time = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  state.aiLogs.push({ time, tag, text, level });
  if (state.aiLogs.length > 200) state.aiLogs.splice(0, state.aiLogs.length - 200);
  renderLog(level === 'error');

  queueDebugLog({
    at: now.toISOString(),
    time,
    tag: String(tag ?? '').slice(0, 40),
    text: text.slice(0, MAX_LOG_TEXT),
    level,
    bookId: state.current?.meta?.id || '',
    view: state.view || '',
  });
}

export function renderLog(forceBottom = false) {
  const log = $('#ai-log');
  if (!log) return;

  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
  const rank = { info: 0, warn: 1, error: 2 };
  const matches = (entry) => rank[entry.level] >= (rank[state.logLevel] ?? 0);

  const entries = state.aiLogs.filter(matches);
  log.innerHTML = entries.length
    ? entries.map((entry) => {
      const cls = entry.level === 'error' ? 'err' : entry.level;
      return `<div class="log-line ${cls}"><time>${entry.time}</time><span class="tag">${escapeHtml(entry.tag)}</span><span class="txt">${escapeHtml(entry.text)}</span></div>`;
    }).join('')
    : '<div class="log-empty">暂无日志</div>';

  const button = $('#log-level');
  if (button) {
    const label = state.logLevel === 'error' ? 'ERR' : state.logLevel.toUpperCase();
    button.dataset.level = state.logLevel;
    button.textContent = label;
    button.setAttribute('aria-label', `日志等级 ${label}，点击切换`);
  }

  if (forceBottom || nearBottom) log.scrollTop = log.scrollHeight;
}
