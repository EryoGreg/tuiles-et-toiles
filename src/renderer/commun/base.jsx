// Decoupe d'App.jsx (etape 1 de Bristol) : code inchange, voir scripts/decouper-app.js.
import { useState, useCallback, useRef, createContext } from 'react';

// Densite de la grille des galeries (tuiles visibles par ligne). Reglage
// global, cycle 5 -> 7 -> 9 -> 5, pilote par le bouton de BarreFiltres.
export const GrilleContext = createContext({ colonnes: 5, cycler: () => {} });

// Tuiles par ligne dans les galeries. Mobile : 2 / 3 / 4 (un telephone ne
// lit rien a 5). `window.api.urlTuile` n'existe que dans l'appli mobile.
export const DENSITES = (typeof window !== 'undefined' && window.api && window.api.urlTuile) ? [2, 3, 4] : [5, 7, 9];

// Reglage hors de la liste (ancienne valeur, ou venue de l'autre forme) : la plus proche.
export const densiteValide = (n) => DENSITES.reduce((m, d) => (Math.abs(d - n) < Math.abs(m - n) ? d : m), DENSITES[0]);

// Retour « intra-page » : une page ayant un état interne (aperçu ouvert,
// éditeur, partie en cours) enregistre ici un gestionnaire. souris4 le
// consulte AVANT de reculer dans l'historique des pages — sinon un aperçu
// ouvert dans Livre renverrait direct à la page précédente au lieu de se
// refermer. Le gestionnaire renvoie true s'il a absorbé le retour.
export const NavContext = createContext({ setRetour: () => {} });

// Tuile a ouvrir dans l'editeur a l'arrivee sur Edition (menu contextuel).
// Un objet : un import ES ne se reassigne pas depuis un autre module.
export const editionEnAttente = { id: null };

/* ---------------------------------------------------- preferences d'affichage */

// Tri, sens et filtres de chaque page : gardes d'un onglet a l'autre ET d'un
// lancement a l'autre (reglage « prefs_affichage » de cet appareil, non
// synchronise). Charges une fois avant le premier affichage des pages (App),
// donc lus de facon synchrone : pas de clignotement a l'ouverture.
export const PREFS = { valeurs: {}, charge: false, minuteur: null };

export function chargerPrefs(v) {
  if (PREFS.charge) return;   // ensuite, la memoire fait foi (ecriture differee)
  PREFS.valeurs = v && typeof v === 'object' ? v : {};
  PREFS.charge = true;
}

export function enregistrerPrefs() {
  clearTimeout(PREFS.minuteur);
  PREFS.minuteur = setTimeout(() => {
    window.api.reglages.definir('prefs_affichage', JSON.stringify(PREFS.valeurs));
  }, 300);
}

/** Comme useState, mais la valeur survit au changement d'onglet et au redemarrage. */
export function usePref(cle, defaut) {
  const [v, setV] = useState(() => (cle in PREFS.valeurs ? PREFS.valeurs[cle] : defaut));
  const courant = useRef(v);
  const poser = useCallback((x) => {
    const n = typeof x === 'function' ? x(courant.current) : x;
    courant.current = n;
    PREFS.valeurs = { ...PREFS.valeurs, [cle]: n };
    enregistrerPrefs();
    setV(n);
  }, [cle]);
  return [v, poser];
}

// Texte de recherche : garde en changeant d'onglet, oublie au redemarrage
// (une vieille recherche oubliee ferait croire a une page vide).
export const MEMOIRE_SESSION = new Map();

export function useSession(cle, defaut) {
  const [v, setV] = useState(() => (MEMOIRE_SESSION.has(cle) ? MEMOIRE_SESSION.get(cle) : defaut));
  const poser = useCallback((x) => {
    setV((ancien) => {
      const n = typeof x === 'function' ? x(ancien) : x;
      MEMOIRE_SESSION.set(cle, n);
      return n;
    });
  }, [cle]);
  return [v, poser];
}

/* ----------------------------------------------- apercu (tuile agrandie) */

// Ordre d'affichage des pastilles de tag sur une carte : livre, etoile,
// a-revoir — le meme que le rail du jeu.
// Adresse d'une image de tuile : protocole tuile:// sur PC ; le pont mobile
// fournit sa propre traduction (pas de protocole personnalise en WebView).
// Appli mobile : le pont mobile fournit urlTuile (voir src/mobile/principal.js).
export const SUR_MOBILE = !!(typeof window !== 'undefined' && window.api && window.api.urlTuile);

export const urlTuile = (nom) => (window.api && window.api.urlTuile ? window.api.urlTuile(nom) : 'tuile://' + nom);

/* ------------------------------------------------ journal des modifications */

export const coupe = (s, n = 140) => (s && s.length > n ? s.slice(0, n) + '…' : s);

// Resume d'une synchro ou d'un import en mots (echange.resumer).
export function direChangements(s, images) {
  const l = [];
  const n = (k, un, plusieurs) => { if (s && s[k]) l.push(s[k] + ' ' + (s[k] > 1 ? plusieurs : un)); };
  n('tuilesNouvelles', 'nouvelle tuile', 'nouvelles tuiles');
  n('tuilesModifiees', 'tuile modifiée', 'tuiles modifiées');
  n('tuilesSupprimees', 'tuile supprimée', 'tuiles supprimées');
  n('tuilesRestaurees', 'tuile restaurée', 'tuiles restaurées');
  n('oeuvresCorrigees', 'œuvre corrigée', 'œuvres corrigées');
  n('marques', 'marque', 'marques');
  n('archives', 'archivage', 'archivages');
  n('revisions', 'note de révision', 'notes de révision');
  if (images) l.push(images + ' image' + (images > 1 ? 's' : ''));
  return l.join(', ');
}

// « Envoyé : … Reçu : … » d'un bilan de synchro (service.js).
// Recharge la page une fois la base enregistree (mobile : sinon la page
// repart de la derniere sauvegarde et perd ce que la synchro vient d'apporter).
export async function recharger() {
  try { await window.api.persister(); } catch { /* PC ancien / navigateur : rien a attendre */ }
  window.location.reload();
}

export function phraseBilan(r) {
  // Bilan d'avant les resumes (0.2.2 et avant) : compte d'ops seulement. Un
  // bilan recent sans resume (envoye: null) n'a envoye que des compteurs de
  // vues : ne pas l'annoncer comme des modifications.
  if (!('envoye' in r) && !('recu' in r) && (r.poussees || r.appliquees)) {
    return (r.poussees || 0) + ' modification(s) envoyée(s), ' + (r.appliquees || 0) + ' reçue(s).';
  }
  const envoye = direChangements(r.envoye, r.imagesEnvoyees);
  const recu = direChangements(r.recu, r.imagesRecues);
  return !envoye && !recu ? 'Tout était déjà à jour.'
    : [envoye && 'Envoyé : ' + envoye + '.', recu && 'Reçu : ' + recu + '.'].filter(Boolean).join(' ');
}

/* ---------------------------------------------------------------- conflits */

export const dateCourte = (iso) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

export const texteValeur = (v, champ) => (v == null || v === '' ? '(vide)' : champ === 'image' ? 'une image' : String(v));

export const enMo = (octets) => Math.round(octets / 1048576) + ' Mo';

export function pourcent(p) {
  return p && p.total ? Math.floor((p.recu / p.total) * 100) : 0;
}
