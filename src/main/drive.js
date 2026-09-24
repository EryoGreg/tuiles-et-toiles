'use strict';
/**
 * Sauvegarde des donnees utilisateur dans Google Drive.
 *
 * Etape 1 de la synchro. Snapshot au fichier entier : le zip de sauvegarde.js
 * (utilisateur.db + images-locales) est televerse dans un dossier « Tuiles et
 * Toiles » du Drive de l'utilisateur. Scope drive.file : l'app ne voit que les
 * fichiers qu'elle a elle-meme crees.
 *
 * Conflit : on garde le headRevisionId du fichier distant a la derniere
 * synchro. Si le distant a bouge depuis, push/pull s'arretent et demandent
 * confirmation. Avant tout ecrasement, la version distante est copiee dans
 * « Tuiles et Toiles/historique/ » — rien n'est jamais perdu.
 *
 * OAuth : installed-app + PKCE, redirection loopback 127.0.0.1, navigateur
 * systeme. Le refresh token est chiffre (safeStorage / DPAPI) dans %APPDATA%.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { shell, safeStorage, net } = require('electron');
const { OAuth2Client } = require('google-auth-library');

const db = require('./db');
const sauvegarde = require('./sauvegarde');

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const NOM_DOSSIER = 'Tuiles et Toiles';
const NOM_HISTO = 'historique';
const NOM_FICHIER = 'utilisateur.zip';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

const b64url = (buf) => buf.toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Textes des LISEZMOI : communs au dossier Drive et au dossier partage local.
const lisezmoi = require('./lisezmoi');

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
  try { if (cfg) fs.rmSync(cfg.jeton, { force: true }); } catch { /* deja parti */ }
  client = null;
}

// --- etat ----------------------------------------------------------------

function etat() {
  const c = lireClient();
  const jeton = c ? chargerJeton() : null;
  let synchroLe = null;
  try { synchroLe = db.etatSync('drive_synchro_le'); } catch { /* base pas encore ouverte */ }
  return {
    configure: !!c,
    connecte: !!(jeton && jeton.refresh_token),
    email: jeton ? (jeton.email || null) : null,
    synchroLe
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
  promesse.finally(() => clearTimeout(minuteur));
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
  catch (e) { return { erreur: e.message }; }

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

  await shell.openExternal(url);

  let code;
  try { code = await promesse; }
  catch (e) { return { erreur: e.message }; }

  let tokens;
  try { ({ tokens } = await oauth.getToken({ code, codeVerifier: verifier })); }
  catch (e) { return { erreur: 'Échange du code refusé : ' + (e.message || e) }; }
  if (!tokens.refresh_token) {
    return { erreur: 'Google n’a pas renvoyé de refresh token. Révoque l’accès dans ton compte Google puis réessaie.' };
  }
  // Consentement granulaire : la case Drive peut rester decochee.
  if (tokens.scope && !tokens.scope.split(' ').includes(SCOPE)) {
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

// --- appels Drive ----------------------------------------------------------

// Jeton refuse par Google : refresh token expire (7 jours tant que l'ecran de
// consentement est en « Test »), revoque par l'utilisateur, ou scope Drive non
// coche au consentement. Seule issue : refaire le flux OAuth.
function erreurJetonMort(detail) {
  const e = new Error('Session Google expirée (' + detail + ').');
  e.jetonMort = true;
  return e;
}

async function jetonAcces(oauth) {
  let r;
  try { r = await oauth.getAccessToken(); }
  catch (e) {
    const code = e && e.response && e.response.data && e.response.data.error;
    if (code === 'invalid_grant' || /invalid_grant/.test(String(e && e.message))) {
      throw erreurJetonMort('invalid_grant');
    }
    throw e;
  }
  if (!r || !r.token) throw erreurJetonMort('jeton vide');
  return r.token;
}

// 401 : jeton refuse. 403 insufficientPermissions : scope Drive non accorde.
function verifierAcces(status, txt) {
  if (status === 401) throw erreurJetonMort('401');
  if (status === 403 && /insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT/.test(txt)) {
    throw erreurJetonMort('autorisation Drive manquante');
  }
}

async function appelJson(oauth, methode, url, corps) {
  const token = await jetonAcces(oauth);
  const opts = { method: methode, headers: { Authorization: 'Bearer ' + token } };
  if (corps !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(corps);
  }
  const res = await net.fetch(url, opts);
  const txt = await res.text();
  if (!res.ok) {
    verifierAcces(res.status, txt);
    throw new Error('Drive ' + res.status + ' : ' + txt.slice(0, 300));
  }
  return txt ? JSON.parse(txt) : {};
}

async function idDossierNomme(oauth, nom, parent) {
  const q = `name='${nom.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder'`
    + ` and '${parent}' in parents and trashed=false`;
  const r = await appelJson(oauth, 'GET', API + '/files?' + new URLSearchParams({
    q, fields: 'files(id)', spaces: 'drive'
  }));
  if (r.files && r.files.length) return r.files[0].id;
  const cree = await appelJson(oauth, 'POST', API + '/files', {
    name: nom, mimeType: 'application/vnd.google-apps.folder', parents: [parent]
  });
  return cree.id;
}

async function trouverFichier(oauth, dossierId) {
  const q = `name='${NOM_FICHIER}' and '${dossierId}' in parents and trashed=false`;
  const r = await appelJson(oauth, 'GET', API + '/files?' + new URLSearchParams({
    q, fields: 'files(id,headRevisionId,modifiedTime,size)', spaces: 'drive'
  }));
  return (r.files && r.files[0]) || null;
}

async function copierVersHistorique(oauth, dossierId, distant) {
  const histoId = await idDossierNomme(oauth, NOM_HISTO, dossierId);
  try { await majLisezmoi(oauth, histoId, 'historique'); } catch { /* non critique */ }
  const stamp = String(distant.modifiedTime || new Date().toISOString()).replace(/[:.]/g, '-').slice(0, 19);
  await appelJson(oauth, 'POST', API + '/files/' + distant.id + '/copy', {
    name: 'utilisateur-' + stamp + '.zip', parents: [histoId]
  });
}

async function majLisezmoi(oauth, dossierId, cle = 'racine') {
  const token = await jetonAcces(oauth);
  const q = `name='LISEZMOI.txt' and '${dossierId}' in parents and trashed=false`;
  const r = await appelJson(oauth, 'GET', API + '/files?' + new URLSearchParams({
    q, fields: 'files(id)', spaces: 'drive'
  }));
  const donnees = Buffer.from(lisezmoi.texte(cle), 'utf8');
  const id = r.files && r.files[0] && r.files[0].id;

  if (id) {
    await net.fetch(UPLOAD + '/files/' + id + '?uploadType=media',
      { method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'text/plain; charset=UTF-8' }, body: donnees });
    return;
  }
  const limite = '----tt' + crypto.randomBytes(8).toString('hex');
  const meta = JSON.stringify({ name: 'LISEZMOI.txt', parents: [dossierId] });
  const corps = Buffer.concat([
    Buffer.from('--' + limite + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + meta + '\r\n'),
    Buffer.from('--' + limite + '\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n'),
    donnees,
    Buffer.from('\r\n--' + limite + '--\r\n')
  ]);
  await net.fetch(UPLOAD + '/files?uploadType=multipart',
    { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'multipart/related; boundary=' + limite }, body: corps });
}

async function televerser(oauth, dossierId, cheminZip, existant) {
  const token = await jetonAcces(oauth);
  const donnees = fs.readFileSync(cheminZip);

  if (existant) {
    const res = await net.fetch(
      UPLOAD + '/files/' + existant.id + '?uploadType=media&fields=id,headRevisionId,modifiedTime',
      { method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/zip' }, body: donnees }
    );
    if (!res.ok) await echecEnvoi(res);
    return res.json();
  }

  const limite = '----tt' + crypto.randomBytes(8).toString('hex');
  const meta = JSON.stringify({ name: NOM_FICHIER, parents: [dossierId] });
  const corps = Buffer.concat([
    Buffer.from('--' + limite + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + meta + '\r\n'),
    Buffer.from('--' + limite + '\r\nContent-Type: application/zip\r\n\r\n'),
    donnees,
    Buffer.from('\r\n--' + limite + '--\r\n')
  ]);
  const res = await net.fetch(
    UPLOAD + '/files?uploadType=multipart&fields=id,headRevisionId,modifiedTime',
    { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'multipart/related; boundary=' + limite }, body: corps }
  );
  if (!res.ok) await echecEnvoi(res);
  return res.json();
}

async function echecEnvoi(res) {
  const txt = await res.text();
  verifierAcces(res.status, txt);
  throw new Error('Envoi ' + res.status + ' : ' + txt.slice(0, 300));
}

async function telecharger(oauth, fichierId, cible) {
  const token = await jetonAcces(oauth);
  const res = await net.fetch(API + '/files/' + fichierId + '?alt=media',
    { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) {
    const txt = await res.text();
    verifierAcces(res.status, txt);
    throw new Error('Téléchargement ' + res.status);
  }
  fs.writeFileSync(cible, Buffer.from(await res.arrayBuffer()));
}

// --- push / pull -------------------------------------------------------

// Execute op(oauth). Si Google refuse le jeton, on l'oublie, on relance le
// flux OAuth (navigateur) et on retente une seule fois. surReconnexion()
// previent l'interface que le navigateur va s'ouvrir.
async function avecReconnexion(op, surReconnexion) {
  const oauth = clientCourant();
  if (!oauth) return { erreur: 'Google Drive non connecté.' };
  try { return await op(oauth); }
  catch (e) {
    if (!e.jetonMort) return { erreur: e.message || String(e) };
  }

  deconnecter();
  if (surReconnexion) surReconnexion();
  const r = await connecter();
  if (r.erreur) return { erreur: 'Session Google expirée — reconnexion échouée : ' + r.erreur };

  const neuf = clientCourant();
  if (!neuf) return { erreur: 'Google Drive non connecté.' };
  try { return { ...(await op(neuf)), reconnecte: true }; }
  catch (e) { return { erreur: e.message || String(e), reconnecte: true }; }
}

function pousser({ forcer = false } = {}, surReconnexion) {
  return avecReconnexion((oauth) => opPousser(oauth, forcer), surReconnexion);
}

function tirer({ forcer = false } = {}, surReconnexion) {
  return avecReconnexion((oauth) => opTirer(oauth, forcer), surReconnexion);
}

async function opPousser(oauth, forcer) {
  const dossierId = await idDossierNomme(oauth, NOM_DOSSIER, 'root');
  const distant = await trouverFichier(oauth, dossierId);
  const revConnue = db.etatSync('drive_rev');
  const distantABouge = distant && distant.headRevisionId !== revConnue;

  if (distantABouge && !forcer) {
    return { conflit: true, sens: 'pousser', distantModifie: distant.modifiedTime };
  }
  if (distantABouge) await copierVersHistorique(oauth, dossierId, distant);

  const tmp = path.join(os.tmpdir(), 'tuiles-drive-push-' + Date.now() + '.zip');
  let maj;
  try {
    sauvegarde.exporter(tmp);
    maj = await televerser(oauth, dossierId, tmp, distant);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* deja parti */ }
  }
  try { await majLisezmoi(oauth, dossierId); } catch { /* non critique */ }

  db.definirEtatSync('drive_rev', maj.headRevisionId || '');
  db.definirEtatSync('drive_synchro_le', new Date().toISOString());
  return { ok: true, synchroLe: db.etatSync('drive_synchro_le') };
}

async function opTirer(oauth, forcer) {
  const dossierId = await idDossierNomme(oauth, NOM_DOSSIER, 'root');
  const distant = await trouverFichier(oauth, dossierId);
  if (!distant) return { erreur: 'Aucune sauvegarde sur Drive pour l’instant.' };

  if (!forcer && distant.headRevisionId === db.etatSync('drive_rev')) {
    return { aJour: true };
  }

  const tmp = path.join(os.tmpdir(), 'tuiles-drive-pull-' + Date.now() + '.zip');
  let r;
  try {
    await telecharger(oauth, distant.id, tmp);
    r = sauvegarde.importer(tmp);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* deja parti */ }
  }
  if (r.erreur) return r;

  db.definirEtatSync('drive_rev', distant.headRevisionId || '');
  db.definirEtatSync('drive_synchro_le', new Date().toISOString());
  return { ok: true, manifest: r.manifest };
}

module.exports = { configurer, etat, connecter, deconnecter, pousser, tirer };
