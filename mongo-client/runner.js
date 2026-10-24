// Esecuzione delle istruzioni lette da mongosh.js con il driver. Le letture restituiscono al
// massimo `limit` documenti (truncated se ce n'erano altri); le modifiche arrivano qui solo
// dopo la conferma. Risultato: { kind: 'documents' | 'value' | 'write', … }
const { toJson } = require('./ejson');
const { ShellError } = require('./mongosh');

const QUERY_TIMEOUT_MS = 30000;
const isObj = v => v && typeof v === 'object' && !Array.isArray(v) && !v._bsontype && !(v instanceof Date);
const obj = (v, what, optional = true) => {
  if (v === undefined && optional) return {};
  if (!isObj(v)) throw new ShellError('shell_argument', { what });
  return v;
};
const arr = (v, what) => {
  if (!Array.isArray(v)) throw new ShellError('shell_argument', { what });
  return v;
};
const strArg = (v, what) => {
  if (typeof v !== 'string' || !v) throw new ShellError('shell_argument', { what });
  return v;
};

// Opzioni di un cursore di find dai modificatori in catena
function cursorOptions(stmt) {
  const o = {};
  let terminal = null;
  for (const { name, args } of stmt.chain) {
    if (name === 'sort') o.sort = obj(args[0], 'sort', false);
    else if (name === 'limit') o.limit = Math.max(0, Math.trunc(Number(args[0]) || 0));
    else if (name === 'skip') o.skip = Math.max(0, Math.trunc(Number(args[0]) || 0));
    else if (name === 'projection' || name === 'project') o.projection = obj(args[0], name, false);
    else if (name === 'hint') o.hint = args[0];
    else if (name === 'collation') o.collation = obj(args[0], 'collation', false);
    else if (name === 'maxTimeMS') o.maxTimeMS = Number(args[0]);
    else if (name === 'comment') o.comment = args[0];
    else if (name === 'allowDiskUse') o.allowDiskUse = args[0] !== false;
    else if (['count', 'itcount', 'size', 'explain'].includes(name)) terminal = name;
  }
  return { options: o, terminal };
}

// Primi `limit` elementi di un cursore e se ce n'erano altri
async function take(cursor, limit) {
  const out = [];
  try {
    while (out.length <= limit && await cursor.hasNext()) out.push(await cursor.next());
  } finally { await cursor.close().catch(() => {}); }
  return { documents: out.slice(0, limit).map(toJson), truncated: out.length > limit };
}

const writeSummary = r => {
  if (!r || typeof r !== 'object') return { value: toJson({ v: r }).v };
  const keys = ['acknowledged', 'insertedCount', 'insertedId', 'insertedIds', 'matchedCount', 'modifiedCount', 'deletedCount', 'upsertedCount', 'upsertedId', 'upsertedIds'];
  const out = {};
  for (const k of keys) if (r[k] !== undefined && r[k] !== null) out[k] = r[k];
  return toJson(Object.keys(out).length ? out : r);
};

// Cursore di lettura per l'export (find o aggregate senza $out/$merge)
function exportCursor(client, stmt) {
  if (stmt.type !== 'collection' || !['find', 'aggregate'].includes(stmt.method) || !stmt.read) throw new ShellError('export_not_cursor');
  const col = client.db(stmt.database).collection(stmt.collection);
  if (stmt.method === 'aggregate') return col.aggregate(arr(stmt.args[0] ?? [], 'pipeline'), { ...obj(stmt.args[1], 'options'), maxTimeMS: 300000 });
  const { options } = cursorOptions(stmt);
  return col.find(obj(stmt.args[0], 'filter'), { ...(stmt.args[1] ? { projection: obj(stmt.args[1], 'projection') } : {}), ...options, maxTimeMS: 300000 });
}

// Documenti toccati da una modifica, per la conferma (null se non si può sapere in fretta)
async function matches(client, stmt) {
  if (stmt.type !== 'collection') return null;
  const filterMethods = ['updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'replaceOne', 'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete'];
  const col = client.db(stmt.database).collection(stmt.collection);
  try {
    if (filterMethods.includes(stmt.method)) {
      const n = await col.countDocuments(obj(stmt.args[0], 'filter'), { maxTimeMS: 5000, ...(/One/.test(stmt.method) ? { limit: 1 } : {}) });
      return n;
    }
    if (stmt.method === 'drop') return await col.estimatedDocumentCount({ maxTimeMS: 5000 });
  } catch { /* conteggio lento o filtro non valido: l'errore arriva all'esecuzione */ }
  return null;
}

async function run(client, stmt, { limit = 100 } = {}) {
  const started = Date.now();
  const done = r => ({ ...r, ms: Date.now() - started });

  if (stmt.type === 'show') {
    if (stmt.what === 'databases') {
      const r = await client.db('admin').admin().listDatabases({ nameOnly: false });
      return done({ kind: 'value', value: r.databases.map(d => ({ name: d.name, sizeOnDisk: Number(d.sizeOnDisk ?? 0) })) });
    }
    const list = await client.db(stmt.database).listCollections({}, { nameOnly: true }).toArray();
    return done({ kind: 'value', value: list.map(c => c.name).sort() });
  }
  if (stmt.type === 'use') return done({ kind: 'use', database: stmt.database });

  if (stmt.type === 'db') {
    const db = client.db(stmt.database);
    const a = stmt.args;
    let v;
    switch (stmt.method) {
      case 'getCollectionNames': v = (await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name).sort(); break;
      case 'getCollectionInfos': v = await db.listCollections(obj(a[0], 'filter')).toArray(); break;
      case 'stats': v = await db.command({ dbStats: 1, ...(a[0] !== undefined ? { scale: Number(a[0]) } : {}) }); break;
      case 'version': v = (await client.db('admin').command({ buildInfo: 1 })).version; break;
      case 'getName': v = stmt.database; break;
      case 'runCommand': case 'adminCommand': v = await db.command(obj(a[0], stmt.method, false), { maxTimeMS: QUERY_TIMEOUT_MS }); break;
      case 'createCollection': await db.createCollection(strArg(a[0], 'createCollection'), obj(a[1], 'options')); return done({ kind: 'write', result: { ok: 1 } });
      case 'createView': await db.createCollection(strArg(a[0], 'createView'), { viewOn: strArg(a[1], 'createView'), pipeline: arr(a[2] ?? [], 'pipeline'), ...obj(a[3], 'options') }); return done({ kind: 'write', result: { ok: 1 } });
      case 'dropDatabase': await db.dropDatabase(); return done({ kind: 'write', result: { dropped: stmt.database } });
      default: throw new ShellError('shell_unsupported', { method: `db.${stmt.method}()` });
    }
    return done({ kind: stmt.read ? 'value' : 'write', ...(stmt.read ? { value: toJson({ v }).v } : { result: toJson({ v }).v }) });
  }

  const col = client.db(stmt.database).collection(stmt.collection);
  const a = stmt.args;
  const source = { database: stmt.database, collection: stmt.collection };
  switch (stmt.method) {
    case 'find': {
      const filter = obj(a[0], 'filter');
      const { options, terminal } = cursorOptions(stmt);
      if (a[1] !== undefined && !options.projection) options.projection = obj(a[1], 'projection');
      if (terminal === 'count' || terminal === 'itcount' || terminal === 'size') {
        return done({ kind: 'value', value: await col.countDocuments(filter, { maxTimeMS: QUERY_TIMEOUT_MS, ...(options.skip ? { skip: options.skip } : {}), ...(options.limit ? { limit: options.limit } : {}) }) });
      }
      if (terminal === 'explain') return done({ kind: 'value', value: toJson(await col.find(filter, options).explain()) });
      const max = options.limit ? Math.min(options.limit, limit) : limit;
      const cursor = col.find(filter, { maxTimeMS: QUERY_TIMEOUT_MS, ...options, limit: max + 1 });
      const r = await take(cursor, max);
      // .limit(n) dell'utente oltre il limite del pannello: troncato
      return done({ kind: 'documents', ...r, truncated: r.truncated, source: { ...source, filter: toJson(filter) } });
    }
    case 'findOne': {
      const doc = await col.findOne(obj(a[0], 'filter'), { maxTimeMS: QUERY_TIMEOUT_MS, ...(a[1] !== undefined ? { projection: obj(a[1], 'projection') } : {}) });
      return done({ kind: 'documents', documents: doc ? [toJson(doc)] : [], truncated: false, source });
    }
    case 'aggregate': {
      const pipeline = arr(a[0] ?? [], 'pipeline');
      if (!stmt.read) {
        await col.aggregate(pipeline, { ...obj(a[1], 'options') }).toArray();
        return done({ kind: 'write', result: { ok: 1 } });
      }
      const { options, terminal } = cursorOptions(stmt);
      if (terminal === 'explain') return done({ kind: 'value', value: toJson(await col.aggregate(pipeline, obj(a[1], 'options')).explain()) });
      const r = await take(col.aggregate(pipeline, { maxTimeMS: QUERY_TIMEOUT_MS, ...obj(a[1], 'options'), ...(options.allowDiskUse ? { allowDiskUse: true } : {}) }), limit);
      return done({ kind: 'documents', ...r });
    }
    case 'countDocuments': return done({ kind: 'value', value: await col.countDocuments(obj(a[0], 'filter'), { maxTimeMS: QUERY_TIMEOUT_MS, ...obj(a[1], 'options') }) });
    case 'count': return done({ kind: 'value', value: await col.countDocuments(obj(a[0], 'filter'), { maxTimeMS: QUERY_TIMEOUT_MS }) });
    case 'estimatedDocumentCount': return done({ kind: 'value', value: await col.estimatedDocumentCount({ maxTimeMS: QUERY_TIMEOUT_MS }) });
    case 'distinct': {
      const values = await col.distinct(strArg(a[0], 'distinct'), obj(a[1], 'filter'), { maxTimeMS: QUERY_TIMEOUT_MS });
      return done({ kind: 'value', value: toJson({ v: values.slice(0, limit) }).v, truncated: values.length > limit });
    }
    case 'getIndexes': case 'indexes': return done({ kind: 'value', value: (await col.indexes()).map(toJson) });
    case 'stats': {
      const [s] = await col.aggregate([{ $collStats: { storageStats: {} } }]).toArray();
      return done({ kind: 'value', value: toJson(s?.storageStats ?? {}) });
    }
    // ---- modifiche (già confermate) ----
    case 'insertOne': return done({ kind: 'write', result: writeSummary(await col.insertOne(obj(a[0], 'document', false), obj(a[1], 'options'))) });
    case 'insertMany': return done({ kind: 'write', result: writeSummary(await col.insertMany(arr(a[0], 'documents'), obj(a[1], 'options'))) });
    case 'updateOne': case 'updateMany': {
      const update = a[1];
      if (!isObj(update) && !Array.isArray(update)) throw new ShellError('shell_argument', { what: stmt.method });
      return done({ kind: 'write', result: writeSummary(await col[stmt.method](obj(a[0], 'filter', false), update, obj(a[2], 'options'))) });
    }
    case 'replaceOne': return done({ kind: 'write', result: writeSummary(await col.replaceOne(obj(a[0], 'filter', false), obj(a[1], 'document', false), obj(a[2], 'options'))) });
    case 'deleteOne': case 'deleteMany': return done({ kind: 'write', result: writeSummary(await col[stmt.method](obj(a[0], 'filter', false), obj(a[1], 'options'))) });
    case 'findOneAndUpdate': case 'findOneAndReplace': case 'findOneAndDelete': {
      const args = stmt.method === 'findOneAndDelete' ? [obj(a[0], 'filter', false), { ...obj(a[1], 'options'), includeResultMetadata: false }]
        : [obj(a[0], 'filter', false), stmt.method === 'findOneAndReplace' ? obj(a[1], 'document', false) : a[1], { ...obj(a[2], 'options'), includeResultMetadata: false }];
      const doc = await col[stmt.method](...args);
      return done({ kind: 'documents', documents: doc ? [toJson(doc)] : [], truncated: false, wrote: true });
    }
    case 'bulkWrite': return done({ kind: 'write', result: writeSummary(await col.bulkWrite(arr(a[0], 'operations'), obj(a[1], 'options'))) });
    case 'createIndex': return done({ kind: 'write', result: { name: await col.createIndex(obj(a[0], 'keys', false), obj(a[1], 'options')) } });
    case 'createIndexes': return done({ kind: 'write', result: { names: await col.createIndexes(arr(a[0], 'indexes').map(k => ({ key: k })), obj(a[1], 'options')) } });
    case 'dropIndex': {
      const ix = a[0];
      if (typeof ix !== 'string' && !isObj(ix)) throw new ShellError('shell_argument', { what: 'dropIndex' });
      await col.dropIndex(ix);
      return done({ kind: 'write', result: { ok: 1 } });
    }
    case 'dropIndexes': await col.dropIndexes(); return done({ kind: 'write', result: { ok: 1 } });
    case 'drop': await col.drop(); return done({ kind: 'write', result: { dropped: stmt.collection } });
    case 'renameCollection': await col.rename(strArg(a[0], 'renameCollection'), { dropTarget: a[1] === true }); return done({ kind: 'write', result: { renamed: a[0] } });
    default: throw new ShellError('shell_unsupported', { method: `.${stmt.method}()` });
  }
}

module.exports = { run, matches, exportCursor, cursorOptions };
