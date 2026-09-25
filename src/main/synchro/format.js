'use strict';
/**
 * Format des fichiers de synchro, commun a tous les transports (dossier
 * partage, Google Drive) : memes noms, meme arborescence, meme contenu.
 *
 *   Tuiles et Toiles/
 *     journaux/<id>/<hlc1>_<hlc2>.ndjson   segments immuables, une op par ligne
 *     appareils/<id>.json                   fiche d'appareil
 *     images/<uuid>.jpg|png                 images des tuiles locales
 *     snapshots/<id>/<hlc>.json.gz          etat compacte (compaction.js)
 *
 * Tout nom hors motif est ignore (LISEZMOI.txt, copies de conflit des
 * services de synchro, fichiers temporaires).
 */

const NOM_RACINE = 'Tuiles et Toiles';   // sans « & » : nom de dossier Drive / Windows
const RE_APPAREIL = /^[0-9a-f]{8}$/;
const RE_SEGMENT = /^(\d{16}-\d{4}-[0-9a-z]+_\d{16}-\d{4}-[0-9a-z]+)\.ndjson$/;
const RE_FICHE = /^([0-9a-f]{8})\.json$/;
// Noms produits par images.importer (uuid.ext) : rien d'autre ne transite.
const RE_IMAGE = /^[0-9a-f-]{36}\.(jpg|png)$/;
const RE_SNAPSHOT = /^(\d{16}-\d{4}-[0-9a-z]+)\.json\.gz$/;

/** Nom de segment (sans extension) si `fichier` en est un, sinon null. */
function segment(fichier) {
  const m = RE_SEGMENT.exec(fichier);
  return m ? m[1] : null;
}

/** Nom de snapshot (sans extension) si `fichier` en est un, sinon null. */
function snapshot(fichier) {
  const m = RE_SNAPSHOT.exec(fichier);
  return m ? m[1] : null;
}

const zlib = require('zlib');
const encoderSnapshot = (obj) => zlib.gzipSync(Buffer.from(JSON.stringify(obj), 'utf8'));
const decoderSnapshot = (buf) => JSON.parse(zlib.gunzipSync(buf).toString('utf8'));

function ecrireNdjson(ops) {
  return ops.map((o) => JSON.stringify(o)).join('\n') + '\n';
}

function lireNdjson(brut, etiquette) {
  const ops = [];
  for (const [i, ligne] of String(brut).split('\n').entries()) {
    if (!ligne.trim()) continue;
    try { ops.push(JSON.parse(ligne)); }
    catch { throw new Error(`Segment illisible ${etiquette} ligne ${i + 1} (copie en cours ?)`); }
  }
  return ops;
}

module.exports = {
  NOM_RACINE, RE_APPAREIL, RE_SEGMENT, RE_FICHE, RE_IMAGE, RE_SNAPSHOT, segment, snapshot,
  encoderSnapshot, decoderSnapshot, ecrireNdjson, lireNdjson
};
