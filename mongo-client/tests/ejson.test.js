// Extended JSON: lettura dell'input, risultati senza perdita di cifre, anteprime come in mongosh
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toJson, parse, shell, EjsonError, BSON } = require('../ejson');

test('parse: oggetti vuoti, tipi speciali, errori', () => {
  assert.deepEqual(parse('', 'filter'), {});
  assert.deepEqual(parse(undefined, 'filter'), {});
  const f = parse('{"_id": {"$oid": "65a1b2c3d4e5f60718293a4b"}, "at": {"$date": "2026-01-02T03:04:05Z"}}', 'filter');
  assert.equal(f._id._bsontype, 'ObjectId');
  assert.ok(f.at instanceof Date);
  assert.equal(parse({ n: { $numberLong: '9007199254740993' } }, 'doc').n._bsontype, 'Long');
  assert.throws(() => parse('{nope', 'filter'), e => e instanceof EjsonError && e.key === 'json_invalid' && e.params.what === 'filter');
  assert.throws(() => parse('[1,2]', 'filter'), e => e.key === 'json_not_object');
  assert.deepEqual(parse('[1,2]', 'ids', { object: false }).map(Number), [1, 2]);
  assert.equal(parse('"abc"', 'id', { object: false }), 'abc');
});

test('interi a 64 bit: nessuna cifra persa, restano Long dopo una modifica', () => {
  const doc = { a: BSON.Long.fromString('42'), b: BSON.Long.fromString('9007199254740993'), c: [BSON.Long.fromString('-9007199254740995')], n: 7 };
  const json = toJson(doc);
  assert.deepEqual(json, { a: { $numberLong: '42' }, b: { $numberLong: '9007199254740993' }, c: [{ $numberLong: '-9007199254740995' }], n: 7 });
  const back = parse(JSON.stringify(json), 'document');
  assert.equal(back.a._bsontype, 'Long');
  assert.equal(back.b.toString(), '9007199254740993');
  assert.equal(back.n._bsontype, 'Int32');
  assert.equal(parse('{"x": 1.5, "y": 3000000000}', 'document').y._bsontype, 'Long');
  const id = new BSON.ObjectId('65a1b2c3d4e5f60718293a4b');
  assert.deepEqual(toJson({ _id: id, d: new Date('2026-01-02T03:04:05Z'), x: BSON.Decimal128.fromString('1.10') }),
    { _id: { $oid: '65a1b2c3d4e5f60718293a4b' }, d: { $date: '2026-01-02T03:04:05Z' }, x: { $numberDecimal: '1.10' } });
});

test('shell: sintassi di mongosh', () => {
  const v = parse('{"_id": {"$oid": "65a1b2c3d4e5f60718293a4b"}, "n": 1, "tags": ["a"], "sub": {"at": {"$date": "2026-01-02T03:04:05Z"}}}', 'doc');
  assert.equal(shell(v), '{\n  _id: ObjectId("65a1b2c3d4e5f60718293a4b"),\n  n: 1,\n  tags: [ "a" ],\n  sub: {\n    at: ISODate("2026-01-02T03:04:05.000Z")\n  }\n}');
  assert.equal(shell({ 'a-b': null }), '{\n  "a-b": null\n}');
});
