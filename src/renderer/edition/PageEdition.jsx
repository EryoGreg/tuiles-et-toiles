// Decoupe d'App.jsx (etape 1 de Bristol) : code inchange, voir scripts/decouper-app.js.
import { useEffect, useState, useContext, Fragment } from 'react';
import * as I from '../icones.jsx';
import { NavContext, SUR_MOBILE, coupe, editionEnAttente, useSession } from '../commun/base.jsx';
import { BoiteConfirmation } from '../commun/boites.jsx';
import { EditeurTuile } from './Editeur.jsx';
import { PageBibliotheque } from '../galeries/Galeries.jsx';

export function PageEdition({ onEtat }) {
  const [mode, setMode] = useState(null);   // null (choix) | 'creer' | 'liste' | 'journal' | { tuile }
  const [toast, setToast] = useState(null);
  const [demandeSuppr, setDemandeSuppr] = useState(null);   // la tuile a supprimer

  const notifier = (m) => { setToast(m); setTimeout(() => setToast(null), 6000); };

  // souris4 : dérouler l'état interne (dialogue -> éditeur -> liste -> accueil
  // Édition) avant de quitter la page.
  const { setRetour } = useContext(NavContext);
  useEffect(() => {
    let f = null;
    if (demandeSuppr) f = () => { setDemandeSuppr(null); return true; };
    else if (mode && mode.tuile) f = () => { setMode('liste'); return true; };
    else if (mode === 'creer' || mode === 'liste' || mode === 'journal') f = () => { setMode(null); return true; };
    setRetour(f);
    return () => setRetour(null);
  }, [mode, demandeSuppr]);

  const finiCreation = (r) => {
    setMode(null);
    if (onEtat) onEtat();
    notifier(r.masques === 0
      ? `Tuile #${r.ref} créée — 0 masque valide, elle n’apparaîtra pas au tirage.`
      : `Tuile #${r.ref} créée (${r.masques} masques valides).`);
  };
  // Apres une modification ou une suppression : retour a la liste des tuiles
  // (on en modifie souvent plusieurs d'affilee), pas a l'accueil d'Edition.
  const finiModif = (r) => {
    setMode('liste');
    if (onEtat) onEtat();
    notifier(`#${r.ref} enregistrée${r.masques === 0 ? ' — 0 masque valide' : ` (${r.masques} masques)`}.`);
  };
  const ouvrir = async (o) => {
    const t = await window.api.edition.tuile(o.id);
    if (t) setMode({ tuile: t });
  };
  // Arrivee depuis le menu contextuel d'une carte : editeur de cette tuile.
  useEffect(() => {
    if (!editionEnAttente.id) return;
    const id = editionEnAttente.id;
    editionEnAttente.id = null;
    ouvrir({ id });
  }, []);
  const confirmerSuppr = async () => {
    const t = demandeSuppr;
    setDemandeSuppr(null);
    await window.api.edition.supprimer(t.id);
    setMode('liste');
    if (onEtat) onEtat();
    notifier(`#${t.ref} mise à la corbeille.`);
  };

  if (mode === 'creer') {
    return <EditeurTuile mode="creer" onFini={finiCreation} onAnnuler={() => setMode(null)} />;
  }
  if (mode === 'journal') {
    return (
      <>
        <JournalModifs onOuvrir={ouvrir} />
        <button className="edition-retour" onClick={() => setMode(null)}>
          <I.Fleche t={16} retour /> Retour
        </button>
      </>
    );
  }
  if (mode === 'liste') {
    return (
      <>
        <PageBibliotheque onEtat={onEtat} onChoisirTuile={ouvrir} />
        <button className="edition-retour" onClick={() => setMode(null)}>
          <I.Fleche t={16} retour /> Retour
        </button>
        {toast && <div className="edition-toast" role="status"><I.Coche t={14} /> {toast}</div>}
      </>
    );
  }
  if (mode && mode.tuile) {
    return (
      <>
        <EditeurTuile
          mode="modifier"
          tuile={mode.tuile}
          onFini={finiModif}
          onAnnuler={() => setMode('liste')}
          onSupprimer={setDemandeSuppr}
        />
        {demandeSuppr && (
          <BoiteConfirmation
            titre={demandeSuppr.estLocale ? 'Suppression de la tuile locale' : 'Suppression de la tuile'}
            texteConfirmer="CONFIRMER"
            onAnnuler={() => setDemandeSuppr(null)}
            onConfirmer={confirmerSuppr}
          >
            {!demandeSuppr.estLocale && (
              <p>
                Cette tuile fait partie d’un pack : elle disparaîtra du jeu et de la
                Bibliothèque. Cette action n’est pas conseillée.
              </p>
            )}
            <p>
              Elle part dans la <strong>Corbeille</strong>, avec ses marques
              {demandeSuppr.estLocale
                ? ' : tu pourras la restaurer pendant 90 jours, ensuite son contenu est effacé définitivement.'
                : ' : tu pourras la restaurer à tout moment.'}
            </p>
          </BoiteConfirmation>
        )}
      </>
    );
  }

  return (
    <div className="galerie" style={{ '--accent': 'var(--laiton)' }}>
      <div className="galerie-tete">
        <span className="galerie-icone"><I.Crayon t={22} /></span>
        <div>
          <h2>Édition</h2>
          <div className="soustitre">Tes ajouts et corrections locales — jamais dans le pack, exportables</div>
        </div>
      </div>

      {toast && <div className="options-confirmation"><I.Coche t={14} /> {toast}</div>}

      <div className="edition-choix">
        <button className="carte" onClick={() => setMode('creer')}>
          <span className="pastille"><I.Crayon t={22} /></span>
          <span>
            <div className="nom">Créer une tuile</div>
            <div className="desc">Champs vides, à remplir librement</div>
            {/* Sur mobile, la ligne de boutons de l'editeur n'a pas la place de le dire. */}
            {SUR_MOBILE && <div className="desc">Tuile locale — jamais envoyée au pack, exportable</div>}
          </span>
        </button>
        <button className="carte" onClick={() => setMode('liste')}>
          <span className="pastille"><I.Bibliotheque t={22} /></span>
          <span>
            <div className="nom">Modifier ou supprimer</div>
            <div className="desc">Choisir une tuile dans la liste</div>
          </span>
        </button>
        <button className="carte" onClick={() => setMode('journal')}>
          <span className="pastille"><I.Rafraichir t={22} /></span>
          <span>
            <div className="nom">Journal des modifications</div>
            <div className="desc">Tout ce qui a changé, où et quand, sur tous tes appareils</div>
          </span>
        </button>
      </div>
    </div>
  );
}

// Toutes les modifications (journal de synchro), plus recentes d'abord,
// regroupees par action. Clic sur une tuile encore visible : l'editeur.
export function JournalModifs({ onOuvrir }) {
  const [entrees, setEntrees] = useState(null);
  const [suite, setSuite] = useState(null);
  const [q, setQ] = useSession('edition:journal:recherche', '');
  const [ouverte, setOuverte] = useState(null);
  const [charge, setCharge] = useState(false);

  useEffect(() => {
    window.api.edition.journal({}).then((r) => { setEntrees(r.entrees); setSuite(r.suite); });
  }, []);
  const plus = async () => {
    setCharge(true);
    const r = await window.api.edition.journal({ avant: suite });
    setEntrees((l) => [...l, ...r.entrees]); setSuite(r.suite); setCharge(false);
  };
  const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const filtre = norm(q.trim());
  const visibles = entrees && (filtre
    ? entrees.filter((e) => norm('#' + e.ref + ' ' + e.titre + ' ' + e.appareil + ' ' + e.actions.join(' ')
      + ' ' + e.champs.map((c) => c.libelle + ' ' + (c.valeur || '')).join(' ')).includes(filtre))
    : entrees);
  const jour = (iso) => new Date(iso).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const heure = (iso) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

  let jourCourant = null;
  return (
    <div className="galerie" style={{ '--accent': 'var(--laiton)' }}>
      <div className="galerie-tete">
        <span className="galerie-icone"><I.Rafraichir t={22} /></span>
        <div>
          <h2>Journal des modifications</h2>
          <div className="soustitre">
            Tout ce qui a changé sur tes tuiles, sur tous tes appareils. Clic sur une entrée pour le
            détail ; « Ouvrir » pour modifier la tuile.
          </div>
        </div>
      </div>
      <input className="biblio-recherche journal-recherche" placeholder="Filtrer : numéro, titre, appareil, champ…"
        value={q} onChange={(e) => setQ(e.target.value)} />

      {!visibles ? <div className="chargement">chargement…</div> : !visibles.length ? (
        <div className="galerie-vide">{filtre ? 'Aucun résultat.' : 'Aucune modification pour l’instant.'}</div>
      ) : (
        <div className="journal">
          {visibles.map((e) => {
            const j = jour(e.le);
            const titreJour = j !== jourCourant ? (jourCourant = j) : null;
            const resume = [
              ...e.actions,
              ...(e.champs.length && !e.actions.includes('créée') ? [e.champs.map((c) => c.libelle).join(', ')] : []),
              ...e.marques.map((m) => (m.pose ? 'marquée ' : 'marque retirée : ') + m.nom)
            ].join(' · ');
            return (
              <Fragment key={e.id}>
                {titreJour && <div className="journal-jour">{titreJour}</div>}
                <div className={'journal-entree' + (ouverte === e.id ? ' ouverte' : '')}
                  onClick={() => setOuverte(ouverte === e.id ? null : e.id)}>
                  <span className="journal-heure">{heure(e.le)}</span>
                  {e.image ? <img className="journal-vignette" src={e.image} alt="" loading="lazy" />
                    : <span className="journal-vignette journal-vignette-vide" />}
                  <div className="journal-corps">
                    <div className="journal-ligne">
                      <span className="numero">#{e.ref}</span> <span className="journal-titre">{e.titre || '—'}</span>
                    </div>
                    <div className="journal-resume">{resume}</div>
                    <div className="journal-qui">{e.appareil}</div>
                    {ouverte === e.id && e.champs.length > 0 && (
                      <div className="journal-detail">
                        {e.champs.map((c, i) => (
                          <div key={i} className="journal-champ">
                            <span className="etiquette">{c.libelle}</span>
                            {c.image ? <span>image changée</span> : (
                              <span>
                                {c.avant != null && !e.actions.includes('créée') && (
                                  <span className="journal-avant">{coupe(c.avant) || '(vide)'} → </span>
                                )}
                                {c.duPack ? 'valeur du pack' : (coupe(c.valeur, 400) || '(vide)')}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  {e.visible ? (
                    <button className="bouton-neutre" onClick={(ev) => { ev.stopPropagation(); onOuvrir({ id: e.cle }); }}>
                      Ouvrir
                    </button>
                  ) : <span className="journal-absente">{e.estLocale ? 'en corbeille ou effacée' : 'archivée'}</span>}
                </div>
              </Fragment>
            );
          })}
          {suite && !filtre && (
            <button className="bouton-neutre journal-plus" onClick={plus} disabled={charge}>
              {charge ? 'Chargement…' : 'Plus ancien…'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
