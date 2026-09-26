'use strict';
/**
 * Canaux du pont mobile : l'equivalent des gerer(...) de src/main/index.js,
 * appeles directement (meme page). Memes modules, memes regles ; seules
 * changent les parties propres au poste (fenetres, raccourcis, mises a jour,
 * dialogues de fichiers), absentes ou remplacees ici.
 */

const { gerer } = require('electron');
const db = require('../main/db');
const jeu = require('../main/jeu');
const edition = require('../main/edition');
const etat = require('../main/synchro/etat');
const annuler = require('../main/annuler');
const journal = require('../main/journal');
const images = require('./images-import');
const imagesUrl = require('./images-url');
const drive = require('./drive');
const synchro = require('../main/synchro/service');
const { creerAuto } = require('../main/synchro/auto');
const reseau = require('./reseau');

const ROUTINE = new Set(['etat', 'synchro:etat', 'images:etat', 'annuler:etat', 'oeuvres:toutes', 'oeuvres:parTag',
  'jeu:tirer', 'jeu:apercu', 'jeu:categories', 'jeu:apercuCategories', 'edition:tuile', 'edition:versions']);

function enregistrer({ version, dossierImagesLocales, surEcriture, emettre }) {
  // Journalise comme gerer() du PC, puis signale une ecriture possible (la
  // base est sauvegardee en differe).
  const g = (canal, fn) => gerer(canal, async (...args) => {
    const t0 = Date.now();
    try {
      const r = await fn(...args);
      journal.evt('ipc', canal, { ms: Date.now() - t0, erreur: r && r.erreur }, r && r.erreur ? 'WARN' : ROUTINE.has(canal) ? 'DEBUG' : 'INFO');
      if (!ROUTINE.has(canal)) surEcriture();
      return r;
    } catch (e) {
      journal.erreur('ipc', canal, e, { ms: Date.now() - t0 });
      throw e;
    }
  });

  const refDe = (id) => { const o = db.oeuvre(id); return o ? '#' + o.ref : 'une tuile'; };
  const NOMS_MARQUES = { livre: 'livre', etoile: 'étoile', bad_smiley: 'à revoir' };
  const lirePrefs = () => { try { return JSON.parse(db.reglage('prefs_affichage', '{}')) || {}; } catch { return {}; } };

  g('etat', () => ({
    prefs: lirePrefs(),
    oeuvres: db.compterOeuvres(),
    tags: db.comptesTags(),
    theme: db.reglage('theme', 'auto'),
    sidebarRepliee: db.reglage('sidebar_repliee', '1') === '1',
    grilleColonnes: parseInt(db.reglage('grille_colonnes', '2'), 10) || 2,
    raccourcisProposes: true,
    majAuto: false,
    forme: 'mobile',
    version,
    derniereSynchro: db.etatSync('derniere_synchro'),
    conflits: etat.conflits().length,
    corbeille: edition.corbeille().length
  }));
  gerer('journal', (msg, extra) => journal.ligne('[ui] ' + msg, extra));
  gerer('journal:evt', (domaine, quoi, donnees, niveau) =>
    journal.evt(domaine || 'ui', quoi, donnees, ['DEBUG', 'INFO', 'WARN', 'ERREUR'].includes(niveau) ? niveau : 'INFO'));

  // --- jeu, oeuvres, marques --------------------------------------------------
  g('jeu:tirer', (tagJeu) => jeu.tirer(tagJeu || null));
  g('jeu:reveler', (id) => jeu.reveler(id));
  g('jeu:apercu', (id) => jeu.apercu(id));
  g('jeu:categories', () => jeu.categories());
  g('jeu:apercuCategories', (sel) => jeu.apercuCategories(sel || {}));
  g('oeuvres:chercher', (c) => db.chercher(c || {}));
  g('oeuvres:numero', (n) => db.parNumero(n));
  g('oeuvres:parTag', ({ tag, texte } = {}) => jeu.listerParTag(tag, texte));
  g('oeuvres:toutes', (c) => jeu.listerToutes(c));
  g('tags:basculer', ({ id, tag }) => ({
    actif: annuler.action((actif) => (actif ? 'Marque ' : 'Retrait de la marque ') + (NOMS_MARQUES[tag] || tag)
      + ' sur ' + refDe(id), () => db.basculerTag(id, tag)),
    comptes: db.comptesTags()
  }));
  g('tags:effacerTout', () => ({
    supprimes: annuler.action('Effacement de toutes les marques', () => db.effacerTousLesTags()),
    comptes: db.comptesTags()
  }));
  g('reglages:definir', ({ cle, valeur }) => { db.definirReglage(cle, valeur); return true; });
  g('theme:systeme', () => (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'sombre' : 'clair'));

  // --- edition, corbeille, annuler -------------------------------------------
  g('edition:creer', (champs) => annuler.action((r) => 'Création de #' + (r && r.ref), () => edition.creer(champs || {})));
  g('edition:tuile', (id) => edition.tuile(id));
  g('edition:modifier', ({ id, champs }) => annuler.action('Modification de ' + refDe(id), () => edition.modifier(id, champs || {})));
  g('edition:supprimer', (id) => annuler.action('Suppression de ' + refDe(id), () => edition.supprimer(id)));
  g('edition:versions', (id) => edition.versions(id));
  g('edition:journal', (opts) => edition.journalModifs(opts || {}));
  g('corbeille:liste', () => edition.corbeille());
  g('corbeille:restaurer', (id) => annuler.action((r) => 'Restauration de #' + (r && r.ref), () => edition.restaurer(id)));
  const apresAnnulation = (r) => { if (r.faites) edition.rafraichir(); return { ...r, comptes: db.comptesTags() }; };
  g('annuler:annuler', () => apresAnnulation(annuler.annuler()));
  g('annuler:retablir', () => apresAnnulation(annuler.retablir()));
  g('annuler:etat', () => annuler.etatPiles());

  // Photo : galerie ou appareil photo, via le selecteur de fichiers de la
  // WebView (Capacitor le relie a l'appareil photo).
  g('edition:choisirImage', () => new Promise((ok) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const f = input.files && input.files[0];
      if (!f) { ok(null); return; }
      ok(await images.importer(new Uint8Array(await f.arrayBuffer()), dossierImagesLocales,
        { origine: 'selecteur', nom: f.name, type: f.type, octets: f.size }));
    };
    input.oncancel = () => ok(null);
    input.click();
  }));
  // Appareil photo (@capacitor/camera) : la photo prise est lue puis passe par
  // le meme import (redimensionnee, <= 500 Ko) qu'une image choisie.
  g('edition:prendrePhoto', async () => {
    let r;
    try { r = await require('@capacitor/camera').Camera.takePhoto({ quality: 90, correctOrientation: true }); }
    catch (e) {
      if (/cancel|annul/i.test(String(e && e.message))) return null;   // l'utilisateur a renonce
      journal.erreur('image', 'appareil-photo', e);
      return { erreur: 'Appareil photo indisponible : ' + (e && e.message || e) };
    }
    const chemin = r && (r.webPath || r.uri);
    if (!chemin) return null;
    const octets = new Uint8Array(await (await fetch(chemin)).arrayBuffer());
    return images.importer(octets, dossierImagesLocales, { origine: 'appareil-photo', octets: octets.length });
  });
  g('edition:importerImage', (octets, meta) => images.importer(new Uint8Array(octets), dossierImagesLocales, { origine: 'depot', ...(meta || {}) }));
  g('edition:importerImageUrl', () => ({ erreur: 'Sur mobile, choisis l’image dans ta galerie ou prends une photo.' }));
  g('edition:oublierImage', (nom) => edition.oublierImage(nom));

  // --- images du pack ----------------------------------------------------------
  g('images:etat', () => ({ ...imagesUrl.etat(), horsLigne: db.reglage('images_hors_ligne', '0') === '1' }));
  g('images:toutTelecharger', () => imagesUrl.toutTelecharger((p) => require('electron').emettre('images:progression', p)));

  // --- rapport d'erreur (meme script de reception que le PC) -------------------
  const rapport = require('../main/rapport');
  g('rapport:choix', () => rapport.choix());
  g('rapport:apercu', (f) => rapport.apercu(f || {}));
  g('rapport:envoyer', async (f) => {
    const r = await rapport.envoyer(f || {});
    if (r.secours && r.mailto) window.location.href = r.mailto;
    return r;
  });
  g('rapport:copier', async (f) => {
    try { await navigator.clipboard.writeText(rapport.texteACopier(f || {})); return { ok: true }; }
    catch (e) { return { erreur: 'Copie impossible : ' + e.message }; }
  });

  // --- propres au poste : absents sur mobile ------------------------------------
  g('raccourcis:etat', () => null);
  g('raccourcis:perimes', () => []);
  g('maj:verifier', () => ({ aJour: true }));
  g('copie:etat', () => null);
  // « Quitter » sur Android = passer en arriere-plan (l'appli reste prete).
  g('app:quitter', async () => {
    try { await require('@capacitor/app').App.minimizeApp(); } catch { /* navigateur : rien */ }
    return true;
  });

  // --- Google Drive et synchro (memes modules que le PC) ------------------------
  synchro.configurer({ dossierUser: '/data', imagesLocales: dossierImagesLocales, surProgression: (p) => emettre('synchro:progression', p) });
  const auto = creerAuto({
    actif: () => db.reglage('synchro_auto', '1') === '1',
    cibles: () => (drive.etat().connecte && !db.etatSync('drive_pause_auto') ? ['drive'] : []),
    lancer: async () => {
      const r = await synchro.synchroniserDrive(null, null, { auto: true });
      if (r && r.jetonMort) db.definirEtatSync('drive_pause_auto', new Date().toISOString());
      surEcriture();
      return r;
    },
    aEnvoyer: () => db.instance().prepare('SELECT COUNT(*) n FROM changements WHERE pousse=0').get().n,
    conflitsOuverts: () => db.instance().prepare('SELECT COUNT(*) n FROM conflits WHERE resolu=0').get().n,
    // « Wi-Fi seulement » (actif par defaut) : rien d'automatique en donnees mobiles.
    reseauPermis: () => db.reglage('synchro_wifi', '1') !== '1' || reseau.wifi(),
    journal
  });
  const etatAuto = () => ({
    actif: db.reglage('synchro_auto', '1') === '1', pauseDrive: db.etatSync('drive_pause_auto') || null,
    wifiSeulement: db.reglage('synchro_wifi', '1') === '1', wifi: reseau.wifi(), mobile: true
  });

  g('drive:etat', () => drive.etat());
  g('drive:connecter', async () => {
    const r = await drive.connecter();
    if (r.connecte) db.definirEtatSync('drive_pause_auto', '');
    return { ...drive.etat(), ...r };
  });
  g('drive:deconnecter', () => { drive.deconnecter(); return drive.etat(); });
  g('synchro:etat', () => ({ ...synchro.etat(), auto: etatAuto() }));
  g('synchro:drive', async () => {
    const r = await synchro.synchroniserDrive(() => journal.evt('drive', 'reconnexion-auto'));
    if (!r.erreur && db.etatSync('drive_pause_auto')) db.definirEtatSync('drive_pause_auto', '');
    return r;
  });
  g('appareils:liste', () => synchro.listeAppareils());
  g('appareils:retirer', ({ id, retirer }) => synchro.retirerAppareil(id, retirer !== false));
  g('conflits:liste', () => synchro.listeConflits());
  g('conflits:trancher', ({ id, choix }) => {
    annuler.action('Choix dans un conflit', () => synchro.resoudre(id, choix === 'perdant' ? 'perdant' : 'gagnant'));
    const reste = synchro.listeConflits();
    auto.differer(reste.length ? 'conflit-tranche' : 'conflits-resolus', reste.length ? 3000 : 0).catch(() => {});
    return reste;
  });
  g('conflits:actualiser', async () => {
    const r = await auto.declencher('ecran-conflits', { forcer: true });
    return { conflits: synchro.listeConflits(), synchro: !!r };
  });
  return auto;
}

module.exports = { enregistrer };
