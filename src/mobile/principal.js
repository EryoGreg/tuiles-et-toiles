'use strict';
/**
 * Demarrage de l'appli mobile (et de la version navigateur de test).
 *
 * Tourne dans la meme page que l'interface React, AVANT elle : construit
 * window.api avec le vrai preload (src/main/preload.js, sur un faux module
 * electron), puis demarre les modules du processus principal comme
 * src/main/index.js le fait sur PC :
 *   sql.js (SQLite WebAssembly) <- fichiers virtuels (IndexedDB)
 *   pack.db livre avec l'appli -> /app/pack.db (jamais sauvegarde)
 *   /data/utilisateur.db, /data/appareil.json, /data/images-locales/
 * Chaque appel de l'interface attend la fin du demarrage.
 */

const initSqlJs = require('sql.js/dist/sql-wasm-browser.js');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');
const electron = require('electron');

const journal = require('../main/journal');
const db = require('../main/db');
const edition = require('../main/edition');
const etat = require('../main/synchro/etat');
const appareil = require('../main/synchro/appareil');
const imagesUrl = require('./images-url');
const canaux = require('./canaux');

const VERSION = typeof __VERSION__ !== 'undefined' ? __VERSION__ : '0.0.0';
const DATA = '/data';
const PACK = '/app/pack.db';
const USER = DATA + '/utilisateur.db';
const IMAGES_LOCALES = DATA + '/images-locales';

// Sauvegarde differee de la base (sql.js travaille en memoire).
let minuteur = null;
function planifierSauvegarde() {
  if (minuteur) return;
  minuteur = setTimeout(() => {
    minuteur = null;
    try { if (db.instance().persister()) fs.sauver(); } catch (e) { journal.erreur('db', 'sauvegarde-mobile', e); }
  }, 1500);
}
function sauverTout() {
  try { db.instance().persister(); } catch { /* base pas ouverte */ }
  return fs.sauver();
}

async function demarrer() {
  const t0 = Date.now();
  const [SQL] = await Promise.all([
    initSqlJs({ locateFile: (f) => f }),
    fs.charger()
  ]);
  Database.initialiser(SQL);
  const [pack, manifeste] = await Promise.all([
    fetch('pack.db').then((r) => r.arrayBuffer()),
    fetch('images-manifest.json').then((r) => r.json()).catch(() => ({ ref: null, images: {} }))
  ]);
  fs.writeFileSync(PACK, new Uint8Array(pack));
  journal.configurer(DATA + '/logs', { version: VERSION, mobile: true, agent: navigator.userAgent }, { console: false });

  const moi = appareil.charger(DATA, { nom: os.hostname() });
  etat.configurer({ appareil: moi });
  db.ouvrir(USER, PACK);
  edition.configurer(IMAGES_LOCALES);
  await imagesUrl.configurer({ manifeste, locales: IMAGES_LOCALES });
  imagesUrl.surArrivee(() => {});
  require('../main/rapport').configurer({
    dossier: DATA + '/rapports', version: VERSION, fetch: (u, o) => fetch(u, o),
    infos: () => ({
      appareil: { id: moi.id, nom: moi.nom, prefixe: moi.prefixe_ref }, mobile: true, agent: navigator.userAgent,
      ecran: window.innerWidth + 'x' + window.innerHeight, oeuvres: db.compterOeuvres(), tags: db.comptesTags(),
      images: imagesUrl.etat()
    })
  });
  setTimeout(() => {
    const rapport = require('../main/rapport');
    if (rapport.listerAttente().length) rapport.renvoyerEnAttente().catch(() => {});
  }, 8000);
  planifierSauvegarde();
  journal.evt('app', 'demarrage-mobile', { ms: Date.now() - t0, appareil: moi.id, oeuvres: db.compterOeuvres() });
}

const pret = demarrer();
pret.catch((e) => {
  console.error(e);
  document.body.innerHTML = '<p style="font:16px sans-serif;padding:24px">Démarrage impossible : '
    + String(e && e.message || e) + '</p>';
});

canaux.enregistrer({ version: VERSION, dossierImagesLocales: IMAGES_LOCALES, surEcriture: planifierSauvegarde });
// Tuile affichee en grand : sa grande image est gardee pour le hors-ligne.
const EN_GRAND = new Set(['jeu:tirer', 'jeu:apercu', 'jeu:reveler']);
electron.configurer({ attendre: pret, transformer: (canal, r) => imagesUrl.traduireTout(r, { garder: EN_GRAND.has(canal) }) });

// window.api : le meme preload que sur PC.
require('../main/preload');
window.api.urlTuile = (nom) => imagesUrl.traduire('tuile://' + nom);

// Mise en veille / fermeture de l'onglet : tout ecrire tout de suite.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') sauverTout(); });
window.addEventListener('pagehide', () => { sauverTout(); });
