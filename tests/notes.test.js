'use strict';
/**
 * Mes notes (edition.lireNote / ecrireNote, entite synchronisee 'note') :
 * ecriture, effacement, recherche, filtre, jamais au tirage ni dans les
 * masques, annulation, synchro entre deux appareils, conflit.
 *
 *     node scripts/lancer-node.js tests/notes.test.js
 */

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RACINE = path.resolve(__dirname, '..');
const src = (p) => require(path.join(RACINE, 'src/main', p));
const db = src('db');
const etat = src('synchro/etat');
const moteur = src('synchro/moteur');
const edition = src('edition');
const jeu = src('jeu');
const appareil = src('synchro/appareil');
const service = src('synchro/service');
const annuler = src('annuler');
const { viderCaches } = src('synchro/transport-drive');
const { creerFauxDrive } = require('./faux-drive');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-notes-'));
const PACK = path.join(TMP, 'pack.db');
fs.copyFileSync(path.join(RACINE, 'data/pack.db'), PACK);

let nOk = 0, nKo = 0;
async function test(nom, fn) {
  try { await fn(); nOk++; console.log('  ok  ' + nom); }
  catch (e) { nKo++; console.log('  KO  ' + nom + '\n      ' + String(e.stack || e).split('\n').slice(0, 7).join('\n      ')); }
}

function ouvrir(dir) {
  db.fermer();
  const a = appareil.charger(dir, { nom: path.basename(dir) });
  etat.configurer({ appareil: a });
  const images = path.join(dir, 'images-locales');
  fs.mkdirSync(images, { recursive: true });
  edition.configurer(images);
  service.configurer({ dossierUser: dir, imagesLocales: images });
  db.ouvrir(path.join(dir, 'utilisateur.db'), PACK);
  jeu.reinitialiserSac();
  annuler.vider();
}
const neuf = () => { const d = fs.mkdtempSync(path.join(TMP, 'a-')); ouvrir(d); return d; };
const premiere = () => db.instance().prepare('SELECT id, ref, masques FROM oeuvres_effectives ORDER BY ref LIMIT 1').get();

(async () => {
  await test('ecrire puis relire ; texte vide = note effacee', () => {
    neuf();
    const o = premiere();
    assert.deepEqual(edition.lireNote(o.id), { texte: '', modifieLe: null });
    assert.ok(edition.ecrireNote(o.id, 'Salon des refusés, 1863\r\nà retenir  ').ok);
    assert.equal(edition.lireNote(o.id).texte, 'Salon des refusés, 1863\nà retenir');
    assert.ok(edition.lireNote(o.id).modifieLe);
    assert.equal(edition.ecrireNote(o.id, 'Salon des refusés, 1863\nà retenir').inchangee, true, 'rien a ecrire');
    edition.ecrireNote(o.id, '   ');
    assert.equal(edition.lireNote(o.id).texte, '');
    assert.equal(db.oeuvresAvecNote().size, 0);
  });

  await test('tuile locale aussi ; tuile inconnue ou note trop longue refusees', () => {
    neuf();
    const id = edition.creer({ titre: 'Ma tuile', artiste: 'Moi' }).id;
    assert.ok(edition.ecrireNote(id, 'note locale').ok);
    assert.equal(edition.lireNote(id).texte, 'note locale');
    assert.match(edition.ecrireNote('p:inexistant', 'x').erreur, /introuvable/);
    assert.match(edition.ecrireNote(id, 'x'.repeat(20001)).erreur, /trop longue/);
  });

  await test('jamais au tirage : seulement la presence (aNote), pas le texte ; masques inchanges', () => {
    neuf();
    const o = premiere();
    edition.ecrireNote(o.id, 'LA REPONSE EST ICI');
    const apres = db.instance().prepare('SELECT masques FROM oeuvres_effectives WHERE id=?').get(o.id).masques;
    assert.equal(apres, o.masques, 'la note n\'entre pas dans les masques');
    const t = jeu.tuile(o.id, null);
    assert.equal(t.aNote, true);
    assert.ok(!JSON.stringify(t).includes('LA REPONSE'), 'texte absent de la tuile tiree');
    assert.equal(jeu.apercu(o.id).aNote, true);
    assert.equal(jeu.reveler(o.id).aNote, true);
  });

  await test('recherche : un mot de la note trouve la tuile ; filtre « avec une note »', () => {
    neuf();
    const o = premiere();
    edition.ecrireNote(o.id, 'Penser à Barbizon et à la lumière');
    const ids = (r) => r.map((x) => x.id);
    assert.ok(ids(jeu.listerToutes({ texte: 'barbizon' })).includes(o.id), 'accents / casse ignores');
    assert.ok(ids(jeu.listerToutes({ texte: 'lumiere' })).includes(o.id));
    assert.deepEqual(ids(jeu.listerToutes({ avecNote: true })), [o.id]);
    assert.ok(jeu.listerToutes({}).find((x) => x.id === o.id).aNote);
    assert.equal(jeu.listerToutes({ texte: 'zzzintrouvablezzz' }).length, 0);
  });

  await test('recherche par numero toujours possible (mot = nombre)', () => {
    neuf();
    const o = premiere();
    assert.ok(jeu.listerToutes({ texte: String(parseInt(o.ref, 10)) }).some((x) => x.id === o.id));
  });

  await test('Ctrl+Z : la note revient a son texte precedent', () => {
    neuf();
    const o = premiere();
    annuler.action('Note', () => edition.ecrireNote(o.id, 'premiere'));
    annuler.action('Note', () => edition.ecrireNote(o.id, 'seconde'));
    annuler.annuler();
    assert.equal(edition.lireNote(o.id).texte, 'premiere');
    annuler.annuler();
    assert.equal(edition.lireNote(o.id).texte, '');
  });

  await test('op note mal formee : rejetee', () => {
    neuf();
    const ctx = etat.contexte();
    const base = { hlc: '0001790000000001-0000-cccccccc', appareil: 'cccccccc', entite: 'note', cle: 'p:x' };
    assert.equal(moteur.appliquer(ctx, { ...base, champ: 'autre', valeur: JSON.stringify('x') }), 'rejetee');
    assert.equal(moteur.appliquer(ctx, { ...base, champ: '_', valeur: JSON.stringify({ pas: 'un texte' }) }), 'rejetee');
  });

  console.log('synchro');

  async function deux() {
    viderCaches();
    const faux = creerFauxDrive();
    const A = neuf(); assert.ok(!(await service.synchroniserDrive(null, faux)).erreur);
    const B = neuf(); await service.synchroniserDrive(null, faux); service.choisirRemplacement(null);
    assert.ok(!(await service.synchroniserDrive(null, faux)).erreur);
    return { faux, A, B };
  }

  await test('note ecrite sur le PC : arrive sur le telephone, comptee au bilan « Recu »', async () => {
    const { faux, A, B } = await deux();
    ouvrir(A);
    const o = premiere();
    edition.ecrireNote(o.id, 'retenue sur le PC');
    await service.synchroniserDrive(null, faux);
    ouvrir(B);
    const r = await service.synchroniserDrive(null, faux);
    assert.equal(edition.lireNote(o.id).texte, 'retenue sur le PC');
    // Ici la note arrive par un rattrapage (premiere lecture du PC) : compte aussi.
    assert.equal(r.recu.notes, 1, JSON.stringify(r.recu));
  });

  await test('meme note changee des deux cotes sans se voir : conflit « Ma note », trancher ferme partout', async () => {
    const { faux, A, B } = await deux();
    ouvrir(A);
    const o = premiere();
    edition.ecrireNote(o.id, 'version PC');
    ouvrir(B);
    edition.ecrireNote(o.id, 'version telephone');
    await service.synchroniserDrive(null, faux);
    ouvrir(A);
    await service.synchroniserDrive(null, faux);
    const c = service.listeConflits().find((x) => x.entite === 'note');
    assert.ok(c, 'conflit visible');
    assert.equal(c.libelle, 'Ma note');
    assert.equal(c.oeuvre.ref, o.ref);
    service.resoudre(c.id, 'perdant');
    const gardee = edition.lireNote(o.id).texte;
    await service.synchroniserDrive(null, faux);
    ouvrir(B);
    await service.synchroniserDrive(null, faux);
    assert.equal(edition.lireNote(o.id).texte, gardee);
    assert.equal(service.listeConflits().filter((x) => x.entite === 'note').length, 0);
  });

  db.fermer();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* verrou */ }
  console.log(`\n${nOk} ok, ${nKo} KO`);
  process.exit(nKo ? 1 : 0);
})();
