import { state } from '../core/state.js';
import { $ } from '../core/dom.js';

function clusterRulerTops(values, tolerance) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const tops = [];
  for (const value of sorted) {
    if (!tops.length || value - tops[tops.length - 1] > tolerance) tops.push(value);
  }
  return tops;
}

function rulerGeometry() {
  const prose = $('#prose');
  const ms = $('.manuscript');
  const ruler = $('#diff-ruler');
  if (!prose || !ms || !ruler) return null;

  const paragraph = prose.querySelector('p');
  const lineHeight = parseFloat(paragraph ? getComputedStyle(paragraph).lineHeight : '');
  const tolerance = Math.max(6, (Number.isFinite(lineHeight) ? lineHeight : 24) * 0.45);
  const msRect = ms.getBoundingClientRect();
  const scrollTop = ms.scrollTop;
  const toContent = (top) => top - msRect.top + scrollTop;

  const values = [];
  const range = document.createRange();
  range.selectNodeContents(prose);
  [...range.getClientRects()].forEach((rect) => {
    if (rect.width > 0 && rect.height > 0) values.push(toContent(rect.top));
  });
  const tops = clusterRulerTops(values, tolerance);

  return {
    prose,
    ms,
    ruler,
    toContent,
    tolerance,
    tops,
    totalLines: tops.length,
    rulerHeight: ruler.clientHeight,
    scrollHeight: ms.scrollHeight,
  };
}

function nearestRulerLine(tops, value) {
  let best = 0;
  let distance = Infinity;
  tops.forEach((top, index) => {
    const next = Math.abs(top - value);
    if (next < distance) {
      distance = next;
      best = index;
    }
  });
  return best;
}

function rulerLineSpan(element, geometry) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const values = [...range.getClientRects()]
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .map((rect) => geometry.toContent(rect.top));
  const clusters = clusterRulerTops(values, geometry.tolerance);
  if (!clusters.length) return null;
  const indices = clusters.map((top) => nearestRulerLine(geometry.tops, top));
  return { start: Math.min(...indices), end: Math.max(...indices) };
}

function layoutRulerThumb() {
  const wrap = document.querySelector('.ms-wrap');
  const ms = $('.manuscript');
  const ruler = $('#diff-ruler');
  const thumb = $('#diff-ruler-thumb');
  if (!wrap?.classList.contains('ruler-on') || !ms || !ruler || !thumb) return;

  const total = ms.scrollHeight;
  const viewport = ms.clientHeight;
  const height = ruler.clientHeight;
  if (!total || !viewport || !height) return;
  const maxScroll = Math.max(1, total - viewport);
  const thumbHeight = total <= viewport
    ? height
    : Math.max(24, Math.round((viewport / total) * height));
  const thumbTop = total <= viewport
    ? 0
    : Math.round((ms.scrollTop / maxScroll) * (height - thumbHeight));

  thumb.style.height = `${thumbHeight}px`;
  thumb.style.top = `${thumbTop}px`;
  thumb.setAttribute('aria-valuenow', String(Math.round((ms.scrollTop / maxScroll) * 100)));
}

function renderRuler() {
  const wrap = document.querySelector('.ms-wrap');
  const ruler = $('#diff-ruler');
  const marks = $('#diff-ruler-marks');
  if (!wrap?.classList.contains('ruler-on') || !ruler || !marks) return;

  marks.innerHTML = '';
  const geometry = rulerGeometry();
  if (!geometry || !geometry.tops.length) {
    layoutRulerThumb();
    return;
  }

  const paragraphs = [...geometry.prose.querySelectorAll('p')];
  const elements = [...geometry.prose.querySelectorAll(
    '.ai-del, .ai-ins, .ai-selection-pending, .ai-change-block .ai-old, .ai-change-block .ai-new',
  )];
  const ranges = [];
  for (const element of elements) {
    const span = rulerLineSpan(element, geometry);
    if (!span) continue;
    const kind = element.classList.contains('ai-selection-pending')
      ? 'pending'
      : (element.classList.contains('ai-del') || element.classList.contains('ai-old') ? 'red' : 'green');
    ranges.push({ ...span, kind, element });
  }

  const merged = [];
  for (const range of ranges.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = merged[merged.length - 1];
    const sameState = last && ((range.kind === 'pending') === last.kinds.has('pending'));
    if (last && sameState && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
      last.kinds.add(range.kind);
    } else {
      merged.push({ ...range, kinds: new Set([range.kind]) });
    }
  }

  for (const range of merged) {
    const kinds = range.kinds;
    const kind = kinds.size === 1
      ? [...kinds][0]
      : (kinds.has('red') && kinds.has('green') ? 'blue' : [...kinds][0]);
    const rawTop = (geometry.tops[range.start] / geometry.scrollHeight) * geometry.rulerHeight;
    const rawHeight = ((range.end - range.start + 1) / geometry.totalLines) * geometry.rulerHeight;
    const block = Math.max(3, rawHeight);
    let top = rawTop;
    if (block > rawHeight) top -= (block - rawHeight) / 2;
    top = Math.max(0, Math.min(geometry.rulerHeight - block, top));

    const paragraph = range.element.closest('p');
    const paragraphIndex = paragraph ? paragraphs.indexOf(paragraph) + 1 : 0;
    const label = kind === 'red' ? '删除' : kind === 'green' ? '新增' : kind === 'blue' ? '修改' : '正在改写';

    const mark = document.createElement('button');
    mark.type = 'button';
    mark.className = 'diff-ruler-mark';
    mark.dataset.kind = kind;
    mark.dataset.scroll = String(Math.round(geometry.tops[range.start]));
    mark.title = paragraphIndex ? `第 ${paragraphIndex} 段 · ${label}` : label;
    mark.setAttribute('aria-label', mark.title);
    mark.style.top = `${Math.round(top)}px`;
    mark.style.height = `${Math.round(block)}px`;
    marks.appendChild(mark);
  }

  layoutRulerThumb();
}

export function scheduleRulerRender() {
  if (state.rulerFrame) return;
  state.rulerFrame = requestAnimationFrame(() => {
    state.rulerFrame = 0;
    renderRuler();
  });
}

export function setRulerEnabled() {
  const wrap = document.querySelector('.ms-wrap');
  const ruler = $('#diff-ruler');
  if (!wrap || !ruler) return;
  const singleColumn = window.matchMedia('(max-width: 1080px)').matches;
  const enabled = Boolean(state.current) && state.manuscriptMode === 'read' && !singleColumn;
  wrap.classList.toggle('ruler-on', enabled);
  ruler.hidden = !enabled;
  if (enabled) {
    scheduleRulerRender();
  } else {
    const marks = $('#diff-ruler-marks');
    if (marks) marks.innerHTML = '';
  }
}

function showRulerThumb() {
  const wrap = document.querySelector('.ms-wrap');
  if (!wrap) return;
  wrap.classList.add('ruler-show');
  clearTimeout(state.rulerThumbTimer);
  state.rulerThumbTimer = setTimeout(() => wrap.classList.remove('ruler-show'), 900);
}

export function wireDiffRuler() {
  const ruler = $('#diff-ruler');
  const thumb = $('#diff-ruler-thumb');
  const ms = $('.manuscript');
  const prose = $('#prose');
  if (!ruler || !thumb || !ms || !prose) return;

  let drag = null;
  thumb.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    showRulerThumb();
    thumb.setPointerCapture(event.pointerId);
    thumb.classList.add('dragging');
    drag = { startY: event.clientY, startScroll: ms.scrollTop };
  });
  thumb.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const height = ruler.clientHeight;
    const maxScroll = Math.max(1, ms.scrollHeight - ms.clientHeight);
    const travel = Math.max(1, height - thumb.offsetHeight);
    const delta = ((event.clientY - drag.startY) / travel) * maxScroll;
    ms.scrollTop = Math.max(0, Math.min(maxScroll, drag.startScroll + delta));
  });
  const endDrag = (event) => {
    if (!drag) return;
    drag = null;
    thumb.classList.remove('dragging');
    if (event?.pointerId !== undefined && thumb.hasPointerCapture(event.pointerId)) {
      thumb.releasePointerCapture(event.pointerId);
    }
  };
  thumb.addEventListener('pointerup', endDrag);
  thumb.addEventListener('pointercancel', endDrag);

  ruler.addEventListener('click', (event) => {
    const mark = event.target.closest('.diff-ruler-mark');
    if (mark) {
      const target = Number(mark.dataset.scroll) || 0;
      ms.scrollTo({
        top: Math.max(0, target - ms.clientHeight / 2),
        behavior: 'smooth',
      });
      return;
    }
    if (event.target.closest('.diff-ruler-thumb')) return;
    const rect = ruler.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    ms.scrollTo({ top: ratio * ms.scrollHeight - ms.clientHeight / 2, behavior: 'smooth' });
  });

  let scrollFrame = 0;
  ms.addEventListener('scroll', () => {
    showRulerThumb();
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      layoutRulerThumb();
    });
  });
  ms.addEventListener('focus', showRulerThumb);
  prose.addEventListener('input', scheduleRulerRender);
  window.addEventListener('resize', () => {
    setRulerEnabled();
    scheduleRulerRender();
  });

  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => {
      if (document.querySelector('.ms-wrap')?.classList.contains('ruler-on')) {
        scheduleRulerRender();
      }
    });
    observer.observe(prose);
    observer.observe(ms);
  }
}
