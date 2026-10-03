// Decoupe d'App.jsx (etape 1 de Bristol) : code inchange, voir scripts/decouper-app.js.
import { useEffect, useState, useRef } from 'react';
import * as I from '../icones.jsx';
import { SUR_MOBILE, direChangements, phraseBilan, recharger } from '../commun/base.jsx';
import { BoiteConfirmation, ProgressionSynchro } from '../commun/boites.jsx';
import { SectionMaj } from './Maj.jsx';
import { FormulaireRapport } from './Rapport.jsx';
import { BoiteRemplacement, SectionAppareils, SectionImages, SectionLectureIA, SectionRevision } from './Sections.jsx';

/* --------------------------------------------------------------- options */

export const THEMES = [
  ['auto', SUR_MOBILE ? 'Auto (système)' : 'Auto (Windows)'],
  ['clair', 'Clair'],
  ['parchemin', 'Parchemin'],
  ['lin', 'Lin'],
  ['sepia', 'Sépia'],
  ['sepia-profond', 'Sépia profond'],
  ['taupe', 'Taupe'],
  ['ardoise', 'Ardoise claire'],
  ['sombre', 'Sombre'],
  ['dracula', 'Dracula']
];

export const RACCOURCIS = [
  ['bureau', 'Ajouter au bureau', 'Sur le bureau — retirer'],
  ['menu', 'Ajouter au menu Démarrer', 'Dans le menu Démarrer — retirer'],
  ['taskbar', 'Épingler à la barre des tâches', 'Épinglé à la barre — détacher']
];

export function Options({ etat, onEtat, aller }) {
  const [confirmation, setConfirmation] = useState(false);
  const [demandeEffacement, setDemandeEffacement] = useState(false);
  const [effacementFait, setEffacementFait] = useState(null);
  const [raccourcis, setRaccourcis] = useState(null);
  const [raccourciEnCours, setRaccourciEnCours] = useState(null);
  const [raccourciManuel, setRaccourciManuel] = useState(false);
  const [sauvMsg, setSauvMsg] = useState(null);          // { ok } | { erreur }
  const [sauvImport, setSauvImport] = useState(null);    // zip choisi, en attente de confirmation
  // Bilan d'un import, qui survit au rechargement de la page.
  const [importFait] = useState(() => {
    try {
      const m = sessionStorage.getItem('import-msg');
      if (m) { sessionStorage.removeItem('import-msg'); return JSON.parse(m); }
    } catch { /* stockage indisponible */ }
    return null;
  });
  const [sauvOccupe, setSauvOccupe] = useState(false);
  const [copie, setCopie] = useState(null);             // copie de securite automatique
  useEffect(() => { window.api.copieSecurite.etat().then(setCopie); }, []);
  const [drv, setDrv] = useState(null);                  // etat Google Drive
  const [drvOccupe, setDrvOccupe] = useState(false);
  // Bilan de la derniere synchro, qui survit au rechargement suivant une fusion.
  const [msgRecharge] = useState(() => {
    try {
      const m = sessionStorage.getItem('synchro-msg');
      if (m) { sessionStorage.removeItem('synchro-msg'); return JSON.parse(m); }
    } catch { /* stockage indisponible */ }
    return null;
  });
  const [drvMsg, setDrvMsg] = useState(msgRecharge && msgRecharge.ou === 'drive' ? msgRecharge.msg : null);
  const [drvAction, setDrvAction] = useState(null);      // 'connexion'
  const [syn, setSyn] = useState(null);                  // etat synchro (dossier + Drive)
  const [synMsg, setSynMsg] = useState(msgRecharge && msgRecharge.ou === 'dossier' ? msgRecharge.msg : null);

  const [rapportOuvert, setRapportOuvert] = useState(false);

  const totalMarques = etat.tags.livre + etat.tags.etoile + etat.tags.bad_smiley;

  const flashSauv = (m) => { setSauvMsg(m); setTimeout(() => setSauvMsg(null), 7000); };
  useEffect(() => { if (importFait) setSauvMsg(importFait); }, []);

  const exporterDonnees = async () => {
    setSauvOccupe(true); setSauvMsg(null);
    const r = await window.api.sauvegarde.exporter();
    setSauvOccupe(false);
    if (r.annule) return;
    flashSauv(r.erreur ? { erreur: r.erreur } : { ok: 'Exporté : ' + r.chemin });
  };

  const choisirImport = async () => {
    setSauvOccupe(true); setSauvMsg(null);
    const r = await window.api.sauvegarde.choisir();
    setSauvOccupe(false);
    if (r.annule) return;
    if (r.erreur) { flashSauv({ erreur: r.erreur }); return; }
    setSauvImport(r);
  };

  const confirmerImport = async () => {
    const chemin = sauvImport.chemin;
    setSauvImport(null); setSauvOccupe(true);
    const r = await window.api.sauvegarde.importer(chemin);
    if (r && r.erreur) { setSauvOccupe(false); flashSauv({ erreur: r.erreur }); return; }
    const recu = direChangements(r.resume, r.imagesCopiees);
    const msg = {
      ok: recu ? 'Sauvegarde fusionnée : ' + recu + '.' : 'Rien de nouveau dans cette sauvegarde : tout était déjà là.',
      conflits: r.conflits
    };
    try { sessionStorage.setItem('import-msg', JSON.stringify(msg)); } catch { /* tant pis */ }
    await recharger();   // la base a changé — repartir propre
  };

  useEffect(() => { window.api.drive.etat().then(setDrv); }, []);
  const drvFlash = (m) => { setDrvMsg(m); setTimeout(() => setDrvMsg(null), 8000); };

  const drvConnecter = async () => {
    setDrvOccupe(true); setDrvMsg(null); setDrvAction('connexion');
    const r = await window.api.drive.connecter();
    setDrvOccupe(false); setDrvAction(null);
    setDrv(r);
    setSyn(await window.api.synchro.etat());
    if (r.erreur) drvFlash({ erreur: r.erreur });
  };
  const drvDeconnecter = async () => {
    setDrv(await window.api.drive.deconnecter());
    setSyn(await window.api.synchro.etat());
  };

  // Progression de la synchro, tenue par le processus principal : une page
  // (re)ouverte pendant une synchro l'affiche aussitot, et le bilan arrive
  // meme si la synchro a ete lancee depuis une page quittee entre-temps.
  const [prog, setProg] = useState({ enCours: false });
  const annonces = useRef(new Set());   // cycles deja annonces
  const [, setTic] = useState(0);
  useEffect(() => {
    window.api.synchro.etat().then((s) => { setSyn(s); if (s.progression) setProg(s.progression); });
    return window.api.synchro.onProgression((p) => {
      setProg(p);
      if (p.etape === 'fin' && p.resultat) annoncer(p.resultat, p.par);
    });
  }, []);
  // Chronometre visible : la synchro vit, meme sur une etape longue.
  useEffect(() => {
    if (!prog.enCours) return undefined;
    const id = setInterval(() => setTic((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [prog.enCours]);

  const synChoisir = async () => {
    setSynMsg(null);
    const r = await window.api.synchro.choisirDossier();
    if (r.annule) return;
    if (r.erreur) { setSynMsg({ erreur: r.erreur }); return; }
    setSyn(r);
  };
  const synOublier = async () => { setSyn(await window.api.synchro.oublier()); setSynMsg(null); };

  // Bilan d'une synchro (dossier ou Drive), une seule fois par cycle : il
  // arrive par la progression (etape « fin ») et/ou par le retour de l'appel.
  function annoncer(r, ou) {
    if (r.cycle) {
      if (annonces.current.has(r.cycle)) return;
      annonces.current.add(r.cycle);
    }
    // Synchro automatique : pas de rechargement ni de message, la ligne
    // « Dernière fois » se met a jour (et l'appli propose d'actualiser).
    if (r.auto) {
      onEtat();
      window.api.synchro.etat().then(setSyn);
      return;
    }
    annoncerSynchro(r, ou, ou === 'drive' ? setDrvMsg : setSynMsg);
  }

  // Si des donnees sont arrivees, la page se recharge ; le message passe le
  // rechargement via sessionStorage.
  const annoncerSynchro = async (r, ou, setMsg) => {
    onEtat();   // compteurs de la barre (conflits…)
    if (r.decisionRequise) {
      // Appareil neuf : « remplace-t-il un autre ? » avant toute ecriture.
      setSyn(await window.api.synchro.etat());
      setDecisionOuverte(true);
      return;
    }
    if (r.erreur) { setMsg({ erreur: r.erreur }); return; }
    const morceaux = [];
    if (r.reconnecte) morceaux.push('Reconnecté à Google.');
    if (r.remplacement) {
      morceaux.push(r.remplacement.auto
        ? 'Appareil reconnu : il reprend le nom « ' + r.nom + ' » et la lettre « ' + r.prefixe + ' ».'
        : 'Cet appareil remplace « ' + r.remplacement.nom + ' » : il reprend son nom et sa lettre « ' + r.prefixe + ' ».');
    }
    if (r.supplante) {
      morceaux.push('« ' + r.supplante.par.nom + ' » a repris la lettre « ' + r.supplante.ancienPrefixe
        + ' » de cet appareil : ses nouvelles tuiles seront numérotées « ' + r.supplante.prefixe + ' ».');
    }
    if (r.renumerotees.length) {
      morceaux.push('Cet appareil numérote désormais ses tuiles « ' + r.prefixe + ' » : '
        + r.renumerotees.map((x) => x.avant + ' → ' + x.apres).join(', ') + '.');
    }
    morceaux.push(phraseBilan(r));
    if (r.conflits) morceaux.push(r.conflits + ' conflit(s) à trancher — la valeur la plus récente est affichée en attendant.');
    if (r.rattrapage) morceaux.push('Rattrapage depuis un snapshot.');
    if (r.tuilesOubliees) morceaux.push(r.tuilesOubliees + ' tuile(s) supprimée(s) depuis plus de 90 jours vidée(s).');
    const msg = { ok: morceaux.join(' '), conflits: r.conflits };
    if (r.change || r.appliquees || r.renumerotees.length || r.imagesRecues) {
      try { sessionStorage.setItem('synchro-msg', JSON.stringify({ ou, msg })); } catch { /* tant pis */ }
      await recharger();   // la base a change — repartir propre
      return;
    }
    setMsg(msg);
    setSyn(await window.api.synchro.etat());
  };

  // « Cet appareil en remplace-t-il un autre ? » (appareil neuf, avant sa
  // premiere synchro) : le choix est range, puis la synchro relancee.
  const [decisionOuverte, setDecisionOuverte] = useState(false);
  const decider = async (id) => {
    setDecisionOuverte(false);
    const par = syn && syn.decision && syn.decision.par;
    const r = await window.api.appareils.remplacer(id);
    if (r.erreur) { (par === 'drive' ? setDrvMsg : setSynMsg)({ erreur: r.erreur }); return; }
    setSyn(r.etat);
    if (par === 'dossier') synLancer(); else drvSynchroniser();
  };

  const synLancer = async () => {
    setSynMsg(null);
    const r = await window.api.synchro.synchroniser();
    annoncer(r, 'dossier');
  };

  const drvSynchroniser = async () => {
    setDrvMsg(null);
    const r = await window.api.synchro.drive();
    setDrv(await window.api.drive.etat());
    setSyn(await window.api.synchro.etat());
    annoncer(r, 'drive');
  };
  const syncDrive = prog.enCours && prog.par === 'drive';
  const syncDossier = prog.enCours && prog.par === 'dossier';
  // Session Google refusee (date) : affichee a la place de « Connecte » (service.noterSession).
  const sessionExpiree = (syn && syn.sessionExpiree) || null;

  useEffect(() => { window.api.raccourcis.etat().then(setRaccourcis); }, []);

  const basculerRaccourci = async (type) => {
    setRaccourciEnCours(type);
    const r = await window.api.raccourcis.basculer(type);
    setRaccourcis(r.etat);
    setRaccourciManuel(r.manuel);
    setRaccourciEnCours(null);
  };

  const definir = async (cle, valeur) => {
    await window.api.reglages.definir(cle, valeur);
    onEtat();
  };

  const reinitialiser = async () => {
    await definir('theme', 'auto');
    await window.api.reglages.definir('sidebar_repliee', '0');
    onEtat();
    setConfirmation(true);
    setTimeout(() => setConfirmation(false), 2400);
  };

  const effacerMarques = async () => {
    const r = await window.api.tags.effacerTout();
    setDemandeEffacement(false);
    setEffacementFait(r.supprimes);
    onEtat();
    setTimeout(() => setEffacementFait(null), 3500);
  };

  return (
    <div className="options">
      <h2>Options</h2>

      <section>
        <div className="etiquette">Thème</div>
        <div className="choix-themes">
          {THEMES.map(([cle, nom]) => (
            <button
              key={cle}
              className={'theme-bouton' + (etat.theme === cle ? ' actif' : '')}
              onClick={() => definir('theme', cle)}
            >
              <span className={'echantillon echantillon-' + cle} />
              {nom}
            </button>
          ))}
        </div>
      </section>

      {raccourcis && (
        <>
          <div className="filet" />
          <section>
            <div className="etiquette">Raccourcis</div>
            <div className="choix-raccourcis">
              {RACCOURCIS.map(([cle, labelAjout, labelPose]) => {
                const pose = raccourcis[cle];
                return (
                  <button
                    key={cle}
                    className={'raccourci-bouton' + (pose ? ' pose' : '')}
                    onClick={() => basculerRaccourci(cle)}
                    disabled={raccourciEnCours === cle}
                  >
                    {pose ? <I.Coche t={14} /> : <span className="raccourci-plus">+</span>}
                    {raccourciEnCours === cle ? '…' : (pose ? labelPose : labelAjout)}
                  </button>
                );
              })}
            </div>
            {raccourciManuel && (
              <div className="options-note" style={{ color: 'var(--laiton)' }}>
                Windows n’autorise plus l’épinglage automatique. Le dossier s’est ouvert : clic droit
                sur « Tuiles &amp; Toiles » → Épingler à la barre des tâches (ou glisse-le sur la barre).
              </div>
            )}
            <div className="options-note">
              {etat.forme === 'portable'
                ? 'Les raccourcis pointent vers l’exe portable actuel. Si tu le déplaces, refais-les.'
                : 'Les raccourcis pointent vers l’application installée.'}
            </div>
          </section>
        </>
      )}

      <div className="filet" />

      <section>
        <div className="etiquette">Préférences d'affichage</div>
        <button className="bouton-neutre" onClick={reinitialiser}>
          <I.Rafraichir t={16} /> Réinitialiser thème et barre latérale
        </button>
        {confirmation && <div className="options-confirmation"><I.Coche t={14} /> Préférences réinitialisées</div>}
        <div className="options-note">
          Les tuiles marquées livre / étoile / à revoir et la progression ne sont jamais touchées ici.
        </div>
      </section>

      <div className="filet" />

      <section>
        <div className="etiquette">Tuiles marquées</div>
        <button
          className="bouton-danger"
          onClick={() => setDemandeEffacement(true)}
          disabled={totalMarques === 0}
          style={totalMarques === 0 ? { opacity: 0.4, cursor: 'default' } : undefined}
        >
          <I.Croix t={14} /> Effacer toutes les marques
        </button>
        {effacementFait != null && (
          <div className="options-confirmation">
            <I.Coche t={14} /> {effacementFait} marque{effacementFait > 1 ? 's' : ''} effacée{effacementFait > 1 ? 's' : ''}
          </div>
        )}
        <div className="options-note">
          {totalMarques > 0
            ? `${totalMarques} tuile${totalMarques > 1 ? 's' : ''} actuellement marquée${totalMarques > 1 ? 's' : ''} (livre, étoile, à revoir).`
            : 'Aucune tuile marquée (livre, étoile, à revoir) pour l’instant.'}
        </div>
      </section>

      <div className="filet" />

      <SectionMaj etat={etat} definir={definir} />
      <div className="filet" />

      <SectionImages />

      <div className="filet" />
      <SectionRevision />

      <div className="filet" />
      <SectionLectureIA />

      <div className="filet" />

      {/* Synchronisation : un seul etat affiche (connecte / session expiree / non
          connecte), puis le reglage automatique, les appareils et (PC) le dossier
          partage replie. */}
      <section>
        <div className="etiquette">Synchronisation</div>
        {!drv ? (
          <div className="options-note">…</div>
        ) : !drv.configure ? (
          <div className="options-note">
            Synchronisation non disponible sur cette version (client OAuth absent).
          </div>
        ) : !drv.connecte ? (
          <>
            <div className="synchro-etat"><span>Non connecté à Google Drive.</span></div>
            <button className="bouton-neutre" onClick={drvConnecter} disabled={drvOccupe}>
              <I.Nuage t={16} /> {drvOccupe ? 'Connexion…' : 'Connecter Google Drive'}
            </button>
            <div className="options-note">
              Tes tuiles, marques et corrections passent d’un appareil à l’autre par ton Google
              Drive. {SUR_MOBILE ? 'Choisis ton compte Google' : 'Ouvre le navigateur pour autoriser l’accès'} :
              l’application ne voit que le dossier « Tuiles et Toiles » qu’elle crée dans ton
              Drive — rien d’autre.
            </div>
          </>
        ) : (
          <>
            {sessionExpiree ? (
              <div className="synchro-etat alerte">
                <span>
                  <strong>Session Google expirée</strong> (depuis le {new Date(sessionExpiree).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })}) :
                  la synchro est en pause. Reconnecte {drv.email || 'ton compte Google'}.
                </span>
              </div>
            ) : (
              <div className="synchro-etat ok">
                <I.Coche t={14} />
                <span>
                  Connecté à Google Drive : {drv.email || 'compte Google'}.{' '}
                  {syn && syn.derniereDrive
                    ? 'Dernière synchro le ' + new Date(syn.derniereDrive.le).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) + '.'
                    : 'Jamais synchronisé depuis cet appareil.'}
                </span>
              </div>
            )}
            <div className="choix-raccourcis">
              <button className={sessionExpiree ? 'bouton-valide' : 'bouton-neutre'} onClick={drvSynchroniser} disabled={drvOccupe || prog.enCours}>
                <I.Echange t={16} /> {syncDrive ? 'Synchro en cours…' : sessionExpiree ? 'Reconnecter et synchroniser' : 'Synchroniser'}
              </button>
              <button className="bouton-neutre" onClick={drvDeconnecter} disabled={drvOccupe || prog.enCours}>
                <I.Croix t={14} /> Déconnecter
              </button>
            </div>
            {syn && syn.conflits > 0 && (
              <div className="options-note">{syn.conflits} conflit(s) à trancher.</div>
            )}
            {!drvMsg && syn && syn.derniereDrive && (
              <div className="options-note">Dernière fois : {phraseBilan(syn.derniereDrive)}</div>
            )}
            {!drvMsg && syn && syn.echec && syn.echec.par === 'drive' && syn.echec.type !== 'session' && (
              <div className="options-note" style={{ color: syn.echec.type === 'reseau' ? undefined : 'var(--revoir)' }}>
                Dernier échec{syn.echec.auto ? ' (synchro automatique)' : ''}, le {new Date(syn.echec.le).toLocaleString('fr-FR')} : {syn.echec.libelle}.
              </div>
            )}
          </>
        )}
        {drvAction && (
          <div className="drive-encours">
            <span className="drive-pastille" />
            Connexion à Google Drive — autorise l’accès {SUR_MOBILE ? 'à l’écran' : 'dans le navigateur'}…
          </div>
        )}
        {syncDrive && <ProgressionSynchro p={prog} titre="Synchro avec Google Drive" />}
        {drvMsg && drvMsg.ok && <div className="options-confirmation"><I.Coche t={14} /> {drvMsg.ok}</div>}
        {drvMsg && drvMsg.conflits > 0 && aller && (
          <button className="bouton-neutre" onClick={() => aller('conflits')}><I.Echange t={16} /> Voir les conflits</button>
        )}
        {drvMsg && drvMsg.erreur && (
          <div className="options-note" style={{ color: 'var(--revoir)' }}>{drvMsg.erreur}</div>
        )}

        {syn && drv && (drv.connecte || syn.dossier) && (
          <>
            <div className="sous-etiquette">Automatique</div>
            <div className="choix-raccourcis">
              <button
                className={'raccourci-bouton' + (syn.auto && syn.auto.actif ? ' pose' : '')}
                onClick={async () => {
                  await window.api.reglages.definir('synchro_auto', syn.auto && syn.auto.actif ? '0' : '1');
                  setSyn(await window.api.synchro.etat());
                }}
              >
                {syn.auto && syn.auto.actif ? <I.Coche t={14} /> : <span className="raccourci-plus">+</span>}
                Synchroniser automatiquement
              </button>
              {syn.auto && syn.auto.mobile && (
                <button
                  className={'raccourci-bouton' + (syn.auto.wifiSeulement ? ' pose' : '')}
                  onClick={async () => {
                    await window.api.reglages.definir('synchro_wifi', syn.auto.wifiSeulement ? '0' : '1');
                    setSyn(await window.api.synchro.etat());
                  }}
                >
                  {syn.auto.wifiSeulement ? <I.Coche t={14} /> : <span className="raccourci-plus">+</span>}
                  Seulement en Wi-Fi
                </button>
              )}
            </div>
            {sessionExpiree && drv.connecte && syn.auto && syn.auto.actif && (
              <div className="options-note" style={{ color: 'var(--revoir)' }}>
                En pause tant que la session Google est expirée (voir plus haut).
              </div>
            )}
            {syn.auto && syn.auto.mobile && syn.auto.wifiSeulement && !syn.auto.wifi && (
              <div className="auto-avis">
                <span>En données mobiles : la synchro automatique attend le Wi-Fi. Tu peux synchroniser maintenant quand même.</span>
                {drv.connecte && !sessionExpiree && (
                  <button className="bouton-neutre" onClick={drvSynchroniser} disabled={syncDrive}>
                    <I.Nuage t={14} /> Synchroniser maintenant
                  </button>
                )}
              </div>
            )}
            <div className="options-note">
              Au lancement, une vingtaine de secondes après chaque modification, toutes les 15 minutes
              et à la fermeture. Rien n’est écrasé : chaque modification est fusionnée ; si une tuile a
              été modifiée des deux côtés, la plus récente s’affiche et l’autre attend dans « Conflits ».
              Sans connexion, elle réessaie plus tard ; elle ne demande jamais de reconnexion toute seule.
            </div>
          </>
        )}
      </section>

      {syn && syn.decision && (
        <div className="decision-bandeau">
          <span>
            <strong>Première synchro en attente.</strong> D’autres appareils utilisent déjà ce Drive :
            dis si celui-ci en remplace un (téléphone changé, appli réinstallée).
          </span>
          <button className="bouton-valide" onClick={() => setDecisionOuverte(true)}>Choisir</button>
        </div>
      )}
      {decisionOuverte && syn && syn.decision && (
        <BoiteRemplacement candidats={syn.decision.candidats} onChoisir={decider} onFermer={() => setDecisionOuverte(false)} />
      )}

      {syn && drv && (drv.connecte || syn.dossier) && <SectionAppareils syn={syn} drv={drv} onSyn={setSyn} />}

      {/* Dossier partage et sauvegarde .zip : propres au PC (dialogues de fichiers). */}
      {etat.forme !== 'mobile' && (
      <>
      <details className="options-replie" open={syn && syn.dossier ? true : undefined}>
        <summary>Autre méthode : dossier partagé (clé USB, OneDrive…)</summary>
      <section>
        {!syn ? (
          <div className="options-note">Chargement…</div>
        ) : !syn.dossier ? (
          <>
            <button className="bouton-neutre" onClick={synChoisir}>
              <I.Echange t={16} /> Choisir un dossier partagé…
            </button>
            <div className="options-note">
              Un dossier que tes appareils voient tous : clé USB, dossier OneDrive, Dropbox ou
              Syncthing. L’app y crée « Tuiles et Toiles » (même rangement que sur Google
              Drive, avec un LISEZMOI dans chaque dossier). Synchroniser envoie les changements
              de cet appareil et récupère ceux des autres — rien n’est écrasé, tout fusionne.
            </div>
          </>
        ) : (
          <>
            <div className="choix-raccourcis">
              <button className="bouton-neutre" onClick={synLancer} disabled={prog.enCours}>
                <I.Echange t={16} /> {syncDossier ? 'Synchro en cours…' : 'Synchroniser maintenant'}
              </button>
              <button className="bouton-neutre" onClick={synChoisir} disabled={prog.enCours}>
                Changer de dossier…
              </button>
              <button className="bouton-neutre" onClick={synOublier} disabled={prog.enCours}>
                Oublier ce dossier
              </button>
            </div>
            <div className="options-note">
              Dossier : {syn.dossier}. Cet appareil : {syn.appareil.nom} (tuiles « {syn.appareil.prefixe} »).{' '}
              {syn.derniere
                ? 'Dernière synchro le ' + new Date(syn.derniere.le).toLocaleString('fr-FR') + '.'
                : 'Jamais synchronisé.'}
              {syn.conflits ? ' ' + syn.conflits + ' conflit(s) à trancher.' : ''}
            </div>
            {!synMsg && syn.derniere && (
              <div className="options-note">Dernière fois : {phraseBilan(syn.derniere)}</div>
            )}
            {syn.avertissement && (
              <div className="options-note" style={{ color: 'var(--revoir)' }}>{syn.avertissement}</div>
            )}
          </>
        )}
        {syncDossier && <ProgressionSynchro p={prog} titre="Synchro avec le dossier partagé" />}
        {prog.enCours && !syncDossier && syn && syn.dossier && (
          <div className="options-note">Une synchro Google Drive est en cours : celle-ci attendra qu’elle se termine.</div>
        )}
        {synMsg && synMsg.ok && <div className="options-confirmation"><I.Coche t={14} /> {synMsg.ok}</div>}
        {synMsg && synMsg.conflits > 0 && aller && (
          <button className="bouton-neutre" onClick={() => aller('conflits')}><I.Echange t={16} /> Voir les conflits</button>
        )}
        {synMsg && synMsg.erreur && (
          <div className="options-note" style={{ color: 'var(--revoir)' }}>{synMsg.erreur}</div>
        )}
      </section>
      </details>

      <div className="filet" />

      <section>
        <div className="etiquette">Sauvegarde des données</div>
        <div className="choix-raccourcis">
          <button className="bouton-neutre" onClick={exporterDonnees} disabled={sauvOccupe}>
            <I.FlecheVert t={16} bas /> Exporter mes données (.zip)
          </button>
          <button className="bouton-neutre" onClick={choisirImport} disabled={sauvOccupe}>
            <I.FlecheVert t={16} /> Importer une sauvegarde…
          </button>
        </div>
        {sauvMsg && sauvMsg.ok && (
          <div className="options-confirmation"><I.Coche t={14} /> {sauvMsg.ok}</div>
        )}
        {sauvMsg && sauvMsg.conflits > 0 && aller && (
          <button className="bouton-neutre" onClick={() => aller('conflits')}><I.Echange t={16} /> Voir les conflits</button>
        )}
        {sauvMsg && sauvMsg.erreur && (
          <div className="options-note" style={{ color: 'var(--revoir)' }}>{sauvMsg.erreur}</div>
        )}
        <div className="options-note">
          Le zip contient tes tuiles créées, tes corrections, tes archives et tes marques —
          pas le pack. L’import <strong>fusionne</strong> la sauvegarde avec tes données : ce
          qui manque revient, rien n’est effacé. Pour annuler une modification, passe plutôt
          par la tuile elle-même.
        </div>
        {copie && (
          <div className="options-note">
            Copie de sécurité automatique chaque semaine (4 gardées) :{' '}
            {copie.derniere
              ? 'la dernière date du ' + new Date(copie.derniere.le).toLocaleDateString('fr-FR', { dateStyle: 'long' }) + '. '
              : 'la première sera faite sous peu. '}
            {copie.derniere && (
              <button className="lien-discret" onClick={() => window.api.copieSecurite.ouvrir()}>Ouvrir le dossier</button>
            )}
          </div>
        )}
      </section>

      </>
      )}

      <div className="filet" />

      <section>
        <div className="etiquette">Signaler un problème</div>
        <button className="bouton-neutre" onClick={() => setRapportOuvert(true)}>
          <I.FlecheVert t={16} /> Envoyer le log pour rapport d’erreur
        </button>
        <div className="options-note">
          Envoie en un clic un rapport au développeur : ta description, le journal de
          fonctionnement et l’état de l’application. Ton nom d’utilisateur Windows, le nom de
          ton ordinateur et tes adresses email sont masqués ; tu peux voir ce qui part avant
          d’envoyer. Sans connexion, le rapport part au prochain lancement.
        </div>
      </section>

      {rapportOuvert && <FormulaireRapport onFermer={() => setRapportOuvert(false)} />}

      {sauvImport && (
        <BoiteConfirmation
          titre="Importer cette sauvegarde ?"
          texteConfirmer="Importer et fusionner"
          onAnnuler={() => setSauvImport(null)}
          onConfirmer={confirmerImport}
        >
          <p>
            Le contenu de la sauvegarde (tuiles créées, corrections, archives, marques) sera
            <strong> fusionné</strong> avec tes données : ce qui manque ici revient, rien
            n’est effacé. Si une même tuile a changé des deux côtés, la version la plus
            récente est gardée et l’autre t’est proposée dans « Conflits ».
          </p>
          {sauvImport.manifest && (
            <p className="options-note">
              Sauvegarde du{' '}
              {new Date(sauvImport.manifest.exporteLe).toLocaleString('fr-FR')} ·{' '}
              {sauvImport.manifest.oeuvresLocales ?? '?'} tuile(s) locale(s) ·{' '}
              {sauvImport.manifest.marques ?? '?'} marque(s) · pack{' '}
              {sauvImport.manifest.pack || '?'}
            </p>
          )}
          <p>
            Une copie de ta base actuelle est gardée (utilisateur.db.avant-import-…). Si la
            synchro est active, ces données partiront aussi vers tes autres appareils.
          </p>
        </BoiteConfirmation>
      )}

      {demandeEffacement && (
        <BoiteConfirmation
          titre="Effacer toutes les marques ?"
          texteConfirmer="Tout effacer"
          onAnnuler={() => setDemandeEffacement(false)}
          onConfirmer={effacerMarques}
        >
          <p>
            Les {totalMarques} marques livre, étoile et à revoir seront retirées.
            Les {etat.oeuvres} œuvres, leurs informations, tes corrections et ta
            progression ne sont pas touchées — seules les marques disparaissent.
          </p>
          <p>
            Tu pourras re-marquer n’importe quelle tuile à tout moment. Cette
            action ne peut pas être annulée.
          </p>
        </BoiteConfirmation>
      )}
    </div>
  );
}
