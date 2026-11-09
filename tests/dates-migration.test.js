'use strict';
/**
 * Dates a la convention commune pour les donnees existantes
 * (edition.normaliserDates, au demarrage et apres un import) — scenario reel du
 * 09/11/2026 : un ami (W) envoie le zip de son dossier de donnees, on l'importe
 * (U), puis il continue a modifier / creer des tuiles avec une ancienne version
 * et renvoie un zip. Ses modifications ne doivent pas etre perdues, et ses dates
 * doivent finir au format commun, sans faux conflit.
 *
 *     node scripts/lancer-node.js tests/dates-migration.test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const Database = require('better-sqlite3');

const RACINE = path.resolve(__dirname, '..');
const src = (p) => require(path.join(RACINE, 'src/main', p));
const db = src('db');
const etat = src('synchro/etat');
const edition = src('edition');
const jeu = src('jeu');
const appareil = src('synchro/appareil');
const sauvegarde = src('sauvegarde');
const journal = src('journal');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-dates-mig-'));
const PACK = path.join(TMP, 'pack.db');
fs.copyFileSync(path.join(RACINE, 'data/pack.db'), PACK);
journal.configurer(path.join(TMP, 'logs'), {});

let nOk = 0, nKo = 0;
function test(nom, fn) {
  try { fn(); nOk++; console.log('  ok  ' + nom); }
  catch (e) { nKo++; console.log('  KO  ' + nom + '\n      ' + String(e.stack || e).split('\n').slice(0, 8).join('\n      ')); }
}

function ouvrir(dir) {
  db.fermer();
  const a = appareil.charger(dir, { nom: path.basename(dir) });
  etat.configurer({ appareil: a });
  const images = path.join(dir, 'images-locales');
  fs.mkdirSync(images, { recursive: true });
  edition.configurer(images);
  sauvegarde.configurer({ user: path.join(dir, 'utilisateur.db'), imagesLocales: images, pack: PACK, versionApp: 'test' });
  db.ouvrir(path.join(dir, 'utilisateur.db'), PACK);
  jeu.reinitialiserSac();
}
const W = path.join(TMP, 'willy');
const U = path.join(TMP, 'moi');
fs.mkdirSync(W); fs.mkdirSync(U);

/** Zip fait a la main du dossier de donnees complet (comme celui recu). */
let nZip = 0;
function zipDuDossier(dir) {
  const tmpDb = path.join(TMP, 'copie-' + (++nZip) + '.db');
  db.exporterVers(tmpDb);
  const z = new AdmZip();
  z.addLocalFile(tmpDb, 'tuiles-et-toiles', 'utilisateur.db');
  z.addFile('tuiles-et-toiles/appareil.json', fs.readFileSync(path.join(dir, 'appareil.json')));
  z.addFile('tuiles-et-toiles/Local State', Buffer.from('{}'));
  const f = path.join(TMP, 'envoi-' + nZip + '.zip');
  z.writeZip(f);
  return f;
}

const pack = new Database(PACK, { readonly: true });
const X = pack.prepare("SELECT id, date FROM oeuvres WHERE date = 'vers 1700'").get();
const Y = pack.prepare("SELECT id, date FROM oeuvres WHERE date = 'vers 1780'").get();
pack.close();
const A = 'local:aaaaaaaa-0000-4000-8000-000000000001';
const B = 'local:bbbbbbbb-0000-4000-8000-000000000002';
const v = (e, c, ch) => etat.valeur(e, c, ch);
const ouverts = () => db.instance().prepare('SELECT COUNT(*) n FROM conflits WHERE resolu=0').get().n;

test('W (ancienne version) ecrit des dates hors convention', () => {
  ouvrir(W);
  // Ecriture directe : une ancienne version ne normalisait rien.
  etat.ecrire('locale', A, '_existe', 1);
  etat.ecrire('locale', A, 'ref_local', 'L1');
  etat.ecrire('locale', A, 'titre', 'Tuile A');
  etat.ecrire('locale', A, 'date', 'Fin XIX');
  etat.ecrire('override', X.id, 'date', { valeur: '1700', valeur_source: 'Vers 1700' });   // pack avant 1.1.0
  etat.ecrire('override', Y.id, 'date', { valeur: 'Circa 1780', valeur_source: 'Circa 1780' });
  edition.rafraichir();
});
const zip1 = zipDuDossier(W);

test('U importe le zip du dossier complet : dates au format, pas de faux conflit', () => {
  ouvrir(U);
  const r = sauvegarde.importer(zip1);
  assert.ok(!r.erreur, r.erreur);
  assert.equal(v('locale', A, 'date'), 'fin XIXe siècle');
  assert.deepEqual(v('override', X.id, 'date'), { valeur: '1700', valeur_source: 'vers 1700' });
  assert.equal(v('override', Y.id, 'date'), null, 'correction identique au pack : retiree');
  assert.equal(edition.conflitsPack().length, 0);
  assert.equal(ouverts(), 0);
});

test('W continue sur son ancienne version : modifie A, cree B', () => {
  ouvrir(W);
  etat.ecrire('locale', A, 'date', 'C. 1890');
  etat.ecrire('locale', A, 'titre', 'Tuile A corrigée');
  etat.ecrire('locale', B, '_existe', 1);
  etat.ecrire('locale', B, 'ref_local', 'L2');
  etat.ecrire('locale', B, 'titre', 'Tuile B');
  etat.ecrire('locale', B, 'date', 'V.1645-1648');
  edition.rafraichir();
});
const zip2 = zipDuDossier(W);

test('U importe le 2e zip : modifications de W gardees, dates au format', () => {
  ouvrir(U);
  const r = sauvegarde.importer(zip2);
  assert.ok(!r.erreur, r.erreur);
  assert.equal(v('locale', A, 'titre'), 'Tuile A corrigée');
  assert.equal(v('locale', A, 'date'), 'vers 1890');
  assert.equal(v('locale', B, 'titre'), 'Tuile B');
  assert.equal(v('locale', B, 'date'), 'vers 1645-1648');
  assert.equal(ouverts(), 0, 'les deux ecritures de la date de A ne laissent pas de conflit');
  assert.equal(db.oeuvre(A).date, 'vers 1890');
});

test('W passe a la nouvelle version : meme resultat chez lui, puis 3e zip sans conflit', () => {
  ouvrir(W);
  const n = edition.normaliserDates();
  assert.equal(n.locales, 2);
  assert.equal(v('locale', A, 'date'), 'vers 1890');
  assert.equal(edition.conflitsPack().length, 0);
  const zip3 = zipDuDossier(W);
  ouvrir(U);
  assert.ok(!sauvegarde.importer(zip3).erreur);
  assert.equal(ouverts(), 0);
  assert.equal(v('locale', A, 'date'), 'vers 1890');
  assert.deepEqual(edition.normaliserDates(), { locales: 0, corrections: 0, retirees: 0 }, 'idempotente');
});

test('tuile supprimee : sa date n\'est pas touchee (pas de « supprimee ici, modifiee la-bas »)', () => {
  const C = 'local:cccccccc-0000-4000-8000-000000000003';
  etat.ecrire('locale', C, '_existe', 1);
  etat.ecrire('locale', C, 'date', 'V.1860');
  etat.supprimerLocale(C);
  edition.normaliserDates();
  assert.equal(v('locale', C, 'date'), 'V.1860');
  assert.equal(ouverts(), 0);
});

test('donnees abimees ou inattendues : ignorees sans erreur, rien de reecrit', () => {
  const D = 'local:dddddddd-0000-4000-8000-000000000004';
  etat.ecrire('locale', D, '_existe', 1);
  etat.ecrire('locale', D, 'date', 'V.' + '1'.repeat(300));            // > 200 caracteres
  etat.ecrire('override', 'p:inexistant', 'date', { valeur: 'C.1500', valeur_source: 'x' });   // oeuvre inconnue
  const Z = db.instance().prepare("SELECT id FROM pack.oeuvres WHERE date = '1665' LIMIT 1").get();
  etat.ecrire('override', Z.id, 'date', { valeur: 1700, valeur_source: null });                 // valeur non texte
  db.instance().prepare("UPDATE etat SET valeur = '{pas du json' WHERE entite='locale' AND cle=? AND champ='date'").run(A);
  const avant = db.instance().prepare('SELECT COUNT(*) n FROM changements').get().n;
  assert.deepEqual(edition.normaliserDates(), { locales: 0, corrections: 0, retirees: 0 });
  assert.equal(db.instance().prepare('SELECT COUNT(*) n FROM changements').get().n, avant);
});

test('date farfelue : remise au format une seule fois, plus jamais reecrite ensuite', () => {
  const F = 'local:ffffffff-0000-4000-8000-000000000006';
  etat.ecrire('locale', F, '_existe', 1);
  etat.ecrire('locale', F, 'date', ',) et 1803-26');
  edition.normaliserDates();
  const v1 = v('locale', F, 'date');
  for (let i = 0; i < 3; i++) assert.deepEqual(edition.normaliserDates(), { locales: 0, corrections: 0, retirees: 0 });
  assert.equal(v('locale', F, 'date'), v1);
});

test('correction de date dont la source n\'est pas une ancienne ecriture du pack : source gardee (vrai conflit possible)', () => {
  const Z = db.instance().prepare("SELECT id, date FROM pack.oeuvres WHERE date = 'vers 1780' LIMIT 1").get();
  etat.ecrire('override', Z.id, 'date', { valeur: '1781', valeur_source: '1779' });   // le pack a vraiment change
  edition.normaliserDates();
  assert.deepEqual(v('override', Z.id, 'date'), { valeur: '1781', valeur_source: '1779' });
});

test('zip sans utilisateur.db : refuse', () => {
  const z = new AdmZip();
  z.addFile('dossier/autre.txt', Buffer.from('x'));
  const f = path.join(TMP, 'vide.zip');
  z.writeZip(f);
  assert.ok(sauvegarde.inspecter(f).erreur);
});

db.fermer();
console.log(`\n${nOk} ok, ${nKo} KO`);
process.exit(nKo ? 1 : 0);
