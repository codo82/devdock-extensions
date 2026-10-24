// Client MongoDB: connessioni (sezione "mongoConnections") con la password cifrata dal vault
// del core, database e collezioni, documenti in Extended JSON. Come nel client database, nessuna
// modifica parte da sola: il server restituisce l'operazione esatta e la esegue solo con il
// token di conferma legato a quell'operazione; le connessioni in sola lettura le rifiutano.
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const { toJson, parse, shell, EjsonError, EJSON } = require('./ejson');

const FIELDS = ['id', 'label', 'uri', 'host', 'port', 'user', 'password', 'authSource', 'database', 'tls', 'tlsInsecure', 'tunnel', 'readOnly'];
const HOST_RE = /^(\[[0-9a-f:.]+\]|[A-Za-z0-9._-]{1,253})$/i;
const NAME_RE = /^[^\x00$/\\. "]{1,64}$/;                 // nome di database
const COLL_RE = /^(?!system\.)[^\x00$]{1,120}$/;           // nome di collezione
const URI_RE = /^mongodb(\+srv)?:\/\/[^\s]{1,1000}$/;
const CONNECT_TIMEOUT_MS = 8000;
const QUERY_TIMEOUT_MS = 30000;
const PAGE_SIZES = [10, 25, 50, 100, 250];
const MAX_EXPORT = 100000;
const MAX_BATCH = 1000;
const OPS = ['insertOne', 'insertMany', 'replaceOne', 'deleteMany', 'dropCollection'];

module.exports = function createMongoClient(ctx) {
  const { KEY_RE, isText, isPort } = ctx.lib.validate;
  const { pick } = ctx.lib.config;
  const tunnels = ctx.require('tunnels'); // opzionale: connessioni via tunnel SSH
  const vault = ctx.vault;

  const connections = () => ctx.config.get('mongoConnections');
  const save = list => ctx.config.set('mongoConnections', list);
  const findConn = id => connections().find(c => c.id === id) || null;
  const connOr404 = id => {
    const c = findConn(id);
    if (!c) throw ctx.error(404, 'connection_not_found', { id: String(id) });
    return c;
  };
  const ejsonCall = fn => {
    try { return fn(); } catch (e) { if (e instanceof EjsonError) throw ctx.error(400, e.key, e.params); throw e; }
  };
  // errori del driver: messaggio originale (non tradotto) come parametro
  const driverError = e => (typeof e?.code === 'string' && e.code.includes('.') ? e : ctx.error(502, 'mongo', { error: e?.message || String(e) }));
  const run = async fn => { try { return await fn(); } catch (e) { throw driverError(e); } };

  // ---- validazione ----

  function validateConnection(c) {
    const bad = field => ctx.error.config(`connection_${field}`, { id: String(c?.id ?? '') });
    if (!c || typeof c !== 'object' || !KEY_RE.test(c.id || '')) throw bad('id');
    if (!isText(c.label, 100)) throw bad('label');
    if (c.uri != null) {
      if (!URI_RE.test(c.uri)) throw bad('uri');
      if (/^mongodb(\+srv)?:\/\/[^@/]*:[^@/]*@/.test(c.uri)) throw bad('uri_password'); // la password va nel vault
    } else if (c.tunnel != null) {
      if (!KEY_RE.test(c.tunnel)) throw bad('tunnel');
    } else {
      if (!HOST_RE.test(c.host || '')) throw bad('host');
      if (!isPort(c.port)) throw bad('port');
    }
    if (c.user != null && c.user !== '' && !isText(c.user, 200)) throw bad('user');
    if (c.password != null && !vault.isBox(c.password)) throw bad('password');
    if (c.authSource != null && c.authSource !== '' && !NAME_RE.test(c.authSource)) throw bad('auth_source');
    if (c.database != null && c.database !== '' && !NAME_RE.test(c.database)) throw bad('database');
    for (const k of ['tls', 'tlsInsecure', 'readOnly']) if (c[k] != null && typeof c[k] !== 'boolean') throw bad(k === 'readOnly' ? 'read_only' : 'tls');
  }

  const config = {
    mongoConnections: {
      empty: [], idField: 'id',
      normalize: v => (Array.isArray(v) ? v.map(c => pick(c || {}, FIELDS)) : v),
      validate(list, cfg) {
        if (!Array.isArray(list)) throw ctx.error.config('not_a_list', { section: 'mongoConnections' });
        const seen = new Set();
        for (const c of list) {
          validateConnection(c);
          if (seen.has(c.id)) throw ctx.error.config('duplicate_connection', { id: c.id });
          seen.add(c.id);
          if (c.password != null && !cfg.vault) throw ctx.error.config('password_without_vault', { id: c.id });
        }
      },
    },
  };

  // Password ri-cifrate al cambio della master password, cancellate al reset; client chiusi al blocco
  vault.register({
    rekey(reencrypt, cfg) {
      const list = cfg.mongoConnections || [];
      return { sections: { mongoConnections: list.map(c => (c.password ? { ...c, password: reencrypt(c.password) } : c)) }, count: list.filter(c => c.password).length };
    },
    reset: cfg => ({ mongoConnections: (cfg.mongoConnections || []).map(c => ({ ...c, password: null })) }),
    lock: () => closeClients(),
  });

  // ---- client del driver (uno per connessione, chiuso quando la connessione cambia) ----

  const clients = new Map(); // id → { client, signature }

  function closeClients(id) {
    for (const [k, v] of clients) {
      if (id && k !== id) continue;
      v.client.close().catch(() => {});
      clients.delete(k);
    }
  }

  async function connectionUri(c) {
    const password = c.password ? vault.decrypt(c.password) : '';
    let base;
    if (c.uri) base = new URL(c.uri);
    else {
      let host = c.host, port = c.port;
      if (c.tunnel) {
        if (!tunnels) throw ctx.error(400, 'tunnels_unavailable');
        if (!tunnels.getServer(c.tunnel)) throw ctx.error(400, 'tunnel_deleted', { tunnel: c.tunnel });
        const t = await tunnels.ensureTunnel(c.tunnel);
        host = '127.0.0.1'; port = t.port;
      }
      base = new URL(`mongodb://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}/`);
      // un solo server (anche dietro un tunnel): niente scoperta degli altri membri del replica set
      base.searchParams.set('directConnection', 'true');
    }
    if (c.user) { base.username = c.user; base.password = password; }
    if (c.authSource) base.searchParams.set('authSource', c.authSource);
    if (c.tls) base.searchParams.set('tls', 'true');
    if (c.tlsInsecure) base.searchParams.set('tlsInsecure', 'true');
    return base.toString();
  }

  async function clientFor(c) {
    const uri = await connectionUri(c);
    const signature = crypto.createHash('sha256').update(uri).digest('hex');
    const cached = clients.get(c.id);
    if (cached && cached.signature === signature) return cached.client;
    if (cached) closeClients(c.id);
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS, connectTimeoutMS: CONNECT_TIMEOUT_MS,
      appName: 'DevDock', promoteLongs: false, ignoreUndefined: true,
      ...(c.readOnly ? { readPreference: 'secondaryPreferred' } : {}),
    });
    await run(() => client.connect());
    clients.set(c.id, { client, signature });
    return client;
  }

  const dbName = name => {
    if (!NAME_RE.test(name || '')) throw ctx.error(400, 'database_invalid', { name: String(name ?? '') });
    return name;
  };
  const collName = name => {
    if (!COLL_RE.test(name || '')) throw ctx.error(400, 'collection_invalid', { name: String(name ?? '') });
    return name;
  };

  async function collection(c, db, coll) {
    const client = await clientFor(c);
    return client.db(dbName(db)).collection(collName(coll));
  }

  // ---- letture ----

  async function listDatabases(c) {
    const client = await clientFor(c);
    try {
      const r = await client.db('admin').admin().listDatabases({ nameOnly: false });
      return r.databases.map(d => ({ name: d.name, sizeOnDisk: Number(d.sizeOnDisk ?? 0), empty: !!d.empty }));
    } catch (e) {
      // utente senza permessi su listDatabases: almeno il database della connessione
      if (c.database && /not authorized|Unauthorized/i.test(e.message)) return [{ name: c.database, sizeOnDisk: null, empty: false, restricted: true }];
      throw driverError(e);
    }
  }

  async function listCollections(c, db) {
    const client = await clientFor(c);
    const d = client.db(dbName(db));
    const list = await run(() => d.listCollections({}, { nameOnly: false }).toArray());
    const out = await Promise.all(list.filter(x => !x.name.startsWith('system.')).map(async x => {
      let count = null;
      if (x.type !== 'view') { try { count = await d.collection(x.name).estimatedDocumentCount({ maxTimeMS: 5000 }); } catch { /* conteggio non disponibile */ } }
      return { name: x.name, type: x.type || 'collection', count };
    }));
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  // { filter, sort, projection, skip, limit } → documenti, totale (fino a un tempo massimo)
  async function findDocuments(c, db, coll, body, { maxLimit = PAGE_SIZES.at(-1) } = {}) {
    const filter = ejsonCall(() => parse(body.filter, 'filter'));
    const sort = ejsonCall(() => parse(body.sort, 'sort'));
    const projection = ejsonCall(() => parse(body.projection, 'projection'));
    const limit = Math.min(Math.max(parseInt(body.limit) || 50, 1), maxLimit);
    const skip = Math.max(parseInt(body.skip) || 0, 0);
    const col = await collection(c, db, coll);
    const started = Date.now();
    const docs = await run(() => col.find(filter, { sort, projection, skip, limit: limit + 1, maxTimeMS: QUERY_TIMEOUT_MS }).toArray());
    let total = null;
    if (body.count !== false) {
      try { total = await col.countDocuments(filter, { maxTimeMS: 5000 }); } catch { /* troppo lento: senza totale */ }
    }
    return {
      documents: docs.slice(0, limit).map(toJson), hasMore: docs.length > limit,
      skip, limit, total, ms: Date.now() - started,
    };
  }

  // ---- modifiche: anteprima, token di conferma, esecuzione ----

  const confirmSecret = crypto.randomBytes(32); // i token valgono fino al riavvio di DevDock
  const tokenOf = (connId, op) => crypto.createHmac('sha256', confirmSecret).update(`${connId}\0${JSON.stringify(op)}`).digest('hex');

  // Operazione dal client → forma normalizzata (documenti come Extended JSON canonico) e anteprima
  function plan(c, raw) {
    const op = raw || {};
    if (!OPS.includes(op.op)) throw ctx.error(400, 'operation_invalid');
    const db = dbName(op.database), coll = collName(op.collection);
    const norm = { op: op.op, database: db, collection: coll };
    const target = `db.getSiblingDB(${JSON.stringify(db)}).getCollection(${JSON.stringify(coll)})`;
    let preview, count = 1;
    if (op.op === 'insertOne') {
      const doc = ejsonCall(() => parse(op.document, 'document'));
      norm.document = toJsonCanonical(doc);
      preview = `${target}.insertOne(${shell(doc)})`;
    } else if (op.op === 'insertMany') {
      const docs = ejsonCall(() => parse(op.documents, 'documents', { object: false }));
      if (!Array.isArray(docs) || !docs.length || docs.length > MAX_BATCH || !docs.every(d => d && typeof d === 'object' && !Array.isArray(d))) throw ctx.error(400, 'documents_invalid', { max: MAX_BATCH });
      norm.documents = docs.map(toJsonCanonical);
      count = docs.length;
      preview = `${target}.insertMany([\n${docs.map(d => shell(d, '  ')).map(s => `  ${s}`).join(',\n')}\n])`;
    } else if (op.op === 'replaceOne') {
      const id = ejsonCall(() => parse(op.id, 'id', { object: false }));
      if (id === null || id === undefined) throw ctx.error(400, 'id_required');
      const doc = ejsonCall(() => parse(op.document, 'document'));
      if (doc._id !== undefined && JSON.stringify(toJsonCanonical({ v: doc._id })) !== JSON.stringify(toJsonCanonical({ v: id }))) throw ctx.error(400, 'id_changed');
      delete doc._id;
      norm.id = toJsonCanonical({ v: id }).v;
      norm.document = toJsonCanonical(doc);
      preview = `${target}.replaceOne(\n  { _id: ${shell(id)} },\n  ${shell(doc, '  ')}\n)`;
    } else if (op.op === 'deleteMany') {
      const ids = ejsonCall(() => parse(op.ids, 'ids', { object: false }));
      if (!Array.isArray(ids) || !ids.length || ids.length > MAX_BATCH) throw ctx.error(400, 'ids_invalid', { max: MAX_BATCH });
      norm.ids = ids.map(x => toJsonCanonical({ v: x }).v);
      count = ids.length;
      preview = ids.length === 1 ? `${target}.deleteOne({ _id: ${shell(ids[0])} })` : `${target}.deleteMany({ _id: { $in: ${shell(ids)} } })`;
    } else if (op.op === 'dropCollection') {
      preview = `${target}.drop()`;
      count = null;
    }
    return { op: norm, preview, count, dangerous: op.op === 'dropCollection' || op.op === 'deleteMany', token: tokenOf(c.id, norm) };
  }

  const toJsonCanonical = doc => EJSON.serialize(doc, { relaxed: false });
  const fromCanonical = v => EJSON.deserialize(v, { relaxed: false });

  async function execute(c, op) {
    const col = await collection(c, op.database, op.collection);
    if (op.op === 'insertOne') {
      const r = await run(() => col.insertOne(fromCanonical(op.document)));
      return { inserted: 1, ids: [toJson({ v: r.insertedId }).v] };
    }
    if (op.op === 'insertMany') {
      const r = await run(() => col.insertMany(op.documents.map(fromCanonical), { ordered: true }));
      return { inserted: r.insertedCount, ids: Object.values(r.insertedIds).map(id => toJson({ v: id }).v) };
    }
    if (op.op === 'replaceOne') {
      const id = fromCanonical({ v: op.id }).v;
      const r = await run(() => col.replaceOne({ _id: id }, fromCanonical(op.document)));
      if (!r.matchedCount) throw ctx.error(404, 'document_not_found');
      return { matched: r.matchedCount, modified: r.modifiedCount };
    }
    if (op.op === 'deleteMany') {
      const ids = op.ids.map(x => fromCanonical({ v: x }).v);
      const r = await run(() => col.deleteMany({ _id: { $in: ids } }));
      return { deleted: r.deletedCount };
    }
    if (op.op === 'dropCollection') {
      await run(() => col.drop());
      return { dropped: true };
    }
    throw ctx.error(400, 'operation_invalid');
  }

  // ---- dati dal form ----

  const publicConnection = c => ({ ...pick(c, FIELDS.filter(f => f !== 'password')), hasPassword: !!c.password, ...(c.tunnel && (!tunnels || !tunnels.getServer(c.tunnel)) ? { tunnelMissing: true } : {}) });

  // password: stringa = nuova (cifrata subito), null = rimossa, assente o '' = invariata
  function buildConnection(body, existing = {}) {
    const c = { ...existing, ...pick(body || {}, ['label', 'uri', 'host', 'port', 'user', 'authSource', 'database', 'tls', 'tlsInsecure', 'tunnel', 'readOnly']) };
    if (!existing.id) c.id = body.id;
    for (const k of ['uri', 'host', 'user', 'authSource', 'database', 'tunnel']) if (c[k] === '' || c[k] === undefined) c[k] = null;
    if (c.port !== undefined && c.port !== null && c.port !== '') c.port = Number(c.port); else c.port = null;
    for (const k of ['tls', 'tlsInsecure', 'readOnly']) c[k] = !!c[k];
    if (c.uri) { c.host = null; c.port = null; c.tunnel = null; }
    else if (c.tunnel) {
      if (!tunnels) throw ctx.error(400, 'tunnels_unavailable');
      if (!tunnels.getServer(c.tunnel)) throw ctx.error(400, 'tunnel_unknown', { tunnel: String(c.tunnel) });
      c.host = null; c.port = null;
    }
    if (typeof body.password === 'string' && body.password !== '') c.password = vault.encrypt(body.password);
    else if (body.password === null) c.password = null;
    else if (c.password === undefined) c.password = null;
    for (const k of Object.keys(c)) if (c[k] === null && k !== 'password') delete c[k];
    if (!c.tls) delete c.tls;
    if (!c.tlsInsecure) delete c.tlsInsecure;
    return c;
  }

  const mcpConnection = id => {
    if (vault.state() !== 'unlocked') throw ctx.error(423, 'mcp_vault_locked');
    return connOr404(id);
  };

  return {
    config,

    handlers: {
      listConnections(req, res) {
        res.json({ connections: connections().map(publicConnection), tunnelsAvailable: !!tunnels, pageSizes: PAGE_SIZES });
      },

      createConnection(req, res) {
        const body = req.body || {};
        if (findConn(body.id)) throw ctx.error(409, 'connection_exists', { id: String(body.id) });
        const c = buildConnection(body);
        save([...connections(), c]);
        res.json(publicConnection(c));
      },

      updateConnection(req, res) {
        const cur = connOr404(req.params.id);
        const c = buildConnection(req.body || {}, cur);
        save(connections().map(x => (x.id === c.id ? c : x)));
        closeClients(c.id);
        res.json(publicConnection(c));
      },

      deleteConnection(req, res) {
        const c = connOr404(req.params.id);
        save(connections().filter(x => x.id !== c.id));
        closeClients(c.id);
        res.json({ ok: true });
      },

      async testConnection(req, res) {
        const c = connOr404(req.params.id);
        closeClients(c.id);
        const client = await clientFor(c);
        const info = await run(() => client.db('admin').command({ buildInfo: 1 }));
        res.json({ ok: true, version: info.version });
      },

      async databases(req, res) { res.json({ databases: await listDatabases(connOr404(req.params.id)) }); },

      async collections(req, res) { res.json({ collections: await listCollections(connOr404(req.params.id), req.params.db) }); },

      async find(req, res) {
        res.json(await findDocuments(connOr404(req.params.id), req.params.db, req.params.coll, req.body || {}));
      },

      async count(req, res) {
        const col = await collection(connOr404(req.params.id), req.params.db, req.params.coll);
        const filter = ejsonCall(() => parse(req.body?.filter, 'filter'));
        res.json({ count: await run(() => col.countDocuments(filter, { maxTimeMS: QUERY_TIMEOUT_MS })) });
      },

      async indexes(req, res) {
        const col = await collection(connOr404(req.params.id), req.params.db, req.params.coll);
        const list = await run(() => col.indexes());
        res.json({ indexes: list.map(toJson) });
      },

      // Collezione (o risultato filtrato) come array JSON, scaricato dal browser
      async exportDocuments(req, res) {
        const c = connOr404(req.params.id);
        const body = req.body || {};
        const col = await collection(c, req.params.db, req.params.coll);
        const filter = ejsonCall(() => parse(body.filter, 'filter'));
        const sort = ejsonCall(() => parse(body.sort, 'sort'));
        const projection = ejsonCall(() => parse(body.projection, 'projection'));
        const cursor = col.find(filter, { sort, projection, limit: MAX_EXPORT, maxTimeMS: 300000 });
        // primo lotto prima delle intestazioni: un filtro sbagliato diventa un errore normale
        try { await cursor.hasNext(); } catch (e) { await cursor.close().catch(() => {}); throw driverError(e); }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${req.params.coll.replace(/[^\w.-]/g, '_')}.json"`);
        let first = true;
        res.write('[\n');
        try {
          for await (const doc of cursor) {
            res.write(`${first ? '' : ',\n'}${JSON.stringify(toJson(doc))}`);
            first = false;
          }
        } catch (e) {
          ctx.log.error('export:', e.message); // a metà file: il download resta troncato ma valido
        }
        res.end('\n]\n');
      },

      // { op } → anteprima e token; { op, token } → esecuzione se il token corrisponde
      async operation(req, res) {
        const c = connOr404(req.params.id);
        if (c.readOnly) throw ctx.error(403, 'read_only');
        const p = plan(c, req.body?.op);
        if (!req.body?.token) return res.json({ preview: p.preview, count: p.count, dangerous: p.dangerous, token: p.token, op: p.op });
        const given = Buffer.from(String(req.body.token));
        const expected = Buffer.from(p.token);
        if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw ctx.error(409, 'confirmation_mismatch');
        res.json({ ok: true, ...(await execute(c, p.op)) });
      },
    },

    // Strumenti MCP: solo letture e solo con il vault sbloccato dall'interfaccia
    mcp: {
      connections() {
        if (vault.state() !== 'unlocked') throw ctx.error(423, 'mcp_vault_locked');
        return {
          connections: connections().map(c => ({
            id: c.id, label: c.label, host: c.uri ? new URL(c.uri).host : c.tunnel ? null : c.host, port: c.uri || c.tunnel ? null : c.port,
            tunnel: c.tunnel || null, database: c.database || null, readOnly: !!c.readOnly,
          })),
        };
      },
      async databases({ connection }) { return { databases: (await listDatabases(mcpConnection(connection))).map(d => d.name) }; },
      async collections({ connection, database }) { return { database, collections: await listCollections(mcpConnection(connection), database) }; },
      async find({ connection, database, collection: coll, filter, sort, projection, limit = 20 }) {
        const r = await findDocuments(mcpConnection(connection), database, coll, { filter, sort, projection, limit, count: false }, { maxLimit: 100 });
        return { database, collection: coll, documents: r.documents, truncated: r.hasMore };
      },
      async count({ connection, database, collection: coll, filter }) {
        const col = await collection(mcpConnection(connection), database, coll);
        const f = ejsonCall(() => parse(filter, 'filter'));
        return { database, collection: coll, count: await run(() => col.countDocuments(f, { maxTimeMS: QUERY_TIMEOUT_MS })) };
      },
    },

    shutdown() { closeClients(); },
  };
};
