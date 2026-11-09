import fs from 'node:fs';
import path from 'node:path';

function pad2(value) {
  return String(value).padStart(2, '0');
}

function localDay(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * 本地调试日志，一行一个 JSON，按天切文件。
 *
 * 这个日志只给排查问题用，会记录 AI 请求的完整 messages，可能包含正文和提示词；
 * 不记录 Authorization / API key。写不进去时只打印一次警告，不影响主流程。
 */
export function createDebugLog({
  dir,
  enabled = process.env.NOVELIN_DEBUG_LOG !== '0',
  now = () => new Date(),
} = {}) {
  if (!dir) throw new Error('debug log 需要目录');

  let ready = false;
  let broken = false;

  function ensureDir() {
    if (ready || broken) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      ready = true;
    } catch (err) {
      broken = true;
      console.warn('[debug-log] 创建日志目录失败：', err.message);
    }
  }

  function log(evt, data = {}, level = 'info') {
    if (!enabled) return;
    ensureDir();
    if (broken) return;

    const date = now();
    let line;
    try {
      line = JSON.stringify({ ts: date.toISOString(), level, evt, ...data });
    } catch (err) {
      line = JSON.stringify({
        ts: date.toISOString(),
        level: 'error',
        evt: 'debug.serialize_failed',
        message: err.message,
        original: String(evt),
      });
    }

    try {
      fs.appendFileSync(path.join(dir, `debug-${localDay(date)}.jsonl`), `${line}\n`);
    } catch (err) {
      broken = true;
      console.warn('[debug-log] 写入日志失败：', err.message);
    }
  }

  return { log, dir, enabled };
}
