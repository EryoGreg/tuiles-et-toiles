'use strict';
/**
 * Dossier des donnees sur PC : %APPDATA%\tuiles-et-toiles (fixe par lanceur.js
 * depuis le 09/11/2026 ; c'etait deja, sans le vouloir, celui de toutes les
 * installations depuis la 0.3.20). Une installation restee en 0.3.19 ou avant
 * a ses donnees dans l'ancien « Tuiles et Toiles » : si le nouveau dossier n'a
 * pas encore de base, on y recopie l'ancien. Jamais l'inverse, jamais
 * d'ecrasement, l'ancien dossier reste intact.
 */
const fs = require('fs');
const path = require('path');

const NOM = 'tuiles-et-toiles';
const ANCIEN_NOM = 'Tuiles et Toiles';
const FICHIERS = ['appareil.json', 'drive-jeton.bin', 'ia-cle.bin', 'pack.db', 'utilisateur.db'];
const DOSSIERS = ['images-locales', 'images-cache'];

/**
 * @param {string} ancien   ancien dossier de donnees
 * @param {string} nouveau  dossier utilise
 * @returns {null | { ancien, copies: string[] }}  null : rien a reprendre
 */
function reprendre(ancien, nouveau) {
  if (!ancien || !nouveau) return null;
  if (path.resolve(ancien).toLowerCase() === path.resolve(nouveau).toLowerCase()) return null;
  if (fs.existsSync(path.join(nouveau, 'utilisateur.db'))) return null;
  if (!fs.existsSync(path.join(ancien, 'utilisateur.db'))) return null;
  const copies = [];
  fs.mkdirSync(nouveau, { recursive: true });
  // La base en dernier : tant qu'elle n'est pas la, une reprise interrompue recommence.
  for (const nom of FICHIERS) {
    const src = path.join(ancien, nom);
    const cible = path.join(nouveau, nom);
    if (!fs.existsSync(src) || fs.existsSync(cible)) continue;
    if (nom === 'utilisateur.db') {
      fs.copyFileSync(src, cible + '.reprise');
      fs.renameSync(cible + '.reprise', cible);
    } else fs.copyFileSync(src, cible);
    copies.push(nom);
  }
  for (const sous of DOSSIERS) {
    const src = path.join(ancien, sous);
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) continue;
    fs.cpSync(src, path.join(nouveau, sous), { recursive: true, force: false, errorOnExist: false });
    copies.push(sous + '/');
  }
  return { ancien, copies };
}

module.exports = { NOM, ANCIEN_NOM, reprendre };
