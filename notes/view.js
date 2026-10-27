// Note e to-do: nella sidebar lo spazio "Generale" e i progetti (con le voci aperte), nel
// pannello le liste da spuntare e le note tipo post-it della bacheca scelta. Tutto passa dal
// vault della master password: bloccato, la sezione mostra solo "Sblocca".

const EXT = 'Ext.notes';
const GENERAL = '@general';
const COLORS = ['yellow', 'green', 'blue', 'pink', 'purple', 'gray'];
const ACTIVE_KEY = 'kelbo.notes.board';
const SAVE_DELAY = 700; // ms dopo l'ultimo tasto prima di salvare una nota

export default {
  async mount(ctx) {
    const { esc, js, toast, fmt } = ctx.ui;
    const { t } = ctx;
    const $ = (root, role) => root.querySelector(`[data-role="${role}"]`);

    let locked = false;
    let info = new Map();     // bacheca → { open, items, lists, notes }
    let projects = [], folders = [];
    let active = (() => { try { return localStorage.getItem(ACTIVE_KEY) || GENERAL; } catch { return GENERAL; } })();
    let board = null;         // { board, lists, notes, counts }
    const pending = new Map(); // nota → timer del salvataggio
    let dragging = null;       // { list, item } durante il trascinamento

    const url = (...parts) => `/boards/${parts.map(encodeURIComponent).join('/')}`;
    const boardLabel = id => (id === GENERAL ? t('sidebar.general') : projects.find(p => p.id === id)?.label || id);

    // Esegue fn; con il vault bloccato (o da creare) lo chiede e riprova
    async function withVault(fn) {
      try { return await fn(); } catch (e) {
        if (!ctx.vault.isVaultError(e)) throw e;
        if (await ctx.vault.ensure()) return fn();
        throw Object.assign(new Error(t('locked.still')), { handled: true });
      }
    }
    const fail = e => { if (!e?.handled) toast(e.message, 'error'); };

    // ---- caricamento ----

    async function load() {
      try { ({ projects, folders } = await ctx.projects.load()); } catch { projects = []; folders = []; }
      try {
        const r = await ctx.api.get('/boards');
        info = new Map(r.boards.map(b => [b.board, b.counts]));
        locked = false;
      } catch (e) {
        if (!ctx.vault.isVaultError(e)) toast(e.message, 'error');
        locked = ctx.vault.isVaultError(e);
        info = new Map();
      }
      if (active !== GENERAL && !projects.some(p => p.id === active) && !info.has(active)) active = GENERAL;
      updateBadge();
      renderSidebar();
      if (locked) { board = null; renderBoard(); return; }
      await loadBoard();
    }

    async function loadBoard() {
      try { board = await ctx.api.get(url(active)); } catch (e) { board = null; if (ctx.vault.isVaultError(e)) locked = true; else fail(e); }
      renderBoard();
    }

    function updateBadge() {
      const open = [...info.values()].reduce((n, c) => n + c.open, 0);
      ctx.setBadge(open ? fmt.number(open) : null);
    }

    // Risposta di una modifica: bacheca e contatori aggiornati
    function applied(r) {
      board = r;
      if (r.counts.lists || r.counts.notes) info.set(r.board, r.counts); else info.delete(r.board);
      updateBadge();
      renderSidebar();
      renderSummary();
    }

    // Modifica della bacheca: fn(api) → bacheca aggiornata (null se non riuscita)
    async function call(fn) {
      try { const r = await withVault(() => fn(ctx.api)); applied(r); return r; } catch (e) { fail(e); return null; }
    }

    // ---- sidebar ----

    function renderSidebar() {
      const el = $(ctx.sidebar, 'boards');
      if (locked) {
        ctx.ui.patch(el, `<p class="nt-muted" style="padding:12px">${esc(t('locked.text'))}<br><br>
          <button class="btn btn-primary btn-sm" onclick="${EXT}.unlock()">${esc(t('locked.unlock'))}</button></p>`);
        return;
      }
      const item = (id, icon, label) => {
        const open = info.get(id)?.open || 0;
        return `<button class="sb-item ${id === active ? 'active' : ''}" onclick="${EXT}.select(${js(id)})">
          <span class="sb-icon">${icon}</span><span>${esc(label)}</span>
          ${open ? `<span class="sb-count nt-open" title="${esc(t('sidebar.openTitle', { count: open }))}">${esc(fmt.number(open))}</span>` : ''}</button>`;
      };
      const orphans = [...info.keys()].filter(id => id !== GENERAL && !projects.some(p => p.id === id));
      ctx.ui.patch(el, item(GENERAL, '📌', t('sidebar.general'))
        + ctx.projects.tree(folders, projects, p => item(p.id, info.has(p.id) ? '📝' : '·', p.label))
        + (orphans.length ? `<div class="nt-sb-sep">${esc(t('sidebar.orphans'))}</div>${orphans.map(id => item(id, '⚠', id)).join('')}` : ''));
    }

    // ---- bacheca ----

    function renderSummary() {
      if (!board) return;
      const c = board.counts;
      $(ctx.root, 'summary').textContent = c.items || c.notes ? t('board.summary', { open: fmt.number(c.open), items: fmt.number(c.items), notes: fmt.number(c.notes) }) : '';
    }

    function renderBoard() {
      $(ctx.root, 'locked').hidden = !locked;
      $(ctx.root, 'board').hidden = locked || !board;
      if (locked || !board) return;
      $(ctx.root, 'title').textContent = boardLabel(board.board);
      renderSummary();
      renderLists();
      renderNotes();
    }

    function renderLists() {
      const el = $(ctx.root, 'lists');
      const focus = document.activeElement?.dataset?.add; // il campo "aggiungi" resta attivo dopo l'invio
      el.innerHTML = board.lists.length ? board.lists.map(listHtml).join('') : `<p class="nt-empty">${esc(t('lists.none'))}</p>`;
      if (focus) el.querySelector(`[data-add="${CSS.escape(focus)}"]`)?.focus();
    }

    function listHtml(l) {
      const open = l.items.filter(i => !i.done), done = l.items.filter(i => i.done);
      const itemHtml = i => `<li class="nt-item ${i.done ? 'done' : ''}" data-list="${esc(l.id)}" data-item="${esc(i.id)}">
          ${i.done ? '' : `<span class="nt-handle" title="${esc(t('items.drag'))}">⋮⋮</span>`}
          <input type="checkbox" ${i.done ? 'checked' : ''} aria-label="${esc(t(i.done ? 'items.reopen' : 'items.check'))}" data-check>
          <input class="nt-item-text" value="${esc(i.text)}" maxlength="1000" data-text aria-label="${esc(t('items.text'))}">
          ${i.done && i.doneAt ? `<span class="nt-item-date" title="${esc(fmt.date(i.doneAt, { dateStyle: 'medium', timeStyle: 'short' }))}">${esc(fmt.relative(i.doneAt))}</span>` : ''}
          <button class="nt-del" data-del-item title="${esc(t('core.action.delete'))}">✕</button></li>`;
      return `<section class="nt-list" data-list="${esc(l.id)}">
        <div class="nt-list-head">
          <input class="nt-list-title" value="${esc(l.title)}" maxlength="200" data-list-title aria-label="${esc(t('lists.name'))}">
          <span class="sb-count">${esc(fmt.number(open.length))}</span>
          <button class="sb-item-act" onclick="${EXT}.listMenu(event, ${js(l.id)})" title="${esc(t('lists.actions'))}">⋯</button>
        </div>
        <ul class="nt-items">${open.map(itemHtml).join('')}</ul>
        ${done.length ? `<div class="nt-done-head"><span>${esc(t('items.doneCount', { count: done.length }))}</span>
          <button onclick="${EXT}.clearDone(${js(l.id)})">${esc(t('items.clearDone'))}</button></div>
          <ul class="nt-items">${done.map(itemHtml).join('')}</ul>` : ''}
        <input class="form-input nt-add" data-add="${esc(l.id)}" maxlength="1000" placeholder="${esc(t('items.add'))}" aria-label="${esc(t('items.add'))}">
      </section>`;
    }

    function renderNotes() {
      flushNotes();
      const el = $(ctx.root, 'notes');
      el.innerHTML = board.notes.length ? board.notes.map(n => `<div class="nt-note nt-c-${esc(n.color)}" data-note="${esc(n.id)}">
          <textarea maxlength="10000" placeholder="${esc(t('notes.placeholder'))}" aria-label="${esc(t('notes.text'))}" data-note-text>${esc(n.text)}</textarea>
          <footer>
            ${COLORS.map(c => `<button class="nt-dot nt-c-${c} ${c === n.color ? 'active' : ''}" data-color="${c}" title="${esc(t(`colors.${c}`))}" aria-label="${esc(t(`colors.${c}`))}"></button>`).join('')}
            <span class="nt-saved" data-saved>${n.updatedAt ? esc(fmt.relative(n.updatedAt)) : ''}</span>
            <button class="nt-del" data-del-note title="${esc(t('core.action.delete'))}">✕</button>
          </footer></div>`).join('') : `<p class="nt-empty">${esc(t('notes.none'))}</p>`;
      for (const ta of el.querySelectorAll('textarea')) grow(ta);
    }

    const grow = ta => { ta.style.height = 'auto'; ta.style.height = `${Math.max(110, ta.scrollHeight)}px`; };

    // ---- note: salvataggio automatico ----

    function scheduleNote(id) {
      clearTimeout(pending.get(id));
      const el = ctx.root.querySelector(`[data-note="${CSS.escape(id)}"] [data-saved]`);
      if (el) el.textContent = t('notes.saving');
      pending.set(id, setTimeout(() => saveNote(id), SAVE_DELAY));
    }

    async function saveNote(id) {
      clearTimeout(pending.get(id));
      pending.delete(id);
      const note = board?.notes.find(n => n.id === id);
      const ta = ctx.root.querySelector(`[data-note="${CSS.escape(id)}"] textarea`);
      if (!note || !ta) return;
      const boardId = board.board;
      try {
        const r = await withVault(() => ctx.api.put(url(boardId, 'notes', id), { text: ta.value, updatedAt: note.updatedAt }));
        if (board?.board !== boardId) return;
        // le note restano come sono (si sta scrivendo): si aggiornano dati, contatori e "salvata"
        board.notes = r.notes; board.counts = r.counts;
        info.set(r.board, r.counts);
        renderSummary();
        const saved = ctx.root.querySelector(`[data-note="${CSS.escape(id)}"] [data-saved]`);
        if (saved) saved.textContent = t('notes.saved');
      } catch (e) {
        if (e.status === 409) { toast(t('notes.changedElsewhere'), 'error'); await loadBoard(); return; }
        fail(e);
      }
    }

    // Salvataggi in attesa eseguiti subito (prima di ridisegnare le note o cambiare bacheca)
    function flushNotes() { for (const id of [...pending.keys()]) saveNote(id); }

    // ---- azioni ----

    const actions = {
      async select(id) {
        if (id === active && board) return;
        flushNotes();
        active = id;
        try { localStorage.setItem(ACTIVE_KEY, id); } catch { /* solo in questa sessione */ }
        renderSidebar();
        await loadBoard();
      },
      async unlock() { if (await ctx.vault.ensure()) load(); },
      async addList() {
        const r = await call(api => api.post(url(active, 'lists'), { title: t('lists.newTitle') }));
        if (!r) return;
        renderLists();
        const input = ctx.root.querySelector(`[data-list="${CSS.escape(r.lists.at(-1).id)}"] [data-list-title]`);
        input?.focus(); input?.select();
      },
      async addNote() {
        flushNotes();
        const r = await call(api => api.post(url(active, 'notes'), { text: '' }));
        if (!r) return;
        renderNotes();
        ctx.root.querySelector(`[data-note="${CSS.escape(r.notes[0].id)}"] textarea`)?.focus();
      },
      listMenu(event, listId) {
        const i = board.lists.findIndex(l => l.id === listId);
        const l = board.lists[i];
        const move = to => {
          const ids = board.lists.map(x => x.id);
          ids.splice(to, 0, ids.splice(i, 1)[0]);
          call(api => api.put(url(active, 'lists', 'order'), { ids })).then(r => r && renderLists());
        };
        event.stopPropagation();
        const r = event.currentTarget.getBoundingClientRect();
        ctx.ui.contextMenu(r.left, r.bottom, [
          { label: t('lists.moveBefore'), icon: '◀', disabled: i === 0, action: () => move(i - 1) },
          { label: t('lists.moveAfter'), icon: '▶', disabled: i === board.lists.length - 1, action: () => move(i + 1) },
          { label: t('items.clearDone'), icon: '✓', disabled: !l.items.some(x => x.done), action: () => actions.clearDone(listId) },
          'separator',
          { label: t('lists.delete'), icon: '🗑', danger: true, action: () => {
            if (l.items.length && !confirm(t('lists.confirmDelete', { name: l.title, count: l.items.length }))) return;
            call(api => api.del(url(active, 'lists', listId))).then(res => res && renderLists());
          } },
        ]);
      },
      async clearDone(listId) {
        if (await call(api => api.post(url(active, 'lists', listId, 'clear-done')))) renderLists();
      },
    };
    ctx.expose(actions);

    // ---- eventi ----

    ctx.sidebar.addEventListener('click', e => { if (e.target.closest('[data-action="reload"]')) load(); });

    ctx.root.addEventListener('click', e => {
      const a = e.target.closest('[data-action]')?.dataset.action;
      if (a === 'unlock') return actions.unlock();
      if (a === 'add-list') return actions.addList();
      if (a === 'add-note') return actions.addNote();
      const li = e.target.closest('[data-item]');
      if (li && e.target.closest('[data-del-item]')) {
        call(api => api.del(url(active, 'lists', li.dataset.list, 'items', li.dataset.item))).then(r => r && renderLists());
        return;
      }
      const note = e.target.closest('[data-note]');
      if (!note) return;
      const color = e.target.closest('[data-color]')?.dataset.color;
      if (color) {
        clearTimeout(pending.get(note.dataset.note)); pending.delete(note.dataset.note);
        const text = note.querySelector('textarea').value;
        const n = board.notes.find(x => x.id === note.dataset.note);
        call(api => api.put(url(active, 'notes', n.id), { color, text, updatedAt: n.updatedAt })).then(r => r && renderNotes());
      } else if (e.target.closest('[data-del-note]')) {
        const text = note.querySelector('textarea').value;
        if (text.trim() && !confirm(t('notes.confirmDelete'))) return;
        clearTimeout(pending.get(note.dataset.note)); pending.delete(note.dataset.note);
        call(api => api.del(url(active, 'notes', note.dataset.note))).then(r => r && renderNotes());
      }
    });

    ctx.root.addEventListener('change', e => {
      const el = e.target;
      const li = el.closest('[data-item]');
      if (li && el.matches('[data-check]')) {
        call(api => api.put(url(active, 'lists', li.dataset.list, 'items', li.dataset.item), { done: el.checked })).then(r => r && renderLists());
      } else if (li && el.matches('[data-text]')) {
        if (!el.value.trim()) { el.value = board.lists.find(l => l.id === li.dataset.list)?.items.find(i => i.id === li.dataset.item)?.text || ''; return; }
        call(api => api.put(url(active, 'lists', li.dataset.list, 'items', li.dataset.item), { text: el.value }));
      } else if (el.matches('[data-list-title]')) {
        const listId = el.closest('[data-list]').dataset.list;
        if (!el.value.trim()) { el.value = board.lists.find(l => l.id === listId)?.title || ''; return; }
        call(api => api.put(url(active, 'lists', listId), { title: el.value }));
      }
    });

    ctx.root.addEventListener('keydown', e => {
      const el = e.target;
      if (e.key === 'Enter' && el.matches('[data-add]')) {
        e.preventDefault();
        const text = el.value.trim();
        if (!text) return;
        el.value = '';
        call(api => api.post(url(active, 'lists', el.dataset.add, 'items'), { text })).then(r => r && renderLists());
      } else if (e.key === 'Enter' && el.matches('[data-text], [data-list-title]')) {
        e.preventDefault();
        el.blur(); // salva con "change"
      } else if (e.key === 'Escape' && el.matches('[data-text], [data-list-title]')) {
        el.value = el.defaultValue;
        el.blur();
      }
    });

    ctx.root.addEventListener('input', e => {
      if (!e.target.matches('[data-note-text]')) return;
      grow(e.target);
      scheduleNote(e.target.closest('[data-note]').dataset.note);
    });

    // ---- trascinamento delle voci aperte (dalla maniglia ⋮⋮), nella stessa lista ----

    ctx.root.addEventListener('pointerdown', e => {
      const li = e.target.closest('.nt-handle') && e.target.closest('[data-item]');
      if (li) li.draggable = true;
    });
    ctx.root.addEventListener('dragstart', e => {
      const li = e.target.closest?.('[data-item]');
      if (!li?.draggable) return;
      dragging = { list: li.dataset.list, el: li };
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', li.dataset.item);
    });
    ctx.root.addEventListener('dragover', e => {
      const li = e.target.closest?.('[data-item]');
      if (!dragging || !li || li === dragging.el || li.dataset.list !== dragging.list || li.classList.contains('done')) return;
      e.preventDefault();
      const r = li.getBoundingClientRect();
      li.parentElement.insertBefore(dragging.el, e.clientY > r.top + r.height / 2 ? li.nextSibling : li);
    });
    ctx.root.addEventListener('dragend', () => {
      if (!dragging) return;
      const { list, el } = dragging;
      dragging = null;
      el.classList.remove('dragging');
      el.draggable = false;
      const l = board.lists.find(x => x.id === list);
      const openIds = [...el.parentElement.querySelectorAll('[data-item]')].map(x => x.dataset.item);
      const ids = [...openIds, ...l.items.filter(i => i.done).map(i => i.id)];
      if (ids.join() === l.items.map(i => i.id).join()) return;
      call(api => api.put(url(active, 'lists', list, 'items', 'order'), { ids })).then(r => r && renderLists());
    });

    ctx.bus.on('core:projects-changed', load);
    window.addEventListener('beforeunload', flushNotes);
    await load();

    this.refresh = load;
    this.show = () => load(); // il vault può essere stato sbloccato (o bloccato) da un'altra sezione
    this.hide = flushNotes;
    this.languageChanged = () => { renderSidebar(); renderBoard(); };
  },
};
