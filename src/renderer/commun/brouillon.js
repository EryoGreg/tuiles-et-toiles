// Brouillon de l'editeur, range juste avant d'ouvrir l'appareil photo (mobile).
// Android peut tuer l'appli pendant la prise de vue (telephone a court de
// memoire) : au redemarrage, App.jsx le trouve, rouvre l'editeur tel quel et
// l'editeur reprend la photo (window.api.edition.photoReprise / lireCartel('reprise')).
// localStorage : survit a la mort du processus ; facultatif (try/catch partout).

const CLE = 'tt-brouillon-editeur';
const DUREE_MAX = 60 * 60 * 1000;   // plus vieux : abandonne

// b = { mode: 'creer' | 'modifier', tuileId, champs, note, idCree, attente: 'photo' | 'cartel' }
export function rangerBrouillon(b) {
  try { localStorage.setItem(CLE, JSON.stringify({ ...b, le: Date.now() })); } catch { /* stockage indisponible */ }
}

export function effacerBrouillon() {
  try { localStorage.removeItem(CLE); } catch { /* rien */ }
}

// Lu une seule fois (efface aussitot) : un second redemarrage ne le rejoue pas.
export function prendreBrouillon() {
  let b = null;
  try { b = JSON.parse(localStorage.getItem(CLE) || 'null'); } catch { b = null; }
  effacerBrouillon();
  if (!b || typeof b !== 'object' || !b.champs || !(Date.now() - (b.le || 0) < DUREE_MAX)) return null;
  return b;
}
