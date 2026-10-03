'use strict';
/**
 * MAJ de pack contre correction locale (edition.conflitsPack / trancherPack) :
 * un champ corrige par l'utilisateur que le pack change ensuite. Vraie base +
 * copie du pack modifiee « a la main » comme le ferait une mise a jour.
 *
 *     node scripts/lancer-node.js tests/conflit-pack.test.js
 */

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const RACINE = path.resolve(__dirname, '..');
const src = (p) => require(path.join(RACINE, 'src/main', p));
const db = src('db');
const etat = src('synchro/etat');
const edition = src('edition');
const jeu = src('jeu');
const appareil = src('synchro/appareil');
const service = src('synchro/service');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-cpack-'));

let nOk = 0, nKo = 0;
async function test(nom, fn) {
  try { await fn(); nOk++; console.log('  ok  ' + nom); }
  catch (e) { nKo++; console.log('  KO  ' + nom + '\n      ' + String(e.stack || e).split('\n').slice(0, 7).join('\n      ')); }
}

/** Appareil neuf sur sa propre copie du pack. */
function monde() {
  const dir = fs.mkdtempSync(path.join(TMP, 'a-'));
  const pack = path.join(dir, 'pack.db');
  fs.copyFileSync(path.join(RACINE, 'data/pack.db'), pack);
  ouvrir(dir, pack);
  return { dir, pack };
}
function ouvrir(dir, pack) {
  db.fermer();
  const a = appareil.charger(dir, { nom: 'test' });
  etat.configurer({ appareil: a });
  const images = path.join(dir, 'images-locales');
  fs.mkdirSync(images, { recursive: true });
  edition.configurer(images);
  service.configurer({ dossierUser: dir, imagesLocales: images });
  db.ouvrir(path.join(dir, 'utilisateur.db'), pack);
  jeu.reinitialiserSac();
}
/** « Mise a jour du pack » : change un champ dans le fichier, puis rouvre. */
function majPack(m, id, champ, valeur) {
  db.fermer();
  const p = new Database(m.pack);
  p.prepare(`UPDATE oeuvres SET ${champ} = ? WHERE id = ?`).run(valeur, id);
  p.close();
  ouvrir(m.dir, m.pack);
}
const premiere = () => db.instance().prepare('SELECT id, titre, lieu FROM pack.oeuvres ORDER BY ref LIMIT 1').get();
const corriger = (id, champs) => edition.modifier(id, { ...db.oeuvre(id), ...champs });

(async () => {
  await test('pack inchange : aucune correction n\'est en conflit', () => {
    const m = monde();
    const o = premiere();
    corriger(o.id, { lieu: 'Lieu corrigé' });
    assert.equal(edition.conflitsPack().length, 0);
    assert.equal(db.oeuvre(o.id).lieu, 'Lieu corrigé');
    void m;
  });

  await test('le pack change un champ corrige : conflit, la correction reste affichee', () => {
    const m = monde();
    const o = premiere();
    corriger(o.id, { lieu: 'Lieu corrigé' });
    majPack(m, o.id, 'lieu', 'Lieu du pack 2');
    const c = edition.conflitsPack();
    assert.equal(c.length, 1);
    assert.equal(c[0].champ, 'lieu');
    assert.equal(c[0].correction, 'Lieu corrigé');
    assert.equal(c[0].ancienPack, o.lieu || '');
    assert.equal(c[0].nouveauPack, 'Lieu du pack 2');
    assert.equal(db.oeuvre(o.id).lieu, 'Lieu corrigé');
    assert.equal(service.nombreConflits(), 1, 'compte dans la barre laterale');
    const l = service.listeConflits();
    assert.equal(l[0].type, 'pack');
    assert.equal(l[0].oeuvre.titre, o.titre);
  });

  await test('le pack corrige pareil que l\'utilisateur : pas de conflit', () => {
    const m = monde();
    const o = premiere();
    corriger(o.id, { lieu: 'Même correction' });
    majPack(m, o.id, 'lieu', 'Même correction');
    assert.equal(edition.conflitsPack().length, 0);
  });

  await test('comparaison stricte : une seule majuscule changee par le pack compte', () => {
    const m = monde();
    const o = premiere();
    corriger(o.id, { titre: 'Titre corrigé' });
    majPack(m, o.id, 'titre', (o.titre || '').toUpperCase() === o.titre ? o.titre.toLowerCase() : (o.titre || '').toUpperCase());
    assert.equal(edition.conflitsPack().length, 1);
  });

  await test('« Garder ma correction » : plus de conflit, jusqu\'au prochain changement du pack', () => {
    const m = monde();
    const o = premiere();
    corriger(o.id, { lieu: 'Lieu corrigé' });
    majPack(m, o.id, 'lieu', 'Lieu du pack 2');
    const [c] = service.listeConflits();
    service.resoudre(c.id, 'gagnant');
    assert.equal(edition.conflitsPack().length, 0);
    assert.equal(db.oeuvre(o.id).lieu, 'Lieu corrigé');
    assert.deepEqual(etat.valeur('override', o.id, 'lieu'), { valeur: 'Lieu corrigé', valeur_source: 'Lieu du pack 2' });
    majPack(m, o.id, 'lieu', 'Lieu du pack 3');
    assert.equal(edition.conflitsPack().length, 1, 'nouveau changement du pack : de nouveau signale');
  });

  await test('« Prendre celle du pack » : correction retiree, valeur du pack affichee', () => {
    const m = monde();
    const o = premiere();
    corriger(o.id, { lieu: 'Lieu corrigé' });
    majPack(m, o.id, 'lieu', 'Lieu du pack 2');
    const [c] = service.listeConflits();
    service.resoudre(c.id, 'perdant');
    assert.equal(edition.conflitsPack().length, 0);
    assert.equal(db.oeuvre(o.id).lieu, 'Lieu du pack 2');
    assert.equal(etat.valeur('override', o.id, 'lieu'), null);
  });

  await test('le choix est une ecriture ordinaire (part a la synchro)', () => {
    const m = monde();
    const o = premiere();
    corriger(o.id, { lieu: 'Lieu corrigé' });
    majPack(m, o.id, 'lieu', 'Lieu du pack 2');
    const n = () => db.instance().prepare('SELECT COUNT(*) n FROM changements WHERE pousse = 0').get().n;
    const avant = n();
    service.resoudre(service.listeConflits()[0].id, 'gagnant');
    assert.ok(n() > avant);
  });

  await test('conflit deja tranche : erreur douce', () => {
    monde();
    assert.match(edition.trancherPack('pack:p:inconnu:lieu', 'garder').erreur, /introuvable/);
  });

  await test('plusieurs champs d\'une oeuvre : un conflit par champ, tranches separement', () => {
    const m = monde();
    const o = premiere();
    corriger(o.id, { lieu: 'L', titre: 'T' });
    majPack(m, o.id, 'lieu', 'L2');
    majPack(m, o.id, 'titre', 'T2');
    const c = edition.conflitsPack();
    assert.deepEqual(c.map((x) => x.champ).sort(), ['lieu', 'titre']);
    service.resoudre(c.find((x) => x.champ === 'titre').id, 'perdant');
    const r = edition.conflitsPack();
    assert.equal(r.length, 1);
    assert.equal(r[0].champ, 'lieu');
    assert.equal(db.oeuvre(o.id).titre, 'T2');
    assert.equal(db.oeuvre(o.id).lieu, 'L');
  });

  db.fermer();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* verrou */ }
  console.log(`\n${nOk} ok, ${nKo} KO`);
  process.exit(nKo ? 1 : 0);
})();
