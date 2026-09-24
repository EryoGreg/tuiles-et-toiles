'use strict';
/**
 * Transport « dossier partage » : cle USB, dossier OneDrive / Dropbox /
 * Syncthing, partage reseau. Meme contrat que les autres transports (voir
 * echange.js), plus les fiches d'appareil et les images.
 *
 *   <racine>/
 *     appareils/<id>.json               fiche : nom, prefixe_ref, vu_le
 *     journaux/<id>/<hlc1>_<hlc2>.ndjson segments immuables, une op par ligne
 *     images/<nom>                       images des tuiles locales (noms UUID)
 *
 * Chaque appareil n'ecrit que ses propres fichiers. Ecritures atomiques
 * (fichier temporaire puis renommage) : un service de synchro de fichiers ne
 * voit jamais un segment a moitie ecrit. Tout nom qui ne suit pas le motif
 * attendu est ignore — notamment les copies de conflit que ces services
 * creent (« x (1).ndjson », « x-PC-conflict.ndjson »).
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const RE_APPAREIL = /^[0-9a-f]{8}$/;
const RE_SEGMENT = /^(\d{16}-\d{4}-[0-9a-z]+_\d{16}-\d{4}-[0-9a-z]+)\.ndjson$/;
const RE_FICHE = /^([0-9a-f]{8})\.json$/;
// Noms produits par images.importer (uuid.ext) : rien d'autre ne transite.
const RE_IMAGE = /^[0-9a-f-]{36}\.(jpg|png)$/;

async function ecrireAtomique(chemin, contenu) {
  await fsp.mkdir(path.dirname(chemin), { recursive: true });
  const tmp = chemin + '.' + process.pid + '.tmp';
  await fsp.writeFile(tmp, contenu);
  await fsp.rename(tmp, chemin);
}

async function lister(dossier) {
  try { return await fsp.readdir(dossier); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

async function existe(chemin) {
  try { await fsp.access(chemin); return true; } catch { return false; }
}

function creerTransportDossier(racine) {
  const J = path.join(racine, 'journaux');
  const A = path.join(racine, 'appareils');
  const I = path.join(racine, 'images');

  return {
    racine,

    async listerAppareils() {
      return (await lister(J)).filter((n) => RE_APPAREIL.test(n));
    },

    async listerSegments(app) {
      if (!RE_APPAREIL.test(app)) return [];
      return (await lister(path.join(J, app)))
        .map((n) => RE_SEGMENT.exec(n)).filter(Boolean).map((m) => m[1]).sort();
    },

    async lireSegment(app, nom) {
      const brut = await fsp.readFile(path.join(J, app, nom + '.ndjson'), 'utf8');
      const ops = [];
      for (const [i, ligne] of brut.split('\n').entries()) {
        if (!ligne.trim()) continue;
        try { ops.push(JSON.parse(ligne)); }
        catch { throw new Error(`Segment illisible ${app}/${nom} ligne ${i + 1} (copie en cours ?)`); }
      }
      return ops;
    },

    async ecrireSegment(app, nom, ops) {
      const chemin = path.join(J, app, nom + '.ndjson');
      if (await existe(chemin)) return;
      await ecrireAtomique(chemin, ops.map((o) => JSON.stringify(o)).join('\n') + '\n');
    },

    // --- fiches d'appareil ---

    async lireFiches() {
      const out = [];
      for (const n of await lister(A)) {
        const m = RE_FICHE.exec(n);
        if (!m) continue;
        try {
          const f = JSON.parse(await fsp.readFile(path.join(A, n), 'utf8'));
          if (f && f.id === m[1]) out.push(f);
        } catch { /* fiche en cours de copie : relue au prochain passage */ }
      }
      return out;
    },

    async ecrireFiche(fiche) {
      await ecrireAtomique(path.join(A, fiche.id + '.json'), JSON.stringify(fiche, null, 2));
    },

    // --- images ---

    imageValide(nom) { return RE_IMAGE.test(nom); },

    async aImage(nom) { return existe(path.join(I, nom)); },

    async envoyerImage(nom, source) {
      const cible = path.join(I, nom);
      if (await existe(cible)) return false;
      await ecrireAtomique(cible, await fsp.readFile(source));
      return true;
    },

    /** Copie l'image vers `cible` si le dossier l'a. @returns {boolean} copiee */
    async recupererImage(nom, cible) {
      const source = path.join(I, nom);
      if (!(await existe(source))) return false;
      await ecrireAtomique(cible, await fsp.readFile(source));
      return true;
    }
  };
}

module.exports = { creerTransportDossier };
