// Decoupe d'App.jsx (etape 1 de Bristol) : code inchange, voir scripts/decouper-app.js.
import { useEffect, useState } from 'react';
import * as I from '../icones.jsx';
import { dateCourte, texteValeur } from '../commun/base.jsx';

// Conflits de synchro : le meme champ modifie sur deux appareils sans que
// l'un ait vu l'autre, ou une tuile supprimee ici et modifiee la-bas. La
// valeur la plus recente est affichee en attendant ; rien ne bloque.
export function PageConflits({ onEtat }) {
  const [liste, setListe] = useState(null);
  const [enCours, setEnCours] = useState(null);
  const [verif, setVerif] = useState(true);   // synchro d'ouverture en cours

  // Liste locale tout de suite, puis synchro : un conflit deja tranche sur
  // un autre appareil disparait. Et a la fin de chaque synchro, relecture.
  useEffect(() => {
    let vivant = true;
    window.api.conflits.liste().then((l) => { if (vivant) setListe(l); });
    window.api.conflits.actualiser().then((r) => {
      if (!vivant) return;
      setListe(r.conflits); setVerif(false); onEtat();
    });
    const desab = window.api.synchro.onProgression((p) => {
      if (!p.enCours && vivant) window.api.conflits.liste().then((l) => { if (vivant) setListe(l); });
    });
    return () => { vivant = false; desab(); };
  }, []);

  const trancher = async (id, choix) => {
    setEnCours(id);
    setListe(await window.api.conflits.trancher(id, choix));
    setEnCours(null);
    onEtat();
  };

  return (
    <div className="galerie" style={{ '--accent': 'var(--revoir)' }}>
      <div className="galerie-tete">
        <span className="galerie-icone"><I.Echange t={22} /></span>
        <div>
          <h2>Conflits</h2>
          <div className="soustitre">
            Modifications faites sur deux appareils sans qu’ils se soient vus, ou champs que tu avais
            corrigés et qu’une mise à jour du pack a changés. En attendant ton choix, la version
            marquée « affichée » reste. Chaque choix part aussitôt vers tes autres appareils.
          </div>
          {verif && <div className="soustitre">Vérification auprès de tes autres appareils…</div>}
        </div>
      </div>

      {!liste ? <div className="chargement">chargement…</div> : !liste.length ? (
        <div className="conflits-vide"><I.Coche t={18} /> Aucun conflit : tous tes appareils sont d’accord.</div>
      ) : (
        <div className="conflits">
          {liste.map((c) => (
            <div key={c.id} className="conflit">
              <div className="conflit-tete">
                <span className="conflit-oeuvre">{c.oeuvre.ref ? '#' + c.oeuvre.ref + ' ' : ''}« {c.oeuvre.titre} »</span>
                <span className="conflit-champ">
                  {c.type === 'suppression' ? 'supprimée ici, modifiée là-bas'
                    : c.type === 'pack' ? c.libelle + ' — corrigé par toi, changé par la mise à jour du pack' : c.libelle}
                </span>
              </div>
              {c.type === 'pack' ? (
                <div className="conflit-versions">
                  <Version titre="Ta correction" actuelle
                    texte={texteValeur(c.correction, c.champ)} bouton="Garder ma correction"
                    occupe={enCours === c.id} onChoisir={() => trancher(c.id, 'gagnant')} />
                  <Version titre="Nouvelle version du pack"
                    texte={texteValeur(c.nouveauPack, c.champ)}
                    note={'Avant la mise à jour, le pack disait : ' + texteValeur(c.ancienPack, c.champ)}
                    bouton="Prendre celle du pack"
                    occupe={enCours === c.id} onChoisir={() => trancher(c.id, 'perdant')} />
                </div>
              ) : c.type === 'suppression' ? (
                <div className="conflit-versions">
                  <Version
                    titre={(c.supprimee ? 'Supprimée' : 'Restaurée') + ' sur ' + c.gagnant.nomAppareil}
                    date={c.gagnant.le} actuelle
                    texte={c.supprimee ? 'La tuile n’apparaît plus.' : 'La tuile est visible.'}
                    bouton={c.supprimee ? 'Garder supprimée' : 'Garder la tuile'}
                    occupe={enCours === c.id} onChoisir={() => trancher(c.id, 'gagnant')}
                  />
                  <Version
                    titre={(c.perdant.champ === '_existe' ? (c.supprimee ? 'Restaurée' : 'Supprimée') : 'Modifiée')
                      + ' sur ' + c.perdant.nomAppareil}
                    date={c.perdant.le}
                    texte={c.perdant.champ === '_existe'
                      ? (c.supprimee ? 'La tuile est visible.' : 'La tuile n’apparaît plus.')
                      : (c.perdant.libelleChamp || 'Champ') + ' : ' + texteValeur(c.perdant.valeur, c.perdant.champ)}
                    bouton={c.supprimee ? 'Restaurer la tuile' : 'Supprimer la tuile'}
                    occupe={enCours === c.id} onChoisir={() => trancher(c.id, 'perdant')}
                  />
                </div>
              ) : (
                <div className="conflit-versions">
                  <Version titre={c.gagnant.nomAppareil} date={c.gagnant.le} actuelle
                    texte={texteValeur(c.gagnant.valeur, c.champ)} bouton="Garder celle-ci"
                    occupe={enCours === c.id} onChoisir={() => trancher(c.id, 'gagnant')} />
                  <Version titre={c.perdant.nomAppareil} date={c.perdant.le}
                    texte={texteValeur(c.perdant.valeur, c.champ)} bouton="Garder celle-ci"
                    occupe={enCours === c.id} onChoisir={() => trancher(c.id, 'perdant')} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Version({ titre, date, texte, note, bouton, actuelle, occupe, onChoisir }) {
  return (
    <div className={'conflit-version' + (actuelle ? ' actuelle' : '')}>
      <div className="conflit-qui">{titre}{actuelle && <span className="conflit-badge">affichée</span>}</div>
      {date && <div className="conflit-quand">{dateCourte(date)}</div>}
      <div className="conflit-valeur">{texte}</div>
      {note && <div className="conflit-quand">{note}</div>}
      <button className="bouton-neutre" onClick={onChoisir} disabled={occupe}><I.Coche t={14} /> {bouton}</button>
    </div>
  );
}
