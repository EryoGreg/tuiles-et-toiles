'use strict';
/**
 * Aleatoire restreint aux marques (Jouer -> Aleatoire -> Marques, facultatif) :
 * 0 marque = toutes les oeuvres ; 1 ou plusieurs = tuiles portant AU MOINS UNE
 * des marques choisies. Le tag de jeu reste censure. Marques futures creees par
 * l'utilisateur : proposees et filtrees sans changer le code (jeu.marques).
 *
 *     node scripts/lancer-node.js tests/marques-tirage.test.js
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
  try { jeu.reinitialiserSac(); fn(); nOk++; console.log('  ok  ' + nom); }
  catch (e) { nKo++; console.log('  KO  ' + nom + '\n      ' + String(e.stack || e).split('\n').slice(0, 6).join('\n      ')); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-marques-'));
const PACK = path.join(TMP, 'pack.db');
fs.copyFileSync(path.join(RACINE, 'data/pack.db'), PACK);
etat.configurer({ appareil: appareil.charger(TMP, { nom: 'essai' }) });
edition.configurer(path.join(TMP, 'images-locales'));
db.ouvrir(path.join(TMP, 'utilisateur.db'), PACK);

const n = () => db.instance().prepare('SELECT COUNT(*) n FROM oeuvres_effectives').get().n;
const ids = db.instance().prepare('SELECT id FROM oeuvres_effectives ORDER BY ref LIMIT 8').all().map((r) => r.id);
const marquer = (id, tag) => { if (!db.tagsDe(id).includes(tag)) db.basculerTag(id, tag); };
const demarquer = (id, tag) => { if (db.tagsDe(id).includes(tag)) db.basculerTag(id, tag); };

/** Vide le sac en entier : ensemble des ids tires (sans doublon attendu). */
function tirerTout(filtre) {
  const vus = [];
  jeu.reinitialiserSac();
  for (let i = 0; i < 2000; i++) {
    const t = jeu.tirer(filtre);
    if (!t) break;
    vus.push(t.id);
    assert.equal(t.champs.tags, null, 'tag de jeu censure en aleatoire');
    if (t.restant === 0) break;
  }
  return vus;
}
// Tuiles jouables (au moins un masque) : le tirage saute les autres.
const jouable = (id) => JSON.parse(db.oeuvre(id).masques || '[]').length > 0;

marquer(ids[0], 'livre'); marquer(ids[1], 'livre');
marquer(ids[1], 'etoile'); marquer(ids[2], 'etoile');
marquer(ids[3], 'bad_smiley');

test('jeu.marques : les trois marques, comptes exacts, total = tout sans selection', () => {
  const r = jeu.marques({});
  assert.deepEqual(r.liste.map((m) => m.valeur), ['livre', 'etoile', 'bad_smiley']);
  assert.deepEqual(r.liste.map((m) => m.label), ['Livre', 'Étoile', 'À revoir']);
  assert.deepEqual(r.liste.map((m) => m.n), [2, 2, 1]);
  assert.equal(r.total, n());
  assert.equal(jeu.marques().total, n(), 'sans argument');
  assert.equal(jeu.marques({ marques: [] }).total, n(), 'liste vide');
});

test('jeu.marques : total = union (une tuile a deux marques comptee une fois)', () => {
  assert.equal(jeu.marques({ marques: ['livre'] }).total, 2);
  assert.equal(jeu.marques({ marques: ['livre', 'etoile'] }).total, 3);
  assert.equal(jeu.marques({ marques: ['livre', 'etoile', 'bad_smiley'] }).total, 4);
  assert.equal(jeu.marques({ marques: ['livre', 'livre'] }).total, 2, 'doublon');
});

test('jeu.marques : valeurs absurdes ignorees', () => {
  assert.equal(jeu.marques({ marques: ['inconnue'] }).total, 0);
  assert.equal(jeu.marques({ marques: [null, 3, '', { a: 1 }] }).total, n(), 'aucune marque valable = tout');
  assert.equal(jeu.marques({ marques: 'livre' }).total, n(), 'pas une liste = aucune selection');
});

test('aucune marque (null, {}, { marques: [] }) : tirage dans toutes les oeuvres', () => {
  const tout = db.instance().prepare('SELECT id FROM oeuvres_effectives').all().map((r) => r.id).filter(jouable);
  for (const f of [null, {}, { marques: [] }]) {
    const vus = tirerTout(f);
    assert.equal(new Set(vus).size, vus.length, 'sac sans remise');
    assert.deepEqual(new Set(vus), new Set(tout));
  }
});

test('une marque : seulement les tuiles marquees', () => {
  assert.deepEqual(new Set(tirerTout({ marques: ['livre'] })), new Set([ids[0], ids[1]].filter(jouable)));
  assert.deepEqual(new Set(tirerTout({ marques: ['bad_smiley'] })), new Set([ids[3]].filter(jouable)));
});

test('plusieurs marques : au moins une, sans doublon', () => {
  const vus = tirerTout({ marques: ['livre', 'etoile'] });
  assert.equal(new Set(vus).size, vus.length);
  assert.deepEqual(new Set(vus), new Set([ids[0], ids[1], ids[2]].filter(jouable)));
});

test('marque sans tuile : aucun tirage (null), pas de boucle', () => {
  jeu.reinitialiserSac();
  assert.equal(jeu.tirer({ marques: ['inconnue'] }), null);
});

test('changer de selection en cours de partie : nouveau sac', () => {
  jeu.reinitialiserSac();
  const t1 = jeu.tirer({ marques: ['bad_smiley'] });
  assert.equal(t1.id, ids[3]);
  const t2 = jeu.tirer({ marques: ['livre'] });
  assert.ok([ids[0], ids[1]].includes(t2.id));
  // Meme selection dans un autre ordre : meme sac (pas de remise a zero).
  jeu.reinitialiserSac();
  const a = jeu.tirer({ marques: ['livre', 'etoile'] });
  const b = jeu.tirer({ marques: ['etoile', 'livre'] });
  assert.notEqual(a.id, b.id);
});

test('marque retiree pendant la partie : prise en compte au remplissage suivant du sac', () => {
  demarquer(ids[0], 'livre');
  assert.deepEqual(new Set(tirerTout({ marques: ['livre'] })), new Set([ids[1]].filter(jouable)));
  marquer(ids[0], 'livre');
});

test('tuile supprimee ou archivee : ni comptee ni tiree ; restauree : de retour', () => {
  edition.supprimer(ids[3]);   // oeuvre du pack -> archivee
  assert.equal(jeu.marques({ marques: ['bad_smiley'] }).total, 0);
  assert.equal(jeu.marques({}).liste.find((m) => m.valeur === 'bad_smiley').n, 0);
  jeu.reinitialiserSac();
  assert.equal(jeu.tirer({ marques: ['bad_smiley'] }), null);
  edition.restaurer(ids[3]);
  assert.equal(jeu.marques({ marques: ['bad_smiley'] }).total, 1);
});

test('tuile locale marquee : tiree comme les autres', () => {
  const r = edition.creer({ titre: 'Nocturne en bleu et or', artiste: 'Whistler essai', description: 'Feu d\'artifice au-dessus de la Tamise, toile tres sombre et presque abstraite pour son temps.' });
  const id = r.id || r.oeuvre && r.oeuvre.id || db.instance().prepare("SELECT id FROM oeuvres_effectives WHERE titre = 'Nocturne en bleu et or'").get().id;
  marquer(id, 'bad_smiley');
  assert.equal(jeu.marques({ marques: ['bad_smiley'] }).total, 2);
  assert.ok(tirerTout({ marques: ['bad_smiley'] }).includes(id));
});

test('marque utilisateur future (valeur inconnue dans user_tags) : proposee et filtrable', () => {
  // La table refuse aujourd'hui toute autre valeur (CHECK) : on simule une base
  // future sans la contrainte, sur une copie de la table.
  const d = db.instance();
  d.exec(`CREATE TABLE user_tags_neuf AS SELECT * FROM user_tags;
          DROP TABLE user_tags; ALTER TABLE user_tags_neuf RENAME TO user_tags;`);
  d.prepare("INSERT INTO user_tags (oeuvre_id, tag, cree_le) VALUES (?, 'baroque perso', '2026-11-11')").run(ids[5]);
  const r = jeu.marques({ marques: ['baroque perso'] });
  const m = r.liste.find((x) => x.valeur === 'baroque perso');
  assert.ok(m, 'proposee');
  assert.equal(m.label, 'baroque perso');
  assert.equal(m.n, 1);
  assert.equal(r.total, 1);
  assert.deepEqual(r.liste.slice(0, 3).map((x) => x.valeur), ['livre', 'etoile', 'bad_smiley'], 'marques connues d\'abord');
  assert.deepEqual(new Set(tirerTout({ marques: ['baroque perso'] })), new Set([ids[5]].filter(jouable)));
});

test('categories inchangees : le tag de jeu reste visible s\'il est seul', () => {
  const cat = jeu.categories().find((c) => c.n > 0).valeur;
  jeu.reinitialiserSac();
  const t = jeu.tirer({ cats: [cat], soustractif: false });
  assert.ok(t);
  const o = db.oeuvre(t.id);
  const seul = String(o.tags || '').split(',').map((s) => s.trim()).filter(Boolean).length === 1;
  if (seul && t.visible.tags) assert.equal(t.champs.tags, o.tags);
});

db.fermer();
console.log(`\n${nOk} ok, ${nKo} KO`);
process.exit(nKo ? 1 : 0);
