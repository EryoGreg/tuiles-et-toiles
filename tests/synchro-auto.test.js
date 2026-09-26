'use strict';
/**
 * Synchro automatique (synchro/auto.js) : quand elle se declenche, pause apres
 * un echec, envoi a la fermeture borne dans le temps. Horloge simulee.
 *
 *     node scripts/lancer-node.js tests/synchro-auto.test.js
 */

const assert = require('assert/strict');
const path = require('path');
const { creerAuto, DELAIS } = require(path.resolve(__dirname, '..', 'src/main/synchro/auto'));

let nOk = 0, nKo = 0;
async function test(nom, fn) {
  try { await fn(); nOk++; console.log('  ok  ' + nom); }
  catch (e) { nKo++; console.log('  KO  ' + nom + '\n      ' + String(e.stack || e).split('\n').slice(0, 6).join('\n      ')); }
}

function monde(o = {}) {
  const m = { t: 1e12, attente: 0, conflits: 0, wifi: true, actif: true, cibles: ['drive'], appels: [], reponse: () => ({}) };
  m.auto = creerAuto({
    actif: () => m.actif,
    cibles: () => m.cibles,
    aEnvoyer: () => m.attente,
    conflitsOuverts: () => m.conflits,
    reseauPermis: () => m.wifi,
    lancer: async (cible, raison) => {
      m.appels.push(cible + ':' + raison);
      const r = await m.reponse(cible, raison);
      if (!r.erreur) m.attente = 0;
      return r;
    },
    maintenant: () => m.t,
    delais: o.delais
  });
  m.avancer = async (ms) => {
    // Un passage toutes les 15 s, comme en vrai.
    for (let fait = 0; fait < ms; fait += DELAIS.verification) {
      m.t += Math.min(DELAIS.verification, ms - fait);
      await m.auto.tic();
    }
  };
  return m;
}

(async () => {
  console.log('synchro automatique');

  await test('rien a envoyer : une synchro tous les quarts d\'heure seulement', async () => {
    const m = monde();
    await m.avancer(14 * 60e3);
    assert.deepEqual(m.appels, []);
    await m.avancer(60e3);
    assert.deepEqual(m.appels, ['drive:periodique']);
  });

  await test('conflits ouverts : reception toutes les 2 min, puis retour au quart d\'heure', async () => {
    const m = monde();
    m.conflits = 2;
    await m.avancer(4 * 60e3);
    assert.deepEqual(m.appels, ['drive:conflits-ouverts', 'drive:conflits-ouverts']);
    m.conflits = 0;
    await m.avancer(10 * 60e3);
    assert.equal(m.appels.length, 2);
  });

  await test('modification : envoi une fois le calme revenu, pas pendant la saisie', async () => {
    const m = monde();
    for (let i = 0; i < 6; i++) { m.attente++; await m.avancer(15e3); }   // saisie continue
    assert.deepEqual(m.appels, [], 'rien pendant la saisie');
    await m.avancer(30e3);
    assert.deepEqual(m.appels, ['drive:modification']);
    await m.avancer(60e3);
    assert.equal(m.appels.length, 1, 'plus rien a envoyer');
  });

  await test('echec (hors ligne) : pause de 5 min puis nouvel essai', async () => {
    const m = monde();
    m.reponse = () => ({ erreur: 'hors ligne' });
    m.attente = 3;
    await m.avancer(45e3);
    assert.equal(m.appels.length, 1);
    await m.avancer(4 * 60e3);
    assert.equal(m.appels.length, 1, 'pause');
    m.reponse = () => ({});
    await m.avancer(90e3);
    assert.equal(m.appels.length, 2);
    assert.equal(m.attente, 0);
  });

  await test('synchro manuelle deja en cours : pas une panne, pas de pause', async () => {
    const m = monde();
    let fois = 0;
    m.reponse = () => (fois++ === 0 ? { erreur: 'Une synchro est déjà en cours.', enCoursPar: 'drive' } : {});
    m.attente = 1;
    await m.avancer(45e3);
    await m.avancer(30e3);
    assert.equal(m.appels.length, 2);
  });

  await test('desactivee, ou aucune cible : jamais lancee', async () => {
    const m = monde();
    m.actif = false; m.attente = 2;
    await m.avancer(20 * 60e3);
    assert.equal(m.appels.length, 0);
    assert.equal(await m.auto.avantFermeture(), 'rien');
    m.actif = true; m.cibles = [];
    await m.avancer(20 * 60e3);
    assert.equal(m.appels.length, 0);
  });

  await test('plusieurs cibles : Drive puis dossier', async () => {
    const m = monde();
    m.cibles = ['drive', 'dossier'];
    await m.auto.declencher('reveil');
    assert.deepEqual(m.appels, ['drive:reveil', 'dossier:reveil']);
  });

  await test('declenchement force (conflit tranche) : meme desactivee ou en pause', async () => {
    const m = monde();
    m.actif = false;
    assert.equal(await m.auto.declencher('reveil'), null, 'non force : rien');
    await m.auto.declencher('conflits-resolus', { forcer: true });
    assert.deepEqual(m.appels, ['drive:conflits-resolus']);
    m.actif = true;
    m.reponse = () => ({ erreur: 'hors ligne' });
    m.attente = 1;
    await m.avancer(45e3);                              // echec -> pause 5 min
    m.reponse = () => ({});
    await m.auto.declencher('conflit-tranche', { forcer: true });
    assert.equal(m.appels[m.appels.length - 1], 'drive:conflit-tranche', 'la pause ne retient pas un choix');
  });

  await test('force pendant une synchro auto : une autre suit, pour emporter le choix', async () => {
    const m = monde();
    let liberer;
    m.reponse = (c, raison) => (raison === 'periodique' ? new Promise((r) => { liberer = () => r({}); }) : {});
    const premiere = m.auto._executer('periodique');
    const seconde = m.auto.declencher('conflit-tranche', { forcer: true });
    liberer();
    await premiere; await seconde;
    assert.deepEqual(m.appels, ['drive:periodique', 'drive:conflit-tranche']);
  });

  await test('differer : plusieurs choix d\'affilee -> une seule synchro', async () => {
    const m = monde();
    m.auto.differer('conflit-tranche', 40);
    m.auto.differer('conflit-tranche', 40);
    await m.auto.differer('conflit-tranche', 40);
    assert.deepEqual(m.appels, ['drive:conflit-tranche']);
    await m.auto.differer('conflits-resolus', 0);
    assert.deepEqual(m.appels, ['drive:conflit-tranche', 'drive:conflits-resolus']);
  });

  await test('Wi-Fi seulement : rien d\'automatique en donnees mobiles, un geste explicite passe', async () => {
    const m = monde();
    m.wifi = false;
    m.attente = 3;
    await m.avancer(20 * 60e3);
    assert.deepEqual(m.appels, [], 'ni modification ni periodique');
    await m.auto.declencher('conflit-tranche', { forcer: true });
    assert.deepEqual(m.appels, ['drive:conflit-tranche']);
    m.wifi = true;
    m.attente = 1;
    await m.avancer(45e3);
    assert.equal(m.appels[m.appels.length - 1], 'drive:modification', 'le Wi-Fi revenu, tout repart');
  });

  await test('fermeture : envoie ce qui reste, attend au plus le delai', async () => {
    const m = monde({ delais: { fermeture: 60 } });
    assert.equal(await m.auto.avantFermeture(), 'rien', 'rien en attente');
    m.attente = 1;
    assert.equal(await m.auto.avantFermeture(), 'fini');
    assert.deepEqual(m.appels, ['drive:fermeture']);
    m.attente = 1;
    m.reponse = () => new Promise(() => {});   // reseau qui ne repond plus
    const t0 = Date.now();
    assert.equal(await m.auto.avantFermeture(), 'delai');
    assert.ok(Date.now() - t0 < 1000);
  });

  console.log(`\n${nOk} ok, ${nKo} KO`);
  process.exit(nKo ? 1 : 0);
})();
