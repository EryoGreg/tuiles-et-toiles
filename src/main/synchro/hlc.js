'use strict';
/**
 * Horloge logique hybride (HLC).
 *
 * Une HLC = heure physique (ms) + compteur + appareil, formatee pour que la
 * comparaison de chaines suive l'ordre causal :
 *
 *     0001727180400123-0000-a7f3c2e1
 *     └─── ms (16) ──┘ └cpt┘ └appareil┘
 *
 * Deux appareils ne produisent jamais la meme HLC (suffixe appareil). Une
 * horloge de telephone en retard ne casse pas l'ordre : l'horloge locale
 * avance toujours au moins jusqu'a la plus grande HLC vue.
 */

const LARG_MS = 16;
const LARG_CPT = 4;
const MAX_CPT = 9999;
// Garde-fou : une HLC distante plus d'un jour dans le futur vient d'une
// horloge dereglee ; l'accepter lui ferait gagner tous les conflits.
const MAX_AVANCE = 24 * 3600e3;

function formater(ms, cpt, appareil) {
  if (cpt > MAX_CPT) throw new Error('HLC : compteur sature a ' + ms);
  return String(ms).padStart(LARG_MS, '0') + '-' + String(cpt).padStart(LARG_CPT, '0') + '-' + appareil;
}

function lire(h) {
  const m = /^(\d{16})-(\d{4})-([0-9a-z]+)$/.exec(String(h));
  if (!m) throw new Error('HLC illisible : ' + h);
  return { ms: Number(m[1]), cpt: Number(m[2]), appareil: m[3] };
}

/** Heure physique d'une HLC, en ISO (sert aux colonnes cree_le / modifie_le). */
function versIso(h) {
  return new Date(lire(h).ms).toISOString();
}

/**
 * @param {string} appareil id de l'appareil (suffixe de chaque HLC emise)
 * @param {{ maintenant?: () => number }} [opts] horloge injectable (tests)
 */
function creerHorloge(appareil, { maintenant = Date.now } = {}) {
  let ms = 0;
  let cpt = 0;

  return {
    /** Evenement local : nouvelle HLC, strictement superieure a toutes les precedentes. */
    tic() {
      const now = maintenant();
      if (now > ms) { ms = now; cpt = 0; } else cpt++;
      return formater(ms, cpt, appareil);
    },

    /** Reception d'une op distante : l'horloge avance au moins jusqu'a elle. */
    recevoir(h) {
      const r = lire(h);
      const now = maintenant();
      if (r.ms > now + MAX_AVANCE) throw new Error('HLC distante trop en avance : ' + h);
      const p = Math.max(ms, r.ms, now);
      if (p === ms && p === r.ms) cpt = Math.max(cpt, r.cpt) + 1;
      else if (p === ms) cpt++;
      else if (p === r.ms) cpt = r.cpt + 1;
      else cpt = 0;
      ms = p;
    },

    /**
     * Recale l'horloge sur une HLC deja acceptee (plus grande du journal, a
     * l'ouverture). Sans garde-fou : elle a ete verifiee a sa reception.
     */
    caler(h) {
      if (!h) return;
      const r = lire(h);
      if (r.ms > ms || (r.ms === ms && r.cpt > cpt)) { ms = r.ms; cpt = r.cpt; }
    },

    appareil
  };
}

module.exports = { creerHorloge, formater, lire, versIso, MAX_AVANCE };
