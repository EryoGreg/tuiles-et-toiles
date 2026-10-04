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
 * Puis on ne garde, par oeuvre, que les masques les plus serres : ceux qui
 * montrent le MINIMUM de champs possible (minC) et ceux qui en montrent un de
 * plus (minC+1). Les deux niveaux servent la difficulte choisie au tirage
 * (`jeu.js`) : « difficile » pioche parmi minC (en general 1 seul champ visible),
 * « normal » parmi minC+1 (2 champs). On jette les masques plus fournis : montrer
 * titre + artiste + description a la fois n'a aucun interet pour l'entrainement.
 *
 * Tout est precalcule a l'import : le tirage en jeu se contente de piocher
 * dans la liste des masques de l'oeuvre, filtree par difficulte.
 */

const CHAMPS = ['image', 'artiste', 'titre', 'lieu', 'description', 'tags'];
const BIT = {};
CHAMPS.forEach((c, i) => { BIT[c] = 1 << i; });

// Indices qu'un humain peut relier a l'oeuvre.
const EVOCATEURS = ['image', 'titre', 'description'];

// L'artiste est evocateur tant qu'il n'a pas trop d'oeuvres au corpus : un nom
// porte par 2 a 6 oeuvres (artiste prolifique sur des sujets varies) reste un
// indice pour un humain ; au-dela il ne « situe » plus l'oeuvre. (La
// discriminance, elle, est verifiee a part : artiste seul ne suffit a designer
// l'oeuvre que s'il est effectivement unique.)
const ARTISTE_EVOCATEUR_MAX = 6;

// Champs texte dont la valeur est une « reponse » qu'un champ visible ne doit
// pas trahir (regle 3). La description, trop longue, n'est pas une reponse a
// restituer ; les tags sont des categories, pas une reponse unique.
const CIBLES_FUITE = ['artiste', 'titre', 'lieu'];
// Champs texte qui peuvent contenir, en clair, la reponse d'un champ cache.
const TEXTE = ['artiste', 'titre', 'lieu', 'description', 'tags'];

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

/** Cette oeuvre a-t-elle une image ? (champ `image` = nom de fichier, vide sinon.) */
function aImage(oeuvre) {
  return !!String(oeuvre.image || '').trim();
}

/** La valeur d'un champ, sous forme comparable. */
function valeur(oeuvre, champ) {
  // Une image par oeuvre (son id) — mais une tuile SANS image ne « montre »
  // rien : elle ne discrimine pas et n'est pas evocatrice par l'image.
  if (champ === 'image') return aImage(oeuvre) ? oeuvre.id : '';
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

/**
 * Un champ VISIBLE trahit-il la reponse d'un champ CACHE ?
 * Pour chaque cible cachee (artiste, titre, lieu), on regarde si tous ses mots
 * significatifs apparaissent dans la reunion des champs texte visibles. Couvre
 * les cas negliges par l'ancienne version (qui ne testait que description ->
 * artiste/titre) : p. ex. lieu « Musee Picasso » visible pendant que l'artiste
 * « Picasso » est cache, ou une description qui cite le lieu cache.
 *
 * Un mot n'est « significatif » que s'il fait plus de 3 lettres (motsSignificatifs),
 * ce qui ecarte les faux positifs sur les mots courts. On exige qu'un titre ou
 * un lieu cible ait au moins 2 mots significatifs pour declencher une fuite —
 * sinon un titre d'un seul mot un peu commun bloquerait trop de masques ;
 * l'artiste, lui, suffit a 1 mot (un nom propre est une reponse franche).
 */
function fuite(motsCache, motsVisibles, cible) {
  if (!motsCache.length) return false;
  if (cible !== 'artiste' && motsCache.length < 2) return false;
  return motsCache.every((m) => motsVisibles.has(m));
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

  const meta = oeuvres.map((o) => {
    const a = normaliser(o.artiste);
    // Mots significatifs par champ texte : sert a detecter les fuites.
    const mots = {};
    for (const c of TEXTE) mots[c] = motsSignificatifs(o[c]);
    return {
      artisteEvocateur: !!a && parArtiste.get(a) <= ARTISTE_EVOCATEUR_MAX,
      descriptionForte: (o.description || '').trim().length >= DESCRIPTION_MIN,
      mots
    };
  });

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
    const m0 = meta[i];
    const valides = [];
    for (let m = 1; m < TOUT; m++) {          // < TOUT : au moins un champ cache
      if (!discriminant[i].has(m)) continue;

      const voit = (c) => (m & BIT[c]) !== 0;

      // On ne revele jamais une case sans contenu reel : un champ vide, ou qui se
      // reduit a de la ponctuation (« - », « ? », « N/A » reste du texte), a une
      // valeur normalisee vide -> ce n'est pas un indice. Couvre aussi l'image
      // absente (valeur('image') = '' alors). Court mais rempli (« Orphee »,
      // « XV ») reste valide : c'est le contenu, pas la longueur, qui compte.
      if (CHAMPS.some((c) => voit(c) && valeur(o, c) === '')) continue;

      // regle 2 : au moins un evocateur visible
      let evoc = EVOCATEURS.some((c) => {
        if (!voit(c) || !valeur(o, c)) return false;
        if (c === 'description') return m0.descriptionForte;
        return true;
      });
      if (!evoc && voit('artiste') && m0.artisteEvocateur) evoc = true;
      if (!evoc) continue;

      // regle 3 : aucun champ visible ne trahit la reponse d'un champ cache.
      const motsVisibles = new Set();
      for (const c of TEXTE) if (voit(c)) for (const w of m0.mots[c]) motsVisibles.add(w);
      let fuit = false;
      for (const cible of CIBLES_FUITE) {
        if (voit(cible)) continue;
        if (fuite(m0.mots[cible], motsVisibles, cible)) { fuit = true; break; }
      }
      if (fuit) continue;

      valides.push(m);
    }

    // On garde les masques a minC et minC+1 champs visibles (voir en-tete) :
    // deux niveaux de difficulte, sans les masques trop fournis.
    if (valides.length) {
      const minC = Math.min(...valides.map(nbChamps));
      resultat.set(o.id, valides.filter((m) => nbChamps(m) <= minC + 1));
    } else {
      resultat.set(o.id, []);
    }
  });

  return resultat;
}

/** Nombre de champs visibles dans un masque (popcount). */
function nbChamps(m) {
  let n = 0;
  for (let x = m; x; x >>= 1) n += x & 1;
  return n;
}

/** Traduit un bitmask en objet { champ: visible } pour l'affichage. */
function decrire(masque) {
  const out = { date: false };
  for (const c of CHAMPS) out[c] = (masque & BIT[c]) !== 0;
  return out;
}

module.exports = { CHAMPS, BIT, TOUT, calculer, decrire, normaliser, normaliserRecherche, valeur, aImage, nbChamps };
