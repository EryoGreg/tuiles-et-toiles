'use strict';
/**
 * Remplacant mobile de src/main/images.js : meme contrat
 * (importer(source, dossierCible, contexte) -> { nom, largeur, hauteur,
 * octets, redimensionnee } | { erreur }), mais decodage et compression par le
 * navigateur (createImageBitmap + canvas) : Jimp serait bien trop lent sur un
 * telephone pour une photo de 12 Mpx.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Buffer } = require('buffer');
const journal = require('../main/journal');

const COTE_MAX = 1400;
const POIDS_MAX = 500 * 1024;

function blobVersBuffer(blob) { return blob.arrayBuffer().then((a) => Buffer.from(a)); }

function encoder(canvas, type, qualite) {
  return new Promise((ok) => canvas.toBlob((b) => ok(b), type, qualite));
}

async function importer(source, dossierCible, contexte = {}) {
  const t0 = Date.now();
  let brut;
  try { brut = typeof source === 'string' ? fs.readFileSync(source) : Buffer.from(source); }
  catch (e) { return { erreur: 'Fichier illisible : ' + e.message }; }
  journal.evt('image', 'import:debut', { ...contexte, octets: brut.length });

  let bmp;
  try { bmp = await createImageBitmap(new Blob([brut])); }
  catch (e) {
    journal.erreur('image', 'decodage', e, contexte);
    return { erreur: 'Format d’image non pris en charge. Essaie en JPEG ou PNG.' };
  }
  const cote0 = Math.max(bmp.width, bmp.height);
  let echelle = Math.min(1, COTE_MAX / cote0);
  const canvas = document.createElement('canvas');
  const dessiner = () => {
    canvas.width = Math.max(1, Math.round(bmp.width * echelle));
    canvas.height = Math.max(1, Math.round(bmp.height * echelle));
    const c = canvas.getContext('2d');
    c.fillStyle = '#ffffff';   // fond blanc (pas de transparence en JPEG)
    c.fillRect(0, 0, canvas.width, canvas.height);
    c.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  };
  dessiner();
  let q = 0.85;
  let blob = await encoder(canvas, 'image/jpeg', q);
  while (blob.size > POIDS_MAX && q > 0.45) { q -= 0.08; blob = await encoder(canvas, 'image/jpeg', q); }
  while (blob.size > POIDS_MAX && Math.max(canvas.width, canvas.height) > 500) {
    echelle *= 0.85; dessiner(); blob = await encoder(canvas, 'image/jpeg', q);
  }
  const buf = await blobVersBuffer(blob);
  const nom = crypto.randomUUID() + '.jpg';
  fs.mkdirSync(dossierCible, { recursive: true });
  fs.writeFileSync(path.join(dossierCible, nom), buf);
  const out = {
    nom, largeur: canvas.width, hauteur: canvas.height, octets: buf.length,
    redimensionnee: Math.max(canvas.width, canvas.height) < cote0
  };
  journal.evt('image', 'import:fin', { ...out, octetsAvant: brut.length, ms: Date.now() - t0 });
  return out;
}

module.exports = { importer, POIDS_MAX, COTE_MAX };
