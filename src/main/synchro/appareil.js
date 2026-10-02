'use strict';
/**
 * Identite de cette installation : appareil.json dans le dossier de donnees.
 *
 * Volontairement HORS de utilisateur.db : un import zip ou la restauration
 * d'un snapshot recopie utilisateur.db d'un autre appareil ; si l'id y vivait,
 * deux appareils partageraient la meme identite et s'ignoreraient.
 *
 * L'id est aleatoire, tire au premier lancement — pas un numero de serie
 * materiel (une reinstallation doit etre un nouvel appareil, pas l'ancien
 * amnesique : deux installations vivantes avec le meme id corrompraient la
 * synchro). Le lien avec un appareil precedent passe par le REMPLACEMENT
 * (rejoindre.js) : le nouveau reprend le nom et la lettre de l'ancien.
 *
 *   id           8 hex, suffixe des HLC, nom du dossier journaux/<id>/ sur Drive
 *   nom          nom memorable (« Ananas dansant », noms.js), renommable
 *   nom_perso    true si l'utilisateur l'a choisi (sinon il peut etre repris
 *                d'un appareil remplace)
 *   type         « Windows · POSTE », « Android · Samsung SM-G998B » : recalcule
 *                a chaque lancement, publie dans la fiche
 *   materiel     empreinte de la machine (Windows : MachineGuid + utilisateur ;
 *                Android : ANDROID_ID). Sert a deux choses : reconnaitre le meme
 *                appareil reinstalle (remplacement automatique) et detecter
 *                une identite RECOPIEE sur une autre machine (sauvegarde
 *                restauree, dossier copie) -> nouvelle identite.
 *   prefixe_ref  numero d'affichage des tuiles creees ici : L1, M1…
 *                'L' tant que l'appareil n'a rejoint aucun compte
 *   inscrit      a deja rejoint un espace de synchro (fiche publiee)
 *   remplace     id de l'appareil que celui-ci remplace, ou 'aucun' (decision
 *                prise avant la premiere synchro), absent = pas encore decide
 *   copie_de     id d'une identite recopiee depuis une autre machine (proposee
 *                comme remplacement)
 *   dossier_synchro  (optionnel) dossier partage choisi dans Options
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { nomPour } = require('./noms');

const FICHIER = 'appareil.json';
let crochet = null;   // apres chaque enregistrement (mobile : copie de secours)

// Noms automatiques d'avant les noms memorables (nom du poste ou du type
// d'appareil) : remplaces une fois par un nom memorable.
const ANCIENS_NOMS = new Set(['Téléphone', 'Telephone', 'Appareil', 'Navigateur']);

function valide(a) {
  return a && /^[0-9a-f]{8}$/.test(a.id) && /^[A-Z]{1,2}$/.test(a.prefixe_ref || '');
}

function ecrireAtomique(chemin, objet) {
  const tmp = chemin + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(objet, null, 2), 'utf8');
  fs.renameSync(tmp, chemin);
  if (crochet) { try { crochet(objet); } catch { /* la copie ne doit jamais bloquer */ } }
}

/** fn(identite) apres chaque enregistrement de appareil.json. */
function apresEnregistrement(fn) { crochet = fn; }

function nouvelle(opts, extra = {}) {
  const id = crypto.randomBytes(4).toString('hex');
  return {
    id,
    nom: nomPour(id),
    nom_memorable: true,
    prefixe_ref: 'L',
    cree_le: new Date().toISOString(),
    ...(opts.type ? { type: opts.type } : {}),
    ...(opts.materiel ? { materiel: opts.materiel } : {}),
    ...extra
  };
}

/**
 * Lit appareil.json, ou le cree au premier lancement.
 * @param {string} dossier dossier de donnees (%APPDATA%\Tuiles et Toiles, data/ en dev)
 * @param {{ nom?: string, type?: string, materiel?: string|null, journal?: object }} [opts]
 *   nom : nom du poste (hostname) — seulement pour reconnaitre un ancien nom
 *   automatique ; type et materiel : voir l'en-tete.
 * @returns {object} l'identite ; `evenement` (non enregistre) dit ce qui s'est passe :
 *   'cree' | 'migre' | 'copie' | undefined
 */
function charger(dossier, opts = {}) {
  const chemin = path.join(dossier, FICHIER);
  let a = null;
  try {
    a = JSON.parse(fs.readFileSync(chemin, 'utf8'));
    if (!valide(a)) a = null;
  } catch { a = null; }   // absent ou illisible : nouvel appareil

  fs.mkdirSync(dossier, { recursive: true });
  if (!a) {
    a = nouvelle(opts);
    ecrireAtomique(chemin, a);
    return { ...a, evenement: 'cree' };
  }

  // Identite recopiee depuis une autre machine : la garder ferait deux
  // appareils vivants sous le meme id. Nouvelle identite, l'ancienne est
  // proposee comme remplacement a la premiere synchro.
  if (a.materiel && opts.materiel && a.materiel !== opts.materiel) {
    const n = nouvelle(opts, { copie_de: a.id, ...(a.dossier_synchro ? { dossier_synchro: a.dossier_synchro } : {}) });
    ecrireAtomique(chemin, n);
    return { ...n, evenement: 'copie', ancien: { id: a.id, nom: a.nom, prefixe: a.prefixe_ref } };
  }

  let evenement;
  const avant = JSON.stringify(a);
  // Ancien nom automatique (nom du poste, « Telephone ») -> nom memorable.
  if (!a.nom_perso && !a.nom_memorable && (!a.nom || ANCIENS_NOMS.has(a.nom) || a.nom === opts.nom)) {
    a.nom = nomPour(a.id);
    evenement = 'migre';
  }
  a.nom_memorable = true;
  if (opts.type) a.type = opts.type;
  if (opts.materiel && !a.materiel) a.materiel = opts.materiel;
  if (JSON.stringify(a) !== avant) ecrireAtomique(chemin, a);
  return evenement ? { ...a, evenement } : a;
}

/**
 * Reecrit appareil.json (prefixe attribue en rejoignant, nom, decision de
 * remplacement, dossier de synchro). Reglages propres a l'installation : ne
 * vont pas dans utilisateur.db, qui voyage d'un poste a l'autre par import zip.
 */
function sauver(dossier, a) {
  const { evenement, ancien, ...propre } = a;   // champs de compte rendu, jamais enregistres
  ecrireAtomique(path.join(dossier, FICHIER), propre);
}

/** Empreinte stable et courte d'un identifiant materiel (jamais publie en clair). */
function empreinte(...parts) {
  const brut = parts.filter(Boolean).join('|');
  return brut ? crypto.createHash('sha256').update('tuiles-et-toiles|' + brut).digest('hex').slice(0, 16) : null;
}

module.exports = { charger, sauver, empreinte, apresEnregistrement, ANCIENS_NOMS };
