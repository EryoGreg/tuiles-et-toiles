'use strict';
/**
 * Synchro de l'appareil courant avec un dossier partage (E2c).
 *
 * L'utilisateur choisit un dossier (cle USB, OneDrive, Syncthing…) dans
 * Options ; l'app y range tout sous « Tuiles et Toiles - synchro/ ». Chaque
 * appareil qui pointe vers ce meme dossier se synchronise avec les autres.
 *
 * Une synchro : fiche d'appareil (prefixe a la premiere fois) -> envoi des
 * images puis des ops -> reception des ops puis des images manquantes ->
 * reconstruction de la vue si quelque chose a change.
 *
 * Toujours optionnelle et non bloquante (regle 1) : dossier absent ou
 * illisible = message, rien d'autre ne change.
 */

const fs = require('fs');
const path = require('path');
const db = require('../db');
const jeu = require('../jeu');
const edition = require('../edition');
const etat = require('./etat');
const echange = require('./echange');
const appareilFichier = require('./appareil');
const { rejoindre } = require('./rejoindre');
const { creerTransportDossier } = require('./transport-dossier');

const SOUS_DOSSIER = 'Tuiles et Toiles - synchro';

let cfg = null;
let enCours = false;

/** @param {{ dossierUser, imagesLocales }} c */
function configurer(c) { cfg = c; }

function racine(dossier) {
  return path.basename(dossier) === SOUS_DOSSIER ? dossier : path.join(dossier, SOUS_DOSSIER);
}

function sauverAppareil() {
  appareilFichier.sauver(cfg.dossierUser, etat.appareil());
}

function lireDerniere() {
  try { return JSON.parse(db.etatSync('dossier_derniere') || 'null'); } catch { return null; }
}

function etatSynchro() {
  const a = etat.appareil();
  return {
    dossier: a.dossier_synchro || null,
    appareil: { id: a.id, nom: a.nom, prefixe: a.prefixe_ref },
    derniere: lireDerniere(),
    conflits: etat.conflits().length,
    enCours
  };
}

function definirDossier(dossier) {
  if (!dossier || !fs.existsSync(dossier)) return { erreur: 'Dossier introuvable.' };
  try {
    fs.mkdirSync(racine(dossier), { recursive: true });
    const essai = path.join(racine(dossier), '.essai-' + process.pid);
    fs.writeFileSync(essai, '');
    fs.rmSync(essai);
  } catch (e) {
    return { erreur: 'Impossible d’écrire dans ce dossier : ' + e.message };
  }
  etat.appareil().dossier_synchro = dossier;
  sauverAppareil();
  return etatSynchro();
}

function oublierDossier() {
  delete etat.appareil().dossier_synchro;
  sauverAppareil();
  return etatSynchro();
}

async function transfererImages(t, sens) {
  let n = 0;
  for (const nom of edition.imagesReferencees()) {
    if (!t.imageValide(nom)) continue;
    const local = path.join(cfg.imagesLocales, nom);
    if (sens === 'envoi') {
      if (fs.existsSync(local) && await t.envoyerImage(nom, local)) n++;
    } else if (!fs.existsSync(local)) {
      if (await t.recupererImage(nom, local)) n++;
    }
  }
  return n;
}

/**
 * @returns {Promise<{ poussees, appliquees, conflits, imagesEnvoyees,
 *   imagesRecues, prefixe, renumerotees, premiereFois } | { erreur }>}
 */
async function synchroniser() {
  const a = etat.appareil();
  if (!a.dossier_synchro) return { erreur: 'Aucun dossier de synchro choisi.' };
  if (!fs.existsSync(a.dossier_synchro)) {
    return { erreur: 'Dossier de synchro introuvable (clé USB débranchée, lecteur réseau absent ?).' };
  }
  if (enCours) return { erreur: 'Une synchro est déjà en cours.' };
  enCours = true;
  try {
    fs.mkdirSync(cfg.imagesLocales, { recursive: true });
    const t = creerTransportDossier(racine(a.dossier_synchro));
    const ctx = etat.contexte();

    const rj = await rejoindre(ctx, t, { nom: a.nom, enregistrerPrefixe: () => sauverAppareil() });
    const imagesEnvoyees = await transfererImages(t, 'envoi');
    const p = await echange.pousser(ctx, t);
    const r = await echange.tirer(ctx, t);
    const imagesRecues = await transfererImages(t, 'reception');

    if (r.appliquees || rj.renumerotees.length || imagesRecues) {
      db.reconstruireVue({ force: true });
      jeu.reinitialiserSac();
    }
    const bilan = {
      le: new Date().toISOString(),
      poussees: p.poussees, appliquees: r.appliquees, rejetees: r.rejetees, conflits: r.conflits,
      imagesEnvoyees, imagesRecues,
      prefixe: rj.prefixe, premiereFois: rj.premiereFois, renumerotees: rj.renumerotees
    };
    db.definirEtatSync('dossier_derniere', JSON.stringify(bilan));
    return bilan;
  } catch (e) {
    return { erreur: 'Synchro interrompue : ' + e.message };
  } finally {
    enCours = false;
  }
}

/**
 * Tranche un conflit (choix = 'gagnant' | 'perdant') et remet la vue a jour.
 * L'op emise partira a la prochaine synchro et fermera le conflit ailleurs.
 */
function resoudre(id, choix) {
  const h = etat.resoudre(id, choix);
  db.reconstruireVue({ force: true });
  jeu.reinitialiserSac();
  return { hlc: h, conflits: etat.conflits() };
}

module.exports = {
  configurer, etat: etatSynchro, definirDossier, oublierDossier, synchroniser, resoudre, SOUS_DOSSIER
};
