'use strict';
/**
 * Processus principal Electron.
 *
 * Isolation stricte : le rendu n'a aucun acces a Node. Tout passe par les
 * canaux IPC declares plus bas et exposes via preload.js. C'est indispensable
 * ici, le processus principal detiendra le jeton OAuth.
 */

const { app, BrowserWindow, ipcMain, nativeTheme, protocol, net, dialog, shell, clipboard, screen } = require('electron');
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
const rapport = require('./rapport');
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
    journal.evt('db', 'pack-installe', { de: vInstall, vers: vLivree });
  } else {
    journal.debug('db', 'pack-garde', { installe: vInstall, livre: vLivree });
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
      journal.evt('db', 'migration-v1-v2', { ancien: ANCIEN, registre: Object.keys(registre).length });
    } catch (e) {
      journal.erreur('db', 'migration-v1-v2', e, { ancien: ANCIEN });
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

  fenetre.once('ready-to-show', () => {
    fenetre.show();
    journal.evt('app', 'fenetre-affichee', { depuisLancementMs: Math.round(process.uptime() * 1000) });
  });

  // Erreurs et console du rendu -> journal.
  fenetre.webContents.on('console-message', (_e, niveau, message, ligne, source) => {
    if (niveau >= 2) journal.evt('ui', niveau >= 3 ? 'console.error' : 'console.warn', { message, source: source + ':' + ligne }, niveau >= 3 ? 'ERREUR' : 'WARN');
  });
  fenetre.webContents.on('render-process-gone', (_e, d) => journal.evt('app', 'rendu-perdu', d, 'ERREUR'));
  fenetre.webContents.on('did-fail-load', (_e, code, desc, url) => journal.evt('app', 'did-fail-load', { code, desc, url }, 'ERREUR'));
  fenetre.webContents.on('unresponsive', () => journal.evt('app', 'fenetre-ne-repond-plus', null, 'WARN'));
  fenetre.webContents.on('responsive', () => journal.evt('app', 'fenetre-repond-de-nouveau'));

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
  journal.configurer(path.join(DOSSIER_USER, 'logs'), {
    version: app.getVersion(), dev: DEV,
    electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
    os: `${os.platform()} ${os.release()} ${os.arch()}`, locale: app.getLocale(),
    memoireGo: Math.round(os.totalmem() / 1e8) / 10, libreGo: Math.round(os.freemem() / 1e8) / 10,
    cpus: os.cpus().length + ' x ' + ((os.cpus()[0] || {}).model || '?'),
    exe: process.execPath, portable: process.env.PORTABLE_EXECUTABLE_FILE || null,
    donnees: DOSSIER_USER, demarrageMs: Math.round(process.uptime() * 1000)
  });
  journal.armerErreurs(app);
  journal.evt('app', 'demarrage', { pack: lireVersionPack(PACK_LIVRE), packInstalle: lireVersionPack(PACK) });
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
  journal.evt('app', 'appareil', { id: moi.id, nom: moi.nom, prefixe: moi.prefixe_ref, dossierSynchro: moi.dossier_synchro || null });

  db.ouvrir(USER, PACK);
  edition.configurer(DOSSIER_IMAGES_LOCALES);
  edition.nettoyerOrphelines();   // images importees jamais validees
  sauvegarde.configurer({
    user: USER, imagesLocales: DOSSIER_IMAGES_LOCALES, pack: PACK, versionApp: app.getVersion()
  });
  drive.configurer({ dossierUser: DOSSIER_USER });
  synchro.configurer({
    dossierUser: DOSSIER_USER, imagesLocales: DOSSIER_IMAGES_LOCALES,
    surProgression: (p) => {
      for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('synchro:progression', p);
    }
  });
  rapport.configurer({
    dossier: path.join(app.getPath('documents'), 'Tuiles et Toiles - rapports'),
    version: app.getVersion(),
    infos: infosRapport,
    fetch: (url, opts) => net.fetch(url, opts)
  });
  // Rapports restes en attente (envoi hors ligne) : renvoi discret.
  setTimeout(() => {
    rapport.renvoyerEnAttente()
      .then((r) => { if (r.envoyes || r.restants) journal.evt('rapport', 'attente', r); })
      .catch((e) => journal.erreur('rapport', 'renvoi', e));
  }, 8000);
  maj.configurer({ dossierUser: DOSSIER_USER });
  maj.nettoyerApresMaj(journal);   // premier lancement apres une MAJ : retire l'ancien exe

  // Premier lancement : thème Dracula par défaut (aucun réglage encore posé).
  if (db.reglage('theme') == null) db.definirReglage('theme', 'dracula');

  journal.evt('db', 'base-ouverte', {
    oeuvres: db.compterOeuvres(), theme: db.reglage('theme'), depuisLancementMs: Math.round(process.uptime() * 1000),
    utilisateurDbOctets: fs.existsSync(USER) ? fs.statSync(USER).size : null
  });

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

// Etat de l'application joint a un rapport d'erreur (masque par rapport.js).
function infosRapport() {
  const d = db.instance();
  const n = (sql) => { try { return d.prepare(sql).get().n; } catch { return null; } };
  const a = etat.appareil();
  const s = synchro.etat();
  const dv = drive.etat();
  const pack = db.packMeta();
  return {
    version: app.getVersion(), dev: DEV, os: `${os.platform()} ${os.release()} ${os.arch()}`,
    electron: process.versions.electron, locale: app.getLocale(),
    memoireGo: Math.round(os.totalmem() / 1e8) / 10, libreGo: Math.round(os.freemem() / 1e8) / 10,
    ecrans: screen.getAllDisplays().map((x) => x.size.width + 'x' + x.size.height + '@' + x.scaleFactor),
    enMarcheDepuisMin: Math.round(process.uptime() / 60),
    portable: !!process.env.PORTABLE_EXECUTABLE_FILE, exe: process.execPath,
    appareil: { id: a.id, nom: a.nom, prefixe: a.prefixe_ref },
    pack: { version: pack.version, hash: pack.hash, oeuvres: pack.n_oeuvres },
    donnees: {
      oeuvresAffichees: n('SELECT COUNT(*) n FROM oeuvres_effectives'),
      tuilesLocales: n('SELECT COUNT(*) n FROM oeuvres_locales'),
      corrections: n('SELECT COUNT(*) n FROM user_overrides'),
      archives: n('SELECT COUNT(*) n FROM user_archive'),
      marques: n('SELECT COUNT(*) n FROM user_tags'),
      sansMasque: n("SELECT COUNT(*) n FROM oeuvres_effectives WHERE masques IS NULL OR masques = '[]'"),
      imagesLocales: fs.existsSync(DOSSIER_IMAGES_LOCALES) ? fs.readdirSync(DOSSIER_IMAGES_LOCALES).length : 0,
      utilisateurDbOctets: fs.existsSync(USER) ? fs.statSync(USER).size : null
    },
    synchro: {
      opsJournal: n('SELECT COUNT(*) n FROM changements'), aPousser: n('SELECT COUNT(*) n FROM changements WHERE pousse=0'),
      conflitsOuverts: s.conflits, dossier: s.dossier, derniereDossier: s.derniere, derniereDrive: s.derniereDrive
    },
    drive: { configure: dv.configure, connecte: dv.connecte, derniereSauvegarde: dv.synchroLe },
    reglages: { theme: db.reglage('theme'), majAuto: db.reglage('maj_auto', '1') }
  };
}

// --- canaux IPC ------------------------------------------------------------

// Chaque canal est journalise : arguments resumes, duree, resultat ou erreur.
// Lectures appelees en boucle -> DEBUG ; resultat { erreur } -> WARN.
const ROUTINE = new Set([
  'etat', 'drive:etat', 'synchro:etat', 'raccourcis:etat', 'raccourcis:perimes', 'theme:systeme',
  'jeu:categories', 'jeu:apercuCategories', 'jeu:apercu', 'oeuvres:chercher', 'oeuvres:numero',
  'oeuvres:parTag', 'oeuvres:toutes', 'edition:tuile'
]);

function resumerResultat(r) {
  if (Array.isArray(r)) return { liste: r.length };
  if (!r || typeof r !== 'object') return r;
  const o = {};
  for (const [k, v] of Object.entries(r)) {
    o[k] = Array.isArray(v) ? { liste: v.length } : (v && typeof v === 'object' && !(v instanceof Error) ? '[objet]' : v);
  }
  return o;
}

function gerer(canal, fn) {
  ipcMain.handle(canal, async (e, ...args) => {
    const t0 = Date.now();
    try {
      const r = await fn(e, ...args);
      const niveau = r && r.erreur ? 'WARN' : ROUTINE.has(canal) ? 'DEBUG' : 'INFO';
      journal.evt('ipc', canal, { args, ms: Date.now() - t0, resultat: resumerResultat(r) }, niveau);
      return r;
    } catch (err) {
      journal.erreur('ipc', canal, err, { args, ms: Date.now() - t0 });
      throw err;
    }
  });
}

gerer('etat', () => ({
  oeuvres: db.compterOeuvres(),
  tags: db.comptesTags(),
  theme: db.reglage('theme', 'auto'),
  sidebarRepliee: db.reglage('sidebar_repliee', '0') === '1',
  grilleColonnes: parseInt(db.reglage('grille_colonnes', '5'), 10) || 5,
  raccourcisProposes: db.reglage('raccourcis_proposes', '0') === '1',
  majAuto: db.reglage('maj_auto', '1') === '1',
  version: app.getVersion(),
  derniereSynchro: db.etatSync('derniere_synchro'),
  conflits: etat.conflits().length
}));

ipcMain.on('journal', (_e, msg, extra) => journal.ligne('[ui] ' + msg, extra));
ipcMain.on('journal:evt', (_e, domaine, quoi, donnees, niveau) =>
  journal.evt(domaine || 'ui', quoi, donnees, ['DEBUG', 'INFO', 'WARN', 'ERREUR'].includes(niveau) ? niveau : 'INFO'));

// Detail (champs decrits, image, masques) journalise par edition.js.
gerer('edition:creer', (_e, champs) => edition.creer(champs || {}));
gerer('edition:tuile', (_e, id) => edition.tuile(id));
gerer('edition:modifier', (_e, { id, champs }) => edition.modifier(id, champs || {}));
gerer('edition:supprimer', (_e, id) => edition.supprimer(id));

gerer('edition:importerImageUrl', async (_e, url) => {
  const refus = (erreur, detail) => {
    journal.avertir('image', 'url-refusee', { url, urlTexte: journal.decrireTexte(url), erreur, ...detail });
    return { erreur };
  };
  const t0 = Date.now();
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return refus('URL non supportée.', { protocole: u.protocol });
    const res = await net.fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
          + '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      }
    });
    const reponse = {
      status: res.status, contentType: res.headers.get('content-type'),
      contentLength: res.headers.get('content-length'), urlFinale: res.url, ms: Date.now() - t0
    };
    journal.evt('image', 'url-reponse', { url, ...reponse });
    if (!res.ok) return refus('Téléchargement refusé (' + res.status + ').', reponse);
    if (!(res.headers.get('content-type') || '').startsWith('image/')) {
      return refus('Le lien ne pointe pas vers une image.', reponse);
    }
    const ab = await res.arrayBuffer();
    if (ab.byteLength > 25 * 1024 * 1024) return refus('Image trop lourde (> 25 Mo).', { ...reponse, octets: ab.byteLength });
    return await images.importer(Buffer.from(ab), DOSSIER_IMAGES_LOCALES, { origine: 'url', url });
  } catch (e) {
    journal.erreur('image', 'url-echec', e, { url, urlTexte: journal.decrireTexte(url), ms: Date.now() - t0 });
    return { erreur: 'Échec : ' + e.message + '. Télécharge l’image puis glisse le fichier.' };
  }
});

gerer('edition:choisirImage', async () => {
  const r = await dialog.showOpenDialog(fenetre, {
    title: 'Choisir une image',
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff'] }],
    properties: ['openFile']
  });
  if (r.canceled || !r.filePaths[0]) { journal.evt('image', 'selecteur-annule'); return null; }
  return images.importer(r.filePaths[0], DOSSIER_IMAGES_LOCALES, { origine: 'selecteur' });
});

gerer('edition:importerImage', (_e, octets, meta) =>
  images.importer(Buffer.from(octets), DOSSIER_IMAGES_LOCALES, { origine: 'depot', ...(meta || {}) }));

gerer('edition:oublierImage', (_e, nom) => edition.oublierImage(nom));

gerer('sauvegarde:exporter', async () => {
  const defaut = 'tuiles-et-toiles-' + new Date().toISOString().slice(0, 10) + '.zip';
  const r = await dialog.showSaveDialog(fenetre, {
    title: 'Exporter mes données',
    defaultPath: path.join(app.getPath('documents'), defaut),
    filters: [{ name: 'Archive zip', extensions: ['zip'] }]
  });
  if (r.canceled || !r.filePath) return { annule: true };
  try {
    const out = sauvegarde.exporter(r.filePath);
    journal.evt('sauvegarde', 'export', { chemin: r.filePath, octets: out.octets, manifest: out.manifest });
    return { chemin: r.filePath, ...out };
  } catch (e) {
    journal.erreur('sauvegarde', 'export', e, { chemin: r.filePath });
    return { erreur: e.message };
  }
});

gerer('sauvegarde:choisir', async () => {
  const r = await dialog.showOpenDialog(fenetre, {
    title: 'Choisir une sauvegarde',
    filters: [{ name: 'Archive zip', extensions: ['zip'] }],
    properties: ['openFile']
  });
  if (r.canceled || !r.filePaths[0]) return { annule: true };
  return { chemin: r.filePaths[0], ...sauvegarde.inspecter(r.filePaths[0]) };
});

gerer('sauvegarde:importer', (_e, chemin) => {
  try {
    const out = sauvegarde.importer(chemin);
    if (out.erreur) { journal.evt('sauvegarde', 'import-refuse', { chemin, erreur: out.erreur }); return out; }
    journal.evt('sauvegarde', 'import', { chemin, comptes: out.comptes });
    return out;
  } catch (e) {
    journal.erreur('sauvegarde', 'import', e, { chemin });
    return { erreur: e.message };
  }
});

gerer('drive:etat', () => drive.etat());
gerer('drive:connecter', async () => {
  const r = await drive.connecter();
  journal.evt('drive', 'connecter', { connecte: !!r.connecte, erreur: r.erreur || null });
  return { ...drive.etat(), ...r };
});
gerer('drive:deconnecter', () => { drive.deconnecter(); journal.evt('drive', 'deconnecter'); return drive.etat(); });
// Jeton refuse par Google en cours d'operation : drive.js relance le flux
// OAuth ; on previent le rendu pour qu'il affiche « autorise dans le navigateur ».
const surReconnexionDrive = (e) => () => {
  journal.evt('drive', 'reconnexion-auto');
  if (!e.sender.isDestroyed()) e.sender.send('drive:reconnexion');
};
// Reconnexion reussie : l'interface remet le message de l'operation en cours.
const surReconnecteDrive = (e) => () => { if (!e.sender.isDestroyed()) e.sender.send('drive:reconnecte'); };
gerer('drive:pousser', async (e, opts) => {
  const r = await drive.pousser(opts || {}, surReconnexionDrive(e), surReconnecteDrive(e));
  journal.evt('drive', 'pousser', { ok: !!r.ok, conflit: !!r.conflit, reconnecte: !!r.reconnecte, erreur: r.erreur || null });
  return r;
});
gerer('drive:tirer', async (e, opts) => {
  const r = await drive.tirer(opts || {}, surReconnexionDrive(e), surReconnecteDrive(e));
  journal.evt('drive', 'tirer', { ok: !!r.ok, aJour: !!r.aJour, reconnecte: !!r.reconnecte, erreur: r.erreur || null });
  return r;
});

// Synchro par dossier partage (E2c) : fusion ligne a ligne, rien n'est ecrase.
gerer('synchro:etat', () => synchro.etat());
gerer('synchro:choisirDossier', async () => {
  const r = await dialog.showOpenDialog(fenetre, {
    title: 'Dossier de synchro (partagé entre tes appareils)',
    properties: ['openDirectory', 'createDirectory']
  });
  if (r.canceled || !r.filePaths[0]) return { annule: true };
  const out = await synchro.definirDossier(r.filePaths[0]);
  journal.evt('synchro', 'dossier', { dossier: r.filePaths[0], erreur: out.erreur || null });
  return out;
});
gerer('synchro:oublier', () => { journal.evt('synchro', 'oublier-dossier'); return synchro.oublierDossier(); });
// Bilan detaille journalise par synchro/service.js (domaine synchro).
gerer('synchro:synchroniser', () => synchro.synchroniser());
gerer('synchro:drive', (e) => synchro.synchroniserDrive(surReconnexionDrive(e)));

// Mise a jour : verification (au lancement si maj_auto, ou bouton Options),
// telechargement avec progression, puis installation = relance sur le nouvel exe.
gerer('maj:verifier', async () => {
  const r = await maj.verifier();
  journal.evt('maj', 'verifier', { disponible: r.disponible ? r.version : null, erreur: r.erreur || null });
  return r;
});
gerer('maj:telecharger', async (e) => {
  const r = await maj.telecharger((recu, total) => {
    if (!e.sender.isDestroyed()) e.sender.send('maj:progression', { recu, total });
  });
  journal.evt('maj', 'telecharger', { ok: !!r.ok, erreur: r.erreur || null });
  return r;
});
gerer('maj:installer', () => {
  const r = maj.installer();
  journal.evt('maj', 'installer', { ok: !!r.ok, erreur: r.erreur || null });
  if (r.ok) {
    fermetureAutorisee = true;
    setTimeout(() => app.quit(), 500);
  }
  return r;
});

gerer('raccourcis:etat', () => raccourcis.etat());
gerer('raccourcis:perimes', () => raccourcis.perimes());
gerer('raccourcis:basculer', async (_e, type) => {
  const r = await raccourcis.basculer(type);
  return { etat: raccourcis.etat(), manuel: r.manuel };
});
gerer('raccourcis:reparer', (_e, types) => {
  raccourcis.reparer(types);
  return raccourcis.etat();
});

gerer('jeu:tirer', (_e, tagJeu) => jeu.tirer(tagJeu || null));
gerer('jeu:reveler', (_e, id) => jeu.reveler(id));
gerer('jeu:apercu', (_e, id) => jeu.apercu(id));
gerer('jeu:categories', () => jeu.categories());
gerer('jeu:apercuCategories', (_e, sel) => jeu.apercuCategories(sel || {}));

gerer('oeuvres:chercher', (_e, criteres) => db.chercher(criteres || {}));
gerer('oeuvres:numero', (_e, n) => db.parNumero(n));
gerer('oeuvres:parTag', (_e, { tag, texte } = {}) => jeu.listerParTag(tag, texte));
gerer('oeuvres:toutes', (_e, criteres) => jeu.listerToutes(criteres));

gerer('tags:basculer', (_e, { id, tag }) => ({
  actif: db.basculerTag(id, tag),
  comptes: db.comptesTags()
}));

gerer('tags:effacerTout', () => ({
  supprimes: db.effacerTousLesTags(),
  comptes: db.comptesTags()
}));

// Themes a fond clair : pilotent les elements natifs (menus, boites systeme)
// en mode clair. Tout le reste est en mode sombre.
const THEMES_CLAIRS = new Set([
  'clair', 'parchemin', 'lin', 'sepia', 'sepia-profond', 'taupe', 'ardoise'
]);

gerer('reglages:definir', (_e, { cle, valeur }) => {
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

// Conflits de synchro : liste lisible et choix de l'utilisateur.
gerer('conflits:liste', () => synchro.listeConflits());
gerer('conflits:trancher', (_e, { id, choix }) => {
  synchro.resoudre(id, choix === 'perdant' ? 'perdant' : 'gagnant');
  return synchro.listeConflits();
});

// Rapport d'erreur : envoi direct au script de reception (un clic) ; repli
// messagerie si le script n'est pas configure ; en attente si hors ligne.
gerer('rapport:choix', () => rapport.choix());
gerer('rapport:apercu', (_e, formulaire) => {
  try { return rapport.apercu(formulaire || {}); }
  catch (e) { journal.erreur('rapport', 'apercu', e); return { erreur: 'Aperçu impossible : ' + e.message }; }
});
gerer('rapport:envoyer', async (_e, formulaire) => {
  let r;
  try { r = await rapport.envoyer(formulaire || {}); }
  catch (e) { journal.erreur('rapport', 'envoyer', e); return { erreur: 'Rapport impossible : ' + e.message }; }
  if (r.secours) {
    try { await shell.openExternal(r.mailto); }
    catch (e) { journal.erreur('rapport', 'messagerie-absente', e); return { ...r, erreur: 'Aucune messagerie ne s’est ouverte : copie le texte et envoie-le depuis ta boîte mail.' }; }
  }
  return r;
});
gerer('rapport:copier', (_e, formulaire) => {
  clipboard.writeText(rapport.texteACopier(formulaire || {}));
  return { ok: true };
});

gerer('theme:systeme', () => (nativeTheme.shouldUseDarkColors ? 'sombre' : 'clair'));

// La confirmation de fermeture est une fenetre HTML aux tons de l'appli (voir
// App.jsx), pas une boite de dialogue Windows : plus de son systeme. Ce canal
// ferme directement, la question a deja ete posee cote rendu.
gerer('app:quitter', () => {
  fermetureAutorisee = true;
  if (fenetre) fenetre.close(); else app.quit();
  return true;
});
