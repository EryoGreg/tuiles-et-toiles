'use strict';
/**
 * Processus principal Electron.
 *
 * Isolation stricte : le rendu n'a aucun acces a Node. Tout passe par les
 * canaux IPC declares plus bas et exposes via preload.js. C'est indispensable
 * ici, le processus principal detiendra le jeton OAuth.
 */

const { app, BrowserWindow, ipcMain, nativeTheme, protocol, net, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { pathToFileURL } = require('url');

const db = require('./db');
const jeu = require('./jeu');
const edition = require('./edition');
const images = require('./images');
const raccourcis = require('./raccourcis');
const journal = require('./journal');
const sauvegarde = require('./sauvegarde');
const drive = require('./drive');
const maj = require('./maj');
const lisezmoi = require('./lisezmoi');
const appareil = require('./synchro/appareil');
const etat = require('./synchro/etat');
const synchro = require('./synchro/service');

// Avant tout getPath('userData') : sinon Electron nomme le dossier d'apres le
// champ "name" du package.json (tuiles-et-toiles).
app.setName('Tuiles et Toiles');

const DEV = !app.isPackaged;

// Contenu livre avec l'application (extraResources), lecture seule.
const DATA_LIVRE = DEV
  ? path.resolve(__dirname, '..', '..', 'data')
  : path.join(process.resourcesPath, 'data');

// Images du pack : servies telles quelles depuis le paquet, jamais recopiees.
const DOSSIER_IMAGES = path.join(DATA_LIVRE, 'images');

// Emplacement inscriptible : %APPDATA%\Tuiles et Toiles (pas a cote de l'exe,
// pas dans le cache temporaire du stub portable). En dev : le depot.
const DOSSIER_USER = DEV ? DATA_LIVRE : app.getPath('userData');

// Images des tuiles creees par l'utilisateur.
const DOSSIER_IMAGES_LOCALES = path.join(DOSSIER_USER, 'images-locales');

// pack.db = contenu, remplacable en bloc. En dev on lit celui du depot ;
// empaquete, on le copie une fois dans %APPDATA% (une MAJ de pack l'y ecrasera).
const PACK_LIVRE = path.join(DATA_LIVRE, 'pack.db');
const PACK = DEV ? PACK_LIVRE : path.join(DOSSIER_USER, 'pack.db');
// utilisateur.db = tags, archive, overrides, tuiles locales. Jamais ecrase.
const USER = path.join(DOSSIER_USER, 'utilisateur.db');
const ANCIEN = path.join(DOSSIER_USER, 'tuiles.db');   // base v1 monolithique

// Icone de fenetre en dev (l'exe empaquete porte deja la sienne).
const ICONE = path.join(__dirname, '..', '..', 'build', 'icon.png');

function preparerDonnees() {
  if (DEV) return;   // dev : data/pack.db (import) + data/utilisateur.db (cree a l'ouverture)
  fs.mkdirSync(DOSSIER_USER, { recursive: true });

  // Copie le pack livre s'il manque, ou si l'exe embarque une version STRICTEMENT
  // plus recente. Un pack telecharge plus tard (version superieure) n'est donc
  // jamais ecrase par le pack du bundle.
  const vInstall = lireVersionPack(PACK);
  const vLivree = lireVersionPack(PACK_LIVRE);
  if (vLivree && (!vInstall || versionSuperieure(vLivree, vInstall))) {
    fs.copyFileSync(PACK_LIVRE, PACK);
  }

  // Migration depuis une install v1 : recopie les tables user_* dans
  // utilisateur.db, re-cle les tags via le registre.
  if (!fs.existsSync(USER) && fs.existsSync(ANCIEN)) {
    let registre = {};
    try { registre = JSON.parse(fs.readFileSync(path.join(DATA_LIVRE, 'registre.json'), 'utf8')); }
    catch (_) { /* registre absent : tags non re-cles */ }
    try {
      db.migrer(ANCIEN, USER, registre);
      fs.renameSync(ANCIEN, ANCIEN + '.avant-v2');
    } catch (e) {
      console.error('Migration v1 -> v2 echouee :', e.message);
    }
  }
}

// Lit pack_meta.version sans garder la connexion ouverte.
function lireVersionPack(chemin) {
  if (!fs.existsSync(chemin)) return null;
  const Database = require('better-sqlite3');
  try {
    const d = new Database(chemin, { readonly: true, fileMustExist: true });
    const r = d.prepare("SELECT valeur FROM pack_meta WHERE cle = 'version'").get();
    d.close();
    return r ? r.valeur : null;
  } catch (_) { return null; }
}

const { versionSuperieure } = maj;

let fenetre = null;
let fermetureAutorisee = false;

// Les images vivent sur disque, hors du bundle : un protocole dedie evite
// d'ouvrir file:// au rendu.
protocol.registerSchemesAsPrivileged([
  { scheme: 'tuile', privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);

function creerFenetre() {
  fenetre = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#14110F',
    show: false,
    autoHideMenuBar: true,
    icon: fs.existsSync(ICONE) ? ICONE : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  fenetre.once('ready-to-show', () => fenetre.show());

  // Erreurs et console du rendu -> journal.
  fenetre.webContents.on('console-message', (_e, niveau, message, ligne, source) => {
    if (niveau >= 3) journal.ligne('[ui] console.error', { message, source: source + ':' + ligne });
  });
  fenetre.webContents.on('render-process-gone', (_e, d) => journal.ligne('ERREUR rendu perdu', d));
  fenetre.webContents.on('did-fail-load', (_e, code, desc) => journal.ligne('ERREUR did-fail-load', { code, desc }));

  // Garde-fou fermeture : la croix Windows ne quitte pas directement, le rendu
  // affiche d'abord le dialogue de confirmation. Seul app:quitter (bouton du
  // dialogue) leve la garde.
  fenetre.on('close', (e) => {
    if (fermetureAutorisee) return;
    e.preventDefault();
    fenetre.webContents.send('app:tenter-fermeture');
  });

  // Boutons lateraux de la souris (Windows) : naviguer dans l'historique de
  // pages de l'appli, pas dans l'historique du webContents.
  fenetre.on('app-command', (e, cmd) => {
    if (cmd === 'browser-backward') { e.preventDefault(); fenetre.webContents.send('app:nav', 'reculer'); }
    else if (cmd === 'browser-forward') { e.preventDefault(); fenetre.webContents.send('app:nav', 'avancer'); }
  });

  if (DEV) {
    fenetre.loadURL('http://127.0.0.1:5500');
  } else {
    fenetre.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  journal.configurer(path.join(DOSSIER_USER, 'logs'));
  journal.armerErreurs(app);
  journal.ligne('demarrage', { dev: DEV, version: app.getVersion(), pack: lireVersionPack(PACK_LIVRE) });
  preparerDonnees();
  // Un LISEZMOI dans chaque dossier cree par l'app. Pas en dev : data/ est le depot.
  if (!DEV) {
    lisezmoi.deposer(DOSSIER_USER, 'donnees');
    lisezmoi.deposer(DOSSIER_IMAGES_LOCALES, 'images_locales');
    lisezmoi.deposer(path.join(DOSSIER_USER, 'logs'), 'logs');
  }

  protocol.handle('tuile', (requete) => {
    const brut = decodeURIComponent(new URL(requete.url).hostname
      + new URL(requete.url).pathname).replace(/^\/+/, '');
    const nom = path.basename(brut);
    // Image locale d'abord (tuile creee), puis image du pack.
    for (const dossier of [DOSSIER_IMAGES_LOCALES, DOSSIER_IMAGES]) {
      const cible = path.join(dossier, nom);
      if (cible.startsWith(dossier) && fs.existsSync(cible)) {
        return net.fetch(pathToFileURL(cible).toString());
      }
    }
    return new Response('', { status: 404 });
  });

  // Identite de l'installation (appareil.json, hors utilisateur.db) : avant
  // db.ouvrir, dont le hook d'ouverture migre les stats et fait la genese.
  const moi = appareil.charger(DOSSIER_USER, { nom: os.hostname() });
  etat.configurer({ appareil: moi });
  journal.ligne('appareil', { id: moi.id, nom: moi.nom, prefixe: moi.prefixe_ref });

  db.ouvrir(USER, PACK);
  edition.configurer(DOSSIER_IMAGES_LOCALES);
  edition.nettoyerOrphelines();   // images importees jamais validees
  sauvegarde.configurer({
    user: USER, imagesLocales: DOSSIER_IMAGES_LOCALES, pack: PACK, versionApp: app.getVersion()
  });
  drive.configurer({ dossierUser: DOSSIER_USER });
  synchro.configurer({ dossierUser: DOSSIER_USER, imagesLocales: DOSSIER_IMAGES_LOCALES });
  maj.configurer({ dossierUser: DOSSIER_USER });
  maj.nettoyerApresMaj(journal);   // premier lancement apres une MAJ : retire l'ancien exe

  // Premier lancement : thème Dracula par défaut (aucun réglage encore posé).
  if (db.reglage('theme') == null) db.definirReglage('theme', 'dracula');

  journal.ligne('base ouverte', { oeuvres: db.compterOeuvres(), theme: db.reglage('theme') });

  // Aucun raccourci n'est cree automatiquement : au premier lancement le rendu
  // propose (bureau / barre / menu Demarrer), rappel qu'Options le refait.
  creerFenetre();

  // Theme 'auto' : pousse le changement au rendu sans qu'il ait a sonder.
  nativeTheme.on('updated', () => {
    if (fenetre) {
      fenetre.webContents.send('theme:systeme-change', nativeTheme.shouldUseDarkColors ? 'sombre' : 'clair');
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) creerFenetre();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- canaux IPC ------------------------------------------------------------

ipcMain.handle('etat', () => ({
  oeuvres: db.compterOeuvres(),
  tags: db.comptesTags(),
  theme: db.reglage('theme', 'auto'),
  sidebarRepliee: db.reglage('sidebar_repliee', '0') === '1',
  grilleColonnes: parseInt(db.reglage('grille_colonnes', '5'), 10) || 5,
  raccourcisProposes: db.reglage('raccourcis_proposes', '0') === '1',
  majAuto: db.reglage('maj_auto', '1') === '1',
  version: app.getVersion(),
  derniereSynchro: db.etatSync('derniere_synchro')
}));

ipcMain.on('journal', (_e, msg, extra) => journal.ligne('[ui] ' + msg, extra));

ipcMain.handle('edition:creer', (_e, champs) => {
  const r = edition.creer(champs || {});
  journal.ligne('edition creer', { ref: r.ref, masques: r.masques });
  return r;
});
ipcMain.handle('edition:tuile', (_e, id) => edition.tuile(id));
ipcMain.handle('edition:modifier', (_e, { id, champs }) => {
  const r = edition.modifier(id, champs || {});
  journal.ligne('edition modifier', { id, ref: r.ref, masques: r.masques });
  return r;
});
ipcMain.handle('edition:supprimer', (_e, id) => {
  const r = edition.supprimer(id);
  journal.ligne('edition supprimer', { id, archivee: r.archivee });
  return r;
});

ipcMain.handle('edition:importerImageUrl', async (_e, url) => {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return { erreur: 'URL non supportée.' };
    const res = await net.fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
          + '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      }
    });
    if (!res.ok) return { erreur: 'Téléchargement refusé (' + res.status + ').' };
    if (!(res.headers.get('content-type') || '').startsWith('image/')) {
      return { erreur: 'Le lien ne pointe pas vers une image.' };
    }
    const ab = await res.arrayBuffer();
    if (ab.byteLength > 25 * 1024 * 1024) return { erreur: 'Image trop lourde (> 25 Mo).' };
    return await images.importer(Buffer.from(ab), DOSSIER_IMAGES_LOCALES);
  } catch (e) {
    return { erreur: 'Échec : ' + e.message + '. Télécharge l’image puis glisse le fichier.' };
  }
});

ipcMain.handle('edition:choisirImage', async () => {
  const r = await dialog.showOpenDialog(fenetre, {
    title: 'Choisir une image',
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff'] }],
    properties: ['openFile']
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return images.importer(r.filePaths[0], DOSSIER_IMAGES_LOCALES);
});

ipcMain.handle('edition:importerImage', (_e, octets) =>
  images.importer(Buffer.from(octets), DOSSIER_IMAGES_LOCALES));

ipcMain.handle('edition:oublierImage', (_e, nom) => edition.oublierImage(nom));

ipcMain.handle('sauvegarde:exporter', async () => {
  const defaut = 'tuiles-et-toiles-' + new Date().toISOString().slice(0, 10) + '.zip';
  const r = await dialog.showSaveDialog(fenetre, {
    title: 'Exporter mes données',
    defaultPath: path.join(app.getPath('documents'), defaut),
    filters: [{ name: 'Archive zip', extensions: ['zip'] }]
  });
  if (r.canceled || !r.filePath) return { annule: true };
  try {
    const out = sauvegarde.exporter(r.filePath);
    journal.ligne('sauvegarde export', { chemin: r.filePath, octets: out.octets });
    return { chemin: r.filePath, ...out };
  } catch (e) {
    journal.ligne('ERREUR sauvegarde export', { message: e.message });
    return { erreur: e.message };
  }
});

ipcMain.handle('sauvegarde:choisir', async () => {
  const r = await dialog.showOpenDialog(fenetre, {
    title: 'Choisir une sauvegarde',
    filters: [{ name: 'Archive zip', extensions: ['zip'] }],
    properties: ['openFile']
  });
  if (r.canceled || !r.filePaths[0]) return { annule: true };
  return { chemin: r.filePaths[0], ...sauvegarde.inspecter(r.filePaths[0]) };
});

ipcMain.handle('sauvegarde:importer', (_e, chemin) => {
  try {
    const out = sauvegarde.importer(chemin);
    if (out.erreur) { journal.ligne('sauvegarde import refuse', { chemin, erreur: out.erreur }); return out; }
    journal.ligne('sauvegarde import', { chemin, comptes: out.comptes });
    return out;
  } catch (e) {
    journal.ligne('ERREUR sauvegarde import', { message: e.message });
    return { erreur: e.message };
  }
});

ipcMain.handle('drive:etat', () => drive.etat());
ipcMain.handle('drive:connecter', async () => {
  const r = await drive.connecter();
  journal.ligne('drive connecter', { connecte: !!r.connecte, erreur: r.erreur || null });
  return { ...drive.etat(), ...r };
});
ipcMain.handle('drive:deconnecter', () => { drive.deconnecter(); journal.ligne('drive deconnecter'); return drive.etat(); });
// Jeton refuse par Google en cours d'operation : drive.js relance le flux
// OAuth ; on previent le rendu pour qu'il affiche « autorise dans le navigateur ».
const surReconnexionDrive = (e) => () => {
  journal.ligne('drive reconnexion auto');
  if (!e.sender.isDestroyed()) e.sender.send('drive:reconnexion');
};
ipcMain.handle('drive:pousser', async (e, opts) => {
  const r = await drive.pousser(opts || {}, surReconnexionDrive(e));
  journal.ligne('drive pousser', { ok: !!r.ok, conflit: !!r.conflit, reconnecte: !!r.reconnecte, erreur: r.erreur || null });
  return r;
});
ipcMain.handle('drive:tirer', async (e, opts) => {
  const r = await drive.tirer(opts || {}, surReconnexionDrive(e));
  journal.ligne('drive tirer', { ok: !!r.ok, aJour: !!r.aJour, reconnecte: !!r.reconnecte, erreur: r.erreur || null });
  return r;
});

// Synchro par dossier partage (E2c) : fusion ligne a ligne, rien n'est ecrase.
ipcMain.handle('synchro:etat', () => synchro.etat());
ipcMain.handle('synchro:choisirDossier', async () => {
  const r = await dialog.showOpenDialog(fenetre, {
    title: 'Dossier de synchro (partagé entre tes appareils)',
    properties: ['openDirectory', 'createDirectory']
  });
  if (r.canceled || !r.filePaths[0]) return { annule: true };
  const out = await synchro.definirDossier(r.filePaths[0]);
  journal.ligne('synchro dossier', { dossier: r.filePaths[0], erreur: out.erreur || null });
  return out;
});
ipcMain.handle('synchro:oublier', () => { journal.ligne('synchro oublier dossier'); return synchro.oublierDossier(); });
const journaliserSynchro = (quoi, r) => journal.ligne(quoi, r.erreur ? { erreur: r.erreur } : {
    poussees: r.poussees, appliquees: r.appliquees, rejetees: r.rejetees, conflits: r.conflits,
    images: [r.imagesEnvoyees, r.imagesRecues], prefixe: r.prefixe, renumerotees: r.renumerotees.length,
    reconnecte: !!r.reconnecte
  });
ipcMain.handle('synchro:synchroniser', async () => {
  const r = await synchro.synchroniser();
  journaliserSynchro('synchro dossier', r);
  return r;
});
ipcMain.handle('synchro:drive', async (e) => {
  const r = await synchro.synchroniserDrive(surReconnexionDrive(e));
  journaliserSynchro('synchro drive', r);
  return r;
});

// Mise a jour : verification (au lancement si maj_auto, ou bouton Options),
// telechargement avec progression, puis installation = relance sur le nouvel exe.
ipcMain.handle('maj:verifier', async () => {
  const r = await maj.verifier();
  journal.ligne('maj verifier', { disponible: r.disponible ? r.version : null, erreur: r.erreur || null });
  return r;
});
ipcMain.handle('maj:telecharger', async (e) => {
  const r = await maj.telecharger((recu, total) => {
    if (!e.sender.isDestroyed()) e.sender.send('maj:progression', { recu, total });
  });
  journal.ligne('maj telecharger', { ok: !!r.ok, erreur: r.erreur || null });
  return r;
});
ipcMain.handle('maj:installer', () => {
  const r = maj.installer();
  journal.ligne('maj installer', { ok: !!r.ok, erreur: r.erreur || null });
  if (r.ok) {
    fermetureAutorisee = true;
    setTimeout(() => app.quit(), 500);
  }
  return r;
});

ipcMain.handle('raccourcis:etat', () => raccourcis.etat());
ipcMain.handle('raccourcis:perimes', () => raccourcis.perimes());
ipcMain.handle('raccourcis:basculer', async (_e, type) => {
  const r = await raccourcis.basculer(type);
  return { etat: raccourcis.etat(), manuel: r.manuel };
});
ipcMain.handle('raccourcis:reparer', (_e, types) => {
  raccourcis.reparer(types);
  return raccourcis.etat();
});

ipcMain.handle('jeu:tirer', (_e, tagJeu) => jeu.tirer(tagJeu || null));
ipcMain.handle('jeu:reveler', (_e, id) => jeu.reveler(id));
ipcMain.handle('jeu:apercu', (_e, id) => jeu.apercu(id));
ipcMain.handle('jeu:categories', () => jeu.categories());
ipcMain.handle('jeu:apercuCategories', (_e, sel) => jeu.apercuCategories(sel || {}));

ipcMain.handle('oeuvres:chercher', (_e, criteres) => db.chercher(criteres || {}));
ipcMain.handle('oeuvres:numero', (_e, n) => db.parNumero(n));
ipcMain.handle('oeuvres:parTag', (_e, { tag, texte } = {}) => jeu.listerParTag(tag, texte));
ipcMain.handle('oeuvres:toutes', (_e, criteres) => jeu.listerToutes(criteres));

ipcMain.handle('tags:basculer', (_e, { id, tag }) => ({
  actif: db.basculerTag(id, tag),
  comptes: db.comptesTags()
}));

ipcMain.handle('tags:effacerTout', () => ({
  supprimes: db.effacerTousLesTags(),
  comptes: db.comptesTags()
}));

// Themes a fond clair : pilotent les elements natifs (menus, boites systeme)
// en mode clair. Tout le reste est en mode sombre.
const THEMES_CLAIRS = new Set([
  'clair', 'parchemin', 'lin', 'sepia', 'sepia-profond', 'taupe', 'ardoise'
]);

ipcMain.handle('reglages:definir', (_e, { cle, valeur }) => {
  db.definirReglage(cle, valeur);
  if (cle === 'theme') {
    // Le rendu affiche notre propre palette via data-theme ; ceci ne pilote
    // que les elements natifs (menus, boites systeme).
    nativeTheme.themeSource = valeur === 'auto'
      ? 'system'
      : (THEMES_CLAIRS.has(valeur) ? 'light' : 'dark');
  }
  return true;
});

ipcMain.handle('theme:systeme', () => (nativeTheme.shouldUseDarkColors ? 'sombre' : 'clair'));

// La confirmation de fermeture est une fenetre HTML aux tons de l'appli (voir
// App.jsx), pas une boite de dialogue Windows : plus de son systeme. Ce canal
// ferme directement, la question a deja ete posee cote rendu.
ipcMain.handle('app:quitter', () => {
  fermetureAutorisee = true;
  if (fenetre) fenetre.close(); else app.quit();
  return true;
});
