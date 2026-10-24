// Extended JSON dei documenti: lettura dell'input dell'utente (filtri, documenti) e scrittura
// dei risultati. Risultati in formato "relaxed" (numeri e stringhe come in JSON, ObjectId, date e
// decimali come {"$oid"}, {"$date"}, {"$numberDecimal"}), con gli interi a 64 bit sempre come
// {"$numberLong": "…"}: non perdono cifre e restano Long quando il documento viene salvato.
// L'input è letto in modo canonico per lo stesso motivo (interi piccoli → Int32, con decimali →
// Double, oltre i 32 bit o {"$numberLong"} → Long).
const { BSON } = require('mongodb');

const { EJSON } = BSON;

class EjsonError extends Error {
  constructor(key, params = {}) { super(key); this.key = key; this.params = params; }
}

const isPlain = v => v && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

// Long → {"$numberLong"} (il formato relaxed li renderebbe numeri)
function protectLongs(v) {
  if (v && v._bsontype === 'Long') return { $numberLong: v.toString() };
  if (Array.isArray(v)) return v.map(protectLongs);
  if (isPlain(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, protectLongs(x)]));
  return v;
}

// Documento BSON → oggetto JSON (relaxed)
const toJson = doc => EJSON.serialize(protectLongs(doc), { relaxed: true });

// Testo o oggetto dell'utente → valore BSON. what: nome del campo per l'errore
function parse(input, what, { object = true } = {}) {
  if (input === undefined || input === null || input === '') return object ? {} : null;
  let value;
  try {
    value = typeof input === 'string' ? EJSON.parse(input, { relaxed: false }) : EJSON.deserialize(input, { relaxed: false });
  } catch (e) { throw new EjsonError('json_invalid', { what, error: e.message }); }
  if (object && !isPlain(value)) throw new EjsonError('json_not_object', { what });
  return value;
}

// Rappresentazione leggibile di un valore BSON nella sintassi di mongosh (per le conferme)
function shell(v, indent = '') {
  if (v === null) return 'null';
  if (v instanceof Date) return `ISODate(${JSON.stringify(v.toISOString())})`;
  if (v && v._bsontype === 'ObjectId') return `ObjectId(${JSON.stringify(v.toHexString())})`;
  if (v && v._bsontype === 'Decimal128') return `NumberDecimal(${JSON.stringify(v.toString())})`;
  if (v && v._bsontype === 'Long') return `NumberLong(${JSON.stringify(v.toString())})`;
  if (v && v._bsontype === 'Binary') return `BinData(${v.sub_type}, ${JSON.stringify(v.toString('base64'))})`;
  if (v && v._bsontype === 'Int32' || v && v._bsontype === 'Double') return String(v.valueOf());
  if (Array.isArray(v)) return v.length ? `[ ${v.map(x => shell(x, indent)).join(', ')} ]` : '[]';
  if (v && typeof v === 'object' && !v._bsontype) {
    const entries = Object.entries(v);
    if (!entries.length) return '{}';
    const inner = indent + '  ';
    return `{\n${entries.map(([k, x]) => `${inner}${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${shell(x, inner)}`).join(',\n')}\n${indent}}`;
  }
  if (v && v._bsontype) return EJSON.stringify(v);
  return JSON.stringify(v);
}

module.exports = { toJson, parse, shell, EjsonError, EJSON, BSON };
