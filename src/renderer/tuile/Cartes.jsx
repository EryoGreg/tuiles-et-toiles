// Decoupe d'App.jsx (etape 1 de Bristol) : code inchange, voir scripts/decouper-app.js.
import { useEffect, useState, useRef, useContext } from 'react';
import * as I from '../icones.jsx';
import { NavContext } from '../commun/base.jsx';
import { BoiteConfirmation } from '../commun/boites.jsx';
import { Tuile } from './Tuile.jsx';

export const PIPS = [
  ['livre', 'var(--livre)'],
  ['etoile', 'var(--etoile)'],
  ['bad_smiley', 'var(--revoir)']
];

// Tuile concernee par un conflit de synchro (a trancher dans « Conflits »).
export function PastilleConflit() {
  return (
    <span className="pastille-conflit" title="Modifiée sur deux appareils : à trancher dans « Conflits »">
      <I.Echange t={10} /> conflit
    </span>
  );
}

// Carte commune a la Bibliotheque et aux galeries. Clic n'importe ou =
// agrandir ; la croix (galeries seulement) retire le tag sans agrandir.
// Appui long au doigt (500 ms sans bouger) = clic droit : le menu s'ouvre et le
// toucher qui suit n'ouvre pas l'apercu. Le contextmenu natif d'Android, s'il
// arrive aussi, rouvre le meme menu au meme endroit.
export function useAppuiLong(onLong) {
  const t = useRef(null);
  const depart = useRef(null);
  const long = useRef(false);
  const annuler = () => { clearTimeout(t.current); t.current = null; };
  if (!onLong) return { props: {}, avale: () => false };
  return {
    props: {
      onPointerDown: (e) => {
        long.current = false;
        if (e.pointerType !== 'touch') return;
        depart.current = { x: e.clientX, y: e.clientY };
        annuler();
        t.current = setTimeout(() => { long.current = true; onLong({ clientX: depart.current.x, clientY: depart.current.y }); }, 500);
      },
      onPointerMove: (e) => {
        if (!t.current || !depart.current) return;
        if (Math.abs(e.clientX - depart.current.x) > 10 || Math.abs(e.clientY - depart.current.y) > 10) annuler();
      },
      onPointerUp: annuler,
      onPointerCancel: annuler
    },
    avale: () => { const v = long.current; long.current = false; return v; }
  };
}

export function CarteTuile({ o, onOuvrir, onRetirer, nomRetirer, onMenu }) {
  const appui = useAppuiLong(onMenu ? (e) => onMenu(e, o) : null);
  return (
    <div
      className="carte-galerie"
      onClick={(e) => { if (appui.avale()) return; if (onOuvrir) onOuvrir(e); }}
      onContextMenu={onMenu ? (e) => { e.preventDefault(); onMenu(e, o); } : undefined}
      {...appui.props}
    >
      {onRetirer && (
        <button
          className="carte-galerie-retirer"
          onClick={(e) => { e.stopPropagation(); onRetirer(); }}
          title={nomRetirer}
        >
          <I.Croix t={12} />
        </button>
      )}
      {o.image
        ? <img className="carte-galerie-image" src={o.vignette || o.image} alt="" loading="lazy" />
        : <div className="carte-galerie-image carte-galerie-image-vide" />}
      <div className="carte-galerie-corps">
        <span className="numero">#{o.ref}{o.conflit && <PastilleConflit />}{o.aNote && <span className="carte-note" title="Ma note"><I.Note t={12} /></span>}</span>
        <div className="carte-galerie-titre">{o.titre || '—'}</div>
        <div className="carte-galerie-artiste">
          {o.artiste || '—'}{o.date ? ' · ' + o.date : ''}
        </div>
      </div>
      {o.tagsUtilisateur && o.tagsUtilisateur.length > 0 && (
        <div className="carte-galerie-pips">
          {PIPS.filter(([t]) => o.tagsUtilisateur.includes(t))
            .map(([t, c]) => <span key={t} className="pip" style={{ background: c }} />)}
        </div>
      )}
    </div>
  );
}

// Menu contextuel d'une carte (clic droit ; appui long sur mobile) : agrandir,
// modifier, marquer, mettre a la corbeille. Chaque geste passe par les memes
// canaux que les boutons (donc annulable par Ctrl+Z et synchronise).
export const MARQUES_MENU = [['livre', 'Livre', I.Livre], ['etoile', 'Étoile', I.Etoile], ['bad_smiley', 'À revoir', I.Revoir]];

export function useMenuTuile({ onMaj, onAgrandir, onEtat }) {
  const [menu, setMenu] = useState(null);         // { x, y, o }
  const [suppr, setSuppr] = useState(null);       // tuile a mettre a la corbeille
  const { modifierTuile } = useContext(NavContext);
  const fermer = () => setMenu(null);
  // Appui long au doigt : le menu s'ouvre sous le doigt, puis Android envoie
  // son propre « contextmenu », le clic du relachement et parfois un petit
  // defilement — tous sur le fond du menu, qui le refermaient aussitot. Rien
  // ne ferme le menu pendant 700 ms apres son ouverture.
  const ouvertLe = useRef(0);
  const fermerSiStable = () => { if (Date.now() - ouvertLe.current > 700) fermer(); };
  useEffect(() => {
    if (!menu) return undefined;
    const echap = (e) => { if (e.key === 'Escape') fermer(); };
    window.addEventListener('keydown', echap);
    window.addEventListener('resize', fermerSiStable);
    window.addEventListener('scroll', fermerSiStable, true);
    return () => {
      window.removeEventListener('keydown', echap);
      window.removeEventListener('resize', fermerSiStable);
      window.removeEventListener('scroll', fermerSiStable, true);
    };
  }, [menu]);
  const surMenu = (e, o) => {
    // Deja ouvert pour cette tuile a l'instant (appui long puis contextmenu natif) : rien a refaire.
    if (menu && menu.o.id === o.id && Date.now() - ouvertLe.current < 700) return;
    ouvertLe.current = Date.now();
    // Garde le menu dans la fenetre (220 x ~260 px).
    const x = Math.min(e.clientX, window.innerWidth - 230);
    const y = Math.min(e.clientY, window.innerHeight - 280);
    setMenu({ x: Math.max(8, x), y: Math.max(8, y), o });
    window.api.evt('ui', 'menu-tuile', { id: o.id, ref: o.ref });
  };
  const fait = () => { fermer(); if (onMaj) onMaj(); if (onEtat) onEtat(); };
  const marquer = async (tag) => { await window.api.tags.basculer(menu.o.id, tag); fait(); };
  const supprimer = async () => {
    const o = suppr;
    setSuppr(null);
    await window.api.edition.supprimer(o.id);
    if (onMaj) onMaj();
    if (onEtat) onEtat();
  };
  const tags = (menu && menu.o.tagsUtilisateur) || [];
  const rendu = (
    <>
      {menu && (
        <div className="menu-tuile-fond" onClick={fermerSiStable} onContextMenu={(e) => { e.preventDefault(); fermerSiStable(); }}>
          <div className="menu-tuile" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()} role="menu">
            <div className="menu-tuile-tete">#{menu.o.ref} {menu.o.titre || ''}</div>
            {onAgrandir && (
              <button role="menuitem" onClick={() => { const o = menu.o; fermer(); onAgrandir(o); }}>
                <I.Loupe t={14} /> Agrandir
              </button>
            )}
            {modifierTuile && (
              <button role="menuitem" onClick={() => { const o = menu.o; fermer(); modifierTuile(o.id); }}>
                <I.Crayon t={14} /> Modifier
              </button>
            )}
            <div className="menu-tuile-filet" />
            {MARQUES_MENU.map(([t, nom, Ic]) => (
              <button key={t} role="menuitemcheckbox" aria-checked={tags.includes(t)} onClick={() => marquer(t)}>
                <Ic t={14} /> {nom}{tags.includes(t) && <span className="menu-tuile-coche"><I.Coche t={12} /></span>}
              </button>
            ))}
            <div className="menu-tuile-filet" />
            <button role="menuitem" className="danger" onClick={() => { const o = menu.o; fermer(); setSuppr(o); }}>
              <I.Corbeille t={14} /> Mettre à la corbeille
            </button>
          </div>
        </div>
      )}
      {suppr && (
        <BoiteConfirmation
          titre={'Mettre #' + suppr.ref + ' à la corbeille ?'}
          texteConfirmer="Mettre à la corbeille"
          onAnnuler={() => setSuppr(null)}
          onConfirmer={supprimer}
        >
          <p>Elle disparaît des listes et du tirage, avec ses marques. Tu peux la restaurer depuis la Corbeille.</p>
        </BoiteConfirmation>
      )}
    </>
  );
  return { surMenu, rendu };
}

// Recouvrement plein ecran : la tuile agrandie a la taille exacte du jeu,
// mais TOUT visible (rien de masque). Les sections qu'un tirage cacherait
// sont soulignees en pointilles dore. Marquer y fonctionne partout —
// Bibliotheque, Livre, Étoile, À revoir.
export const SUR_VIDE = new Set();

export function RecouvrementApercu({ id, onFermer, onEtat }) {
  const [tuile, setTuile] = useState(null);

  useEffect(() => {
    setTuile(null);
    window.api.jeu.apercu(id).then(setTuile);
  }, [id]);

  const marquer = async (tag) => {
    const r = await window.api.tags.basculer(id, tag);
    setTuile((t) => ({
      ...t,
      tagsUtilisateur: r.actif
        ? [...t.tagsUtilisateur, tag]
        : t.tagsUtilisateur.filter((x) => x !== tag)
    }));
    if (onEtat) onEtat();
  };

  useEffect(() => {
    const clavier = (e) => {
      if (e.key === 'Escape') {
        // Une vue image plein cadre ou la boite « Ma note » est ouverte par-dessus :
        // la laisser se fermer d'abord, ne pas refermer tout l'apercu du meme coup.
        if (document.querySelector('.recouvrement-image, .boite-note')) return;
        onFermer();
        return;
      }
      if (!tuile) return;
      if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
      if (e.key.toLowerCase() === 'l') marquer('livre');
      if (e.key.toLowerCase() === 'e') marquer('etoile');
      if (e.key.toLowerCase() === 's') marquer('bad_smiley');
    };
    window.addEventListener('keydown', clavier);
    return () => window.removeEventListener('keydown', clavier);
  });

  return (
    <div className="recouvrement-apercu" onClick={onFermer}>
      <div className="jeu apercu-jeu" onClick={(e) => e.stopPropagation()}>
        <Tuile
          tuile={tuile} revele={null} sur={SUR_VIDE}
          onReveler={() => {}} onMarquer={marquer}
          apercu onFermer={onFermer}
          onSuivante={() => {}} onPrecedente={() => {}} peutRevenir={false}
        />
      </div>
    </div>
  );
}
