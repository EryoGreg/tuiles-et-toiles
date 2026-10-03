'use strict';
/**
 * Vitesse de la synchro Drive (0.3.11) : synchro rapide par le fil des
 * changements, fiche reecrite seulement si elle change, caches de dossiers et
 * de fiches d'une synchro a l'autre. Service + deux vraies bases + faux Drive
 * (appels comptes), aussi a travers le vrai code HTTP (drive-api.js).
 *
 *     node scripts/lancer-node.js tests/synchro-rapide.test.js
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
const { parLots } = src('synchro/echange');
const erreurs = src('synchro/erreurs');
const { viderCaches, creerTransportDrive } = src('synchro/transport-drive');
const { creerFauxDrive, fetchFauxDrive } = require('./faux-drive');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-rapide-'));
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
  return images;
}

/** Appels faits au faux Drive pendant fn. */
async function compter(faux, fn) {
  const avant = { ...faux.appels };
  const r = await fn();
  const d = {};
  for (const k of Object.keys(faux.appels)) d[k] = faux.appels[k] - avant[k];
  d.total = Object.values(d).reduce((x, y) => x + y, 0);
  return { r, d };
}

const auto = (api) => service.synchroniserDrive(null, api, { auto: true });
const manuelle = (api) => service.synchroniserDrive(null, api);
const fil = () => JSON.parse(db.etatSync('drive_fil') || 'null');

/** Monde : PC et telephone inscrits sur le meme faux Drive, converges. */
async function monde() {
  viderCaches();
  const faux = creerFauxDrive();
  const PC = fs.mkdtempSync(path.join(TMP, 'pc-')), TEL = fs.mkdtempSync(path.join(TMP, 'tel-'));
  ouvrir(PC);
  edition.creer({ titre: 'Tuile du PC', artiste: 'x' });
  assert.ok(!(await manuelle(faux)).erreur);
  ouvrir(TEL);
  await manuelle(faux);                       // decision demandee
  service.choisirRemplacement(null);
  assert.ok(!(await manuelle(faux)).erreur);
  ouvrir(PC); await manuelle(faux);
  ouvrir(TEL); await manuelle(faux);
  return { faux, PC, TEL };
}

async function tout() {
  console.log('synchro rapide (fil des changements)');

  await test('rien de neuf : synchro auto en UNE requete (fil), aucune lecture ni ecriture', async () => {
    const { faux, PC } = await monde();
    ouvrir(PC);
    await auto(faux);   // premiere auto apres convergence (peut relire les ecritures du telephone)
    const { r, d } = await compter(faux, () => auto(faux));
    assert.ok(!r.erreur, r.erreur);
    assert.equal(r.rapide, true);
    assert.equal(d.changements, 1);
    assert.equal(d.total, 1, JSON.stringify(d));
    assert.equal(service.etat().derniereDrive.rapide, true);
  });

  await test('modification sur l\'autre appareil : la synchro auto suivante est complete et la recoit', async () => {
    const { faux, PC, TEL } = await monde();
    ouvrir(PC); await auto(faux); await auto(faux);
    ouvrir(TEL);
    const t = edition.creer({ titre: 'Vue au musee', artiste: 'y' });
    assert.ok(!(await auto(faux)).rapide, 'quelque chose a envoyer : complete');
    ouvrir(PC);
    const r = await auto(faux);
    assert.ok(!r.rapide);
    assert.equal(r.appliquees > 0, true);
    assert.equal(db.oeuvre(t.id).titre, 'Vue au musee');
  });

  await test('modification locale : jamais de raccourci (il y a des ops a envoyer)', async () => {
    const { faux, PC } = await monde();
    ouvrir(PC); await auto(faux); await auto(faux);
    edition.creer({ titre: 'Nouvelle', artiste: 'z' });
    const r = await auto(faux);
    assert.ok(!r.rapide);
    assert.ok(r.poussees > 0);
  });

  await test('compteurs de vues seulement : envoyes (pas de raccourci)', async () => {
    const { faux, PC } = await monde();
    ouvrir(PC); await auto(faux); await auto(faux);
    const id = db.instance().prepare('SELECT id FROM pack.oeuvres LIMIT 1').get().id;
    db.instance().prepare('INSERT INTO user_stats (oeuvre_id, appareil, vues, dernier_vu) VALUES (?, ?, 3, ?)')
      .run(id, etat.appareil().id, new Date().toISOString());
    const r = await auto(faux);
    assert.ok(!r.rapide);
    assert.ok(r.poussees > 0);
  });

  await test('pas de va-et-vient : deux appareils en synchro auto alternee finissent tous deux en rapide', async () => {
    const { faux, PC, TEL } = await monde();
    const res = [];
    for (let i = 0; i < 6; i++) {
      ouvrir(i % 2 ? TEL : PC);
      res.push((await auto(faux)).rapide ? 'R' : 'C');
    }
    assert.deepEqual(res.slice(-2), ['R', 'R'], res.join(''));
  });

  await test('ecriture d\'un autre appareil PENDANT ma synchro : la suivante est complete (relire)', async () => {
    const { faux, PC, TEL } = await monde();
    ouvrir(TEL); const idTel = etat.appareil().id;
    ouvrir(PC); await auto(faux); await auto(faux);
    edition.creer({ titre: 'Declencheur', artiste: 'x' });   // force une synchro complete
    // Pendant cette synchro, le telephone ecrit (on touche sa fiche au 5e listing).
    const fiche = faux.trouver('Tuiles et Toiles', 'appareils', idTel + '.json');
    let n = 0;
    const espion = { ...faux, lister: async (...a) => { if (++n === 5) faux.toucher(fiche.id); return faux.lister(...a); } };
    espion.memoCle = undefined;
    assert.ok(!(await service.synchroniserDrive(null, faux, { auto: true })).rapide);
    void espion;
    // Variante directe : une ecriture etrangere apres le jeton0 et avant la fin.
    edition.creer({ titre: 'Declencheur 2', artiste: 'x' });
    const changements = faux.changements.bind(faux);
    let premier = true;
    faux.changements = async (j) => { if (premier) { premier = false; faux.toucher(fiche.id); } return changements(j); };
    await auto(faux);
    faux.changements = changements;
    assert.equal(fil().relire, true, 'ecriture etrangere notee');
    const r = await auto(faux);
    assert.ok(!r.rapide, 'relire -> complete');
    assert.equal(fil().relire, false);
    assert.equal((await auto(faux)).rapide, true);
  });

  await test('synchro manuelle : toujours complete (bouton = reparation)', async () => {
    const { faux, PC } = await monde();
    ouvrir(PC); await auto(faux); await auto(faux);
    const r = await manuelle(faux);
    assert.ok(!r.rapide);
  });

  await test('plus de 6 h depuis la derniere complete : complete', async () => {
    const { faux, PC } = await monde();
    ouvrir(PC); await auto(faux); await auto(faux);
    const f = fil();
    db.definirEtatSync('drive_fil', JSON.stringify({ ...f, complet_le: new Date(Date.now() - 7 * 3600e3).toISOString() }));
    assert.ok(!(await auto(faux)).rapide);
    assert.equal((await auto(faux)).rapide, true);
  });

  await test('renommer, retirer un appareil : la synchro suivante est complete (fiche publiee)', async () => {
    const { faux, PC, TEL } = await monde();
    ouvrir(TEL); const idTel = etat.appareil().id;
    ouvrir(PC); await auto(faux); await auto(faux);
    service.renommer('PC du salon');
    const { r, d } = await compter(faux, () => auto(faux));
    assert.ok(!r.rapide);
    assert.ok(d.maj >= 1, 'fiche reecrite');
    assert.equal(JSON.parse(faux.trouver('Tuiles et Toiles', 'appareils', etat.appareil().id + '.json').octets).nom, 'PC du salon');
    await auto(faux);
    service.retirerAppareil(idTel, true);
    assert.ok(!(await auto(faux)).rapide);
  });

  await test('image en echec : la synchro suivante est complete, puis rapide une fois reprise', async () => {
    const { faux, PC } = await monde();
    ouvrir(PC); await auto(faux); await auto(faux);
    db.definirEtatSync('images_a_reprendre', JSON.stringify({ sens: 'envoi', echecs: 1 }));
    assert.ok(!(await auto(faux)).rapide);
    assert.equal(db.etatSync('images_a_reprendre'), '');
    assert.equal((await auto(faux)).rapide, true);
  });

  await test('image annoncee mais absente du Drive : forcee 24 h seulement', async () => {
    const { faux, PC, TEL } = await monde();
    ouvrir(TEL);
    const images = path.join(TEL, 'images-locales');
    const nom = require('crypto').randomUUID() + '.jpg';
    fs.writeFileSync(path.join(images, nom), 'jpeg');
    edition.creer({ titre: 'Avec image', artiste: 'x', image: nom });
    await manuelle(faux);
    const img = faux.trouver('Tuiles et Toiles', 'images', nom);
    await faux.supprimer(img.id);                     // l'image disparait du Drive
    ouvrir(PC);
    await auto(faux);
    assert.ok(db.etatSync('images_a_reprendre'), 'image manquante notee');
    assert.ok(!(await auto(faux)).rapide);
    db.definirEtatSync('images_manquantes_depuis', new Date(Date.now() - 25 * 3600e3).toISOString());
    await auto(faux);                                  // complete : note, mais plus forcee
    assert.equal(db.etatSync('images_a_reprendre'), '');
    assert.equal((await auto(faux)).rapide, true);
  });

  await test('premiere synchro apres mise a jour (pas encore de jeton) : complete, puis rapide', async () => {
    const { faux, PC } = await monde();
    ouvrir(PC);
    db.definirEtatSync('drive_fil', '');
    assert.ok(!(await auto(faux)).rapide);
    await auto(faux);
    assert.equal((await auto(faux)).rapide, true);
  });

  await test('fil des changements en panne : synchro complete normale, rien ne casse', async () => {
    const { faux, PC } = await monde();
    ouvrir(PC); await auto(faux); await auto(faux);
    const changements = faux.changements;
    faux.changements = async () => { throw new Error('Drive 500'); };
    const r = await auto(faux);
    faux.changements = changements;
    assert.ok(!r.erreur, r.erreur);
    assert.ok(!r.rapide);
  });

  console.log('ecritures et lectures epargnees');

  await test('synchro complete sans rien de neuf : aucune ecriture (fiche inchangee, pas de segment)', async () => {
    const { faux, PC } = await monde();
    ouvrir(PC); await manuelle(faux);
    const { r, d } = await compter(faux, () => manuelle(faux));
    assert.ok(!r.erreur, r.erreur);
    assert.equal(d.maj, 0, JSON.stringify(d));
    assert.equal(d.creer, 0, JSON.stringify(d));
  });

  await test('fiche reecrite au moins toutes les 6 h (signe de vie)', async () => {
    const { faux, PC } = await monde();
    ouvrir(PC); await manuelle(faux);
    const e = faux.trouver('Tuiles et Toiles', 'appareils', etat.appareil().id + '.json');
    const f = JSON.parse(e.octets);
    await faux.majFichier(e.id, Buffer.from(JSON.stringify({ ...f, vu_le: new Date(Date.now() - 7 * 3600e3).toISOString() })));
    const { d } = await compter(faux, () => manuelle(faux));
    assert.equal(d.maj, 1);
    assert.ok(Date.now() - Date.parse(JSON.parse(e.octets).vu_le) < 60e3);
  });

  await test('dossiers et fiches gardes d\'une synchro a l\'autre : bien moins d\'appels', async () => {
    const { faux, PC } = await monde();
    viderCaches();                                     // « relance » de l'app
    ouvrir(PC);
    const a = await compter(faux, () => manuelle(faux));
    const b = await compter(faux, () => manuelle(faux));
    assert.ok(b.d.lister < a.d.lister, `listes ${a.d.lister} -> ${b.d.lister}`);
    assert.ok(b.d.lire < a.d.lire || a.d.lire === 0, `lectures ${a.d.lire} -> ${b.d.lire}`);
    assert.equal(b.d.lire, 0, 'fiches inchangees : pas relues');
  });

  await test('fiche modifiee par un autre appareil : relue (date de modification)', async () => {
    const { faux, PC, TEL } = await monde();
    ouvrir(PC); await manuelle(faux);
    ouvrir(TEL); service.renommer('Mon Pixel'); await manuelle(faux);
    ouvrir(PC);
    await manuelle(faux);
    assert.ok(service.listeAppareils().some((x) => x.nom === 'Mon Pixel'));
  });

  await test('dossier supprime ailleurs : erreur une fois, cache oublie, la synchro suivante repart', async () => {
    const { faux, PC } = await monde();
    ouvrir(PC); await manuelle(faux);
    const appareils = faux.trouver('Tuiles et Toiles', 'appareils');
    for (const e of [...faux.elements.values()].filter((x) => x.parent === appareils.id)) await faux.supprimer(e.id);
    await faux.supprimer(appareils.id);
    const r1 = await manuelle(faux);
    const r2 = r1.erreur ? await manuelle(faux) : r1;
    assert.ok(!r2.erreur, r2.erreur);
    assert.ok(faux.trouver('Tuiles et Toiles', 'appareils', etat.appareil().id + '.json'), 'fiche recreee');
  });

  await test('cache par compte : un autre compte (autre Drive) ne reutilise pas les dossiers', async () => {
    viderCaches();
    const f1 = creerFauxDrive(), f2 = creerFauxDrive();
    const t1 = creerTransportDrive(f1, { cleCache: 'drive:a@x' });
    await t1.preparer('aaaa0001');
    const t2 = creerTransportDrive(f2, { cleCache: 'drive:b@x' });
    await t2.preparer('aaaa0001');
    assert.ok(f2.trouver('Tuiles et Toiles', 'journaux', 'aaaa0001'), 'dossiers crees dans le 2e Drive');
  });

  await test('parLots : resultats dans l\'ordre, au plus n en meme temps', async () => {
    let enCours = 0, max = 0;
    const r = await parLots([5, 1, 4, 2, 3, 0, 6, 7], 3, async (x) => {
      enCours++; max = Math.max(max, enCours);
      await new Promise((ok) => setTimeout(ok, x * 3));
      enCours--;
      return x * 10;
    });
    assert.deepEqual(r, [50, 10, 40, 20, 30, 0, 60, 70]);
    assert.ok(max <= 3);
    assert.deepEqual(await parLots([], 3, async () => 1), []);
  });

  console.log('erreurs dites a l\'utilisateur');

  await test('classement : type et phrase courte, quelle que soit l\'origine du message', () => {
    const cas = [
      [{ erreur: 'Session Google expirée (invalid_grant).', jetonMort: true }, 'session'],
      ['request to https://oauth2.googleapis.com/token failed, reason: getaddrinfo ENOTFOUND oauth2.googleapis.com', 'reseau'],
      ['net::ERR_NAME_NOT_RESOLVED', 'reseau'],
      ['[tirer] net::ERR_NETWORK_IO_SUSPENDED', 'reseau'],
      ['TypeError: Failed to fetch', 'reseau'],
      ['Drive 429 : {"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}', 'limite'],
      ['Drive 403 : {"error":{"errors":[{"reason":"dailyLimitExceeded","message":"quota"}]}}', 'limite'],
      ['Drive 503 : backendError', 'drive'],
      ['Envoi 500 : internal', 'drive'],
      ['Lecture Drive 404 : notFound', 'refus'],
      ['Drive 403 : insufficientFilePermissions', 'refus'],
      ['Google Drive non connecté.', 'compte'],
      ['Dossier de synchro introuvable (clé USB débranchée, lecteur réseau absent ?).', 'dossier'],
      ['Une synchro est déjà en cours.', 'encours'],
      ['[pousser] Cannot read properties of undefined (reading \'hlc\')', 'interne'],
      ['', 'interne']
    ];
    for (const [r, type] of cas) {
      const c = erreurs.classer(r);
      assert.equal(c.type, type, JSON.stringify(r));
      assert.ok(c.message.startsWith('Synchro impossible : '));
      assert.ok(c.message.length < 110, 'court : ' + c.message);
    }
  });

  await test('echec : type garde (etat.echec), detail technique a part, efface au succes suivant', async () => {
    const { faux, PC } = await monde();
    ouvrir(PC);
    const panne = { ...faux, lister: async () => { throw new Error('Drive 503 : backendError'); } };
    const r = await service.synchroniserDrive(null, panne, { auto: false });
    assert.equal(r.typeErreur, 'drive');
    assert.equal(r.erreur, 'Synchro impossible : Google Drive ne répond pas (panne passagère).');
    assert.match(r.detail, /503/);
    const e = service.etat().echec;
    assert.equal(e.type, 'drive');
    assert.equal(e.par, 'drive');
    assert.equal(e.auto, false);
    assert.ok(!(await manuelle(faux)).erreur);
    assert.equal(service.etat().echec, null);
  });

  console.log('session Google expiree : un seul etat (0.3.12)');

  const jetonMort = (faux) => ({
    ...faux,
    lister: async () => { const e = new Error('Session Google expirée (invalid_grant).'); e.jetonMort = true; throw e; },
    jetonChangements: async () => { const e = new Error('Session Google expirée (invalid_grant).'); e.jetonMort = true; throw e; },
    changements: async () => { const e = new Error('Session Google expirée (invalid_grant).'); e.jetonMort = true; throw e; }
  });

  await test('synchro AUTO refusee (jeton mort) : session expiree notee, typee « session »', async () => {
    const { faux, PC } = await monde();
    ouvrir(PC);
    assert.equal(service.sessionExpiree(), null);
    const r = await auto(jetonMort(faux));
    assert.equal(r.typeErreur, 'session');
    assert.ok(service.sessionExpiree(), 'date notee');
    assert.equal(service.etat().sessionExpiree, service.sessionExpiree());
  });

  await test('synchro MANUELLE refusee : notee aussi (avant : seulement en auto -> « Connecte » affiche a tort)', async () => {
    const { faux, PC } = await monde();
    ouvrir(PC);
    await manuelle(jetonMort(faux));
    assert.ok(service.sessionExpiree());
  });

  await test('date de la premiere expiration gardee, puis effacee par une synchro reussie', async () => {
    const { faux, PC } = await monde();
    ouvrir(PC);
    await auto(jetonMort(faux));
    const d1 = service.sessionExpiree();
    await new Promise((ok) => setTimeout(ok, 5));
    await manuelle(jetonMort(faux));
    assert.equal(service.sessionExpiree(), d1);
    assert.ok(!(await manuelle(faux)).erreur);
    assert.equal(service.sessionExpiree(), null);
    assert.equal(service.etat().sessionExpiree, null);
  });

  await test('autres echecs (reseau, panne, synchro deja en cours) : la session expiree reste', async () => {
    const { faux, PC } = await monde();
    ouvrir(PC);
    await auto(jetonMort(faux));
    const d1 = service.sessionExpiree();
    const panne = async () => { throw new Error('fetch failed'); };
    const horsLigne = { ...faux, lister: panne, jetonChangements: panne, changements: panne };
    assert.equal((await manuelle(horsLigne)).typeErreur, 'reseau');
    assert.equal(service.sessionExpiree(), d1);
    const [r1, r2] = await Promise.all([manuelle(faux), manuelle(faux)]);
    assert.match(r2.erreur, /déjà en cours/);
    assert.ok(!r1.erreur);
    assert.equal(service.sessionExpiree(), null, 'la synchro reussie l\'efface');
  });

  await test('erreur reseau seule : jamais « session expiree » (pas de pause de la synchro auto)', async () => {
    const { faux, PC } = await monde();
    ouvrir(PC);
    const panne = async () => { throw new Error('fetch failed'); };
    const horsLigne = { ...faux, lister: panne, jetonChangements: panne, changements: panne };
    await auto(horsLigne);
    assert.equal(service.sessionExpiree(), null);
  });

  await test('connexion refaite (sessionRetablie) : etat efface', async () => {
    const { faux, PC } = await monde();
    ouvrir(PC);
    await auto(jetonMort(faux));
    service.sessionRetablie();
    assert.equal(service.sessionExpiree(), null);
    service.sessionRetablie();   // sans effet si rien a effacer
    assert.equal(service.sessionExpiree(), null);
  });

  await test('decision « remplace-t-il un autre ? » : pas un echec', async () => {
    viderCaches();
    const faux = creerFauxDrive();
    ouvrir(fs.mkdtempSync(path.join(TMP, 'a-'))); await manuelle(faux);
    ouvrir(fs.mkdtempSync(path.join(TMP, 'b-')));
    const r = await manuelle(faux);
    assert.equal(r.decisionRequise, true);
    assert.equal(r.typeErreur, undefined);
    assert.equal(service.etat().echec, null);
  });

  console.log('a travers le vrai code HTTP (drive-api.js)');

  await test('fil des changements et dates de modification par HTTP : rapide en 1 requete', async () => {
    viderCaches();
    const faux = creerFauxDrive();
    let requetes = 0;
    const fetchF = fetchFauxDrive(faux);
    const journal = { evt() {}, erreur() {}, avertir() {}, debug() {} };
    const { api } = require(path.join(RACINE, 'src/main/drive-api'))({ fetch: (...a) => { requetes++; return fetchF(...a); }, journal });
    const http = api({ getAccessToken: async () => ({ token: 'jeton' }) });
    const DIR = fs.mkdtempSync(path.join(TMP, 'http-'));
    ouvrir(DIR);
    edition.creer({ titre: 'Par HTTP', artiste: 'x' });
    assert.ok(!(await service.synchroniserDrive(null, http)).erreur);
    await service.synchroniserDrive(null, http, { auto: true });
    const avant = requetes;
    const r = await service.synchroniserDrive(null, http, { auto: true });
    assert.equal(r.rapide, true);
    assert.equal(requetes - avant, 1);
    const l = await http.lister('root', { dossier: true });
    assert.ok(l[0].modifiedTime, 'modifiedTime renvoye');
    assert.match(await http.jetonChangements(), /^\d+$/);
  });
}

(async () => {
  await tout();
  db.fermer();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* verrou */ }
  console.log(`\n${nOk} ok, ${nKo} KO`);
  process.exit(nKo ? 1 : 0);
})();
