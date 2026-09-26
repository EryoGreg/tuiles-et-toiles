'use strict';
/**
 * Mobile : remplace src/main/drive.js (meme interface pour synchro/service.js :
 * configurer, etat, connecter, deconnecter, api, avecReconnexion).
 *
 * Connexion Google NATIVE (Credential Manager d'Android, via
 * @capgo/capacitor-social-login) au lieu du navigateur + serveur local du PC.
 * Meme projet Google Cloud, meme autorisation drive.file ; il faut un client
 * OAuth « Android » (nom de paquet + empreinte SHA-1 de la signature) et le
 * client « Web » dont l'identifiant est passe a initialize (webClientId).
 *
 * Pas de refresh token cote appli : le systeme garde l'autorisation, un jeton
 * d'acces (1 h) est redemande sans rien afficher (getAuthorizationCode). S'il
 * faut de nouveau un choix de compte, c'est connecter() (jamais en auto).
 *
 * Les appels Drive eux-memes : src/main/drive-api.js, commun avec le PC.
 */

const fs = require('fs');
const journal = require('../main/journal');
const { SocialLogin } = require('@capgo/capacitor-social-login');

const SCOPES = ['https://www.googleapis.com/auth/drive.file', 'email', 'profile'];
const FICHIER = '/data/drive.json';   // { connecte, email } : pas de secret

let cfg = { webClientId: null };
let initialise = null;
let jeton = null;   // { token, expire }

const { api } = require('../main/drive-api')({ fetch: (u, o) => fetch(u, o), journal });

function configurer(c) { cfg = { ...cfg, ...c }; }

function lire() { try { return JSON.parse(fs.readFileSync(FICHIER, 'utf8')); } catch { return null; } }

function etat() {
  const f = lire();
  return { configure: !!cfg.webClientId, connecte: !!(f && f.connecte), email: f ? f.email || null : null };
}

function initialiser() {
  if (!initialise) {
    initialise = SocialLogin.initialize({ google: { webClientId: cfg.webClientId, mode: 'online' } })
      .catch((e) => { initialise = null; throw e; });
  }
  return initialise;
}

function memoriser(token) {
  jeton = token ? { token, expire: Date.now() + 50 * 60e3 } : null;
}

async function connecter() {
  if (!cfg.webClientId) return { erreur: 'Connexion Google non configurée dans cette version.' };
  const t0 = Date.now();
  try {
    await initialiser();
    const r = await SocialLogin.login({ provider: 'google', options: { scopes: SCOPES } });
    const res = r && r.result ? r.result : {};
    const token = res.accessToken && res.accessToken.token;
    if (!token) throw new Error('aucun jeton d’accès (autorisation Drive refusée ?)');
    memoriser(token);
    const email = (res.profile && res.profile.email) || null;
    fs.writeFileSync(FICHIER, JSON.stringify({ connecte: true, email, le: new Date().toISOString() }));
    journal.evt('drive', 'oauth-connecte', { email, mobile: true, ms: Date.now() - t0 });
    return { connecte: true, email };
  } catch (e) {
    journal.erreur('drive', 'oauth-echec', e, { mobile: true, ms: Date.now() - t0 });
    return { erreur: 'Connexion Google impossible : ' + (e && e.message || e) };
  }
}

function deconnecter() {
  memoriser(null);
  try { fs.rmSync(FICHIER, { force: true }); } catch { /* deja absent */ }
  initialiser().then(() => SocialLogin.logout({ provider: 'google' })).catch(() => {});
  journal.evt('drive', 'deconnecte', { mobile: true });
}

function erreurJetonMort(detail) {
  const e = new Error('Session Google expirée (' + detail + ').');
  e.jetonMort = true;
  return e;
}

/** Jeton d'acces, redemande sans interface si besoin. */
const oauth = {
  async getAccessToken() {
    if (jeton && jeton.expire > Date.now()) return { token: jeton.token };
    await initialiser();
    let r;
    try { r = await SocialLogin.getAuthorizationCode({ provider: 'google' }); }
    catch (e) { journal.avertir('drive', 'jeton-refuse', { mobile: true, erreur: String(e && e.message || e) }); throw erreurJetonMort('autorisation'); }
    if (!r || !r.accessToken) throw erreurJetonMort('jeton vide');
    memoriser(r.accessToken);
    return { token: r.accessToken };
  }
};

/**
 * Comme sur PC : execute op(oauth) ; jeton refuse -> nouvelle connexion (choix
 * du compte a l'ecran) puis un seul nouvel essai. sansReconnexion (synchro
 * automatique) : jamais d'interface, { erreur, jetonMort }.
 */
async function avecReconnexion(op, surReconnexion, surReconnecte, { sansReconnexion = false } = {}) {
  if (!etat().connecte) return { erreur: 'Google Drive non connecté.' };
  try { return await op(oauth); }
  catch (e) {
    if (!e.jetonMort) { journal.erreur('drive', 'operation-echec', e); return { erreur: e.message || String(e) }; }
    journal.avertir('drive', 'reconnexion-necessaire', { raison: e.message, sansReconnexion, mobile: true });
    if (sansReconnexion) return { erreur: 'Session Google expirée.', jetonMort: true };
  }
  if (surReconnexion) surReconnexion();
  memoriser(null);
  const r = await connecter();
  if (r.erreur) return { erreur: 'Session Google expirée — reconnexion échouée : ' + r.erreur };
  if (surReconnecte) surReconnecte();
  try { return { ...(await op(oauth)), reconnecte: true }; }
  catch (e) { journal.erreur('drive', 'operation-echec-apres-reconnexion', e); return { erreur: e.message || String(e), reconnecte: true }; }
}

module.exports = { configurer, etat, connecter, deconnecter, api, avecReconnexion };
