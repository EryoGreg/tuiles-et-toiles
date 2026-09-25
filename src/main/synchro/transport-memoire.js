'use strict';
/**
 * Transport en memoire (tests) : un « Drive » partage par plusieurs appareils
 * d'un meme processus. Meme contrat que les transports reels (voir echange.js
 * et compaction.js). Tout est serialise : aucun objet partage entre appareils.
 */

function creerTransportMemoire() {
  const dossiers = new Map();    // appareil -> Map(nom -> JSON)
  const fiches = new Map();      // appareil -> JSON
  const snapshots = new Map();   // appareil -> Map(nom -> JSON)
  const dans = (m, app) => { if (!m.has(app)) m.set(app, new Map()); return m.get(app); };

  return {
    async preparer() {},
    async listerAppareils() { return [...dossiers.keys()]; },
    async listerSegments(app) { return [...(dossiers.get(app) || new Map()).keys()].sort(); },
    async lireSegment(app, nom) { return JSON.parse(dossiers.get(app).get(nom)); },
    async ecrireSegment(app, nom, ops) {
      const d = dans(dossiers, app);
      if (!d.has(nom)) d.set(nom, JSON.stringify(ops));
    },
    async supprimerSegment(app, nom) { const d = dossiers.get(app); if (d) d.delete(nom); },

    async lireFiches() { return [...fiches.values()].map((f) => JSON.parse(f)); },
    async ecrireFiche(f) { fiches.set(f.id, JSON.stringify(f)); },

    async listerSnapshots() {
      const out = [];
      for (const [app, m] of snapshots) for (const nom of m.keys()) out.push({ appareil: app, nom });
      return out;
    },
    async lireSnapshot(app, nom) { return JSON.parse(snapshots.get(app).get(nom)); },
    async ecrireSnapshot(app, nom, obj) { dans(snapshots, app).set(nom, JSON.stringify(obj)); },
    async supprimerSnapshot(app, nom) { const m = snapshots.get(app); if (m) m.delete(nom); },

    // Tests : nombre total de segments.
    taille() { let n = 0; for (const d of dossiers.values()) n += d.size; return n; }
  };
}

module.exports = { creerTransportMemoire };
