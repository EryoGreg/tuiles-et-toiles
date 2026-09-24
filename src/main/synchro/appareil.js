'use strict';
/**
 * Identite de cette installation : appareil.json dans le dossier de donnees.
 *
 * Volontairement HORS de utilisateur.db : un import zip ou la restauration
 * d'un snapshot recopie utilisateur.db d'un autre appareil ; si l'id y vivait,
 * deux appareils partageraient la meme identite et s'ignoreraient.
 *
 * L'id est aleatoire, tire au premier lancement — pas un numero de serie
 * materiel (inaccessible sur mobile, et une reinstallation doit etre un
 * nouvel appareil, pas l'ancien amnesique).
 *
 *   id           8 hex, suffixe des HLC, nom du dossier journaux/<id>/ sur Drive
 *   nom          affiche dans l'UI (« PC fixe »), modifiable
 *   prefixe_ref  numero d'affichage des tuiles creees ici : L1, M1…
 *                'L' tant que l'appareil n'a rejoint aucun compte
 *   dossier_synchro  (optionnel) dossier partage choisi dans Options
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FICHIER = 'appareil.json';

function valide(a) {
  return a && /^[0-9a-f]{8}$/.test(a.id) && /^[A-Z]{1,2}$/.test(a.prefixe_ref || '');
}

function ecrireAtomique(chemin, objet) {
  const tmp = chemin + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(objet, null, 2), 'utf8');
  fs.renameSync(tmp, chemin);
}

/**
 * Lit appareil.json, ou le cree au premier lancement.
 * @param {string} dossier dossier de donnees (%APPDATA%\Tuiles et Toiles, data/ en dev)
 * @param {{ nom?: string }} [opts] nom par defaut (hostname)
 */
function charger(dossier, { nom } = {}) {
  const chemin = path.join(dossier, FICHIER);
  try {
    const a = JSON.parse(fs.readFileSync(chemin, 'utf8'));
    if (valide(a)) return a;
  } catch { /* absent ou illisible : nouvel appareil */ }

  const a = {
    id: crypto.randomBytes(4).toString('hex'),
    nom: nom || 'Appareil',
    prefixe_ref: 'L',
    cree_le: new Date().toISOString()
  };
  fs.mkdirSync(dossier, { recursive: true });
  ecrireAtomique(chemin, a);
  return a;
}

/**
 * Reecrit appareil.json (prefixe attribue en rejoignant, dossier de synchro).
 * Reglages propres a l'installation : ne vont pas dans utilisateur.db, qui
 * voyage d'un poste a l'autre par import zip.
 */
function sauver(dossier, a) {
  ecrireAtomique(path.join(dossier, FICHIER), a);
}

module.exports = { charger, sauver };
