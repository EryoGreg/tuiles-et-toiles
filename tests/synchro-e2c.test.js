'use strict';
/**
 * E2c — synchro par dossier partage : transport disque, entree d'un appareil
 * (prefixe + renumerotation), bout-en-bout avec deux vraies bases d'app.
 *
 *     node scripts/lancer-node.js tests/synchro-e2c.test.js
 *
 * La suite E2b complete tourne aussi sur disque :
 *     TT_TRANSPORT=dossier node scripts/lancer-node.js tests/synchro-e2b.test.js
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
const { rejoindre } = src('synchro/rejoindre');
const { creerHorloge, formater } = src('synchro/hlc');
const { creerTransportDossier } = src('synchro/transport-dossier');
const lisezmoi = src('lisezmoi');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-e2c-'));
const PACK = path.join(TMP, 'pack.db');
fs.copyFileSync(path.join(RACINE, 'data/pack.db'), PACK);

let nOk = 0, nKo = 0;
async function test(nom, fn) {
  try { await fn(); nOk++; console.log('  ok  ' + nom); }
  catch (e) { nKo++; console.log('  KO  ' + nom + '\n      ' + String(e.stack || e).split('\n').slice(0, 6).join('\n      ')); }
}

let nDossiers = 0;
const dossier = () => { const d = path.join(TMP, 'd' + (++nDossiers)); fs.mkdirSync(d, { recursive: true }); return d; };

/** Appareil en memoire (moteur seul), comme dans E2b. */
function appareilMemoire(id, prefixe = 'L') {
  const d = new Database(':memory:');
  d.exec(db.SCHEMA_USER);
  return { d, appareil: { id, prefixe_ref: prefixe }, horloge: creerHorloge(id) };
}

// --- transport dossier ------------------------------------------------------

async function transport() {
  console.log('transport dossier');

  await test('fichiers temporaires et copies de conflit ignores', async () => {
    const racine = dossier();
    const t = creerTransportDossier(racine);
    const h = formater(1000, 0, 'aaaa0001');
    const nom = h + '_' + h;
    await t.ecrireSegment('aaaa0001', nom, [{ hlc: h }]);
    const j = path.join(racine, 'journaux', 'aaaa0001');
    fs.writeFileSync(path.join(j, nom + '.ndjson.1234.tmp'), 'moitie');
    fs.writeFileSync(path.join(j, nom + ' (1).ndjson'), '{}');
    fs.writeFileSync(path.join(j, nom + '-PC-conflict.ndjson'), '{}');
    fs.mkdirSync(path.join(racine, 'journaux', 'desktop.ini'), { recursive: true });
    assert.deepEqual(await t.listerSegments('aaaa0001'), [nom]);
    assert.deepEqual(await t.listerAppareils(), ['aaaa0001']);
  });

  await test('segment existant jamais ecrase', async () => {
    const t = creerTransportDossier(dossier());
    const h = formater(1000, 0, 'aaaa0001');
    await t.ecrireSegment('aaaa0001', h + '_' + h, [{ hlc: h, v: 1 }]);
    await t.ecrireSegment('aaaa0001', h + '_' + h, [{ hlc: h, v: 2 }]);
    assert.equal((await t.lireSegment('aaaa0001', h + '_' + h))[0].v, 1);
  });

  await test('segment tronque (copie en cours) : tirage refuse, curseur intact, repris ensuite', async () => {
    const racine = dossier();
    const t = creerTransportDossier(racine);
    const A = appareilMemoire('aaaa0001'), B = appareilMemoire('bbbb0002');
    moteur.ecrire(A, 'tag', 'p:1', 'livre', 1);
    moteur.ecrire(A, 'tag', 'p:1', 'etoile', 1);
    const { segment } = await echange.pousser(A, t);
    const f = path.join(racine, 'journaux', 'aaaa0001', segment + '.ndjson');
    const complet = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, complet.slice(0, complet.length - 20));
    await assert.rejects(() => echange.tirer(B, t), /illisible/);
    assert.equal(B.d.prepare("SELECT COUNT(*) n FROM sync WHERE cle LIKE 'curseur:%'").get().n, 0);
    fs.writeFileSync(f, complet);
    assert.equal((await echange.tirer(B, t)).appliquees, 2);
  });

  await test('images : envoi une seule fois, recuperation, noms hors motif refuses', async () => {
    const t = creerTransportDossier(dossier());
    const nom = '0f8fad5b-d9cb-469f-a165-70867728950e.jpg';
    const src = path.join(dossier(), nom);
    fs.writeFileSync(src, 'jpeg');
    assert.equal(await t.envoyerImage(nom, src), true);
    assert.equal(await t.envoyerImage(nom, src), false);
    const cible = path.join(dossier(), nom);
    assert.equal(await t.recupererImage(nom, cible), true);
    assert.equal(fs.readFileSync(cible, 'utf8'), 'jpeg');
    assert.equal(t.imageValide('../../etc/passwd'), false);
    assert.equal(t.imageValide(nom), true);
  });
}

// --- rejoindre --------------------------------------------------------------

async function entree() {
  console.log('entree d\'un appareil');

  const tuile = (ctx, id) => {
    moteur.ecrire(ctx, 'locale', id, '_existe', 1);
    const n = ctx.d.prepare("SELECT COUNT(*) n FROM etat WHERE entite='locale' AND champ='ref_local'").get().n;
    moteur.ecrire(ctx, 'locale', id, 'ref_local', ctx.appareil.prefixe_ref + (n + 1));
  };
  const ref = (ctx, id) => moteur.valeur(ctx, 'locale', id, 'ref_local');

  await test('premier appareil garde L ; le second prend M et renumerote ses tuiles dans l\'ordre', async () => {
    const t = creerTransportDossier(dossier());
    const A = appareilMemoire('aaaa0001'), B = appareilMemoire('bbbb0002');
    tuile(A, 'local:a1');
    tuile(B, 'local:b1'); tuile(B, 'local:b2');
    let enregistre = null;
    const ra = await rejoindre(A, t, { nom: 'PC', enregistrerPrefixe: (p) => { enregistre = p; } });
    assert.equal(ra.prefixe, 'L');
    assert.equal(enregistre, null);
    const rb = await rejoindre(B, t, { nom: 'Tel', enregistrerPrefixe: (p) => { enregistre = p; } });
    assert.equal(rb.prefixe, 'M');
    assert.equal(enregistre, 'M');
    assert.deepEqual(rb.renumerotees.map((r) => [r.avant, r.apres]), [['L1', 'M1'], ['L2', 'M2']]);
    assert.equal(ref(B, 'local:b2'), 'M2');
    // Apres echange, A voit les numeros M.
    await echange.pousser(B, t);
    await echange.tirer(A, t);
    assert.equal(ref(A, 'local:b1'), 'M1');
    assert.equal(ref(A, 'local:a1'), 'L1');
    assert.deepEqual(moteur.conflits(A), []);
  });

  await test('deja inscrit : rien ne change, fiche rafraichie', async () => {
    const t = creerTransportDossier(dossier());
    const A = appareilMemoire('aaaa0001');
    await rejoindre(A, t, { nom: 'PC', enregistrerPrefixe: () => {} });
    tuile(A, 'local:a1');
    const r = await rejoindre(A, t, { nom: 'PC fixe', enregistrerPrefixe: () => { throw new Error('non'); } });
    assert.equal(r.premiereFois, false);
    assert.equal(ref(A, 'local:a1'), 'L1');
    assert.equal((await t.lireFiches())[0].nom, 'PC fixe');
  });

  await test('course : un rival d\'id plus petit a pris le meme prefixe -> on cede', async () => {
    const t = creerTransportDossier(dossier());
    const A = appareilMemoire('aaaa0001');
    await rejoindre(A, t, { nom: 'PC', enregistrerPrefixe: () => {} });
    const B = appareilMemoire('bbbb0002');
    tuile(B, 'local:b1');
    // Le rival s'inscrit en M pendant que B choisit M lui aussi.
    const lireFiches = t.lireFiches.bind(t);
    let appels = 0;
    t.lireFiches = async () => {
      if (++appels === 2) await t.ecrireFiche({ id: '0000cafe', nom: 'Tablette', prefixe_ref: 'M' });
      return lireFiches();
    };
    const r = await rejoindre(B, t, { nom: 'Tel', enregistrerPrefixe: () => {} });
    assert.equal(r.prefixe, 'N');
    assert.deepEqual(r.renumerotees.map((x) => [x.avant, x.apres]), [['L1', 'N1']]);
    assert.equal(ref(B, 'local:b1'), 'N1');
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

async function boutEnBout() {
  console.log('bout-en-bout (service + 2 bases)');
  const partage = dossier();
  const PC = dossier(), TEL = dossier();
  const packIds = new Database(PACK, { readonly: true }).prepare('SELECT id, titre FROM oeuvres ORDER BY ref LIMIT 2').all();
  let idsPC;

  await test('PC : premiere synchro, tout part (ops + images)', async () => {
    const images = ouvrirAppareil(PC);
    const a = edition.creer({ titre: 'Nympheas', artiste: 'Monet', image: poserImage(images) });
    const b = edition.creer({ titre: 'Olympia', artiste: 'Manet' });
    idsPC = [a.id, b.id];
    db.basculerTag(packIds[0].id, 'etoile');
    edition.modifier(packIds[1].id, { ...edition.tuile(packIds[1].id), titre: 'Titre PC' });
    assert.ok(!service.etat().dossier);
    assert.ok(!service.definirDossier(partage).erreur);
    const r = await service.synchroniser();
    assert.ok(!r.erreur, r.erreur);
    assert.equal(r.prefixe, 'L');
    assert.equal(r.imagesEnvoyees, 1);
    assert.ok(r.poussees >= 10);
    assert.ok(fs.existsSync(path.join(partage, service.SOUS_DOSSIER, 'appareils')));
  });

  await test('telephone (avec une tuile creee avant) : prend M, recoit tout, image copiee', async () => {
    const images = ouvrirAppareil(TEL);
    edition.creer({ titre: 'Sculpture salle 12', artiste: 'Inconnu', image: poserImage(images) });
    service.definirDossier(partage);
    const r = await service.synchroniser();
    assert.ok(!r.erreur, r.erreur);
    assert.equal(r.prefixe, 'M');
    assert.deepEqual(r.renumerotees.map((x) => [x.avant, x.apres]), [['L1', 'M1']]);
    assert.equal(r.imagesRecues, 1);
    assert.equal(db.oeuvre(idsPC[0]).ref, 'L1');
    assert.equal(db.oeuvre(idsPC[0]).titre, 'Nympheas');
    assert.ok(fs.existsSync(path.join(images, db.oeuvre(idsPC[0]).image)));
    assert.deepEqual(db.tagsDe(packIds[0].id), ['etoile']);
    assert.equal(db.oeuvre(packIds[1].id).titre, 'Titre PC');
    assert.equal(JSON.parse(fs.readFileSync(path.join(TEL, 'appareil.json'), 'utf8')).prefixe_ref, 'M');
    // Au musee : modifie une tuile du PC, corrige la meme oeuvre du pack.
    edition.modifier(idsPC[1], { ...edition.tuile(idsPC[1]), lieu: 'Orsay' });
    edition.modifier(packIds[1].id, { ...edition.tuile(packIds[1].id), titre: 'Titre telephone' });
    assert.ok(!(await service.synchroniser()).erreur);
    // Prochaine tuile creee ici : M2.
    assert.equal(edition.creer({ titre: 'Apres', artiste: 'X' }).ref, 'M2');
  });

  await test('retour au PC : fusion, refs du PC intactes, tuile du telephone visible', async () => {
    ouvrirAppareil(PC);
    // Pendant ce temps, le PC avait lui aussi corrige ce titre (sans synchro).
    edition.modifier(packIds[1].id, { ...edition.tuile(packIds[1].id), titre: 'Titre PC bis' });
    const r = await service.synchroniser();
    assert.ok(!r.erreur, r.erreur);
    assert.equal(db.oeuvre(idsPC[1]).lieu, 'Orsay');
    assert.equal(db.oeuvre(idsPC[0]).ref, 'L1');
    const m1 = db.instance().prepare("SELECT * FROM oeuvres_effectives WHERE ref='M1'").get();
    assert.equal(m1.titre, 'Sculpture salle 12');
    assert.equal(r.imagesRecues, 1);
    assert.equal(r.conflits, 1, 'titre corrige des deux cotes');
    assert.equal(service.etat().conflits, 1);
  });

  await test('le telephone voit le meme conflit ; le trancher le ferme partout', async () => {
    ouvrirAppareil(TEL);
    await service.synchroniser();
    const cs = etat.conflits();
    assert.equal(cs.length, 1);
    service.resoudre(cs[0].id, 'perdant');
    assert.equal(db.oeuvre(packIds[1].id).titre, 'Titre telephone', 'vue a jour tout de suite');
    await service.synchroniser();
    const titre = db.oeuvre(packIds[1].id).titre;
    ouvrirAppareil(PC);
    await service.synchroniser();
    assert.equal(etat.conflits().length, 0);
    assert.equal(db.oeuvre(packIds[1].id).titre, titre);
  });

  await test('LISEZMOI dans chaque dossier, rangement « Tuiles et Toiles » comme sur Drive', async () => {
    const r = path.join(partage, 'Tuiles et Toiles');
    for (const d of ['', 'journaux', 'appareils', 'images', path.join('journaux', etat.appareil().id)]) {
      assert.ok(fs.existsSync(path.join(r, d, lisezmoi.NOM)), 'LISEZMOI manquant dans ' + (d || 'racine'));
    }
    // Le LISEZMOI de journaux/ n'est pas pris pour un appareil ni un segment.
    const t = creerTransportDossier(r);
    assert.ok((await t.listerAppareils()).every((a) => /^[0-9a-f]{8}$/.test(a)));
    // Le menage des images ne l'efface pas.
    const images = path.join(PC, 'images-locales');
    lisezmoi.deposer(images, 'images_locales');
    edition.nettoyerOrphelines();
    assert.ok(fs.existsSync(path.join(images, lisezmoi.NOM)));
    // Texte mis a jour s'il a change, sinon laisse tel quel.
    fs.writeFileSync(path.join(r, lisezmoi.NOM), 'ancien texte');
    lisezmoi.deposer(r, 'racine');
    assert.equal(fs.readFileSync(path.join(r, lisezmoi.NOM), 'utf8'), lisezmoi.texte('racine'));
  });

  await test('dossier Google Drive pour ordinateur : avertissement', async () => {
    const miroir = path.join(TMP, 'G', 'Mon Drive');
    fs.mkdirSync(miroir, { recursive: true });
    const e = service.definirDossier(miroir);
    assert.match(e.avertissement, /Google Drive/);
    assert.equal(service.definirDossier(partage).avertissement, null);
  });

  await test('dossier absent (cle debranchee) : message, rien ne casse', async () => {
    etat.appareil().dossier_synchro = path.join(TMP, 'cle-debranchee');
    const r = await service.synchroniser();
    assert.match(r.erreur, /introuvable/);
    assert.ok(db.compterOeuvres() > 400);
  });
}

(async () => {
  await transport();
  await entree();
  await boutEnBout();
  db.fermer();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* verrou Windows */ }
  console.log(`\n${nOk} ok, ${nKo} KO`);
  process.exit(nKo ? 1 : 0);
})();
