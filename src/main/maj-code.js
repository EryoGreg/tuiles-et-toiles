'use strict';
/**
 * Mise a jour PARTIELLE sur PC (PLAN-maj-partielle.md, etape 5) : seul le code
 * de l'appli (src/main, dist) change, telecharge (~400 Ko au lieu de 95 Mo),
 * verifie, puis charge par le lanceur (lanceur.js) au demarrage suivant ou
 * tout de suite (« Redemarrer maintenant »).
 *
 *   trouver(release, o)    assets <Nom>-code-x.y.z{.json,.json.sig,-n<exeMin>.zip}
 *                          utilisables par cet exe ?
 *   telecharger(p, prog)   manifeste + signature Ed25519 (cle-maj-web.js), puis
 *                          zip ; chaque fichier verifie ; ecrit dans
 *                          <userData>/code/<version>.tmp renomme ; « en attente ».
 *   redemarrer()           relance l'exe (le lanceur prend le paquet).
 *
 * Publication : scripts/paquet-code.js. Etat partage avec le lanceur :
 * lanceur-etat.js. Meme logique que le mobile (src/mobile/maj-web.js).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const journal = require('./journal');
const { versionSuperieure, decrireAsset } = require('./maj-github');
const etatCode = require('./lanceur-etat');
const CLE_PUBLIQUE = require('./cle-maj-web');

const NOM_ASSET = 'Tuiles-et-Toiles';

let cfg = { racine: null, fetch: null, relancer: null };
/** @param {{ racine: string, fetch: Function, relancer: () => void }} c */
function configurer(c) { cfg = { ...cfg, ...c }; }

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const echapper = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const versionCode = (v) => { const [x, y, z] = String(v).split('.').map((n) => parseInt(n, 10) || 0); return x * 10000 + y * 100 + z; };

/**
 * @param {object} release  reponse GitHub releases/latest
 * @param {{ actuelle: string, versionExe: string, refusees?: string[] }} o
 * @returns {{ version, exeMin, manifeste, signature, zip } | null}
 */
function trouver(release, o) {
  const version = String(release.tag_name || '').replace(/^v/, '');
  if (!versionSuperieure(version, o.actuelle)) return null;
  if ((o.refusees || []).includes(version)) return null;
  const base = NOM_ASSET + '-code-' + version;
  const assets = release.assets || [];
  const json = decrireAsset(assets.find((x) => x.name === base + '.json'));
  const sig = decrireAsset(assets.find((x) => x.name === base + '.json.sig'));
  const motifZip = new RegExp('^' + echapper(base) + '-n(\\d+)\\.zip$');
  const z = assets.find((x) => motifZip.test(x.name));
  const zip = decrireAsset(z);
  if (!json || !sig || !zip) return null;
  const exeMin = parseInt(z.name.match(motifZip)[1], 10);
  if (!(versionCode(o.versionExe) >= exeMin)) return null;   // il faut l'exe complet
  return { version, exeMin, manifeste: json, signature: sig, zip };
}

function cleVerif() {
  // Cle brute Ed25519 -> SPKI DER (prefixe fixe de 12 octets).
  const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(CLE_PUBLIQUE, 'base64')]);
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

async function telechargerAsset(a, surProgression) {
  const res = await cfg.fetch(a.url);
  if (!res.ok) throw new Error('Téléchargement ' + res.status + ' (' + a.nom + ')');
  const b = Buffer.from(await res.arrayBuffer());
  if (surProgression) surProgression(b.length, a.taille);
  if (a.taille && b.length !== a.taille) throw new Error('Fichier incomplet : ' + a.nom);
  if (a.sha256 && sha(b) !== a.sha256) throw new Error('Empreinte SHA-256 incorrecte : ' + a.nom);
  return b;
}

/**
 * @param {object} p  resultat de trouver()
 * @returns {Promise<{ ok: true } | { erreur: string }>}
 */
async function telecharger(p, surProgression) {
  const t0 = Date.now();
  const racine = cfg.racine;
  const tmp = path.join(racine, p.version + '.tmp');
  try {
    const octetsManifeste = await telechargerAsset(p.manifeste);
    const signature = Buffer.from((await telechargerAsset(p.signature)).toString('utf8').trim(), 'base64');
    if (!crypto.verify(null, octetsManifeste, cleVerif(), signature)) throw new Error('Signature du paquet invalide : mise à jour refusée.');
    const m = JSON.parse(octetsManifeste.toString('utf8'));
    if (m.version !== p.version || m.exeMin !== p.exeMin || !m.zip || m.zip.nom !== p.zip.nom) {
      throw new Error('Manifeste incohérent avec la version annoncée.');
    }
    const zip = await telechargerAsset(p.zip, surProgression);
    if (zip.length !== m.zip.octets || sha(zip) !== m.zip.sha256) throw new Error('Paquet corrompu (empreinte).');
    const AdmZip = require('adm-zip');
    const entrees = new AdmZip(zip).getEntries().filter((e) => !e.isDirectory);
    const attendus = Object.keys(m.fichiers || {});
    if (entrees.length !== attendus.length) throw new Error('Paquet incomplet.');
    const contenus = new Map();
    for (const e of entrees) {
      const f = e.entryName;
      const d = m.fichiers[f];
      if (!d) throw new Error('Fichier inattendu : ' + f);
      if (f.split('/').some((x) => x === '..' || x === '') || path.isAbsolute(f)) throw new Error('Chemin refusé : ' + f);
      const o = e.getData();
      if (o.length !== d.octets || sha(o) !== d.sha256) throw new Error('Fichier altéré : ' + f);
      contenus.set(f, o);
    }
    for (const f of ['src/main/index.js', 'src/main/preload.js', 'dist/index.html']) {
      if (!contenus.has(f)) throw new Error('Paquet sans ' + f);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const [f, o] of contenus) {
      const cible = path.join(tmp, ...f.split('/'));
      if (!cible.startsWith(tmp + path.sep)) throw new Error('Chemin refusé : ' + f);
      fs.mkdirSync(path.dirname(cible), { recursive: true });
      fs.writeFileSync(cible, o);
    }
    const final = path.join(racine, p.version);
    fs.rmSync(final, { recursive: true, force: true });
    fs.renameSync(tmp, final);
    const e = etatCode.lireEtat(racine);
    e.attente = { version: p.version, essais: 0 };
    etatCode.ecrireEtat(racine, e);
    journal.evt('maj', 'code-pret', { version: p.version, octets: zip.length, fichiers: attendus.length, ms: Date.now() - t0 });
    return { ok: true };
  } catch (err) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* rien */ }
    journal.erreur('maj', 'code-telechargement', err, { version: p.version, ms: Date.now() - t0 });
    return { erreur: (err && err.message) || String(err) };
  }
}

/** « Redemarrer maintenant » : l'appelant ferme ensuite l'appli. */
function redemarrer() {
  const e = etatCode.lireEtat(cfg.racine);
  if (!e.attente) return { erreur: 'Aucune mise à jour prête.' };
  cfg.relancer();
  journal.evt('maj', 'code-redemarrage', { version: e.attente.version });
  return { ok: true };
}

const lireEtat = () => etatCode.lireEtat(cfg.racine);

module.exports = { NOM_ASSET, configurer, trouver, telecharger, redemarrer, lireEtat, versionCode };
