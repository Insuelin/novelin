import { state } from '../core/state.js';
import { $, $$, escapeHtml } from '../core/dom.js';
import { api } from '../core/api.js';
import { toast } from '../ui/toast.js';
import { confirmDialog } from '../ui/primitives.js';

const KIND_LABELS = {
  rule: '规则',
  location: '地点',
  character: '人物',
  item: '物品',
  outline: '大纲',
};

const SUFFIX_RE = /(做法|教程|指南|配方|资料|说明|笔记|大全|流程|步骤|方法|设定|规则|地图)$/;
const GENERIC = new Set([
  '做法', '教程', '指南', '配方', '资料', '说明', '笔记', '大全', '流程',
  '步骤', '方法', '设定', '规则', '地图', '内容', '注意事项',
]);

let bookId = '';
let selected = new Set();
let dismissed = new Set();
let selectedId = null;
let editingId = null;
let editTriggers = [];
let search = '';
let kindFilter = '';
let hitTimer = 0;
let refreshing = false;
let saving = false;
let generatingTriggers = false;
let triggerRequestToken = 0;
let editReopen = false;
let materialsVersion = 0;

function currentMaterials() {
  if (!state.current || state.current.meta?.id !== bookId) return [];
  return Array.isArray(state.current.materials) ? state.current.materials : [];
}

function materialById(id) {
  return currentMaterials().find((material) => material.id === id) || null;
}

function kindLabel(kind) {
  return KIND_LABELS[kind] || kind || '资料';
}

export function suggestTriggers(title) {
  const value = String(title || '').trim();
  if (!value) return [];
  const base = value.replace(SUFFIX_RE, '').trim();
  const pieces = [base, ...value.split(/[\s,，、/|:：()（）]+/)];
  return [...new Set(pieces
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && !GENERIC.has(item) && !SUFFIX_RE.test(item)))]
    .slice(0, 6);
}

function matchLocal(text) {
  const haystack = String(text || '').toLowerCase();
  if (!haystack.trim()) return [];
  const hits = [];
  for (const material of currentMaterials()) {
    if (material.enabled === false) continue;
    const candidates = (material.triggers || [])
      .map((trigger) => String(trigger || '').trim())
      .filter(Boolean)
      .filter((trigger) => haystack.includes(trigger.toLowerCase()));
    if (!candidates.length) continue;
    candidates.sort((a, b) => b.length - a.length || a.localeCompare(b));
    const trigger = candidates[0];
    hits.push({ material, trigger, at: haystack.indexOf(trigger.toLowerCase()) });
  }
  return hits.sort((a, b) => a.at - b.at);
}

function triggerHtml(trigger) {
  return `<span class="trigger-chip"><b>${escapeHtml(trigger)}</b></span>`;
}

function renderList() {
  const list = $('#material-list');
  if (!list) return;
  const materials = currentMaterials();
  const needle = search.trim().toLowerCase();
  const visible = materials.filter((material) => {
    if (kindFilter && material.kind !== kindFilter) return false;
    if (!needle) return true;
    const haystack = [
      material.title,
      material.summary,
      material.content,
      ...(material.triggers || []),
    ].join('\n').toLowerCase();
    return haystack.includes(needle);
  });

  if (!visible.length) {
    list.innerHTML = `<p class="material-empty">${materials.length ? '没有匹配的资料。' : '还没有资料。点“新建”添加一份。'}</p>`;
    return;
  }

  list.innerHTML = visible.map((material) => {
    const flags = [
      material.hard === false ? '按需读取' : '硬触发',
      material.enabled === false ? '停用' : '',
    ].filter(Boolean).join(' · ');
    return `
      <article class="material-card${material.id === selectedId ? ' on' : ''}" data-material-id="${escapeHtml(material.id)}" role="listitem">
        <div class="material-card-head">
          <span class="material-card-title">${escapeHtml(material.title)}</span>
          <span class="material-kind">${escapeHtml(kindLabel(material.kind))}</span>
          <span class="material-kind">${escapeHtml(flags)}</span>
        </div>
        <p class="material-card-summary">${escapeHtml(material.summary || '（没有摘要）')}</p>
        <div class="material-card-triggers">${(material.triggers || []).map(triggerHtml).join('')}</div>
        <div class="material-card-actions">
          <button class="btn ghost small" type="button" data-edit-material="${escapeHtml(material.id)}">编辑</button>
          <button class="btn ${selected.has(material.id) ? 'small' : 'ghost small'}" type="button" data-pick-material="${escapeHtml(material.id)}">
            ${selected.has(material.id) ? '已选' : '加入本次'}
          </button>
        </div>
      </article>
    `;
  }).join('');
}

function renderDetail() {
  const detail = $('#material-detail');
  if (!detail) return;
  const material = materialById(selectedId);
  if (!material) {
    detail.innerHTML = '<p class="material-empty">从左侧选择一份资料。资料正文不会预先放进提示词，只有模型调用 read_materials 时才会读取。</p>';
    return;
  }
  const flags = [
    material.hard === false ? '按需读取' : '硬触发',
    material.enabled === false ? '停用' : '启用',
  ].join(' · ');
  detail.innerHTML = `
    <h3>${escapeHtml(material.title)}</h3>
    <p>${escapeHtml(kindLabel(material.kind))} · ${escapeHtml(flags)}</p>
    <div class="material-card-triggers">${(material.triggers || []).map(triggerHtml).join('')}</div>
    <pre>${escapeHtml(material.content || '（正文为空）')}</pre>
    <div class="edit-actions" style="justify-content:flex-start;margin-top:12px">
      <button class="btn ghost small" type="button" data-edit-material="${escapeHtml(material.id)}">编辑</button>
      <button class="btn ghost small" type="button" data-pick-material="${escapeHtml(material.id)}">${selected.has(material.id) ? '已选' : '加入本次'}</button>
    </div>
  `;
}

function renderSelected() {
  const wrap = $('#selected-materials-wrap');
  const tray = $('#selected-materials');
  if (!wrap || !tray) return;
  const materials = currentMaterials();
  const alive = new Set(materials.map((material) => material.id));
  for (const id of [...selected]) {
    if (!alive.has(id)) selected.delete(id);
  }
  if (!selected.size) {
    wrap.hidden = true;
    tray.innerHTML = '';
    return;
  }
  wrap.hidden = false;
  tray.innerHTML = [...selected].map((id) => {
    const material = materials.find((item) => item.id === id);
    if (!material) return '';
    return `<span class="selected-chip"><b>${escapeHtml(material.title)}</b><button class="chip-x" type="button" data-remove-selected="${escapeHtml(id)}" aria-label="移除">×</button></span>`;
  }).join('');
}

function renderHits() {
  const panel = $('#material-hits');
  const list = $('#material-hit-list');
  if (!panel || !list) return;
  const instruction = $('#ai-instruction');
  const hits = matchLocal(instruction?.value || '')
    .filter((hit) => !dismissed.has(hit.material.id));
  if (!hits.length) {
    panel.hidden = true;
    list.innerHTML = '';
    return;
  }
  panel.hidden = false;
  const visible = hits.slice(0, 8);
  list.innerHTML = visible.map((hit) => `
    <div class="material-hit" data-hit-material="${escapeHtml(hit.material.id)}">
      <span><b>${escapeHtml(hit.material.title)}</b> <small>命中：${escapeHtml(hit.trigger)} · ${hit.material.hard === false ? '仅提示' : '硬触发'}</small></span>
      <button class="icon-btn" type="button" data-add-hit="${escapeHtml(hit.material.id)}" title="加入本次" aria-label="加入本次">+</button>
      <button class="icon-btn" type="button" data-dismiss-hit="${escapeHtml(hit.material.id)}" title="忽略本次命中" aria-label="忽略本次命中">×</button>
    </div>
  `).join('') + (hits.length > visible.length
    ? `<div class="material-hit-more">还有 ${hits.length - visible.length} 份命中；去资料库查看。</div>`
    : '');
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

export function syncMaterials() {
  const nextId = state.current?.meta?.id || '';
  if (nextId !== bookId) {
    bookId = nextId;
    materialsVersion += 1;
    selected.clear();
    dismissed.clear();
    selectedId = null;
    search = '';
    kindFilter = '';
    const searchInput = $('#material-search');
    if (searchInput) searchInput.value = '';
    const kindSelect = $('#material-kind-filter');
    if (kindSelect) kindSelect.value = '';
    editReopen = false;
    const library = $('#materials-dialog');
    if (library?.open) library.close();
    const edit = $('#material-edit-dialog');
    if (edit?.open) edit.close();
  }
  if (!nextId) {
    renderAll();
    return;
  }
  if (!Array.isArray(state.current.materials)) state.current.materials = [];
  const alive = new Set(currentMaterials().map((material) => material.id));
  for (const id of [...selected]) {
    if (!alive.has(id)) selected.delete(id);
  }
  for (const id of [...dismissed]) {
    if (!alive.has(id)) dismissed.delete(id);
  }
  if (selectedId && !alive.has(selectedId)) selectedId = null;
  if (!selectedId) selectedId = currentMaterials()[0]?.id || null;
  renderAll();
}

async function refreshMaterials() {
  const id = state.current?.meta?.id;
  if (!id || refreshing) return;
  const version = materialsVersion;
  refreshing = true;
  try {
    const data = await api(`/books/${encodeURIComponent(id)}/materials`);
    if (state.current?.meta.id !== id || version !== materialsVersion) return;
    state.current.materials = Array.isArray(data.materials) ? data.materials : [];
    syncMaterials();
  } catch (err) {
    toast(`读取资料失败：${err.message}`, 'error');
  } finally {
    refreshing = false;
  }
}

function setLibraryStatus(message = '', kind = 'info') {
  const status = $('#material-library-status');
  if (!status) return;
  const text = String(message || '').trim();
  status.hidden = !text;
  status.textContent = text;
  status.classList.toggle('is-error', Boolean(text) && kind === 'error');
}

function openLibrary({ status = null } = {}) {
  if (!state.current) {
    toast('先从书架选一本书', 'error');
    return;
  }
  renderAll();
  setLibraryStatus(status?.message || '', status?.kind || 'info');
  const dialog = $('#materials-dialog');
  if (dialog && !dialog.open) dialog.showModal();
  refreshMaterials();
}

function hideLibrary() {
  const dialog = $('#materials-dialog');
  if (dialog?.open) dialog.close();
}

function renderEditTriggers() {
  const chips = $('#trigger-chips');
  if (!chips) return;
  chips.innerHTML = editTriggers.map((trigger) => `
    <span class="trigger-chip"><b>${escapeHtml(trigger)}</b><button class="chip-x" type="button" data-remove-trigger="${escapeHtml(trigger)}" aria-label="删除触发词">×</button></span>
  `).join('');
}

function setEditStatus(message = '', kind = 'error') {
  const status = $('#material-edit-status');
  if (!status) return;
  const text = String(message || '').trim();
  status.hidden = !text;
  status.textContent = text;
  status.classList.toggle('is-error', Boolean(text) && kind === 'error');
}

function setTriggerBusy(busy) {
  generatingTriggers = busy;
  const button = $('#trigger-suggest');
  if (!button) return;
  button.disabled = busy;
  button.textContent = busy ? '生成中…' : '自动生成';
}

async function requestMaterialAnalysis({ title, summary, content, bookId: targetId } = {}) {
  const id = targetId || state.current?.meta?.id;
  if (!id) throw new Error('没有当前书');
  const data = await api(`/books/${encodeURIComponent(id)}/materials/analyze`, {
    method: 'POST',
    body: { title, summary, content },
  });
  return {
    summary: String(data.summary || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    triggers: Array.isArray(data.triggers) ? data.triggers : [],
  };
}

function mergeEditTriggers(list) {
  let added = 0;
  for (const trigger of Array.isArray(list) ? list : []) {
    if (addEditTrigger(trigger)) added += 1;
  }
  return added;
}

function applyMaterialAnalysis(analysis, { fillSummary = true, addTriggers = true } = {}) {
  const summaryInput = $('#material-edit-summary');
  let summaryAdded = false;
  if (fillSummary && summaryInput && !summaryInput.value.trim() && analysis.summary) {
    summaryInput.value = analysis.summary;
    summaryAdded = true;
  }
  const triggersAdded = addTriggers ? mergeEditTriggers(analysis.triggers) : 0;
  return { summaryAdded, triggersAdded };
}

async function generateTriggersFromAgent() {
  if (generatingTriggers || saving) return;
  const title = $('#material-edit-name')?.value.trim() || '';
  if (!title) {
    setEditStatus('先填标题，再生成关键词。');
    $('#material-edit-name')?.focus();
    return;
  }

  const token = ++triggerRequestToken;
  setTriggerBusy(true);
  setEditStatus('子代理正在读取标题和正文，生成摘要与关键词…', 'info');
  try {
    const analysis = await requestMaterialAnalysis({
      title,
      summary: $('#material-edit-summary')?.value.trim() || '',
      content: $('#material-edit-content')?.value || '',
    });
    if (token !== triggerRequestToken) return;
    const applied = applyMaterialAnalysis(analysis, {
      fillSummary: true,
      addTriggers: true,
    });
    let triggersAdded = applied.triggersAdded;
    let usedFallback = false;
    if (!triggersAdded) {
      triggersAdded = mergeEditTriggers(suggestTriggers(title));
      usedFallback = triggersAdded > 0;
    }
    const parts = [];
    if (applied.summaryAdded) parts.push('摘要');
    if (triggersAdded) parts.push(`${triggersAdded} 个关键词`);
    if (parts.length) {
      setEditStatus(`已生成${parts.join('、')}${usedFallback ? '（关键词来自本地候选）' : ''}。`, 'info');
    } else {
      setEditStatus('子代理没有给出新的摘要或关键词，可以手动填写。', 'info');
    }
  } catch (err) {
    if (token !== triggerRequestToken) return;
    const fallback = mergeEditTriggers(suggestTriggers(title));
    setEditStatus(
      `子代理生成失败${fallback ? `，已用本地候选加入 ${fallback} 个关键词` : ''}：${err.message}`,
      'error',
    );
  } finally {
    if (token === triggerRequestToken) setTriggerBusy(false);
  }
}

function openEdit(id = null) {
  const material = id ? materialById(id) : null;
  if (id && !material) return;
  editingId = id;
  saving = false;
  triggerRequestToken += 1;
  setTriggerBusy(false);
  editTriggers = [...(material?.triggers || [])];
  setEditStatus('');
  const title = $('#material-edit-title');
  if (title) title.textContent = id ? '编辑资料' : '新建资料';
  $('#material-edit-name').value = material?.title || '';
  $('#material-edit-kind').value = material?.kind || 'rule';
  $('#material-edit-summary').value = material?.summary || '';
  $('#material-edit-content').value = material?.content || '';
  $('#material-edit-hard').checked = material ? material.hard !== false : true;
  const del = $('#material-delete');
  if (del) del.hidden = !id;
  const save = $('#material-edit-save');
  if (save) {
    save.disabled = false;
    save.textContent = '保存';
  }
  renderEditTriggers();
  hideLibrary();
  editReopen = true;
  const dialog = $('#material-edit-dialog');
  if (dialog && !dialog.open) dialog.showModal();
  $('#material-edit-name')?.focus();
}

function closeEdit() {
  triggerRequestToken += 1;
  setTriggerBusy(false);
  const dialog = $('#material-edit-dialog');
  if (dialog?.open) dialog.close();
}

function addEditTrigger(value) {
  const trigger = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!trigger) return false;
  if (editTriggers.some((item) => item.toLowerCase() === trigger.toLowerCase())) return false;
  if (editTriggers.length >= 20) {
    toast('一份资料最多 20 个触发词', 'warn');
    return false;
  }
  editTriggers.push(trigger);
  renderEditTriggers();
  return true;
}

function upsertLocal(material) {
  if (!state.current || !material) return;
  const list = currentMaterials();
  const at = list.findIndex((item) => item.id === material.id);
  if (at >= 0) list[at] = material;
  else list.push(material);
  state.current.materials = list;
}

async function saveEdit() {
  if (saving) return;
  const book = state.current;
  if (!book) return;
  const title = $('#material-edit-name')?.value.trim() || '';
  if (!title) {
    setEditStatus('标题不能为空');
    $('#material-edit-name')?.focus();
    return;
  }
  setEditStatus('');
  const existing = editingId ? materialById(editingId) : null;
  const id = book.meta.id;
  const payload = {
    title,
    kind: $('#material-edit-kind')?.value || 'rule',
    summary: $('#material-edit-summary')?.value.trim() || '',
    content: $('#material-edit-content')?.value || '',
    triggers: [...editTriggers],
    hard: Boolean($('#material-edit-hard')?.checked),
    enabled: existing ? existing.enabled !== false : true,
  };
  let autoNote = '';
  let autoFailed = false;
  const summaryInput = $('#material-edit-summary');
  const missingSummary = !summaryInput?.value.trim();
  const missingTriggers = editTriggers.length === 0;
  let autoSummary = false;
  let autoTriggers = 0;
  let autoFallback = false;
  const autoMissing = [];

  saving = true;
  const saveButton = $('#material-edit-save');
  if (saveButton) {
    saveButton.disabled = true;
    saveButton.textContent = '保存中…';
  }

  try {
    if (missingSummary || missingTriggers) {
      const token = ++triggerRequestToken;
      setTriggerBusy(true);
      setEditStatus('正在让子代理补摘要和关键词…', 'info');
      try {
        const analysis = await requestMaterialAnalysis({
          title,
          summary: payload.summary,
          content: payload.content,
          bookId: id,
        });
        if (token === triggerRequestToken) {
          const applied = applyMaterialAnalysis(analysis, {
            fillSummary: missingSummary,
            addTriggers: missingTriggers,
          });
          autoSummary = applied.summaryAdded;
          autoTriggers = applied.triggersAdded;
          if (missingTriggers && !autoTriggers) {
            autoTriggers = mergeEditTriggers(suggestTriggers(title));
            autoFallback = autoTriggers > 0;
          }
          if (missingSummary && !autoSummary) autoMissing.push('摘要');
          if (missingTriggers && !autoTriggers) autoMissing.push('关键词');
        }
      } catch (err) {
        if (token === triggerRequestToken) {
          if (missingTriggers) {
            autoTriggers = mergeEditTriggers(suggestTriggers(title));
            autoFallback = autoTriggers > 0;
          }
          if (missingSummary) autoMissing.push('摘要');
          if (missingTriggers && !autoTriggers) autoMissing.push('关键词');
        }
      } finally {
        if (token === triggerRequestToken) {
          setTriggerBusy(false);
          payload.summary = summaryInput?.value.trim() || payload.summary;
          payload.triggers = [...editTriggers];
        }
      }

      const generatedParts = [];
      if (autoSummary) generatedParts.push('摘要');
      if (autoTriggers) generatedParts.push(`${autoTriggers} 个关键词`);
      if (generatedParts.length) {
        autoNote = `已自动生成${generatedParts.join('、')}${autoFallback ? '（关键词来自本地候选）' : ''}`;
      }
      if (autoMissing.length) {
        autoNote = `${autoNote ? `${autoNote}；` : ''}${autoMissing.join('、')}没有生成`;
        autoFailed = true;
      }
    }

    setEditStatus('正在保存…', 'info');
    const data = editingId
      ? await api(`/books/${encodeURIComponent(id)}/materials/${encodeURIComponent(editingId)}`, {
        method: 'PUT',
        body: { material: payload },
      })
      : await api(`/books/${encodeURIComponent(id)}/materials`, {
        method: 'POST',
        body: { material: payload },
      });
    if (state.current?.meta.id !== id) return;
    if (!data.material) throw new Error('服务端没有返回资料');
    materialsVersion += 1;
    upsertLocal(data.material);
    selectedId = data.material.id;
    editReopen = false;
    closeEdit();
    const baseText = editingId ? '资料已保存' : '资料已新建';
    openLibrary({
      status: {
        message: autoNote ? `${baseText}，${autoNote}。` : `${baseText}。`,
        kind: autoFailed ? 'error' : 'info',
      },
    });
    toast(editingId ? '资料已保存' : '资料已新建');
  } catch (err) {
    const message = err.message || '保存资料失败';
    setEditStatus(`保存失败：${message}`);
    toast(message, 'error');
  } finally {
    saving = false;
    if (saveButton) {
      saveButton.disabled = false;
      saveButton.textContent = '保存';
    }
  }
}

async function deleteEdit() {
  if (saving || !editingId) return;
  const material = materialById(editingId);
  if (!material) return;
  const ok = await confirmDialog({
    title: '删除资料',
    text: `删除「${material.title}」？正文不会被改。`,
    okLabel: '删除',
  });
  if (!ok) return;
  const id = state.current?.meta.id;
  if (!id) return;
  saving = true;
  setEditStatus('删除中…', 'info');
  const deleteButton = $('#material-delete');
  if (deleteButton) deleteButton.disabled = true;
  try {
    await api(`/books/${encodeURIComponent(id)}/materials/${encodeURIComponent(material.id)}`, {
      method: 'DELETE',
    });
    if (state.current?.meta.id !== id) return;
    materialsVersion += 1;
    state.current.materials = currentMaterials().filter((item) => item.id !== material.id);
    selected.delete(material.id);
    dismissed.delete(material.id);
    selectedId = null;
    editReopen = false;
    closeEdit();
    openLibrary();
    toast('资料已删除');
  } catch (err) {
    const message = err.message || '删除资料失败';
    setEditStatus(`删除失败：${message}`);
    toast(message, 'error');
  } finally {
    saving = false;
    if (deleteButton) deleteButton.disabled = false;
  }
}

export function selectedMaterialIds() {
  const alive = new Set(currentMaterials()
    .filter((material) => material.enabled !== false)
    .map((material) => material.id));
  return [...selected].filter((id) => alive.has(id));
}

export function dismissedMaterialIds() {
  return [...dismissed];
}

export function wireMaterialsEvents() {
  $('#materials-btn')?.addEventListener('click', openLibrary);
  $('#material-done')?.addEventListener('click', hideLibrary);
  $('#material-new')?.addEventListener('click', () => openEdit(null));
  $('#material-edit-cancel')?.addEventListener('click', () => {
    editReopen = true;
    closeEdit();
  });
  $('#material-edit-save')?.addEventListener('click', saveEdit);
  $('#material-delete')?.addEventListener('click', deleteEdit);

  $('#material-edit-dialog')?.addEventListener('close', () => {
    const reopen = editReopen;
    editReopen = false;
    if (reopen) openLibrary();
  });

  $('#material-list')?.addEventListener('click', (event) => {
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
      if (selected.has(pick.dataset.pickMaterial)) selected.delete(pick.dataset.pickMaterial);
      else {
        selected.add(pick.dataset.pickMaterial);
        dismissed.delete(pick.dataset.pickMaterial);
      }
      renderAll();
      return;
    }
    selectedId = id;
    renderList();
    renderDetail();
  });

  $('#material-detail')?.addEventListener('click', (event) => {
    const edit = event.target.closest('[data-edit-material]');
    const pick = event.target.closest('[data-pick-material]');
    if (edit) openEdit(edit.dataset.editMaterial);
    if (pick) {
      if (selected.has(pick.dataset.pickMaterial)) selected.delete(pick.dataset.pickMaterial);
      else {
        selected.add(pick.dataset.pickMaterial);
        dismissed.delete(pick.dataset.pickMaterial);
      }
      renderAll();
    }
  });

  $('#material-search')?.addEventListener('input', (event) => {
    search = event.target.value;
    renderList();
  });

  $('#material-kind-filter')?.addEventListener('change', (event) => {
    kindFilter = event.target.value;
    renderList();
  });

  $('#ai-instruction')?.addEventListener('input', () => {
    dismissed.clear();
    scheduleHits();
  });

  $('#material-hit-list')?.addEventListener('click', (event) => {
    const add = event.target.closest('[data-add-hit]');
    const dismiss = event.target.closest('[data-dismiss-hit]');
    if (add) {
      selected.add(add.dataset.addHit);
      dismissed.delete(add.dataset.addHit);
      renderAll();
    }
    if (dismiss) {
      dismissed.add(dismiss.dataset.dismissHit);
      selected.delete(dismiss.dataset.dismissHit);
      renderHits();
      renderSelected();
    }
  });

  $('#selected-materials')?.addEventListener('click', (event) => {
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
    if (addEditTrigger(input?.value)) input.value = '';
    input?.focus();
  });

  $('#trigger-input')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const input = event.target;
    if (addEditTrigger(input.value)) input.value = '';
  });

  $('#trigger-suggest')?.addEventListener('click', () => {
    generateTriggersFromAgent();
  });
}
