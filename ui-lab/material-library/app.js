import { escapeHtml } from '/core/dom.js';
import { KINDS, createMaterials, matchMaterials, suggestTriggers } from './mock-data.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const materials = createMaterials();
const selected = new Set();
const dismissed = new Set();
let selectedId = materials[0]?.id || null;
let editingId = null;
let editTriggers = [];
let search = '';
let kindFilter = '';
let hitTimer = 0;

const instruction = $('#instruction');
const hitsPanel = $('#material-hits');
const hitList = $('#material-hit-list');
const selectedTray = $('#selected-materials');
const materialDialog = $('#material-dialog');
const editDialog = $('#material-edit-dialog');
const list = $('#material-list');
const detail = $('#material-detail');
const toast = $('#demo-toast');

function kindLabel(kind) {
  return KINDS[kind] || kind;
}

function materialById(id) {
  return materials.find((item) => item.id === id) || null;
}

function triggerHtml(trigger) {
  return `<span class="trigger-chip"><b>${escapeHtml(trigger)}</b></span>`;
}

function renderList() {
  if (!list) return;
  const needle = search.trim().toLowerCase();
  const visible = materials.filter((material) => {
    if (kindFilter && material.kind !== kindFilter) return false;
    if (!needle) return true;
    const haystack = [material.title, material.summary, material.content, ...(material.triggers || [])]
      .join('\n')
      .toLowerCase();
    return haystack.includes(needle);
  });

  if (!visible.length) {
    list.innerHTML = '<p class="demo-note" style="padding:16px">没有匹配的资料。</p>';
    return;
  }

  list.innerHTML = visible.map((material) => `
    <article class="material-card${material.id === selectedId ? ' on' : ''}" data-material-id="${escapeHtml(material.id)}" role="listitem">
      <div class="material-card-head">
        <span class="material-card-title">${escapeHtml(material.title)}</span>
        <span class="material-kind">${escapeHtml(kindLabel(material.kind))}</span>
        ${material.enabled ? '' : '<span class="material-kind" style="color:var(--dim)">停用</span>'}
      </div>
      <p class="material-card-summary">${escapeHtml(material.summary)}</p>
      <div class="material-card-triggers">${(material.triggers || []).map(triggerHtml).join('')}</div>
      <div class="material-card-actions">
        <button class="btn ghost small" type="button" data-edit-material="${escapeHtml(material.id)}">编辑</button>
        <button class="btn ${selected.has(material.id) ? 'small' : 'ghost small'}" type="button" data-pick-material="${escapeHtml(material.id)}">
          ${selected.has(material.id) ? '已选' : '加入本次'}
        </button>
      </div>
    </article>
  `).join('');
}

function renderDetail() {
  if (!detail) return;
  const material = materialById(selectedId);
  if (!material) {
    detail.innerHTML = '<p>从左侧选择一份资料。</p>';
    return;
  }
  detail.innerHTML = `
    <h3>${escapeHtml(material.title)}</h3>
    <p>${escapeHtml(kindLabel(material.kind))} · ${material.enabled ? '启用' : '停用'}</p>
    <div class="material-card-triggers">${(material.triggers || []).map(triggerHtml).join('')}</div>
    <pre>${escapeHtml(material.content)}</pre>
    <div class="edit-actions" style="justify-content:flex-start;margin-top:12px">
      <button class="btn ghost small" type="button" data-edit-material="${escapeHtml(material.id)}">编辑</button>
      <button class="btn ghost small" type="button" data-pick-material="${escapeHtml(material.id)}">${selected.has(material.id) ? '已选' : '加入本次'}</button>
    </div>
  `;
}

function renderSelected() {
  if (!selectedTray) return;
  if (!selected.size) {
    selectedTray.innerHTML = '<span class="demo-note">未手动选择资料</span>';
    return;
  }
  selectedTray.innerHTML = [...selected].map((id) => {
    const material = materialById(id);
    if (!material) return '';
    return `<span class="selected-chip"><b>${escapeHtml(material.title)}</b><button class="chip-x" type="button" data-remove-selected="${escapeHtml(id)}" aria-label="移除">×</button></span>`;
  }).join('');
}

function renderHits() {
  if (!hitsPanel || !hitList) return;
  const hits = matchMaterials(instruction.value, materials)
    .filter((hit) => !dismissed.has(hit.material.id));
  if (!hits.length) {
    hitsPanel.hidden = true;
    hitList.innerHTML = '';
    return;
  }
  hitsPanel.hidden = false;
  hitList.innerHTML = hits.map((hit) => `
    <div class="material-hit" data-hit-material="${escapeHtml(hit.material.id)}">
      <span><b>${escapeHtml(hit.material.title)}</b> <small>命中：${escapeHtml(hit.trigger)}</small></span>
      <button class="icon-btn" type="button" data-add-hit="${escapeHtml(hit.material.id)}" title="加入本次" aria-label="加入本次">+</button>
      <button class="icon-btn" type="button" data-dismiss-hit="${escapeHtml(hit.material.id)}" title="忽略本次命中" aria-label="忽略本次命中">×</button>
    </div>
  `).join('');
}

function renderAll() {
  renderList();
  renderDetail();
  renderSelected();
  renderHits();
}

function scheduleHits() {
  clearTimeout(hitTimer);
  hitTimer = setTimeout(renderHits, 80);
}

function toggleSelected(id) {
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  renderAll();
}

function openLibrary() {
  renderAll();
  if (materialDialog && !materialDialog.open) materialDialog.showModal();
}

function closeDialog(dialog) {
  if (dialog?.open) dialog.close();
}

function renderEditTriggers() {
  const chips = $('#trigger-chips');
  if (!chips) return;
  chips.innerHTML = editTriggers.map((trigger) => `
    <span class="trigger-chip"><b>${escapeHtml(trigger)}</b><button class="chip-x" type="button" data-remove-trigger="${escapeHtml(trigger)}" aria-label="删除触发词">×</button></span>
  `).join('');
}

function openEdit(id = null) {
  editingId = id;
  const material = id ? materialById(id) : {
    title: '',
    kind: 'rule',
    summary: '',
    content: '',
    triggers: [],
    enabled: true,
  };
  if (!material) return;
  editTriggers = [...(material.triggers || [])];
  $('#edit-title').value = material.title;
  $('#edit-kind').value = material.kind;
  $('#edit-summary').value = material.summary;
  $('#edit-content').value = material.content;
  $('#edit-enabled').checked = material.enabled;
  renderEditTriggers();
  closeDialog(materialDialog);
  if (editDialog && !editDialog.open) editDialog.showModal();
}

function addEditTrigger(value) {
  const trigger = String(value || '').trim();
  if (!trigger) return false;
  if (editTriggers.includes(trigger)) return false;
  editTriggers.push(trigger);
  renderEditTriggers();
  return true;
}

function refreshAfterEdit(id) {
  selectedId = id;
  closeDialog(editDialog);
  renderAll();
  openLibrary();
}

$('#materials-btn')?.addEventListener('click', openLibrary);
$('#pick-material')?.addEventListener('click', openLibrary);
$('#material-done')?.addEventListener('click', () => closeDialog(materialDialog));
$('#material-new')?.addEventListener('click', () => openEdit(null));

$$('[data-close]').forEach((button) => {
  button.addEventListener('click', () => closeDialog(document.getElementById(button.dataset.close)));
});

list?.addEventListener('click', (event) => {
  const card = event.target.closest('[data-material-id]');
  if (!card) return;
  const id = card.dataset.materialId;
  const edit = event.target.closest('[data-edit-material]');
  const pick = event.target.closest('[data-pick-material]');
  if (edit) {
    event.stopPropagation();
    openEdit(edit.dataset.editMaterial);
    return;
  }
  if (pick) {
    event.stopPropagation();
    toggleSelected(pick.dataset.pickMaterial);
    return;
  }
  selectedId = id;
  renderList();
  renderDetail();
});

detail?.addEventListener('click', (event) => {
  const edit = event.target.closest('[data-edit-material]');
  const pick = event.target.closest('[data-pick-material]');
  if (edit) openEdit(edit.dataset.editMaterial);
  if (pick) toggleSelected(pick.dataset.pickMaterial);
});

$('#material-search')?.addEventListener('input', (event) => {
  search = event.target.value;
  renderList();
});

$('#kind-filter')?.addEventListener('change', (event) => {
  kindFilter = event.target.value;
  renderList();
});

instruction?.addEventListener('input', () => {
  dismissed.clear();
  scheduleHits();
});

$('#material-hit-list')?.addEventListener('click', (event) => {
  const add = event.target.closest('[data-add-hit]');
  const dismiss = event.target.closest('[data-dismiss-hit]');
  if (add) {
    selected.add(add.dataset.addHit);
    renderSelected();
    renderList();
    renderDetail();
  }
  if (dismiss) {
    dismissed.add(dismiss.dataset.dismissHit);
    renderHits();
  }
});

selectedTray?.addEventListener('click', (event) => {
  const remove = event.target.closest('[data-remove-selected]');
  if (!remove) return;
  selected.delete(remove.dataset.removeSelected);
  renderAll();
});

$('#trigger-chips')?.addEventListener('click', (event) => {
  const remove = event.target.closest('[data-remove-trigger]');
  if (!remove) return;
  editTriggers = editTriggers.filter((trigger) => trigger !== remove.dataset.removeTrigger);
  renderEditTriggers();
});

$('#trigger-add')?.addEventListener('click', () => {
  const input = $('#trigger-input');
  if (addEditTrigger(input.value)) input.value = '';
  input.focus();
});

$('#trigger-input')?.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const input = event.target;
  if (addEditTrigger(input.value)) input.value = '';
});

$('#trigger-suggest')?.addEventListener('click', () => {
  const suggestions = suggestTriggers($('#edit-title').value);
  let added = false;
  for (const trigger of suggestions) {
    if (addEditTrigger(trigger)) added = true;
  }
  if (!added) toast.textContent = '没有新的触发词候选。';
});

$('#edit-cancel')?.addEventListener('click', () => {
  closeDialog(editDialog);
  openLibrary();
});

$('#edit-save')?.addEventListener('click', () => {
  const title = $('#edit-title').value.trim();
  if (!title) {
    toast.textContent = '标题不能为空。';
    return;
  }
  const data = {
    title,
    kind: $('#edit-kind').value,
    summary: $('#edit-summary').value.trim(),
    content: $('#edit-content').value,
    triggers: [...editTriggers],
    enabled: $('#edit-enabled').checked,
  };
  if (editingId) {
    const material = materialById(editingId);
    if (material) Object.assign(material, data);
    refreshAfterEdit(editingId);
  } else {
    const id = `material-${Date.now()}`;
    materials.push({ id, ...data });
    refreshAfterEdit(id);
  }
});

$('#demo-run')?.addEventListener('click', () => {
  const hits = matchMaterials(instruction.value, materials);
  toast.textContent = hits.length
    ? `演示模式：命中 ${hits.length} 条资料，真实运行会先读资料，不写书稿。`
    : '演示模式：本次没有命中资料。';
});

renderAll();
