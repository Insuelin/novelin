import { marked } from './marked.js';
import DOMPurify from '../vendor/purify.es.js';
import katex from '/vendor/katex/katex.mjs';
import renderMathInElement from '/vendor/katex/contrib/auto-render.mjs';

const MATH_DELIMITERS = [
  { left: '$$', right: '$$', display: true },
  { left: '\\[', right: '\\]', display: true },
  { left: '\\(', right: '\\)', display: false },
  { left: '$', right: '$', display: false },
];

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
