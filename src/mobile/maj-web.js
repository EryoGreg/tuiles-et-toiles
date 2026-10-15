'use strict';
/**
 * Mise a jour PARTIELLE (Android) : seul le code web change, telecharge
 * (~1 Mo au lieu de l'APK), verifie, applique au lancement suivant ou tout de
 * suite. Plan : PLAN-maj-partielle.md. Publication : scripts/paquet-web.js.
 *
 *   trouver(release, …)   assets <Nom>-web-x.y.z{.json,.json.sig,-n<natifMin>.zip}
 *                         d'une release : paquet utilisable par cet APK ?
 *   telecharger(p, prog)  manifeste + signature (Ed25519, cle-maj-web.js), puis
 *                         zip ; chaque fichier verifie contre le manifeste ;
 *                         ecrit dans Data/web/<version>/ (dossier .tmp renomme
 *                         a la fin : jamais de paquet a moitie ecrit) ; marque
 *                         « en attente ».
 *   demarrage(version)    TOUT au debut du demarrage : paquet en attente ->
 *                         WebView.setServerBasePath (la page se recharge sur le
 *                         nouveau code) ; nouveau code qui demarre -> a valider ;
 *                         2 essais sans validation -> paquet refuse (jamais
 *                         reessaye), l'ancien code reste.
 *   valider()             apres un demarrage complet : persistServerBasePath
 *                         (le nouveau code devient celui de chaque lancement).
 *   appliquerMaintenant() « Redemarrer maintenant ».
 *
 * Capacitor ignore le chemin persiste des qu'un APK neuf est installe
 * (Bridge.isNewBinary) : un APK reprend toujours la main ; demarrage() fait
 * alors le menage. Rien n'est telecharge sans geste de l'utilisateur.
 * Meme fichier dans T&T et Bristol (NOM_ASSET seul differe).
 */

const journal = require('../main/journal');
const { versionSuperieure, decrireAsset } = require('../main/maj-github');
const CLE_PUBLIQUE = require('./cle-maj-web');

const NOM_ASSET = 'Tuiles-et-Toiles';
const DOSSIER = 'web';
const ESSAIS_MAX = 2;

let d = null;           // dependances (configurer) : Filesystem, Directory, Encoding, WebView, MiseAJour, lire, unzip, sha256, subtle
let aValider = null;    // version en cours de validation (nouveau code qui demarre)

function deps() {
  if (d) return d;
  const { Filesystem, Directory, Encoding } = require('@capacitor/filesystem');
  const C = window.Capacitor;
  d = {
    Filesystem, Directory, Encoding,
    WebView: require('@capacitor/core').WebView,
    MiseAJour: C.registerPlugin('MiseAJour'),
    // Fichier telecharge par le module natif -> octets (adresse lisible par la page).
    lire: async (chemin) => new Uint8Array(await (await fetch(C.convertFileSrc('file://' + chemin))).arrayBuffer()),
    unzip: (o) => require('fflate').unzipSync(o),
    sha256: (o) => Array.from(require('@noble/hashes/sha2.js').sha256(o), (x) => x.toString(16).padStart(2, '0')).join(''),
    subtle: globalThis.crypto && globalThis.crypto.subtle
  };
  return d;
}
/** Tests : dependances simulees. */
function configurer(dependances) { d = dependances; aValider = null; }

// --- etat (Data/web/etat.json) --------------------------------------------------
// { attente: { version, essais } | null, ok: version | null, refusees: [version] }

async function lireEtat() {
  const { Filesystem, Directory, Encoding } = deps();
  try {
    const r = await Filesystem.readFile({ path: DOSSIER + '/etat.json', directory: Directory.Data, encoding: Encoding.UTF8 });
    const e = JSON.parse(r.data);
    return { attente: e.attente || null, ok: e.ok || null, refusees: Array.isArray(e.refusees) ? e.refusees : [] };
  } catch { return { attente: null, ok: null, refusees: [] }; }
}
async function ecrireEtat(e) {
  const { Filesystem, Directory, Encoding } = deps();
  await Filesystem.writeFile({ path: DOSSIER + '/etat.json', directory: Directory.Data, encoding: Encoding.UTF8, data: JSON.stringify(e), recursive: true });
}
async function cheminAbsolu(rel) {
  const { Filesystem, Directory } = deps();
  const { uri } = await Filesystem.getUri({ path: rel, directory: Directory.Data });
  return decodeURIComponent(uri.replace(/^file:\/\//, ''));
}
async function effacer(rel) {
  const { Filesystem, Directory } = deps();
  await Filesystem.rmdir({ path: rel, directory: Directory.Data, recursive: true }).catch(() => {});
}
/** Efface les paquets sauf ceux cites. */
async function menage(garder) {
  const { Filesystem, Directory } = deps();
  let r;
  try { r = await Filesystem.readdir({ path: DOSSIER, directory: Directory.Data }); } catch { return; }
  for (const f of r.files || []) {
    if (f.type !== 'directory' || garder.includes(f.name)) continue;
    await effacer(DOSSIER + '/' + f.name);
  }
}

// --- demarrage / validation -------------------------------------------------------

/**
 * @param {string} version  version du code web qui tourne
 * @returns {Promise<'recharge' | 'normal'>}  'recharge' : la page repart sur un
 *          autre code, ne rien demarrer.
 */
async function demarrage(version) {
  const e = await lireEtat();
  // APK plus recent que le paquet retenu (installe par-dessus) : il a repris la main.
  if (e.ok && versionSuperieure(version, e.ok)) {
    journal.evt('maj', 'web-remplace-par-apk', { paquet: e.ok, apk: version });
    e.ok = null;
    await ecrireEtat(e);
    await menage(e.attente ? [e.attente.version] : []);
  }
  const a = e.attente;
  if (!a) return 'normal';
  if (a.version === version) {   // le nouveau code demarre : a valider
    aValider = version;
    return 'normal';
  }
  if (!versionSuperieure(a.version, version)) {   // paquet depasse (APK plus recent)
    e.attente = null;
    await ecrireEtat(e);
    await menage(e.ok ? [e.ok] : []);
    return 'normal';
  }
  if (a.essais >= ESSAIS_MAX) {
    journal.avertir('maj', 'web-refuse', { version: a.version, essais: a.essais, motif: 'demarrage jamais valide' });
    e.refusees = [...new Set([...e.refusees, a.version])];
    e.attente = null;
    await ecrireEtat(e);
    await menage(e.ok ? [e.ok] : []);
    return 'normal';
  }
  return appliquer(e);
}

async function appliquer(e) {
  const a = e.attente;
  a.essais = (a.essais || 0) + 1;
  await ecrireEtat(e);
  const chemin = await cheminAbsolu(DOSSIER + '/' + a.version);
  journal.evt('maj', 'web-application', { version: a.version, essai: a.essais });
  await deps().WebView.setServerBasePath({ path: chemin });   // la page se recharge
  return 'recharge';
}

/** Demarrage complet du nouveau code : il devient celui de chaque lancement. */
async function valider() {
  if (!aValider) return false;
  const v = aValider;
  aValider = null;
  await deps().WebView.persistServerBasePath();
  const e = await lireEtat();
  e.ok = v;
  if (e.attente && e.attente.version === v) e.attente = null;
  await ecrireEtat(e);
  await menage([v]);
  journal.evt('maj', 'web-valide', { version: v });
  return true;
}

/** « Redemarrer maintenant » (paquet deja telecharge). */
async function appliquerMaintenant() {
  const e = await lireEtat();
  if (!e.attente) return { erreur: 'Aucune mise à jour prête.' };
  await appliquer(e);
  return { ok: true };
}

// --- recherche et telechargement ----------------------------------------------------

const echapper = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Paquet web de cette release utilisable ici ? -> { version, natifMin, manifeste, signature, zip } | null
 * @param {object} release  reponse GitHub releases/latest
 * @param {{ actuelle: string, versionCode: number, refusees?: string[] }} o
 */
function trouver(release, o) {
  const version = String(release.tag_name || '').replace(/^v/, '');
  if (!versionSuperieure(version, o.actuelle)) return null;
  if ((o.refusees || []).includes(version)) return null;
  const base = NOM_ASSET + '-web-' + version;
  const assets = release.assets || [];
  const json = decrireAsset(assets.find((x) => x.name === base + '.json'));
  const sig = decrireAsset(assets.find((x) => x.name === base + '.json.sig'));
  const motifZip = new RegExp('^' + echapper(base) + '-n(\\d+)\\.zip$');
  const z = assets.find((x) => motifZip.test(x.name));
  const zip = decrireAsset(z);
  if (!json || !sig || !zip) return null;
  const natifMin = parseInt(z.name.match(motifZip)[1], 10);
  if (!(o.versionCode >= natifMin)) return null;   // il faut d'abord l'APK
  return { version, natifMin, manifeste: json, signature: sig, zip };
}

async function verifierSignature(octets, signatureB64) {
  const subtle = deps().subtle;
  if (!subtle) throw new Error('Vérification de signature impossible sur cet appareil.');
  const b64 = (s) => Uint8Array.from(atob(String(s).trim()), (c) => c.charCodeAt(0));
  const cle = await subtle.importKey('raw', b64(CLE_PUBLIQUE), { name: 'Ed25519' }, false, ['verify']);
  return subtle.verify({ name: 'Ed25519' }, cle, b64(signatureB64), octets);
}

async function telechargerAsset(a, surProgression) {
  const { MiseAJour, lire } = deps();
  const ecoute = surProgression ? await MiseAJour.addListener('progression', (p) => surProgression(p.recu, p.total)) : null;
  try {
    const r = await MiseAJour.telecharger({ url: a.url, nom: a.nom, taille: a.taille, sha256: a.sha256 || '' });
    return lire(r.chemin);
  } finally { if (ecoute) ecoute.remove(); }
}

/**
 * @param {object} p  resultat de trouver()
 * @returns {Promise<{ ok: true } | { erreur: string }>}
 */
async function telecharger(p, surProgression) {
  const t0 = Date.now();
  const { Filesystem, Directory, unzip, sha256 } = deps();
  try {
    const octetsManifeste = await telechargerAsset(p.manifeste);
    const signature = new TextDecoder().decode(await telechargerAsset(p.signature));
    if (!(await verifierSignature(octetsManifeste, signature))) throw new Error('Signature du paquet invalide : mise à jour refusée.');
    const m = JSON.parse(new TextDecoder().decode(octetsManifeste));
    if (m.version !== p.version || m.natifMin !== p.natifMin || !m.zip || m.zip.nom !== p.zip.nom) {
      throw new Error('Manifeste incohérent avec la version annoncée.');
    }
    const zip = await telechargerAsset(p.zip, surProgression);
    if (zip.length !== m.zip.octets || sha256(zip) !== m.zip.sha256) throw new Error('Paquet corrompu (empreinte).');
    const fichiers = unzip(zip);
    const attendus = Object.keys(m.fichiers || {});
    const recus = Object.keys(fichiers).filter((f) => !f.endsWith('/'));
    if (recus.length !== attendus.length || attendus.some((f) => !fichiers[f])) throw new Error('Paquet incomplet.');
    for (const f of attendus) {
      const o = fichiers[f];
      if (o.length !== m.fichiers[f].octets || sha256(o) !== m.fichiers[f].sha256) throw new Error('Fichier altéré : ' + f);
    }
    if (!fichiers['index.html'] || !fichiers['principal.js']) throw new Error('Paquet sans index.html.');
    // Ecriture dans un dossier temporaire, renomme a la fin.
    const { Buffer } = require('buffer');
    const tmp = DOSSIER + '/' + p.version + '.tmp';
    const final = DOSSIER + '/' + p.version;
    await effacer(tmp);
    for (const f of attendus) {
      if (f.split('/').some((x) => x === '..' || x === '')) throw new Error('Chemin refusé : ' + f);
      await Filesystem.writeFile({ path: tmp + '/' + f, directory: Directory.Data, data: Buffer.from(fichiers[f]).toString('base64'), recursive: true });
    }
    await effacer(final);
    await Filesystem.rename({ from: tmp, to: final, directory: Directory.Data, toDirectory: Directory.Data });
    const e = await lireEtat();
    e.attente = { version: p.version, essais: 0 };
    await ecrireEtat(e);
    journal.evt('maj', 'web-pret', { version: p.version, octets: zip.length, fichiers: attendus.length, ms: Date.now() - t0 });
    return { ok: true };
  } catch (err) {
    journal.erreur('maj', 'web-telechargement', err, { version: p.version, ms: Date.now() - t0 });
    return { erreur: (err && err.message) || String(err) };
  }
}

/** Pour le rapport d'erreur. */
async function etat() {
  const e = await lireEtat().catch(() => null);
  return { ...(e || {}), aValider };
}

module.exports = {
  NOM_ASSET, configurer, dependances: () => deps(), demarrage, valider, appliquerMaintenant, trouver, telecharger, etat, lireEtat
};
