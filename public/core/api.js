export const API = '/api';

export async function api(path, options = {}) {
  const request = { ...options };
  if (request.body && typeof request.body !== 'string') {
    request.body = JSON.stringify(request.body);
  }
  request.headers = {
    ...(request.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {}),
  };

  let response;
  try {
    response = await fetch(`${API}${path}`, request);
  } catch {
    throw new Error('连不上本地服务，确认 npm start 还在跑');
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `请求失败 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export async function streamAiResponse(response, onEvent) {
  if (!response.body) throw new Error('浏览器不支持流式响应');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const dispatch = (raw) => {
    let eventName = 'message';
    const data = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!data.length) return;
    let payload;
    try {
      payload = JSON.parse(data.join('\n'));
    } catch {
      return;
    }
    onEvent(eventName, payload);
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (raw.trim()) dispatch(raw);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    for (const raw of buffer.split('\n\n')) {
      if (raw.trim()) dispatch(raw);
    }
  }
}
