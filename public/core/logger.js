import { state } from './state.js';
import { $, escapeHtml } from './dom.js';
import { pad2 } from './format.js';

export function setAiState(label, tone = '') {
  const stateElement = $('#ai-state');
  const text = $('#ai-state-text');
  if (text) text.textContent = label;
  if (stateElement) stateElement.dataset.state = tone;
}

export function aiLog(tag, message, tone = '') {
  const level = tone === 'err' ? 'error' : tone === 'warn' ? 'warn' : 'info';
  const now = new Date();
  state.aiLogs.push({
    time: `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`,
    tag,
    text: String(message ?? ''),
    level,
  });
  if (state.aiLogs.length > 200) state.aiLogs.splice(0, state.aiLogs.length - 200);
  renderLog(level === 'error');
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
