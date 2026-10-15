'use strict';
/**
 * contenu.json du build mobile : liste du CONTENU livre (pack / decks,
 * manifestes, vignettes, images) que l'appli recopie une fois dans ses donnees
 * (src/mobile/contenu.js). Un paquet web mis a jour seul (PLAN-maj-partielle.md)
 * ne le transporte pas : c'est le code qui change, pas le contenu.
 *
 *   ecrire(sortie, racines) -> { id, fichiers: { 'chemin/relatif': octets }, octets }
 *
 * racines : fichiers ou dossiers relatifs a `sortie` (parcourus en entier).
 * id = empreinte de tous les chemins et de tous les octets : il change des que
 * le contenu livre change, meme a taille egale (vignette refaite).
 * Meme fichier dans Tuiles & Toiles et Bristol.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function lister(sortie, rel, out) {
  const p = path.join(sortie, rel);
  if (fs.statSync(p).isDirectory()) {
    for (const f of fs.readdirSync(p).sort()) lister(sortie, rel + '/' + f, out);
  } else {
    out.push(rel);
  }
}

function ecrire(sortie, racines) {
  const chemins = [];
  for (const r of racines) lister(sortie, r, chemins);
  chemins.sort();
  const h = crypto.createHash('sha256');
  const fichiers = {};
  let octets = 0;
  for (const rel of chemins) {
    const contenu = fs.readFileSync(path.join(sortie, rel));
    fichiers[rel] = contenu.length;
    octets += contenu.length;
    h.update(rel).update('\0').update(contenu);
  }
  const r = { id: h.digest('hex').slice(0, 16), fichiers, octets };
  fs.writeFileSync(path.join(sortie, 'contenu.json'), JSON.stringify(r));
  return r;
}

module.exports = { ecrire };
