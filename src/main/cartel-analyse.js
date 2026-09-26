'use strict';
/**
 * Range les lignes lues sur un cartel de musee (ML Kit, src/mobile/cartel.js)
 * dans les champs d'une tuile. JS pur, sans dependance : teste sur PC
 * (tests/cartel-analyse.test.js, cartels reels retranscrits).
 *
 * Entree : [{ texte, bloc, hauteur, cadre: { x, y, l, h } }] dans l'ordre de
 * lecture. Sortie : { champs: { titre, artiste, date, description, tags },
 * roles: [role par ligne] }.
 *
 * Roles : artiste, vie (dates / lieux de vie de l'artiste), titre, date,
 * technique, texte (description), provenance, numero, traduction, doublon,
 * autre (non range : l'utilisateur decide).
 *
 * Ce n'est qu'une proposition : l'editeur la montre, l'utilisateur corrige
 * en touchant les lignes, rien n'est ecrit avant « Valider ».
 */

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[’`]/g, "'").replace(/\s+/g, ' ').trim();

// --- reconnaissance ligne par ligne -----------------------------------------

const MOTS_DATE = new Set(['vers', 'v.', 'c.', 'ca.', 'circa', 'entre', 'fin', 'debut', 'milieu', 'avant', 'apres',
  'premier', 'premiere', 'second', 'seconde', 'deuxieme', 'troisieme', 'dernier', 'derniere', 'moitie', 'quart',
  'tiers', 'et', 'a', 'au', 'aux', 'du', 'de', 'des', 'la', 'le', 'les', "l'", "d'", 'en', 'ou', 'av.', 'av',
  'apr.', 'apr', 'j.-c.', 'j.-c', 'j.c.', 'jc', 'siecle', 'siecles', 's.', 'millenaire', 'an', 'annee', 'annees',
  'epoque', 'probablement', 'avt', '?']);
const ROMAIN = /^[ivxlc]+(e|er|eme|es)?$/i;
const ANNEE = /^-?\d{1,4}(e|er)?\??$/;

/** « Vers 1890 », « 1632 », « Fin IVe – début Ve siècle apr. J.-C », « milieu du XVIe siècle » */
function estDate(texte) {
  const t = norm(texte).replace(/[()[\],;:/–—-]/g, ' ').replace(/\bj\s*\.?\s*c\b\.?/g, 'jc');
  const mots = t.split(' ').filter(Boolean);
  if (!mots.length || mots.length > 10) return false;
  let fort = false;
  for (const m of mots) {
    if (ANNEE.test(m)) { fort = true; continue; }
    if (ROMAIN.test(m) && m.length <= 6) { if (/siecle/.test(t)) fort = true; continue; }
    if (MOTS_DATE.has(m) || MOTS_DATE.has(m.replace(/\.$/, ''))) { if (/siecle|millenaire/.test(m)) fort = true; continue; }
    return false;
  }
  return fort;
}

/** « Paris, vers 1863 » -> « vers 1863 » ; « Limoges, milieu du XVIe siècle » -> « milieu du XVIe siècle » */
function dateApresLieu(texte) {
  const i = texte.indexOf(',');
  if (i < 0) return null;
  const lieu = texte.slice(0, i).trim();
  const reste = texte.slice(i + 1).trim();
  if (!lieu || lieu.split(/\s+/).length > 3 || /\d/.test(lieu)) return null;
  return estDate(reste) ? reste : null;
}

const ANNEES = (t) => (String(t).match(/\b\d{4}\b/g) || []).length;

/** Lieux et dates de vie : « Aix-en-Provence 1839 – Aix-en-Provence 1906 », « Anvers, 1582-1583 – Haarlem, 1666 » */
const VIE_SEULE = /^\(?\s*\d{4}\s*[–—-]\s*\d{4}\s*\)?$/;           // « (1854-1937) »
const VIE_ACCOLEE = /^(.*\S)\s*\(\s*\d{4}\s*[–—-]\s*\d{4}\s*\)\s*$/; // « Auguste Raynaud (1854-1937) »
// (Dates entre parentheses en fin de ligne : artiste accole, ou personnage du
// titre — « de Jeanne d'Albret (1528-1572) » —, jamais des lieux de vie.)
function estVieAvecLieux(texte) {
  return ANNEES(texte) >= 2 && /[–—-]/.test(texte) && /[a-zà-ÿ]{3,}/i.test(texte)
    && !VIE_ACCOLEE.test(texte) && !estDate(texte);
}

const PROVENANCE = /\b(inv|inventaire|legs|don|donation|dation|achat|acquis|acquisition|depot|usufruit|mecenat|restauree?|ancien(ne)? (fonds|collection)|collection|fonds|n°|rf \d)\b/;
const estProvenance = (texte) => texte.length < 120 && PROVENANCE.test(norm(texte));

const NUMERO = /^\(?\d{1,3}[.)]?$/;

const MATIERES = /\b(huile|toile|panneau|bois|bronze|marbres?|terre cuite|email|emaux|emaille|aquarelle|gouache|pastel|crayon|fusain|encre|papier|parchemin|velin|cuivre|argent|rehauts?|platre|calcaires?|pierre|tempera|detrempe|fresque|gravure|eau-forte|lithographie|photographie|cartons?|verre|porcelaine|faience|ceramique|ivoire|albatre|acrylique|techniques? mixtes?|sanguine|mine de plomb|laiton|fer forge|acier|soie|laine|tapisserie|cire|gres|tesselles|cloisonne|polychromes?|dore|taille-douce|vernis)\b/;
const estTechnique = (texte) => texte.length < 110 && MATIERES.test(norm(texte));

const MOTS_ANGLAIS = new Set(['the', 'of', 'at', 'with', 'for', 'and', 'his', 'her', 'by', 'is', 'from', 'this', 'shows',
  'painting', 'canvas', 'oil', 'taken', 'scene', 'cards', 'playing', 'to', 'was', 'which', 'its', 'man', 'woman',
  'portrait of', 'on canvas', 'panel', 'wood', 'bath', 'grave']);
function estAnglais(texte) {
  const mots = norm(texte).replace(/[^a-z' ]/g, ' ').split(' ').filter(Boolean);
  if (mots.length < 2) return false;
  const n = mots.filter((m) => MOTS_ANGLAIS.has(m)).length;
  return n >= 2 && n / mots.length >= 0.2;
}

const PREFIXE_ARTISTE = /^(attribue|attribuee|atelier|entourage|ecole|d'apres|suiveur|cercle|maitre|maison|manufacture|signe)\b/;
function estCapitales(texte) {
  const lettres = texte.replace(/[^A-Za-zÀ-ÿ]/g, '');
  const mots = texte.trim().split(/\s+/);
  return lettres.length >= 6 && mots.length >= 2 && lettres === lettres.toUpperCase();
}

const LONGUE = 48;   // au-dela : phrase de texte, pas un titre

// --- assemblage ----------------------------------------------------------------

function joindre(lignes) {
  let s = '';
  let blocPrec = null;
  for (const l of lignes) {
    const t = l.texte.trim();
    if (!s) { s = t; blocPrec = l.bloc; continue; }
    if (l.bloc !== blocPrec || /^[•·▪–-]\s/.test(t)) s += '\n' + t;
    else if (/[a-zà-ÿ]-$/.test(s) && /^[a-zà-ÿ]/.test(t)) s = s.slice(0, -1) + t;   // coupure de mot
    else if (/-$/.test(s)) s += t;                                                 // « Sainte- » + « Victoire »
    else s += ' ' + t;
    blocPrec = l.bloc;
  }
  return s;
}

function analyser(entree) {
  const lignes = (entree || []).map((l, i) => ({
    i, texte: String(l.texte || '').trim(), bloc: l.bloc == null ? i : l.bloc,
    hauteur: l.hauteur || (l.cadre && l.cadre.h) || 0
  })).filter((l) => l.texte);
  const role = new Map();
  const extra = new Map();   // i -> valeur retenue (date extraite, artiste sans ses dates…)

  // 1. Ce qui se reconnait seul.
  const vus = new Set();
  for (const l of lignes) {
    const n = norm(l.texte);
    if (vus.has(n)) { role.set(l.i, 'doublon'); continue; }
    vus.add(n);
    if (NUMERO.test(l.texte)) role.set(l.i, 'numero');
    else if (estProvenance(l.texte)) role.set(l.i, 'provenance');
    else if (estAnglais(l.texte)) role.set(l.i, 'traduction');
    else if (estDate(l.texte)) role.set(l.i, 'date');
    else if (dateApresLieu(l.texte)) { role.set(l.i, 'date'); extra.set(l.i, dateApresLieu(l.texte)); }
    else if (estVieAvecLieux(l.texte)) role.set(l.i, 'vie');
    else if (l.texte.length >= LONGUE && !estTechnique(l.texte)) role.set(l.i, 'texte');
    else if (estTechnique(l.texte)) role.set(l.i, 'technique');
  }
  // Paragraphe : les lignes libres d'un bloc qui contient deja du texte, a la
  // meme taille, en font partie (debut ou fin de paragraphe plus courts).
  for (const l of lignes) {
    if (role.has(l.i)) continue;
    const voisines = lignes.filter((m) => m.bloc === l.bloc && role.get(m.i) === 'texte');
    if (voisines.some((m) => Math.abs(m.hauteur - l.hauteur) <= 0.15 * Math.max(m.hauteur, l.hauteur, 1))) role.set(l.i, 'texte');
  }
  // Bloc de 3 lignes ou plus, surtout longues : un paragraphe, meme sans ligne de 48 car.
  const parBloc = new Map();
  for (const l of lignes) { if (!parBloc.has(l.bloc)) parBloc.set(l.bloc, []); parBloc.get(l.bloc).push(l); }
  for (const b of parBloc.values()) {
    const libres = b.filter((l) => !role.has(l.i));
    if (libres.length >= 3 && libres.filter((l) => l.texte.length >= 35).length >= libres.length / 2) {
      for (const l of libres) role.set(l.i, 'texte');
    }
  }
  // Provenance sur plusieurs lignes (« …Amis des Arts de Bordeaux, » / « 1858. ») :
  // une ligne courte du meme bloc, a la meme taille, en fait partie.
  for (const l of lignes) {
    if (role.has(l.i) || l.texte.length >= LONGUE) continue;
    const prov = lignes.filter((m) => m.bloc === l.bloc && role.get(m.i) === 'provenance');
    if (prov.some((m) => Math.abs(m.hauteur - l.hauteur) <= 0.15 * Math.max(m.hauteur, l.hauteur, 1))) role.set(l.i, 'provenance');
  }
  // Traduction anglaise d'un paragraphe : tout le bloc suit.
  for (const l of lignes) {
    if (role.get(l.i) === 'traduction') {
      for (const m of lignes) if (m.bloc === l.bloc && role.get(m.i) === 'texte') role.set(m.i, 'traduction');
    }
  }

  // 2. Artiste : marque par ce qui l'entoure.
  const libres = () => lignes.filter((l) => !role.has(l.i));
  let artiste = null;
  for (let k = 0; k < lignes.length && !artiste; k++) {
    const l = lignes[k];
    if (role.has(l.i)) continue;
    const suivante = lignes[k + 1];
    const n = norm(l.texte);
    if (suivante && (role.get(suivante.i) === 'vie'
      || (VIE_SEULE.test(suivante.texte) && suivante.hauteur <= l.hauteur))) {
      artiste = l;
      if (VIE_SEULE.test(suivante.texte)) role.set(suivante.i, 'vie');
    } else if (PREFIXE_ARTISTE.test(n) || estCapitales(l.texte)) {
      artiste = l;
    }
  }
  if (!artiste) {
    const premiere = libres()[0];
    if (premiere && VIE_ACCOLEE.test(premiere.texte)) {
      artiste = premiere;
      extra.set(premiere.i, premiere.texte.match(VIE_ACCOLEE)[1]);
    }
  }
  if (artiste) role.set(artiste.i, 'artiste');

  // 3. Titre : le plus gros texte restant, lignes voisines de meme taille jointes.
  const groupes = [];
  for (const l of lignes) {
    if (role.has(l.i)) continue;
    const g = groupes[groupes.length - 1];
    const der = g && g[g.length - 1];
    if (der && der.i === l.i - 1 && der.bloc === l.bloc && Math.abs(der.hauteur - l.hauteur) <= 0.2 * Math.max(der.hauteur, l.hauteur, 1)) g.push(l);
    else groupes.push([l]);
  }
  const taille = (g) => Math.max(...g.map((l) => l.hauteur));
  let titre = null;
  for (const g of groupes) if (!titre || taille(g) > taille(titre)) titre = g;
  if (titre) for (const l of titre) role.set(l.i, 'titre');

  // Pas d'artiste repere : un seul groupe restant AVANT le titre en tient lieu.
  if (!artiste && titre) {
    const avant = groupes.filter((g) => g !== titre && g[0].i < titre[0].i);
    if (avant.length === 1 && avant[0].length === 1) { artiste = avant[0][0]; role.set(artiste.i, 'artiste'); }
  }
  for (const l of lignes) if (!role.has(l.i)) role.set(l.i, 'autre');

  // 4. Champs proposes.
  const de = (r) => lignes.filter((l) => role.get(l.i) === r);
  const dates = de('date');
  const techniques = de('technique');
  const champs = {
    titre: titre ? joindre(titre) : '',
    artiste: artiste ? (extra.get(artiste.i) || artiste.texte) : '',
    date: dates.length ? (extra.get(dates[0].i) || dates[0].texte) : '',
    description: joindre(de('texte')),
    tags: techniques.length ? joindre(techniques).replace(/\n/g, ' ') : ''
  };
  return { champs, roles: (entree || []).map((l, i) => role.get(i) || 'autre') };
}

module.exports = { analyser, joindre, estDate, estVieAvecLieux, estAnglais };
