'use strict';
/**
 * Transport « dossier partage » : cle USB, dossier OneDrive / Dropbox /
 * Syncthing, partage reseau. Meme contrat et meme arborescence que le
 * transport Google Drive (voir echange.js et format.js).
 *
 * Chaque appareil n'ecrit que ses propres fichiers. Ecritures atomiques
 * (fichier temporaire puis renommage) : un service de synchro de fichiers ne
 * voit jamais un segment a moitie ecrit. Tout nom hors motif est ignore —
 * notamment les copies de conflit que ces services creent
 * (« x (1).ndjson », « x-PC-conflict.ndjson »).
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const F = require('./format');
const lisezmoi = require('../lisezmoi');

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
  const S = path.join(racine, 'snapshots');

  return {
    racine,

    /** Arborescence + LISEZMOI de chaque dossier. */
    async preparer(idAppareil) {
      lisezmoi.deposer(racine, 'racine');
      lisezmoi.deposer(J, 'journaux');
      lisezmoi.deposer(path.join(J, idAppareil), 'journal_appareil');
      lisezmoi.deposer(A, 'appareils');
      lisezmoi.deposer(I, 'images');
      lisezmoi.deposer(S, 'snapshots');
    },

    async listerAppareils() {
      return (await lister(J)).filter((n) => F.RE_APPAREIL.test(n));
    },

    async listerSegments(app) {
      if (!F.RE_APPAREIL.test(app)) return [];
      return (await lister(path.join(J, app))).map(F.segment).filter(Boolean).sort();
    },

    async lireSegment(app, nom) {
      return F.lireNdjson(await fsp.readFile(path.join(J, app, nom + '.ndjson'), 'utf8'), app + '/' + nom);
    },

    async ecrireSegment(app, nom, ops) {
      const chemin = path.join(J, app, nom + '.ndjson');
      if (await existe(chemin)) return;
      await ecrireAtomique(chemin, F.ecrireNdjson(ops));
    },

    /** Suppression d'un segment de CET appareil (purge, compaction.js). */
    async supprimerSegment(app, nom) {
      try { await fsp.rm(path.join(J, app, nom + '.ndjson'), { force: true }); } catch { /* deja parti */ }
    },

    // --- snapshots ---

    async listerSnapshots() {
      const out = [];
      for (const app of (await lister(S)).filter((n) => F.RE_APPAREIL.test(n))) {
        for (const n of await lister(path.join(S, app))) {
          const nom = F.snapshot(n);
          if (nom) out.push({ appareil: app, nom });
        }
      }
      return out;
    },
    async lireSnapshot(app, nom) {
      return F.decoderSnapshot(await fsp.readFile(path.join(S, app, nom + '.json.gz')));
    },
    async ecrireSnapshot(app, nom, obj) {
      const d = path.join(S, app);
      if (!(await existe(path.join(d, lisezmoi.NOM)))) lisezmoi.deposer(d, 'snapshots_appareil');
      await ecrireAtomique(path.join(d, nom + '.json.gz'), F.encoderSnapshot(obj));
    },
    async supprimerSnapshot(app, nom) {
      try { await fsp.rm(path.join(S, app, nom + '.json.gz'), { force: true }); } catch { /* deja parti */ }
    },

    // --- fiches d'appareil ---

    async lireFiches() {
      const out = [];
      for (const n of await lister(A)) {
        const m = F.RE_FICHE.exec(n);
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

    imageValide(nom) { return F.RE_IMAGE.test(nom); },

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

module.exports = { creerTransportDossier, ecrireAtomique };
