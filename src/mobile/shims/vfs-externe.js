'use strict';
/**
 * Fichiers « externes » du vfs mobile : les photos des tuiles creees
 * (/data/images-locales/) sont de VRAIS fichiers de l'appli
 * (Directory.Data/images-locales/, @capacitor/filesystem), plus des octets en
 * memoire ni dans IndexedDB.
 *
 * Pourquoi : le vfs chargeait toutes les photos en memoire au demarrage
 * (29 Mo pour 177 photos chez un testeur, et ca grossit avec chaque tuile),
 * et une copie de plus a chaque affichage. Desormais seules les metadonnees
 * (nom, taille, date) restent en memoire ; l'affichage passe par l'adresse du
 * fichier (Capacitor.convertFileSrc) et l'envoi au Drive lit le fichier a la
 * demande (fs.promises.readFile).
 *
 * L'API synchrone du vfs reste : ecrire() note les metadonnees et garde les
 * octets « en attente » le temps de l'ecriture native (file sequentielle :
 * ecrire, renommer, supprimer dans l'ordre) ; une lecture ou un affichage
 * pendant ce temps les sert depuis la memoire. vider() attend la fin de la
 * file (avant un rechargement de page, a la mise en veille).
 *
 * Migration : les photos encore dans IndexedDB (versions precedentes) sont
 * passees par migrer() ; l'ancienne copie n'est effacee qu'une fois le
 * fichier natif relu a la bonne taille (vfs.js).
 *
 * Tests : tests/vfs-externe.test.js (Filesystem simule). Meme fichier dans
 * Tuiles & Toiles et Bristol.
 */

const RACINE = '/data/images-locales';
const DOSSIER = 'images-locales';

function creer({ Filesystem, Directory, convertir, journal }) {
  const meta = new Map();          // nom -> { taille, mtime }
  const attente = new Map();       // nom -> { octets, jeton } (ecriture native pas finie)
  let file = Promise.resolve();    // file des operations natives
  let jetons = 0;
  let base = null;                 // adresse lisible par la page du dossier (avec / final)
  let pret = false;
  const echecs = [];

  const nomDe = (p) => p.slice(RACINE.length + 1);
  const estExterne = (p) => pret && p.startsWith(RACINE + '/') && !p.slice(RACINE.length + 1).includes('/');
  const chemin = (nom) => DOSSIER + '/' + nom;
  const b64 = (o) => {
    let s = '';
    for (let i = 0; i < o.length; i += 0x8000) s += String.fromCharCode.apply(null, o.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const deB64 = (s) => { const bin = atob(s); const o = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i); return o; };

  function enFile(quoi, nom, fn) {
    file = file.then(fn).catch((e) => {
      echecs.push({ quoi, nom, erreur: String(e && e.message || e) });
      if (journal) journal.erreur('image', 'fichier-' + quoi, e, { nom });
    });
    return file;
  }

  /** Lit le dossier natif : metadonnees de toutes les photos. */
  async function init() {
    await Filesystem.mkdir({ path: DOSSIER, directory: Directory.Data, recursive: true }).catch(() => {});
    const { uri } = await Filesystem.getUri({ path: DOSSIER, directory: Directory.Data });
    base = convertir(uri).replace(/\/+$/, '') + '/';
    let r = { files: [] };
    try { r = await Filesystem.readdir({ path: DOSSIER, directory: Directory.Data }); } catch { /* vide */ }
    for (const f of r.files || []) {
      if (f.type === 'directory' || /\.tmp$/.test(f.name)) continue;
      meta.set(f.name, { taille: Number(f.size) || 0, mtime: Number(f.mtime) || Date.now() });
    }
    pret = true;
    return meta.size;
  }

  function ecrire(p, octets) {
    const nom = nomDe(p);
    const jeton = ++jetons;
    meta.set(nom, { taille: octets.length, mtime: Date.now() });
    attente.set(nom, { octets, jeton });
    enFile('ecriture', nom, async () => {
      await Filesystem.writeFile({ path: chemin(nom), directory: Directory.Data, data: b64(octets), recursive: true });
      const a = attente.get(nom);
      if (a && a.jeton === jeton) attente.delete(nom);
    });
  }

  function supprimer(p) {
    const nom = nomDe(p);
    meta.delete(nom);
    attente.delete(nom);
    enFile('suppression', nom, () => Filesystem.deleteFile({ path: chemin(nom), directory: Directory.Data }).catch(() => {}));
  }

  function renommer(de, vers) {
    const a = nomDe(de), b = nomDe(vers);
    const m = meta.get(a);
    if (!m) return false;
    meta.delete(a); meta.set(b, m);
    const at = attente.get(a);
    attente.delete(a);
    const jeton = ++jetons;
    if (at) attente.set(b, { octets: at.octets, jeton });
    enFile('renommage', b, async () => {
      await Filesystem.deleteFile({ path: chemin(b), directory: Directory.Data }).catch(() => {});
      await Filesystem.rename({ from: chemin(a), to: chemin(b), directory: Directory.Data, toDirectory: Directory.Data });
      const x = attente.get(b);
      if (x && x.jeton === jeton) attente.delete(b);
    });
    return true;
  }

  async function lire(p) {
    const nom = nomDe(p);
    const at = attente.get(nom);
    if (at) return at.octets;
    if (!meta.has(nom)) { const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e; }
    await file;   // une operation en cours sur ce nom se termine d'abord
    const r = await Filesystem.readFile({ path: chemin(nom), directory: Directory.Data });
    return typeof r.data === 'string' ? deB64(r.data) : new Uint8Array(await r.data.arrayBuffer());
  }

  /** Taille relue sur disque (verification de la migration). */
  async function tailleNative(nom) {
    try { const s = await Filesystem.stat({ path: chemin(nom), directory: Directory.Data }); return Number(s.size); }
    catch { return -1; }
  }

  return {
    RACINE, init, estExterne,
    existe: (p) => meta.has(nomDe(p)),
    stat: (p) => meta.get(nomDe(p)) || null,
    noms: () => [...meta.keys()].sort(),
    ecrire, supprimer, renommer, lire, tailleNative,
    /** Octets pas encore ecrits sur disque (affichage immediat), sinon null. */
    enAttente: (p) => { const a = attente.get(nomDe(p)); return a ? a.octets : null; },
    /** Adresse du fichier pour <img> (null tant qu'il n'est pas ecrit). */
    adresse: (p) => (attente.has(nomDe(p)) || !meta.has(nomDe(p)) ? null : base + encodeURIComponent(nomDe(p))),
    vider: () => file,
    occupation: () => {
      let octets = 0, enMemoire = 0;
      for (const m of meta.values()) octets += m.taille;
      for (const a of attente.values()) enMemoire += a.octets.length;
      return { fichiers: meta.size, octets, enMemoire };
    },
    echecs: () => echecs.slice()
  };
}

module.exports = { creer, RACINE, DOSSIER };
