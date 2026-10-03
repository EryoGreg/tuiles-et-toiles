// Decoupe d'App.jsx (etape 1 de Bristol) : code inchange, voir scripts/decouper-app.js.
import { useEffect, useState } from 'react';
import * as I from '../icones.jsx';
import { SUR_MOBILE, enMo } from '../commun/base.jsx';
import { BoiteConfirmation } from '../commun/boites.jsx';

export const nomModeleIA = (id) => String(id || '').replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-(\d+)$/, ' $1')
  .replace(/^\w/, (c) => c.toUpperCase());

// Options → Lecture amelioree (Claude) : cle API de l'utilisateur, modele, depense.
export function SectionLectureIA() {
  const [e, setE] = useState(null);
  const [saisie, setSaisie] = useState('');
  const [msg, setMsg] = useState(null);
  useEffect(() => { window.api.ia.etat().then(setE).catch(() => {}); }, []);
  if (!e) return null;
  const enregistrer = async () => {
    const r = await window.api.ia.definirCle(saisie);
    if (r.erreur) { setMsg({ erreur: r.erreur }); return; }
    setSaisie(''); setE(r.etat); setMsg({ ok: 'Clé enregistrée, chiffrée sur cet appareil.' });
  };
  const oublier = async () => { setE(await window.api.ia.oublierCle()); setMsg(null); };
  const gamme = async (g) => setE(await window.api.ia.gamme(g));
  return (
    <section>
      <div className="etiquette">Lecture améliorée (Claude)</div>
      {e.configure ? (
        <div className="choix-raccourcis">
          <span className="options-note" style={{ alignSelf: 'center' }}>Clé : {e.apercu}</span>
          <button className="bouton-neutre" onClick={oublier}><I.Croix t={14} /> Oublier la clé</button>
        </div>
      ) : (
        <div className="choix-raccourcis">
          <input className="editeur-input" type="password" autoComplete="off" spellCheck={false}
            placeholder="Clé API Anthropic (sk-ant-…)" value={saisie} onChange={(x) => setSaisie(x.target.value)}
            onKeyDown={(x) => { if (x.key === 'Enter') enregistrer(); }} style={{ maxWidth: 360 }} />
          <button className="bouton-neutre" onClick={enregistrer} disabled={!saisie.trim()}><I.Coche t={14} /> Enregistrer</button>
        </div>
      )}
      {msg && msg.ok && <div className="options-confirmation"><I.Coche t={14} /> {msg.ok}</div>}
      {msg && msg.erreur && <div className="options-note" style={{ color: 'var(--revoir)' }}>{msg.erreur}</div>}
      <div className="options-note" style={{ margin: '12px 0 8px' }}>Modèle</div>
      <div className="choix-raccourcis">
        {[['sonnet', 'Sonnet 5.5 · conseillé · ~1,5 ct'], ['haiku', 'Haiku 4.5 · moins cher · ~0,5 ct']].map(([g, nom]) => (
          <button key={g} className={'raccourci-bouton' + (e.gamme === g ? ' pose' : '')} onClick={() => gamme(g)}>
            {e.gamme === g && <I.Coche t={14} />} {nom}
          </button>
        ))}
      </div>
      <div className="options-note">
        {e.lectures ? e.lectures + ' lecture(s) par Claude sur cet appareil, environ ' + (e.depense * 100).toFixed(1).replace('.', ',') + ' centimes de dollar au total. ' : ''}
        Après une lecture de cartel, « Relire avec Claude » envoie la photo à Anthropic avec ta liste de
        catégories ; Claude range le texte et choisit des catégories parmi les tiennes. Payant à l’usage sur
        ton compte (console.anthropic.com), jamais automatique. La clé reste chiffrée sur cet appareil :
        elle n’est ni synchronisée, ni envoyée ailleurs qu’à Anthropic.
      </div>
    </section>
  );
}

// Options → Revision espacee : nouvelles tuiles par jour et retention cible
// (reglages propres a l'appareil ; les notes, elles, sont synchronisees).
export function SectionRevision() {
  const [c, setC] = useState(null);
  const charger = () => window.api.revision.etat().then(setC).catch(() => {});
  useEffect(() => { charger(); }, []);
  const definir = async (cle, v) => { await window.api.reglages.definir(cle, String(v)); charger(); };
  if (!c) return null;
  return (
    <section>
      <div className="etiquette">Révision espacée</div>
      <div className="options-note" style={{ marginBottom: 8 }}>Nouvelles tuiles par jour</div>
      <div className="choix-raccourcis">
        {[5, 10, 20, 30].map((n) => (
          <button key={n} className={'raccourci-bouton' + (c.quotaNouvelles === n ? ' pose' : '')} onClick={() => definir('revision_nouvelles', n)}>
            {c.quotaNouvelles === n && <I.Coche t={14} />} {n}
          </button>
        ))}
      </div>
      <div className="options-note" style={{ margin: '14px 0 8px' }}>Taux de souvenir visé</div>
      <div className="choix-raccourcis">
        {[[0.85, 'Détendu · 85 %'], [0.9, 'Normal · 90 %'], [0.95, 'Exigeant · 95 %']].map(([r, nom]) => (
          <button key={r} className={'raccourci-bouton' + (Math.abs(c.retention - r) < 0.001 ? ' pose' : '')} onClick={() => definir('revision_retention', r)}>
            {Math.abs(c.retention - r) < 0.001 && <I.Coche t={14} />} {nom}
          </button>
        ))}
      </div>
      <div className="options-note">
        {c.apprises} tuile{c.apprises > 1 ? 's' : ''} en cours d’apprentissage sur {c.total}. Plus le taux visé est
        haut, plus les tuiles reviennent souvent. Tes notes sont synchronisées entre tes appareils
        (Jouer → Révision espacée) ; ces deux réglages restent propres à cet appareil.
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ images */

// Grandes images du pack : telechargees a la demande (vignettes embarquees).
// Hors ligne complet : tout telecharger d'un coup, ou en tache de fond.
// Options → Images des œuvres : qualite (reduite / a l'affichage / tout hors
// ligne, images-qualite.js) et « Liberer l'espace » (grandes images du cache).
export const QUALITES_IMAGES = [
  ['reduite', 'Réduite', 'Aucun téléchargement : la version réduite livrée avec l’appli.'],
  ['affichage', 'Grande à l’affichage', 'Chaque grande image est téléchargée quand tu la regardes, puis gardée.'],
  ['tout', 'Tout garder hors ligne', 'Toutes les grandes images d’avance : tout marche sans connexion.']
];

export function SectionImages() {
  const [e, setE] = useState(null);
  const [prog, setProg] = useState(null);
  const [demande, setDemande] = useState(null);   // null | 'vider' | 'reduite'
  const [msg, setMsg] = useState(null);
  const relire = () => window.api.images.etat().then(setE);
  useEffect(() => {
    relire();
    return window.api.images.onProgression((p) => { setProg(p); if (p.faites % 20 === 0) relire(); });
  }, []);
  if (!e || !e.nombre) return null;
  const complet = e.presentes >= e.nombre;
  const lancer = async () => {
    setProg({ faites: 0, echecs: 0, total: e.nombre - e.presentes });
    const r = await window.api.images.toutTelecharger();
    setProg(r.restantes ? { fini: true, ...r } : null);
    relire();
  };
  const choisir = async (q) => {
    setMsg(null);
    if (q === e.qualite) return;
    setE(await window.api.images.qualite(q));
    // Passer en reduite avec des grandes images deja la : proposer la place.
    if (q === 'reduite' && e.octetsCache > 0) setDemande('reduite');
  };
  const vider = async () => {
    setDemande(null);
    const r = await window.api.images.vider();
    setE(r.etat);
    setProg(null);
    setMsg(r.octets ? enMo(r.octets) + ' libérés : les versions réduites prennent le relais.' : 'Rien à libérer.');
  };
  const enCours = prog && !prog.fini;
  const mobile = SUR_MOBILE;
  return (
    <section>
      <div className="etiquette">Images des œuvres</div>
      <div className="options-note" style={{ marginBottom: 8 }}>Qualité des images</div>
      <div className="choix-raccourcis">
        {QUALITES_IMAGES.map(([q, nom]) => (
          <button key={q} className={'raccourci-bouton' + (e.qualite === q ? ' pose' : '')} onClick={() => choisir(q)}>
            {e.qualite === q && <I.Coche t={14} />} {nom}
          </button>
        ))}
      </div>
      <div className="options-note">
        {(QUALITES_IMAGES.find(([q]) => q === e.qualite) || [])[2]}
        {mobile && e.qualite !== 'reduite' ? ' En Wi-Fi seulement.' : ''}
        {' '}Version réduite : 33 Ko par image en moyenne ; grande : 130 Ko (≈ 4 fois plus,
        {' '}{enMo(e.octetsTotal)} pour les {e.nombre}).
      </div>
      <div className="choix-raccourcis" style={{ marginTop: 10 }}>
        {!complet && e.qualite !== 'reduite' && (
          <button className="bouton-neutre" onClick={lancer} disabled={enCours}>
            <I.FlecheVert t={16} bas />
            {enCours ? 'Téléchargement… ' + prog.faites + '/' + prog.total
              : 'Tout télécharger maintenant (' + enMo(e.octetsTotal - e.octets) + ')'}
          </button>
        )}
        {e.octetsCache > 0 && (
          <button className="bouton-neutre" onClick={() => setDemande('vider')} disabled={enCours}>
            <I.Corbeille t={15} /> Libérer l’espace ({enMo(e.octetsCache)})
          </button>
        )}
      </div>
      {prog && prog.fini && prog.restantes > 0 && (
        <div className="options-note" style={{ color: 'var(--revoir)' }}>
          {prog.restantes} image(s) n’ont pas pu être téléchargées (connexion ?). Nouvel essai plus tard.
        </div>
      )}
      {msg && <div className="options-confirmation"><I.Coche t={14} /> {msg}</div>}
      <div className="options-note">
        {complet
          ? 'Les ' + e.nombre + ' grandes images (' + enMo(e.octets) + ' au total) sont sur cet appareil : tout marche hors ligne.'
          : e.presentes + ' grande(s) image(s) sur ' + e.nombre + ' sur cet appareil. Sans connexion, la version réduite remplace les autres.'}
      </div>
      {demande && (
        <BoiteConfirmation
          titre={demande === 'reduite' ? 'Supprimer aussi les grandes images déjà téléchargées ?' : 'Libérer ' + enMo(e.octetsCache) + ' ?'}
          texteConfirmer={'Supprimer (' + enMo(e.octetsCache) + ')'}
          onAnnuler={() => setDemande(null)}
          onConfirmer={vider}
        >
          <p>
            Les grandes images téléchargées sont effacées de cet appareil ; les versions réduites
            (livrées avec l’appli) prennent le relais. Elles se re-téléchargent selon la qualité choisie.
            {demande === 'reduite' ? ' « Annuler » les garde : elles restent affichées, gratuitement.' : ''}
          </p>
        </BoiteConfirmation>
      )}
    </section>
  );
}

/* --------------------------------------------------------------- appareils */

// Appareils vus a la derniere synchro. Retirer un appareil perdu : il ne
// bloque plus le menage du dossier de synchro (ses tuiles restent).
export function SectionAppareils({ syn, drv, onSyn }) {
  const [liste, setListe] = useState(null);
  const [demande, setDemande] = useState(null);
  const [renommage, setRenommage] = useState(null);   // null | texte en cours
  const [erreurNom, setErreurNom] = useState(null);
  useEffect(() => { window.api.appareils.liste().then(setListe); }, [syn.derniere, syn.derniereDrive]);
  if (!liste) return null;
  const moi = liste.find((a) => a.moi);
  const renommer = async () => {
    const r = await window.api.appareils.renommer(renommage);
    if (r.erreur) { setErreurNom(r.erreur); return; }
    setErreurNom(null);
    setRenommage(null);
    setListe(r.appareils);
    if (onSyn && r.etat) onSyn(r.etat);
  };
  const basculer = async (a, retirer) => {
    setDemande(null);
    const r = await window.api.appareils.retirer(a.id, retirer);
    if (r.appareils) setListe(r.appareils);
  };
  const jour = (iso) => (iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) : 'jamais');
  return (
    <>
      <div className="filet" />
      <section>
        <div className="etiquette">Appareils</div>
        {moi && (
          <div className="appareil-moi">
            <span className="appareil-prefixe">{moi.prefixe || '?'}</span>
            <div className="appareil-moi-texte">
              <span className="appareil-moi-titre">Cet appareil</span>
              {renommage === null ? (
                <span className="appareil-moi-nom">{moi.nom}</span>
              ) : (
                <input
                  className="editeur-input" value={renommage} maxLength={40} autoFocus
                  onChange={(e) => setRenommage(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') renommer(); if (e.key === 'Escape') setRenommage(null); }}
                />
              )}
              {moi.type && <span className="appareil-type">{moi.type}</span>}
            </div>
            {renommage === null
              ? <button className="bouton-neutre" onClick={() => setRenommage(moi.nom || '')}><I.Crayon t={14} /> Renommer</button>
              : <button className="bouton-valide" onClick={renommer}><I.Coche t={14} /> OK</button>}
          </div>
        )}
        {erreurNom && <div className="options-note" style={{ color: 'var(--revoir)' }}>{erreurNom}</div>}
        <div className="appareils">
          {liste.filter((a) => !a.moi).map((a) => (
            <div key={a.id} className={'appareil' + (a.retire ? ' retire' : '')}>
              <span className="appareil-prefixe">{a.prefixe || '?'}</span>
              <span className="appareil-nom">
                {a.nom || a.id}
                {a.type && <span className="appareil-type">{a.type}</span>}
              </span>
              <span className="appareil-vu">
                {a.retire ? (a.retireIci ? 'retiré' : 'retiré par un autre appareil')
                  : a.moi && !a.prefixe ? 'lettre attribuée à la première synchro'
                  : 'dernière synchro : ' + jour(a.vu_le)}
              </span>
              {!a.moi && (a.retire
                ? (a.retireIci ? <button className="bouton-neutre" onClick={() => basculer(a, false)}>Remettre</button> : <span />)
                : <button className="bouton-neutre" onClick={() => setDemande(a)}>Retirer</button>)}
            </div>
          ))}
        </div>
        <div className="options-note">
          Chaque appareil numérote ses tuiles avec sa lettre, et garde son nom tant que l’appli
          n’est pas réinstallée ; un appareil qui en remplace un autre reprend son nom et sa lettre. {drv.connecte ? 'Compte Google de cet appareil : '
            + (drv.email || 'inconnu') + ' — un appareil connecté avec un autre compte n’apparaît pas ici et ne '
            + 'reçoit rien.' : ''}
        </div>
      </section>
      {demande && (
        <BoiteConfirmation
          titre={'Retirer « ' + (demande.nom || demande.id) + ' » ?'}
          texteConfirmer="Retirer"
          onAnnuler={() => setDemande(null)}
          onConfirmer={() => basculer(demande, true)}
        >
          <p>
            Pour un appareil perdu, vendu ou réinstallé : il ne retient plus le ménage du dossier de
            synchro. Ses tuiles (« {demande.prefixe} ») restent, et sa lettre reste réservée. S’il
            revient, il se remet à jour tout seul.
          </p>
          <p>
            Cela ne lui coupe pas l’accès à ton Google Drive. Pour ça : compte Google → Sécurité →
            Applications tierces → Tuiles et Toiles → Supprimer l’accès (tous tes appareils devront
            se reconnecter).
          </p>
        </BoiteConfirmation>
      )}
    </>
  );
}

// Appareil neuf qui arrive sur un Drive (ou un dossier) deja utilise : reprend-il
// le nom et la lettre d'un appareil precedent ? Rien n'est ecrit avant le choix.
export function BoiteRemplacement({ candidats, onChoisir, onFermer }) {
  const [choix, setChoix] = useState(() => {
    const muet = candidats.find((c) => !c.recent);
    return muet ? muet.id : 'aucun';
  });
  const jour = (iso) => (iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) : 'jamais');
  useEffect(() => {
    const clavier = (e) => { if (e.key === 'Escape') onFermer(); };
    window.addEventListener('keydown', clavier);
    return () => window.removeEventListener('keydown', clavier);
  }, [onFermer]);
  const Option = ({ id, children, recent }) => (
    <label className={'remplacement-option' + (choix === id ? ' choisie' : '') + (recent ? ' recent' : '')}>
      <input type="radio" name="remplacement" checked={choix === id} onChange={() => setChoix(id)} />
      <span className="remplacement-texte">{children}</span>
    </label>
  );
  return (
    <div className="recouvrement" onClick={onFermer}>
      <div className="boite-dialogue boite-remplacement" onClick={(e) => e.stopPropagation()}>
        <h3>Cet appareil en remplace-t-il un autre ?</h3>
        <p>
          Téléphone changé, appli réinstallée, ordinateur remis à zéro : choisis l’ancien appareil.
          Celui-ci reprend son nom et sa lettre (ses tuiles continuent à la suite), et l’ancien est
          retiré. Sinon, c’est un nouvel appareil, avec son propre nom.
        </p>
        <div className="remplacement-liste">
          {candidats.map((c) => (
            <Option key={c.id} id={c.id} recent={c.recent}>
              <span className="remplacement-nom"><span className="appareil-prefixe">{c.prefixe}</span> {c.nom}</span>
              <span className="appareil-type">
                {[c.type, 'dernière synchro : ' + jour(c.vu_le), c.retire ? 'retiré' : null].filter(Boolean).join(' · ')}
              </span>
              {c.recent && <span className="remplacement-alerte">Actif il y a moins d’un jour : sans doute un autre appareil encore en service.</span>}
            </Option>
          ))}
          <Option id="aucun">
            <span className="remplacement-nom">Non, c’est un nouvel appareil</span>
          </Option>
        </div>
        <div className="actions">
          <button className="bouton-neutre" onClick={onFermer}>Plus tard</button>
          <button className="bouton-valide" onClick={() => onChoisir(choix === 'aucun' ? null : choix)}>
            <I.Coche t={14} /> Valider et synchroniser
          </button>
        </div>
      </div>
    </div>
  );
}
