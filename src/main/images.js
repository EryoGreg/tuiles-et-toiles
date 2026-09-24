'use strict';
/**
 * Import d'une image pour une tuile locale.
 *
 * - reduit le cote max a 1400 px (comme le corpus)
 * - vise <= 500 Ko : JPEG q85 -> q descend jusqu'a 45, puis dimensions -15 %
 *   par palier ; PNG garde seulement si l'image a de VRAIS pixels transparents
 * - ecrit dans images-locales/ sous un nom UUID, renvoie nom + dimensions + poids
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Jimp = require('jimp');
const journal = require('./journal');

const COTE_MAX = 1400;
const POIDS_MAX = 500 * 1024;

function aVraieTransparence(img) {
  if (!img.hasAlpha()) return false;
  let transparent = false;
  img.scan(0, 0, img.bitmap.width, img.bitmap.height, function scan(x, y, idx) {
    if (this.bitmap.data[idx + 3] < 250) transparent = true;
  });
  return transparent;
}

function cote(img) { return Math.max(img.bitmap.width, img.bitmap.height); }

// Type reel d'apres les premiers octets (un .jpg peut etre un HEIC, un WebP…).
function signature(buf) {
  const h = buf.subarray(0, 12);
  const hex = h.toString('hex');
  if (hex.startsWith('ffd8ff')) return 'jpeg';
  if (hex.startsWith('89504e47')) return 'png';
  if (hex.startsWith('47494638')) return 'gif';
  if (hex.startsWith('424d')) return 'bmp';
  if (hex.startsWith('49492a00') || hex.startsWith('4d4d002a')) return 'tiff';
  if (h.toString('ascii', 0, 4) === 'RIFF' && h.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (h.toString('ascii', 4, 8) === 'ftyp') return 'iso-bmff (heic/avif ?) ' + h.toString('ascii', 8, 12);
  if (/^\s*</.test(buf.subarray(0, 64).toString('utf8'))) return 'texte/html (pas une image)';
  return 'inconnu ' + hex;
}

/**
 * @param {string|Buffer} source  chemin de fichier ou octets bruts
 * @param {string} dossierCible   images-locales/
 * @param {object} [contexte]     origine (selecteur, depot, url…) + nom/type
 *   d'origine, pour le journal
 * @returns {Promise<{nom, largeur, hauteur, octets, redimensionnee}|{erreur}>}
 */
async function importer(source, dossierCible, contexte = {}) {
  const t0 = Date.now();
  const chemin = typeof source === 'string' ? source : null;
  let brut;
  try {
    brut = chemin ? fs.readFileSync(chemin) : source;
  } catch (e) {
    journal.erreur('image', 'lecture-fichier', e, { ...contexte, chemin, cheminTexte: journal.decrireTexte(chemin) });
    return { erreur: 'Fichier illisible : ' + e.message };
  }
  const entree = {
    ...contexte, chemin, cheminTexte: chemin ? journal.decrireTexte(chemin) : undefined,
    nomTexte: contexte.nom ? journal.decrireTexte(contexte.nom) : undefined,
    octets: brut.length, signature: signature(brut)
  };
  journal.evt('image', 'import:debut', entree);

  let img;
  try {
    img = await Jimp.read(brut);
  } catch (e) {
    journal.erreur('image', 'decodage', e, entree);
    return { erreur: 'Format d’image non pris en charge (' + entree.signature + '). Essaie en JPEG ou PNG.' };
  }
  const cote0 = cote(img);
  const dims0 = img.bitmap.width + 'x' + img.bitmap.height;

  if (cote0 > COTE_MAX) {
    if (img.bitmap.width >= img.bitmap.height) img.resize(COTE_MAX, Jimp.AUTO);
    else img.resize(Jimp.AUTO, COTE_MAX);
  }

  let buf;
  let ext;

  if (aVraieTransparence(img)) {
    ext = 'png';
    buf = await img.getBufferAsync(Jimp.MIME_PNG);
    while (buf.length > POIDS_MAX && cote(img) > 500) {
      img.scaleToFit(Math.round(cote(img) * 0.85), Math.round(cote(img) * 0.85));
      buf = await img.getBufferAsync(Jimp.MIME_PNG);
    }
  } else {
    ext = 'jpg';
    let q = 85;
    img.quality(q).background(0xffffffff);   // fond blanc si l'alpha etait opaque
    buf = await img.getBufferAsync(Jimp.MIME_JPEG);
    while (buf.length > POIDS_MAX && q > 45) {
      q -= 8;
      img.quality(q);
      buf = await img.getBufferAsync(Jimp.MIME_JPEG);
    }
    while (buf.length > POIDS_MAX && cote(img) > 500) {
      img.scaleToFit(Math.round(cote(img) * 0.85), Math.round(cote(img) * 0.85)).quality(q);
      buf = await img.getBufferAsync(Jimp.MIME_JPEG);
    }
  }

  const nom = crypto.randomUUID() + '.' + ext;
  try {
    fs.mkdirSync(dossierCible, { recursive: true });
    fs.writeFileSync(path.join(dossierCible, nom), buf);
  } catch (e) {
    journal.erreur('image', 'ecriture', e, { ...entree, dossierCible, nom });
    return { erreur: 'Impossible d’enregistrer l’image : ' + e.message };
  }

  const out = {
    nom,
    largeur: img.bitmap.width,
    hauteur: img.bitmap.height,
    octets: buf.length,
    redimensionnee: cote0 > COTE_MAX || cote(img) < cote0
  };
  journal.evt('image', 'import:fin', {
    origine: contexte.origine, nom, format: ext, avant: dims0, apres: out.largeur + 'x' + out.hauteur,
    octetsAvant: brut.length, octetsApres: buf.length, redimensionnee: out.redimensionnee,
    transparence: ext === 'png', ms: Date.now() - t0,
    ...(buf.length > POIDS_MAX ? { auDessusDuPlafond: true } : {})
  }, buf.length > POIDS_MAX ? 'WARN' : 'INFO');
  return out;
}

module.exports = { importer, POIDS_MAX, COTE_MAX };
