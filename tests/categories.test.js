'use strict';
/**
 * Choix de categories en mode soustractif (jeu.apercuCategories) : seuls les
 * tags encore cumulables sont proposes (« siège » + « Asie » -> rien), avec le
 * nombre exact de tuiles qu'il resterait. Sert a Jouer, a la Bibliotheque et a
 * la frise (SelecteurTags).
 *
 *     node scripts/lancer-node.js tests/categories.test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RACINE = path.resolve(__dirname, '..');
const src = (p) => require(path.join(RACINE, 'src/main', p));
const db = src('db');
const etat = src('synchro/etat');
const edition = src('edition');
const jeu = src('jeu');
const appareil = src('synchro/appareil');

let nOk = 0, nKo = 0;
function test(nom, fn) {
  try { fn(); nOk++; console.log('  ok  ' + nom); }
  catch (e) { nKo++; console.log('  KO  ' + nom + '\n      ' + String(e.stack || e).split('\n').slice(0, 6).join('\n      ')); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-cats-'));
const PACK = path.join(TMP, 'pack.db');
fs.copyFileSync(path.join(RACINE, 'data/pack.db'), PACK);
etat.configurer({ appareil: appareil.charger(TMP, { nom: 'essai' }) });
edition.configurer(path.join(TMP, 'images-locales'));
db.ouvrir(path.join(TMP, 'utilisateur.db'), PACK);
// Le cas signale : un siege et un objet d'Asie, jamais ensemble.
edition.creer({ titre: 'Siège Louis XV', artiste: 'x', tags: 'siège, mobilier' });
edition.creer({ titre: 'Vase', artiste: 'y', tags: 'Asie, céramique' });

const cats = jeu.categories().map((c) => c.valeur);
const reel = (sel) => db.parCategorie(sel, true).length;

test('siège + Asie : Asie desactivee apres siège (et inversement)', () => {
  const siege = cats.find((v) => v === 'siege');
  const asie = cats.find((v) => v === 'asie');
  assert.ok(siege && asie, 'categories presentes');
  assert.equal(reel([siege, asie]), 0);
  assert.ok(!jeu.apercuCategories({ cats: [siege], soustractif: true }).possibles.includes(asie));
  assert.ok(!jeu.apercuCategories({ cats: [asie], soustractif: true }).possibles.includes(siege));
});

test('pour chaque tag choisi seul : possibles = exactement les tags cumulables, comptes exacts', () => {
  for (const v of cats) {
    const r = jeu.apercuCategories({ cats: [v], soustractif: true });
    assert.equal(r.total, reel([v]), v);
    for (const w of cats) {
      if (w === v) { assert.ok(!r.possibles.includes(w), 'tag choisi pas re-propose'); continue; }
      const n = reel([v, w]);
      assert.equal(r.possibles.includes(w), n > 0, v + ' + ' + w);
      if (n > 0) assert.equal(r.comptes[w], n, v + ' + ' + w);
    }
  }
});

test('trois tags : un tag propose garde au moins une tuile, un tag bloque n\'en garde aucune', () => {
  const r0 = jeu.apercuCategories({ cats: ['peinture'], soustractif: true });
  const deux = ['peinture', r0.possibles[0]];
  const r = jeu.apercuCategories({ cats: deux, soustractif: true });
  for (const w of cats) {
    if (deux.includes(w)) continue;
    assert.equal(r.possibles.includes(w), reel([...deux, w]) > 0, w);
  }
});

test('additif ou aucun tag : rien n\'est bloque', () => {
  assert.equal(jeu.apercuCategories({ cats: ['siege'], soustractif: false }).possibles, null);
  const r = jeu.apercuCategories({ cats: [], soustractif: true });
  assert.equal(r.total, db.instance().prepare('SELECT COUNT(*) n FROM oeuvres_effectives').get().n);
});

test('tag memorise qui n\'existe plus : 0 tuile, tout le reste bloque (« Tout retirer » le debloque)', () => {
  const r = jeu.apercuCategories({ cats: ['tag-disparu'], soustractif: true });
  assert.equal(r.total, 0);
  assert.deepEqual(r.possibles, []);
});

test('combinaison deja impossible (passage en soustractif apres coup) : 0 tuile, rien a ajouter', () => {
  const r = jeu.apercuCategories({ cats: ['siege', 'asie'], soustractif: true });
  assert.equal(r.total, 0);
  assert.deepEqual(r.possibles, []);
  assert.deepEqual(r.comptes, {});
});

test('casse, accents, espaces et doublons dans les tags : meme categorie', () => {
  edition.creer({ titre: 'Paravent', artiste: 'z', tags: '  ASIE ,Siège ,  asie' });
  const r = jeu.apercuCategories({ cats: ['siege'], soustractif: true });
  assert.ok(r.possibles.includes('asie'), 'siège + Asie existe maintenant');
  assert.equal(r.comptes.asie, 1);
  assert.equal(r.comptes.asie, reel(['siege', 'asie']));
});

test('tuile supprimee ou oeuvre du pack archivee : ne compte plus', () => {
  const t = db.instance().prepare("SELECT id FROM oeuvres_effectives WHERE titre = 'Paravent'").get();
  edition.supprimer(t.id);
  assert.ok(!jeu.apercuCategories({ cats: ['siege'], soustractif: true }).possibles.includes('asie'), 'locale supprimee');
  // Oeuvre du pack portant une combinaison unique : archivee -> combinaison bloquee.
  const lignes = db.instance().prepare("SELECT id, tags FROM oeuvres_effectives WHERE id LIKE 'p:%'").all();
  let cible = null;
  for (const o of lignes) {
    const tg = [...new Set(String(o.tags).split(',').map((s) => require(path.join(RACINE, 'src/main/masques')).normaliser(s)).filter(Boolean))];
    for (let i = 0; i < tg.length && !cible; i++) for (let j = i + 1; j < tg.length && !cible; j++) {
      if (reel([tg[i], tg[j]]) === 1) cible = { id: o.id, a: tg[i], b: tg[j] };
    }
    if (cible) break;
  }
  assert.ok(cible, 'une combinaison unique existe dans le pack');
  assert.ok(jeu.apercuCategories({ cats: [cible.a], soustractif: true }).possibles.includes(cible.b));
  edition.supprimer(cible.id);   // archive
  assert.ok(!jeu.apercuCategories({ cats: [cible.a], soustractif: true }).possibles.includes(cible.b), 'archivee');
  edition.restaurer(cible.id);
  assert.ok(jeu.apercuCategories({ cats: [cible.a], soustractif: true }).possibles.includes(cible.b), 'restauree');
});

test('tags corriges sur une oeuvre du pack : la correction compte, pas la valeur du pack', () => {
  const o = db.instance().prepare("SELECT id FROM oeuvres_effectives WHERE id LIKE 'p:%' LIMIT 1").get();
  const avant = edition.tuile(o.id);
  edition.modifier(o.id, { ...avant, tags: 'siège, Asie' });
  const r = jeu.apercuCategories({ cats: ['siege'], soustractif: true });
  assert.ok(r.possibles.includes('asie'));
  assert.equal(r.comptes.asie, reel(['siege', 'asie']));
  edition.modifier(o.id, avant);
  assert.ok(!jeu.apercuCategories({ cats: ['siege'], soustractif: true }).possibles.includes('asie'));
});

db.fermer();
console.log(`\n${nOk} ok, ${nKo} KO`);
process.exit(nKo ? 1 : 0);
