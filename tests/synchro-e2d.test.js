'use strict';
/**
 * E2d — synchro par Google Drive, sur un faux Drive en memoire (meme
 * interface que drive.api) : dossier existant reutilise, homonymes, LISEZMOI,
 * bout-en-bout avec deux vraies bases d'app, stats additionnees.
 *
 *     node scripts/lancer-node.js tests/synchro-e2d.test.js
 *
 * La suite E2b complete tourne aussi sur ce transport :
 *     TT_TRANSPORT=drive node scripts/lancer-node.js tests/synchro-e2b.test.js
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
const moteur = src('synchro/moteur');
const echange = src('synchro/echange');
const appareil = src('synchro/appareil');
const service = src('synchro/service');
const lisezmoi = src('lisezmoi');
const { creerHorloge, formater } = src('synchro/hlc');
const { creerTransportDrive } = src('synchro/transport-drive');
const { creerFauxDrive } = require('./faux-drive');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-e2d-'));
const PACK = path.join(TMP, 'pack.db');
fs.copyFileSync(path.join(RACINE, 'data/pack.db'), PACK);

let nOk = 0, nKo = 0;
async function test(nom, fn) {
  try { await fn(); nOk++; console.log('  ok  ' + nom); }
  catch (e) { nKo++; console.log('  KO  ' + nom + '\n      ' + String(e.stack || e).split('\n').slice(0, 6).join('\n      ')); }
}

function appareilMemoire(id) {
  const d = new Database(':memory:');
  d.exec(db.SCHEMA_USER);
  return { d, appareil: { id, prefixe_ref: 'L' }, horloge: creerHorloge(id) };
}

const texteDe = (faux, ...chemin) => {
  const e = faux.trouver(...chemin);
  return e && e.octets ? e.octets.toString('utf8') : null;
};

/** Dossier Drive tel que la sauvegarde E1 l'a laisse. */
async function driveE1() {
  const faux = creerFauxDrive();
  const r = await faux.creerDossier('Tuiles et Toiles', 'root');
  await faux.creerFichier('utilisateur.zip', r, Buffer.from('ZIP E1'));
  await faux.creerFichier('LISEZMOI.txt', r, Buffer.from('ancien texte E1'));
  const h = await faux.creerDossier('historique', r);
  await faux.creerFichier('utilisateur-2026-09-07.zip', h, Buffer.from('ZIP ancien'));
  return faux;
}

async function transport() {
  console.log('transport Drive');

  await test('reutilise le dossier « Tuiles et Toiles » existant, sans toucher a utilisateur.zip ni historique/', async () => {
    const faux = await driveE1();
    const t = creerTransportDrive(faux);
    await t.preparer('aaaa0001');
    const racines = [...faux.elements.values()].filter((e) => e.parent === 'root');
    assert.equal(racines.length, 1);
    assert.equal(texteDe(faux, 'Tuiles et Toiles', 'utilisateur.zip'), 'ZIP E1');
    assert.equal(texteDe(faux, 'Tuiles et Toiles', 'historique', 'utilisateur-2026-09-07.zip'), 'ZIP ancien');
    assert.equal(texteDe(faux, 'Tuiles et Toiles', 'LISEZMOI.txt'), lisezmoi.texte('racine'), 'LISEZMOI mis a jour');
    for (const [chemin, cle] of [[['journaux'], 'journaux'], [['journaux', 'aaaa0001'], 'journal_appareil'],
      [['appareils'], 'appareils'], [['images'], 'images']]) {
      assert.equal(texteDe(faux, 'Tuiles et Toiles', ...chemin, 'LISEZMOI.txt'), lisezmoi.texte(cle), chemin.join('/'));
    }
  });

  await test('LISEZMOI deja a jour : pas reecrit', async () => {
    const faux = await driveE1();
    await creerTransportDrive(faux).preparer('aaaa0001');
    const maj = faux.appels.maj, creer = faux.appels.creer;
    await creerTransportDrive(faux).preparer('aaaa0001');
    assert.equal(faux.appels.maj, maj);
    assert.equal(faux.appels.creer, creer);
  });

  await test('dossiers homonymes (course a la creation) : lecture de l\'union, ecriture dans le plus ancien', async () => {
    const faux = creerFauxDrive();
    const r = await faux.creerDossier('Tuiles et Toiles', 'root');
    const j1 = await faux.creerDossier('journaux', r);
    const j2 = await faux.creerDossier('journaux', r);   // cree par un autre appareil au meme instant
    const A = appareilMemoire('aaaa0001'), B = appareilMemoire('bbbb0002');
    // A a ecrit dans le doublon recent (il l'a cree), B ecrit ensuite.
    moteur.ecrire(A, 'tag', 'p:1', 'livre', 1);
    const ops = A.d.prepare('SELECT hlc, appareil, entite, cle, champ, valeur, base, vus FROM changements').all();
    const da = await faux.creerDossier('aaaa0001', j2);
    await faux.creerFichier(ops[0].hlc + '_' + ops[0].hlc + '.ndjson', da, Buffer.from(ops.map((o) => JSON.stringify(o)).join('\n')));
    const tB = creerTransportDrive(faux);
    moteur.ecrire(B, 'tag', 'p:2', 'etoile', 1);
    await echange.pousser(B, tB);
    const r2 = await echange.tirer(B, tB);
    assert.equal(r2.appliquees, 1, 'op de A lue dans le doublon');
    assert.equal(faux.trouver('Tuiles et Toiles', 'journaux', 'bbbb0002').parent, j1, 'B ecrit dans le plus ancien');
    assert.equal(moteur.valeur(B, 'tag', 'p:1', 'livre'), 1);
  });

  await test('segment deja present : pas de doublon', async () => {
    const faux = creerFauxDrive();
    const t = creerTransportDrive(faux);
    const h = formater(1000, 0, 'aaaa0001');
    await t.ecrireSegment('aaaa0001', h + '_' + h, [{ hlc: h }]);
    await t.ecrireSegment('aaaa0001', h + '_' + h, [{ hlc: h }]);
    const d = faux.trouver('Tuiles et Toiles', 'journaux', 'aaaa0001');
    assert.equal([...faux.elements.values()].filter((e) => e.parent === d.id).length, 1);
  });

  await test('fichiers etrangers (LISEZMOI, copies) ignores', async () => {
    const faux = creerFauxDrive();
    const t = creerTransportDrive(faux);
    await t.preparer('aaaa0001');
    const d = faux.trouver('Tuiles et Toiles', 'journaux', 'aaaa0001').id;
    await faux.creerFichier('note.txt', d, Buffer.from('x'));
    await faux.creerFichier('Copie de x.ndjson', d, Buffer.from('x'));
    assert.deepEqual(await creerTransportDrive(faux).listerSegments('aaaa0001'), []);
    assert.deepEqual(await creerTransportDrive(faux).listerAppareils(), ['aaaa0001']);
  });
}

// --- bout-en-bout : deux vraies bases d'app ------------------------------------

function ouvrirAppareil(dir) {
  db.fermer();
  const a = appareil.charger(dir, { nom: path.basename(dir) });
  etat.configurer({ appareil: a });
  const images = path.join(dir, 'images-locales');
  fs.mkdirSync(images, { recursive: true });
  edition.configurer(images);
  service.configurer({ dossierUser: dir, imagesLocales: images });
  db.ouvrir(path.join(dir, 'utilisateur.db'), PACK);
  jeu.reinitialiserSac();
  return images;
}

function poserImage(images) {
  const nom = require('crypto').randomUUID() + '.jpg';
  fs.writeFileSync(path.join(images, nom), 'jpeg ' + nom);
  return nom;
}

function vues(id) {
  return db.instance().prepare('SELECT SUM(vues) n FROM user_stats WHERE oeuvre_id=?').get(id).n || 0;
}

/** Tire jusqu'a tomber sur l'oeuvre voulue (compte une vue a chaque passage sur elle). */
function voir(id, fois) {
  for (let i = 0; i < fois; i++) {
    db.instance().prepare(`INSERT INTO user_stats (oeuvre_id, appareil, vues, dernier_vu) VALUES (?, ?, 1, ?)
      ON CONFLICT(oeuvre_id, appareil) DO UPDATE SET vues = vues + 1, dernier_vu = excluded.dernier_vu`)
      .run(id, etat.appareil().id, new Date().toISOString());
  }
}

async function boutEnBout() {
  console.log('bout-en-bout (service + faux Drive + 2 bases)');
  const faux = await driveE1();
  const PC = path.join(TMP, 'pc'), TEL = path.join(TMP, 'tel');
  const pack = new Database(PACK, { readonly: true }).prepare('SELECT id FROM oeuvres ORDER BY ref LIMIT 2').all();
  let idsPC;

  await test('PC : premiere synchro Drive, tout part dans le dossier existant', async () => {
    const images = ouvrirAppareil(PC);
    const a = edition.creer({ titre: 'Nympheas', artiste: 'Monet', image: poserImage(images) });
    idsPC = [a.id];
    db.basculerTag(pack[0].id, 'etoile');
    voir(pack[0].id, 3);
    const r = await service.synchroniserDrive(null, faux);
    assert.ok(!r.erreur, r.erreur);
    assert.equal(r.prefixe, 'L');
    assert.equal(r.imagesEnvoyees, 1);
    assert.ok(faux.trouver('Tuiles et Toiles', 'appareils', etat.appareil().id + '.json'));
    assert.equal(texteDe(faux, 'Tuiles et Toiles', 'utilisateur.zip'), 'ZIP E1');
    assert.equal(service.etat().derniereDrive.poussees, r.poussees);
  });

  await test('telephone : prend M, recoit tuile + image + marques ; vues additionnees', async () => {
    const images = ouvrirAppareil(TEL);
    edition.creer({ titre: 'Sculpture salle 12', artiste: 'Inconnu' });
    voir(pack[0].id, 2);
    const r = await service.synchroniserDrive(null, faux);
    assert.ok(!r.erreur, r.erreur);
    assert.equal(r.prefixe, 'M');
    assert.deepEqual(r.renumerotees.map((x) => [x.avant, x.apres]), [['L1', 'M1']]);
    assert.equal(r.imagesRecues, 1);
    const o = db.oeuvre(idsPC[0]);
    assert.equal(o.ref, 'L1');
    assert.ok(fs.existsSync(path.join(images, o.image)));
    assert.deepEqual(db.tagsDe(pack[0].id), ['etoile']);
    assert.equal(vues(pack[0].id), 5, '3 vues PC + 2 vues telephone');
    edition.modifier(idsPC[0], { ...edition.tuile(idsPC[0]), lieu: 'Orangerie' });
    assert.ok(!(await service.synchroniserDrive(null, faux)).erreur);
  });

  await test('retour au PC : fusion, vues 5 aussi, rien de nouveau au second passage', async () => {
    ouvrirAppareil(PC);
    const r = await service.synchroniserDrive(null, faux);
    assert.ok(!r.erreur, r.erreur);
    assert.equal(db.oeuvre(idsPC[0]).lieu, 'Orangerie');
    assert.equal(db.instance().prepare("SELECT titre FROM oeuvres_effectives WHERE ref='M1'").get().titre, 'Sculpture salle 12');
    assert.equal(vues(pack[0].id), 5);
    const avant = { ...faux.appels };
    const r2 = await service.synchroniserDrive(null, faux);
    assert.equal(r2.poussees + r2.appliquees, 0);
    const n = Object.keys(avant).reduce((s, k) => s + faux.appels[k] - avant[k], 0);
    assert.ok(n < 40, n + ' appels API pour une synchro sans rien de neuf');
    console.log('      (synchro a vide : ' + n + ' appels API)');
  });

  await test('Drive injoignable : message, donnees locales intactes', async () => {
    const panne = { ...faux, lister: async () => { throw new Error('ENOTFOUND www.googleapis.com'); } };
    const r = await service.synchroniserDrive(null, panne);
    assert.match(r.erreur, /ENOTFOUND/);
    assert.equal(db.oeuvre(idsPC[0]).lieu, 'Orangerie');
  });
}

(async () => {
  await transport();
  await boutEnBout();
  db.fermer();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* verrou Windows */ }
  console.log(`\n${nOk} ok, ${nKo} KO`);
  process.exit(nKo ? 1 : 0);
})();
