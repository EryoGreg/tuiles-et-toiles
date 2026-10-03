// Mes notes : boite d'edition de la note personnelle d'une tuile, ouverte
// depuis la tuile (jeu, revision, apercu). Masquee tant que la tuile n'est pas
// revelee : une note contient souvent la reponse (regle 2, comme la date).
import { useEffect, useRef, useState } from 'react';
import * as I from '../icones.jsx';

export function BoiteNote({ tuile, masquee, onFermer, onEnregistree }) {
  const [texte, setTexte] = useState(null);       // null = chargement
  const [initial, setInitial] = useState('');
  const [voir, setVoir] = useState(!masquee);
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState(null);
  const zone = useRef(null);

  useEffect(() => {
    let vivant = true;
    window.api.notes.lire(tuile.id).then((r) => {
      if (!vivant) return;
      setTexte(r.texte || ''); setInitial(r.texte || '');
      if (!r.texte) setVoir(true);   // rien a cacher
    });
    return () => { vivant = false; };
  }, [tuile.id]);
  useEffect(() => { if (voir && texte != null && zone.current) zone.current.focus(); }, [voir, texte != null]);

  const enregistrer = async () => {
    if (enCours) return;
    setEnCours(true);
    const r = await window.api.notes.ecrire(tuile.id, texte);
    setEnCours(false);
    if (r && r.erreur) { setErreur(r.erreur); return; }
    if (onEnregistree) onEnregistree(!!String(texte).trim());
    onFermer();
  };

  useEffect(() => {
    const clavier = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onFermer(); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) enregistrer();
    };
    window.addEventListener('keydown', clavier, true);
    return () => window.removeEventListener('keydown', clavier, true);
  });

  const change = texte != null && texte !== initial;
  return (
    <div className="recouvrement" onClick={onFermer}>
      <div className="boite-dialogue boite-note" onClick={(e) => e.stopPropagation()}>
        <h3>Ma note — #{tuile.ref}</h3>
        {texte == null ? (
          <div className="chargement">chargement…</div>
        ) : !voir ? (
          <div className="note-masquee">
            <p>Ta note peut contenir la réponse : elle reste cachée tant que la tuile n’est pas révélée.</p>
            <button className="bouton-neutre" onClick={() => setVoir(true)}><I.OeilBarre t={14} /> Afficher quand même</button>
          </div>
        ) : (
          <textarea
            ref={zone} className="editeur-textarea note-zone" value={texte} spellCheck
            placeholder="Ce que tu veux retenir : un moyen mnémotechnique, une confusion à éviter, un lien avec une autre œuvre…"
            onChange={(e) => { setTexte(e.target.value); setErreur(null); }}
          />
        )}
        {erreur && <div className="options-note" style={{ color: 'var(--revoir)' }}>{erreur}</div>}
        <div className="options-note">Personnelle et synchronisée entre tes appareils ; jamais affichée au tirage. Ctrl+Entrée pour enregistrer.</div>
        <div className="actions">
          <button className="bouton-neutre" onClick={onFermer}>Annuler</button>
          <button className="bouton-valide" onClick={enregistrer} disabled={!voir || !change || enCours}>
            <I.Coche t={14} /> {enCours ? 'Enregistrement…' : String(texte || '').trim() || !initial ? 'Enregistrer' : 'Effacer la note'}
          </button>
        </div>
      </div>
    </div>
  );
}
