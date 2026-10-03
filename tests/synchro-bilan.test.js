'use strict';
/**
 * Bilan d'une synchro (« Envoye : … Recu : … ») : ce qui arrive par un
 * rattrapage depuis un snapshot (premiere lecture d'un autre appareil, ou
 * segments purges jamais lus) compte comme une reception ordinaire. Avant le
 * 03/10/2026, la premiere synchro d'un appareil qui en decouvrait un autre
 * annoncait « Tout etait deja a jour » alors que des donnees arrivaient.
 * Plus : le garde-fou « bilan-incoherent » ne crie pas pour des compteurs de vues.
 *
 *     node scripts/lancer-node.js tests/synchro-bilan.test.js
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
const service = src('synchro/service');
const journal = src('journal');
const { viderCaches } = src('synchro/transport-drive');
const { creerFauxDrive } = require('./faux-drive');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-bilan-'));
const PACK = path.join(TMP, 'pack.db');
fs.copyFileSync(path.join(RACINE, 'data/pack.db'), PACK);
const LOGS = path.join(TMP, 'logs');
journal.configurer(LOGS, {}, { console: false });
const journalTexte = () => fs.readdirSync(LOGS).map((f) => fs.readFileSync(path.join(LOGS, f), 'utf8')).join('\n');

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
}
const neuf = () => { const d = fs.mkdtempSync(path.join(TMP, 'a-')); ouvrir(d); return d; };
const sync = (faux) => service.synchroniserDrive(null, faux);

(async () => {
  await test('appareil qui rejoint un Drive deja rempli : tuiles et marques recues comptees', async () => {
    viderCaches();
    const faux = creerFauxDrive();
    const A = neuf();
    edition.creer({ titre: 'Une', artiste: 'x' });
    edition.creer({ titre: 'Deux', artiste: 'y' });
    const id = db.instance().prepare('SELECT id FROM oeuvres_effectives ORDER BY ref LIMIT 1').get().id;
    db.basculerTag(id, 'etoile');
    assert.ok(!(await sync(faux)).erreur);
    void A;
    neuf();
    await sync(faux);                              // decision « remplace-t-il un autre ? »
    service.choisirRemplacement(null);
    const r = await sync(faux);
    assert.ok(!r.erreur, r.erreur);
    assert.equal(r.recu.tuilesNouvelles, 2, JSON.stringify(r.recu));
    assert.equal(r.recu.marques, 1);
    assert.ok(r.appliquees > 0);
  });

  await test('premiere lecture d\'un autre appareil par rattrapage : marque et note comptees', async () => {
    viderCaches();
    const faux = creerFauxDrive();
    const A = neuf(); await sync(faux);
    const B = neuf(); await sync(faux); service.choisirRemplacement(null); await sync(faux);
    ouvrir(A);
    const id = db.instance().prepare('SELECT id FROM oeuvres_effectives ORDER BY ref LIMIT 1').get().id;
    db.basculerTag(id, 'livre');
    edition.ecrireNote(id, 'une note');
    await sync(faux);
    ouvrir(B);
    const r = await sync(faux);
    assert.ok(r.rattrapage, 'passe bien par un rattrapage (cas a couvrir)');
    assert.equal(r.recu.marques, 1, JSON.stringify(r.recu));
    assert.equal(r.recu.notes, 1);
    assert.equal(r.appliquees, 2);
    assert.match(journalTexte(), /recu-detail/);
  });

  await test('reception ordinaire ensuite : toujours comptee (pas de double compte)', async () => {
    viderCaches();
    const faux = creerFauxDrive();
    const A = neuf(); await sync(faux);
    const B = neuf(); await sync(faux); service.choisirRemplacement(null); await sync(faux);
    ouvrir(A); db.basculerTag(db.instance().prepare('SELECT id FROM oeuvres_effectives ORDER BY ref LIMIT 1').get().id, 'livre'); await sync(faux);
    ouvrir(B); await sync(faux);
    ouvrir(A); db.basculerTag(db.instance().prepare('SELECT id FROM oeuvres_effectives ORDER BY ref LIMIT 1 OFFSET 1').get().id, 'etoile'); await sync(faux);
    ouvrir(B);
    const r = await sync(faux);
    assert.equal(r.rattrapage, null, 'plus de rattrapage : curseurs en place');
    assert.equal(r.recu.marques, 1, JSON.stringify(r.recu));
  });

  await test('compteurs de vues seuls : pas d\'avertissement « bilan-incoherent »', async () => {
    viderCaches();
    const faux = creerFauxDrive();
    const A = neuf(); await sync(faux);
    const B = neuf(); await sync(faux); service.choisirRemplacement(null); await sync(faux);
    ouvrir(A);
    jeu.tirer(null); jeu.tirer(null);              // vues de cet appareil
    await sync(faux);
    const avant = (journalTexte().match(/bilan-incoherent/g) || []).length;
    ouvrir(B); await sync(faux);
    const apres = (journalTexte().match(/bilan-incoherent/g) || []).length;
    assert.equal(apres, avant);
  });

  db.fermer();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* verrou */ }
  console.log(`\n${nOk} ok, ${nKo} KO`);
  process.exit(nKo ? 1 : 0);
})();
