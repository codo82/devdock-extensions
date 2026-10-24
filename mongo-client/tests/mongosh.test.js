// Sintassi mongosh dell'editor: valori, istruzioni, letture e modifiche, errori con posizione
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parse, parseValue, ShellError } = require('../mongosh');

test('valori: chiavi senza virgolette, stringhe con apici, costruttori della shell, regex', () => {
  const v = parseValue(`{ name: 'it\\'s', "a-b": [1, -2.5e3, true, null,], _id: ObjectId("65a1b2c3d4e5f60718293a4b"),
    at: ISODate("2026-01-02T03:04:05Z"), d: new Date('2026-01-01'), n: NumberLong("9007199254740993"), i: NumberInt(7),
    x: NumberDecimal("1.10"), re: /^a\\/b[/]c/i, u: UUID("123e4567-e89b-12d3-a456-426614174000"), // commento
    t: Timestamp(5, 2), /* blocco */ m: MinKey() }`);
  assert.equal(v.name, "it's");
  assert.deepEqual(v['a-b'], [1, -2500, true, null]);
  assert.equal(v._id.toHexString(), '65a1b2c3d4e5f60718293a4b');
  assert.equal(v.at.toISOString(), '2026-01-02T03:04:05.000Z');
  assert.ok(v.d instanceof Date);
  assert.equal(v.n.toString(), '9007199254740993');
  assert.equal(v.i._bsontype, 'Int32');
  assert.equal(v.x.toString(), '1.10');
  assert.equal(v.re.pattern, '^a\\/b[/]c');
  assert.equal(v.re.options, 'i');
  assert.equal(v.u._bsontype, 'Binary');
  assert.equal(v.t._bsontype, 'Timestamp');
  assert.equal(v.m._bsontype, 'MinKey');
});

test('istruzioni: collezione, catena del cursore, database, letture e modifiche', () => {
  let s = parse('db.users.find({ age: { $gte: 18 } }, { name: 1 }).sort({ name: -1 }).limit(5);', 'app');
  assert.deepEqual([s.type, s.database, s.collection, s.method, s.read], ['collection', 'app', 'users', 'find', true]);
  assert.deepEqual(s.chain.map(c => c.name), ['sort', 'limit']);
  s = parse('db.getSiblingDB("logs").getCollection("a.b").aggregate([{ $match: {} }])', 'app');
  assert.deepEqual([s.database, s.collection, s.read], ['logs', 'a.b', true]);
  assert.equal(parse('db.x.aggregate([{ $match: {} }, { $out: "y" }])', 'app').read, false);
  assert.equal(parse('db.x.aggregate([{ $merge: { into: "y" } }])', 'app').read, false);
  assert.equal(parse('db.foo.bar.countDocuments()', 'app').collection, 'foo.bar');
  assert.equal(parse('db["my coll"].find()', 'app').collection, 'my coll');
  s = parse('db.users.deleteMany({ old: true })', 'app');
  assert.deepEqual([s.read, s.dangerous], [false, true]);
  for (const m of ['insertOne({})', 'updateMany({}, { $set: { a: 1 } })', 'createIndex({ a: 1 })', 'drop()', 'bulkWrite([])']) assert.equal(parse(`db.x.${m}`, 'app').read, false, m);
  assert.equal(parse('db.runCommand({ ping: 1 })', 'app').read, true);
  assert.equal(parse('db.runCommand({ dropDatabase: 1 })', 'app').read, false);
  assert.equal(parse('db.adminCommand({ listDatabases: 1 })', 'app').database, 'admin');
  assert.deepEqual(parse('db.dropDatabase()', 'app'), { type: 'db', database: 'app', method: 'dropDatabase', args: [], read: false, dangerous: true });
  assert.deepEqual(parse('show dbs'), { type: 'show', what: 'databases', read: true });
  assert.deepEqual(parse('show collections', 'app'), { type: 'show', what: 'collections', database: 'app', read: true });
  assert.deepEqual(parse('use other;'), { type: 'use', database: 'other', read: true });
});

test('errori: sintassi con posizione, metodi non supportati, niente codice JavaScript', () => {
  const err = (code, key) => assert.throws(() => parse(code, 'app'), e => e instanceof ShellError && e.key === key, code);
  err('db.x.find({ a: })', 'shell_syntax');
  err('db.x.find({ a: 1 }', 'shell_syntax');
  err('db.x.find() db.y.find()', 'shell_syntax');
  err('db.x.find({ a: foo })', 'shell_unknown_value');
  err('db.x.find({ $where: function () { return true } })', 'shell_unknown_value');
  err('db.x.eval()', 'shell_unsupported');
  err('db.x.find().forEach(printjson)', 'shell_unknown_value');
  err('db.x.find().forEach()', 'shell_unsupported');
  err('db.x.insertOne({}).limit(1)', 'shell_unsupported');
  err('db.x', 'shell_incomplete');
  err('const a = 1', 'shell_start');
  err('show users', 'shell_unsupported');
  assert.throws(() => parse('db.x.find()', null), e => e.key === 'shell_no_database');
  try { parse('db.x.find({\n  a: ,\n})', 'app'); } catch (e) { assert.deepEqual([e.params.line, e.params.column], [2, 6]); }
});
