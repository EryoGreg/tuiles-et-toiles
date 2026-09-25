'use strict';
/**
 * Transport Google Drive : meme contrat et meme arborescence que le transport
 * dossier (format.js), dans le dossier « Tuiles et Toiles » que la sauvegarde
 * Drive (E1) a deja cree — utilisateur.zip et historique/ y restent.
 *
 * S'appuie sur une petite interface `api` (drive.js en REST, un faux Drive en
 * memoire pour les tests) :
 *   lister(parent, { nom?, dossier? }) -> [{ id, name, dossier, createdTime }]
 *   creerDossier(nom, parent)          -> id
 *   creerFichier(nom, parent, octets, mime) -> id
 *   majFichier(id, octets, mime)
 *   lire(id)                           -> Buffer
 *   supprimer(id)                      (purge : uniquement nos propres fichiers)
 *
 * Particularite Drive : deux dossiers peuvent porter le meme nom. Si deux
 * appareils creent « journaux » au meme instant, il y en a deux. Parade : on
 * LIT l'union de tous les homonymes et on ECRIT dans le plus ancien — le
 * resultat ne depend pas de qui a gagne la course.
 *
 * Scope drive.file : l'app ne voit que les fichiers crees par l'app (toutes
 * installations et plateformes du meme projet Google Cloud confondues). Des
 * fichiers deposes a la main ou par Google Drive pour ordinateur ne sont pas
 * visibles — c'est voulu.
 */

const fs = require('fs');
const path = require('path');
const F = require('./format');
const lisezmoi = require('../lisezmoi');
const { ecrireAtomique } = require('./transport-dossier');

const MIME_NDJSON = 'application/x-ndjson';
const MIME_JSON = 'application/json';
const MIME_TXT = 'text/plain; charset=UTF-8';
const MIME_GZ = 'application/gzip';
const mimeImage = (nom) => (nom.endsWith('.png') ? 'image/png' : 'image/jpeg');

// LISEZMOI deja verifies pendant cette session de l'app. Cle : api.memoCle
// (stable d'une synchro a l'autre pour le vrai Drive, dont les ids sont
// uniques), sinon l'objet api lui-meme (faux Drive des tests).
const lisezmoiVus = new Map();

const plusAncien = (a, b) => (a.createdTime < b.createdTime ? -1 : a.createdTime > b.createdTime ? 1
  : (a.id < b.id ? -1 : 1));

function creerTransportDrive(api, { nomRacine = F.NOM_RACINE } = {}) {
  // Memo de session : ids de dossiers, listings de segments et d'images.
  const memo = new Map();
  const segments = new Map();   // app -> Map(nom -> id)
  let images = null;            // Map(nom -> id)

  /** Tous les dossiers `nom` sous `parent` (plus ancien d'abord) ; cree si aucun. */
  async function dossiers(nom, parent, creer = true) {
    const cle = parent + '/' + nom;
    if (memo.has(cle)) return memo.get(cle);
    let l = (await api.lister(parent, { nom, dossier: true })).sort(plusAncien).map((d) => d.id);
    if (!l.length && creer) l = [await api.creerDossier(nom, parent)];
    if (l.length) memo.set(cle, l);
    return l;
  }

  const racine = async () => (await dossiers(nomRacine, 'root'))[0];
  const sous = async (nom) => dossiers(nom, await racine());

  /** Fichiers (non dossiers) de plusieurs dossiers, union. */
  async function fichiers(parents) {
    const out = [];
    for (const p of parents) out.push(...(await api.lister(p, { dossier: false })));
    return out;
  }

  async function dossiersAppareil(app, creer = false) {
    const out = [];
    for (const j of await sous('journaux')) out.push(...(await dossiers(app, j, false)));
    if (!out.length && creer) {
      const id = await api.creerDossier(app, (await sous('journaux'))[0]);
      memo.set((await sous('journaux'))[0] + '/' + app, [id]);
      out.push(id);
    }
    return out;
  }

  async function deposerLisezmoi(parent, cle) {
    const cleApi = api.memoCle || api;
    if (!lisezmoiVus.has(cleApi)) lisezmoiVus.set(cleApi, new Set());
    const vus = lisezmoiVus.get(cleApi);
    if (vus.has(parent + '/' + cle)) return;
    const t = Buffer.from(lisezmoi.texte(cle), 'utf8');
    const l = await api.lister(parent, { nom: lisezmoi.NOM, dossier: false });
    if (!l.length) await api.creerFichier(lisezmoi.NOM, parent, t, MIME_TXT);
    else if (!(await api.lire(l[0].id)).equals(t)) await api.majFichier(l[0].id, t, MIME_TXT);
    vus.add(parent + '/' + cle);
  }

  async function listeImages() {
    if (images) return images;
    images = new Map();
    for (const f of await fichiers(await sous('images'))) {
      if (F.RE_IMAGE.test(f.name) && !images.has(f.name)) images.set(f.name, f.id);
    }
    return images;
  }

  return {
    /** Arborescence + LISEZMOI de chaque dossier (une fois par session). */
    async preparer(idAppareil) {
      const r = await racine();
      await deposerLisezmoi(r, 'racine');
      await deposerLisezmoi((await sous('journaux'))[0], 'journaux');
      await deposerLisezmoi((await dossiersAppareil(idAppareil, true))[0], 'journal_appareil');
      await deposerLisezmoi((await sous('appareils'))[0], 'appareils');
      await deposerLisezmoi((await sous('images'))[0], 'images');
      await deposerLisezmoi((await sous('snapshots'))[0], 'snapshots');
    },

    async listerAppareils() {
      const noms = new Set();
      for (const j of await sous('journaux')) {
        for (const d of await api.lister(j, { dossier: true })) if (F.RE_APPAREIL.test(d.name)) noms.add(d.name);
      }
      return [...noms];
    },

    async listerSegments(app) {
      if (!F.RE_APPAREIL.test(app)) return [];
      const m = new Map();
      for (const f of await fichiers(await dossiersAppareil(app))) {
        const nom = F.segment(f.name);
        if (nom && !m.has(nom)) m.set(nom, f.id);
      }
      segments.set(app, m);
      return [...m.keys()].sort();
    },

    async lireSegment(app, nom) {
      if (!segments.has(app) || !segments.get(app).has(nom)) await this.listerSegments(app);
      const id = segments.get(app).get(nom);
      if (!id) throw new Error('Segment introuvable ' + app + '/' + nom);
      return F.lireNdjson((await api.lire(id)).toString('utf8'), app + '/' + nom);
    },

    async ecrireSegment(app, nom, ops) {
      const dossier = (await dossiersAppareil(app, true))[0];
      const deja = await api.lister(dossier, { nom: nom + '.ndjson', dossier: false });
      if (deja.length) return;
      await api.creerFichier(nom + '.ndjson', dossier, Buffer.from(F.ecrireNdjson(ops), 'utf8'), MIME_NDJSON);
    },

    async supprimerSegment(app, nom) {
      for (const d of await dossiersAppareil(app)) {
        for (const f of await api.lister(d, { nom: nom + '.ndjson', dossier: false })) await api.supprimer(f.id);
      }
      if (segments.has(app)) segments.get(app).delete(nom);
    },

    // --- snapshots ---

    async listerSnapshots() {
      const out = [];
      const vus = new Set();
      for (const s of await sous('snapshots')) {
        for (const d of await api.lister(s, { dossier: true })) {
          if (!F.RE_APPAREIL.test(d.name)) continue;
          for (const f of await api.lister(d.id, { dossier: false })) {
            const nom = F.snapshot(f.name);
            if (nom && !vus.has(d.name + '/' + nom)) { vus.add(d.name + '/' + nom); out.push({ appareil: d.name, nom, id: f.id }); }
          }
        }
      }
      return out;
    },
    async lireSnapshot(app, nom) {
      const s = (await this.listerSnapshots()).find((x) => x.appareil === app && x.nom === nom);
      if (!s) throw new Error('Snapshot introuvable ' + app + '/' + nom);
      return F.decoderSnapshot(await api.lire(s.id));
    },
    async ecrireSnapshot(app, nom, obj) {
      const racineS = (await sous('snapshots'))[0];
      let d = (await dossiers(app, racineS, false))[0];
      if (!d) {
        d = await api.creerDossier(app, racineS);
        memo.set(racineS + '/' + app, [d]);
        await deposerLisezmoi(d, 'snapshots_appareil');
      }
      await api.creerFichier(nom + '.json.gz', d, F.encoderSnapshot(obj), MIME_GZ);
    },
    async supprimerSnapshot(app, nom) {
      for (const s of (await this.listerSnapshots()).filter((x) => x.appareil === app && x.nom === nom)) {
        await api.supprimer(s.id);
      }
    },

    // --- fiches d'appareil ---

    async lireFiches() {
      const out = [];
      const vus = new Set();
      for (const f of await fichiers(await sous('appareils'))) {
        const m = F.RE_FICHE.exec(f.name);
        if (!m || vus.has(m[1])) continue;
        try {
          const fiche = JSON.parse((await api.lire(f.id)).toString('utf8'));
          if (fiche && fiche.id === m[1]) { out.push(fiche); vus.add(m[1]); }
        } catch { /* fiche illisible : ignoree */ }
      }
      return out;
    },

    async ecrireFiche(fiche) {
      const octets = Buffer.from(JSON.stringify(fiche, null, 2), 'utf8');
      const nom = fiche.id + '.json';
      const dossiersA = await sous('appareils');
      for (const d of dossiersA) {
        const l = await api.lister(d, { nom, dossier: false });
        if (l.length) { await api.majFichier(l[0].id, octets, MIME_JSON); return; }
      }
      await api.creerFichier(nom, dossiersA[0], octets, MIME_JSON);
    },

    // --- images ---

    imageValide(nom) { return F.RE_IMAGE.test(nom); },

    async envoyerImage(nom, source) {
      const l = await listeImages();
      if (l.has(nom)) return false;
      const id = await api.creerFichier(nom, (await sous('images'))[0], fs.readFileSync(source), mimeImage(nom));
      l.set(nom, id);
      return true;
    },

    async recupererImage(nom, cible) {
      const id = (await listeImages()).get(nom);
      if (!id) return false;
      await ecrireAtomique(cible, await api.lire(id));
      return true;
    }
  };
}

module.exports = { creerTransportDrive };
