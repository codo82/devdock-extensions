// API senza un server MongoDB: password solo nel vault, validazione, sola lettura, token di
// conferma legato all'operazione, strumenti MCP solo con il vault sbloccato
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startServer, mcpClient } = require('devdock/testkit');

const EXT = path.join(__dirname, '..');
let srv, mcp;
before(async () => {
  srv = await startServer({ projects: [] }, { install: [EXT] });
  mcp = await mcpClient(srv);
});
after(async () => { await mcp?.close(); await srv?.stop(); });

const api = (method, p, body) => srv.request(method, `${p.startsWith('/vault') ? '/api/core' : '/api/ext/mongo-client'}${p}`, { body });

test('connessioni: password cifrata nel vault, mai in chiaro né restituita', async () => {
  assert.deepEqual((await api('GET', '/connections')).json.connections, []);
  // senza vault la password non si può salvare
  let r = await api('POST', '/connections', { id: 'loc', label: 'Locale', host: '127.0.0.1', port: 27017, user: 'app', password: 'segreta-mongo' });
  assert.equal(r.status, 423);
  assert.equal(r.json.code, 'core.vault_missing');
  assert.equal((await api('POST', '/vault/init', { password: 'master-password-mongo' })).status, 200);
  r = await api('POST', '/connections', { id: 'loc', label: 'Locale', host: '127.0.0.1', port: 27017, user: 'app', password: 'segreta-mongo' });
  assert.equal(r.status, 200);
  assert.equal(r.json.hasPassword, true);
  assert.equal(r.json.password, undefined);
  const saved = srv.readConfig().mongoConnections[0];
  assert.ok(saved.password.iv && saved.password.data);
  assert.doesNotMatch(JSON.stringify(srv.readConfig()), /segreta-mongo/);
  // password invariata se non inviata, rimossa con null
  r = await api('PUT', '/connections/loc', { label: 'Locale 2', host: '127.0.0.1', port: 27018, user: 'app' });
  assert.equal(r.json.hasPassword, true);
  assert.equal(r.json.port, 27018);
  r = await api('PUT', '/connections/loc', { label: 'Locale 2', host: '127.0.0.1', port: 27018, user: 'app', password: null });
  assert.equal(r.json.hasPassword, false);
  assert.equal((await api('POST', '/connections', { id: 'loc', label: 'x', host: 'h', port: 1 })).json.code, 'mongo-client.connection_exists');
});

test('validazione: URI con password, host e porta, nomi di database e collezioni', async () => {
  let r = await api('POST', '/connections', { id: 'atlas', label: 'Atlas', uri: 'mongodb+srv://app:segreta@cluster0.example.invalid/' });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'mongo-client.connection_uri_password');
  r = await api('POST', '/connections', { id: 'atlas', label: 'Atlas', uri: 'http://cluster0.example.invalid/' });
  assert.equal(r.json.code, 'mongo-client.connection_uri');
  r = await api('POST', '/connections', { id: 'atlas', label: 'Atlas', uri: 'mongodb+srv://cluster0.example.invalid/?retryWrites=true', user: 'app' });
  assert.equal(r.status, 200);
  assert.equal(r.json.host, undefined);
  r = await api('POST', '/connections', { id: 'bad', label: 'Bad', host: 'a b', port: 27017 });
  assert.equal(r.json.code, 'mongo-client.connection_host');
  r = await api('POST', '/connections', { id: 'bad', label: 'Bad', host: 'h', port: 70000 });
  assert.equal(r.json.code, 'mongo-client.connection_port');
  r = await api('POST', '/connections', { id: 'tun', label: 'Tun', tunnel: 'missing' });
  assert.equal(r.status, 400);
  assert.match(r.json.code, /^mongo-client\.tunnel/);
  r = await api('POST', '/connections/atlas/operation', { op: { op: 'dropCollection', database: 'a.b', collection: 'x' } });
  assert.equal(r.json.code, 'mongo-client.database_invalid');
  r = await api('POST', '/connections/atlas/operation', { op: { op: 'dropCollection', database: 'app', collection: 'system.users' } });
  assert.equal(r.json.code, 'mongo-client.collection_invalid');
  r = await api('POST', '/connections/nope/operation', { op: {} });
  assert.equal(r.status, 404);
});

test('modifiche: anteprima e token legato all\'operazione; sola lettura rifiuta', async () => {
  await api('POST', '/connections', { id: 'rw', label: 'RW', host: '127.0.0.1', port: 9 });
  await api('POST', '/connections', { id: 'ro', label: 'RO', host: '127.0.0.1', port: 9, readOnly: true });
  const op = { op: 'insertOne', database: 'app', collection: 'users', document: '{"name": "Ada", "at": {"$date": "2026-01-02T03:04:05Z"}}' };
  let r = await api('POST', '/connections/rw/operation', { op });
  assert.equal(r.status, 200);
  assert.equal(r.json.preview, 'db.getSiblingDB("app").getCollection("users").insertOne({\n  name: "Ada",\n  at: ISODate("2026-01-02T03:04:05.000Z")\n})');
  assert.match(r.json.token, /^[0-9a-f]{64}$/);
  const { token } = r.json;
  // stesso token su un'altra operazione o un'altra connessione: rifiutato senza toccare il database
  r = await api('POST', '/connections/rw/operation', { op: { ...op, document: '{"name": "Eve"}' }, token });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'mongo-client.confirmation_mismatch');
  r = await api('POST', '/connections/ro/operation', { op, token });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'mongo-client.read_only');
  // eliminazione per _id, anche di tipi diversi
  r = await api('POST', '/connections/rw/operation', { op: { op: 'deleteMany', database: 'app', collection: 'users', ids: '[{"$oid": "65a1b2c3d4e5f60718293a4b"}, 7]' } });
  assert.equal(r.json.count, 2);
  assert.equal(r.json.dangerous, true);
  assert.match(r.json.preview, /deleteMany\(\{ _id: \{ \$in: \[ ObjectId\("65a1b2c3d4e5f60718293a4b"\), 7 \] \} \}\)/);
  // _id non modificabile, JSON non valido, operazione sconosciuta
  r = await api('POST', '/connections/rw/operation', { op: { op: 'replaceOne', database: 'app', collection: 'users', id: '1', document: '{"_id": 2}' } });
  assert.equal(r.json.code, 'mongo-client.id_changed');
  r = await api('POST', '/connections/rw/operation', { op: { op: 'insertOne', database: 'app', collection: 'users', document: '{bad' } });
  assert.equal(r.json.code, 'mongo-client.json_invalid');
  r = await api('POST', '/connections/rw/operation', { op: { op: 'updateMany', database: 'app', collection: 'users' } });
  assert.equal(r.json.code, 'mongo-client.operation_invalid');
});

test('MCP: niente con il vault bloccato, nessuna credenziale', async () => {
  const call = (name, args = {}) => mcp.callTool({ name, arguments: args });
  let r = await call('mongo_client_connections');
  assert.equal(r.structuredContent.connections.find(c => c.id === 'atlas').host, 'cluster0.example.invalid');
  assert.doesNotMatch(r.content[0].text, /password|"user"/);
  assert.equal((await api('POST', '/vault/lock', {})).status, 200);
  r = await call('mongo_client_connections');
  assert.equal(r.structuredContent.code, 'mongo-client.mcp_vault_locked');
  r = await call('mongo_client_find', { connection: 'rw', database: 'app', collection: 'users' });
  assert.equal(r.structuredContent.code, 'mongo-client.mcp_vault_locked');
});
