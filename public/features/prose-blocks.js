import { analyzeBlocks } from '../core/block-source.js';
import { sanitizeHtml } from '../core/markdown.js';

const MARKED_OPTIONS = { breaks: true, gfm: true };

function fallbackFragment(source, marked) {
  const template = document.createElement('template');
  template.innerHTML = sanitizeHtml(marked.parse(source, { ...marked.defaults, ...MARKED_OPTIONS }));
  return template.content;
}

/**
 * 把一篇 Markdown 渲染成可直接放进 #prose 的 DocumentFragment。
 * 每个顶层元素带 data-block-* 属性；fallback 时没有任何块属性，双击编辑自然失效。
 */
export function renderProseBlocks(source, marked) {
  const analysis = analyzeBlocks(source, marked);
  if (analysis.fallback) {
    return {
      fragment: fallbackFragment(source, marked),
      analysis,
      fallback: true,
    };
  }

  const fragment = document.createDocumentFragment();

  analysis.blocks.forEach((block, index) => {
    const single = [block.token];
    single.links = analysis.links;

    let html = '';
    try {
      html = marked.parser(single, {
        ...marked.defaults,
        ...MARKED_OPTIONS,
        links: analysis.links,
      });
    } catch {
      return {
        fragment: fallbackFragment(source, marked),
        analysis,
        fallback: true,
      };
    }

    if (!html.trim()) return;

    const slotTemplate = document.createElement('template');
    slotTemplate.innerHTML = sanitizeHtml(`<div data-blk-slot="${index}">${html}</div>`);
    const slot = slotTemplate.content.firstElementChild;
    if (!slot) return;

    for (const node of Array.from(slot.childNodes)) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        node.dataset.blockIndex = String(index);
        node.dataset.blockType = block.type;
        if (block.editable) {
          node.dataset.blockStart = String(block.start);
          node.dataset.blockEnd = String(block.end);
        } else {
          node.dataset.blockEditable = 'false';
        }
      }
      fragment.appendChild(node);
    }
  });

  return { fragment, analysis, fallback: false };
}
