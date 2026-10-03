import { useEffect, useState, useCallback, useRef, useMemo, Fragment } from 'react';
import * as I from './icones.jsx';
import { DENSITES, GrilleContext, NavContext, SUR_MOBILE, chargerPrefs, densiteValide, editionEnAttente } from './commun/base.jsx';
import { BoiteConfirmation, EnChantier } from './commun/boites.jsx';
import { PageEdition } from './edition/PageEdition.jsx';
import { PageBibliotheque, PageEtoile, PageLivre, PageRevoir } from './galeries/Galeries.jsx';
import { Jeu } from './jeu/Jeu.jsx';
import { BandeauMaj, MajContext, useMaj } from './options/Maj.jsx';
import { Options, RACCOURCIS } from './options/Options.jsx';
import { PageConflits } from './pages/Conflits.jsx';
import { PageCorbeille } from './pages/Corbeille.jsx';

/* ------------------------------------------------------------------ menu */

function Menu({ etat, aller, onQuitter }) {
  return (
    <div className="menu">
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
        <div className="surtitre">
          {etat.oeuvres} œuvres · {etat.tags.livre + etat.tags.etoile + etat.tags.bad_smiley} marquées
        </div>
        <h1>Tuiles <span className="amp">&amp;</span> Toiles</h1>
        <div className="soustitre">Entraînement mémoriel — histoire de l’art</div>
      </div>

      <div className="filet" />

      <div className="cartes">
        <button className="carte primaire" onClick={() => aller('jeu')}>
          <span className="pastille"><I.Manette t={24} /></span>
          <span>
            <div className="nom">Jouer</div>
            <div className="desc">Mode aléatoire ou par catégorie</div>
          </span>
        </button>

        {[
          ['bibliotheque', I.Bibliotheque, 'Bibliothèque', 'Toutes les tuiles', etat.oeuvres, null],
          ['livre', I.Livre, 'Livre', 'À approfondir', etat.tags.livre, 'var(--livre)'],
          ['etoile', I.Etoile, 'Étoile', 'Favorites', etat.tags.etoile, 'var(--etoile)'],
          ['revoir', I.Revoir, 'À revoir', 'Ratées la dernière fois', etat.tags.bad_smiley, 'var(--revoir)'],
          ['edition', I.Crayon, 'Édition', 'Créer et modifier des tuiles', null, 'var(--laiton)']
        ].map(([cle, Icone, nom, desc, n, couleur]) => (
          <button key={cle} className="carte" onClick={() => aller(cle)}>
            <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <span className="pastille" style={couleur ? { color: couleur } : undefined}>
                <Icone t={23} />
              </span>
              <span className="nombre">{n}</span>
            </span>
            <span>
              <div className="nom">{nom}</div>
              <div className="desc">{desc}</div>
            </span>
          </button>
        ))}
      </div>

      <div className="menu-actions">
        <button className="menu-lien" onClick={() => aller('options')}>
          <I.Rouage t={14} /> Options
        </button>
        <button className="menu-lien menu-quitter" onClick={onQuitter}>
          <I.Croix t={14} /> Quitter
        </button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- coquille */

function Barre({ page, aller, etat, repliee, basculer, onQuitter, synchro }) {
  const items = [
    ['menu', I.Maison, 'Accueil', null],
    ['jeu', I.Manette, 'Jouer', null],
    ['bibliotheque', I.Bibliotheque, 'Bibliothèque', etat.oeuvres],
    ['livre', I.Livre, 'Livre', etat.tags.livre],
    ['etoile', I.Etoile, 'Étoile', etat.tags.etoile],
    ['revoir', I.Revoir, 'À revoir', etat.tags.bad_smiley],
    ['edition', I.Crayon, 'Édition', null],
    // N'apparaissent que s'il y a quelque chose dedans.
    ...(etat.corbeille ? [['corbeille', I.Corbeille, 'Corbeille', etat.corbeille]] : []),
    ...(etat.conflits ? [['conflits', I.Echange, 'Conflits', etat.conflits]] : [])
  ];
  return (
    <aside className={'barre' + (repliee ? ' repliee' : '')}>
      <button className="entree" onClick={basculer}>
        <I.Hamburger />
        {!repliee && <span className="libelle" style={{ fontFamily: 'var(--serif)', fontSize: 16 }}>Tuiles &amp; Toiles</span>}
      </button>
      {items.map(([cle, Icone, nom, n]) => (
        <button key={cle} className={'entree' + (page === cle ? ' active' : '')} onClick={() => aller(cle)}>
          <Icone />
          <span className="libelle">{nom}</span>
          {n != null && <span className={'compte' + (cle === 'conflits' ? ' alerte' : '')}>{n}</span>}
        </button>
      ))}
      <span style={{ flexGrow: 1 }} />
      {synchro && (
        <button className="entree synchro-en-cours" onClick={() => aller('options')}
          title={'Synchro en cours — ' + (synchro.libelle || '')} role="status" aria-live="polite">
          <span className="drive-pastille" />
          <span className="libelle">
            Synchro…{synchro.total ? ' ' + synchro.faits + '/' + synchro.total : ''}
          </span>
        </button>
      )}
      <button className="entree" onClick={() => aller('options')}><I.Rouage /><span className="libelle">Options</span></button>
      <button className="entree" onClick={onQuitter} style={{ color: 'var(--revoir)' }}>
        <I.Croix /><span className="libelle">Quitter</span>
      </button>
    </aside>
  );
}

function ConfirmationFermeture({ onAnnuler, onConfirmer }) {
  return (
    <BoiteConfirmation
      titre="Fermer Tuiles & Toiles ?"
      texteConfirmer="Quitter"
      validerEntree
      onAnnuler={onAnnuler}
      onConfirmer={onConfirmer}
    >
      <p>La progression et les tuiles marquées sont déjà enregistrées.</p>
    </BoiteConfirmation>
  );
}

// Propose au premier lancement d'ajouter un raccourci. Rien n'est cree sans clic.
function PropositionRaccourcis({ onFermer }) {
  const [rc, setRc] = useState(null);
  const [enCours, setEnCours] = useState(null);
  const [manuel, setManuel] = useState(false);

  useEffect(() => { window.api.raccourcis.etat().then(setRc); }, []);
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onFermer(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onFermer]);

  const basculer = async (type) => {
    setEnCours(type);
    const r = await window.api.raccourcis.basculer(type);
    setRc(r.etat);
    setManuel(r.manuel);
    setEnCours(null);
  };

  if (!rc) return null;

  return (
    <div className="recouvrement" onClick={onFermer}>
      <div className="boite-dialogue" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
        <h3>Ajouter un raccourci ?</h3>
        <p>Pour retrouver Tuiles &amp; Toiles facilement. Rien n’est ajouté sans ton clic.</p>
        <div className="choix-raccourcis" style={{ margin: '4px 0 14px' }}>
          {RACCOURCIS.map(([cle, labelAjout, labelPose]) => {
            const pose = rc[cle];
            return (
              <button
                key={cle}
                className={'raccourci-bouton' + (pose ? ' pose' : '')}
                onClick={() => basculer(cle)}
                disabled={enCours === cle}
              >
                {pose ? <I.Coche t={14} /> : <span className="raccourci-plus">+</span>}
                {enCours === cle ? '…' : (pose ? labelPose : labelAjout)}
              </button>
            );
          })}
        </div>
        {manuel && (
          <p style={{ color: 'var(--laiton)' }}>
            Windows n’autorise plus l’épinglage automatique : le dossier s’est ouvert,
            clic droit sur l’icône → Épingler à la barre des tâches.
          </p>
        )}
        <p className="options-note">Tu pourras revenir là-dessus dans les Options.</p>
        <div className="actions">
          <button className="bouton-neutre" onClick={onFermer}>Plus tard</button>
          <button className="bouton-valide" onClick={onFermer}>
            <I.Coche t={14} /> Terminé
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [etat, setEtat] = useState(null);
  const [page, setPage] = useState('menu');
  const [repliee, setRepliee] = useState(false);
  const [confirmerFermeture, setConfirmerFermeture] = useState(false);
  const [racPerimes, setRacPerimes] = useState(null);
  const [proposerRaccourcis, setProposerRaccourcis] = useState(false);
  const [colonnes, setColonnes] = useState(DENSITES[0]);

  // Historique de navigation (souris4 = reculer, souris5 = avancer). `nonce`
  // rejoue le montage de la page : cliquer l'onglet parent depuis une
  // sous-page (Édition -> modifier) ramène bien à la page parent.
  const histoRef = useRef({ pile: ['menu'], pos: 0 });
  const [navNonce, setNavNonce] = useState(0);

  // Gestionnaire de retour interne posé par la page courante (voir NavContext).
  const retourInterneRef = useRef(null);
  const setRetour = useCallback((fn) => { retourInterneRef.current = fn || null; }, []);

  const charger = useCallback(async () => {
    const e = await window.api.etat();
    chargerPrefs(e.prefs);
    setEtat(e);
  }, []);

  // Synchro en cours, visible depuis toutes les pages (barre laterale).
  const [synchroEnCours, setSynchroEnCours] = useState(null);
  // Synchro automatique qui a apporte du nouveau : la page affichee n'est
  // pas rechargee d'office (saisie, apercu ouvert…), on propose d'actualiser.
  const [nouveautes, setNouveautes] = useState(null);   // { conflits }
  // Echec d'une synchro automatique : bandeau court (type d'erreur), sauf hors
  // ligne (regle 1 : silencieux, dit seulement dans Options). Efface au
  // succes suivant ; fermable.
  const [echecSynchro, setEchecSynchro] = useState(null);   // { type, libelle }
  const conflitsAvant = useRef(null);
  useEffect(() => {
    window.api.synchro.etat().then((s) => {
      if (s.progression && s.progression.enCours) setSynchroEnCours(s.progression);
      if (s.echec && s.echec.auto && s.echec.type !== 'reseau') setEchecSynchro(s.echec);
    });
    return window.api.synchro.onProgression((p) => {
      setSynchroEnCours(p.enCours ? p : null);
      if (p.enCours) return;
      charger();   // compteurs (conflits…) a jour sans changer d'onglet
      const r = p.resultat;
      if (r && !r.erreur) setEchecSynchro(null);
      if (r && r.auto && r.erreur && !r.decisionRequise) {
        setEchecSynchro(r.typeErreur === 'reseau' || r.typeErreur === 'encours' ? null
          : { type: r.typeErreur, libelle: String(r.erreur).replace(/^Synchro impossible : /, '').replace(/\.$/, '') });
      }
      if (!r || !r.auto || r.erreur) return;
      const recu = r.appliquees || r.imagesRecues || (r.renumerotees && r.renumerotees.length);
      const nouveauxConflits = r.conflits > (conflitsAvant.current || 0);
      conflitsAvant.current = r.conflits;
      if (recu || nouveauxConflits) setNouveautes({ recu: !!recu, conflits: nouveauxConflits ? r.conflits : 0 });
    });
  }, [charger]);
  useEffect(() => { if (etat && conflitsAvant.current == null) conflitsAvant.current = etat.conflits; }, [etat]);
  useEffect(() => { charger(); }, [charger]);

  // Mise a jour : verification discrete peu apres le lancement (reglage
  // maj_auto), silencieuse si hors ligne ou deja a jour.
  const maj = useMaj();
  const majVerifiee = useRef(false);
  useEffect(() => {
    if (!etat || majVerifiee.current) return undefined;
    majVerifiee.current = true;
    if (!etat.majAuto) return undefined;
    const t = setTimeout(() => maj.verifier(true), 4000);
    return () => clearTimeout(t);
  }, [etat, maj.verifier]);

  // Densite de grille : chargee du reglage, appliquee en var CSS globale,
  // cyclee dans DENSITES par le bouton de BarreFiltres.
  useEffect(() => {
    if (etat && etat.grilleColonnes) setColonnes(densiteValide(etat.grilleColonnes));
  }, [etat && etat.grilleColonnes]);
  useEffect(() => {
    document.documentElement.style.setProperty('--grille-cols', colonnes);
    document.documentElement.dataset.grille = colonnes;   // cartes plus sobres a 3-4 (mobile)
  }, [colonnes]);
  const cyclerColonnes = useCallback(() => {
    setColonnes((c) => {
      const n = DENSITES[(DENSITES.indexOf(c) + 1) % DENSITES.length] || DENSITES[0];
      window.api.reglages.definir('grille_colonnes', String(n));
      window.api.log('grille -> ' + n + '/ligne');
      return n;
    });
  }, []);

  // Ctrl+Z / Ctrl+Y (ou Ctrl+Maj+Z) : annuler / retablir la derniere action
  // (annuler.js). Pas dans un champ de saisie ni dans l'editeur de tuile :
  // la, c'est l'annulation de texte habituelle.
  const [annulation, setAnnulation] = useState(null);   // { sens, libelle, faites, ignorees, etat }
  const minuteurAnnulation = useRef(null);
  const pageRef = useRef(page);
  pageRef.current = page;
  const annulerOuRetablir = useCallback(async (sens) => {
    const r = sens === 'annuler' ? await window.api.annuler.annuler() : await window.api.annuler.retablir();
    setAnnulation({ sens, ...r });
    clearTimeout(minuteurAnnulation.current);
    minuteurAnnulation.current = setTimeout(() => setAnnulation(null), 7000);
    if (r.rien || !r.faites) return;
    charger();
    // Listes : remontees pour montrer le resultat. Pas le jeu (la tuile
    // tiree serait perdue).
    if (pageRef.current !== 'jeu' && pageRef.current !== 'menu') setNavNonce((n) => n + 1);
  }, [charger]);
  useEffect(() => {
    const k = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const t = e.key.toLowerCase();
      const sens = t === 'z' && !e.shiftKey ? 'annuler' : (t === 'y' || (t === 'z' && e.shiftKey)) ? 'retablir' : null;
      if (!sens) return;
      const cible = e.target;
      if (cible && (/^(INPUT|TEXTAREA|SELECT)$/.test(cible.tagName) || cible.isContentEditable)) return;
      if (document.querySelector('.editeur-jeu')) return;
      e.preventDefault();
      annulerOuRetablir(sens);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [annulerOuRetablir]);

  // Ctrl+F : donner le focus au champ de recherche de la page courante.
  useEffect(() => {
    const k = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        const inp = document.querySelector('.biblio-recherche');
        if (inp) { e.preventDefault(); inp.focus(); inp.select(); }
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  // Navigation tracee (journal.log). A etoffer : logger aussi les actions
  // internes des pages. Chaque appel empile la page et remonte le composant
  // (nonce) — y compris quand on reclique l'onglet courant.
  const naviguer = useCallback((p) => {
    window.api.log('page -> ' + p);
    retourInterneRef.current = null;
    const h = histoRef.current;
    h.pile = h.pile.slice(0, h.pos + 1);
    if (h.pile[h.pos] !== p) { h.pile.push(p); h.pos = h.pile.length - 1; }
    setPage(p);
    setNavNonce((n) => n + 1);
  }, []);

  const navValue = useMemo(() => ({
    setRetour,
    modifierTuile: (id) => { editionEnAttente.id = id; naviguer('edition'); }
  }), [setRetour, naviguer]);

  const reculer = useCallback(() => {
    // D'abord fermer l'état interne de la page (aperçu, éditeur…) s'il y en a.
    if (retourInterneRef.current && retourInterneRef.current()) return;
    const h = histoRef.current;
    if (h.pos <= 0) {
      // Mobile : retour depuis la premiere page = l'appli passe en arriere-plan.
      if (SUR_MOBILE) window.api.quitter();
      return;
    }
    h.pos -= 1;
    window.api.log('page <- ' + h.pile[h.pos] + ' (souris4)');
    setPage(h.pile[h.pos]);
    setNavNonce((n) => n + 1);
  }, []);

  const avancer = useCallback(() => {
    retourInterneRef.current = null;
    const h = histoRef.current;
    if (h.pos >= h.pile.length - 1) return;
    h.pos += 1;
    window.api.log('page -> ' + h.pile[h.pos] + ' (souris5)');
    setPage(h.pile[h.pos]);
    setNavNonce((n) => n + 1);
  }, []);

  useEffect(() => { window.api.log('rendu prêt'); }, []);

  // Boutons lateraux de la souris : 3 = precedent, 4 = suivant. preventDefault
  // sur mousedown coupe la navigation d'historique par defaut de Chromium ;
  // onNav couvre les touches physiques remontees en app-command (Windows). Un
  // garde-temps evite un double saut si les deux voies se declenchent.
  const gardeSouris = useRef(0);
  useEffect(() => {
    const sauter = (fn) => {
      const t = Date.now();
      if (t - gardeSouris.current < 300) return;
      gardeSouris.current = t;
      fn();
    };
    const onUp = (e) => {
      if (e.button === 3) { e.preventDefault(); sauter(reculer); }
      else if (e.button === 4) { e.preventDefault(); sauter(avancer); }
    };
    const onDown = (e) => { if (e.button === 3 || e.button === 4) e.preventDefault(); };
    window.addEventListener('mouseup', onUp);
    window.addEventListener('mousedown', onDown);
    const desab = window.api.onNav
      ? window.api.onNav((sens) => sauter(sens === 'reculer' ? reculer : avancer))
      : null;
    return () => {
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('mousedown', onDown);
      if (desab) desab();
    };
  }, [reculer, avancer]);

  // A chaque ouverture : les raccourcis qui pointent vers un ancien
  // emplacement de l'exe -> proposer de les remettre a jour.
  useEffect(() => {
    window.api.raccourcis.perimes().then((l) => { if (l && l.length) setRacPerimes(l); });
  }, []);

  // Premier lancement (Windows) : proposer d'ajouter un raccourci.
  useEffect(() => {
    if (etat && !etat.raccourcisProposes) {
      window.api.raccourcis.etat().then((rc) => { if (rc) setProposerRaccourcis(true); });
    }
  }, [etat && etat.raccourcisProposes]);

  useEffect(() => {
    if (etat) setRepliee(etat.sidebarRepliee);
  }, [etat && etat.sidebarRepliee]);

  // Applique la palette choisie (attribut data-theme lu par styles.css) et
  // suit le theme Windows en direct quand 'auto' est actif.
  useEffect(() => {
    if (!etat) return undefined;
    let actif = true;
    const appliquer = (systeme) => {
      document.documentElement.dataset.theme = etat.theme === 'auto' ? systeme : etat.theme;
    };
    window.api.themeSysteme().then((s) => { if (actif) appliquer(s); });
    const desabonner = window.api.onThemeSysteme(appliquer);
    return () => { actif = false; desabonner(); };
  }, [etat && etat.theme]);

  const basculer = () => {
    const v = !repliee;
    setRepliee(v);
    window.api.reglages.definir('sidebar_repliee', v ? '1' : '0');
  };

  // Croix (fenetre ou barre laterale) et « Quitter » : proposent directement
  // de fermer l'application. Le retour a l'accueil se fait par l'onglet dedie.
  const tenterFermeture = useCallback(() => {
    setConfirmerFermeture(true);
  }, []);

  useEffect(() => window.api.onTenterFermeture(tenterFermeture), [tenterFermeture]);

  const noteAnnulation = annulation && (
    <div className="bandeau-synchro bandeau-annulation" role="status">
      <I.Rafraichir t={15} />
      <span>
        {annulation.rien
          ? (annulation.sens === 'annuler' ? 'Rien à annuler.' : 'Rien à rétablir.')
          : !annulation.faites
            ? 'Rien n’a changé : « ' + annulation.libelle + ' » a été modifié depuis (autre appareil ou autre action).'
            : (annulation.sens === 'annuler' ? 'Annulé : ' : 'Rétabli : ') + annulation.libelle
              + (annulation.ignorees && annulation.ignorees.length ? ' (en partie : modifié depuis ailleurs)' : '') + '.'}
      </span>
      {!annulation.rien && annulation.sens === 'annuler' && annulation.etat && annulation.etat.retablir && (
        <button className="bouton-neutre" onClick={() => annulerOuRetablir('retablir')}>Rétablir</button>
      )}
      <button className="bandeau-synchro-x" onClick={() => setAnnulation(null)} title="Fermer"><I.Croix t={12} /></button>
    </div>
  );

  // Quitter peut attendre l'envoi des dernieres modifications (10 s max).
  const [fermetureEnCours, setFermetureEnCours] = useState(false);
  const dialogueFermeture = fermetureEnCours ? (
    <div className="recouvrement">
      <div className="boite-dialogue">
        <h3>Fermeture…</h3>
        <p>Envoi de tes dernières modifications vers tes autres appareils.</p>
      </div>
    </div>
  ) : confirmerFermeture && (
    <ConfirmationFermeture
      onAnnuler={() => setConfirmerFermeture(false)}
      onConfirmer={() => { setConfirmerFermeture(false); setFermetureEnCours(true); window.api.quitter(); }}
    />
  );

  // Pages qu'« Actualiser » peut remonter sans rien perdre (pas l'editeur :
  // une saisie en cours serait perdue ; pas Conflits : il se relit seul).
  const PAGES_LISTES = ['bibliotheque', 'livre', 'etoile', 'revoir', 'corbeille'];
  const bandeauNouveautes = nouveautes && (nouveautes.conflits || PAGES_LISTES.includes(page)) && (
    <div className="bandeau-synchro" role="status">
      <I.Echange t={15} />
      <span>
        {nouveautes.recu ? 'Du nouveau de tes autres appareils.' : ''}
        {nouveautes.conflits ? ' ' + nouveautes.conflits + ' conflit(s) à trancher.' : ''}
      </span>
      {nouveautes.recu && PAGES_LISTES.includes(page) && (
        <button className="bouton-neutre" onClick={() => { setNouveautes(null); setNavNonce((n) => n + 1); }}>Actualiser</button>
      )}
      {nouveautes.conflits > 0 && page !== 'conflits' && (
        <button className="bouton-neutre" onClick={() => { setNouveautes(null); naviguer('conflits'); }}>Voir</button>
      )}
      <button className="bandeau-synchro-x" onClick={() => setNouveautes(null)} title="Fermer"><I.Croix t={12} /></button>
    </div>
  );

  const bandeauEchec = echecSynchro && page !== 'options' && (
    <div className="bandeau-synchro echec" role="alert">
      <I.Nuage t={15} />
      <span>Synchro en échec : {echecSynchro.libelle}.</span>
      <button className="bouton-neutre" onClick={() => naviguer('options')}>Options</button>
      <button className="bandeau-synchro-x" onClick={() => setEchecSynchro(null)} title="Fermer"><I.Croix t={12} /></button>
    </div>
  );

  const NOMS_RAC = { bureau: 'le bureau', menu: 'le menu Démarrer', taskbar: 'la barre des tâches' };
  const reparerRaccourcis = async () => {
    await window.api.raccourcis.reparer(racPerimes.map((r) => r.type));
    setRacPerimes(null);
  };
  const dialogueRaccourcis = racPerimes && (
    <BoiteConfirmation
      titre="Raccourcis à mettre à jour ?"
      texteConfirmer="Mettre à jour"
      confirmerVariante="valide"
      onAnnuler={() => setRacPerimes(null)}
      onConfirmer={reparerRaccourcis}
    >
      <p>
        {racPerimes.length > 1 ? 'Des raccourcis' : 'Un raccourci'} vers Tuiles &amp; Toiles
        ({racPerimes.map((r) => NOMS_RAC[r.type]).join(', ')}) pointe
        {racPerimes.length > 1 ? 'nt' : ''} vers un ancien emplacement de l’application.
        Le{racPerimes.length > 1 ? 's' : ''} faire pointer vers l’exe actuel ?
      </p>
    </BoiteConfirmation>
  );

  const fermerProposition = () => {
    setProposerRaccourcis(false);
    window.api.reglages.definir('raccourcis_proposes', '1');
    charger();
  };
  const dialoguePropositionRaccourcis = proposerRaccourcis && (
    <PropositionRaccourcis onFermer={fermerProposition} />
  );

  if (!etat) return <div className="chargement">chargement…</div>;
  if (page === 'menu') {
    return (
      <MajContext.Provider value={maj}>
        <Menu etat={etat} aller={naviguer} onQuitter={tenterFermeture} />
        {bandeauEchec}
        {noteAnnulation}
        <BandeauMaj />
        {dialogueFermeture}
        {dialogueRaccourcis}
        {dialoguePropositionRaccourcis}
      </MajContext.Provider>
    );
  }

  return (
   <MajContext.Provider value={maj}>
    <GrilleContext.Provider value={{ colonnes, cycler: cyclerColonnes }}>
     <NavContext.Provider value={navValue}>
      <div className="appli">
        <Barre
          page={page} aller={naviguer} etat={etat} repliee={repliee} basculer={basculer}
          onQuitter={tenterFermeture} synchro={synchroEnCours}
        />
        <div className="contenu">
          {/* cle = page + nonce : recliquer l'onglet courant (ou revenir via
              souris4/5) remonte la page et repart de son etat initial. */}
          <Fragment key={page + '#' + navNonce}>
            {page === 'jeu' ? <Jeu onEtat={charger} />
              : page === 'options' ? <Options etat={etat} onEtat={charger} aller={naviguer} />
              : page === 'conflits' ? <PageConflits onEtat={charger} />
              : page === 'corbeille' ? <PageCorbeille onEtat={charger} />
              : page === 'bibliotheque' ? <PageBibliotheque onEtat={charger} />
              : page === 'edition' ? <PageEdition onEtat={charger} />
              : page === 'livre' ? <PageLivre onEtat={charger} />
              : page === 'etoile' ? <PageEtoile onEtat={charger} />
              : page === 'revoir' ? <PageRevoir onEtat={charger} />
              : <EnChantier nom={page} />}
          </Fragment>
        </div>
        {dialogueFermeture}
        {dialogueRaccourcis}
        {dialoguePropositionRaccourcis}
        {bandeauNouveautes}
        {bandeauEchec}
        {noteAnnulation}
        <BandeauMaj />
      </div>
     </NavContext.Provider>
    </GrilleContext.Provider>
   </MajContext.Provider>
  );
}
