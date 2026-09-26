'use strict';
/**
 * Remplacant de `better-sqlite3` pour le mobile, sur sql.js (SQLite en
 * WebAssembly). Meme API synchrone, pour le sous-ensemble utilise :
 * new Database(chemin, opts), prepare(sql).get/all/run, exec, pragma,
 * transaction(fn), close.
 *
 * Fichiers : lus / ecrits dans le systeme de fichiers virtuel (vfs.js).
 * sql.js travaille en memoire : persister() ecrit la base dans son fichier
 * (appele en differe par le demarrage mobile, hors transaction).
 *
 * ATTACH DATABASE ? AS x : sql.js n'expose pas son systeme de fichiers, la
 * base jointe (le pack, lecture seule) est donc recopiee dans une base
 * :memory: jointe (schema + lignes, ~50 ms pour le pack). A refaire apres
 * chaque persister() : l'export de sql.js ferme et rouvre la base.
 */

const fs = require('./vfs');
const { Buffer } = require('buffer');

let SQL = null;
/** A appeler une fois, avec le module sql.js initialise. */
function initialiser(sql) { SQL = sql; }

function versParametres(args) {
  const conv = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0)
    : (v instanceof Uint8Array ? new Uint8Array(v) : v));
  if (args.length === 1 && args[0] && typeof args[0] === 'object' && !(args[0] instanceof Uint8Array) && !Array.isArray(args[0])) {
    const o = {};
    for (const [k, v] of Object.entries(args[0])) { const c = conv(v); o['@' + k] = c; o[':' + k] = c; o['$' + k] = c; }
    return o;
  }
  const plat = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
  return plat.map(conv);
}

function versLigne(o) {
  for (const k of Object.keys(o)) if (o[k] instanceof Uint8Array) o[k] = Buffer.from(o[k]);
  return o;
}

const RE_ATTACH = /^\s*ATTACH\s+DATABASE\s+\?\s+AS\s+(\w+)\s*$/i;
const RE_ECRITURE = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|ATTACH|DETACH|VACUUM)/i;

class Statement {
  constructor(base, sql) { this.base = base; this.sql = sql; }

  _prep() {
    const b = this.base;
    let st = b._cache.get(this.sql);
    if (!st) { st = b._db.prepare(this.sql); b._cache.set(this.sql, st); }
    return st;
  }

  get(...args) {
    const st = this._prep();
    st.bind(versParametres(args));
    const r = st.step() ? versLigne(st.getAsObject()) : undefined;
    st.reset();
    return r;
  }

  all(...args) {
    const st = this._prep();
    st.bind(versParametres(args));
    const out = [];
    while (st.step()) out.push(versLigne(st.getAsObject()));
    st.reset();
    return out;
  }

  run(...args) {
    const m = RE_ATTACH.exec(this.sql);
    if (m) { this.base._attacher(m[1], args[0]); return { changes: 0, lastInsertRowid: 0 }; }
    const st = this._prep();
    st.bind(versParametres(args));
    st.step();
    st.reset();
    if (RE_ECRITURE.test(this.sql)) this.base.modifiee = true;
    const id = this.base._db.exec('SELECT last_insert_rowid() AS id');
    return { changes: this.base._db.getRowsModified(), lastInsertRowid: id.length ? id[0].values[0][0] : 0 };
  }

  *iterate(...args) { yield* this.all(...args); }
}

class Database {
  constructor(chemin, { readonly = false, fileMustExist = false } = {}) {
    if (!SQL) throw new Error('sqlite mobile : initialiser() pas appele.');
    this.chemin = chemin === ':memory:' ? null : chemin;
    const existe = this.chemin && fs.existsSync(this.chemin);
    if (!existe && fileMustExist) throw new Error('Fichier absent : ' + chemin);
    const octets = existe ? new Uint8Array(fs.readFileSync(this.chemin)) : null;
    this._db = new SQL.Database(octets && octets.length ? octets : undefined);
    // Comme SQLite : le fichier existe des l'ouverture (vide jusqu'a persister()).
    if (!existe && this.chemin && !readonly) fs.writeFileSync(this.chemin, new Uint8Array(0));
    this._cache = new Map();
    this._jointes = [];      // [{ alias, chemin }]
    this._pragmas = [];      // pragmas a rejouer apres persister()
    this._profondeur = 0;
    this.readonly = readonly;
    this.modifiee = !existe && !!this.chemin;
  }

  prepare(sql) { return new Statement(this, sql); }

  exec(sql) {
    this._db.exec(sql);
    if (RE_ECRITURE.test(sql) || /\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/i.test(sql)) this.modifiee = true;
    return this;
  }

  pragma(texte, { simple = false } = {}) {
    if (/journal_mode|wal_checkpoint/i.test(texte)) return simple ? 'memory' : [];
    if (/=/.test(texte)) this._pragmas.push(texte);
    const r = this._db.exec('PRAGMA ' + texte);
    const lignes = r.length ? r[0].values.map((v) => Object.fromEntries(r[0].columns.map((c, i) => [c, v[i]]))) : [];
    return simple ? (lignes[0] ? Object.values(lignes[0])[0] : undefined) : lignes;
  }

  transaction(fn) {
    const base = this;
    return function (...args) {
      const nom = 'sp' + base._profondeur;
      base._db.exec(base._profondeur ? 'SAVEPOINT ' + nom : 'BEGIN');
      base._profondeur++;
      try {
        const r = fn.apply(this, args);
        base._profondeur--;
        base._db.exec(base._profondeur ? 'RELEASE ' + nom : 'COMMIT');
        base.modifiee = true;
        return r;
      } catch (e) {
        base._profondeur--;
        try { base._db.exec(base._profondeur ? 'ROLLBACK TO ' + nom + '; RELEASE ' + nom : 'ROLLBACK'); } catch { /* deja annulee */ }
        throw e;
      }
    };
  }

  get inTransaction() { return this._profondeur > 0; }

  /** Recopie une base (fichier du vfs) dans une base :memory: jointe. */
  _attacher(alias, chemin) {
    const src = new SQL.Database(new Uint8Array(fs.readFileSync(chemin)));
    try {
      this._db.exec(`ATTACH DATABASE ':memory:' AS ${alias}`);
      const objets = src.exec("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type = 'table' DESC");
      const lignes = objets.length ? objets[0].values : [];
      this._db.exec('BEGIN');
      for (const [type, nom, sql] of lignes) {
        if (type === 'table') {
          this._db.exec(sql.replace(/^\s*CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?/i, (m) => m + alias + '.'));
          const r = src.exec(`SELECT * FROM "${nom}"`);
          if (!r.length) continue;
          const cols = r[0].columns;
          const ins = this._db.prepare(`INSERT INTO ${alias}."${nom}" (${cols.map((c) => '"' + c + '"').join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
          for (const v of r[0].values) { ins.run(v); }
          ins.free();
        } else if (type === 'index') {
          this._db.exec(sql.replace(/^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+(IF\s+NOT\s+EXISTS\s+)?/i, (m) => m + alias + '.'));
        } else if (type === 'view') {
          this._db.exec(sql.replace(/^\s*CREATE\s+VIEW\s+(IF\s+NOT\s+EXISTS\s+)?/i, (m) => m + alias + '.'));
        }
      }
      this._db.exec('COMMIT');
    } finally { src.close(); }
    if (!this._jointes.some((j) => j.alias === alias)) this._jointes.push({ alias, chemin });
  }

  /**
   * Ecrit la base dans son fichier (hors transaction). export() de sql.js
   * ferme et rouvre la base : requetes preparees, pragmas et bases jointes
   * sont refaits. @returns {boolean} ecrite
   */
  persister() {
    if (!this.chemin || this._profondeur || !this.modifiee) return false;
    for (const st of this._cache.values()) { try { st.free(); } catch { /* deja liberee */ } }
    this._cache.clear();
    const octets = this._db.export();
    fs.writeFileSync(this.chemin, octets);
    for (const p of this._pragmas) this._db.exec('PRAGMA ' + p);
    for (const j of this._jointes) this._attacher(j.alias, j.chemin);
    this.modifiee = false;
    return true;
  }

  close() {
    this.persister();
    for (const st of this._cache.values()) { try { st.free(); } catch { /* */ } }
    this._db.close();
  }
}

Database.initialiser = initialiser;
module.exports = Database;
