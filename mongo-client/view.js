// MongoDB: albero connessione ▸ database ▸ collezioni nella sidebar, documenti della collezione
// aperta con filtro, ordinamento, proiezione e pagine. Ogni modifica passa da un'anteprima
// dell'operazione (sintassi di mongosh) che l'utente conferma.

const EXT = "Ext['mongo-client']";

// Valori Extended JSON con un solo campo "$…" mostrati come in mongosh
function special(v) {
  const keys = Object.keys(v);
  if (keys.length !== 1 && !(keys.length === 2 && '$binary' in v)) return null;
  const [k] = keys, x = v[k];
  if (k === '$oid' && typeof x === 'string') return `ObjectId("${x}")`;
  if (k === '$date') return `ISODate("${typeof x === 'string' ? x : x?.$numberLong ?? JSON.stringify(x)}")`;
  if (k === '$numberDecimal') return `NumberDecimal("${x}")`;
  if (k === '$numberLong') return `NumberLong("${x}")`;
  if (k === '$numberDouble') return x;
  if (k === '$binary') return `BinData(${x?.subType ?? '?'}, "${String(x?.base64 ?? '').slice(0, 24)}${String(x?.base64 ?? '').length > 24 ? '…' : ''}")`;
  if (k === '$uuid') return `UUID("${x}")`;
  if (k === '$regularExpression') return `/${x?.pattern}/${x?.options || ''}`;
  if (k === '$timestamp') return `Timestamp(${x?.t}, ${x?.i})`;
  if (k === '$minKey') return 'MinKey()';
  if (k === '$maxKey') return 'MaxKey()';
  return null;
}

// Documento (Extended JSON relaxed) → HTML con colori, rientrato
function renderValue(v, esc, indent = '') {
  if (v === null) return '<span class="mg-null">null</span>';
  if (typeof v === 'string') return `<span class="mg-s">${esc(JSON.stringify(v))}</span>`;
  if (typeof v === 'number') return `<span class="mg-n">${esc(String(v))}</span>`;
  if (typeof v === 'boolean') return `<span class="mg-b">${v}</span>`;
  const inner = indent + '  ';
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    // valori semplici su una riga
    if (v.length <= 12 && v.every(x => x === null || typeof x !== 'object')) return `[ ${v.map(x => renderValue(x, esc)).join(', ')} ]`;
    return `[\n${v.map(x => inner + renderValue(x, esc, inner)).join(',\n')}\n${indent}]`;
  }
  if (typeof v === 'object') {
    const s = special(v);
    if (s !== null) return `<span class="mg-t">${esc(s)}</span>`;
    const entries = Object.entries(v);
    if (!entries.length) return '{}';
    return `{\n${entries.map(([k, x]) => `${inner}<span class="mg-k">${esc(k)}</span>: ${renderValue(x, esc, inner)}`).join(',\n')}\n${indent}}`;
  }
  return esc(String(v));
}

const idText = id => (id && typeof id === 'object' ? special(id) ?? JSON.stringify(id) : JSON.stringify(id));

export default {
  async mount(ctx) {
    const { esc, js, toast, openModal, closeModal, fmt } = ctx.ui;
    const { t } = ctx;
    const $ = (root, role) => root.querySelector(`[data-role="${role}"]`);
    const byId = id => document.getElementById(id);

    let connections = [];
    let tunnelsAvailable = false;
    let pageSizes = [10, 25, 50, 100, 250];
    const open = new Set();   // nodi aperti dell'albero: "c|conn", "d|conn|db"
    const cache = new Map();  // stesse chiavi → { loading } | { error } | lista
    let current = null;       // { conn, db, coll }
    let query = { filter: '', sort: '', projection: '', limit: 25, skip: 0 };
    let result = null;        // ultima risposta di find
    let selected = new Set(); // indici dei documenti selezionati nella pagina
    let loading = false;

    const conn = id => connections.find(c => c.id === id) || null;
    const base = id => `/connections/${encodeURIComponent(id)}`;
    const collPath = (id, db, coll) => `${base(id)}/databases/${encodeURIComponent(db)}/collections/${encodeURIComponent(coll)}`;

    // Esegue fn; se il vault della master password è bloccato (o da creare) lo chiede e riprova
    async function withVault(fn) {
      try { return await fn(); } catch (e) {
        if (!ctx.vault.isVaultError(e)) throw e;
        if (await ctx.vault.ensure()) return fn();
        throw Object.assign(new Error(t('vault.stillLocked')), { handled: true });
      }
    }
    const fail = e => { if (!e?.handled || e.message) toast(e.message, 'error'); };

    // ---- connessioni e albero ----

    async function load() {
      try {
        const r = await ctx.api.get('/connections');
        connections = r.connections;
        tunnelsAvailable = r.tunnelsAvailable;
        pageSizes = r.pageSizes || pageSizes;
      } catch (e) { toast(e.message, 'error'); connections = []; }
      for (const k of [...open]) if (!conn(k.split('|')[1])) open.delete(k);
      if (current && !conn(current.conn)) current = null;
      renderTree();
      renderMain();
    }

    async function fetchNode(key) {
      const [kind, id, db] = key.split('|');
      cache.set(key, { loading: true });
      renderTree();
      try {
        const list = kind === 'c'
          ? (await withVault(() => ctx.api.get(`${base(id)}/databases`))).databases
          : (await withVault(() => ctx.api.get(`${base(id)}/databases/${encodeURIComponent(db)}/collections`))).collections;
        cache.set(key, list);
      } catch (e) {
        cache.set(key, { error: e.message });
      }
      renderTree();
    }

    const chevron = isOpen => `<svg class="pf-chevron ${isOpen ? 'open' : ''}" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 1.5 7 5 3.5 8.5" /></svg>`;

    function childrenHtml(key, depth, renderItem) {
      const node = cache.get(key);
      const pad = `style="padding-inline-start:${12 + depth * 14}px"`;
      if (!node || node.loading) return `<div class="mg-tree-note" ${pad}>${esc(t('tree.loading'))}</div>`;
      if (node.error) return `<div class="mg-tree-note mg-danger" ${pad}>${esc(node.error)}</div>`;
      if (!node.length) return `<div class="mg-tree-note" ${pad}>${esc(t('tree.none'))}</div>`;
      return node.map(renderItem).join('');
    }

    function renderTree() {
      const el = $(ctx.sidebar, 'tree');
      if (!connections.length) { el.innerHTML = `<p class="mg-muted mg-pad">${esc(t('sidebar.none'))}</p>`; return; }
      el.innerHTML = connections.map(c => {
        const ck = `c|${c.id}`, cOpen = open.has(ck);
        const where = c.uri ? t('tree.viaUri') : c.tunnel ? t('tree.viaTunnel', { tunnel: c.tunnel }) : `${c.host}:${c.port}`;
        return `<div class="sb-item mg-row mg-row-conn" role="button" tabindex="0" aria-expanded="${cOpen}" title="${esc(where)}"
            onclick="${EXT}.toggle(${js(ck)})" oncontextmenu="event.preventDefault();${EXT}.connMenu(event,${js(c.id)})">
            ${chevron(cOpen)}<span class="mg-icon">🍃</span><span class="mg-name">${esc(c.label)}</span>
            ${c.readOnly ? `<span class="mg-lock" title="${esc(t('main.readOnlyTitle'))}">🔒</span>` : ''}
            ${c.tunnelMissing ? `<span class="mg-warn" title="${esc(t('tree.tunnelMissing', { tunnel: c.tunnel }))}">⚠</span>` : ''}
            <button class="mg-more" onclick="event.stopPropagation();${EXT}.connMenu(event,${js(c.id)})" aria-label="${esc(t('tree.actions'))}">⋯</button>
          </div>
          ${cOpen ? childrenHtml(ck, 1, d => {
            const dk = `d|${c.id}|${d.name}`, dOpen = open.has(dk);
            return `<div class="sb-item mg-row" style="padding-inline-start:26px" role="button" tabindex="0" aria-expanded="${dOpen}"
                onclick="${EXT}.toggle(${js(dk)})" oncontextmenu="event.preventDefault();${EXT}.dbMenu(event,${js(c.id)},${js(d.name)})">
                ${chevron(dOpen)}<span class="mg-icon">🗄️</span><span class="mg-name">${esc(d.name)}</span>
                ${d.sizeOnDisk != null ? `<span class="mg-count">${esc(fmt.bytes(d.sizeOnDisk))}</span>` : ''}
              </div>
              ${dOpen ? childrenHtml(dk, 3, x => {
                const isCurrent = current && current.conn === c.id && current.db === d.name && current.coll === x.name;
                return `<div class="sb-item mg-row ${isCurrent ? 'active' : ''}" style="padding-inline-start:52px" role="button" tabindex="0"
                    onclick="${EXT}.openCollection(${js(c.id)},${js(d.name)},${js(x.name)})"
                    oncontextmenu="event.preventDefault();${EXT}.collMenu(event,${js(c.id)},${js(d.name)},${js(x.name)})">
                    <span class="mg-icon">${x.type === 'view' ? '👁' : '📄'}</span><span class="mg-name">${esc(x.name)}</span>
                    ${x.count != null ? `<span class="mg-count">${esc(fmt.number(x.count))}</span>` : ''}
                  </div>`;
              }) : ''}`;
          }) : ''}`;
      }).join('');
    }

    function toggle(key) {
      if (open.has(key)) open.delete(key);
      else {
        open.add(key);
        if (!cache.has(key) || cache.get(key).error) return fetchNode(key);
      }
      renderTree();
    }

    function refreshConnection(id) {
      for (const k of [...cache.keys()]) if (k.split('|')[1] === id) cache.delete(k);
      for (const k of open) if (k.split('|')[1] === id) fetchNode(k);
    }

    function refreshDatabase(id, db) {
      const dk = `d|${id}|${db}`;
      cache.delete(dk);
      if (open.has(dk)) fetchNode(dk);
    }

    // ---- menu contestuali ----

    function connMenu(e, id) {
      const c = conn(id);
      if (!c) return;
      ctx.ui.contextMenu(e.clientX, e.clientY, [
        { label: t('menu.test'), icon: '⚡', action: () => testConnection(id) },
        { label: t('menu.refresh'), icon: '↻', action: () => refreshConnection(id) },
        'separator',
        { label: t('menu.edit'), icon: '✎', action: () => connectionDialog(id) },
        { label: t('menu.delete'), icon: '🗑', danger: true, action: () => deleteConnection(id) },
      ]);
    }

    function dbMenu(e, id, db) {
      ctx.ui.contextMenu(e.clientX, e.clientY, [
        { label: t('menu.refresh'), icon: '↻', action: () => refreshDatabase(id, db) },
      ]);
    }

    function collMenu(e, id, db, coll) {
      const ro = conn(id)?.readOnly;
      ctx.ui.contextMenu(e.clientX, e.clientY, [
        { label: t('menu.open'), icon: '📄', action: () => openCollection(id, db, coll) },
        { label: t('menu.insert'), icon: '＋', disabled: ro, action: () => openCollection(id, db, coll).then(() => documentDialog(null)) },
        { label: t('menu.export'), icon: '⤓', action: () => exportDocuments({ conn: id, db, coll }, false) },
        'separator',
        { label: t('menu.drop'), icon: '🗑', danger: true, disabled: ro, action: () => dropCollection(id, db, coll) },
      ]);
    }

    // ---- dialogo della connessione ----

    async function connectionDialog(id) {
      const c = id ? conn(id) : { port: 27017 };
      if (!c) return;
      const servers = tunnelsAvailable ? (await ctx.apiFor('tunnels').get('/state').catch(() => ({ servers: [] }))).servers : [];
      const mode = c.uri ? 'uri' : c.tunnel ? 'tunnel' : 'host';
      const opt = (value, label, sel) => `<option value="${esc(value)}" ${sel ? 'selected' : ''}>${esc(label)}</option>`;
      const check = (fid, key, value) => `<label class="mg-check"><input type="checkbox" id="${fid}" ${value ? 'checked' : ''}> ${esc(t(key))}</label>`;
      openModal(t(id ? 'form.editTitle' : 'form.newTitle'), `
        <div class="form-grid">
          <div class="form-row"><label>${esc(t('form.id'))}</label><input class="form-input" id="f_mg_id" value="${esc(c.id || '')}" placeholder="${esc(t('form.idPlaceholder'))}" ${id ? 'disabled' : ''}></div>
          <div class="form-row"><label>${esc(t('form.label'))}</label><input class="form-input" id="f_mg_label" value="${esc(c.label || '')}"></div>
        </div>
        <div class="form-row"><label>${esc(t('form.mode'))}</label>
          <select class="form-input" id="f_mg_mode" onchange="${EXT}.formMode()">
            ${opt('host', t('form.modeHost'), mode === 'host')}
            ${opt('uri', t('form.modeUri'), mode === 'uri')}
            ${tunnelsAvailable || mode === 'tunnel' ? opt('tunnel', t('form.modeTunnel'), mode === 'tunnel') : ''}
          </select></div>
        <div class="form-row" data-mode="uri"><label>${esc(t('form.uri'))}</label>
          <input class="form-input mg-code" id="f_mg_uri" value="${esc(c.uri || '')}" spellcheck="false" placeholder="mongodb+srv://user@cluster0.example.net/?retryWrites=true">
          <p class="mg-muted">${esc(t('form.uriHint'))}</p></div>
        <div class="form-grid" data-mode="host">
          <div class="form-row"><label>${esc(t('form.host'))}</label><input class="form-input" id="f_mg_host" value="${esc(c.host || '')}" placeholder="localhost"></div>
          <div class="form-row"><label>${esc(t('form.port'))}</label><input class="form-input" id="f_mg_port" type="number" min="1" max="65535" value="${esc(String(c.port ?? 27017))}"></div>
        </div>
        <div class="form-row" data-mode="tunnel"><label>${esc(t('form.tunnel'))}</label>
          <select class="form-input" id="f_mg_tunnel">
            ${c.tunnelMissing ? opt(c.tunnel, t('form.tunnelDeleted', { tunnel: c.tunnel }), true) : ''}
            ${servers.map(s => opt(s.key, t('form.tunnelOption', { name: s.label, remote: s.remote }), c.tunnel === s.key)).join('')}
          </select>
          <p class="mg-muted">${esc(t('form.tunnelHint'))}</p></div>
        <div class="form-grid">
          <div class="form-row"><label>${esc(t('form.user'))}</label><input class="form-input" id="f_mg_user" value="${esc(c.user || '')}" autocomplete="off"></div>
          <div class="form-row"><label>${esc(t('form.password'))}</label>
            <input class="form-input" id="f_mg_password" type="password" autocomplete="new-password" placeholder="${esc(c.hasPassword ? t('form.passwordUnchanged') : '')}">
            ${c.hasPassword ? check('f_mg_nopassword', 'form.removePassword', false) : ''}</div>
        </div>
        <div class="form-grid">
          <div class="form-row"><label>${esc(t('form.authSource'))}</label><input class="form-input" id="f_mg_auth" value="${esc(c.authSource || '')}" placeholder="admin"></div>
          <div class="form-row"><label>${esc(t('form.database'))}</label><input class="form-input" id="f_mg_db" value="${esc(c.database || '')}"></div>
        </div>
        <p class="mg-muted">${esc(t('form.databaseHint'))}</p>
        ${check('f_mg_tls', 'form.tls', c.tls)}
        ${check('f_mg_insecure', 'form.tlsInsecure', c.tlsInsecure)}
        ${check('f_mg_ro', 'form.readOnly', c.readOnly)}
        <p class="mg-muted">${esc(t('form.vaultHint'))}</p>`,
      `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
       <button class="btn btn-primary" onclick="${EXT}.saveConnection(${js(id || '')})">${esc(t('core.action.save'))}</button>`);
      formMode();
    }

    function formMode() {
      const mode = byId('f_mg_mode')?.value;
      document.querySelectorAll('#modalBody [data-mode]').forEach(el => { el.hidden = el.dataset.mode !== mode; });
    }

    async function saveConnection(id) {
      const mode = byId('f_mg_mode').value;
      const pwd = byId('f_mg_password').value;
      const body = {
        id: byId('f_mg_id').value.trim(), label: byId('f_mg_label').value.trim(),
        uri: mode === 'uri' ? byId('f_mg_uri').value.trim() : '',
        host: mode === 'host' ? byId('f_mg_host').value.trim() : '',
        port: mode === 'host' ? byId('f_mg_port').value : '',
        tunnel: mode === 'tunnel' ? byId('f_mg_tunnel').value : '',
        user: byId('f_mg_user').value.trim(), authSource: byId('f_mg_auth').value.trim(), database: byId('f_mg_db').value.trim(),
        tls: byId('f_mg_tls').checked, tlsInsecure: byId('f_mg_insecure').checked, readOnly: byId('f_mg_ro').checked,
        ...(byId('f_mg_nopassword')?.checked ? { password: null } : pwd ? { password: pwd } : {}),
      };
      if (!body.label) body.label = body.id;
      try {
        await withVault(() => (id ? ctx.api.put(base(id), body) : ctx.api.post('/connections', body)));
        closeModal();
        toast(t('form.saved', { name: body.label }), 'success');
        if (id) { refreshConnection(id); if (current?.conn === id) result = null; }
        await load();
        if (current?.conn === id) find();
      } catch (e) { fail(e); }
    }

    async function testConnection(id) {
      try {
        const r = await withVault(() => ctx.api.post(`${base(id)}/test`, {}));
        toast(t('menu.testOk', { version: r.version }), 'success');
      } catch (e) { fail(e); }
    }

    async function deleteConnection(id) {
      const c = conn(id);
      if (!c || !confirm(t('form.confirmDelete', { name: c.label }))) return;
      try {
        await ctx.api.del(base(id));
        refreshConnection(id);
        if (current?.conn === id) current = null;
        await load();
      } catch (e) { fail(e); }
    }

    // ---- documenti ----

    async function openCollection(id, db, coll) {
      if (!current || current.conn !== id || current.db !== db || current.coll !== coll) {
        current = { conn: id, db, coll };
        query = { filter: '', sort: '', projection: '', limit: query.limit, skip: 0 };
        result = null;
        const form = ctx.root;
        $(form, 'filter').value = ''; $(form, 'sort').value = ''; $(form, 'projection').value = '';
      }
      renderTree();
      await find();
    }

    async function find() {
      if (!current) return;
      loading = true;
      renderMain();
      const { conn: id, db, coll } = current;
      try {
        result = await withVault(() => ctx.api.post(`${collPath(id, db, coll)}/find`, {
          filter: query.filter, sort: query.sort, projection: query.projection, limit: query.limit, skip: query.skip,
        }));
        result.error = null;
      } catch (e) {
        result = { error: e.handled ? null : e.message, documents: [] };
      }
      selected = new Set();
      loading = false;
      renderMain();
    }

    function readQuery() {
      query.filter = $(ctx.root, 'filter').value.trim();
      query.sort = $(ctx.root, 'sort').value.trim();
      query.projection = $(ctx.root, 'projection').value.trim();
      query.limit = Number($(ctx.root, 'limit').value) || 25;
      query.skip = 0;
    }

    function renderMain() {
      const c = current && conn(current.conn);
      $(ctx.root, 'empty').hidden = !!c;
      $(ctx.root, 'workspace').hidden = !c;
      if (!c) return;
      $(ctx.root, 'path').innerHTML = `<span class="mg-path-conn">${esc(c.label)}</span><span class="mg-sep">›</span>${esc(current.db)}<span class="mg-sep">›</span><strong>${esc(current.coll)}</strong>`;
      $(ctx.root, 'read-only').hidden = !c.readOnly;
      $(ctx.root, 'insert-btn').hidden = !!c.readOnly;
      const limit = $(ctx.root, 'limit');
      limit.innerHTML = pageSizes.map(n => `<option value="${n}" ${n === query.limit ? 'selected' : ''}>${esc(fmt.number(n))}</option>`).join('');
      renderBar(c);
      renderDocs(c);
    }

    function renderBar(c) {
      const bar = $(ctx.root, 'bar');
      if (loading && !result) { bar.innerHTML = `<span class="mg-muted">${esc(t('docs.loading'))}</span>`; return; }
      if (!result || result.error) { bar.innerHTML = ''; return; }
      const n = result.documents.length;
      const from = n ? result.skip + 1 : 0, to = result.skip + n;
      const range = result.total != null
        ? t('docs.rangeOf', { from: fmt.number(from), to: fmt.number(to), count: result.total })
        : t('docs.range', { from: fmt.number(from), to: fmt.number(to) });
      bar.innerHTML = `
        <button class="btn btn-ghost btn-sm" onclick="${EXT}.page(-1)" ${result.skip > 0 ? '' : 'disabled'} aria-label="${esc(t('docs.prev'))}">‹</button>
        <span class="mg-range">${esc(range)}</span>
        <button class="btn btn-ghost btn-sm" onclick="${EXT}.page(1)" ${result.hasMore ? '' : 'disabled'} aria-label="${esc(t('docs.next'))}">›</button>
        <span class="mg-muted">${esc(t('docs.ms', { ms: fmt.number(result.ms) }))}</span>
        ${loading ? `<span class="mg-muted">${esc(t('docs.loading'))}</span>` : ''}
        <span class="mg-bar-actions">
          ${!c.readOnly && n ? `<label class="mg-check mg-check-inline"><input type="checkbox" onchange="${EXT}.selectAll(this.checked)" ${selected.size === n ? 'checked' : ''}> ${esc(t('docs.selectAll'))}</label>` : ''}
          ${!c.readOnly && selected.size ? `<button class="btn btn-ghost btn-sm mg-danger" onclick="${EXT}.deleteSelected()">${esc(t('docs.deleteSelected', { count: selected.size }))}</button>` : ''}
        </span>`;
    }

    function renderDocs(c) {
      const el = $(ctx.root, 'docs');
      if (!result) { el.innerHTML = ''; return; }
      if (result.error) { el.innerHTML = `<div class="mg-error">${esc(result.error)}</div>`; return; }
      if (!result.documents.length) { el.innerHTML = `<div class="empty-state"><p>${esc(t(query.filter ? 'docs.noneFiltered' : 'docs.none'))}</p></div>`; return; }
      el.innerHTML = result.documents.map((d, i) => `
        <div class="mg-doc ${selected.has(i) ? 'selected' : ''}">
          <div class="mg-doc-head">
            ${!c.readOnly && d._id !== undefined ? `<input type="checkbox" onchange="${EXT}.select(${i},this.checked)" ${selected.has(i) ? 'checked' : ''} aria-label="${esc(t('docs.select'))}">` : ''}
            <span class="mg-doc-id">${d._id !== undefined ? esc(idText(d._id)) : esc(t('docs.noId'))}</span>
            <span class="mg-doc-actions">
              <button class="btn btn-ghost btn-sm" onclick="${EXT}.copyDoc(${i})" title="${esc(t('docs.copy'))}">⧉</button>
              ${!c.readOnly && d._id !== undefined ? `<button class="btn btn-ghost btn-sm" onclick="${EXT}.editDoc(${i})" title="${esc(t('docs.edit'))}">✎</button>
              <button class="btn btn-ghost btn-sm mg-danger" onclick="${EXT}.deleteDoc(${i})" title="${esc(t('docs.delete'))}">🗑</button>` : ''}
            </span>
          </div>
          <pre class="mg-json">${renderValue(d, esc)}</pre>
        </div>`).join('');
    }

    // ---- modifiche: anteprima e conferma ----

    // Chiede al server l'anteprima di op e la conferma; back: dialogo a cui tornare con "Indietro"
    async function operate(op, { back, onDone } = {}) {
      const id = op.connection || current.conn;
      const c = conn(id);
      const { connection, ...payload } = op;
      let plan;
      try { plan = await withVault(() => ctx.api.post(`${base(id)}/operation`, { op: payload })); } catch (e) { return fail(e); }
      const mustType = payload.op === 'dropCollection';
      openModal(t('confirm.title'), `
        <p>${esc(t(`confirm.${payload.op}`, { count: plan.count ?? 0, collection: payload.collection, database: payload.database, connection: c?.label ?? id }))}</p>
        <pre class="mg-preview">${esc(plan.preview)}</pre>
        ${mustType ? `<div class="form-row"><label>${esc(t('confirm.typeName', { name: payload.collection }))}</label><input class="form-input" id="f_mg_typed" autocomplete="off" oninput="document.getElementById('f_mg_go').disabled=this.value!==${js(payload.collection)}"></div>` : ''}`,
      `${back ? `<button class="btn btn-ghost" onclick="${EXT}.back()">${esc(t('confirm.back'))}</button>` : `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>`}
       <button class="btn ${plan.dangerous ? 'btn-danger' : 'btn-primary'}" id="f_mg_go" ${mustType ? 'disabled' : ''} onclick="${EXT}.execute()">${esc(t('confirm.run'))}</button>`);
      pending = { id, payload, token: plan.token, back, onDone };
    }
    let pending = null;

    async function execute() {
      if (!pending) return;
      const { id, payload, token, onDone } = pending;
      try {
        const r = await withVault(() => ctx.api.post(`${base(id)}/operation`, { op: payload, token }));
        closeModal();
        pending = null;
        const msg = payload.op === 'insertOne' || payload.op === 'insertMany' ? t('done.inserted', { count: r.inserted })
          : payload.op === 'replaceOne' ? t(r.modified ? 'done.replaced' : 'done.unchanged')
          : payload.op === 'deleteMany' ? t('done.deleted', { count: r.deleted })
          : t('done.dropped', { name: payload.collection });
        toast(msg, 'success');
        onDone?.(r);
      } catch (e) { fail(e); }
    }

    // Dialogo di inserimento (doc null) o di modifica di un documento
    let draft = '';
    function documentDialog(index, text) {
      const doc = index == null ? null : result?.documents[index];
      if (index != null && !doc) return;
      draft = text ?? (doc ? JSON.stringify(doc, null, 2) : '{\n  \n}');
      openModal(t(doc ? 'edit.titleEdit' : 'edit.titleInsert', { collection: current.coll }), `
        <p class="mg-muted">${esc(t(doc ? 'edit.hintEdit' : 'edit.hintInsert'))}</p>
        <textarea class="form-input mg-code mg-editor" id="f_mg_doc" spellcheck="false">${esc(draft)}</textarea>`,
      `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
       <button class="btn btn-primary" onclick="${EXT}.submitDocument(${index == null ? 'null' : index})">${esc(t('edit.continue'))}</button>`);
      modalWide();
      const ta = byId('f_mg_doc');
      ta.focus();
      ta.addEventListener('keydown', e => {
        if (e.key === 'Tab') { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitDocument(index); }
      });
    }

    const modalWide = () => byId('modal')?.classList.add('modal-wide');

    function submitDocument(index) {
      draft = byId('f_mg_doc').value;
      const back = () => documentDialog(index, draft);
      const onDone = () => { find(); refreshDatabase(current.conn, current.db); };
      const { db, coll } = current;
      if (index == null) {
        const many = draft.trim().startsWith('[');
        return operate(many ? { op: 'insertMany', database: db, collection: coll, documents: draft } : { op: 'insertOne', database: db, collection: coll, document: draft }, { back, onDone });
      }
      const doc = result.documents[index];
      return operate({ op: 'replaceOne', database: db, collection: coll, id: JSON.stringify(doc._id), document: draft }, { back, onDone });
    }

    function deleteIds(indexes) {
      const ids = indexes.map(i => result.documents[i]?._id).filter(x => x !== undefined);
      if (!ids.length) return;
      operate({ op: 'deleteMany', database: current.db, collection: current.coll, ids: JSON.stringify(ids) },
        { onDone: () => { find(); refreshDatabase(current.conn, current.db); } });
    }

    function dropCollection(id, db, coll) {
      operate({ connection: id, op: 'dropCollection', database: db, collection: coll }, {
        onDone: () => {
          if (current && current.conn === id && current.db === db && current.coll === coll) { current = null; result = null; renderMain(); }
          refreshDatabase(id, db);
        },
      });
    }

    // ---- export e indici ----

    async function exportDocuments(target, filtered) {
      const body = filtered ? { filter: query.filter, sort: query.sort, projection: query.projection } : {};
      const run = async () => {
        const res = await fetch(ctx.api.url(`${collPath(target.conn, target.db, target.coll)}/export`), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw Object.assign(new Error(ctx.ui.errorText(data, `HTTP ${res.status}`)), { status: res.status, code: data?.code, data });
        }
        return res.blob();
      };
      try {
        const blob = await withVault(run);
        const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${target.coll}.json` });
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      } catch (e) { fail(e); }
    }

    async function showIndexes() {
      if (!current) return;
      try {
        const { indexes } = await withVault(() => ctx.api.get(`${collPath(current.conn, current.db, current.coll)}/indexes`));
        openModal(t('indexes.title', { collection: current.coll }), indexes.length
          ? `<table class="data-table"><thead><tr><th>${esc(t('indexes.name'))}</th><th>${esc(t('indexes.keys'))}</th><th>${esc(t('indexes.options'))}</th></tr></thead><tbody>
            ${indexes.map(ix => {
              const { v, key, name, ...rest } = ix;
              return `<tr><td><code>${esc(name)}</code></td><td><pre class="mg-json mg-inline">${renderValue(key, esc)}</pre></td>
                <td>${Object.keys(rest).length ? `<pre class="mg-json mg-inline">${renderValue(rest, esc)}</pre>` : ''}</td></tr>`;
            }).join('')}</tbody></table>`
          : `<p class="mg-muted">${esc(t('indexes.none'))}</p>`,
        `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.close'))}</button>`);
        modalWide();
      } catch (e) { fail(e); }
    }

    // ---- eventi ----

    const actions = {
      'reload': () => { cache.clear(); load().then(() => { for (const k of open) fetchNode(k); }); },
      'add-connection': () => connectionDialog(null),
      'indexes': showIndexes,
      'export': () => current && exportDocuments(current, true),
      'insert': () => current && documentDialog(null),
      'reset-query': () => {
        for (const r of ['filter', 'sort', 'projection']) $(ctx.root, r).value = '';
        readQuery();
        find();
      },
    };
    for (const root of [ctx.root, ctx.sidebar]) {
      root.addEventListener('click', e => {
        const el = e.target.closest('[data-action]');
        if (el && actions[el.dataset.action]) actions[el.dataset.action]();
      });
    }
    $(ctx.root, 'query-form').addEventListener('submit', e => { e.preventDefault(); readQuery(); find(); });
    $(ctx.root, 'limit').addEventListener('change', () => { readQuery(); find(); });

    ctx.expose({
      toggle, connMenu, dbMenu, collMenu, openCollection, formMode, saveConnection,
      page(dir) {
        if (!result) return;
        query.skip = Math.max(0, query.skip + dir * query.limit);
        find();
      },
      select(i, on) { if (on) selected.add(i); else selected.delete(i); renderMain(); },
      selectAll(on) { selected = on ? new Set(result.documents.map((d, i) => (d._id !== undefined ? i : null)).filter(i => i !== null)) : new Set(); renderMain(); },
      deleteSelected: () => deleteIds([...selected]),
      deleteDoc: i => deleteIds([i]),
      editDoc: i => documentDialog(i),
      submitDocument,
      async copyDoc(i) {
        try { await navigator.clipboard.writeText(JSON.stringify(result.documents[i], null, 2)); toast(t('docs.copied'), 'success'); }
        catch { toast(t('docs.copyFailed'), 'error'); }
      },
      execute,
      back() { const b = pending?.back; pending = null; b?.(); },
    });

    this.refresh = load;
    this.languageChanged = () => { renderTree(); renderMain(); };
    await load();
  },
};
