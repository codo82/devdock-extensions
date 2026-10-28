// Con un vero MongoDB (mongodb-memory-server): database, collezioni, documenti, modifiche
// confermate, export e strumenti MCP. Saltato quando il binario di mongod non è disponibile.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startServer, mcpClient } = require('kelbo/testkit');

const EXT = path.join(__dirname, '..');
let mongod = null, srv, mcp, skipReason = null;

before(async () => {
  try {
    const { MongoMemoryServer } = require('mongodb-memory-server');
    mongod = await MongoMemoryServer.create();
  } catch (e) { skipReason = `mongod non disponibile: ${e.message.split('\n')[0]}`; return; }
  srv = await startServer({ projects: [] }, { install: [EXT] });
  mcp = await mcpClient(srv);
});
after(async () => { await mcp?.close(); await srv?.stop(); await mongod?.stop(); });

const api = (method, p, body) => srv.request(method, `${p.startsWith('/vault') ? '/api/core' : '/api/ext/mongo-client'}${p}`, { body });
const coll = '/connections/m/databases/app/collections/users';

// anteprima, poi esecuzione con il token
async function operate(op) {
  const plan = await api('POST', '/connections/m/operation', { op });
  assert.equal(plan.status, 200, plan.text);
  const r = await api('POST', '/connections/m/operation', { op, token: plan.json.token });
  assert.equal(r.status, 200, r.text);
  return r.json;
}

test('collezioni e documenti: inserimento, ricerca, modifica, eliminazione', async t => {
  if (skipReason) return t.skip(skipReason);
  assert.equal((await api('POST', '/vault/init', { password: 'master-password-mongo' })).status, 200);
  const port = Number(new URL(mongod.getUri()).port);
  assert.equal((await api('POST', '/connections', { id: 'm', label: 'Memoria', host: '127.0.0.1', port })).status, 200);
  const test1 = await api('POST', '/connections/m/test', {});
  assert.equal(test1.status, 200, test1.text);
  assert.match(test1.json.version, /^\d+\./);

  let r = await operate({ op: 'insertMany', database: 'app', collection: 'users', documents: JSON.stringify([
    { _id: 1, name: 'Ada', n: { $numberLong: '9007199254740993' } },
    { _id: 2, name: 'Bob', at: { $date: '2026-01-02T03:04:05Z' } },
    { _id: 3, name: 'Cy' },
  ]) });
  assert.equal(r.inserted, 3);
  r = await operate({ op: 'insertOne', database: 'app', collection: 'users', document: '{"name": "Dee"}' });
  assert.equal(r.inserted, 1);
  assert.match(r.ids[0].$oid, /^[0-9a-f]{24}$/);

  assert.ok((await api('GET', '/connections/m/databases')).json.databases.some(d => d.name === 'app'));
  assert.deepEqual((await api('GET', '/connections/m/databases/app/collections')).json.collections, [{ name: 'users', type: 'collection', count: 4 }]);

  r = await api('POST', `${coll}/find`, { filter: '{"name": "Ada"}' });
  assert.equal(r.json.total, 1);
  assert.deepEqual(r.json.documents, [{ _id: 1, name: 'Ada', n: { $numberLong: '9007199254740993' } }]);
  r = await api('POST', `${coll}/find`, { sort: '{"name": -1}', projection: '{"name": 1}', limit: 2 });
  assert.deepEqual(r.json.documents.map(d => d.name), ['Dee', 'Cy']);
  assert.equal(r.json.hasMore, true);
  r = await api('POST', `${coll}/find`, { sort: '{"name": -1}', limit: 2, skip: 2 });
  assert.deepEqual(r.json.documents.map(d => d.name), ['Bob', 'Ada']);
  assert.equal(r.json.hasMore, false);
  assert.deepEqual(r.json.documents[0].at, { $date: '2026-01-02T03:04:05Z' });
  assert.equal((await api('POST', `${coll}/count`, { filter: '{"_id": {"$lte": 2}}' })).json.count, 2);
  r = await api('POST', `${coll}/find`, { filter: '{"$bad": 1}' });
  assert.equal(r.status, 502);
  assert.equal(r.json.code, 'mongo-client.mongo');

  // modifica del documento visto nel browser: il Long resta Long
  r = await operate({ op: 'replaceOne', database: 'app', collection: 'users', id: '1', document: '{"_id": 1, "name": "Ada L.", "n": {"$numberLong": "9007199254740993"}}' });
  assert.deepEqual(r, { ok: true, matched: 1, modified: 1 });
  r = await api('POST', `${coll}/find`, { filter: '{"_id": 1}' });
  assert.deepEqual(r.json.documents[0], { _id: 1, name: 'Ada L.', n: { $numberLong: '9007199254740993' } });
  r = await api('POST', '/connections/m/operation', { op: { op: 'replaceOne', database: 'app', collection: 'users', id: '99', document: '{}' } });
  r = await api('POST', '/connections/m/operation', { op: { op: 'replaceOne', database: 'app', collection: 'users', id: '99', document: '{}' }, token: r.json.token });
  assert.equal(r.json.code, 'mongo-client.document_not_found');

  const ix = await api('GET', `${coll}/indexes`);
  assert.deepEqual(ix.json.indexes.map(i => i.name), ['_id_']);

  const exp = await api('POST', '/connections/m/export', { database: 'app', collection: 'users', filter: '{"_id": {"$in": [1, 2]}}', sort: '{"_id": 1}', format: 'json' });
  assert.equal(exp.status, 200);
  assert.match(exp.headers['content-disposition'], /users\.json/);
  assert.deepEqual(exp.json.map(d => d._id), [1, 2]);
  assert.equal((await api('POST', '/connections/m/export', { database: 'app', collection: 'users', filter: '{"$bad": 1}', format: 'json' })).json.code, 'mongo-client.mongo');
  const csv = await api('POST', '/connections/m/export', { database: 'app', collection: 'users', filter: '{"_id": {"$in": [1, 2]}}', sort: '{"_id": 1}', format: 'csv' });
  assert.match(csv.headers['content-disposition'], /users\.csv/);
  assert.equal(csv.text, '_id,name,n,at\r\n1,Ada L.,9007199254740993,\r\n2,Bob,,2026-01-02T03:04:05Z\r\n');
  const script = await api('POST', '/connections/m/export', { database: 'app', code: 'db.users.find({ _id: 2 })', format: 'js' });
  assert.equal(script.text, 'db.getCollection("users").insertMany([\n  {\n    _id: 2,\n    name: "Bob",\n    at: ISODate("2026-01-02T03:04:05.000Z")\n  }\n]);\n');

  r = await operate({ op: 'deleteMany', database: 'app', collection: 'users', ids: '[1, 2]' });
  assert.equal(r.deleted, 2);
  assert.equal((await api('POST', `${coll}/count`, {})).json.count, 2);
});

test('MCP: letture con il vault sbloccato', async t => {
  if (skipReason) return t.skip(skipReason);
  const call = async (name, args = {}) => (await mcp.callTool({ name, arguments: args })).structuredContent;
  assert.deepEqual((await call('mongo_client_databases', { connection: 'm' })).databases.includes('app'), true);
  assert.deepEqual((await call('mongo_client_collections', { connection: 'm', database: 'app' })).collections.map(c => c.name), ['users']);
  const r = await call('mongo_client_find', { connection: 'm', database: 'app', collection: 'users', filter: { _id: 3 }, limit: 5 });
  assert.deepEqual(r.documents, [{ _id: 3, name: 'Cy' }]);
  assert.equal((await call('mongo_client_count', { connection: 'm', database: 'app', collection: 'users' })).count, 2);
  const agg = await call('mongo_client_aggregate', { connection: 'm', database: 'app', collection: 'users', pipeline: [{ $match: { _id: 3 } }, { $project: { name: 1 } }] });
  assert.deepEqual(agg.documents, [{ _id: 3, name: 'Cy' }]);
  assert.equal((await call('mongo_client_aggregate', { connection: 'm', database: 'app', collection: 'users', pipeline: [{ $out: 'x' }] })).code, 'mongo-client.mcp_read_only');
});

test('editor: letture subito, modifiche con anteprima e conferma, risultati di find modificabili', async t => {
  if (skipReason) return t.skip(skipReason);
  const shell = (code, extra = {}) => api('POST', '/connections/m/shell', { code, database: 'app', limit: 50, ...extra });
  let r = await shell('db.users.find({ name: /^c/i }, { name: 1 })');
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.json.kind, r.json.documents, r.json.source.collection], ['documents', [{ _id: 3, name: 'Cy' }], 'users']);
  r = await shell('db.users.countDocuments({})');
  assert.deepEqual([r.json.kind, r.json.value], ['value', 2]);
  r = await shell('db.users.distinct("name")');
  assert.equal(r.json.value.length, 2);
  r = await shell('db.users.aggregate([{ $group: { _id: null, n: { $sum: 1 } } }])');
  assert.deepEqual(r.json.documents, [{ _id: null, n: 2 }]);
  r = await shell('show collections');
  assert.deepEqual(r.json.value, ['users']);
  r = await shell('db.users.find().sort({ _id: 1 }).limit(1)');
  assert.equal(r.json.documents.length, 1);
  r = await shell('db.users.find().count()');
  assert.equal(r.json.value, 2);

  // modifica: 428 con l'istruzione, i documenti che corrispondono e il token
  const code = 'db.users.updateMany({ name: { $exists: true } }, { $set: { checked: true } })';
  r = await shell(code);
  assert.equal(r.status, 428);
  assert.deepEqual([r.json.needsConfirmation, r.json.matches, r.json.preview], [true, 2, code]);
  assert.equal((await shell(code + ' ')).status, 428); // stesso testo a meno di spazi: stesso token
  const done = await shell(code, { token: r.json.token });
  assert.equal(done.status, 200, done.text);
  assert.deepEqual([done.json.kind, done.json.result.matchedCount, done.json.result.modifiedCount], ['write', 2, 2]);
  r = await shell('db.users.updateMany({}, { $set: { checked: false } })', { token: r.json.token });
  assert.equal(r.json.code, 'mongo-client.confirmation_mismatch');
  r = await shell('db.users.insertOne({ _id: 3, name: "dup" })');
  r = await shell('db.users.insertOne({ _id: 3, name: "dup" })', { token: r.json.token });
  assert.equal(r.status, 502);
  assert.match(r.json.params.error, /duplicate key/);

  // celle modificate nella tabella: un bulkWrite di $set confermato
  const op = { op: 'updateFields', database: 'app', collection: 'users', updates: JSON.stringify([{ id: 3, set: { name: 'Cy 2', 'meta.tag': 'x' } }]) };
  r = await operate(op);
  assert.deepEqual([r.matched, r.modified], [1, 1]);
  r = await shell('db.users.findOne({ _id: 3 })');
  assert.deepEqual(r.json.documents[0], { _id: 3, name: 'Cy 2', checked: true, meta: { tag: 'x' } });
});

test('designer: collezione nuova, indici, struttura, rinomina', async t => {
  if (skipReason) return t.skip(skipReason);
  let r = await operate({ op: 'createCollection', database: 'shop', collection: 'orders', options: JSON.stringify({ validator: { $jsonSchema: { bsonType: 'object', required: ['total'] } } }) });
  assert.equal(r.created, true);
  const bad = await api('POST', '/connections/m/shell', { code: 'db.orders.insertOne({ x: 1 })', database: 'shop' });
  const refused = await api('POST', '/connections/m/shell', { code: 'db.orders.insertOne({ x: 1 })', database: 'shop', token: bad.json.token });
  assert.equal(refused.status, 502); // il validatore rifiuta il documento
  await operate({ op: 'insertMany', database: 'shop', collection: 'orders', documents: '[{"total": 10, "tags": ["a"]}, {"total": 5.5, "note": "x"}]' });
  r = await operate({ op: 'createIndex', database: 'shop', collection: 'orders', keys: '{"total": -1}', options: '{"name": "by_total"}' });
  assert.equal(r.index, 'by_total');
  const st = await api('GET', '/connections/m/databases/shop/collections/orders/structure');
  assert.equal(st.status, 200, st.text);
  assert.equal(st.json.stats.count, 2);
  assert.deepEqual(st.json.indexes.map(i => i.name), ['_id_', 'by_total']);
  const total = st.json.schema.find(f => f.path === 'total');
  assert.deepEqual([total.count, Object.keys(total.types).sort()], [2, ['double', 'int']]);
  assert.equal(st.json.schema.find(f => f.path === 'note').count, 1);
  assert.ok(st.json.options.validator);
  r = await operate({ op: 'dropIndex', database: 'shop', collection: 'orders', name: 'by_total' });
  assert.equal(r.dropped, true);
  r = await operate({ op: 'renameCollection', database: 'shop', collection: 'orders', to: 'orders_old' });
  assert.equal(r.renamed, 'orders_old');
  assert.deepEqual((await api('GET', '/connections/m/databases/shop/collections')).json.collections.map(c => c.name), ['orders_old']);
  const drop = await api('POST', '/connections/m/shell', { code: 'db.dropDatabase()', database: 'shop' });
  assert.equal(drop.status, 428);
  assert.equal(drop.json.dangerous, true);
  r = await api('POST', '/connections/m/shell', { code: 'db.dropDatabase()', database: 'shop', token: drop.json.token });
  assert.equal(r.status, 200, r.text);
  assert.ok(!(await api('GET', '/connections/m/databases')).json.databases.some(d => d.name === 'shop'));
});

test('eliminazione della collezione', async t => {
  if (skipReason) return t.skip(skipReason);
  const r = await operate({ op: 'dropCollection', database: 'app', collection: 'users' });
  assert.equal(r.dropped, true);
  assert.deepEqual((await api('GET', '/connections/m/databases/app/collections')).json.collections, []);
});
