'use strict';
/**
 * Bilan de synchro aux extremes : un utilisateur sans aucune tuile, et un qui
 * en a des milliers (snapshots, rattrapages, envois de dizaines de milliers
 * d'ops). Comptes EXACTS attendus dans « Recu » / « Envoye », duree mesuree.
 *
 *     node scripts/lancer-node.js tests/synchro-bilan-volume.test.js
 *     TT_VOLUME=5000 ... : plus de tuiles (defaut 2000)
 */

const assert = require('assert/strict');
const crypto = require('crypto');
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
const { viderCaches } = src('synchro/transport-drive');
const { creerFauxDrive } = require('./faux-drive');

const N = parseInt(process.env.TT_VOLUME || '2000', 10);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-bilanvol-'));
const PACK = path.join(TMP, 'pack.db');
fs.copyFileSync(path.join(RACINE, 'data/pack.db'), PACK);

let nOk = 0, nKo = 0;
async function test(nom, fn) {
  const t0 = Date.now();
  try { await fn(); nOk++; console.log('  ok  ' + nom + '  (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)'); }
  catch (e) { nKo++; console.log('  KO  ' + nom + '\n      ' + String(e.stack || e).split('\n').slice(0, 8).join('\n      ')); }
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

/** n tuiles locales en un lot (un seul recalcul de vue). */
function creerEnLot(n, mot) {
  const ids = [];
  // Vrais numeros (« L1 », « L2 »…, a la suite du plus grand), comme edition.creer :
  // un appareil hors ligne recommence a L1 et doit etre renumerote en rejoignant.
  const pre = etat.appareil().prefixe_ref || 'L';
  let k = 0;
  for (const r of db.instance().prepare("SELECT valeur FROM etat WHERE entite='locale' AND champ='ref_local'").all()) {
    const m = new RegExp('^' + pre + '(\d+)$').exec(JSON.parse(r.valeur) || '');
    if (m) k = Math.max(k, parseInt(m[1], 10));
  }
  etat.lot(() => {
    for (let i = 0; i < n; i++) {
      const id = 'local:' + crypto.randomUUID();
      etat.ecrire('locale', id, '_existe', 1);
      etat.ecrire('locale', id, 'ref_local', pre + (++k));
      etat.ecrire('locale', id, 'titre', mot + ' ' + i);
      etat.ecrire('locale', id, 'artiste', 'Artiste ' + (i % 211));
      etat.ecrire('locale', id, 'description', 'Description ' + mot + ' ' + i + ' assez longue pour etre evocatrice au tirage.');
      ids.push(id);
    }
  });
  edition.rafraichir();
  return ids;
}
const locales = () => db.instance().prepare('SELECT id FROM oeuvres_locales ORDER BY ref_local').all().map((r) => r.id);

/** Synchro manuelle ; un appareil neuf ne remplace personne. */
async function sync(faux) {
  const t0 = Date.now();
  let r = await service.synchroniserDrive(null, faux);
  if (r.decisionRequise) { service.choisirRemplacement(null); r = await service.synchroniserDrive(null, faux); }
  assert.ok(!r.erreur, r.erreur);
  r.duree = Date.now() - t0;
  return r;
}
const vide = (resume) => !resume || Object.entries(resume).filter(([k]) => k !== 'vues').every(([, v]) => !v);

(async () => {
  console.log('aucune tuile');

  await test('deux appareils sans aucune tuile ni marque : « a jour » partout, rien envoye ni recu', async () => {
    viderCaches();
    const faux = creerFauxDrive();
    const A = neuf();
    const r1 = await sync(faux);
    assert.ok(vide(r1.envoye) && vide(r1.recu), JSON.stringify(r1));
    const B = neuf();
    const r2 = await sync(faux);
    assert.ok(vide(r2.envoye) && vide(r2.recu), JSON.stringify([r2.envoye, r2.recu]));
    for (const d of [A, B, A, B]) {
      ouvrir(d);
      const r = await sync(faux);
      assert.ok(vide(r.envoye) && vide(r.recu), JSON.stringify([r.envoye, r.recu]));
      assert.equal(r.appliquees - ((r.recu && r.recu.vues) || 0), 0);
    }
  });

  await test('sans tuile mais avec des marques et notes sur le pack : comptes exacts', async () => {
    viderCaches();
    const faux = creerFauxDrive();
    const A = neuf(); await sync(faux);
    const B = neuf(); await sync(faux);
    ouvrir(A);
    const pack = db.instance().prepare('SELECT id FROM oeuvres_effectives ORDER BY ref LIMIT 40').all().map((r) => r.id);
    etat.lot(() => { for (const id of pack.slice(0, 25)) etat.ecrire('tag', id, 'livre', 1); });
    for (const id of pack.slice(25)) edition.ecrireNote(id, 'note ' + id);
    const ra = await sync(faux);
    assert.equal(ra.envoye.marques, 25);
    assert.equal(ra.envoye.notes, 15);
    ouvrir(B);
    const rb = await sync(faux);
    assert.equal(rb.recu.marques, 25, JSON.stringify(rb.recu));
    assert.equal(rb.recu.notes, 15);
    assert.equal(rb.recu.tuilesNouvelles, 0);
  });

  console.log('milliers de tuiles (' + N + ')');
  viderCaches();
  const faux = creerFauxDrive();
  let A, B, ids;

  await test(N + ' tuiles + 300 marques + 100 notes envoyees : « Envoye » exact', async () => {
    A = neuf();
    ids = creerEnLot(N, 'Volume');
    etat.lot(() => { for (const id of ids.slice(0, 300)) etat.ecrire('tag', id, 'etoile', 1); });
    etat.lot(() => { for (const id of ids.slice(300, 400)) etat.ecrire('note', id, '_', 'note ' + id); });
    edition.rafraichir();
    const r = await sync(faux);
    assert.equal(r.envoye.tuilesNouvelles, N, JSON.stringify(r.envoye));
    assert.equal(r.envoye.marques, 300);
    assert.equal(r.envoye.notes, 100);
    console.log('      envoi : ' + r.poussees + ' ops en ' + r.duree + ' ms' + (r.snapshot ? ', snapshot ' + r.snapshot : ''));
  });

  await test('appareil SANS tuile qui rejoint : tout recu par rattrapage, compte exact', async () => {
    B = neuf();
    const r = await sync(faux);
    assert.equal(r.recu.tuilesNouvelles, N, JSON.stringify(r.recu));
    assert.equal(r.recu.marques, 300);
    assert.equal(r.recu.notes, 100);
    assert.equal(db.instance().prepare('SELECT COUNT(*) n FROM oeuvres_locales').get().n, N);
    console.log('      reception : ' + r.appliquees + ' ops en ' + r.duree + ' ms' + (r.rattrapage ? ' (rattrapage ' + r.rattrapage + ')' : ''));
  });

  await test('appareil AVEC ' + Math.round(N / 2) + ' tuiles creees hors ligne qui rejoint : envoi + reception exacts, refs uniques', async () => {
    const C = neuf();
    creerEnLot(Math.round(N / 2), 'HorsLigne');
    const r = await sync(faux);
    assert.equal(r.recu.tuilesNouvelles, N, JSON.stringify(r.recu));
    assert.equal(r.envoye.tuilesNouvelles, Math.round(N / 2), JSON.stringify(r.envoye));
    assert.equal(r.renumerotees.length, Math.round(N / 2), 'tuiles hors ligne renumerotees a l\'inscription');
    ouvrir(A);
    const ra = await sync(faux);
    assert.equal(ra.recu.tuilesNouvelles, Math.round(N / 2), JSON.stringify(ra.recu));
    const refs = db.instance().prepare('SELECT ref_local FROM oeuvres_locales').all().map((x) => x.ref_local);
    assert.equal(new Set(refs).size, refs.length, 'refs uniques');
    assert.equal(refs.length, N + Math.round(N / 2));
    void C;
  });

  await test('modifications et suppressions en masse : comptes exacts de l\'autre cote', async () => {
    ouvrir(A);
    const mes = locales().filter((id) => ids.includes(id));
    const mod = mes.slice(0, 500), sup = mes.slice(500, 1200);
    etat.lot(() => { for (const id of mod) etat.ecrire('locale', id, 'titre', 'Retouche ' + id.slice(-6)); });
    for (const id of sup) etat.supprimerLocale(id);
    edition.rafraichir();
    const ra = await sync(faux);
    assert.equal(ra.envoye.tuilesModifiees, mod.length, JSON.stringify(ra.envoye));
    assert.equal(ra.envoye.tuilesSupprimees, sup.length);
    ouvrir(B);
    const rb = await sync(faux);
    assert.equal(rb.recu.tuilesModifiees, mod.length, JSON.stringify(rb.recu));
    assert.equal(rb.recu.tuilesSupprimees, sup.length);
    console.log('      reception : ' + rb.appliquees + ' ops en ' + rb.duree + ' ms' + (rb.rattrapage ? ' (rattrapage)' : ''));
  });

  await test('appareil arrive APRES le menage du Drive (segments purges) : rattrapage compte', async () => {
    // Tout le monde a lu, un snapshot couvre : le menage peut purger. Un nouveau
    // venu ne peut alors QUE rattraper depuis un snapshot.
    for (let tour = 0; tour < 2; tour++) for (const d of [A, B]) { ouvrir(d); await sync(faux); }
    const D = neuf();
    const r = await sync(faux);
    const attendu = db.instance().prepare('SELECT COUNT(*) n FROM oeuvres_locales').get().n;
    assert.ok(r.rattrapage, 'par un snapshot');
    assert.equal(r.recu.tuilesNouvelles, attendu, JSON.stringify(r.recu));
    void D;
  });

  await test('rien de neuf apres tout ca : « a jour » sur chaque appareil', async () => {
    for (const d of [A, B]) {
      ouvrir(d);
      await sync(faux);
      const r = await sync(faux);
      assert.ok(vide(r.recu), JSON.stringify(r.recu));
      assert.ok(vide(r.envoye), JSON.stringify(r.envoye));
    }
  });

  db.fermer();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* verrou */ }
  console.log(`\n${nOk} ok, ${nKo} KO`);
  process.exit(nKo ? 1 : 0);
})();
