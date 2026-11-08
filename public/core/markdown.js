import { marked } from '../vendor/marked.esm.js';
import DOMPurify from '../vendor/purify.es.js';
import katex from '/vendor/katex/katex.mjs';
import renderMathInElement from '/vendor/katex/contrib/auto-render.mjs';
import { escapeHtml } from './dom.js';

const MATH_BLOCK_RE = /^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n|$)/;
const MATH_DELIMITERS = [
  { left: '$$', right: '$$', display: true },
  { left: '\\[', right: '\\]', display: true },
  { left: '\\(', right: '\\)', display: false },
  { left: '$', right: '$', display: false },
];

marked.use({
  extensions: [{
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
  }],
});

export { marked };

export function sanitizeHtml(html) {
  return DOMPurify.sanitize(html);
}

export function renderBlockMath(root) {
  if (!root) return;
  root.querySelectorAll('.math-block').forEach((element) => {
    const tex = element.getAttribute('data-tex') || '';
    if (!tex) return;
    try {
      element.innerHTML = katex.renderToString(tex, {
        displayMode: true,
        throwOnError: false,
        strict: false,
      });
    } catch (err) {
      element.textContent = tex;
    }
  });
}

export function renderMath(root) {
  if (!root) return;
  try {
    renderMathInElement(root, {
      delimiters: MATH_DELIMITERS,
      throwOnError: false,
      strict: false,
      errorColor: 'rgba(255,85,68,.9)',
      ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'option'],
    });
  } catch (err) {
    console.warn('KaTeX render failed', err);
  }
}
