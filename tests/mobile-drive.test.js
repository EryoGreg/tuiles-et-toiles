'use strict';
/**
 * Jeton Drive sur Android (src/mobile/drive.js, 0.3.12) : redemande sans
 * interface par le module natif JetonDrive (AuthorizationClient), plus par
 * SocialLogin.getAuthorizationCode, qui exige un jeton d'identite valide (1 h)
 * et repondait « User is not logged in » une heure apres chaque connexion.
 * Module natif et module de connexion simules.
 *
 *     node scripts/lancer-node.js tests/mobile-drive.test.js
 */

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const RACINE = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-mdrive-'));
const FICHIER = path.join(TMP, 'drive.json');

// Faux @capgo/capacitor-social-login.
const social = { appels: 0, reponse: null };
const SocialLogin = {
  initialize: async () => {},
  logout: async () => {},
  login: async () => ({ result: { accessToken: { token: 'jeton-login' }, profile: { email: 'moi@exemple.fr' } } }),
  getAuthorizationCode: async () => { social.appels++; return social.reponse(); }
};
const charger0 = Module._load;
Module._load = function (demande, ...reste) {
  if (demande === '@capgo/capacitor-social-login') return { SocialLogin };
  return charger0.call(this, demande, ...reste);
};

const journal = require(path.join(RACINE, 'src/main/journal'));
const drive = require(path.join(RACINE, 'src/mobile/drive'));
const erreurs = require(path.join(RACINE, 'src/main/synchro/erreurs'));

let nOk = 0, nKo = 0;
async function test(nom, fn) {
  try { await fn(); nOk++; console.log('  ok  ' + nom); }
  catch (e) { nKo++; console.log('  KO  ' + nom + '\n      ' + String(e.stack || e).split('\n').slice(0, 7).join('\n      ')); }
}

const natif = { appels: [], reponse: null };
function rejet(message, code) { return Object.assign(new Error(message), { code }); }

/** Etat « connecte » (comme apres connecter()), jeton en memoire oublie. */
function connecte(email = 'moi@exemple.fr') {
  drive.deconnecter();
  fs.writeFileSync(FICHIER, JSON.stringify({ connecte: true, email }));
  natif.appels = []; social.appels = 0;
}

(async () => {
  journal.configurer && journal.configurer(path.join(TMP, 'logs'));
  drive.configurer({
    webClientId: 'client-web', fichier: FICHIER,
    jetonNatif: async (email) => { natif.appels.push(email); return natif.reponse(); }
  });

  await test('jeton rendu par le module natif, avec le compte connecte, garde en memoire', async () => {
    connecte('moi@exemple.fr');
    natif.reponse = async () => ({ accessToken: 'jeton-natif' });
    assert.deepEqual(await drive.oauth.getAccessToken(), { token: 'jeton-natif' });
    assert.deepEqual(await drive.oauth.getAccessToken(), { token: 'jeton-natif' });
    assert.deepEqual(natif.appels, ['moi@exemple.fr'], 'un seul appel natif (jeton garde 50 min)');
    assert.equal(social.appels, 0, 'plus de getAuthorizationCode');
  });

  await test('plus d\'une heure apres la connexion : le module natif suffit (bug 0.3.11)', async () => {
    connecte();
    natif.reponse = async () => ({ accessToken: 'neuf' });
    social.reponse = async () => { throw new Error('User is not logged in'); };
    const r = await drive.avecReconnexion(async (oauth) => (await oauth.getAccessToken()).token, null, null, { sansReconnexion: true });
    assert.equal(r, 'neuf');
  });

  await test('acces retire (INTERACTION) : session expiree, jamais d\'ecran en auto', async () => {
    connecte();
    natif.reponse = async () => { throw rejet('interaction requise', 'INTERACTION'); };
    let login = 0;
    const l0 = SocialLogin.login;
    SocialLogin.login = async (...a) => { login++; return l0(...a); };
    const r = await drive.avecReconnexion(async (oauth) => oauth.getAccessToken(), null, null, { sansReconnexion: true });
    SocialLogin.login = l0;
    assert.equal(r.jetonMort, true);
    assert.equal(erreurs.classer(r).type, 'session');
    assert.equal(login, 0);
    assert.equal(social.appels, 0, 'pas de repli : la reponse est sure');
  });

  await test('hors ligne (ApiException 7) : erreur reseau, PAS session expiree', async () => {
    connecte();
    natif.reponse = async () => { throw rejet('7: ', 'ECHEC'); };
    const r = await drive.avecReconnexion(async (oauth) => oauth.getAccessToken(), null, null, { sansReconnexion: true });
    assert.ok(!r.jetonMort);
    assert.equal(erreurs.classer(r).type, 'reseau');
  });

  await test('autre echec natif : repli sur l\'ancien chemin (getAuthorizationCode)', async () => {
    connecte();
    natif.reponse = async () => { throw rejet('Unknown calling package', 'ECHEC'); };
    social.reponse = async () => ({ accessToken: 'jeton-secours' });
    assert.deepEqual(await drive.oauth.getAccessToken(), { token: 'jeton-secours' });
    assert.equal(social.appels, 1);
  });

  await test('repli qui echoue aussi (« User is not logged in ») : session expiree', async () => {
    connecte();
    natif.reponse = async () => { throw rejet('Unknown', 'ECHEC'); };
    social.reponse = async () => { throw new Error('User is not logged in'); };
    await assert.rejects(drive.oauth.getAccessToken(), (e) => e.jetonMort === true);
  });

  await test('jeton natif vide : repli', async () => {
    connecte();
    natif.reponse = async () => ({ accessToken: '' });
    social.reponse = async () => ({ accessToken: 'secours' });
    assert.deepEqual(await drive.oauth.getAccessToken(), { token: 'secours' });
  });

  await test('synchro manuelle, acces retire : nouvelle connexion (ecran) puis reprise', async () => {
    connecte();
    let n = 0;
    natif.reponse = async () => { n++; throw rejet('interaction requise', 'INTERACTION'); };
    const r = await drive.avecReconnexion(async (oauth) => ({ token: (await oauth.getAccessToken()).token }));
    assert.equal(r.reconnecte, true);
    assert.equal(r.token, 'jeton-login', 'jeton de la connexion, garde en memoire');
    assert.equal(n, 1);
  });

  await test('pas connecte : rien n\'est demande', async () => {
    drive.deconnecter();
    natif.appels = [];
    const r = await drive.avecReconnexion(async (oauth) => oauth.getAccessToken(), null, null, { sansReconnexion: true });
    assert.match(r.erreur, /non connecté/);
    assert.equal(natif.appels.length, 0);
  });

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* verrou */ }
  console.log(`\n${nOk} ok, ${nKo} KO`);
  process.exit(nKo ? 1 : 0);
})();
