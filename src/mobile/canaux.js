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

const ROUTINE = new Set(['etat', 'synchro:etat', 'images:etat', 'annuler:etat', 'oeuvres:toutes', 'oeuvres:parTag',
  'jeu:tirer', 'jeu:apercu', 'jeu:categories', 'jeu:apercuCategories', 'edition:tuile', 'edition:versions']);

function enregistrer({ version, dossierImagesLocales, surEcriture }) {
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
  g('edition:importerImage', (octets, meta) => images.importer(new Uint8Array(octets), dossierImagesLocales, { origine: 'depot', ...(meta || {}) }));
  g('edition:importerImageUrl', () => ({ erreur: 'Sur mobile, choisis l’image dans ta galerie ou prends une photo.' }));
  g('edition:oublierImage', (nom) => edition.oublierImage(nom));

  // --- images du pack ----------------------------------------------------------
  g('images:etat', () => ({ ...imagesUrl.etat(), horsLigne: db.reglage('images_hors_ligne', '0') === '1' }));
  g('images:toutTelecharger', () => imagesUrl.toutTelecharger((p) => require('electron').emettre('images:progression', p)));

  // --- propres au poste : absents sur mobile ------------------------------------
  g('raccourcis:etat', () => null);
  g('raccourcis:perimes', () => []);
  g('maj:verifier', () => ({ aJour: true }));
  g('copie:etat', () => null);
  g('drive:etat', () => ({ configure: false, connecte: false }));
  g('synchro:etat', () => ({
    dossier: null, appareil: { id: etat.appareil().id, nom: etat.appareil().nom, prefixe: etat.appareil().prefixe_ref },
    derniere: null, derniereDrive: null, progression: { enCours: false }, conflits: etat.conflits().length,
    enCours: false, auto: { actif: false, pauseDrive: null }
  }));
  g('appareils:liste', () => []);
  g('conflits:liste', () => []);
  g('conflits:actualiser', () => ({ conflits: [], synchro: false }));
  g('app:quitter', () => true);
}

module.exports = { enregistrer };
