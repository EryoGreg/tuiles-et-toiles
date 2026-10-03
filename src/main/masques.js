'use strict';
/**
 * Moteur de masques.
 *
 * Un « masque » est l'ensemble des champs VISIBLES d'une tuile.
 * La date n'en fait jamais partie : elle est toujours cachee, c'est ce que
 * l'utilisateur doit se remémorer.
 *
 * Un masque n'est retenu pour une oeuvre que s'il satisfait quatre regles :
 *   1. discriminant  -- les champs visibles ne designent qu'une seule oeuvre
 *   2. evocateur     -- au moins un indice qu'un humain peut relier a l'oeuvre
 *   3. sans fuite    -- aucun champ visible ne contient la reponse d'un champ cache
 *   4. incomplet     -- au moins un champ cache
 *
 * Tout est precalcule a l'import : le tirage en jeu se contente de piocher
 * dans la liste des masques valides de l'oeuvre.
 */

const CHAMPS = ['image', 'artiste', 'titre', 'lieu', 'description', 'tags'];
const BIT = {};
CHAMPS.forEach((c, i) => { BIT[c] = 1 << i; });

// Indices qu'un humain peut relier a l'oeuvre. L'artiste s'y ajoute quand il
// n'a qu'une seule oeuvre dans le corpus (243 cas sur 431).
const EVOCATEURS = ['image', 'titre', 'description'];

// En dessous, une description n'identifie plus rien pour un lecteur :
// « Baroque », « Tite-live », « fille de Louis XV ».
const DESCRIPTION_MIN = 60;

const TOUT = (1 << CHAMPS.length) - 1;

function normaliser(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Normalisation de la RECHERCHE (Bibliotheque, notes) : identique a
 * normaliser() pour l'alphabet latin — le pack reste trouvable exactement
 * pareil et les masques n'en dependent pas — mais garde aussi les lettres des
 * autres ecritures (grec, cyrillique, hebreu, arabe, thai, kana, CJK, hangul).
 * Avant : « Илья Репин » devenait une chaine vide, introuvable.
 */
function normaliserRecherche(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u0370-\u03ff\u0400-\u052f\u0590-\u05ff\u0600-\u06ff\u0e00-\u0e7f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]+/g, ' ')
    .trim();
}

function motsSignificatifs(s) {
  return normaliser(s).split(' ').filter((m) => m.length > 3);
}

/** La valeur d'un champ, sous forme comparable. */
function valeur(oeuvre, champ) {
  if (champ === 'image') return oeuvre.id;          // une image par oeuvre
  if (champ === 'tags') {
    return [...new Set(
      String(oeuvre.tags || '')
        .split(/[,/;]|\bet\b/)
        .map(normaliser)
        .filter(Boolean)
    )].sort().join('+');
  }
  return normaliser(oeuvre[champ]);
}

/** La description trahit-elle l'artiste ou le titre de cette oeuvre ? */
function fuites(oeuvre) {
  const d = normaliser(oeuvre.description);
  if (!d) return { artiste: false, titre: false };
  const a = motsSignificatifs(oeuvre.artiste);
  const t = motsSignificatifs(oeuvre.titre);
  return {
    artiste: a.length > 0 && a.every((m) => d.includes(m)),
    titre: t.length > 1 && t.every((m) => d.includes(m))
  };
}

/**
 * Calcule les masques valides de chaque oeuvre.
 * @param {Array<Object>} oeuvres
 * @returns {Map<string, number[]>} id -> masques valides (bitmasks)
 */
function calculer(oeuvres) {
  // combien d'oeuvres par artiste : determine si l'artiste est evocateur
  const parArtiste = new Map();
  for (const o of oeuvres) {
    const a = normaliser(o.artiste);
    if (a) parArtiste.set(a, (parArtiste.get(a) || 0) + 1);
  }

  const meta = oeuvres.map((o) => ({
    artisteUnique: !!normaliser(o.artiste) && parArtiste.get(normaliser(o.artiste)) === 1,
    descriptionForte: (o.description || '').trim().length >= DESCRIPTION_MIN,
    fuite: fuites(o)
  }));

  // discriminance : pour chaque masque, une cle par oeuvre, puis comptage
  const discriminant = oeuvres.map(() => new Set());
  for (let m = 1; m <= TOUT; m++) {
    const visibles = CHAMPS.filter((c) => m & BIT[c]);
    const compte = new Map();
    const cles = oeuvres.map((o) => {
      const k = visibles.map((c) => valeur(o, c)).join('');
      compte.set(k, (compte.get(k) || 0) + 1);
      return k;
    });
    for (let i = 0; i < oeuvres.length; i++) {
      if (compte.get(cles[i]) === 1) discriminant[i].add(m);
    }
  }

  const resultat = new Map();
  oeuvres.forEach((o, i) => {
    const valides = [];
    for (let m = 1; m < TOUT; m++) {          // < TOUT : au moins un champ cache
      if (!discriminant[i].has(m)) continue;

      const voit = (c) => (m & BIT[c]) !== 0;

      // regle 2 : au moins un evocateur visible
      let evoc = EVOCATEURS.some((c) => {
        if (!voit(c) || !valeur(o, c)) return false;
        if (c === 'description') return meta[i].descriptionForte;
        return true;
      });
      if (!evoc && voit('artiste') && meta[i].artisteUnique) evoc = true;
      if (!evoc) continue;

      // regle 3 : pas de fuite d'un champ cache par un champ visible
      if (voit('description') && !voit('artiste') && meta[i].fuite.artiste) continue;
      if (voit('description') && !voit('titre') && meta[i].fuite.titre) continue;

      valides.push(m);
    }
    resultat.set(o.id, valides);
  });

  return resultat;
}

/** Traduit un bitmask en objet { champ: visible } pour l'affichage. */
function decrire(masque) {
  const out = { date: false };
  for (const c of CHAMPS) out[c] = (masque & BIT[c]) !== 0;
  return out;
}

module.exports = { CHAMPS, BIT, TOUT, calculer, decrire, normaliser, normaliserRecherche, valeur, fuites };
