'use strict';
/**
 * Sauvegarde / restauration des donnees utilisateur dans un fichier .zip.
 *
 * Le zip contient TOUT ce que l'utilisateur a produit :
 *   utilisateur.db          tags, stats, archive, overrides, tuiles locales, reglages
 *   images-locales/<nom>     images des tuiles creees
 *   manifest.json            versions + comptes, pour verifier avant import
 *
 * L'import FUSIONNE (comme une synchro) : les ops du journal du zip sont
 * appliquees par le moteur de synchro, rien n'est efface. Une donnee modifiee
 * des deux cotes garde la version la plus recente, et un conflit s'ouvre si
 * les deux versions s'ignoraient. Remplacer la base aurait fait diverger les
 * appareils synchronises en silence (le journal local repartait en arriere).
 * Une copie de la base d'avant l'import est gardee a cote
 * (utilisateur.db.avant-import-<horodatage>).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');

const crypto = require('crypto');
const Database = require('better-sqlite3');

const db = require('./db');
const lisezmoi = require('./lisezmoi');
const journal = require('./journal');
const jeu = require('./jeu');
const etat = require('./synchro/etat');
const echange = require('./synchro/echange');

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
  journal.evt('sauvegarde', 'zip-ecrit', {
    cheminZip, cheminTexte: journal.decrireTexte(cheminZip), octets: fs.statSync(cheminZip).size,
    dbOctets: fs.statSync(tmp).size, images: images.length, comptes: manifest
  });
  try { fs.rmSync(tmp, { force: true }); } catch { /* deja parti */ }

  return { octets: fs.statSync(cheminZip).size, manifest };
}

function lireVersionPack() {
  try {
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
 * Ops a fusionner, lues dans la base du zip (ouverte en lecture seule).
 * Zip recent : son journal `changements`. Zip d'avant le journal (0.1.x) :
 * ops fabriquees comme a la genese (date reelle des lignes), sous un
 * identifiant d'appareil derive du contenu du zip — reimporter le meme zip ne
 * cree donc rien de nouveau.
 */
function lireOps(z, octets) {
  const aTable = (n) => !!z.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(n);
  if (aTable('changements')) {
    const cols = z.prepare('PRAGMA table_info(changements)').all().map((c) => c.name);
    const sel = ['hlc', 'appareil', 'entite', 'cle', 'champ', 'valeur', 'base',
      cols.includes('vus') ? 'vus' : 'NULL AS vus',
      cols.includes('remplace') ? 'remplace' : '0 AS remplace'].join(', ');
    return { source: 'journal', ops: z.prepare('SELECT ' + sel + ' FROM changements ORDER BY hlc').all() };
  }
  const id = crypto.createHash('sha1').update(octets).digest('hex').slice(0, 8);
  const brutes = etat.opsGenese(z);
  return { source: 'ancienne-sauvegarde', appareilDerive: id, ops: etat.horodaterGenese(brutes, id) };
}

/**
 * Importe un zip en le FUSIONNANT avec les donnees locales. Les ops nouvelles
 * sont marquees a envoyer : a la prochaine synchro elles partent vers les
 * autres appareils (reprise si le dossier de synchro a ete perdu). Images :
 * celles qui manquent sont copiees, aucune n'est remplacee. Reglages
 * (theme, tri…) : propres a chaque appareil, non importes.
 * @returns {{ manifest, sauvegardePrecedente, source, bilan, resume, conflits, imagesCopiees }|{ erreur }}
 */
function importer(cheminZip) {
  const t0 = Date.now();
  const insp = inspecter(cheminZip);
  if (insp.erreur) {
    journal.avertir('sauvegarde', 'import-zip-refuse', { cheminZip, cheminTexte: journal.decrireTexte(cheminZip), erreur: insp.erreur });
    return insp;
  }
  journal.evt('sauvegarde', 'import:debut', {
    cheminZip, octets: fs.statSync(cheminZip).size, manifest: insp.manifest, comptesAvant: comptesLocaux()
  });

  const zip = new AdmZip(cheminZip);
  const octets = zip.getEntry('utilisateur.db').getData();
  const tmp = path.join(os.tmpdir(), 'tuiles-import-' + horodatage() + '-' + process.pid + '.db');
  let lu;
  try {
    fs.writeFileSync(tmp, octets);
    const z = new Database(tmp, { readonly: true, fileMustExist: true });
    try { lu = lireOps(z, octets); } finally { z.close(); }
  } catch (e) {
    journal.erreur('sauvegarde', 'import-lecture-base', e, { cheminZip });
    return { erreur: 'La base de ce zip est illisible : ' + e.message };
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* deja parti */ }
  }
  journal.evt('sauvegarde', 'import:ops-lues', { source: lu.source, ops: lu.ops.length, appareilDerive: lu.appareilDerive || null });

  // Copie de secours de la base actuelle (VACUUM INTO : propre, sans -wal).
  const sauvegardePrecedente = cfg.user + '.avant-import-' + horodatage();
  db.exporterVers(sauvegardePrecedente);

  let f;
  try {
    f = echange.fusionner(etat.contexte(), lu.ops, { pousse: 0 });
  } catch (e) {
    // Rien n'est applique (une seule transaction) : horloge d'une op trop en avance…
    journal.erreur('sauvegarde', 'import-fusion', e, { cheminZip, ops: lu.ops.length });
    return { erreur: 'Import impossible : ' + e.message };
  }

  // Images manquantes seulement : un nom d'image est unique (uuid).
  fs.mkdirSync(cfg.imagesLocales, { recursive: true });
  let imagesCopiees = 0, imagesPresentes = 0;
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const m = e.entryName.match(/^images-locales\/(.+)$/);
    if (!m || path.basename(m[1]) === lisezmoi.NOM) continue;
    const cible = path.join(cfg.imagesLocales, path.basename(m[1]));
    if (fs.existsSync(cible)) { imagesPresentes++; continue; }
    fs.writeFileSync(cible, e.getData());
    imagesCopiees++;
  }

  db.reconstruireVue({ force: true });
  jeu.reinitialiserSac();
  const conflits = db.instance().prepare('SELECT COUNT(*) n FROM conflits WHERE resolu=0').get().n;
  journal.evt('sauvegarde', 'import:fin', {
    source: lu.source, bilan: f.bilan, resume: f.resume, conflits, imagesCopiees, imagesPresentes,
    sauvegardePrecedente, comptesApres: comptesLocaux(), ms: Date.now() - t0
  });

  return {
    manifest: insp.manifest, sauvegardePrecedente, source: lu.source,
    bilan: f.bilan, resume: f.resume, conflits, imagesCopiees
  };
}

module.exports = { configurer, exporter, inspecter, importer, _lireOps: lireOps };
