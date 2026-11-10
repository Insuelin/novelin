import {
  EditorState,
  EditorView,
  drawSelection,
  history,
  markdown,
  markdownLanguage,
} from '/vendor/codemirror.js';
import { scanMath } from '/core/math-scan.js';
import { livePreview } from '/features/editor-live.js';
import { mathField, mathInlinePreview } from '/features/editor-math.js';

const SAMPLE = [
  '## 公式样例',
  '',
  '雾从海上进来。行内公式 $E=mc^2$，还有 \\(a^2+b^2=c^2\\)。',
  '',
  '$$',
  '\\int_0^1 x^2\\,dx = \\frac{1}{3}',
  '$$',
  '',
  '\\[',
  '\\begin{aligned}',
  'a &= b + c \\\\',
  'd &= e - f',
  '\\end{aligned}',
  '\\]',
  '',
  '段落中间的 $$x+y$$ 会按行内 display 处理。',
  '',
  '价格 $5 到 $10，不应渲染。',
  '',
  '行内 code `$z$` 不渲染。',
  '',
  '~~~text',
  '$$',
  'x+y',
  '$$',
  '~~~',
  '',
  '公式里的 * 和 _：$a_1 * b_2 + \\alpha$。',
].join('\n');

const status = document.querySelector('#math-status');
const selectionInfo = document.querySelector('#math-selection');

const view = new EditorView({
  parent: document.querySelector('#prose'),
  state: EditorState.create({
    doc: SAMPLE,
    extensions: [
      history(),
      drawSelection(),
      EditorView.lineWrapping,
      markdown({ base: markdownLanguage }),
      mathField,
      mathInlinePreview,
      livePreview,
      EditorView.updateListener.of((update) => {
        if (update.docChanged || update.selectionSet) updateStatus();
      }),
    ],
  }),
});

function find(needle) {
  return view.state.doc.toString().indexOf(needle);
}

function selectAt(needle, offset = 0) {
  const at = find(needle);
  if (at < 0) return;
  view.dispatch({
    selection: { anchor: Math.min(view.state.doc.length, at + offset) },
    scrollIntoView: true,
  });
  view.focus();
}

function updateStatus() {
  const pos = view.state.selection.main.head;
  const range = scanMath(view.state.doc.toString()).find((item) => (
    pos >= item.from && pos <= item.to
  ));
  if (status) status.textContent = range ? '光标：公式内' : '光标：公式外';
  if (selectionInfo) {
    selectionInfo.textContent = `SELECTION / ${pos}${range ? ` · ${range.display ? 'DISPLAY' : 'INLINE'}` : ''}`;
  }
}

document.querySelector('#jump-inline')?.addEventListener('click', () => selectAt('$E=mc^2$', 2));
document.querySelector('#jump-block')?.addEventListener('click', () => selectAt('\\int_0^1', 2));
document.querySelector('#jump-code')?.addEventListener('click', () => selectAt('~~~text', 4));
document.querySelector('#reset-demo')?.addEventListener('click', () => {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: SAMPLE },
    selection: { anchor: 0 },
  });
  view.focus();
});

window.__mathDemo = {
  view,
  sample: SAMPLE,
  reset() {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: SAMPLE },
      selection: { anchor: 0 },
    });
  },
};

requestAnimationFrame(updateStatus);
