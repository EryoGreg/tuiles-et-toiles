'use strict';
/**
 * Tirage des tuiles.
 *
 * Sac sans remise : on ne repioche pas une oeuvre tant que le sac n'est pas
 * epuise. Evite de revoir trois fois la meme dans une session, ce que le
 * tirage purement aleatoire produit sans arret sur 431 elements.
 */

const db = require('./db');
const etat = require('./synchro/etat');
const { decrire, TOUT, normaliser } = require('./masques');

let sac = [];
let filtreCourant = null;   // cle stable du filtre courant, null = aleatoire

function melanger(t) {
  for (let i = t.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [t[i], t[j]] = [t[j], t[i]];
  }
  return t;
}

/**
 * filtre de tirage :
 *   null                                   -> aleatoire (toutes les oeuvres)
 *   string | string[]                      -> categories, mode additif (retrocompat)
 *   { cats: string[], soustractif: bool }  -> categories
 *     additif      : l'oeuvre porte AU MOINS UNE des categories choisies
 *     soustractif  : l'oeuvre porte TOUTES les categories choisies
 * @returns {{cats:string[], soustractif:boolean}|null}
 */
function normFiltre(f) {
  if (!f) return null;
  if (typeof f === 'string' || Array.isArray(f)) {
    const cats = (Array.isArray(f) ? f : [f]).filter(Boolean);
    return cats.length ? { cats, soustractif: false } : null;
  }
  const cats = (f.cats || []).filter(Boolean);
  return cats.length ? { cats, soustractif: !!f.soustractif } : null;
}
function cleFiltre(f) {
  return f ? (f.soustractif ? '&' : '|') + f.cats.slice().sort().join('|') : null;
}

function remplirSac(filtre) {
  const f = normFiltre(filtre);
  const lignes = f
    ? db.parCategorie(f.cats, f.soustractif)
    : db.instance().prepare('SELECT id FROM oeuvres_effectives').all();
  sac = melanger(lignes.map((l) => l.id));
  filtreCourant = cleFiltre(f);
}

/**
 * @param {null|string|string[]|{cats:string[],soustractif:boolean}} filtre
 * @returns {Object|null} la tuile a afficher, masque compris
 */
function tirer(filtre = null) {
  const f = normFiltre(filtre);
  if (!sac.length || filtreCourant !== cleFiltre(f)) remplirSac(filtre);
  if (!sac.length) return null;

  const id = sac.pop();
  const o = db.oeuvre(id);
  if (!o) return tirer(filtre);

  const masques = JSON.parse(o.masques || '[]');
  if (!masques.length) return tirer(filtre);
  const masque = masques[Math.floor(Math.random() * masques.length)];
  const visible = decrire(masque);

  // Champ `tags` (le « tag de jeu ») :
  //  - mode aleatoire (filtre null)  -> toujours censure
  //  - mode categorie                -> visible seulement si l'oeuvre ne
  //    porte qu'UNE valeur ; plusieurs valeurs separees par ',' -> censure
  const valeursTags = String(o.tags || '').split(',').map((s) => s.trim()).filter(Boolean);
  const tagsAffiche = f && valeursTags.length === 1 ? o.tags : null;

  // Compteur de CET appareil (hors journal : additionne a la synchro).
  db.instance().prepare(
    `INSERT INTO user_stats (oeuvre_id, appareil, vues, dernier_vu) VALUES (?, ?, 1, ?)
     ON CONFLICT(oeuvre_id, appareil) DO UPDATE SET vues = vues + 1, dernier_vu = excluded.dernier_vu`
  ).run(id, etat.appareil().id, new Date().toISOString());

  return {
    id: o.id,
    ref: o.ref,
    estLocale: !!o.est_locale,
    masque,
    visible,
    tagVisible: null,
    restant: sac.length,
    champs: {
      image: visible.image ? 'tuile://' + o.image : null,
      artiste: visible.artiste ? o.artiste : null,
      titre: visible.titre ? o.titre : null,
      lieu: visible.lieu ? o.lieu : null,
      description: visible.description ? o.description : null,
      tags: tagsAffiche,
      date: null                                  // jamais revelee au tirage
    },
    tagsUtilisateur: db.tagsDe(o.id)
  };
}

/**
 * Categories jouables : valeurs distinctes du champ `tags`, normalisees pour
 * fusionner les variantes de casse (« Huile » / « huile »). n = nombre
 * d'oeuvres portant la categorie. `valeur` est la cle a repasser a tirer().
 */
function categories() {
  const rows = db.instance().prepare('SELECT tags FROM oeuvres_effectives').all();
  const map = new Map();
  for (const r of rows) {
    const vues = new Set();                    // une oeuvre compte 1 fois par categorie
    for (const brut of String(r.tags || '').split(',').map((s) => s.trim()).filter(Boolean)) {
      const cle = normaliser(brut);
      if (!cle || vues.has(cle)) continue;
      vues.add(cle);
      const e = map.get(cle) || { valeur: cle, label: brut, n: 0 };
      e.n += 1;
      map.set(cle, e);
    }
  }
  return [...map.values()].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
}

/**
 * Apercu d'une combinaison de categories AVANT le tirage (ecran Nouvelle
 * partie). Tout en memoire sur oeuvres_effectives (~431 lignes) : negligeable.
 *
 * @param {{cats:string[], soustractif:boolean}} sel
 * @returns {{ total:number, possibles:string[]|null }}
 *   total     : nombre de tuiles que le tirage donnerait avec cette selection
 *   possibles : en soustractif, valeurs de categorie qu'on peut encore ajouter
 *               sans tomber a 0 tuile ; null en additif (aucune restriction).
 */
function apercuCategories({ cats = [], soustractif = false } = {}) {
  const rows = db.instance().prepare('SELECT tags FROM oeuvres_effectives').all();
  const ensembles = rows.map((r) => new Set(
    String(r.tags || '').split(',').map((s) => normaliser(s)).filter(Boolean)
  ));
  const choisies = cats.filter(Boolean);

  const compte = (sel, sous) => {
    if (!sel.length) return rows.length;
    return ensembles.reduce((n, tg) => n + (
      sous ? sel.every((c) => tg.has(c)) : sel.some((c) => tg.has(c))
    ), 0);
  };

  const total = compte(choisies, soustractif);

  let possibles = null;
  if (soustractif) {
    possibles = [];
    const toutes = new Set();
    for (const s of ensembles) for (const v of s) toutes.add(v);
    for (const v of toutes) {
      if (choisies.includes(v)) continue;
      if (compte([...choisies, v], true) > 0) possibles.push(v);
    }
  }
  return { total, possibles };
}

/** Oeuvre complete, prete a afficher (hors tirage, rien n'y est masque). */
function completer(o) {
  return {
    id: o.id,
    ref: o.ref,
    estLocale: !!o.est_locale,
    image: o.image ? 'tuile://' + o.image : null,
    artiste: o.artiste,
    titre: o.titre,
    date: o.date,
    lieu: o.lieu,
    description: o.description,
    tags: o.tags,
    tagsUtilisateur: db.tagsDe(o.id),
    // Present uniquement quand l'oeuvre vient d'une liste par tag : date
    // d'ajout du tag, cle du tri chronologique cote rendu.
    creeLe: o.tag_cree_le || null,
    // Date d'ajout de la tuile (locale : sa creation, sur l'appareil ou elle
    // a ete creee ; oeuvre du pack : null = plus ancienne que tout ajout).
    ajouteLe: o.cree_le || null
  };
}

/**
 * Apercu d'une oeuvre precise, ouvert depuis la Bibliotheque ou une galerie.
 * Contrairement au tirage : RIEN n'est masque, tout est fourni (date
 * comprise). `visible` reste renseigne — un masque valide tire au hasard —
 * pour que le rendu souligne en pointilles dore les sections qu'un tirage
 * cacherait. N'entame ni le sac ni les statistiques.
 */
function apercu(id) {
  const o = db.oeuvre(id);
  if (!o) return null;

  const masques = JSON.parse(o.masques || '[]');
  const masque = masques.length
    ? masques[Math.floor(Math.random() * masques.length)]
    : TOUT;
  const visible = decrire(masque);

  return {
    id: o.id,
    ref: o.ref,
    estLocale: !!o.est_locale,
    masque,
    visible,
    tagVisible: null,
    restant: null,
    champs: {
      image: o.image ? 'tuile://' + o.image : null,
      artiste: o.artiste,
      titre: o.titre,
      lieu: o.lieu,
      description: o.description,
      tags: o.tags,
      date: o.date
    },
    tagsUtilisateur: db.tagsDe(o.id)
  };
}

/** Tout reveler : renvoie l'oeuvre complete, date comprise. */
function reveler(id) {
  const o = db.oeuvre(id);
  return o ? completer(o) : null;
}

/**
 * Tuiles portant un tag utilisateur (livre / etoile / bad_smiley), completes,
 * ordre chronologique d'ajout. `texte` : filtre de recherche permissif.
 */
function listerParTag(tag, texte) {
  return db.parTagUtilisateur(tag, texte || '').map(completer);
}

/**
 * Toutes les tuiles pour la Bibliotheque, completes. `criteres.texte` filtre
 * en recherche permissive (accents / casse / ponctuation ignores des deux
 * cotes), chaque mot devant apparaitre quelque part hors image.
 */
function listerToutes(criteres) {
  return db.chercher({ ...(criteres || {}), limite: 100000 }).map(completer);
}

function reinitialiserSac() {
  sac = [];
  filtreCourant = null;
}

module.exports = {
  tirer, reveler, apercu, categories, apercuCategories,
  listerParTag, listerToutes, reinitialiserSac
};
