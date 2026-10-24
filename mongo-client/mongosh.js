// Sintassi di mongosh per l'editor: un'istruzione per volta, letta senza eseguire codice.
// Valori letterali di JavaScript (oggetti con chiavi senza virgolette, stringhe con ' o ",
// espressioni regolari) e i costruttori della shell (ObjectId, ISODate, NumberLong, …).
//
//   show dbs | show collections | use <db>
//   db.<coll>.<metodo>(…)[.<modificatore>(…)…]   db.getCollection("x").…   db["x"].…
//   db.<metodo>(…)                                db.getSiblingDB("y").…
//
// Il risultato descrive l'istruzione ({ type, database?, collection?, method, args, chain })
// e se è una lettura o una modifica (che va confermata).
const { BSON } = require('mongodb');

class ShellError extends Error {
  constructor(key, params = {}) { super(key); this.key = key; this.params = params; }
}

// ---- valori ----

const CONSTRUCTORS = {
  ObjectId: a => (a.length ? new BSON.ObjectId(str(a[0], 'ObjectId')) : new BSON.ObjectId()),
  ISODate: a => date(a),
  Date: a => date(a),
  NumberLong: a => BSON.Long.fromString(String(num(a[0] ?? 0, 'NumberLong'))),
  Long: a => BSON.Long.fromString(String(num(a[0] ?? 0, 'Long'))),
  NumberInt: a => new BSON.Int32(Number(num(a[0] ?? 0, 'NumberInt'))),
  Int32: a => new BSON.Int32(Number(num(a[0] ?? 0, 'Int32'))),
  Double: a => new BSON.Double(Number(num(a[0] ?? 0, 'Double'))),
  NumberDecimal: a => BSON.Decimal128.fromString(String(num(a[0] ?? '0', 'NumberDecimal'))),
  Decimal128: a => BSON.Decimal128.fromString(String(num(a[0] ?? '0', 'Decimal128'))),
  UUID: a => (a.length ? new BSON.UUID(str(a[0], 'UUID')) : new BSON.UUID()),
  Timestamp: a => new BSON.Timestamp({ t: Number(a[0] ?? 0), i: Number(a[1] ?? 0) }),
  BinData: a => new BSON.Binary(Buffer.from(str(a[1], 'BinData'), 'base64'), Number(a[0])),
  MinKey: () => new BSON.MinKey(),
  MaxKey: () => new BSON.MaxKey(),
  RegExp: a => new BSON.BSONRegExp(str(a[0], 'RegExp'), a[1] === undefined ? '' : str(a[1], 'RegExp')),
};

function str(v, what) {
  if (typeof v !== 'string') throw new ShellError('shell_argument', { what });
  return v;
}
function num(v, what) {
  if (typeof v === 'number' || typeof v === 'string') return v;
  throw new ShellError('shell_argument', { what });
}
function date(a) {
  if (!a.length) return new Date();
  const d = new Date(a[0]);
  if (Number.isNaN(d.getTime())) throw new ShellError('shell_argument', { what: 'ISODate' });
  return d;
}

// Lettore a cursore sul testo; gli errori riportano la posizione (riga e colonna)
function reader(src) {
  let i = 0;
  const where = (at = i) => {
    const before = src.slice(0, at);
    const line = before.split('\n').length;
    return { line, column: at - before.lastIndexOf('\n'), near: src.slice(at, at + 20).split('\n')[0] || '…' };
  };
  const fail = (key = 'shell_syntax', at = i) => new ShellError(key, where(at));

  function ws() {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src.startsWith('//', i)) { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (src.startsWith('/*', i)) {
        const end = src.indexOf('*/', i + 2);
        if (end < 0) throw fail();
        i = end + 2;
        continue;
      }
      return;
    }
  }
  const peek = () => { ws(); return src[i]; };
  const eat = ch => { if (peek() === ch) { i++; return true; } return false; };
  const expect = ch => { if (!eat(ch)) throw fail(); };

  function ident() {
    ws();
    const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
    if (!m) return null;
    i += m[0].length;
    return m[0];
  }

  function string() {
    const q = src[i++];
    let out = '';
    while (i < src.length && src[i] !== q) {
      if (src[i] === '\n') throw fail();
      if (src[i] === '\\') {
        const c = src[++i];
        const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
        if (c === 'u') {
          const hex = /^\{([0-9a-fA-F]{1,6})\}|^([0-9a-fA-F]{4})/.exec(src.slice(i + 1));
          if (!hex) throw fail();
          out += String.fromCodePoint(parseInt(hex[1] || hex[2], 16));
          i += hex[0].length + 1;
          continue;
        }
        if (c === 'x') {
          const hex = /^[0-9a-fA-F]{2}/.exec(src.slice(i + 1));
          if (!hex) throw fail();
          out += String.fromCharCode(parseInt(hex[0], 16));
          i += 3;
          continue;
        }
        if (c === '\n') { i++; continue; }
        out += map[c] ?? c;
        i++;
        continue;
      }
      out += src[i++];
    }
    if (src[i] !== q) throw fail();
    i++;
    return out;
  }

  function number() {
    const m = /^-?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(src.slice(i));
    if (!m) throw fail();
    i += m[0].length;
    return Number(m[0]);
  }

  function regex() {
    const start = i;
    i++; // '/'
    let pattern = '', inClass = false;
    while (i < src.length) {
      const c = src[i];
      if (c === '\n') throw fail('shell_syntax', start);
      if (c === '\\') { pattern += c + src[i + 1]; i += 2; continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) break;
      pattern += c;
      i++;
    }
    if (src[i] !== '/') throw fail('shell_syntax', start);
    i++;
    const flags = /^[a-z]*/.exec(src.slice(i))[0];
    i += flags.length;
    if (/[^imsxlu]/.test(flags.replace(/[gy]/g, ''))) throw fail('shell_syntax', start);
    return new BSON.BSONRegExp(pattern, flags.replace(/[gyu]/g, '').split('').sort().join(''));
  }

  function args() {
    expect('(');
    const list = [];
    if (eat(')')) return list;
    do {
      if (peek() === ')') break; // virgola finale
      list.push(value());
    } while (eat(','));
    expect(')');
    return list;
  }

  function value() {
    const c = peek();
    if (c === undefined) throw fail('shell_incomplete');
    if (c === '{') {
      i++;
      const obj = {};
      while (!eat('}')) {
        let key;
        const k = peek();
        if (k === '"' || k === "'") key = string();
        else if (/[\d-]/.test(k)) key = String(number());
        else {
          key = ident();
          if (key === null) throw fail();
        }
        if (Object.prototype.hasOwnProperty.call(obj, key)) delete obj[key]; // l'ultimo vince, come in JavaScript
        expect(':');
        obj[key] = value();
        if (!eat(',')) { expect('}'); break; }
      }
      return obj;
    }
    if (c === '[') {
      i++;
      const arr = [];
      while (!eat(']')) {
        arr.push(value());
        if (!eat(',')) { expect(']'); break; }
      }
      return arr;
    }
    if (c === '"' || c === "'") return string();
    if (c === '/') return regex();
    if (c === '-' && /^-\s*(Infinity)/.test(src.slice(i))) { i++; ident(); return -Infinity; }
    if (/[\d.-]/.test(c)) return number();
    const start = i;
    let name = ident();
    if (name === null) throw fail();
    if (name === 'new') {
      name = ident();
      if (!name || !CONSTRUCTORS[name]) throw fail('shell_unknown_value', start);
    }
    if (name === 'true') return true;
    if (name === 'false') return false;
    if (name === 'null') return null;
    if (name === 'undefined') return undefined;
    if (name === 'Infinity') return Infinity;
    if (name === 'NaN') return NaN;
    if (CONSTRUCTORS[name] && peek() === '(') return CONSTRUCTORS[name](args());
    throw fail('shell_unknown_value', start);
  }

  return { ws, peek, eat, expect, ident, value, args, string, fail, done: () => { ws(); while (eat(';')) ws(); return i >= src.length; }, at: () => i };
}

// Valore singolo (filtri e documenti scritti a mano) in sintassi della shell
function parseValue(src) {
  const r = reader(String(src));
  const v = r.value();
  if (!r.done()) throw r.fail();
  return v;
}

// ---- istruzioni ----

// Metodi delle collezioni: lettura o modifica; cursore: accetta i modificatori di find
const COLLECTION_METHODS = {
  find: { read: true, cursor: true }, findOne: { read: true }, aggregate: { read: true, cursor: true },
  countDocuments: { read: true }, estimatedDocumentCount: { read: true }, count: { read: true },
  distinct: { read: true }, getIndexes: { read: true }, indexes: { read: true }, stats: { read: true },
  insertOne: {}, insertMany: {}, updateOne: {}, updateMany: {}, replaceOne: {},
  deleteOne: { dangerous: true }, deleteMany: { dangerous: true },
  findOneAndUpdate: {}, findOneAndReplace: {}, findOneAndDelete: { dangerous: true }, bulkWrite: {},
  createIndex: {}, createIndexes: {}, dropIndex: { dangerous: true }, dropIndexes: { dangerous: true },
  drop: { dangerous: true }, renameCollection: { dangerous: true },
};
const CURSOR_MODIFIERS = ['sort', 'limit', 'skip', 'projection', 'project', 'hint', 'collation', 'maxTimeMS', 'batchSize', 'pretty', 'toArray', 'count', 'itcount', 'size', 'explain', 'comment', 'allowDiskUse'];
const DB_METHODS = {
  getCollectionNames: { read: true }, getCollectionInfos: { read: true }, stats: { read: true },
  version: { read: true }, getName: { read: true }, runCommand: {}, adminCommand: {},
  createCollection: {}, createView: {}, dropDatabase: { dangerous: true },
};
// Comandi di runCommand che leggono soltanto (gli altri vanno confermati)
const READ_COMMANDS = new Set(['ping', 'buildinfo', 'serverstatus', 'dbstats', 'collstats', 'liststats', 'listcollections', 'listindexes',
  'listdatabases', 'count', 'distinct', 'find', 'aggregate', 'explain', 'hostinfo', 'connectionstatus', 'hello', 'ismaster',
  'getparameter', 'getcmdlineopts', 'replsetgetstatus', 'validate', 'datasize', 'currentop', 'top', 'getlog', 'usersinfo', 'rolesinfo']);

const lastStage = pipeline => (Array.isArray(pipeline) && pipeline.length ? Object.keys(pipeline.at(-1) || {})[0] : null);
const writesPipeline = pipeline => ['$out', '$merge'].includes(lastStage(pipeline));

// Testo → istruzione. database: quello attivo nell'editor (usato da "db")
function parse(text, database) {
  const src = String(text ?? '').trim();
  if (!src) throw new ShellError('shell_empty');
  const simple = /^(show|use)\s+([^\s;]+)\s*;?\s*$/i.exec(src);
  if (simple) {
    const [, verb, arg] = simple;
    if (verb.toLowerCase() === 'use') return { type: 'use', database: arg, read: true };
    const what = arg.toLowerCase();
    if (what === 'dbs' || what === 'databases') return { type: 'show', what: 'databases', read: true };
    if (what === 'collections' || what === 'tables') return { type: 'show', what: 'collections', database, read: true };
    throw new ShellError('shell_unsupported', { method: `show ${arg}` });
  }

  const r = reader(src);
  if (r.ident() !== 'db') throw r.fail('shell_start');
  let db = database;
  const segments = []; // { name } (proprietà) | { name, args } (chiamata)
  for (;;) {
    if (r.eat('.')) {
      const name = r.ident();
      if (!name) throw r.fail();
      segments.push(r.peek() === '(' ? { name, args: r.args() } : { name });
    } else if (r.peek() === '[') {
      r.expect('[');
      const q = r.peek();
      if (q !== '"' && q !== "'") throw r.fail();
      const name = r.string();
      r.expect(']');
      segments.push({ name, bracket: true });
    } else break;
  }
  if (!r.done()) throw r.fail();

  // db.getSiblingDB("x")
  while (segments[0]?.args && segments[0].name === 'getSiblingDB') {
    db = str(segments.shift().args[0], 'getSiblingDB');
  }
  if (!segments.length) throw new ShellError('shell_incomplete');
  if (!db) throw new ShellError('shell_no_database');

  // metodo del database
  if (segments[0].args && segments[0].name !== 'getCollection') {
    const s = segments.shift();
    const info = DB_METHODS[s.name];
    if (!info) throw new ShellError('shell_unsupported', { method: `db.${s.name}()` });
    if (segments.length) throw new ShellError('shell_unsupported', { method: `.${segments[0].name}` });
    let read = !!info.read;
    if (s.name === 'runCommand' || s.name === 'adminCommand') {
      const cmd = s.args[0];
      if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) throw new ShellError('shell_argument', { what: s.name });
      const first = Object.keys(cmd)[0]?.toLowerCase();
      read = READ_COMMANDS.has(first) && !(first === 'aggregate' && writesPipeline(cmd.pipeline));
    }
    return { type: 'db', database: s.name === 'adminCommand' ? 'admin' : db, method: s.name, args: s.args, read, dangerous: !!info.dangerous };
  }

  // collezione: db.a.b (nome con punti), db.getCollection("x"), db["x"]
  let collection;
  if (segments[0].args) collection = str(segments.shift().args[0], 'getCollection');
  else {
    const parts = [];
    while (segments.length && !segments[0].args) parts.push(segments.shift().name);
    collection = parts.join('.');
  }
  // il primo segmento ora è il metodo
  const m = segments.shift();
  if (!m?.args) throw new ShellError('shell_incomplete');
  const info = COLLECTION_METHODS[m.name];
  if (!info) throw new ShellError('shell_unsupported', { method: `.${m.name}()` });
  const chain = [];
  for (const s of segments) {
    if (!s.args) throw new ShellError('shell_unsupported', { method: `.${s.name}` });
    if (!info.cursor || !CURSOR_MODIFIERS.includes(s.name)) throw new ShellError('shell_unsupported', { method: `.${s.name}()` });
    chain.push({ name: s.name, args: s.args });
  }
  let read = !!info.read;
  if (m.name === 'aggregate' && writesPipeline(m.args[0])) read = false;
  return { type: 'collection', database: db, collection, method: m.name, args: m.args, chain, read, dangerous: !!info.dangerous };
}

module.exports = { parse, parseValue, ShellError, READ_COMMANDS, writesPipeline, COLLECTION_METHODS, DB_METHODS, CURSOR_MODIFIERS };
