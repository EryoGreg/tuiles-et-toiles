// Frise des dates : chaque tuile datee posee a sa date, sur une echelle par
// epoques (echelle.js). Defilement horizontal (et vertical si les tuiles
// s'empilent), zoom, vue d'ensemble cliquable en haut. Toucher une tuile =
// l'agrandir, comme dans la Bibliotheque.
import { useEffect, useLayoutEffect, useState, useRef, useMemo, useContext, useCallback } from 'react';
import * as I from '../icones.jsx';
import { NavContext, SUR_MOBILE, usePref, useSession } from '../commun/base.jsx';
import { RecouvrementApercu, useMenuTuile } from '../tuile/Cartes.jsx';
import { SelecteurTags } from '../galeries/Galeries.jsx';
import { creerEchelle, graduations, milieu, nomQuiTient, ranger, texteAnnee } from './echelle.js';

const ZOOMS = [1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24];
const ETROIT = () => typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 700px)').matches;

export function PageFrise({ onEtat }) {
  const [q, setQ] = useSession('frise:recherche', '');
  const [cats, setCats] = usePref('frise:categories', []);
  const [soustractif, setSoustractif] = usePref('frise:soustractif', false);
  const [zoom, setZoom] = usePref('frise:zoom', ETROIT() ? 6 : 3);
  const [corpus, setCorpus] = useState(null);       // toutes les tuiles : l'echelle ne bouge pas au filtrage
  const [affichees, setAffichees] = useState(null);
  const [apercuId, setApercuId] = useState(null);
  const [survol, setSurvol] = useState(null);
  const [nonce, setNonce] = useState(0);
  const [vue, setVue] = useState({ largeur: 0, gauche: 0, visible: 0 });
  const vueRef = useRef(null);
  const ancre = useRef(null);       // fraction a garder au centre lors d'un zoom

  useEffect(() => {
    let vivant = true;
    window.api.oeuvres.toutes().then((r) => { if (vivant) setCorpus(r); });
    return () => { vivant = false; };
  }, [nonce]);

  const filtre = q.trim().length > 0 || cats.length > 0;
  useEffect(() => {
    if (!filtre) { setAffichees(null); return undefined; }
    let vivant = true;
    const t = setTimeout(async () => {
      const criteres = {};
      if (q.trim()) criteres.texte = q;
      if (cats.length) { criteres.categories = cats; criteres.soustractif = soustractif; }
      const r = await window.api.oeuvres.toutes(criteres);
      if (vivant) setAffichees(r);
    }, 120);
    return () => { vivant = false; clearTimeout(t); };
  }, [q, cats, soustractif, nonce, filtre]);

  const datees = useMemo(() => (corpus ? corpus.filter((o) => o.periode) : []), [corpus]);
  const ech = useMemo(() => creerEchelle(datees.map((o) => milieu(o.periode))), [datees]);
  const liste = filtre ? affichees : corpus;
  const listeDatees = useMemo(() => (liste ? liste.filter((o) => o.periode) : null), [liste]);
  const sansDate = liste ? liste.length - listeDatees.length : 0;

  // Largeur de la vue (barre laterale, rotation du telephone…)
  useLayoutEffect(() => {
    const el = vueRef.current;
    if (!el) return undefined;
    const maj = () => setVue({ largeur: el.clientWidth, gauche: el.scrollLeft, visible: el.clientWidth });
    maj();
    const ro = new ResizeObserver(maj);
    ro.observe(el);
    return () => ro.disconnect();
  }, [corpus]);

  const etroit = vue.largeur > 0 && vue.largeur < 700;
  const C = etroit ? 46 : 62;               // cote d'une vignette
  const H_CARTE = C + (etroit ? 16 : 20);   // vignette + date
  const W = Math.max(vue.largeur, Math.round(vue.largeur * zoom));
  const rang = useMemo(
    () => (listeDatees && W ? ranger(listeDatees, ech, W, C) : { places: new Map(), couloirs: 0 }),
    [listeDatees, ech, W, C]
  );
  const ticks = useMemo(() => (W ? graduations(ech, W, etroit ? 70 : 90) : []), [ech, W, etroit]);

  // Zoom centre : la date au centre de l'ecran (ou sous la souris) reste en place.
  const changerZoom = useCallback((z, fx) => {
    const el = vueRef.current;
    if (!el) { setZoom(z); return; }
    const px = fx == null ? el.clientWidth / 2 : fx;
    const Wc = Math.max(el.clientWidth, Math.round(el.clientWidth * zoom));
    ancre.current = { f: (el.scrollLeft + px) / Wc, px };
    setZoom(z);
  }, [zoom]);
  useLayoutEffect(() => {
    const el = vueRef.current;
    if (!el || !ancre.current) return;
    el.scrollLeft = ancre.current.f * W - ancre.current.px;
    ancre.current = null;
    setVue((v) => ({ ...v, gauche: el.scrollLeft }));
  }, [W]);
  const iz = ZOOMS.reduce((best, z, i) => (Math.abs(z - zoom) < Math.abs(ZOOMS[best] - zoom) ? i : best), 0);
  const plus = () => iz < ZOOMS.length - 1 && changerZoom(ZOOMS[iz + 1]);
  const moins = () => iz > 0 && changerZoom(ZOOMS[iz - 1]);

  // Ctrl + molette : zoom sous la souris. Molette seule : defilement normal ;
  // Maj + molette : horizontal (navigateur).
  useEffect(() => {
    const el = vueRef.current;
    if (!el) return undefined;
    const roue = (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const i = e.deltaY < 0 ? Math.min(ZOOMS.length - 1, iz + 1) : Math.max(0, iz - 1);
      if (i !== iz) changerZoom(ZOOMS[i], e.clientX - r.left);
    };
    el.addEventListener('wheel', roue, { passive: false });
    return () => el.removeEventListener('wheel', roue);
  }, [iz, changerZoom]);

  // Glisser a la souris sur le fond pour se deplacer (le doigt defile deja).
  const glisse = useRef(null);
  const surBas = (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || e.target.closest('.frise-carte')) return;
    glisse.current = { x: e.clientX, y: e.clientY, l: vueRef.current.scrollLeft, t: vueRef.current.scrollTop };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const surDeplacer = (e) => {
    const g = glisse.current;
    if (!g) return;
    vueRef.current.scrollLeft = g.l - (e.clientX - g.x);
    vueRef.current.scrollTop = g.t - (e.clientY - g.y);
  };
  const surHaut = () => { glisse.current = null; };

  // Vue d'ensemble : aller a une date
  const allerA = (f) => {
    const el = vueRef.current;
    if (el) el.scrollTo({ left: f * W - el.clientWidth / 2, behavior: 'smooth' });
  };
  const minicarte = useRef(null);
  const surMini = (e) => {
    const r = minicarte.current.getBoundingClientRect();
    allerA(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
  };

  // Ouvre la frise sur le XIXe siecle la premiere fois (la ou sont les tuiles).
  const centre = useRef(false);
  useLayoutEffect(() => {
    const el = vueRef.current;
    if (centre.current || !el || !W || !datees.length) return;
    centre.current = true;
    const tri = datees.map((o) => milieu(o.periode)).sort((a, b) => a - b);
    el.scrollLeft = ech.x(tri[Math.floor(tri.length / 2)]) * W - el.clientWidth / 2;
    setVue((v) => ({ ...v, gauche: el.scrollLeft }));
  }, [W, datees, ech]);

  const fermerApercu = () => { setApercuId(null); setNonce((n) => n + 1); };
  const menuTuile = useMenuTuile({ onMaj: () => setNonce((n) => n + 1), onAgrandir: (o) => setApercuId(o.id), onEtat });
  const { setRetour } = useContext(NavContext);
  useEffect(() => {
    setRetour(apercuId ? () => { fermerApercu(); return true; } : null);
    return () => setRetour(null);
  }, [apercuId]);

  // Densite pour la vue d'ensemble : un trait par tuile datee (corpus filtre).
  const traits = useMemo(() => {
    if (!listeDatees) return '';
    return listeDatees.map((o) => 'M' + (ech.x(milieu(o.periode)) * 1000).toFixed(1) + ' 0v10').join('');
  }, [listeDatees, ech]);

  const sur = survol && survol.periode;
  const AXE = etroit ? 46 : 54;

  return (
    <div className="galerie frise-page" style={{ '--accent': 'var(--laiton)' }}>
      <div className="galerie-tete">
        <span className="galerie-icone"><I.Frise t={22} /></span>
        <div>
          <h2>Frise des dates</h2>
          <div className="soustitre">Chaque tuile à sa date · échelle resserrée sur les époques anciennes</div>
        </div>
        <span className="galerie-compte">{listeDatees ? listeDatees.length : '…'}</span>
      </div>

      <div className="galerie-tri frise-barre">
        <input
          className="biblio-recherche"
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Rechercher : titre, artiste, lieu, tags…"
        />
        <SelecteurTags choisies={cats} onChoisies={setCats} soustractif={soustractif} onSoustractif={setSoustractif} />
        <div className="frise-zoom" role="group" aria-label="Zoom">
          <button className="tri-bouton" onClick={moins} disabled={iz === 0} title="Dézoomer">−</button>
          <span className="frise-zoom-val">×{ZOOMS[iz]}</span>
          <button className="tri-bouton" onClick={plus} disabled={iz === ZOOMS.length - 1} title="Zoomer (Ctrl + molette)">+</button>
        </div>
      </div>

      {/* Vue d'ensemble : epoques a leur largeur, densite, fenetre visible */}
      <div className="frise-mini" ref={minicarte} onClick={surMini} title="Aller à cette époque">
        {ech.epoques.map((e, i) => (
          <div key={i} className={'frise-mini-ep' + (i % 2 ? ' impaire' : '')}
            style={{ left: e.debut * 100 + '%', width: e.part * 100 + '%' }}>
            <span>{nomQuiTient(e, e.part * vue.largeur, 6.2)}</span>
          </div>
        ))}
        <svg className="frise-mini-traits" viewBox="0 0 1000 10" preserveAspectRatio="none" aria-hidden="true">
          <path d={traits} />
        </svg>
        {W > 0 && (
          <div className="frise-mini-fenetre"
            style={{ left: (vue.gauche / W) * 100 + '%', width: Math.min(100, (vue.visible / W) * 100) + '%' }} />
        )}
      </div>

      <div
        className="frise-vue"
        ref={vueRef}
        onScroll={(e) => { const el = e.currentTarget; setVue((v) => (v.gauche === el.scrollLeft ? v : { ...v, gauche: el.scrollLeft })); }}
        onPointerDown={surBas}
        onPointerMove={surDeplacer}
        onPointerUp={surHaut}
        onPointerCancel={surHaut}
      >
        {!corpus ? (
          <div className="chargement">chargement…</div>
        ) : (
          <div className="frise-toile" style={{ width: W, height: AXE + rang.couloirs * (H_CARTE + 6) + 16 }}>
            <div className="frise-axe" style={{ height: AXE }}>
              {ech.epoques.map((e, i) => (
                <div key={i} className={'frise-ep' + (i % 2 ? ' impaire' : '')}
                  style={{ left: e.debut * W, width: e.part * W }}>
                  <span className="frise-ep-nom">{nomQuiTient(e, e.part * W, 8)}</span>
                </div>
              ))}
              {ticks.map((t) => (
                <div key={t.x + ':' + t.annee} className={'frise-tick' + (t.limite ? ' limite' : '')} style={{ left: t.x }}>
                  {t.etiquette && <span>{texteAnnee(t.annee)}</span>}
                </div>
              ))}
              {sur && (
                <div className="frise-axe-periode"
                  style={{ left: ech.x(sur.debut) * W, width: Math.max(3, (ech.x(sur.fin) - ech.x(sur.debut)) * W) }} />
              )}
            </div>
            {/* fonds alternes des epoques, sous les cartes */}
            {ech.epoques.map((e, i) => (
              <div key={'f' + i} className={'frise-bande' + (i % 2 ? ' impaire' : '')}
                style={{ left: e.debut * W, width: e.part * W, top: AXE }} />
            ))}
            {sur && (
              <div className="frise-periode"
                style={{ left: ech.x(sur.debut) * W, width: Math.max(2, (ech.x(sur.fin) - ech.x(sur.debut)) * W), top: AXE }} />
            )}
            {listeDatees.map((o) => {
              const p = rang.places.get(o.id);
              if (!p) return null;
              return (
                <button
                  key={o.id}
                  className={'frise-carte' + (o.periode.estimee ? ' estimee' : '') + (survol && survol.id === o.id ? ' survol' : '')}
                  style={{ left: p.gauche, top: AXE + 8 + p.couloir * (H_CARTE + 6), width: C }}
                  onClick={() => setApercuId(o.id)}
                  onContextMenu={(e) => { e.preventDefault(); menuTuile.surMenu(e, o); }}
                  onPointerEnter={() => setSurvol(o)}
                  onPointerLeave={() => setSurvol((s) => (s && s.id === o.id ? null : s))}
                  onFocus={() => setSurvol(o)}
                  title={(o.titre || '—') + (o.artiste ? ' — ' + o.artiste : '') + ' · ' + o.date}
                >
                  {o.image
                    ? <img src={o.vignette || o.image} alt="" loading="lazy" draggable="false" style={{ height: C }} />
                    : <span className="frise-carte-vide" style={{ height: C }}>{(o.titre || '?').slice(0, 1)}</span>}
                  <span className="frise-carte-date">{o.date}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="frise-pied">
        {survol ? (
          <span><b>{survol.titre || '—'}</b>{survol.artiste ? ' — ' + survol.artiste : ''} · {survol.date}</span>
        ) : (
          <span>
            {SUR_MOBILE ? 'Glisser pour parcourir, toucher une tuile pour l’agrandir.' : 'Glisser ou Maj + molette pour parcourir, Ctrl + molette pour zoomer.'}
            {' '}Bordure pointillée : date estimée.
          </span>
        )}
        {sansDate > 0 && <span className="frise-sans-date">{sansDate} tuile{sansDate > 1 ? 's' : ''} sans date lisible</span>}
      </div>

      {menuTuile.rendu}
      {apercuId && <RecouvrementApercu id={apercuId} onFermer={fermerApercu} onEtat={onEtat} />}
    </div>
  );
}
