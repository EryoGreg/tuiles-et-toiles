// Decoupe d'App.jsx (etape 1 de Bristol) : code inchange, voir scripts/decouper-app.js.
import { useEffect, useState } from 'react';
import * as I from '../icones.jsx';
import { PastilleConflit } from '../tuile/Cartes.jsx';

/* --------------------------------------------------------------- corbeille */

// Tuiles supprimees (encore restaurables) et oeuvres du pack archivees.
// Restaurer = une modification ordinaire : elle part a la prochaine synchro.
export function PageCorbeille({ onEtat }) {
  const [liste, setListe] = useState(null);
  const [enCours, setEnCours] = useState(null);
  const [msg, setMsg] = useState(null);

  useEffect(() => { window.api.corbeille.liste().then(setListe); }, []);

  const restaurer = async (o) => {
    setEnCours(o.id); setMsg(null);
    const r = await window.api.corbeille.restaurer(o.id);
    setEnCours(null);
    if (r.erreur) { setMsg({ erreur: r.erreur }); setListe(await window.api.corbeille.liste()); return; }
    setListe(r.liste);
    setMsg({ ok: '#' + (r.ref || o.ref) + ' restaurée.' });
    onEtat();
  };
  const jour = (iso) => new Date(iso).toLocaleDateString('fr-FR', { dateStyle: 'long' });

  return (
    <div className="galerie" style={{ '--accent': 'var(--discret)' }}>
      <div className="galerie-tete">
        <span className="galerie-icone"><I.Corbeille t={22} /></span>
        <div>
          <h2>Corbeille</h2>
          <div className="soustitre">
            Tuiles supprimées, avec leurs marques. Une tuile que tu as créée reste restaurable
            90 jours ; une œuvre du pack, toujours. La restauration part vers tes autres appareils
            à la prochaine synchro.
          </div>
        </div>
        <span className="galerie-compte">{liste ? liste.length : '…'}</span>
      </div>

      {msg && msg.ok && <div className="options-confirmation"><I.Coche t={14} /> {msg.ok}</div>}
      {msg && msg.erreur && <div className="options-note" style={{ color: 'var(--revoir)' }}>{msg.erreur}</div>}

      {!liste ? <div className="chargement">chargement…</div> : !liste.length ? (
        <div className="galerie-vide">La corbeille est vide.</div>
      ) : (
        <div className="galerie-grille">
          {liste.map((o) => (
            <div key={o.id} className="carte-galerie carte-corbeille">
              {o.image
                ? <img className="carte-galerie-image" src={o.image} alt="" loading="lazy" />
                : <div className="carte-galerie-image carte-galerie-image-vide" />}
              <div className="carte-galerie-corps">
                <span className="numero">#{o.ref}{o.estLocale ? '' : ' · pack'}{o.conflit && <PastilleConflit />}</span>
                <div className="carte-galerie-titre">{o.titre || '—'}</div>
                <div className="carte-galerie-artiste">{o.artiste || '—'}{o.date ? ' · ' + o.date : ''}</div>
                <div className="corbeille-dates">
                  Supprimée le {jour(o.supprimeeLe)}
                  {o.effaceeLe && <><br />Effacée définitivement le {jour(o.effaceeLe)}</>}
                </div>
                <button className="bouton-neutre corbeille-restaurer" onClick={() => restaurer(o)} disabled={enCours === o.id}>
                  <I.Rafraichir t={14} /> {enCours === o.id ? 'Restauration…' : 'Restaurer'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
