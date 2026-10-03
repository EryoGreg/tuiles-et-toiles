// Decoupe d'App.jsx (etape 1 de Bristol) : code inchange, voir scripts/decouper-app.js.
import { useEffect, useState, useCallback, createContext, useContext } from 'react';
import * as I from '../icones.jsx';
import { SUR_MOBILE, enMo, pourcent } from '../commun/base.jsx';

/* ---------------------------------------------------------- mise a jour */

// Etat de mise a jour partage entre le bandeau (verification au lancement) et
// la section Options. phase : null | 'verif' | 'ajour' | 'dispo' |
// 'telechargement' | 'pret' | 'erreur'. Rien n'est telecharge sans clic.
export function useMaj() {
  const [s, setS] = useState({ phase: null });
  const [progression, setProgression] = useState(null);
  useEffect(() => window.api.maj.onProgression(setProgression), []);

  // migration : version installee proposee a un utilisateur du portable
  // (connue meme quand l'appli est a jour).
  const verifier = useCallback(async (silencieux) => {
    setS({ phase: 'verif' });
    const r = await window.api.maj.verifier();
    const migration = r.migration || null;
    if (r.disponible) setS({ phase: 'dispo', info: r, migration });
    else if (r.aJour) setS({ phase: silencieux ? null : 'ajour', migration });
    else setS(silencieux ? { phase: null, migration } : { phase: 'erreur', erreur: r.erreur, migration });
  }, []);

  const telecharger = useCallback(async () => {
    setProgression(null);
    setS((p) => ({ ...p, phase: 'telechargement', erreur: null, versInstallee: false }));
    const r = await window.api.maj.telecharger();
    if (r.ok) setS((p) => ({ ...p, phase: 'pret' }));
    else setS((p) => ({ ...p, phase: 'dispo', erreur: r.pageOuverte ? null : r.erreur }));
  }, []);

  // Portable -> version installee : telecharge l'installateur.
  const passerInstallee = useCallback(async () => {
    setProgression(null);
    setS((p) => ({ ...p, phase: 'telechargement', erreur: null, versInstallee: true }));
    const r = await window.api.maj.telecharger({ versInstallee: true });
    if (r.ok) setS((p) => ({ ...p, phase: 'pret' }));
    else setS((p) => ({ ...p, phase: p.info ? 'dispo' : null, versInstallee: false, erreur: r.erreur }));
  }, []);

  const installer = useCallback(async () => {
    const r = await window.api.maj.installer();
    if (r.erreur) setS((p) => ({ ...p, erreur: r.erreur }));
  }, []);

  return { ...s, progression, verifier, telecharger, passerInstallee, installer };
}

export const MajContext = createContext(null);

// Boutons d'action selon la phase (bandeau et Options).
export function ActionsMaj({ maj }) {
  if (maj.phase === 'dispo') {
    return (
      <button className="bouton-valide" onClick={maj.telecharger}>
        <I.FlecheVert t={14} bas />
        {maj.info.installable
          ? 'Télécharger la version ' + maj.info.version + ' (' + enMo(maj.info.taille) + ')'
          : 'Voir la version ' + maj.info.version + ' sur GitHub'}
      </button>
    );
  }
  if (maj.phase === 'pret') {
    return (
      <button className="bouton-valide" onClick={maj.installer}>
        <I.Rafraichir t={14} /> {maj.versInstallee
          ? 'Installer et redémarrer'
          : SUR_MOBILE
            ? 'Installer la version ' + maj.info.version
            : 'Redémarrer sur la version ' + maj.info.version}
      </button>
    );
  }
  if (maj.phase === 'telechargement') {
    return (
      <div className="maj-progression">
        <div className="maj-jauge"><span style={{ width: pourcent(maj.progression) + '%' }} /></div>
        Téléchargement… {pourcent(maj.progression)} %
      </div>
    );
  }
  return null;
}

// Bandeau discret en bas a droite quand une version plus recente existe.
export function BandeauMaj() {
  const maj = useContext(MajContext);
  const [masque, setMasque] = useState(false);
  if (!maj || masque || !['dispo', 'telechargement', 'pret'].includes(maj.phase)) return null;
  if (maj.versInstallee) {
    return (
      <div className="maj-bandeau">
        <div className="maj-bandeau-titre">Version installée {maj.phase === 'pret' ? 'prête' : 'en téléchargement'}</div>
        <div className="options-note">
          L’application va se fermer, l’installateur s’affiche quelques secondes puis la relance.
          Tes données sont conservées.
        </div>
        {maj.erreur && <div className="options-note" style={{ color: 'var(--revoir)' }}>{maj.erreur}</div>}
        <div className="maj-bandeau-actions">
          <ActionsMaj maj={maj} />
          {maj.phase !== 'telechargement' && (
            <button className="bouton-neutre" onClick={() => setMasque(true)}>Plus tard</button>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="maj-bandeau">
      <div className="maj-bandeau-titre">
        {maj.phase === 'pret'
          ? 'Version ' + maj.info.version + ' prête'
          : 'Version ' + maj.info.version + ' disponible'}
      </div>
      <div className="options-note">
        {maj.phase === 'pret'
          ? (SUR_MOBILE
            ? 'Android va te demander de confirmer l’installation. Tes données sont conservées.'
            : 'L’application va se fermer et se relancer. Tes données sont conservées.')
          : 'Tu utilises la version ' + maj.info.actuelle + '. Tes données sont conservées.'}
      </div>
      {maj.erreur && <div className="options-note" style={{ color: 'var(--revoir)' }}>{maj.erreur}</div>}
      <div className="maj-bandeau-actions">
        <ActionsMaj maj={maj} />
        {maj.phase !== 'telechargement' && (
          <button className="bouton-neutre" onClick={() => setMasque(true)}>Plus tard</button>
        )}
      </div>
    </div>
  );
}

// Section « Mises à jour » des Options.
export function SectionMaj({ etat, definir }) {
  const maj = useContext(MajContext);
  const occupe = maj.phase === 'verif' || maj.phase === 'telechargement';
  return (
    <section>
      <div className="etiquette">Mises à jour</div>
      <div className="choix-raccourcis">
        <button className="bouton-neutre" onClick={() => maj.verifier(false)} disabled={occupe}>
          <I.Rafraichir t={16} /> {maj.phase === 'verif' ? 'Recherche…' : 'Rechercher une mise à jour'}
        </button>
        <button
          className={'raccourci-bouton' + (etat.majAuto ? ' pose' : '')}
          onClick={() => definir('maj_auto', etat.majAuto ? '0' : '1')}
        >
          {etat.majAuto ? <I.Coche t={14} /> : <span className="raccourci-plus">+</span>}
          Vérifier au lancement
        </button>
      </div>
      <ActionsMaj maj={maj} />
      {etat.forme === 'portable' && maj.migration && maj.phase !== 'telechargement' && maj.phase !== 'pret' && (
        <div className="maj-migration">
          <div className="options-note">
            Tu utilises la version <strong>portable</strong> : elle se décompresse à chaque lancement,
            ce qui est lent sur un ordinateur modeste. La version <strong>installée</strong> démarre
            bien plus vite (installation pour ta session seulement, sans droits administrateur). Tes
            données ne bougent pas ; l’exe portable est supprimé une fois l’installation faite.
          </div>
          <button className="bouton-neutre" onClick={maj.passerInstallee}>
            <I.FlecheVert t={14} bas /> Passer à la version installée ({enMo(maj.migration.taille)})
          </button>
        </div>
      )}
      {maj.phase === 'ajour' && (
        <div className="options-confirmation"><I.Coche t={14} /> Tu as la dernière version.</div>
      )}
      {maj.erreur && <div className="options-note" style={{ color: 'var(--revoir)' }}>{maj.erreur}</div>}
      <div className="options-note">
        Version installée : {etat.version}. Les nouvelles versions viennent de
        github.com/EryoGreg/tuiles-et-toiles ; seule l’application est remplacée, tes données restent.
        {SUR_MOBILE && ' La première fois, Android te demandera d’autoriser Tuiles & Toiles à installer des applications.'}
      </div>
    </section>
  );
}
