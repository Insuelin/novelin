/**
 * 跨书全文搜索。只返回片段，不把整本书交给调用方。
 */
export function searchBooks(books, rawQuery, { perBook = 6, max = 80, around = 40 } = {}) {
  const query = String(rawQuery ?? '').trim();
  if (!query) return [];

  const needle = query.toLowerCase();
  const results = [];

  for (const book of books) {
    if (!book || !book.meta) continue;

    const sections = [
      ['manuscript', book.manuscript],
      ['notes', book.notes],
      ['outline', book.outline],
    ];

    let found = 0;
    for (const [section, rawText] of sections) {
      if (found >= perBook) break;

      const text = String(rawText || '');
      const haystack = text.toLowerCase();
      let from = 0;

      while (found < perBook) {
        const at = haystack.indexOf(needle, from);
        if (at < 0) break;

        const start = Math.max(0, at - around);
        const end = Math.min(text.length, at + query.length + around);

        results.push({
          bookId: book.meta.id,
          title: book.meta.title,
          section,
          at,
          snippet: text.slice(start, end).replace(/\s+/g, ' ').trim(),
          prefix: at - start,
          match: text.slice(at, at + query.length),
        });

        found += 1;
        from = at + Math.max(1, needle.length);
        if (results.length >= max) return results;
      }
    }
  }

  return results;
}
