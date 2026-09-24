'use strict';
/**
 * Transport en memoire (tests) : un « Drive » partage par plusieurs appareils
 * d'un meme processus. Meme contrat que les transports reels (voir echange.js).
 * Les segments sont serialises : aucun objet partage entre appareils.
 */

function creerTransportMemoire() {
  const dossiers = new Map();   // appareil -> Map(nom -> JSON)

  return {
    async listerAppareils() { return [...dossiers.keys()]; },
    async listerSegments(app) { return [...(dossiers.get(app) || new Map()).keys()].sort(); },
    async lireSegment(app, nom) { return JSON.parse(dossiers.get(app).get(nom)); },
    async ecrireSegment(app, nom, ops) {
      if (!dossiers.has(app)) dossiers.set(app, new Map());
      const d = dossiers.get(app);
      if (!d.has(nom)) d.set(nom, JSON.stringify(ops));
    },
    // Tests : nombre total de segments.
    taille() { let n = 0; for (const d of dossiers.values()) n += d.size; return n; }
  };
}

module.exports = { creerTransportMemoire };
