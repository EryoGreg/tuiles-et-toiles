'use strict';
/**
 * Lecture d'un cartel de musee (photo -> texte), par le module natif
 * LectureTexte (LectureTextePlugin.java, Google ML Kit, hors ligne).
 *
 *   preparer()  au lancement, en Wi-Fi : fait telecharger le modele de
 *               lecture par les services Google s'il manque (une fois).
 *   lire(src)   'camera' | 'galerie' -> { lignes, blocs, largeur, hauteur,
 *               ms } ; la photo n'est ni gardee ni envoyee.
 *
 * Les lignes sont rendues dans l'ordre de lecture de ML Kit, avec leur bloc,
 * leur cadre et leur hauteur : de quoi deviner plus tard quel texte va dans
 * quel champ (taille, position). Chaque lecture est journalisee (texte
 * compris : un cartel n'a rien de personnel) pour regler ces regles sur de
 * vrais cartels via « Signaler un probleme ».
 */

const journal = require('../main/journal');
const { analyser } = require('../main/cartel-analyse');

let etat = { disponible: null, erreur: null };   // null = pas encore su

function natif() {
  const C = typeof window !== 'undefined' && window.Capacitor;
  if (!C || !C.isNativePlatform || !C.isNativePlatform()) return null;
  return C.registerPlugin('LectureTexte');
}

async function preparer({ reseauPermis }) {
  const L = natif();
  if (!L) { etat = { disponible: false, erreur: 'Lecture de cartel disponible dans l’appli Android.' }; return etat; }
  try {
    const e = await L.etat();
    if (e.disponible) { etat = { disponible: true, erreur: null }; return etat; }
    if (!reseauPermis()) {
      etat = { disponible: false, erreur: null };
      journal.evt('cartel', 'modele-attente-wifi');
      return etat;
    }
    const t0 = Date.now();
    const r = await L.preparer();
    etat = { disponible: true, erreur: null };
    journal.evt('cartel', 'modele-pret', { dejaLa: r.dejaLa, ms: Date.now() - t0 });
  } catch (e) {
    etat = { disponible: false, erreur: (e && e.message) || String(e) };
    journal.erreur('cartel', 'modele', e);
  }
  return etat;
}

async function prendre(source) {
  const { Camera } = require('@capacitor/camera');
  if (source === 'galerie') {
    const r = await Camera.chooseFromGallery({ limit: 1, correctOrientation: true });
    const m = r && r.results && r.results[0];
    return m && (m.uri || m.webPath);
  }
  const r = await Camera.takePhoto({ quality: 90, correctOrientation: true });
  return r && (r.uri || r.webPath);
}

async function lire(source) {
  const L = natif();
  if (!L) return { erreur: 'La lecture de cartel est disponible dans l’appli Android.' };
  let uri;
  try { uri = await prendre(source); }
  catch (e) {
    if (/cancel|annul/i.test(String(e && e.message))) return null;   // l'utilisateur a renonce
    journal.erreur('cartel', 'photo', e, { source });
    return { erreur: 'Photo impossible : ' + ((e && e.message) || e) };
  }
  if (!uri) return null;

  // Modele encore absent (premier usage, pas de Wi-Fi jusqu'ici) : un geste
  // explicite autorise le telechargement, meme en donnees mobiles.
  if (!etat.disponible) {
    const p = await preparer({ reseauPermis: () => true });
    if (!p.disponible) {
      return { erreur: 'Le modèle de lecture n’est pas encore sur le téléphone (connexion nécessaire une première fois). ' + (p.erreur || '') };
    }
  }

  try {
    const r = await L.lire({ uri });
    const lignes = [];
    // Ordre de lecture : blocs de haut en bas (ML Kit ne le garantit pas).
    const blocs = (r.blocs || []).slice().sort((a, b) => ((a.cadre && a.cadre.y) || 0) - ((b.cadre && b.cadre.y) || 0));
    blocs.forEach((b, ib) => (b.lignes || []).forEach((l) => lignes.push({
      texte: l.texte, bloc: ib, cadre: l.cadre, hauteur: l.hauteurMoyenne,
      confiance: Math.round((l.confiance || 0) * 100) / 100, angle: Math.round(l.angle || 0)
    })));
    // Proposition de rangement : l'editeur la montre, l'utilisateur corrige.
    const { champs, roles } = analyser(lignes);
    lignes.forEach((l, i) => { l.role = roles[i]; });
    journal.evt('cartel', 'lu', {
      source, ms: r.ms, largeur: r.largeur, hauteur: r.hauteur, blocs: (r.blocs || []).length,
      lignes: lignes.map((l) => ({ t: l.texte, r: l.role, b: l.bloc, h: l.hauteur, y: l.cadre && l.cadre.y, x: l.cadre && l.cadre.x, c: l.confiance })),
      propose: champs
    });
    return { lignes, proposition: champs, largeur: r.largeur, hauteur: r.hauteur, ms: r.ms };
  } catch (e) {
    journal.erreur('cartel', 'lecture', e, { source });
    return { erreur: (e && e.message) || String(e) };
  }
}

module.exports = { preparer, lire, etat: () => etat };
