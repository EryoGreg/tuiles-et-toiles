'use strict';
/**
 * Sauvegarde / restauration des donnees utilisateur dans un fichier .zip.
 *
 * Le zip contient TOUT ce que l'utilisateur a produit :
 *   utilisateur.db          tags, stats, archive, overrides, tuiles locales, reglages
 *   images-locales/<nom>     images des tuiles creees
 *   manifest.json            versions + comptes, pour verifier avant import
 *
 * Etape 0 de la synchro : l'utilisateur depose ce zip dans un dossier
 * Google Drive (ou le transporte a la main) et l'importe sur un autre poste.
 * L'import REMPLACE entierement les donnees locales — une copie horodatee de
 * l'ancienne base est gardee a cote (utilisateur.db.avant-import-<horodatage>).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');

const db = require('./db');
const lisezmoi = require('./lisezmoi');
const jeu = require('./jeu');

let cfg = null;
function configurer({ user, imagesLocales, pack, versionApp }) {
  cfg = { user, imagesLocales, pack, versionApp };
}

function horodatage() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

function comptesLocaux() {
  const d = db.instance();
  return {
    oeuvresLocales: d.prepare('SELECT COUNT(*) n FROM oeuvres_locales').get().n,
    archives: d.prepare('SELECT COUNT(*) n FROM user_archive').get().n,
    overrides: d.prepare('SELECT COUNT(*) n FROM user_overrides').get().n,
    marques: d.prepare('SELECT COUNT(*) n FROM user_tags').get().n
  };
}

function listerImages() {
  if (!fs.existsSync(cfg.imagesLocales)) return [];
  return fs.readdirSync(cfg.imagesLocales)
    .filter((f) => f !== lisezmoi.NOM && fs.statSync(path.join(cfg.imagesLocales, f)).isFile());
}

/**
 * Ecrit un zip de sauvegarde a `cheminZip`.
 * @returns {{ octets, manifest }}
 */
function exporter(cheminZip) {
  const zip = new AdmZip();

  // Copie transactionnellement propre de utilisateur.db (VACUUM INTO : pas de
  // -wal, base `pack` attachee exclue).
  const tmp = path.join(os.tmpdir(), 'tuiles-export-' + horodatage() + '.db');
  try { fs.rmSync(tmp, { force: true }); } catch { /* n'existe pas */ }
  db.exporterVers(tmp);
  zip.addLocalFile(tmp, '', 'utilisateur.db');

  const images = listerImages();
  for (const nom of images) {
    zip.addLocalFile(path.join(cfg.imagesLocales, nom), 'images-locales');
  }

  const manifest = {
    app: 'tuiles-et-toiles',
    version: cfg.versionApp,
    pack: lireVersionPack(),
    exporteLe: new Date().toISOString(),
    images: images.length,
    ...comptesLocaux()
  };
  zip.addFile(lisezmoi.NOM, Buffer.from(lisezmoi.texte('sauvegarde'), 'utf8'));
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));

  fs.mkdirSync(path.dirname(cheminZip), { recursive: true });
  zip.writeZip(cheminZip);
  try { fs.rmSync(tmp, { force: true }); } catch { /* deja parti */ }

  return { octets: fs.statSync(cheminZip).size, manifest };
}

function lireVersionPack() {
  try {
    const Database = require('better-sqlite3');
    const d = new Database(cfg.pack, { readonly: true, fileMustExist: true });
    const r = d.prepare("SELECT valeur FROM pack_meta WHERE cle = 'version'").get();
    d.close();
    return r ? r.valeur : null;
  } catch { return null; }
}

/**
 * Lit le manifest d'un zip sans rien modifier — pour l'ecran de confirmation.
 * @returns {{ manifest }|{ erreur }}
 */
function inspecter(cheminZip) {
  try {
    const zip = new AdmZip(cheminZip);
    const entreeDb = zip.getEntry('utilisateur.db');
    const entreeManifest = zip.getEntry('manifest.json');
    if (!entreeDb) return { erreur: 'Ce zip ne contient pas utilisateur.db — ce n’est pas une sauvegarde Tuiles & Toiles.' };
    let manifest = null;
    if (entreeManifest) {
      try { manifest = JSON.parse(zip.readAsText(entreeManifest)); } catch { /* manifest illisible */ }
    }
    return { manifest };
  } catch (e) {
    return { erreur: 'Zip illisible : ' + e.message };
  }
}

/**
 * Restaure les donnees depuis un zip. REMPLACE utilisateur.db et
 * images-locales/. Sauvegarde l'ancienne base a cote avant d'ecraser.
 * @returns {{ manifest, sauvegardePrecedente, comptes }|{ erreur }}
 */
function importer(cheminZip) {
  const insp = inspecter(cheminZip);
  if (insp.erreur) return insp;

  const zip = new AdmZip(cheminZip);
  const bufDb = zip.getEntry('utilisateur.db').getData();

  // 1. Vider le -wal dans le fichier principal, puis fermer.
  try { db.instance().pragma('wal_checkpoint(TRUNCATE)'); } catch { /* pas de wal */ }
  db.fermer();

  // 2. Copie de secours de l'ancienne base.
  let sauvegardePrecedente = null;
  if (fs.existsSync(cfg.user)) {
    sauvegardePrecedente = cfg.user + '.avant-import-' + horodatage();
    fs.copyFileSync(cfg.user, sauvegardePrecedente);
  }

  // 3. Remplacer utilisateur.db (et retirer -wal / -shm devenus caducs).
  for (const suff of ['', '-wal', '-shm']) {
    try { fs.rmSync(cfg.user + suff, { force: true }); } catch { /* absent */ }
  }
  fs.writeFileSync(cfg.user, bufDb);

  // 4. Remplacer images-locales/ par celles du zip.
  fs.mkdirSync(cfg.imagesLocales, { recursive: true });
  for (const f of listerImages()) {
    try { fs.rmSync(path.join(cfg.imagesLocales, f), { force: true }); } catch { /* verrou */ }
  }
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const m = e.entryName.match(/^images-locales\/(.+)$/);
    if (!m) continue;
    fs.writeFileSync(path.join(cfg.imagesLocales, path.basename(m[1])), e.getData());
  }

  // 5. Rouvrir : reconstruit oeuvres_effectives, recalcule les masques.
  db.ouvrir(cfg.user, cfg.pack);
  db.reconstruireVue({ force: true });
  jeu.reinitialiserSac();

  return { manifest: insp.manifest, sauvegardePrecedente, comptes: comptesLocaux() };
}

module.exports = { configurer, exporter, inspecter, importer };
