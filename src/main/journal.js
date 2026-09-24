'use strict';
/**
 * Journal de fonctionnement : %APPDATA%\Tuiles et Toiles\logs\journal.log
 * (data/logs/ en dev). Sert a retrouver vite un bug ou un cas imprevu —
 * volontairement bavard.
 *
 * Une ligne par evenement, colonnes alignees, facile a filtrer (findstr, grep,
 * Ctrl+F) :
 *
 *   2026-09-24T11:44:42.390Z  INFO   synchro   pousser             s=3fa2c1  {"poussees":12,"segment":"…"}
 *   └── horodatage UTC ──┘  niveau domaine   evenement           session   details JSON
 *
 * Niveaux : DEBUG (routine : chaque appel IPC), INFO (action, etape),
 * WARN (anomalie geree : refus, conflit, image rejetee), ERREUR (exception).
 * Domaines : app, ipc, ui, db, edition, image, jeu, synchro, drive,
 * sauvegarde, maj, raccourcis, rapport.
 *
 * Jamais de secret dans le journal : les cles qui ressemblent a un jeton sont
 * remplacees par « *** ». Les donnees personnelles (chemins, email) restent
 * en clair ICI, localement ; elles sont masquees dans le rapport envoye
 * (rapport.js).
 *
 * Rotation : 5 fichiers de 5 Mo (journal.log, journal.log.1 … .4).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX = 5 * 1024 * 1024;
const NB_FICHIERS = 5;
const SESSION = crypto.randomBytes(3).toString('hex');
const LONG_MAX = 2000;                  // chaine plus longue : tronquee
const CLES_SECRETES = /token|secret|password|mot_?de_?passe|authorization|code_?verifier|refresh/i;

let dossier = null;
let fichier = null;
let echo = true;   // recopie sur la sortie standard (terminal de dev)

// --- serialisation sure -----------------------------------------------------

function resumerValeur(v, profondeur = 0) {
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.length > LONG_MAX ? v.slice(0, LONG_MAX) + `…[+${v.length - LONG_MAX} car.]` : v;
  if (typeof v === 'bigint') return String(v);
  if (typeof v === 'function') return '[fonction]';
  if (v instanceof Error) return { erreur: v.message, code: v.code, stack: String(v.stack || '').split('\n').slice(0, 8).join(' | ') };
  if (Buffer.isBuffer(v) || ArrayBuffer.isView(v)) return { octets: v.byteLength };
  if (v instanceof ArrayBuffer) return { octets: v.byteLength };
  if (profondeur > 5) return '[…]';
  if (Array.isArray(v)) {
    const l = v.slice(0, 50).map((x) => resumerValeur(x, profondeur + 1));
    if (v.length > 50) l.push(`…[+${v.length - 50} elements]`);
    return l;
  }
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    out[k] = CLES_SECRETES.test(k) && x ? '***' : resumerValeur(x, profondeur + 1);
  }
  return out;
}

function json(v) {
  if (v === undefined) return '';
  try { return JSON.stringify(resumerValeur(v)); } catch { return JSON.stringify(String(v)); }
}

/**
 * Description d'un texte saisi : longueur, alphabets presents, caracteres
 * speciaux. Pour retrouver les cas « cyrillique », « emoji », « caractere de
 * controle colle depuis Word », « nom de fichier interdit »…
 */
function decrireTexte(s) {
  if (s == null) return null;
  const t = String(s);
  const scripts = [];
  const essais = [
    ['latin', /\p{Script=Latin}/u], ['cyrillique', /\p{Script=Cyrillic}/u], ['grec', /\p{Script=Greek}/u],
    ['arabe', /\p{Script=Arabic}/u], ['hebreu', /\p{Script=Hebrew}/u], ['han', /\p{Script=Han}/u],
    ['kana', /[\p{Script=Hiragana}\p{Script=Katakana}]/u], ['hangul', /\p{Script=Hangul}/u],
    ['emoji', /\p{Extended_Pictographic}/u]
  ];
  for (const [nom, re] of essais) if (re.test(t)) scripts.push(nom);
  const d = { long: t.length, extrait: t.length > 80 ? t.slice(0, 80) + '…' : t };
  if (scripts.length) d.scripts = scripts;
  const controles = (t.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g) || []).length;
  if (controles) d.controles = controles;
  const invisibles = (t.match(/[\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g) || []).length;
  if (invisibles) d.invisibles = invisibles;
  if (/[^\u0000-￿]/u.test(t)) d.horsBMP = true;
  if (t !== t.normalize('NFC')) d.nonNFC = true;
  if (/[<>:"|?*]/.test(t)) d.interditsFichier = true;
  if (t !== t.trim()) d.espacesBords = true;
  return d;
}

// --- ecriture ---------------------------------------------------------------

// Tant que configurer() n'a pas ete appele (tests, scripts), rien n'est ecrit.
function ecrire(s) {
  if (!fichier) return;
  try {
    fs.appendFileSync(fichier, s);
    if (fs.statSync(fichier).size > MAX) tourner();
  } catch { /* disque plein / verrou : le journal ne doit jamais bloquer l'app */ }
  if (echo) { try { process.stdout.write(s); } catch { /* pas de tty */ } }
}

function tourner() {
  for (let i = NB_FICHIERS - 1; i >= 1; i--) {
    const de = i === 1 ? fichier : fichier + '.' + (i - 1);
    const vers = fichier + '.' + i;
    try { if (fs.existsSync(de)) { fs.rmSync(vers, { force: true }); fs.renameSync(de, vers); } } catch { /* verrou */ }
  }
}

const col = (s, n) => (s.length >= n ? s : s + ' '.repeat(n - s.length));

/**
 * Evenement structure.
 * @param {string} domaine  app, ipc, ui, db, edition, image, synchro, drive…
 * @param {string} quoi     nom court de l'evenement (sans espace de preference)
 * @param {*} [donnees]     details (objet serialise en JSON, tronque si enorme)
 * @param {'DEBUG'|'INFO'|'WARN'|'ERREUR'} [niveau]
 */
function evt(domaine, quoi, donnees, niveau = 'INFO') {
  ecrire(`${new Date().toISOString()}  ${col(niveau, 6)} ${col(String(domaine), 10)} ${col(String(quoi), 22)} s=${SESSION}  ${json(donnees)}\n`);
}

const debug = (d, q, x) => evt(d, q, x, 'DEBUG');
const avertir = (d, q, x) => evt(d, q, x, 'WARN');
/** Exception : message, code, pile (8 niveaux) + contexte. */
function erreur(d, q, e, contexte) {
  evt(d, q, { ...(contexte || {}), erreur: e && e.message ? e.message : String(e), code: e && e.code,
    stack: e && e.stack ? String(e.stack).split('\n').slice(0, 8).join(' | ') : undefined }, 'ERREUR');
}

/** Chronometre : const fin = chrono('db', 'reconstruire'); … fin({ n }) */
function chrono(d, q, depart) {
  const t0 = Date.now();
  if (depart !== undefined) debug(d, q + ':debut', depart);
  return (fin, niveau = 'INFO') => evt(d, q, { ...(fin || {}), ms: Date.now() - t0 }, niveau);
}

/**
 * Ancienne API (message libre). « ERREUR xxx » -> niveau ERREUR ;
 * « [ui] xxx » -> domaine ui.
 */
function ligne(msg, extra) {
  const m = String(msg);
  if (m.startsWith('[ui] ')) return evt('ui', m.slice(5), extra, /erreur/i.test(m) ? 'ERREUR' : 'INFO');
  if (m.startsWith('ERREUR ')) return evt('app', m.slice(7), extra, 'ERREUR');
  return evt('app', m, extra);
}

function configurer(d, infos, { console: recopie = true } = {}) {
  dossier = d;
  echo = recopie;
  try {
    fs.mkdirSync(d, { recursive: true });
    fichier = path.join(d, 'journal.log');
    if (fs.existsSync(fichier) && fs.statSync(fichier).size > MAX) tourner();
  } catch { fichier = null; }
  evt('app', '=== SESSION ===', { pid: process.pid, ...(infos || {}) });
}

/** Fichiers du journal, du plus recent au plus ancien (pour le rapport). */
function fichiers() {
  if (!fichier) return [];
  const l = [fichier];
  for (let i = 1; i < NB_FICHIERS; i++) l.push(fichier + '.' + i);
  return l.filter((f) => fs.existsSync(f));
}

/** Attrape ce qui casserait silencieusement le process principal. */
function armerErreurs(app) {
  process.on('uncaughtException', (e) => erreur('app', 'uncaughtException', e));
  process.on('unhandledRejection', (e) => erreur('app', 'unhandledRejection', e));
  process.on('warning', (w) => avertir('app', 'node-warning', { nom: w.name, message: w.message }));
  if (app) {
    app.on('render-process-gone', (_e, _wc, d) => evt('app', 'render-process-gone', d, 'ERREUR'));
    app.on('child-process-gone', (_e, d) => evt('app', 'child-process-gone', d, 'ERREUR'));
  }
}

module.exports = {
  configurer, evt, debug, avertir, erreur, chrono, ligne, armerErreurs, fichiers, decrireTexte, resumerValeur,
  SESSION, get dossier() { return dossier; }
};
