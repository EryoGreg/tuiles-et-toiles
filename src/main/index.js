'use strict';
/**
 * Processus principal Electron.
 *
 * Isolation stricte : le rendu n'a aucun acces a Node. Tout passe par les
 * canaux IPC declares plus bas et exposes via preload.js. C'est indispensable
 * ici, le processus principal detiendra le jeton OAuth.
 */

const { app, BrowserWindow, ipcMain, nativeTheme, protocol, net, dialog, shell, clipboard, screen, powerMonitor } = require('electron');
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
const { creerAuto } = require('./synchro/auto');
const copieSecurite = require('./copie-securite');
const imagesDistantes = require('./images-distantes');
const annuler = require('./annuler');

// Avant tout getPath('userData') : sinon Electron nomme le dossier d'apres le
// champ "name" du package.json (tuiles-et-toiles).
app.setName('Tuiles et Toiles');

const DEV = !app.isPackaged;

// Contenu livre avec l'application (extraResources), lecture seule.
const DATA_LIVRE = DEV
  ? path.resolve(__dirname, '..', '..', 'data')
  : path.join(process.resourcesPath, 'data');

// Images du pack (images-distantes.js) : vignettes embarquees, grandes images
// telechargees a la demande dans un cache. En dev, data/images/ sert de source
// locale (TT_SANS_IMAGES=1 pour tester le telechargement).
const DOSSIER_IMAGES = path.join(DATA_LIVRE, 'images');
const DOSSIER_VIGNETTES = path.join(DATA_LIVRE, 'vignettes');
const MANIFESTE_IMAGES = path.join(DATA_LIVRE, 'images-manifest.json');

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
    // Icone des raccourcis hors de l'exe (voir raccourcis.js), puis raccourcis
    // existants repointes, quelques secondes apres l'affichage.
    raccourcis.preparerIcone(DOSSIER_USER, path.join(process.resourcesPath, 'icone.ico'));
    setTimeout(() => {
      try { raccourcis.reparerIcones(journal); } catch (e) { journal.erreur('app', 'raccourcis-icone', e); }
    }, 3000);
    // Version installee : dossier du programme (remis a neuf a chaque mise a jour).
    if (maj.mode() === 'installee') lisezmoi.deposer(path.dirname(process.execPath), 'installation');
  }

  imagesDistantes.configurer({
    cache: path.join(DOSSIER_USER, 'images-cache'),
    vignettes: DOSSIER_VIGNETTES,
    embarquees: process.env.TT_SANS_IMAGES ? null : DOSSIER_IMAGES,
    manifeste: MANIFESTE_IMAGES,
    fetch: (url, opts) => net.fetch(url, opts),
    journal, lisezmoi
  });
  // tuile://<nom> : image entiere ; tuile://mini/<nom> : vignette (grilles).
  // Image d'une tuile creee d'abord (images-locales), puis image du pack.
  protocol.handle('tuile', async (requete) => {
    const u = new URL(requete.url);
    const brut = decodeURIComponent(u.hostname + u.pathname).replace(/^\/+/, '');
    const mini = brut.startsWith('mini/');
    const nom = path.basename(brut);
    const locale = path.join(DOSSIER_IMAGES_LOCALES, nom);
    if (locale.startsWith(DOSSIER_IMAGES_LOCALES) && fs.existsSync(locale)) {
      return net.fetch(pathToFileURL(locale).toString());
    }
    const cible = await imagesDistantes.chemin(nom, { mini });
    return cible ? net.fetch(pathToFileURL(cible).toString()) : new Response('', { status: 404 });
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
  // Copie de securite hebdomadaire, silencieuse (copie-securite.js). Une minute
  // apres le lancement (pas pendant le demarrage), puis verifiee toutes les 6 h.
  copieSecurite.configurer({
    dossier: DEV ? path.join(DOSSIER_USER, 'sauvegardes') : path.join(app.getPath('documents'), 'Tuiles et Toiles - sauvegardes'),
    exporter: (chemin) => sauvegarde.exporter(chemin),
    aDesDonnees: () => db.instance().prepare('SELECT COUNT(*) n FROM etat').get().n > 0
  });
  const copier = () => { try { copieSecurite.siBesoin(); } catch (e) { journal.erreur('sauvegarde', 'copie-securite', e); } };
  // Grandes images pour le hors-ligne (reglage images_hors_ligne, actif par
  // defaut sur PC) : 90 s apres le lancement, puis toutes les 30 min tant
  // qu'il en manque (hors ligne : on reessaie plus tard).
  const imagesHorsLigne = () => {
    if (db.reglage('images_hors_ligne', '1') !== '1') return;
    if (!imagesDistantes.etat().nombre || imagesDistantes.etat().presentes >= imagesDistantes.etat().nombre) return;
    imagesDistantes.toutTelecharger(diffuserImages).catch((e) => journal.erreur('image', 'hors-ligne', e));
  };
  setTimeout(imagesHorsLigne, 90e3);
  setInterval(imagesHorsLigne, 30 * 60e3);
  setTimeout(copier, 60e3);
  setInterval(copier, 6 * 3600e3);
  synchro.configurer({
    dossierUser: DOSSIER_USER, imagesLocales: DOSSIER_IMAGES_LOCALES,
    surProgression: (p) => {
      for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('synchro:progression', p);
    }
  });
  synchroAuto.demarrer();
  // Au reveil, le reseau met quelques secondes a revenir.
  powerMonitor.on('resume', () => setTimeout(() => synchroAuto.declencher('reveil'), 10e3));

  rapport.configurer({
    dossier: path.join(app.getPath('documents'), 'Tuiles et Toiles - rapports'),
    version: app.getVersion(),
    infos: infosRapport,
    fetch: (url, opts) => net.fetch(url, opts)
  });
  // Rapports restes en attente (envoi hors ligne ou refuse) : renvoi discret
  // 8 s apres le lancement, puis toutes les 10 min tant qu'il en reste.
  const renvoyer = () => {
    if (!rapport.listerAttente().length) return;
    rapport.renvoyerEnAttente()
      .then((r) => journal.evt('rapport', 'attente', r))
      .catch((e) => journal.erreur('rapport', 'renvoi', e));
  };
  setTimeout(renvoyer, 8000);
  setInterval(renvoyer, 10 * 60e3);
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
    drive: { configure: dv.configure, connecte: dv.connecte },
    reglages: { theme: db.reglage('theme'), majAuto: db.reglage('maj_auto', '1') }
  };
}

// --- canaux IPC ------------------------------------------------------------

// Chaque canal est journalise : arguments resumes, duree, resultat ou erreur.
// Lectures appelees en boucle -> DEBUG ; resultat { erreur } -> WARN.
const ROUTINE = new Set([
  'etat', 'drive:etat', 'synchro:etat', 'copie:etat', 'annuler:etat', 'images:etat', 'raccourcis:etat', 'raccourcis:perimes', 'theme:systeme',
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

function lirePrefsAffichage() {
  try { return JSON.parse(db.reglage('prefs_affichage', '{}')) || {}; } catch { return {}; }
}

gerer('etat', () => ({
  prefs: lirePrefsAffichage(),
  oeuvres: db.compterOeuvres(),
  tags: db.comptesTags(),
  theme: db.reglage('theme', 'auto'),
  sidebarRepliee: db.reglage('sidebar_repliee', '0') === '1',
  grilleColonnes: parseInt(db.reglage('grille_colonnes', '5'), 10) || 5,
  raccourcisProposes: db.reglage('raccourcis_proposes', '0') === '1',
  majAuto: db.reglage('maj_auto', '1') === '1',
  forme: maj.mode(),
  version: app.getVersion(),
  derniereSynchro: db.etatSync('derniere_synchro'),
  conflits: etat.conflits().length,
  corbeille: edition.corbeille().length
}));

ipcMain.on('journal', (_e, msg, extra) => journal.ligne('[ui] ' + msg, extra));
ipcMain.on('journal:evt', (_e, domaine, quoi, donnees, niveau) =>
  journal.evt(domaine || 'ui', quoi, donnees, ['DEBUG', 'INFO', 'WARN', 'ERREUR'].includes(niveau) ? niveau : 'INFO'));

// Detail (champs decrits, image, masques) journalise par edition.js.
// Actions annulables (Ctrl+Z) : leurs ecritures sont capturees par annuler.js.
const refDe = (id) => { const o = db.oeuvre(id); return o ? '#' + o.ref : 'une tuile'; };
const NOMS_MARQUES = { livre: 'livre', etoile: 'étoile', bad_smiley: 'à revoir' };
gerer('edition:creer', (_e, champs) =>
  annuler.action((r) => 'Création de #' + (r && r.ref), () => edition.creer(champs || {})));
gerer('edition:tuile', (_e, id) => edition.tuile(id));
gerer('edition:modifier', (_e, { id, champs }) =>
  annuler.action('Modification de ' + refDe(id), () => edition.modifier(id, champs || {})));
gerer('edition:supprimer', (_e, id) =>
  annuler.action('Suppression de ' + refDe(id), () => edition.supprimer(id)));
gerer('edition:versions', (_e, id) => edition.versions(id));
gerer('edition:journal', (_e, opts) => edition.journalModifs(opts || {}));
gerer('corbeille:liste', () => edition.corbeille());
gerer('corbeille:restaurer', (_e, id) =>
  annuler.action((r) => 'Restauration de #' + (r && r.ref), () => edition.restaurer(id)));
// Annuler / retablir : l'ecriture inverse, puis vue et sac remis a jour.
const apresAnnulation = (r) => {
  if (r.faites) edition.rafraichir();
  return { ...r, comptes: db.comptesTags() };
};
gerer('annuler:annuler', () => apresAnnulation(annuler.annuler()));
gerer('annuler:retablir', () => apresAnnulation(annuler.retablir()));
gerer('annuler:etat', () => annuler.etatPiles());

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

// Lecture de cartel (ML Kit) : appli Android seulement pour l'instant.
gerer('edition:lireCartel', () => ({ erreur: 'La lecture de cartel est disponible dans l’appli Android.' }));
gerer('edition:cartelEtat', () => ({ disponible: false }));
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
    journal.evt('sauvegarde', 'import', { chemin, source: out.source, resume: out.resume, conflits: out.conflits });
    return out;
  } catch (e) {
    journal.erreur('sauvegarde', 'import', e, { chemin });
    return { erreur: e.message };
  }
});

gerer('copie:etat', () => copieSecurite.etat());
gerer('images:etat', () => ({ ...imagesDistantes.etat(), horsLigne: db.reglage('images_hors_ligne', '1') === '1' }));
gerer('images:toutTelecharger', async () => imagesDistantes.toutTelecharger(diffuserImages));
gerer('copie:ouvrir', async () => {
  const { dossier } = copieSecurite.etat();
  if (!fs.existsSync(dossier)) return { erreur: 'Aucune copie pour l’instant.' };
  const err = await shell.openPath(dossier);
  return err ? { erreur: err } : { ok: true };
});

gerer('drive:etat', () => drive.etat());
gerer('drive:connecter', async () => {
  const r = await drive.connecter();
  if (r.connecte) db.definirEtatSync('drive_pause_auto', '');
  journal.evt('drive', 'connecter', { connecte: !!r.connecte, erreur: r.erreur || null });
  return { ...drive.etat(), ...r };
});
gerer('drive:deconnecter', () => { drive.deconnecter(); journal.evt('drive', 'deconnecter'); return drive.etat(); });
// Jeton refuse par Google en cours de synchro : drive.js relance le flux
// OAuth ; le rendu l'apprend par la progression de la synchro (etape reconnexion).
const surReconnexionDrive = () => () => journal.evt('drive', 'reconnexion-auto');

// Progression du telechargement des images, vers toutes les fenetres.
function diffuserImages(p) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('images:progression', p);
}

// Synchro automatique (synchro/auto.js) vers chaque cible configuree et
// joignable : Google Drive (sauf pause apres une session expiree : pas de
// navigateur ouvert sans clic) et le dossier partage (s'il est branche).
const synchroAuto = creerAuto({
  actif: () => db.reglage('synchro_auto', '1') === '1',
  cibles: () => {
    const c = [];
    if (drive.etat().connecte && !db.etatSync('drive_pause_auto')) c.push('drive');
    const dossier = etat.appareil().dossier_synchro;
    if (dossier && fs.existsSync(dossier)) c.push('dossier');
    return c;
  },
  lancer: async (cible) => {
    const r = cible === 'drive'
      ? await synchro.synchroniserDrive(null, null, { auto: true })
      : await synchro.synchroniser({ auto: true });
    if (r && r.jetonMort) {
      db.definirEtatSync('drive_pause_auto', new Date().toISOString());
      journal.avertir('synchro', 'auto-drive-pause', { raison: 'session Google expiree' });
    }
    return r;
  },
  aEnvoyer: () => db.instance().prepare('SELECT COUNT(*) n FROM changements WHERE pousse=0').get().n,
  conflitsOuverts: () => db.instance().prepare('SELECT COUNT(*) n FROM conflits WHERE resolu=0').get().n,
  journal
});
function etatAuto() {
  return { actif: db.reglage('synchro_auto', '1') === '1', pauseDrive: db.etatSync('drive_pause_auto') || null };
}

// Synchro par dossier partage (E2c) : fusion ligne a ligne, rien n'est ecrase.
gerer('synchro:etat', () => ({ ...synchro.etat(), auto: etatAuto() }));
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
gerer('synchro:drive', async (e) => {
  const r = await synchro.synchroniserDrive(surReconnexionDrive(e));
  // Synchro manuelle reussie : la synchro auto Drive reprend (pause posee par
  // une session expiree, voir synchroAuto).
  if (!r.erreur && db.etatSync('drive_pause_auto')) {
    db.definirEtatSync('drive_pause_auto', '');
    journal.evt('synchro', 'auto-drive-reprise');
  }
  return r;
});

// Mise a jour : verification (au lancement si maj_auto, ou bouton Options),
// telechargement avec progression, puis installation = relance sur le nouvel exe.
gerer('maj:verifier', async () => {
  const r = await maj.verifier();
  journal.evt('maj', 'verifier', { disponible: r.disponible ? r.version : null, erreur: r.erreur || null });
  return r;
});
gerer('maj:telecharger', async (e, opts) => {
  const r = await maj.telecharger((recu, total) => {
    if (!e.sender.isDestroyed()) e.sender.send('maj:progression', { recu, total });
  }, { versInstallee: !!(opts && opts.versInstallee) });
  journal.evt('maj', 'telecharger', { ok: !!r.ok, erreur: r.erreur || null });
  return r;
});
gerer('maj:installer', async () => {
  // Dernieres modifications envoyees avant de ceder la place (10 s max).
  try { await synchroAuto.avantFermeture(); } catch (e) { journal.erreur('synchro', 'auto-avant-maj', e); }
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
  actif: annuler.action((actif) => (actif ? 'Marque ' : 'Retrait de la marque ') + (NOMS_MARQUES[tag] || tag)
    + ' sur ' + refDe(id), () => db.basculerTag(id, tag)),
  comptes: db.comptesTags()
}));

gerer('tags:effacerTout', () => ({
  supprimes: annuler.action('Effacement de toutes les marques', () => db.effacerTousLesTags()),
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
gerer('appareils:liste', () => synchro.listeAppareils());
gerer('appareils:retirer', (_e, { id, retirer }) => synchro.retirerAppareil(id, retirer !== false));
gerer('conflits:liste', () => synchro.listeConflits());
gerer('conflits:trancher', (_e, { id, choix }) => {
  annuler.action('Choix dans un conflit', () => synchro.resoudre(id, choix === 'perdant' ? 'perdant' : 'gagnant'));
  const reste = synchro.listeConflits();
  // Le choix part vers les autres appareils sans attendre : tout de suite
  // s'il ne reste rien a trancher, sinon 3 s apres le dernier choix.
  synchroAuto.differer(reste.length ? 'conflit-tranche' : 'conflits-resolus', reste.length ? 3000 : 0)
    .catch((e) => journal.erreur('synchro', 'apres-conflit', e));
  return reste;
});
// Ecran Conflits ouvert : synchro d'abord, pour ne pas montrer des conflits
// deja tranches sur un autre appareil. Renvoie la liste a jour.
gerer('conflits:actualiser', async () => {
  const r = await synchroAuto.declencher('ecran-conflits', { forcer: true });
  return { conflits: synchro.listeConflits(), synchro: !!r };
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
gerer('app:quitter', async () => {
  // Dernieres modifications pas encore parties : envoi avant de fermer (10 s max).
  try { await synchroAuto.avantFermeture(); } catch (e) { journal.erreur('synchro', 'auto-fermeture', e); }
  fermetureAutorisee = true;
  if (fenetre) fenetre.close(); else app.quit();
  return true;
});
