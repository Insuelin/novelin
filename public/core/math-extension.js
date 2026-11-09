import { escapeHtml } from './dom.js';

const MATH_BLOCK_RE = /^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n|$)/;

export const mathBlockExtension = {
  name: 'mathBlock',
  level: 'block',
  start(src) {
    return src.search(/\$\$|\\\[/);
  },
  tokenizer(src) {
    const match = MATH_BLOCK_RE.exec(src);
    if (!match) return undefined;
    return {
      type: 'mathBlock',
      raw: match[0],
      text: (match[1] ?? match[2] ?? '').trim(),
    };
  },
  renderer(token) {
    return `<div class="math-block" data-tex="${escapeHtml(token.text)}"></div>\n`;
  },
};
