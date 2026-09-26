'use strict';
/**
 * Mobile : adresse a donner a <img> pour une image tuile://.
 *
 * Pas de protocole tuile:// dans une WebView : les modules produisent
 * « tuile://<nom> » (grande image) et « tuile://mini/<nom> » (vignette), le
 * pont mobile les traduit ici, de facon synchrone :
 *   - image d'une tuile creee (vfs /data/images-locales) -> URL blob
 *   - vignette du pack -> fichier livre avec l'appli (vignettes/<nom>)
 *   - grande image du pack en cache (IndexedDB) -> URL blob
 *   - sinon, en ligne : l'adresse GitHub (fige par le tag du manifeste), et
 *     le telechargement verifie vers le cache demarre ; hors ligne : vignette
 *
 * Cache : IndexedDB « images » (nom -> Blob), liste des noms en memoire.
 */

const fs = require('fs');
const { sha256 } = require('@noble/hashes/sha2.js');

const DEPOT = 'EryoGreg/tuiles-et-toiles';
const BASE_IDB = 'tuiles-et-toiles-images';
let idb = null;
let manifeste = { ref: null, images: {} };
let dossierLocales = '/data/images-locales';
const enCache = new Set();
const urls = new Map();       // cle -> URL blob
const enVol = new Map();
const ecouteurs = new Set();  // notifies quand une grande image arrive
const pretes = new Map();     // nom -> URL blob d'une grande image en cache

function ouvrirIdb() {
  return new Promise((ok, ko) => {
    const r = indexedDB.open(BASE_IDB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('images');
    r.onsuccess = () => ok(r.result);
    r.onerror = () => ko(r.error);
  });
}

/** @param {{ manifeste: object, locales?: string }} o */
async function configurer(o) {
  manifeste = o.manifeste || manifeste;
  if (o.locales) dossierLocales = o.locales;
  idb = await ouvrirIdb();
  // Grandes images en cache : adresses pretes des le demarrage (les Blob
  // d'IndexedDB sont des references, rien n'est lu en memoire).
  await new Promise((ok) => {
    const req = idb.transaction('images', 'readonly').objectStore('images').openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) { ok(); return; }
      const nom = String(c.key);
      enCache.add(nom);
      pretes.set(nom, URL.createObjectURL(c.value));
      c.continue();
    };
    req.onerror = () => ok();
  });
}

const vignette = (nom) => 'vignettes/' + nom.replace(/\.(png|jpe?g)$/i, '.jpg');
const distante = (nom) => 'https://raw.githubusercontent.com/' + DEPOT + '/' + manifeste.ref + '/data/images/' + encodeURIComponent(nom);

function urlBlob(cle, octets, type = 'image/jpeg') {
  if (!urls.has(cle)) urls.set(cle, URL.createObjectURL(new Blob([octets], { type })));
  return urls.get(cle);
}

function lireCache(nom) {
  return new Promise((ok) => {
    const req = idb.transaction('images', 'readonly').objectStore('images').get(nom);
    req.onsuccess = () => ok(req.result || null);
    req.onerror = () => ok(null);
  });
}

/** Telecharge et verifie une grande image, puis la range dans le cache. */
function telecharger(nom) {
  const info = manifeste.images[nom];
  if (!info || !idb || enCache.has(nom)) return Promise.resolve(enCache.has(nom));
  if (enVol.has(nom)) return enVol.get(nom);
  const p = (async () => {
    try {
      const res = await fetch(distante(nom));
      if (!res.ok) return false;
      const octets = new Uint8Array(await res.arrayBuffer());
      if (octets.length !== info.octets) return false;
      const h = Array.from(sha256(octets), (x) => x.toString(16).padStart(2, '0')).join('');
      if (h !== info.sha256) return false;
      await new Promise((ok, ko) => {
        const t = idb.transaction('images', 'readwrite');
        t.objectStore('images').put(new Blob([octets], { type: 'image/jpeg' }), nom);
        t.oncomplete = ok; t.onerror = () => ko(t.error);
      });
      enCache.add(nom);
      for (const f of ecouteurs) { try { f(nom); } catch { /* */ } }
      return true;
    } catch { return false; } finally { enVol.delete(nom); }
  })();
  enVol.set(nom, p);
  return p;
}

// Grandes images arrivees en cours de route : URL blob preparee a l'arrivee.
function preparer(nom) {
  if (pretes.has(nom) || !enCache.has(nom)) return;
  pretes.set(nom, null);
  lireCache(nom).then((b) => { if (b) pretes.set(nom, URL.createObjectURL(b)); else pretes.delete(nom); });
}

/**
 * tuile://… -> adresse chargeable par <img>. garder : mettre la grande image
 * en cache (tuile affichee en grand : jeu, apercu) ; jamais pour une liste,
 * qui en citerait des centaines.
 */
function traduire(url, { garder = false } = {}) {
  const brut = String(url).replace(/^tuile:\/\//, '');
  const mini = brut.startsWith('mini/');
  const nom = brut.replace(/^mini\//, '').split('/').pop();
  const locale = dossierLocales + '/' + nom;
  if (fs.existsSync(locale)) return urlBlob('l:' + nom, fs.readFileSync(locale));
  // Photo d'une tuile creee ailleurs, pas encore recue : rien plutot qu'une
  // image cassee (la carte montre alors sa zone vide).
  if (!manifeste.images[nom]) return '';
  if (mini) return vignette(nom);
  if (pretes.get(nom)) return pretes.get(nom);
  if (enCache.has(nom)) { preparer(nom); return vignette(nom); }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return vignette(nom);
  if (garder) telecharger(nom).then((ok) => { if (ok) preparer(nom); });
  return distante(nom);
}

/** Remplace, dans un resultat, toute chaine tuile://… par son adresse. */
function traduireTout(v, o = {}) {
  if (typeof v === 'string') return v.startsWith('tuile://') ? traduire(v, o) : v;
  if (Array.isArray(v)) return v.map((x) => traduireTout(x, o));
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const r = {};
    for (const [k, x] of Object.entries(v)) r[k] = traduireTout(x, o);
    return r;
  }
  return v;
}

function etat() {
  const noms = Object.keys(manifeste.images);
  const presentes = noms.filter((n) => enCache.has(n));
  return {
    presentes: presentes.length, nombre: noms.length,
    octets: presentes.reduce((s, n) => s + manifeste.images[n].octets, 0),
    octetsTotal: noms.reduce((s, n) => s + manifeste.images[n].octets, 0)
  };
}

async function toutTelecharger(surProgression) {
  const manquantes = Object.keys(manifeste.images).filter((n) => !enCache.has(n));
  let faites = 0, echecs = 0, suite = 0;
  for (const nom of manquantes) {
    if (await telecharger(nom)) { faites++; suite = 0; } else { echecs++; suite++; }
    if (surProgression) surProgression({ faites, echecs, total: manquantes.length });
    if (suite >= 3) break;
  }
  return { faites, echecs, restantes: Object.keys(manifeste.images).filter((n) => !enCache.has(n)).length };
}

module.exports = { configurer, traduire, traduireTout, etat, toutTelecharger, surArrivee: (f) => ecouteurs.add(f) };
