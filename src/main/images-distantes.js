'use strict';
/**
 * Images du pack : vignettes embarquees, grandes images a la demande.
 *
 *   vignettes   data/vignettes/ (cote 480 px, ~13 Mo) livrees avec l'appli :
 *               grilles, et repli tant que la grande image n'est pas la.
 *   grandes     data/images/ du depot GitHub (public), a l'etat fige par le tag
 *               `manifeste.ref` : telechargees au premier affichage, verifiees
 *               (taille + SHA-256 du manifeste), gardees dans le cache
 *               (%APPDATA%\Tuiles et Toiles\images-cache\).
 *   embarquees  si le dossier des grandes images existe a cote de l'appli (dev,
 *               anciennes installations), il passe avant tout telechargement.
 *
 * Regle 1 : hors ligne, jamais d'erreur visible : la vignette tient lieu
 * d'image. Sur PC, toutTelecharger() remplit le cache en tache de fond pour
 * que tout marche ensuite hors ligne (reglage images_hors_ligne).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEPOT = 'EryoGreg/tuiles-et-toiles';
const RE_NOM = /^[\w.-]+\.(jpe?g|png)$/i;
const DELAI = 20000;

let cfg = null;
let manifeste = { ref: null, images: {} };
const enVol = new Map();   // nom -> promesse de telechargement

/**
 * @param {{ cache, vignettes, embarquees?, manifeste, fetch, journal, lisezmoi? }} c
 *   manifeste : chemin de data/images-manifest.json
 */
function configurer(c) {
  cfg = c;
  try { manifeste = JSON.parse(fs.readFileSync(c.manifeste, 'utf8')); }
  catch (e) { manifeste = { ref: null, images: {} }; if (c.journal) c.journal.erreur('image', 'manifeste-illisible', e); }
}

const urlDe = (nom) => 'https://raw.githubusercontent.com/' + DEPOT + '/' + manifeste.ref + '/data/images/' + encodeURIComponent(nom);
const existe = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** Nom d'image sur (pas de chemin, extension image), sinon null. */
function nomSur(nom) {
  const n = path.basename(String(nom || ''));
  return RE_NOM.test(n) ? n : null;
}

function cheminVignette(nom) {
  const p = path.join(cfg.vignettes, nom.replace(/\.(png|jpe?g)$/i, '.jpg'));
  return existe(p) ? p : null;
}

/** Grande image deja sur le disque (embarquee ou en cache), sinon null. */
function cheminGrand(nom) {
  if (cfg.embarquees) { const p = path.join(cfg.embarquees, nom); if (existe(p)) return p; }
  const c = path.join(cfg.cache, nom);
  return existe(c) ? c : null;
}

/** Telecharge une grande image dans le cache. @returns {Promise<string|null>} */
function telecharger(nom) {
  const info = manifeste.images[nom];
  if (!info || !manifeste.ref) return Promise.resolve(null);
  if (enVol.has(nom)) return enVol.get(nom);
  const t0 = Date.now();
  const p = (async () => {
    const ctl = new AbortController();
    const minuteur = setTimeout(() => ctl.abort(), DELAI);
    try {
      const res = await cfg.fetch(urlDe(nom), { signal: ctl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const octets = Buffer.from(await res.arrayBuffer());
      if (octets.length !== info.octets) throw new Error('taille ' + octets.length + ' au lieu de ' + info.octets);
      const h = crypto.createHash('sha256').update(octets).digest('hex');
      if (h !== info.sha256) throw new Error('empreinte SHA-256 incorrecte');
      fs.mkdirSync(cfg.cache, { recursive: true });
      if (cfg.lisezmoi) cfg.lisezmoi.deposer(cfg.cache, 'images_cache');
      const cible = path.join(cfg.cache, nom);
      const tmp = cible + '.part';
      fs.writeFileSync(tmp, octets);
      fs.renameSync(tmp, cible);
      if (cfg.journal) cfg.journal.debug('image', 'telechargee', { nom, octets: octets.length, ms: Date.now() - t0 });
      return cible;
    } catch (e) {
      if (cfg.journal) cfg.journal.evt('image', 'telechargement-echec', { nom, erreur: e.name === 'AbortError' ? 'delai depasse' : e.message, ms: Date.now() - t0 }, 'WARN');
      return null;
    } finally {
      clearTimeout(minuteur);
      enVol.delete(nom);
    }
  })();
  enVol.set(nom, p);
  return p;
}

/**
 * Fichier a servir pour une image du pack.
 * @param {{ mini?: boolean }} o  mini : la vignette (grilles)
 * @returns {Promise<string|null>}
 */
async function chemin(nomBrut, { mini = false } = {}) {
  const nom = nomSur(nomBrut);
  if (!nom) return null;
  if (mini) return cheminVignette(nom) || cheminGrand(nom);
  return cheminGrand(nom) || (await telecharger(nom)) || cheminVignette(nom);
}

/** Combien de grandes images sont disponibles hors ligne. */
function etat() {
  const noms = Object.keys(manifeste.images);
  let presentes = 0, octets = 0;
  for (const n of noms) if (cheminGrand(n)) { presentes++; octets += manifeste.images[n].octets; }
  const total = noms.reduce((s, n) => s + manifeste.images[n].octets, 0);
  return { presentes, nombre: noms.length, octets, octetsTotal: total, enCours: !!tout };
}

let tout = null;   // telechargement complet en cours
/**
 * Telecharge toutes les grandes images manquantes, une par une (sans gener
 * l'affichage). Un seul a la fois ; arret au premier ecueil reseau repete.
 * @returns {Promise<{ faites, echecs, restantes }>}
 */
function toutTelecharger(surProgression) {
  if (tout) return tout;
  tout = (async () => {
    const manquantes = Object.keys(manifeste.images).filter((n) => !cheminGrand(n));
    let faites = 0, echecs = 0, suite = 0;
    const t0 = Date.now();
    for (const nom of manquantes) {
      const ok = await telecharger(nom);
      if (ok) { faites++; suite = 0; } else { echecs++; suite++; }
      if (surProgression) surProgression({ faites, echecs, total: manquantes.length });
      if (suite >= 3) break;   // hors ligne : on reprendra plus tard
    }
    const r = { faites, echecs, restantes: Object.keys(manifeste.images).filter((n) => !cheminGrand(n)).length };
    if (cfg.journal && (manquantes.length || echecs)) cfg.journal.evt('image', 'hors-ligne', { ...r, ms: Date.now() - t0 });
    return r;
  })();
  return tout.finally(() => { tout = null; });
}

module.exports = { configurer, chemin, etat, toutTelecharger, nomSur, _telecharger: telecharger };
