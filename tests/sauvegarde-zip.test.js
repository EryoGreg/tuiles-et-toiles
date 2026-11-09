'use strict';
/**
 * Import d'un zip (sauvegarde.importer / inspecter) : sauvegarde exportee par
 * l'appli, zip fait a la main du dossier de donnees complet, zips pieges.
 *
 *     node scripts/lancer-node.js tests/sauvegarde-zip.test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const RACINE = path.resolve(__dirname, '..');
const src = (p) => require(path.join(RACINE, 'src/main', p));
const db = src('db');
const etat = src('synchro/etat');
const edition = src('edition');
const jeu = src('jeu');
const appareil = src('synchro/appareil');
const sauvegarde = src('sauvegarde');
const journal = src('journal');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-zip-'));
const PACK = path.join(TMP, 'pack.db');
fs.copyFileSync(path.join(RACINE, 'data/pack.db'), PACK);
journal.configurer(path.join(TMP, 'logs'), {});

let nOk = 0, nKo = 0;
function test(nom, fn) {
  try { fn(); nOk++; console.log('  ok  ' + nom); }
  catch (e) { nKo++; console.log('  KO  ' + nom + '\n      ' + String(e.stack || e).split('\n').slice(0, 6).join('\n      ')); }
}

let n = 0;
function ouvrir(dir) {
  db.fermer();
  fs.mkdirSync(dir, { recursive: true });
  etat.configurer({ appareil: appareil.charger(dir, { nom: path.basename(dir) }) });
  const images = path.join(dir, 'images-locales');
  fs.mkdirSync(images, { recursive: true });
  edition.configurer(images);
  sauvegarde.configurer({ user: path.join(dir, 'utilisateur.db'), imagesLocales: images, pack: PACK, versionApp: 'test' });
  db.ouvrir(path.join(dir, 'utilisateur.db'), PACK);
  jeu.reinitialiserSac();
  return images;
}
const nouveau = () => path.join(TMP, 'app-' + (++n));
const locales = () => db.instance().prepare("SELECT titre FROM oeuvres_effectives WHERE id LIKE 'local:%' ORDER BY titre").all().map((r) => r.titre);

// Source : un appareil avec deux tuiles, dont une avec image.
const SRC = nouveau();
const imgSrc = ouvrir(SRC);
const NOM_IMG = crypto.randomUUID() + '.jpg';
fs.writeFileSync(path.join(imgSrc, NOM_IMG), 'JPEG');
edition.creer({ titre: 'Avec image', artiste: 'a', image: NOM_IMG });
edition.creer({ titre: 'Sans image', artiste: 'b' });
const baseSrc = path.join(TMP, 'base-src.db');
db.exporterVers(baseSrc);

function zip(entrees) {
  const z = new AdmZip();
  for (const [nom, contenu] of entrees) z.addFile(nom, Buffer.isBuffer(contenu) ? contenu : Buffer.from(contenu));
  const f = path.join(TMP, 'z-' + (++n) + '.zip');
  z.writeZip(f);
  return f;
}
const BASE = fs.readFileSync(baseSrc);

test('sauvegarde exportee par l\'appli : tuiles et image importees', () => {
  ouvrir(SRC);
  const f = path.join(TMP, 'export.zip');
  sauvegarde.exporter(f);
  const images = ouvrir(nouveau());
  const r = sauvegarde.importer(f);
  assert.ok(!r.erreur, r.erreur);
  assert.deepEqual(locales(), ['Avec image', 'Sans image']);
  assert.ok(fs.existsSync(path.join(images, NOM_IMG)));
});

test('zip du dossier complet (sous-dossier) : base et images trouvees, le reste ignore', () => {
  const f = zip([
    ['tuiles-et-toiles/utilisateur.db', BASE],
    ['tuiles-et-toiles/images-locales/' + NOM_IMG, 'JPEG'],
    ['tuiles-et-toiles/images-cache/autre.jpg', 'X'],
    ['tuiles-et-toiles/Local State', '{}'],
    ['tuiles-et-toiles/logs/journal.log', 'log']
  ]);
  const images = ouvrir(nouveau());
  assert.ok(!sauvegarde.inspecter(f).erreur);
  const r = sauvegarde.importer(f);
  assert.ok(!r.erreur, r.erreur);
  assert.equal(r.imagesCopiees, 1);
  assert.deepEqual(locales(), ['Avec image', 'Sans image']);
  assert.deepEqual(fs.readdirSync(images).filter((x) => x !== 'LISEZMOI.txt'), [NOM_IMG]);
});

test('plusieurs utilisateur.db : la plus haute dans le zip est prise', () => {
  const f = zip([
    ['a/b/utilisateur.db', 'pas une base'],
    ['a/utilisateur.db', BASE]
  ]);
  ouvrir(nouveau());
  const r = sauvegarde.importer(f);
  assert.ok(!r.erreur, r.erreur);
  assert.equal(locales().length, 2);
});

test('images : noms pieges ou hors du dossier de la base refuses, LISEZMOI ignore', () => {
  const autre = crypto.randomUUID() + '.png';
  const f = zip([
    ['d/utilisateur.db', BASE],
    ['d/images-locales/' + NOM_IMG, 'JPEG'],
    ['d/images-locales/virus.exe', 'MZ'],
    ['d/images-locales/raccourci.lnk', 'L'],
    ['d/images-locales/LISEZMOI.txt', 'lis-moi'],
    ['autre/images-locales/' + autre, 'PNG']
  ]);
  const images = ouvrir(nouveau());
  const r = sauvegarde.importer(f);
  assert.ok(!r.erreur, r.erreur);
  assert.deepEqual(fs.readdirSync(images).filter((x) => x !== 'LISEZMOI.txt').sort(), [NOM_IMG]);
  assert.ok(!fs.existsSync(path.join(images, 'virus.exe')));
});

test('zip sans base, base illisible, fichier qui n\'est pas un zip : refus clair, rien d\'ecrit', () => {
  ouvrir(nouveau());
  assert.ok(sauvegarde.inspecter(zip([['x/autre.txt', 'x']])).erreur);
  const pasZip = path.join(TMP, 'faux.zip');
  fs.writeFileSync(pasZip, 'ceci n\'est pas un zip');
  assert.ok(sauvegarde.inspecter(pasZip).erreur);
  const r = sauvegarde.importer(zip([['utilisateur.db', 'pas une base sqlite']]));
  assert.ok(r.erreur);
  assert.deepEqual(locales(), []);
});

test('chemin « .. » dans le zip : jamais pris pour la base', () => {
  const z = new AdmZip();
  z.addFile('ok/utilisateur.db', BASE);
  const f = path.join(TMP, 'z-point.zip');
  z.writeZip(f);
  assert.equal(sauvegarde._racine(new AdmZip(f)), 'ok/');
  // Entree au nom piege ajoutee a la main (AdmZip la garderait telle quelle).
  const z2 = new AdmZip();
  z2.addFile('ok/utilisateur.db', BASE);
  const e = z2.getEntry('ok/utilisateur.db');
  e.entryName = '../utilisateur.db';
  const f2 = path.join(TMP, 'z-piege.zip');
  z2.writeZip(f2);
  assert.equal(sauvegarde._racine(new AdmZip(f2)), null);
});

test('deux imports dans la meme seconde : deux copies de secours distinctes, pas d\'echec', () => {
  const dir = nouveau();
  ouvrir(dir);
  const f = zip([['utilisateur.db', BASE]]);
  const r1 = sauvegarde.importer(f);
  const r2 = sauvegarde.importer(f);
  assert.ok(!r1.erreur && !r2.erreur, (r1.erreur || '') + (r2.erreur || ''));
  assert.notEqual(r1.sauvegardePrecedente, r2.sauvegardePrecedente);
  assert.ok(fs.existsSync(r1.sauvegardePrecedente) && fs.existsSync(r2.sauvegardePrecedente));
  assert.equal(locales().length, 2, 'reimporter le meme zip ne duplique rien');
});

db.fermer();
console.log(`\n${nOk} ok, ${nKo} KO`);
process.exit(nKo ? 1 : 0);
