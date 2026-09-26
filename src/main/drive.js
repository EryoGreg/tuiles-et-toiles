'use strict';
/**
 * Acces Google Drive : connexion OAuth, jeton, et l'API minimale dont la
 * synchro ligne a ligne a besoin (synchro/transport-drive.js). Scope
 * drive.file : l'app ne voit que les fichiers qu'elle a elle-meme crees.
 *
 * (Jusqu'a la 0.2, un bouton « Sauvegarder sur Drive » televersait aussi un
 * zip complet, utilisateur.zip, et « Restaurer » le relisait en remplacant la
 * base : retires, la synchro fait mieux et le remplacement faisait diverger
 * les appareils. Les anciens utilisateur.zip et historique/ restent sur Drive,
 * importables par Options -> « Importer une sauvegarde », qui fusionne.)
 *
 * OAuth : installed-app + PKCE, redirection loopback 127.0.0.1, navigateur
 * systeme. Le refresh token est chiffre (safeStorage / DPAPI) dans %APPDATA%.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { shell, safeStorage, net } = require('electron');
const { OAuth2Client } = require('google-auth-library');

const journal = require('./journal');

const SCOPE = 'https://www.googleapis.com/auth/drive.file';

const b64url = (buf) => buf.toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let cfg = null;      // { jeton: <chemin fichier> }
let client = null;   // OAuth2Client memo (jeton courant)

function configurer({ dossierUser }) {
  cfg = { jeton: path.join(dossierUser, 'drive-jeton.bin') };
}

// --- client OAuth embarque --------------------------------------------------

function lireClient() {
  try {
    const j = require('./oauth-client.json');
    const c = j.installed || j.web || j;
    if (!c.client_id || !c.client_secret) return null;
    return { id: c.client_id, secret: c.client_secret };
  } catch { return null; }
}

// --- jeton chiffre ---------------------------------------------------------

function chargerJeton() {
  if (!cfg || !fs.existsSync(cfg.jeton)) return null;
  try {
    const buf = fs.readFileSync(cfg.jeton);
    const txt = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(buf) : buf.toString('utf8');
    return JSON.parse(txt);
  } catch { return null; }
}

function ecrireJeton(obj) {
  const txt = JSON.stringify(obj);
  const buf = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(txt) : Buffer.from(txt, 'utf8');
  fs.writeFileSync(cfg.jeton, buf);
}

function deconnecter() {
  const avait = !!(cfg && fs.existsSync(cfg.jeton));
  try { if (cfg) fs.rmSync(cfg.jeton, { force: true }); }
  catch (e) { journal.erreur('drive', 'deconnexion-fichier-jeton', e); }
  client = null;
  journal.evt('drive', 'deconnecte', { jetonSupprime: avait });
}

// --- etat ----------------------------------------------------------------

function etat() {
  const c = lireClient();
  const jeton = c ? chargerJeton() : null;
  return {
    configure: !!c,
    connecte: !!(jeton && jeton.refresh_token),
    email: jeton ? (jeton.email || null) : null
  };
}

// --- OAuth : connexion ---------------------------------------------------

async function serveurRedirection(attendu) {
  let resoudre; let rejeter;
  const promesse = new Promise((res, rej) => { resoudre = res; rejeter = rej; });
  const serveur = http.createServer((req, rep) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname !== '/') { rep.writeHead(404); rep.end(); return; }
    rep.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    rep.end('<!doctype html><meta charset="utf-8"><title>Tuiles et Toiles</title>'
      + '<body style="font-family:system-ui;background:#14110f;color:#e8e0d4;'
      + 'display:flex;align-items:center;justify-content:center;height:100vh;margin:0">'
      + '<p>Connexion Google Drive terminée. Vous pouvez fermer cet onglet.</p>');
    setTimeout(() => { try { serveur.close(); } catch { /* deja ferme */ } }, 200);
    const err = u.searchParams.get('error');
    const code = u.searchParams.get('code');
    if (err) return rejeter(new Error('Autorisation refusée (' + err + ').'));
    if (u.searchParams.get('state') !== attendu) return rejeter(new Error('État OAuth invalide.'));
    if (!code) return rejeter(new Error('Aucun code reçu de Google.'));
    return resoudre(code);
  });
  await new Promise((r) => serveur.listen(0, '127.0.0.1', r));
  const minuteur = setTimeout(() => {
    try { serveur.close(); } catch { /* deja ferme */ }
    rejeter(new Error('Délai dépassé — connexion abandonnée.'));
  }, 180000);
  // .catch : la promesse derivee de finally rejetterait sinon sans gestionnaire
  // (« unhandledRejection » au delai depasse) ; l'appelant gere l'erreur.
  promesse.finally(() => clearTimeout(minuteur)).catch(() => {});
  return { port: serveur.address().port, promesse };
}

async function connecter() {
  const c = lireClient();
  if (!c) return { erreur: 'Client OAuth absent (src/main/oauth-client.json manquant).' };

  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const attendu = b64url(crypto.randomBytes(16));

  let port; let promesse;
  try { ({ port, promesse } = await serveurRedirection(attendu)); }
  catch (e) { journal.erreur('drive', 'oauth-serveur-local', e); return { erreur: e.message }; }
  journal.evt('drive', 'oauth-debut', { port, client: c.id.slice(0, 12) + '…' });

  // Hote « localhost » : correspond au redirect_uri enregistre (le port est
  // ignore pour une redirection loopback d'un client Desktop). Le serveur, lui,
  // ecoute sur 127.0.0.1 — localhost s'y resout.
  const redirectUri = 'http://localhost:' + port;
  const oauth = new OAuth2Client({ clientId: c.id, clientSecret: c.secret, redirectUri });
  const url = oauth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPE,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state: attendu
  });

  try { await shell.openExternal(url); journal.evt('drive', 'oauth-navigateur-ouvert'); }
  catch (e) { journal.erreur('drive', 'oauth-navigateur', e); }

  let code;
  const t0 = Date.now();
  try { code = await promesse; }
  catch (e) { journal.avertir('drive', 'oauth-sans-code', { erreur: e.message, attenteMs: Date.now() - t0 }); return { erreur: e.message }; }
  journal.evt('drive', 'oauth-code-recu', { attenteMs: Date.now() - t0 });

  let tokens;
  try { ({ tokens } = await oauth.getToken({ code, codeVerifier: verifier })); }
  catch (e) {
    journal.erreur('drive', 'oauth-echange-refuse', e, { reponse: e && e.response && e.response.data });
    return { erreur: 'Échange du code refusé : ' + (e.message || e) };
  }
  journal.evt('drive', 'oauth-jetons', {
    jetonLongTerme: !!tokens.refresh_token, scopes: tokens.scope, expire: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null
  });
  if (!tokens.refresh_token) {
    journal.avertir('drive', 'oauth-sans-refresh-token');
    return { erreur: 'Google n’a pas renvoyé de refresh token. Révoque l’accès dans ton compte Google puis réessaie.' };
  }
  // Consentement granulaire : la case Drive peut rester decochee.
  if (tokens.scope && !tokens.scope.split(' ').includes(SCOPE)) {
    journal.avertir('drive', 'oauth-scope-refuse', { scopes: tokens.scope, attendu: SCOPE });
    return { erreur: 'Accès à Google Drive non accordé — reconnecte-toi et coche la case Google Drive sur l’écran de Google.' };
  }

  oauth.setCredentials(tokens);
  let email = null;
  try {
    const about = await appelJson(oauth, 'GET', API + '/about?fields=user');
    email = (about.user && about.user.emailAddress) || null;
  } catch { /* email non critique */ }

  ecrireJeton({ refresh_token: tokens.refresh_token, email });
  client = null;
  journal.evt('drive', 'oauth-connecte', { email, chiffrement: safeStorage.isEncryptionAvailable() });
  return { connecte: true, email };
}

// --- client courant ----------------------------------------------------

function clientCourant() {
  if (client) return client;
  const c = lireClient();
  const jeton = chargerJeton();
  if (!c || !jeton || !jeton.refresh_token) return null;
  client = new OAuth2Client({ clientId: c.id, clientSecret: c.secret });
  client.setCredentials({ refresh_token: jeton.refresh_token });
  client.on('tokens', (t) => {
    if (t.refresh_token) {
      const j = chargerJeton() || {};
      ecrireJeton({ ...j, refresh_token: t.refresh_token });
    }
  });
  return client;
}

// --- appels Drive (drive-api.js, commun avec le mobile) ---------------------

const API = 'https://www.googleapis.com/drive/v3';
const { api, appelJson } = require('./drive-api')({ fetch: (url, opts) => net.fetch(url, opts), journal });

// --- reconnexion ---------------------------------------------------------

// Execute op(oauth). Si Google refuse le jeton, on l'oublie, on relance le
// flux OAuth (navigateur) et on retente une seule fois. surReconnexion()
// previent l'interface que le navigateur va s'ouvrir.
// sansReconnexion (synchro automatique) : jamais de navigateur ouvert sans
// clic -> { erreur, jetonMort: true }, le jeton est garde pour la prochaine
// synchro manuelle.
async function avecReconnexion(op, surReconnexion, surReconnecte, { sansReconnexion = false } = {}) {
  const oauth = clientCourant();
  if (!oauth) return { erreur: 'Google Drive non connecté.' };
  try { return await op(oauth); }
  catch (e) {
    if (!e.jetonMort) {
      journal.erreur('drive', 'operation-echec', e);
      return { erreur: e.message || String(e) };
    }
    journal.avertir('drive', 'reconnexion-necessaire', { raison: e.message, sansReconnexion });
    if (sansReconnexion) return { erreur: 'Session Google expirée.', jetonMort: true };
  }

  deconnecter();
  if (surReconnexion) surReconnexion();
  const r = await connecter();
  if (r.erreur) {
    journal.avertir('drive', 'reconnexion-echec', { erreur: r.erreur });
    return { erreur: 'Session Google expirée — reconnexion échouée : ' + r.erreur };
  }

  const neuf = clientCourant();
  if (!neuf) return { erreur: 'Google Drive non connecté.' };
  journal.evt('drive', 'reconnecte-reprise');
  if (surReconnecte) surReconnecte();
  try { return { ...(await op(neuf)), reconnecte: true }; }
  catch (e) {
    journal.erreur('drive', 'operation-echec-apres-reconnexion', e);
    return { erreur: e.message || String(e), reconnecte: true };
  }
}

module.exports = { configurer, etat, connecter, deconnecter, api, avecReconnexion };
