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
 *
 * Vitesse (0.3.11 : une synchro a vide passait 10 s en ~20 allers-retours
 * successifs) : les ids de dossiers et le contenu des fiches d'appareils sont
 * GARDES d'une synchro a l'autre (cache par compte, `cleCache`, 24 h ; vide par
 * oublierDossiers() apres une erreur ou un changement de dossier vu dans le fil
 * des changements), une fiche n'est relue que si sa date de modification a
 * change, et les lectures independantes partent en parallele. `ecrits` = ids
 * des fichiers ecrits par cette synchro (service.js : distinguer ses propres
 * ecritures de celles des autres appareils dans le fil des changements).
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


// Caches d'une synchro a l'autre, par compte Drive (cleCache).
const caches = new Map();
const DUREE_CACHE_DOSSIERS = 24 * 3600e3;

function cacheDe(cle) {
  let c = caches.get(cle);
  if (!c || Date.now() - c.le > DUREE_CACHE_DOSSIERS) {
    // lisezmoi : dossiers dont le LISEZMOI a deja ete verifie (une fois par session)
    c = { le: Date.now(), dossiers: new Map(), fiches: new Map(), fichesIds: new Map(), lisezmoi: new Set() };
    caches.set(cle, c);
  }
  return c;
}

const plusAncien = (a, b) => (a.createdTime < b.createdTime ? -1 : a.createdTime > b.createdTime ? 1
  : (a.id < b.id ? -1 : 1));

function creerTransportDrive(apiBrute, { nomRacine = F.NOM_RACINE, cleCache } = {}) {
  // Par compte : cle donnee par service.js (email du compte) ; sinon propre a cet objet api.
  const cache = cacheDe(cleCache || apiBrute);
  const memo = cache.dossiers;          // ids de dossiers (gardes d'une synchro a l'autre)
  const segments = new Map();           // app -> Map(nom -> id) (cette synchro)
  let images = null;                    // Map(nom -> id) (cette synchro)
  const ecrits = new Set();             // ids ecrits par cette synchro
  // Toute ecriture passe par ici : on sait ce qui vient de nous.
  const api = {
    ...apiBrute,
    lister: (...a) => apiBrute.lister(...a),
    lire: (...a) => apiBrute.lire(...a),
    async creerDossier(...a) { const id = await apiBrute.creerDossier(...a); ecrits.add(id); return id; },
    async creerFichier(...a) { const id = await apiBrute.creerFichier(...a); ecrits.add(id); return id; },
    async majFichier(id, ...a) { await apiBrute.majFichier(id, ...a); ecrits.add(id); },
    async supprimer(id) { await apiBrute.supprimer(id); ecrits.add(id); }
  };

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

  /** Fichiers (non dossiers) de plusieurs dossiers, union (listes en parallele). */
  async function fichiers(parents) {
    return (await Promise.all(parents.map((p) => api.lister(p, { dossier: false })))).flat();
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
    const vus = cache.lisezmoi;
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
    /** Ids des fichiers ecrits par cette synchro. */
    ecrits,
    /** Oublie les ids de dossiers et de fiches gardes (erreur, dossier change ailleurs). */
    oublierDossiers() { memo.clear(); cache.fichesIds.clear(); cache.lisezmoi.clear(); },

    /** Arborescence + LISEZMOI de chaque dossier (une fois par session). */
    async preparer(idAppareil) {
      // Racine et journaux d'abord (les autres en dependent), puis le reste en
      // parallele : noms distincts, aucun risque de doublon entre eux.
      const r = await racine();
      await sous('journaux');
      await Promise.all([
        deposerLisezmoi(r, 'racine'),
        (async () => deposerLisezmoi((await sous('journaux'))[0], 'journaux'))(),
        (async () => deposerLisezmoi((await dossiersAppareil(idAppareil, true))[0], 'journal_appareil'))(),
        (async () => deposerLisezmoi((await sous('appareils'))[0], 'appareils'))(),
        (async () => deposerLisezmoi((await sous('images'))[0], 'images'))(),
        (async () => deposerLisezmoi((await sous('snapshots'))[0], 'snapshots'))()
      ]);
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
      const liste = (await fichiers(await sous('appareils'))).filter((f) => F.RE_FICHE.test(f.name));
      // Seules les fiches modifiees depuis la derniere lecture sont relues, en parallele.
      const contenus = await Promise.all(liste.map(async (f) => {
        const deja = cache.fiches.get(f.id);
        if (deja && f.modifiedTime && deja.modifiedTime === f.modifiedTime) return deja.fiche;
        try {
          const fiche = JSON.parse((await api.lire(f.id)).toString('utf8'));
          cache.fiches.set(f.id, { modifiedTime: f.modifiedTime, fiche });
          return fiche;
        } catch { return null; }   // fiche illisible : ignoree
      }));
      const out = [];
      const vus = new Set();
      liste.forEach((f, i) => {
        const m = F.RE_FICHE.exec(f.name);
        const fiche = contenus[i];
        if (vus.has(m[1]) || !fiche || fiche.id !== m[1]) return;
        out.push(JSON.parse(JSON.stringify(fiche)));   // copie : le cache ne doit pas etre modifie
        vus.add(m[1]);
        cache.fichesIds.set(m[1] + '.json', f.id);
      });
      return out;
    },

    async ecrireFiche(fiche) {
      const octets = Buffer.from(JSON.stringify(fiche, null, 2), 'utf8');
      const nom = fiche.id + '.json';
      const connu = cache.fichesIds.get(nom);
      if (connu) {
        try { await api.majFichier(connu, octets, MIME_JSON); return; }
        catch { cache.fichesIds.delete(nom); }   // supprimee ailleurs : on la retrouve ci-dessous
      }
      const dossiersA = await sous('appareils');
      for (const d of dossiersA) {
        const l = await api.lister(d, { nom, dossier: false });
        if (l.length) { await api.majFichier(l[0].id, octets, MIME_JSON); cache.fichesIds.set(nom, l[0].id); return; }
      }
      cache.fichesIds.set(nom, await api.creerFichier(nom, dossiersA[0], octets, MIME_JSON));
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

/** Tests : oublie tous les caches (nouveau « lancement » de l'app). */
function viderCaches() { caches.clear(); }

module.exports = { creerTransportDrive, viderCaches };
