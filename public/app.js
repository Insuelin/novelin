import { state } from './core/state.js';
import { $, $$ } from './core/dom.js';
import { api } from './core/api.js';
import { aiLog, renderLog } from './core/logger.js';
import { toast } from './ui/toast.js';
import { closeDropdowns, settleConfirm, applyAccent, loadAccent, tickClock } from './ui/primitives.js';
import { bus } from './core/bus.js';
import { closeChapterMenu, checkSelection } from './features/manuscript.js';
import { runAi, stopAi } from './features/ai-agent.js';
import { loadBooks, renderLibrary, wireLibraryEvents } from './features/library.js';
import {
  renderWorkspace,
  flushBriefingDialog,
  wireWorkspaceEvents,
} from './features/workspace.js';
import { flushSave, saveAll } from './features/persistence.js';

/* ---------- views ---------- */
function showView(name) {
  if (name === 'workspace' && !state.current) name = 'library';
  state.view = name;
  $('#view-library').classList.toggle('active', name === 'library');
  $('#view-workspace').classList.toggle('active', name === 'workspace');
  $$('[data-nav]').forEach((button) => {
    button.classList.toggle('active', button.dataset.nav === name);
  });
  const workspaceButton = $('[data-nav="workspace"]');
  if (workspaceButton) workspaceButton.classList.toggle('disabled', !state.current);
  if (name === 'library') {
    closeChapterMenu();
    renderLibrary();
  }
  window.scrollTo(0, 0);
}

async function route() {
  const hash = location.hash || '#/library';
  if (hash.startsWith('#/book/')) {
    const id = decodeURIComponent(hash.slice(7));
    if (!id) {
      location.hash = '#/library';
      return;
    }
    if (!state.current || state.current.meta.id !== id) {
      await openBook(id);
    } else {
      showView('workspace');
    }
  } else {
    await flushSave();
    showView('library');
  }
}

async function openBook(id) {
  if (state.aiRunning) stopAi({ silent: true });
  if (state.current && state.current.meta.id !== id) await flushSave();
  try {
    const { book } = await api(`/books/${encodeURIComponent(id)}`);
    state.current = book;
    state.dirty.clear();
    renderWorkspace();
    showView('workspace');
    if (location.hash !== `#/book/${id}`) location.hash = `#/book/${id}`;
  } catch (err) {
    toast(err.message, 'error');
    state.current = null;
    if (location.hash !== '#/library') location.hash = '#/library';
    else showView('library');
  }
}

async function openBookById(id) {
  if (state.current?.meta.id === id) {
    await openBook(id);
    return;
  }
  location.hash = `#/book/${id}`;
}

/* ---------- events ---------- */
function wireEvents() {
  bus.on('ai:run', (payload = {}) => runAi(payload));
  bus.on('book:open', ({ id } = {}) => {
    if (id) openBookById(id);
  });

  $$('[data-accent-btn]').forEach((button) => {
    button.addEventListener('click', () => applyAccent(button.dataset.accentBtn));
  });

  $$('[data-nav]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (button.dataset.nav === 'library') {
        await flushSave();
        location.hash = '#/library';
        return;
      }
      if (!state.current) {
        toast('先从书架选一本书', 'error');
        return;
      }
      await flushSave();
      location.hash = `#/book/${state.current.meta.id}`;
    });
  });

  const LOG_LEVELS = ['info', 'warn', 'error'];
  $('#log-level')?.addEventListener('click', () => {
    const index = LOG_LEVELS.indexOf(state.logLevel);
    state.logLevel = LOG_LEVELS[(index + 1) % LOG_LEVELS.length];
    renderLog(true);
  });
  renderLog(true);
  window.addEventListener('error', (event) => {
    aiLog('ERR', event.message || '页面脚本错误', 'err');
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    aiLog('ERR', String(reason?.message || reason || '未处理的 Promise 错误'), 'err');
  });

  document.addEventListener('click', () => closeDropdowns());
  document.addEventListener('click', (event) => {
    const closeButton = event.target.closest('[data-close-dialog]');
    if (closeButton) {
      document.getElementById(closeButton.dataset.closeDialog)?.close();
    }
    if (!event.target.closest('#chapter-nav')) closeChapterMenu();
  });

  $('#confirm-ok').addEventListener('click', () => settleConfirm(true));
  $('#confirm-cancel').addEventListener('click', () => settleConfirm(false));
  $('#confirm-dialog').addEventListener('cancel', (event) => {
    event.preventDefault();
    settleConfirm(false);
  });

  window.addEventListener('hashchange', route);
  document.addEventListener('selectionchange', checkSelection);

  window.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if ($('#briefing-dialog')?.open) {
        flushBriefingDialog();
        return;
      }
      if (state.view === 'workspace') saveAll({ notify: true });
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (state.view === 'library') $('#search-input').focus();
    }
    if (event.key === 'Escape') {
      closeChapterMenu();
      closeDropdowns();
    }
  });

  window.addEventListener('beforeunload', (event) => {
    if (state.dirty.size) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());

  wireLibraryEvents();
  wireWorkspaceEvents();
}

/* ---------- boot ---------- */
loadAccent();
wireEvents();
tickClock();
setInterval(tickClock, 15000);
loadBooks().then(route);
