export function countWords(text) {
  return Array.from(String(text || '').replace(/[\s　]/g, '')).length;
}

export function getManuscriptTitle(manuscript) {
  const source = String(manuscript || '');
  const match = source.match(/^(#{1,2})\s+(.+)$/m);
  if (!match || match[1].length !== 1) return null;
  return {
    title: match[2].trim(),
    start: match.index,
    end: match.index + match[0].length,
  };
}

export function parseChapterEntries(manuscript, bookTitle = '') {
  const source = String(manuscript || '');
  if (!source.trim()) return [];

  const headings = [...source.matchAll(/^(#{1,2})\s+(.+)$/gm)].map((match) => ({
    level: match[1].length,
    title: match[2].trim(),
    start: match.index,
  }));

  const title = getManuscriptTitle(source);
  let entries = headings;
  if (title) entries = entries.filter((entry) => entry.start !== title.start);
  if (!entries.length) entries = [{ level: 0, title: '正文', start: 0 }];
  return entries;
}

export function countChapters(text, title = '') {
  return parseChapterEntries(text, title).length;
}

export function pad2(value) {
  return String(value).padStart(2, '0');
}

export function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(Number(value) || 0);
}

export function compactNumber(value) {
  const number = Number(value) || 0;
  if (number >= 1000000) return `${(number / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
  if (number >= 1000) return `${(number / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(number);
}

export function timeAgo(iso) {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return '—';
  const diff = Math.max(0, Date.now() - time);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'JUST NOW';
  if (minutes < 60) return `${minutes}M AGO`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}H AGO`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}D AGO`;
  const date = new Date(time);
  return `${date.getFullYear()}.${pad2(date.getMonth() + 1)}.${pad2(date.getDate())}`;
}

export function deriveTitleFromContent(content) {
  const match = String(content || '').match(/^\s*#{1,6}\s+(.+)$/m);
  return match ? match[1].trim() : '';
}

export function usageLabel(usage) {
  return { continue: 'CONTINUE', reference: 'REFERENCE', read: 'READ ONLY' }[usage] || 'MANUSCRIPT';
}

export function compactValue(value) {
  if (value === null || value === undefined) return '';
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}
