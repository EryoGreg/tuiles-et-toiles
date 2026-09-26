'use strict';
/**
 * Remplacant de `fs` pour le mobile : systeme de fichiers en memoire, API
 * synchrone (le sous-ensemble utilise par les modules du processus principal),
 * sauvegarde dans IndexedDB.
 *
 * Tout est charge en memoire au demarrage (charger()) : la base utilisateur,
 * appareil.json, les images des tuiles creees. Seuls les chemins sous
 * PERSISTANTS sont sauvegardes, en differe (une ecriture = une sauvegarde de
 * ce fichier au plus tard 1 s apres) ; les journaux restent en memoire.
 */

const path = require('path-browserify');
const { Buffer } = require('buffer');

const PERSISTANTS = ['/data/'];
const EXCLUS = ['/data/logs/'];
const BASE_IDB = 'tuiles-et-toiles';
const MAGASIN = 'fichiers';

const fichiers = new Map();   // chemin -> { octets: Uint8Array, mtime: number }
const dossiers = new Set(['/']);
const aSauver = new Set();
const aSupprimer = new Set();
let minuteur = null;

const norm = (p) => path.resolve('/', String(p).replace(/\\/g, '/'));
const parent = (p) => path.dirname(p);
const persistant = (p) => PERSISTANTS.some((x) => p.startsWith(x)) && !EXCLUS.some((x) => p.startsWith(x));

function erreur(code, p) {
  const e = new Error(code + ': ' + p);
  e.code = code;
  return e;
}

function versOctets(data, enc) {
  if (data instanceof Uint8Array) return new Uint8Array(data);
  if (typeof data === 'string') return new Uint8Array(Buffer.from(data, typeof enc === 'string' ? enc : (enc && enc.encoding) || 'utf8'));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(Buffer.from(String(data)));
}

function planifier(p, suppression = false) {
  if (!persistant(p)) return;
  if (suppression) { aSauver.delete(p); aSupprimer.add(p); } else { aSupprimer.delete(p); aSauver.add(p); }
  if (!minuteur) minuteur = setTimeout(() => { minuteur = null; sauver(); }, 1000);
}

// --- IndexedDB -----------------------------------------------------------------

function ouvrirIdb() {
  return new Promise((ok, ko) => {
    const r = indexedDB.open(BASE_IDB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(MAGASIN); };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => ko(r.error);
  });
}
let idb = null;

/** Charge en memoire tous les fichiers sauvegardes. A attendre avant tout. */
async function charger() {
  idb = await ouvrirIdb();
  await new Promise((ok, ko) => {
    const t = idb.transaction(MAGASIN, 'readonly');
    const req = t.objectStore(MAGASIN).openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) { ok(); return; }
      const { octets, mtime } = c.value;
      ecrireMemoire(String(c.key), new Uint8Array(octets), mtime);
      c.continue();
    };
    req.onerror = () => ko(req.error);
  });
}

/** Sauvegarde ce qui a change (appele en differe ; aussi a la mise en veille). */
function sauver() {
  if (!idb || (!aSauver.size && !aSupprimer.size)) return Promise.resolve();
  const ecrire = [...aSauver]; const effacer = [...aSupprimer];
  aSauver.clear(); aSupprimer.clear();
  return new Promise((ok) => {
    const t = idb.transaction(MAGASIN, 'readwrite');
    const s = t.objectStore(MAGASIN);
    for (const p of ecrire) { const f = fichiers.get(p); if (f) s.put({ octets: f.octets, mtime: f.mtime }, p); }
    for (const p of effacer) s.delete(p);
    t.oncomplete = () => ok();
    t.onerror = () => { for (const p of ecrire) aSauver.add(p); ok(); };
  });
}

// --- API fs ----------------------------------------------------------------------

function ecrireMemoire(p, octets, mtime = Date.now()) {
  let d = parent(p);
  while (!dossiers.has(d)) { dossiers.add(d); d = parent(d); }
  fichiers.set(p, { octets, mtime });
}

function existsSync(p) { p = norm(p); return fichiers.has(p) || dossiers.has(p); }

function statSync(p) {
  p = norm(p);
  const f = fichiers.get(p);
  if (!f && !dossiers.has(p)) throw erreur('ENOENT', p);
  const mtime = new Date(f ? f.mtime : 0);
  return { size: f ? f.octets.length : 0, mtime, mtimeMs: mtime.getTime(), isFile: () => !!f, isDirectory: () => !f };
}

function readFileSync(p, enc) {
  p = norm(p);
  const f = fichiers.get(p);
  if (!f) throw erreur('ENOENT', p);
  const b = Buffer.from(f.octets);
  const e = typeof enc === 'string' ? enc : enc && enc.encoding;
  return e ? b.toString(e) : b;
}

function writeFileSync(p, data, enc) {
  p = norm(p);
  ecrireMemoire(p, versOctets(data, enc));
  planifier(p);
}

function appendFileSync(p, data, enc) {
  p = norm(p);
  const avant = fichiers.get(p);
  const plus = versOctets(data, enc);
  if (!avant) { writeFileSync(p, plus); return; }
  const tout = new Uint8Array(avant.octets.length + plus.length);
  tout.set(avant.octets); tout.set(plus, avant.octets.length);
  ecrireMemoire(p, tout);
  planifier(p);
}

function mkdirSync(p) {
  p = norm(p);
  while (!dossiers.has(p)) { dossiers.add(p); p = parent(p); }
}

function readdirSync(p) {
  p = norm(p);
  if (!dossiers.has(p)) throw erreur('ENOENT', p);
  const pref = p === '/' ? '/' : p + '/';
  const noms = new Set();
  for (const k of [...fichiers.keys(), ...dossiers]) {
    if (k !== p && k.startsWith(pref)) noms.add(k.slice(pref.length).split('/')[0]);
  }
  return [...noms].sort();
}

function rmSync(p, { force = false, recursive = false } = {}) {
  p = norm(p);
  if (fichiers.has(p)) { fichiers.delete(p); planifier(p, true); return; }
  if (dossiers.has(p)) {
    if (!recursive) throw erreur('EISDIR', p);
    for (const k of [...fichiers.keys()]) if (k.startsWith(p + '/')) { fichiers.delete(k); planifier(k, true); }
    for (const k of [...dossiers]) if (k === p || k.startsWith(p + '/')) dossiers.delete(k);
    return;
  }
  if (!force) throw erreur('ENOENT', p);
}

function renameSync(de, vers) {
  de = norm(de); vers = norm(vers);
  const f = fichiers.get(de);
  if (!f) throw erreur('ENOENT', de);
  fichiers.delete(de); planifier(de, true);
  ecrireMemoire(vers, f.octets); planifier(vers);
}

function copyFileSync(de, vers) { writeFileSync(vers, readFileSync(de)); }
function accessSync(p) { if (!existsSync(p)) throw erreur('ENOENT', p); }
const unlinkSync = (p) => rmSync(p);

module.exports = {
  existsSync, statSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, rmSync,
  renameSync, copyFileSync, accessSync, unlinkSync,
  constants: { W_OK: 2, R_OK: 4, F_OK: 0 },
  promises: {},
  // propres au mobile
  charger, sauver, _fichiers: fichiers
};
