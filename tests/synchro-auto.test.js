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
  const m = { t: 1e12, attente: 0, actif: true, cibles: ['drive'], appels: [], reponse: () => ({}) };
  m.auto = creerAuto({
    actif: () => m.actif,
    cibles: () => m.cibles,
    aEnvoyer: () => m.attente,
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
