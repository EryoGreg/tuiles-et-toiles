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

// Plafonds anti-bombe. Un snapshot ou un segment arrive d'une source partagee
// (dossier, Drive) qu'un tiers peut remplir : un .gz de quelques Ko peut
// annoncer des gigaoctets. Les volumes legitimes sont tres en dessous (5 000
// tuiles ~ quelques Mo), donc ces bornes ne genent jamais un vrai fichier.
const SNAPSHOT_COMPRESSE_MAX = 32 * 1024 * 1024;   // .gz lu depuis le transport
const SNAPSHOT_DECOMPRESSE_MAX = 96 * 1024 * 1024; // JSON une fois decompresse
const SEGMENT_OCTETS_MAX = 64 * 1024 * 1024;       // .ndjson lu depuis le transport
const SEGMENT_OPS_MAX = 500000;                    // lignes (ops) par segment

const encoderSnapshot = (obj) => zlib.gzipSync(Buffer.from(JSON.stringify(obj), 'utf8'));

/**
 * Decompresse un snapshot en bornant la sortie. Une bombe de decompression
 * (petit .gz, enorme contenu) est rejetee sans allouer les gigaoctets :
 *  - taille compressee plafonnee ;
 *  - ISIZE (taille decompressee annoncee dans le trailer gzip) verifiee ;
 *  - sur Node, `maxOutputLength` impose la borne pendant la decompression meme
 *    si le trailer ment ; sur mobile (fflate, sans cette option) la taille
 *    reelle est verifiee apres coup en dernier recours.
 */
function decoderSnapshot(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length > SNAPSHOT_COMPRESSE_MAX) {
    throw new Error('Snapshot trop volumineux (' + b.length + ' octets compresses)');
  }
  if (b.length >= 4) {
    const isize = b.readUInt32LE(b.length - 4);   // taille decompressee mod 2^32
    if (isize > SNAPSHOT_DECOMPRESSE_MAX) {
      throw new Error('Snapshot trop volumineux (' + isize + ' octets annonces)');
    }
  }
  let plat;
  try { plat = zlib.gunzipSync(b, { maxOutputLength: SNAPSHOT_DECOMPRESSE_MAX }); }
  catch (e) {
    // fflate (mobile) ignore maxOutputLength : on decompresse puis on verifie.
    plat = zlib.gunzipSync(b);
    if (plat.length > SNAPSHOT_DECOMPRESSE_MAX) throw new Error('Snapshot trop volumineux (decompresse)');
    if (/maxOutputLength|output length/i.test(e.message)) throw e;
  }
  if (plat.length > SNAPSHOT_DECOMPRESSE_MAX) throw new Error('Snapshot trop volumineux (decompresse)');
  return JSON.parse(plat.toString('utf8'));
}

function ecrireNdjson(ops) {
  return ops.map((o) => JSON.stringify(o)).join('\n') + '\n';
}

function lireNdjson(brut, etiquette) {
  const s = String(brut);
  if (s.length > SEGMENT_OCTETS_MAX) {
    throw new Error(`Segment trop volumineux ${etiquette} (${s.length} octets)`);
  }
  const ops = [];
  for (const [i, ligne] of s.split('\n').entries()) {
    if (!ligne.trim()) continue;
    if (ops.length >= SEGMENT_OPS_MAX) {
      throw new Error(`Segment trop volumineux ${etiquette} (plus de ${SEGMENT_OPS_MAX} ops)`);
    }
    try { ops.push(JSON.parse(ligne)); }
    catch { throw new Error(`Segment illisible ${etiquette} ligne ${i + 1} (copie en cours ?)`); }
  }
  return ops;
}

module.exports = {
  NOM_RACINE, RE_APPAREIL, RE_SEGMENT, RE_FICHE, RE_IMAGE, RE_SNAPSHOT, segment, snapshot,
  encoderSnapshot, decoderSnapshot, ecrireNdjson, lireNdjson,
  SNAPSHOT_COMPRESSE_MAX, SNAPSHOT_DECOMPRESSE_MAX, SEGMENT_OCTETS_MAX, SEGMENT_OPS_MAX
};
