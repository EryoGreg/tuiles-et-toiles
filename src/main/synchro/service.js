'use strict';
/**
 * Synchro ligne a ligne de l'appareil courant, par un dossier partage (E2c)
 * ou par Google Drive (E2d). Meme cœur, meme arborescence « Tuiles et
 * Toiles/ » (format.js) ; seul le transport change.
 *
 * Une synchro : arborescence + LISEZMOI -> fiche d'appareil (prefixe a la
 * premiere fois) -> compteurs de vues -> envoi des images puis des ops ->
 * reception des ops puis des images manquantes -> reconstruction de la vue
 * si quelque chose a change.
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
const moteur = require('./moteur');
const echange = require('./echange');
const appareilFichier = require('./appareil');
const { NOM_RACINE } = require('./format');
const { rejoindre } = require('./rejoindre');
const { creerTransportDossier } = require('./transport-dossier');
const { creerTransportDrive } = require('./transport-drive');

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
    return { erreur: 'Impossible d’écrire dans ce dossier : ' + e.message };
  }
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

/** Cœur commun. Leve en cas d'echec (le jeton Drive mort doit remonter). */
async function coeur(t) {
  const a = etat.appareil();
  fs.mkdirSync(cfg.imagesLocales, { recursive: true });
  const ctx = etat.contexte();

  await t.preparer(a.id);
  const rj = await rejoindre(ctx, t, { nom: a.nom, enregistrerPrefixe: () => sauverAppareil() });
  moteur.emettreStats(ctx);
  const imagesEnvoyees = await transfererImages(t, 'envoi');
  const p = await echange.pousser(ctx, t);
  const r = await echange.tirer(ctx, t);
  const imagesRecues = await transfererImages(t, 'reception');

  if (r.appliquees || rj.renumerotees.length || imagesRecues) {
    db.reconstruireVue({ force: true });
    jeu.reinitialiserSac();
  }
  return {
    le: new Date().toISOString(),
    poussees: p.poussees, appliquees: r.appliquees, rejetees: r.rejetees, conflits: r.conflits,
    imagesEnvoyees, imagesRecues,
    prefixe: rj.prefixe, premiereFois: rj.premiereFois, renumerotees: rj.renumerotees
  };
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
    return Promise.resolve({ erreur: 'Dossier de synchro introuvable (clé USB débranchée, lecteur réseau absent ?).' });
  }
  return exclusif(async () => {
    try {
      const bilan = await coeur(creerTransportDossier(racine(a.dossier_synchro)));
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
      const bilan = await coeur(creerTransportDrive(apiTest || drive.api(oauth)));
      db.definirEtatSync('drive_fusion_derniere', JSON.stringify(bilan));
      return bilan;
    };
    if (apiTest) {
      try { return await op(null); } catch (e) { return { erreur: 'Synchro interrompue : ' + e.message }; }
    }
    return drive.avecReconnexion(op, surReconnexion);
  });
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
  configurer, etat: etatSynchro, definirDossier, oublierDossier,
  synchroniser, synchroniserDrive, resoudre, SOUS_DOSSIER
};
