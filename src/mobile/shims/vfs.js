'use strict';
/**
 * Remplacant de `fs` pour le mobile : systeme de fichiers en memoire, API
 * synchrone (le sous-ensemble utilise par les modules du processus principal),
 * sauvegarde dans IndexedDB.
 *
 * Tout est charge en memoire au demarrage (charger()) : la base utilisateur,
 * appareil.json, le journal. Seuls les chemins sous PERSISTANTS sont
 * sauvegardes, en differe (une ecriture = une sauvegarde de ce fichier au plus
 * tard 1 s apres).
 *
 * Exception (appli Android) : les photos des tuiles creees (/data/images-locales/)
 * sont de vrais fichiers de l'appli, hors memoire et hors IndexedDB
 * (vfs-externe.js) ; celles d'une version precedente sont migrees au
 * demarrage. Leur contenu se lit par fs.promises.readFile (readFileSync ne
 * les sert que pendant leur ecriture).
 */

const path = require('path-browserify');
const { Buffer } = require('buffer');

const PERSISTANTS = ['/data/'];
const EXCLUS = [];
// Journaux : ecrits a chaque evenement, sauvegardes par lots (toutes les 15 s,
// et avec tout le reste a la mise en veille) plutot qu'a chaque ligne.
const LENTS = ['/data/logs/'];
const DELAI_LENT = 15000;
let minuteurLent = null;
const BASE_IDB = 'tuiles-et-toiles';
const MAGASIN = 'fichiers';

const fichiers = new Map();   // chemin -> { octets: Uint8Array, mtime: number }
let ext = null;               // fichiers externes (vfs-externe.js), appli Android seulement
const aMigrer = [];           // photos lues dans IndexedDB, a effacer une fois le fichier natif verifie
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
  if (LENTS.some((x) => p.startsWith(x))) {
    if (!minuteurLent) minuteurLent = setTimeout(() => { minuteurLent = null; sauver(); }, DELAI_LENT);
    return;
  }
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

// Chaque fichier est range en MORCEAUX de moins de 60 Ko : au-dela, Chromium
// (WebView d'Android) range la valeur dans un fichier annexe, qui peut manquer
// si l'appli est tuee pendant l'ecriture -> « Failed to read large IndexedDB
// value » et plus rien ne se lit. Cle du fichier = { mtime, taille, n } ;
// morceaux = cle + SEP + i. Ancien format (un seul enregistrement { octets }) :
// relu, puis reecrit en morceaux.
const MORCEAU = 60000;
const SEP = '\u0000#';
const nbMorceaux = new Map();   // chemin -> n ecrit en base (pour effacer les restes)
const illisibles = [];          // fichiers ignores au chargement (journalises ensuite)

function lireCle(store, cle) {
  return new Promise((ok) => {
    const r = store.get(cle);
    r.onsuccess = () => ok({ valeur: r.result });
    // preventDefault : un enregistrement illisible ne doit pas annuler la
    // transaction (et donc la lecture de tous les autres).
    r.onerror = (e) => { e.preventDefault(); e.stopPropagation(); ok({ erreur: r.error }); };
  });
}

/**
 * Charge en memoire tous les fichiers sauvegardes. A attendre avant tout.
 * @param {{ externe?: object }} o  vfs-externe.creer(...) : photos en vrais fichiers
 */
async function charger(o = {}) {
  if (o.externe) {
    try {
      await o.externe.init();
      ext = o.externe;
      mkdirSync(ext.RACINE);
    } catch (e) { illisibles.push({ chemin: 'images-locales (fichiers)', erreur: String(e && e.message || e) }); ext = null; }
  }
  idb = await ouvrirIdb();
  const t = idb.transaction(MAGASIN, 'readonly');
  const store = t.objectStore(MAGASIN);
  const cles = await new Promise((ok, ko) => {
    const r = store.getAllKeys();
    r.onsuccess = () => ok(r.result.map(String));
    r.onerror = () => ko(r.error);
  });
  for (const cle of cles) {
    if (cle.includes(SEP)) continue;
    const { valeur, erreur: err } = await lireCle(store, cle);
    if (err || !valeur) { illisibles.push({ chemin: cle, erreur: String(err && err.message || 'vide') }); continue; }
    if (valeur.octets) {                           // ancien format : a reecrire
      if (ext && ext.estExterne(cle)) { migrerPhoto(cle, new Uint8Array(valeur.octets)); nbMorceaux.set(cle, 0); continue; }
      ecrireMemoire(cle, new Uint8Array(valeur.octets), valeur.mtime);
      aSauver.add(cle);
      continue;
    }
    const tout = new Uint8Array(valeur.taille || 0);
    let ok = true;
    for (let i = 0, pos = 0; i < valeur.n; i++) {
      const m = await lireCle(store, cle + SEP + i);
      if (m.erreur || !m.valeur) { ok = false; break; }
      const o = new Uint8Array(m.valeur);
      tout.set(o, pos); pos += o.length;
    }
    if (!ok) { illisibles.push({ chemin: cle, erreur: 'morceau manquant' }); continue; }
    nbMorceaux.set(cle, valeur.n);
    if (ext && ext.estExterne(cle)) { migrerPhoto(cle, tout); continue; }
    ecrireMemoire(cle, tout, valeur.mtime);
  }
  if (aSauver.size) planifier([...aSauver][0]);   // migration vers les morceaux
}

// Photo d'une version precedente (dans IndexedDB) -> fichier de l'appli. Un
// fichier natif deja la a la meme taille n'est pas reecrit.
function migrerPhoto(cle, octets) {
  const st = ext.stat(cle);
  if (!st || st.taille !== octets.length) ext.ecrire(cle, octets);
  aMigrer.push({ cle, taille: octets.length });
}

/**
 * Fin de la migration des photos (en arriere-plan, apres le demarrage) : chaque
 * copie IndexedDB n'est effacee qu'une fois le fichier natif relu a la bonne
 * taille. Renvoie le bilan (journalise par l'appelant).
 */
async function finirMigration() {
  if (!ext || !aMigrer.length) return null;
  await ext.vider();
  const bilan = { photos: aMigrer.length, effacees: 0, gardees: [] };
  for (const { cle, taille } of aMigrer.splice(0)) {
    const nom = cle.slice(ext.RACINE.length + 1);
    if (await ext.tailleNative(nom) === taille) { planifier(cle, true); bilan.effacees++; }
    else bilan.gardees.push(nom);
  }
  await sauver();
  return bilan;
}

/** Sauvegarde ce qui a change (appele en differe ; aussi a la mise en veille). */
function sauver() {
  // Photos (fichiers natifs) : leur ecriture en cours se termine aussi.
  if (ext) return Promise.all([sauverIdb(), ext.vider()]).then(() => {});
  return sauverIdb();
}

function sauverIdb() {
  if (!idb || (!aSauver.size && !aSupprimer.size)) return Promise.resolve();
  const ecrire = [...aSauver]; const effacer = [...aSupprimer];
  aSauver.clear(); aSupprimer.clear();
  return new Promise((ok) => {
    const t = idb.transaction(MAGASIN, 'readwrite');
    const s = t.objectStore(MAGASIN);
    const avant = new Map(nbMorceaux);
    for (const p of ecrire) {
      const f = fichiers.get(p);
      if (!f) continue;
      const n = Math.max(1, Math.ceil(f.octets.length / MORCEAU));
      for (let i = 0; i < n; i++) s.put(f.octets.slice(i * MORCEAU, (i + 1) * MORCEAU), p + SEP + i);
      for (let i = n; i < (avant.get(p) || 0); i++) s.delete(p + SEP + i);
      s.put({ mtime: f.mtime, taille: f.octets.length, n }, p);
      nbMorceaux.set(p, n);
    }
    for (const p of effacer) {
      for (let i = 0; i < (avant.get(p) || 0); i++) s.delete(p + SEP + i);
      s.delete(p);
      nbMorceaux.delete(p);
    }
    t.oncomplete = () => ok();
    t.onerror = () => { for (const p of ecrire) aSauver.add(p); for (const [k, v] of avant) nbMorceaux.set(k, v); ok(); };
  });
}

// --- API fs ----------------------------------------------------------------------

function ecrireMemoire(p, octets, mtime = Date.now()) {
  let d = parent(p);
  while (!dossiers.has(d)) { dossiers.add(d); d = parent(d); }
  fichiers.set(p, { octets, mtime });
}

/** Octets en memoire par dossier (rapport d'erreur) : { '/data/images-locales': { fichiers, octets } … }. */
function occupation() {
  const r = {};
  if (ext) {
    const o = ext.occupation();
    // Sur disque, pas en memoire : seuls les octets en cours d'ecriture le sont.
    r['/data/images-locales (fichiers)'] = { fichiers: o.fichiers, octets: o.octets, surDisque: true };
    if (o.enMemoire) r['/data/images-locales (en cours)'] = { fichiers: 0, octets: o.enMemoire };
  }
  for (const [p, f] of fichiers) {
    const d = p.startsWith('/data/') ? p.split('/').slice(0, 3).join('/') : p.split('/').slice(0, 2).join('/');
    const e = r[d] || (r[d] = { fichiers: 0, octets: 0 });
    e.fichiers++;
    e.octets += f.octets.length;
  }
  return r;
}

function existsSync(p) { p = norm(p); return (ext && ext.estExterne(p)) ? ext.existe(p) : fichiers.has(p) || dossiers.has(p); }

function statSync(p) {
  p = norm(p);
  if (ext && ext.estExterne(p)) {
    const m = ext.stat(p);
    if (!m) throw erreur('ENOENT', p);
    const mtime = new Date(m.mtime);
    return { size: m.taille, mtime, mtimeMs: mtime.getTime(), isFile: () => true, isDirectory: () => false };
  }
  const f = fichiers.get(p);
  if (!f && !dossiers.has(p)) throw erreur('ENOENT', p);
  const mtime = new Date(f ? f.mtime : 0);
  return { size: f ? f.octets.length : 0, mtime, mtimeMs: mtime.getTime(), isFile: () => !!f, isDirectory: () => !f };
}

function readFileSync(p, enc) {
  p = norm(p);
  if (ext && ext.estExterne(p)) {
    const o = ext.enAttente(p);
    if (!o) throw erreur(ext.existe(p) ? 'EASYNC' : 'ENOENT', p + ' (photo : lire par fs.promises.readFile)');
    const e = typeof enc === 'string' ? enc : enc && enc.encoding;
    return e ? Buffer.from(o).toString(e) : Buffer.from(o);
  }
  const f = fichiers.get(p);
  if (!f) throw erreur('ENOENT', p);
  const b = Buffer.from(f.octets);
  const e = typeof enc === 'string' ? enc : enc && enc.encoding;
  return e ? b.toString(e) : b;
}

function writeFileSync(p, data, enc) {
  p = norm(p);
  if (ext && ext.estExterne(p)) { ext.ecrire(p, versOctets(data, enc)); return; }
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
  if (ext && p === ext.RACINE) for (const n of ext.noms()) noms.add(n);
  for (const k of [...fichiers.keys(), ...dossiers]) {
    if (k !== p && k.startsWith(pref)) noms.add(k.slice(pref.length).split('/')[0]);
  }
  return [...noms].sort();
}

function rmSync(p, { force = false, recursive = false } = {}) {
  p = norm(p);
  if (ext && ext.estExterne(p)) {
    if (ext.existe(p)) { ext.supprimer(p); return; }
    if (!force) throw erreur('ENOENT', p);
    return;
  }
  if (ext && recursive && (p === ext.RACINE || ext.RACINE.startsWith(p + '/'))) for (const n of ext.noms()) ext.supprimer(ext.RACINE + '/' + n);
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
  if (ext && ext.estExterne(de)) {
    if (!ext.estExterne(vers)) throw erreur('EXDEV', de + ' -> ' + vers);
    if (!ext.renommer(de, vers)) throw erreur('ENOENT', de);
    return;
  }
  if (ext && ext.estExterne(vers)) {
    const f0 = fichiers.get(de);
    if (!f0) throw erreur('ENOENT', de);
    ext.ecrire(vers, f0.octets);
    fichiers.delete(de); planifier(de, true);
    return;
  }
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
  // Versions asynchrones (transport-dossier.ecrireAtomique, utilise aussi par le
  // transport Drive pour ranger les images recues).
  promises: {
    mkdir: async (p, o) => mkdirSync(p, o),
    writeFile: async (p, d, e) => writeFileSync(p, d, e),
    readFile: async (p, e) => {
      const n = norm(p);
      if (ext && ext.estExterne(n)) {
        const o = Buffer.from(await ext.lire(n));
        const enc = typeof e === 'string' ? e : e && e.encoding;
        return enc ? o.toString(enc) : o;
      }
      return readFileSync(p, e);
    },
    rename: async (a, b) => renameSync(a, b),
    readdir: async (p) => readdirSync(p),
    rm: async (p, o) => rmSync(p, o),
    unlink: async (p) => rmSync(p),
    stat: async (p) => statSync(p),
    access: async (p) => accessSync(p),
    copyFile: async (a, b) => copyFileSync(a, b)
  },
  // propres au mobile
  charger, sauver, _fichiers: fichiers, illisibles: () => illisibles.slice(), occupation, finirMigration,
  // Photos (fichiers natifs) : adresse pour <img>, octets en cours d'ecriture.
  adresseExterne: (p) => (ext && ext.estExterne(norm(p)) ? ext.adresse(norm(p)) : null),
  enAttenteExterne: (p) => (ext && ext.estExterne(norm(p)) ? ext.enAttente(norm(p)) : null),
  externeActif: () => !!ext
};
