'use strict';
/**
 * Faux Google Drive en memoire, meme interface `api` que drive.js
 * (voir transport-drive.js). Sert a faire tourner les suites de synchro sur
 * le transport Drive sans reseau ni compte.
 *
 * Comme le vrai : plusieurs fichiers ou dossiers peuvent porter le meme nom
 * dans un meme parent ; createdTime croissant.
 */

let horloge = Date.parse('2026-01-01T00:00:00Z');

function creerFauxDrive() {
  const elements = new Map();   // id -> { id, name, parent, dossier, createdTime, octets }
  let n = 0;
  const appels = { lister: 0, creer: 0, maj: 0, lire: 0, supprimer: 0 };

  const nouveau = (name, parent, dossier, octets) => {
    const id = 'f' + (++n);
    elements.set(id, { id, name, parent, dossier, createdTime: new Date(++horloge).toISOString(), octets });
    return id;
  };

  return {
    appels,
    elements,
    async lister(parent, { nom, dossier } = {}) {
      appels.lister++;
      return [...elements.values()]
        .filter((e) => e.parent === parent && (nom == null || e.name === nom)
          && (dossier == null || e.dossier === dossier))
        .map((e) => ({ id: e.id, name: e.name, dossier: e.dossier, createdTime: e.createdTime }));
    },
    async creerDossier(nom, parent) { appels.creer++; return nouveau(nom, parent, true, null); },
    async creerFichier(nom, parent, octets) { appels.creer++; return nouveau(nom, parent, false, Buffer.from(octets)); },
    async majFichier(id, octets) { appels.maj++; elements.get(id).octets = Buffer.from(octets); },
    async lire(id) {
      appels.lire++;
      const e = elements.get(id);
      if (!e || e.dossier) throw new Error('Drive 404 ' + id);
      return Buffer.from(e.octets);
    },
    async supprimer(id) { appels.supprimer++; elements.delete(id); },
    /** Chemin -> element (tests). */
    trouver(...noms) {
      let parent = 'root';
      let e = null;
      for (const nom of noms) {
        e = [...elements.values()].find((x) => x.parent === parent && x.name === nom);
        if (!e) return null;
        parent = e.id;
      }
      return e;
    }
  };
}

module.exports = { creerFauxDrive };
