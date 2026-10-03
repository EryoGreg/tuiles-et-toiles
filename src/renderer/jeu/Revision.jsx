// Decoupe d'App.jsx (etape 1 de Bristol) : code inchange, voir scripts/decouper-app.js.
import { useEffect, useState, useCallback, useRef } from 'react';
import * as I from '../icones.jsx';
import { Tuile } from '../tuile/Tuile.jsx';

// Repetition espacee (revision.js) : comme une partie, mais la tuile vient de
// la file du jour, et apres « Tout reveler » on note son souvenir (1-4).
export const NOTES_REVISION = [
  [1, 'Encore', 'Oubliée : elle revient dans quelques minutes'],
  [2, 'Difficile', 'Retrouvée avec peine'],
  [3, 'Bien', 'Retrouvée'],
  [4, 'Facile', 'Retrouvée sans effort']
];

export function dureeRevision(j) {
  if (!j) return '10 min';
  if (j < 30) return j + ' j';
  if (j < 365) return Math.round(j / 30) + ' mois';
  const a = Math.round(j / 36.5) / 10;
  return String(a).replace('.', ',') + ' an' + (a >= 2 ? 's' : '');
}

export function texteRevision(c) {
  if (!c) return '';
  const bouts = [];
  if (c.dues) bouts.push(c.dues + ' à revoir');
  if (c.nouvelles) bouts.push(c.nouvelles + ' nouvelle' + (c.nouvelles > 1 ? 's' : ''));
  if (!bouts.length) {
    return c.prochaine
      ? 'Rien à revoir pour l’instant — prochaine le ' + new Date(c.prochaine).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) + '.'
      : 'Rien à revoir pour l’instant.';
  }
  return 'Aujourd’hui : ' + bouts.join(' · ') + '.';
}

export function Revision({ onChanger, onEtat }) {
  const [tuile, setTuile] = useState(null);       // tuile + .revision, ou { fini, compte }
  const [revele, setRevele] = useState(null);
  const [sur, setSur] = useState(new Set());
  const [note, setNote] = useState(null);         // note en cours d'envoi
  const derniere = useRef(null);

  const tirer = useCallback(async () => {
    const t = await window.api.revision.tirer(derniere.current ? [derniere.current] : []);
    setRevele(null); setSur(new Set()); setNote(null);
    setTuile(t);
  }, []);
  useEffect(() => { tirer(); }, [tirer]);

  const reveler = async (champ) => {
    if (!tuile || tuile.fini) return;
    if (champ === null) {
      setRevele(await window.api.jeu.reveler(tuile.id));
    } else {
      setSur((s) => new Set(s).add(champ));
      const complet = await window.api.jeu.reveler(tuile.id);
      setTuile((t) => ({ ...t, champs: { ...t.champs, [champ]: complet[champ] } }));
    }
  };
  const noter = async (n) => {
    if (!tuile || tuile.fini || !revele || note) return;
    setNote(n);
    await window.api.revision.noter(tuile.id, n);
    derniere.current = tuile.id;
    onEtat();
    tirer();
  };
  const marquer = async (tag) => {
    const r = await window.api.tags.basculer(tuile.id, tag);
    setTuile((t) => ({
      ...t,
      tagsUtilisateur: r.actif ? [...t.tagsUtilisateur, tag] : t.tagsUtilisateur.filter((x) => x !== tag)
    }));
    onEtat();
  };

  useEffect(() => {
    const clavier = (e) => {
      if (!tuile || tuile.fini) return;
      if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
      if (document.querySelector('.boite-note')) return;
      if (e.code === 'Space') { e.preventDefault(); reveler(null); }
      if (revele && ['1', '2', '3', '4'].includes(e.key)) noter(Number(e.key));
      if (e.key.toLowerCase() === 'l') marquer('livre');
      if (e.key.toLowerCase() === 'e') marquer('etoile');
      if (e.key.toLowerCase() === 's') marquer('bad_smiley');
    };
    window.addEventListener('keydown', clavier);
    return () => window.removeEventListener('keydown', clavier);
  });

  if (tuile && tuile.fini) {
    const c = tuile.compte;
    return (
      <div className="revision-fin">
        <div className="revision-fin-icone"><I.Coche t={28} /></div>
        <h2>Révision terminée pour aujourd’hui</h2>
        <p>
          {c.faitesAujourdhui
            ? c.faitesAujourdhui + ' note' + (c.faitesAujourdhui > 1 ? 's' : '') + ' aujourd’hui. '
            : ''}
          {c.apprises} tuile{c.apprises > 1 ? 's' : ''} en cours d’apprentissage sur {c.total}.
        </p>
        <p className="revision-fin-note">
          {c.prochaine
            ? 'Prochaine tuile à revoir : ' + new Date(c.prochaine).toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' }) + '.'
            : ''}
          {' '}Jusqu’à {c.quotaNouvelles} nouvelle{c.quotaNouvelles > 1 ? 's' : ''} tuile{c.quotaNouvelles > 1 ? 's' : ''} par jour (Options → Révision espacée).
        </p>
        <button className="bouton-neutre" onClick={onChanger}><I.Fleche t={16} retour /> Choisir un autre mode</button>
      </div>
    );
  }

  const r = tuile && tuile.revision;
  const compteur = r
    ? (r.nouvelle ? 'Nouvelle tuile · ' : 'À revoir · ') + texteRevision(r.compte).replace(/^Aujourd’hui : /, 'reste ').replace(/\.$/, '')
    : '';
  const actions = !r ? null : !revele ? (
    <button className="bouton-valide" onClick={() => reveler(null)} title="Espace">
      <I.Coche /> Tout révéler
    </button>
  ) : (
    <div className="notes-revision" role="group" aria-label="Ton souvenir">
      {NOTES_REVISION.map(([n, nom, aide]) => (
        <button key={n} className={'note-revision note-' + n} onClick={() => noter(n)} disabled={!!note} title={aide + ' (touche ' + n + ')'}>
          <span className="note-revision-nom">{nom}</span>
          <span className="note-revision-delai">{dureeRevision(r.apercu[n])}</span>
        </button>
      ))}
    </div>
  );

  return (
    <div className="jeu">
      <Tuile
        tuile={tuile && !tuile.fini ? tuile : null} revele={revele} sur={sur}
        onReveler={reveler} onSuivante={() => { if (!revele) reveler(null); }}
        onPrecedente={() => {}} onMarquer={marquer} peutRevenir={false}
        onChanger={onChanger} compteur={compteur} actions={actions}
      />
    </div>
  );
}
