// Decoupe d'App.jsx (etape 1 de Bristol) : code inchange, voir scripts/decouper-app.js.
import { useEffect } from 'react';
import * as I from '../icones.jsx';

export function EnChantier({ nom }) {
  return <div className="chargement">{nom} — à construire</div>;
}

/* ------------------------------------------------------ progression synchro */

// Etape en cours, compteur (images), temps ecoule : l'utilisateur voit que
// sa demande avance, sans avoir a changer d'onglet ni recliquer.
export function ProgressionSynchro({ p, titre }) {
  const s = Math.max(0, Math.round((Date.now() - (p.debut || Date.now())) / 1000));
  const duree = s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + String(s % 60).padStart(2, '0') + ' s';
  const reconnexion = p.etape === 'reconnexion';
  return (
    <div className={'drive-encours' + (reconnexion ? ' attente' : '')} role="status" aria-live="polite">
      <span className="drive-pastille" />
      <span>
        <strong>{titre}</strong> — {p.libelle || 'en cours…'}
        {p.total ? ' (' + p.faits + ' / ' + p.total + ')' : ''}
        <span className="progression-duree"> · {duree}</span>
      </span>
    </div>
  );
}

/* ------------------------------------------------------- rapport d'erreur */

// Un clic : le rapport (formulaire + journaux masques) part directement au
// script de reception, qui le transmet par mail. Apercu depliable avant envoi.
// Hors ligne : mis en attente, renvoye au prochain lancement.
// Choix unique en puces (remplace <select> : la liste native d'Android
// avait un air d'un autre temps). Groupe radio accessible, fleches comprises.
export function Puces({ etiquette, liste, valeur, onChoix }) {
  const clavier = (e, i) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const k = (i + d + liste.length) % liste.length;
    onChoix(liste[k].cle);
    const suivant = e.currentTarget.parentNode.children[k];
    if (suivant) suivant.focus();
  };
  return (
    <div className="puces" role="radiogroup" aria-labelledby={etiquette}>
      {liste.map((x, i) => (
        <button
          key={x.cle}
          type="button"
          role="radio"
          aria-checked={valeur === x.cle}
          tabIndex={valeur === x.cle || (!valeur && i === 0) ? 0 : -1}
          className={'puce' + (valeur === x.cle ? ' on' : '')}
          onClick={() => onChoix(x.cle)}
          onKeyDown={(e) => clavier(e, i)}
        >
          {valeur === x.cle && <I.Coche t={12} />} {x.libelle}
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------- confirmation */

// Boite de dialogue commune (fermeture de l'appli, effacement des marques…).
// Clic dehors ou Échap = Annuler.
// validerEntree : Entrée ou Espace (hors focus sur un bouton) valent « oui ».
// confirmerVariante : 'danger' (rouge, défaut) ou 'valide' (vert, action non destructive).
export function BoiteConfirmation({ titre, texteConfirmer, onAnnuler, onConfirmer, validerEntree = false, confirmerVariante = 'danger', children }) {
  useEffect(() => {
    const clavier = (e) => {
      if (e.key === 'Escape') { onAnnuler(); return; }
      if (!validerEntree) return;
      const surBouton = e.target && e.target.tagName === 'BUTTON';
      if (!surBouton && (e.key === 'Enter' || e.key === ' ' || e.code === 'Space')) {
        e.preventDefault();
        onConfirmer();
      }
    };
    window.addEventListener('keydown', clavier);
    return () => window.removeEventListener('keydown', clavier);
  }, [onAnnuler, onConfirmer, validerEntree]);

  return (
    <div className="recouvrement" onClick={onAnnuler}>
      <div className="boite-dialogue" onClick={(e) => e.stopPropagation()}>
        <h3>{titre}</h3>
        {children}
        <div className="actions">
          <button className="bouton-neutre" onClick={onAnnuler}>Annuler</button>
          {confirmerVariante === 'valide' ? (
            <button className="bouton-valide" onClick={onConfirmer}>
              <I.Coche t={14} /> {texteConfirmer}
            </button>
          ) : (
            <button className="bouton-danger" onClick={onConfirmer}>
              <I.Croix t={14} /> {texteConfirmer}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
