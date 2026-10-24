// Con un vero MongoDB (mongodb-memory-server): database, collezioni, documenti, modifiche
// confermate, export e strumenti MCP. Saltato quando il binario di mongod non è disponibile.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startServer, mcpClient } = require('devdock/testkit');

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

  const exp = await api('POST', `${coll}/export`, { filter: '{"_id": {"$in": [1, 2]}}', sort: '{"_id": 1}' });
  assert.equal(exp.status, 200);
  assert.match(exp.headers['content-disposition'], /users\.json/);
  assert.deepEqual(exp.json.map(d => d._id), [1, 2]);
  assert.equal((await api('POST', `${coll}/export`, { filter: '{"$bad": 1}' })).json.code, 'mongo-client.mongo');

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
});

test('eliminazione della collezione', async t => {
  if (skipReason) return t.skip(skipReason);
  const r = await operate({ op: 'dropCollection', database: 'app', collection: 'users' });
  assert.equal(r.dropped, true);
  assert.deepEqual((await api('GET', '/connections/m/databases/app/collections')).json.collections, []);
});
