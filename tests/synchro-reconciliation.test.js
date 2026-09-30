'use strict';
/**
 * Reconciliation a l'ouverture (synchro/etat.reconcilier) : une ancienne
 * version (0.1.x, sans journal) lancee sur la meme base y ecrit directement.
 * Cas reel du 30/09/2026 : 27 tuiles creees en 0.1.0 sur le PC, jamais
 * envoyees au mobile (aucune op a pousser).
 *
 *     node scripts/lancer-node.js tests/synchro-reconciliation.test.js
 */

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const RACINE = path.resolve(__dirname, '..');
const db = require(path.join(RACINE, 'src/main/db'));
const etat = require(path.join(RACINE, 'src/main/synchro/etat'));
const edition = require(path.join(RACINE, 'src/main/edition'));
const jeu = require(path.join(RACINE, 'src/main/jeu'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-recon-'));
const PACK = path.join(TMP, 'pack.db');
fs.copyFileSync(path.join(RACINE, 'data/pack.db'), PACK);
const IMAGES = path.join(TMP, 'images-locales');
fs.mkdirSync(IMAGES);
edition.configurer(IMAGES);

let nOk = 0, nKo = 0;
function test(nom, fn) {
  try { fn(); nOk++; console.log('  ok  ' + nom); }
  catch (e) { nKo++; console.log('  KO  ' + nom + '\n      ' + (e.stack || e).split('\n').slice(0, 5).join('\n      ')); }
}

const A = { id: 'aaaa0001', nom: 'PC', prefixe_ref: 'L' };
const BASE = path.join(TMP, 'utilisateur.db');
function ouvrir() {
  db.fermer();
  etat.configurer({ appareil: A });
  db.ouvrir(BASE, PACK);
  jeu.reinitialiserSac();
  return db.instance();
}
const aPousser = () => db.instance().prepare('SELECT COUNT(*) n FROM changements WHERE pousse=0').get().n;
const marquerPoussees = () => db.instance().prepare('UPDATE changements SET pousse=1').run();
const nOps = () => db.instance().prepare('SELECT COUNT(*) n FROM changements').get().n;

console.log('reconciliation');

// Base « a jour » : deux tuiles creees normalement, une correction, tout envoye.
ouvrir();
const t1 = edition.creer({ titre: 'Tuile un', artiste: 'Artiste un', date: '1900' });
const t2 = edition.creer({ titre: 'Tuile deux', artiste: 'Artiste deux', date: '1901' });
const pack = db.instance().prepare('SELECT id, titre FROM pack.oeuvres ORDER BY ref LIMIT 3').all();
marquerPoussees();

test('ouverture sans ecart : aucune op emise', () => {
  const avant = nOps();
  ouvrir();
  assert.equal(nOps(), avant);
  assert.equal(aPousser(), 0);
});

// L'ancienne version passe : ecritures directes, hors journal.
db.fermer();
const brut = new Database(BASE);
const maintenant = new Date().toISOString();
brut.prepare(`INSERT INTO oeuvres_locales (id, ref_local, artiste, titre, date, lieu, description, tags, image, cree_le, modifie_le)
  VALUES ('local:0ld-0001', 'L3', 'Mark Rothko', 'N21', '1949', 'Met', 'Une toile.', 'Peinture', '', ?, ?)`).run(maintenant, maintenant);
brut.prepare("UPDATE oeuvres_locales SET titre = 'Tuile un corrigee', lieu = 'Louvre' WHERE id = ?").run(t1.id);
brut.prepare('DELETE FROM oeuvres_locales WHERE id = ?').run(t2.id);
brut.prepare(`INSERT INTO user_overrides (oeuvre_id, champ, valeur, valeur_source, cree_le, modifie_le)
  VALUES (?, 'titre', 'Titre corrige', ?, ?, ?)`).run(pack[0].id, pack[0].titre, maintenant, maintenant);
brut.prepare("INSERT INTO user_tags (oeuvre_id, tag, cree_le) VALUES (?, 'etoile', ?)").run(pack[1].id, maintenant);
brut.prepare('INSERT INTO user_archive (oeuvre_id, cree_le) VALUES (?, ?)').run(pack[2].id, maintenant);
brut.close();

ouvrir();

test('tuile creee hors journal : au registre, champs intacts, a envoyer', () => {
  assert.equal(etat.valeur('locale', 'local:0ld-0001', '_existe'), 1);
  assert.equal(etat.valeur('locale', 'local:0ld-0001', 'ref_local'), 'L3');
  assert.equal(etat.valeur('locale', 'local:0ld-0001', 'titre'), 'N21');
  assert.equal(etat.valeur('locale', 'local:0ld-0001', 'description'), 'Une toile.');
  const row = db.instance().prepare("SELECT * FROM oeuvres_locales WHERE id='local:0ld-0001'").get();
  assert.equal(row.titre, 'N21');
  assert.equal(row.artiste, 'Mark Rothko');
  assert.equal(row.lieu, 'Met');
  const ops = db.instance().prepare("SELECT COUNT(*) n FROM changements WHERE cle='local:0ld-0001' AND pousse=0").get().n;
  assert.ok(ops >= 8, ops + ' ops');
});

test('tuile modifiee hors journal : seuls les champs changes', () => {
  assert.equal(etat.valeur('locale', t1.id, 'titre'), 'Tuile un corrigee');
  assert.equal(etat.valeur('locale', t1.id, 'lieu'), 'Louvre');
  const champs = db.instance().prepare('SELECT champ FROM changements WHERE cle=? AND pousse=0 ORDER BY champ').all(t1.id).map((r) => r.champ);
  assert.deepEqual(champs, ['lieu', 'titre']);
});

test('tuile effacee hors journal : pierre tombale (Corbeille)', () => {
  assert.notEqual(etat.valeur('locale', t2.id, '_existe'), 1);
  assert.ok(edition.corbeille().some((c) => c.id === t2.id));
});

test('correction, marque, archive hors journal : au registre', () => {
  assert.deepEqual(etat.valeur('override', pack[0].id, 'titre'), { valeur: 'Titre corrige', valeur_source: pack[0].titre });
  assert.equal(etat.valeur('tag', pack[1].id, 'etoile'), 1);
  assert.equal(etat.valeur('archive', pack[2].id, '_'), 1);
});

test('reouverture : plus aucun ecart (idempotent)', () => {
  marquerPoussees();
  const avant = nOps();
  ouvrir();
  assert.equal(nOps(), avant);
  assert.equal(aPousser(), 0);
});

test('retrait hors journal (marque, correction) : valeur retiree au registre', () => {
  db.fermer();
  const b = new Database(BASE);
  b.prepare('DELETE FROM user_tags WHERE oeuvre_id = ?').run(pack[1].id);
  b.prepare('DELETE FROM user_overrides WHERE oeuvre_id = ?').run(pack[0].id);
  b.close();
  ouvrir();
  assert.equal(etat.valeur('tag', pack[1].id, 'etoile'), null);
  assert.equal(etat.valeur('override', pack[0].id, 'titre'), null);
  assert.equal(aPousser(), 2);
});

db.fermer();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* verrou */ }
console.log(`\n${nOk} ok, ${nKo} KO`);
process.exit(nKo ? 1 : 0);
