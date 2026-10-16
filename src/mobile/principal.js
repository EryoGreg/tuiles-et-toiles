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
const drive = require('./drive');
const { App: AppNative } = require('@capacitor/app');
const reseau = require('./reseau');
const identite = require('./identite');
const contenu = require('./contenu');
const majWeb = require('./maj-web');
const natif = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

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
    // Photos des tuiles creees : vrais fichiers de l'appli (vfs-externe.js), hors memoire.
    fs.charger({ externe: natif() ? require('./shims/vfs-externe').creer({
      Filesystem: require('@capacitor/filesystem').Filesystem, Directory: require('@capacitor/filesystem').Directory,
      convertir: (u) => window.Capacitor.convertFileSrc(u), journal
    }) : null })
  ]);
  Database.initialiser(SQL);
  // Pack, manifeste et vignettes : copie dans les donnees de l'appli si elle est
  // a jour, sinon fichiers livres (contenu.js, mise a jour partielle).
  const { base, source: sourceContenu } = await contenu.preparer();
  const [pack, manifeste] = await Promise.all([
    fetch(base + 'pack.db').then((r) => { if (!r.ok) throw new Error('pack.db : ' + r.status); return r.arrayBuffer(); }),
    fetch(base + 'images-manifest.json').then((r) => r.json()).catch(() => ({ ref: null, images: {} }))
  ]);
  const vignettes = base + 'vignettes/';
  fs.writeFileSync(PACK, new Uint8Array(pack));
  // Journal garde d'une session a l'autre (avant 0.3.10 : en memoire seulement,
  // l'historique d'un bug disparaissait au redemarrage), en plus petit qu'au PC.
  journal.configurer(DATA + '/logs', { version: VERSION, mobile: true, agent: navigator.userAgent },
    { console: false, max: 1024 * 1024, nb: 2 });
  // Fichier illisible dans le stockage (appli tuee en pleine ecriture) : ignore
  // plutot que de bloquer le demarrage ; la synchro retablit les donnees.
  if (fs.illisibles().length) journal.avertir('app', 'fichiers-illisibles', { fichiers: fs.illisibles() });

  // Mise a jour partielle (maj-web.js) : paquet en attente -> la page repart sur
  // le nouveau code (rien n'a encore ete ecrit) ; nouveau code -> a valider.
  if (natif()) {
    let r = 'normal';
    try { r = await majWeb.demarrage(VERSION); } catch (e) { journal.erreur('maj', 'web-demarrage', e); }
    if (r === 'recharge') return new Promise(() => {});
  }

  // Identite : copie de secours tenue a jour, remise en place si le stockage
  // de la page a ete perdu sur ce meme telephone (identite.js).
  const ident = await identite.infos();
  appareil.apresEnregistrement((a) => identite.copier(a));
  await identite.restaurer(DATA, ident.materiel);
  const moi = appareil.charger(DATA, { nom: os.hostname(), type: ident.type, materiel: ident.materiel });
  identite.copier(moi);
  identite.persistance();
  journal.evt('app', 'appareil', {
    id: moi.id, nom: moi.nom, type: moi.type, prefixe: moi.prefixe_ref, evenement: moi.evenement || null,
    ancien: moi.ancien || null, inscrit: !!moi.inscrit, remplace: moi.remplace || null
  }, moi.evenement === 'copie' ? 'WARN' : 'INFO');
  etat.configurer({ appareil: moi });
  db.ouvrir(USER, PACK);
  edition.configurer(IMAGES_LOCALES);
  await imagesUrl.configurer({ manifeste, locales: IMAGES_LOCALES, vignettes });
  imagesUrl.surArrivee(() => {});
  require('../main/rapport').configurer({
    dossier: DATA + '/rapports', version: VERSION, fetch: (u, o) => fetch(u, o),
    infos: () => ({
      appareil: { id: moi.id, nom: moi.nom, prefixe: moi.prefixe_ref }, mobile: true, agent: navigator.userAgent,
      ecran: window.innerWidth + 'x' + window.innerHeight, oeuvres: db.compterOeuvres(), tags: db.comptesTags(),
      images: imagesUrl.etat(), memoire: memoire(), contenu: contenu.etat(), majWeb: etatMajWeb
    })
  });
  setTimeout(() => {
    const rapport = require('../main/rapport');
    if (rapport.listerAttente().length) rapport.renvoyerEnAttente().catch(() => {});
  }, 8000);
  planifierSauvegarde();
  journal.evt('app', 'demarrage-mobile', { ms: Date.now() - t0, appareil: moi.id, oeuvres: db.compterOeuvres(), memoire: memoire(), contenu: contenu.etat() });
  // Copie du contenu livre (une fois par contenu, ~15 Mo de vignettes) : apres
  // le demarrage, sans le ralentir.
  // Photos d'une version precedente (IndexedDB) -> fichiers : fin de la
  // migration en arriere-plan (ancienne copie effacee apres verification).
  setTimeout(() => fs.finirMigration()
    .then((b) => { if (b) journal.evt('image', 'migration-photos', b, b.gardees.length ? 'WARN' : 'INFO'); })
    .catch((e) => journal.erreur('image', 'migration-photos', e)), 3000);
  // Nouveau code (mise a jour partielle) qui a demarre sans encombre : retenu.
  if (natif()) setTimeout(() => majWeb.valider().catch((e) => journal.erreur('maj', 'web-validation', e)), 10000);
  if (sourceContenu === 'livre') {
    setTimeout(() => contenu.copier().catch((e) => journal.erreur('app', 'contenu-copie', e)), 20000);
  }
}

// Occupation memoire (rapport d'erreur, journal au demarrage) : de quoi savoir
// ce qui pese sur un telephone qu'Android ferme faute de memoire.
function memoire() {
  const mo = (o) => Math.round(o / 1e5) / 10;
  const r = { fichiersMo: {} };
  try {
    for (const [d, e] of Object.entries(fs.occupation())) r.fichiersMo[d] = { n: e.fichiers, mo: mo(e.octets) };
  } catch (e) { r.erreurFichiers = e.message; }
  try { Object.assign(r, imagesUrl.memoire()); } catch { /* */ }
  const pm = typeof performance !== 'undefined' && performance.memory;
  if (pm) { r.tasJsMo = mo(pm.usedJSHeapSize); r.tasJsMaxMo = mo(pm.jsHeapSizeLimit); }
  if (typeof navigator !== 'undefined' && navigator.deviceMemory) r.ramAppareilGo = navigator.deviceMemory;
  return r;
}

let etatMajWeb = null;   // rapport : rempli au demarrage (lecture asynchrone)
const pret = demarrer();
pret.then(() => majWeb.etat()).then((e) => { etatMajWeb = e; }).catch(() => {});
pret.catch((e) => {
  console.error(e);
  // textContent, pas innerHTML : le message peut citer des donnees (JSON abime…).
  const p = document.createElement('p');
  p.style.cssText = 'font:16px sans-serif;padding:24px';
  p.textContent = 'Démarrage impossible : ' + String(e && e.message || e);
  document.body.replaceChildren(p);
});

drive.configurer({ webClientId: typeof __GOOGLE_WEB_CLIENT_ID__ !== 'undefined' ? __GOOGLE_WEB_CLIENT_ID__ : '' });
const auto = canaux.enregistrer({
  version: VERSION, dossierImagesLocales: IMAGES_LOCALES, surEcriture: planifierSauvegarde, emettre: electron.emettre,
  sauverTout
});
// Synchro automatique : au lancement, apres une modification, toutes les
// 15 min tant que l'appli est ouverte, et au retour au premier plan.
pret.then(() => reseau.demarrer()).then(() => auto.demarrer()).catch(() => {});
// En donnees mobiles, une grande image affichee n'est pas telechargee une
// seconde fois pour le cache.
imagesUrl.cachePermis(() => reseau.wifi());
// Tuile affichee en grand : sa grande image est gardee pour le hors-ligne.
const EN_GRAND = new Set(['jeu:tirer', 'jeu:apercu', 'jeu:reveler']);
electron.configurer({ attendre: pret, transformer: (canal, r) => imagesUrl.traduireTout(r, { garder: EN_GRAND.has(canal) }) });

// window.api : le meme preload que sur PC.
require('../main/preload');
window.api.urlTuile = (nom) => imagesUrl.traduire('tuile://' + nom);
// Poignee de diagnostic (console, tests) : jamais utilisee par l'interface.
window.__tt = { db, synchro: require('../main/synchro/service'), fs, pret, majWeb, contenu };

// Bouton retour d'Android : d'abord fermer ce qui est ouvert par-dessus
// (boite, apercu, formulaire : ils se ferment sur Echap), sinon page
// precedente (meme chemin que les boutons lateraux de la souris sur PC) ;
// depuis la premiere page, le rendu appelle app:quitter -> arriere-plan.
// Photo prise pendant que l'appli etait tuee : livree au redemarrage.
require('./photo-reprise').ecouter();

if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
  AppNative.addListener('backButton', () => {
    if (document.querySelector('.recouvrement, .recouvrement-apercu, .recouvrement-image')) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return;
    }
    electron.emettre('app:nav', 'reculer');
  });
}

// Mise en veille / fermeture de l'onglet : tout ecrire tout de suite.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    sauverTout();
    pret.then(() => auto.avantFermeture()).then(() => sauverTout()).catch(() => {});
  }
  // Retour au premier plan : pas de synchro systematique (donnees mobiles).
  // La surveillance d'auto.js la lancera si la derniere a plus de 15 min.
});
window.addEventListener('pagehide', () => { sauverTout(); });
