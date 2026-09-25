'use strict';
/**
 * Synchro ligne a ligne de l'appareil courant, par un dossier partage (E2c)
 * ou par Google Drive (E2d). Meme cœur, meme arborescence « Tuiles et
 * Toiles/ » (format.js) ; seul le transport change.
 *
 * Une synchro = un cycle (cycle.js) : fiche d'appareil, rattrapage par
 * snapshot si besoin, envoi des images puis des ops, reception des ops puis
 * des images, snapshot et purge (compaction.js), puis reconstruction de la
 * vue si quelque chose a change.
 *
 * Toujours optionnelle et non bloquante (regle 1) : dossier absent, pas de
 * reseau, compte deconnecte = message, rien d'autre ne change.
 */

const fs = require('fs');
const path = require('path');
const db = require('../db');
const jeu = require('../jeu');
const edition = require('../edition');
const drive = require('../drive');
const etat = require('./etat');
const cycle = require('./cycle');
const appareilFichier = require('./appareil');
const { NOM_RACINE } = require('./format');
const { creerTransportDossier } = require('./transport-dossier');
const { creerTransportDrive } = require('./transport-drive');
const journal = require('../journal');

const SOUS_DOSSIER = NOM_RACINE;

// Dossier local tenu par Google Drive pour ordinateur (« G:\Mon Drive\… ») :
// les fichiers qu'y depose le client Drive ne sont PAS visibles de l'app via
// l'API Drive (scope drive.file = fichiers crees par l'app). Un telephone
// synchronise par l'API ne les verrait jamais -> on previent.
const RE_MIROIR_DRIVE = /(^|[\\/])(Mon Drive|My Drive|Google Drive|Drive partagés|Shared drives)([\\/]|$)/i;

let cfg = null;
let enCours = false;

/** @param {{ dossierUser, imagesLocales }} c */
function configurer(c) { cfg = c; }

function racine(dossier) {
  return path.basename(dossier) === SOUS_DOSSIER ? dossier : path.join(dossier, SOUS_DOSSIER);
}

function avertissement(dossier) {
  return dossier && RE_MIROIR_DRIVE.test(dossier)
    ? 'Ce dossier semble être ton Google Drive sur l’ordinateur. Ça marche entre ordinateurs, '
      + 'mais un téléphone connecté à Google Drive ne verra pas ces fichiers : pour Drive, '
      + 'préfère « Synchroniser » dans la section Google Drive.'
    : null;
}

function sauverAppareil() {
  appareilFichier.sauver(cfg.dossierUser, etat.appareil());
}

function lire(cle) {
  try { return JSON.parse(db.etatSync(cle) || 'null'); } catch { return null; }
}

function etatSynchro() {
  const a = etat.appareil();
  return {
    dossier: a.dossier_synchro || null,
    appareil: { id: a.id, nom: a.nom, prefixe: a.prefixe_ref },
    derniere: lire('dossier_derniere'),
    derniereDrive: lire('drive_fusion_derniere'),
    conflits: etat.conflits().length,
    avertissement: avertissement(a.dossier_synchro),
    enCours
  };
}

async function definirDossier(dossier) {
  if (!dossier || !fs.existsSync(dossier)) return { erreur: 'Dossier introuvable.' };
  try {
    fs.mkdirSync(racine(dossier), { recursive: true });
    const essai = path.join(racine(dossier), '.essai-' + process.pid);
    fs.writeFileSync(essai, '');
    fs.rmSync(essai);
  } catch (e) {
    journal.erreur('synchro', 'dossier-non-inscriptible', e, { dossier, dossierTexte: journal.decrireTexte(dossier) });
    return { erreur: 'Impossible d’écrire dans ce dossier : ' + e.message };
  }
  journal.evt('synchro', 'dossier-choisi', {
    dossier, dossierTexte: journal.decrireTexte(dossier), miroirDrive: !!avertissement(dossier)
  });
  await creerTransportDossier(racine(dossier)).preparer(etat.appareil().id);
  etat.appareil().dossier_synchro = dossier;
  sauverAppareil();
  return etatSynchro();
}

function oublierDossier() {
  delete etat.appareil().dossier_synchro;
  sauverAppareil();
  return etatSynchro();
}

/**
 * Images dans un sens. Une image en echec est journalisee et ne bloque pas
 * la synchro : elle sera retentee a la suivante.
 */
async function transfererImages(t, sens) {
  let n = 0;
  const faites = [], manquantes = [], echecs = [], invalides = [];
  for (const nom of edition.imagesReferencees()) {
    if (!t.imageValide(nom)) { invalides.push(nom); continue; }
    const local = path.join(cfg.imagesLocales, nom);
    try {
      if (sens === 'envoi') {
        if (!fs.existsSync(local)) { manquantes.push(nom); continue; }
        if (await t.envoyerImage(nom, local)) { n++; faites.push({ nom, octets: fs.statSync(local).size }); }
      } else if (!fs.existsSync(local)) {
        if (await t.recupererImage(nom, local)) { n++; faites.push({ nom, octets: fs.statSync(local).size }); }
        else manquantes.push(nom);
      }
    } catch (e) {
      if (e && e.jetonMort) throw e;
      echecs.push({ nom, erreur: e.message });
      journal.erreur('synchro', 'image-' + sens, e, { nom });
    }
  }
  const niveau = echecs.length ? 'WARN' : 'INFO';
  journal.evt('synchro', 'images-' + sens, {
    transferees: faites, manquantes: manquantes.length ? manquantes : undefined,
    echecs: echecs.length ? echecs : undefined, nomsInvalides: invalides.length ? invalides : undefined
  }, niveau);
  return n;
}

/**
 * Cœur commun : un cycle complet (cycle.js) avec les images et le journal.
 * Leve en cas d'echec (le jeton Drive mort doit remonter) ; l'etape en cours
 * est ajoutee au message et journalisee.
 */
async function coeur(t, sorte) {
  const a = etat.appareil();
  fs.mkdirSync(cfg.imagesLocales, { recursive: true });
  const ctx = etat.contexte();
  const t0 = Date.now();
  let etape = 'depart';
  const pas = async (nom, fn) => {
    etape = nom;
    const t1 = Date.now();
    const r = await fn();
    journal.debug('synchro', 'etape:' + nom, { ms: Date.now() - t1 });
    return r;
  };
  journal.evt('synchro', 'debut', {
    par: sorte, appareil: a.id, nom: a.nom, prefixe: a.prefixe_ref,
    racine: t.racine || (sorte === 'drive' ? 'Google Drive/' + SOUS_DOSSIER : undefined),
    aPousser: ctx.d.prepare('SELECT COUNT(*) n FROM changements WHERE pousse=0').get().n,
    curseurs: ctx.d.prepare("SELECT cle, valeur FROM sync WHERE cle LIKE 'curseur:%'").all()
  });

  try {
    const c = await cycle.executer(ctx, t, {
      nom: a.nom, enregistrerPrefixe: () => sauverAppareil(), pas,
      crochets: {
        imagesEnvoi: () => transfererImages(t, 'envoi'),
        imagesReception: () => transfererImages(t, 'reception')
      }
    });
    const rj = c.rejoindre;
    const r = c.tire;
    // Noms des appareils, pour l'ecran des conflits (« modifie sur Telephone »).
    db.definirEtatSync('appareils_connus', JSON.stringify(rj.appareils || []));
    journal.evt('synchro', 'appareils', {
      premiereFois: rj.premiereFois, prefixe: rj.prefixe, renumerotees: rj.renumerotees, appareils: rj.appareils
    });
    if (c.rattrapage) {
      journal.evt('synchro', 'rattrapage', c.rattrapage, c.rattrapage.manque ? 'ERREUR' : 'INFO');
    }
    if (c.tombes.length) journal.evt('synchro', 'tuiles-oubliees', { cles: c.tombes, raison: 'supprimees depuis plus de 90 jours' });
    journal.evt('synchro', 'pousse', { ops: c.pousse.poussees, segment: c.pousse.segment, stats: c.stats });
    journal.evt('synchro', 'tire', {
      appliquees: r.appliquees, bilan: r.bilan, parAppareil: r.parAppareil, conflits: r.conflits
    }, r.rejetees ? 'WARN' : 'INFO');
    if (r.rejetees) journal.avertir('synchro', 'ops-rejetees', { n: r.rejetees, exemples: r.exemplesRejetes });
    if (c.snapshot) journal.evt('synchro', 'snapshot-ecrit', { nom: c.snapshot.nom, tetes: c.snapshot.ops, nouvelles: c.snapshot.nouvelles, vecteur: c.snapshot.vecteur });
    journal.evt('synchro', 'purge-segments', c.purge, c.purge.supprimes.length ? 'INFO' : 'DEBUG');

    const change = r.appliquees || rj.renumerotees.length || c.imagesRecues || c.tombes.length
      || (c.rattrapage && c.rattrapage.bilan && c.rattrapage.bilan.avance);
    if (change) await pas('vue', () => { db.reconstruireVue({ force: true }); jeu.reinitialiserSac(); });
    const ouverts = etat.conflits();
    if (ouverts.length) {
      journal.avertir('synchro', 'conflits-ouverts', ouverts.map((x) => ({
        entite: x.entite, cle: x.cle, champ: x.champ, gagnant: x.hlc_gagnant, perdant: x.hlc_perdant
      })));
    }
    const bilan = {
      le: new Date().toISOString(),
      poussees: c.pousse.poussees, appliquees: r.appliquees, rejetees: r.rejetees, conflits: r.conflits,
      imagesEnvoyees: c.imagesEnvoyees, imagesRecues: c.imagesRecues,
      prefixe: rj.prefixe, premiereFois: rj.premiereFois, renumerotees: rj.renumerotees,
      rattrapage: c.rattrapage ? (c.rattrapage.snapshot || 'impossible') : null,
      snapshot: c.snapshot ? c.snapshot.nom : null, segmentsPurges: c.purge.supprimes.length,
      tuilesOubliees: c.tombes.length, change: !!change
    };
    journal.evt('synchro', 'fin', { par: sorte, ...bilan, ms: Date.now() - t0 });
    return bilan;
  } catch (e) {
    journal.erreur('synchro', 'echec', e, { par: sorte, etape, ms: Date.now() - t0, jetonMort: !!e.jetonMort });
    if (!e.jetonMort) e.message = '[' + etape + '] ' + e.message;
    throw e;
  }
}

async function exclusif(fn) {
  if (enCours) return { erreur: 'Une synchro est déjà en cours.' };
  enCours = true;
  try { return await fn(); } finally { enCours = false; }
}

/** Synchro par le dossier partage choisi dans Options. */
function synchroniser() {
  const a = etat.appareil();
  if (!a.dossier_synchro) return Promise.resolve({ erreur: 'Aucun dossier de synchro choisi.' });
  if (!fs.existsSync(a.dossier_synchro)) {
    journal.avertir('synchro', 'dossier-introuvable', { dossier: a.dossier_synchro });
    return Promise.resolve({ erreur: 'Dossier de synchro introuvable (clé USB débranchée, lecteur réseau absent ?).' });
  }
  return exclusif(async () => {
    try {
      const bilan = await coeur(creerTransportDossier(racine(a.dossier_synchro)), 'dossier');
      db.definirEtatSync('dossier_derniere', JSON.stringify(bilan));
      return bilan;
    } catch (e) {
      return { erreur: 'Synchro interrompue : ' + e.message };
    }
  });
}

/**
 * Synchro par Google Drive (compte connecte dans Options). Session Google
 * expiree : reconnexion dans le navigateur puis nouvel essai (drive.js).
 * @param {() => void} [surReconnexion] previent l'interface
 * @param {object} [apiTest] api Drive de substitution (tests : faux Drive)
 */
function synchroniserDrive(surReconnexion, apiTest) {
  return exclusif(async () => {
    const op = async (oauth) => {
      const bilan = await coeur(creerTransportDrive(apiTest || drive.api(oauth)), 'drive');
      db.definirEtatSync('drive_fusion_derniere', JSON.stringify(bilan));
      return bilan;
    };
    if (apiTest) {
      try { return await op(null); } catch (e) { return { erreur: 'Synchro interrompue : ' + e.message }; }
    }
    return drive.avecReconnexion(op, surReconnexion);
  });
}

const LIBELLES = {
  titre: 'Titre', artiste: 'Artiste', date: 'Année / période', lieu: 'Conservation',
  description: 'Description', tags: 'Tags', image: 'Image', ref_local: 'Numéro', _existe: 'Existence'
};

/**
 * Conflits ouverts, prets a afficher : oeuvre concernee, champ, et pour
 * chaque version sa valeur, l'appareil et la date.
 */
function listeConflits() {
  const d = db.instance();
  const a = etat.appareil();
  const noms = new Map([[a.id, a.nom + ' (cet appareil)']]);
  for (const f of lire('appareils_connus') || []) if (f.id !== a.id) noms.set(f.id, f.nom || f.id);
  const { lire: lireHlc } = require('./hlc');
  const version = (hlc, valeurJson, entite) => {
    const h = lireHlc(hlc);
    let v = valeurJson;
    if (entite === 'override' && v && typeof v === 'object') v = v.valeur;
    return { hlc, valeur: v, appareil: h.appareil, nomAppareil: noms.get(h.appareil) || h.appareil, le: new Date(h.ms).toISOString() };
  };
  return etat.conflits().map((c) => {
    const o = db.oeuvre(c.cle);
    const l = c.entite === 'locale' ? etat.lignes('locale', c.cle) : {};
    const titre = (o && o.titre) || (l.titre && l.titre.valeur) || '(sans titre)';
    const ref = (o && o.ref) || (l.ref_local && l.ref_local.valeur) || null;
    const base = {
      id: c.id, entite: c.entite, cle: c.cle, champ: c.champ, libelle: LIBELLES[c.champ] || c.champ,
      oeuvre: { titre, ref, locale: c.entite === 'locale' }, detecteLe: c.detecte_le
    };
    if (c.entite === 'locale' && c.champ === '_existe') {
      const m = d.prepare('SELECT champ FROM changements WHERE hlc=?').get(c.hlc_perdant);
      const supprimee = c.valeur_gagnante !== 1;
      return {
        ...base, type: 'suppression', supprimee,
        gagnant: version(c.hlc_gagnant, c.valeur_gagnante, c.entite),
        perdant: { ...version(c.hlc_perdant, c.valeur_perdante, c.entite), champ: m && m.champ, libelleChamp: m && (LIBELLES[m.champ] || m.champ) }
      };
    }
    return {
      ...base, type: 'valeur',
      gagnant: version(c.hlc_gagnant, c.valeur_gagnante, c.entite),
      perdant: version(c.hlc_perdant, c.valeur_perdante, c.entite)
    };
  });
}

/**
 * Tranche un conflit (choix = 'gagnant' | 'perdant') et remet la vue a jour.
 * L'op emise partira a la prochaine synchro et fermera le conflit ailleurs.
 */
function resoudre(id, choix) {
  const c = etat.conflits().find((x) => x.id === id);
  const h = etat.resoudre(id, choix);
  journal.evt('synchro', 'conflit-tranche', {
    id, choix, entite: c && c.entite, cle: c && c.cle, champ: c && c.champ, op: h
  });
  db.reconstruireVue({ force: true });
  jeu.reinitialiserSac();
  return { hlc: h, conflits: etat.conflits() };
}

module.exports = {
  configurer, etat: etatSynchro, definirDossier, oublierDossier,
  synchroniser, synchroniserDrive, resoudre, listeConflits, SOUS_DOSSIER
};
