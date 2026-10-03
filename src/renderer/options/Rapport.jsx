// Decoupe d'App.jsx (etape 1 de Bristol) : code inchange, voir scripts/decouper-app.js.
import { useEffect, useState } from 'react';
import * as I from '../icones.jsx';
import { Puces } from '../commun/boites.jsx';

export function FormulaireRapport({ onFermer }) {
  const [choix, setChoix] = useState(null);
  const [f, setF] = useState({ sujet: '', depuis: '', reproductible: '', description: '', email: '' });
  const [apercu, setApercu] = useState(null);
  const [occupe, setOccupe] = useState(false);
  const [fini, setFini] = useState(null);       // resultat de l'envoi
  const [msg, setMsg] = useState(null);

  useEffect(() => { window.api.rapport.choix().then(setChoix); }, []);
  useEffect(() => {
    const clavier = (e) => { if (e.key === 'Escape') onFermer(); };
    window.addEventListener('keydown', clavier);
    return () => window.removeEventListener('keydown', clavier);
  }, [onFermer]);

  const set = (k) => (e) => { setF((x) => ({ ...x, [k]: e.target.value })); setApercu(null); };
  const choisir = (k) => (v) => { setF((x) => ({ ...x, [k]: v })); setApercu(null); };
  const complet = f.sujet && f.depuis && f.reproductible;
  const voir = async (e) => { if (e.target.open && !apercu) setApercu(await window.api.rapport.apercu(f)); };

  const envoyer = async () => {
    setOccupe(true); setMsg(null);
    const r = await window.api.rapport.envoyer(f);
    setOccupe(false);
    if (r.erreur && !r.enAttente) { setMsg({ erreur: r.erreur }); return; }
    setFini(r);
  };
  const copier = async () => {
    await window.api.rapport.copier(f);
    setMsg({ ok: 'Texte du rapport copié : colle-le dans un mail à ' + choix.destinataire + '.' });
  };

  if (fini) {
    return (
      <div className="recouvrement" onClick={onFermer}>
        <div className="boite-dialogue boite-rapport" onClick={(e) => e.stopPropagation()}>
          <h3>{fini.ok ? 'Rapport envoyé' : fini.enAttente ? 'Rapport mis de côté' : 'Messagerie ouverte'}</h3>
          <p>
            {fini.ok && <>Merci ! Le rapport <strong>{fini.id}</strong> est parti avec le journal complet.</>}
            {fini.enAttente && <>Pas de connexion pour l’instant ({fini.erreur}). Le rapport <strong>{fini.id}</strong> partira
              tout seul au prochain lancement de l’application.</>}
            {fini.secours && <>L’envoi direct n’est pas encore configuré : ta messagerie s’est ouverte avec le rapport
              (texte seul, sans le journal complet). Il ne reste qu’à cliquer « Envoyer ».</>}
          </p>
          <div className="actions">
            <button className="bouton-valide" onClick={onFermer}><I.Coche t={14} /> Fermer</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="recouvrement" onClick={onFermer}>
      <div className="boite-dialogue boite-rapport" onClick={(e) => e.stopPropagation()}>
        <h3>Envoyer le log pour rapport d’erreur</h3>
        {!choix ? <p>Chargement…</p> : (
          <>
            <div className="rapport-champ">
              <span id="rapport-sujet">Quel est le problème ?</span>
              <Puces etiquette="rapport-sujet" liste={choix.sujets} valeur={f.sujet} onChoix={choisir('sujet')} />
            </div>
            <div className="rapport-champ">
              <span id="rapport-depuis">Depuis quand ?</span>
              <Puces etiquette="rapport-depuis" liste={choix.depuis} valeur={f.depuis} onChoix={choisir('depuis')} />
            </div>
            <div className="rapport-champ">
              <span id="rapport-reproductible">Le problème se reproduit-il ?</span>
              <Puces etiquette="rapport-reproductible" liste={choix.reproductible} valeur={f.reproductible} onChoix={choisir('reproductible')} />
            </div>
            <label className="rapport-champ">
              <span>Que s’est-il passé ? Qu’attendais-tu ? <em>(facultatif)</em></span>
              <textarea className="editeur-textarea rapport-description" value={f.description} onChange={set('description')}
                placeholder="Ex. : j’ai glissé une photo nommée « Москва.jpg », rien ne s’est affiché." spellCheck />
            </label>
            <label className="rapport-champ">
              <span>Ton email, pour qu’on puisse te répondre <em>(facultatif)</em></span>
              <input className="editeur-input" type="email" value={f.email} onChange={set('email')} />
            </label>

            {complet && (
              <details className="rapport-apercu" onToggle={voir}>
                <summary>Voir ce qui sera envoyé</summary>
                {!apercu ? <p>Préparation…</p> : apercu.erreur ? <p>{apercu.erreur}</p> : (
                  <>
                    <pre>{'Objet : ' + apercu.objet + '\n\n' + apercu.corps}</pre>
                    <p>
                      Journaux joints : {apercu.journaux.map((j) => j.nom + ' (' + Math.round(j.octets / 1024) + ' Ko)').join(', ')}
                      {' '}— nom d’utilisateur Windows, nom de l’ordinateur et emails masqués.
                    </p>
                  </>
                )}
              </details>
            )}

            {choix.enAttente > 0 && (
              <div className="options-note">{choix.enAttente} rapport(s) précédent(s) en attente : ils repartiront au prochain lancement.</div>
            )}
            {msg && msg.ok && <div className="options-confirmation"><I.Coche t={14} /> {msg.ok}</div>}
            {msg && msg.erreur && <div className="options-note" style={{ color: 'var(--revoir)' }}>{msg.erreur}</div>}
            <div className="actions rapport-actions">
              <button className="bouton-neutre" onClick={copier} disabled={!complet}>Copier le texte</button>
              <button className="bouton-neutre" onClick={onFermer}>Annuler</button>
              <button className="bouton-valide" onClick={envoyer} disabled={!complet || occupe}>
                <I.Coche t={14} /> {occupe ? 'Envoi…' : choix.envoiDirect ? 'Envoyer le rapport' : 'Ouvrir ma messagerie'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
