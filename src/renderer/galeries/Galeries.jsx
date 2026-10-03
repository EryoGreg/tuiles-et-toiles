// Decoupe d'App.jsx (etape 1 de Bristol) : code inchange, voir scripts/decouper-app.js.
import { useEffect, useState, useRef, useMemo, useContext } from 'react';
import * as I from '../icones.jsx';
import { GrilleContext, NavContext, usePref, useSession } from '../commun/base.jsx';
import { CarteTuile, RecouvrementApercu, useMenuTuile } from '../tuile/Cartes.jsx';

/* ------------------------------------------- barre de filtres commune */

export const TRI_LABEL = { ajout: 'Ordre d’ajout', numero: 'Numéro', date: 'Date d’ajout' };

export const parNumero = (a, b) => String(a.ref).localeCompare(String(b.ref), undefined, { numeric: true });

// Trie une liste de tuiles.
//   'ajout'  (galeries) : la liste arrive deja triee par date du tag, cote base
//   'numero' : #002… puis L1, M1…
//   'date'   (Bibliotheque) : date d'ajout de la tuile ; les oeuvres du pack
//            (sans date) passent avant tout ajout, dans l'ordre des numeros
export function trier(tuiles, tri, sens) {
  const t = tuiles.slice();
  if (tri === 'numero') t.sort(parNumero);
  if (tri === 'date') {
    t.sort((a, b) => {
      const da = a.ajouteLe || '', db = b.ajouteLe || '';
      return da < db ? -1 : da > db ? 1 : parNumero(a, b);
    });
  }
  if (sens === 'desc') t.reverse();
  return t;
}

// Selecteur de tags (Bibliotheque) : a droite du champ de recherche. Un
// bouton ouvre un panneau de chips ; le +/− choisit additif (au moins un tag)
// ou soustractif (tous les tags). L'etat vit chez le parent.
export function SelecteurTags({ choisies, onChoisies, soustractif, onSoustractif }) {
  const [ouvert, setOuvert] = useState(false);
  const [cats, setCats] = useState(null);
  const [q, setQ] = useState('');
  const enveloppe = useRef(null);

  useEffect(() => { if (ouvert && !cats) window.api.jeu.categories().then(setCats); }, [ouvert, cats]);
  useEffect(() => {
    if (!ouvert) return undefined;
    const dehors = (e) => { if (enveloppe.current && !enveloppe.current.contains(e.target)) setOuvert(false); };
    const echap = (e) => { if (e.key === 'Escape') setOuvert(false); };
    document.addEventListener('mousedown', dehors);
    window.addEventListener('keydown', echap);
    return () => { document.removeEventListener('mousedown', dehors); window.removeEventListener('keydown', echap); };
  }, [ouvert]);

  const filtrees = useMemo(() => {
    if (!cats) return [];
    const n = q.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    return n ? cats.filter((c) => c.valeur.includes(n) || c.label.toLowerCase().includes(n)) : cats;
  }, [cats, q]);

  const basculer = (v) => onChoisies(
    choisies.includes(v) ? choisies.filter((x) => x !== v) : [...choisies, v]
  );

  return (
    <div className="sel-tags" ref={enveloppe}>
      <button
        className={'tri-bouton' + (choisies.length ? ' actif' : '')}
        onClick={() => setOuvert((o) => !o)}
        title="Filtrer par tags"
      >
        <I.Etiquette t={14} /> Tags{choisies.length ? ' · ' + choisies.length : ''}
      </button>
      <button
        className={'np-combi sel-tags-combi ' + (soustractif ? 'soustr' : 'addit')}
        onClick={() => onSoustractif(!soustractif)}
        title={soustractif
          ? 'Soustractif : les tuiles portant TOUS les tags choisis. Cliquer pour repasser en additif.'
          : 'Additif : les tuiles portant AU MOINS UN tag choisi. Cliquer pour passer en soustractif.'}
      >
        <span className="np-combi-signe">{soustractif ? '−' : '+'}</span>
      </button>

      {ouvert && (
        <div className="sel-tags-pop">
          <div className="sel-tags-haut">
            <input
              className="biblio-recherche"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filtrer les tags…"
              autoFocus
            />
            {choisies.length > 0 && (
              <button className="tri-bouton" onClick={() => onChoisies([])}>Tout retirer</button>
            )}
          </div>
          {!cats ? (
            <div className="chargement">chargement…</div>
          ) : filtrees.length === 0 ? (
            <div className="galerie-vide">Aucun tag.</div>
          ) : (
            <div className="sel-tags-liste">
              {filtrees.map((c) => (
                <button
                  key={c.valeur}
                  className={'np-chip' + (choisies.includes(c.valeur) ? ' actif' : '')}
                  onClick={() => basculer(c.valeur)}
                >
                  {c.label} <span className="np-chip-n">{c.n}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Bascule de tri (un seul bouton), sens (fleche verticale haut/bas) et champ
// de recherche permissif — identiques sur Bibliotheque, Livre, Étoile, À
// revoir. `triModes` : ['ajout','numero'] pour les galeries de tag,
// ['numero'] seul pour la Bibliotheque (pas de date d'ajout). `tags`
// (optionnel) : { choisies, onChoisies, soustractif, onSoustractif } ->
// affiche le selecteur de tags a droite de la recherche (Bibliotheque).
export function BarreFiltres({ triModes, tri, onTri, sens, onSens, q, onQ, tags, avecNote }) {
  const multi = triModes.length > 1;
  const { colonnes, cycler } = useContext(GrilleContext);
  return (
    <div className="galerie-tri">
      <button
        className="tri-bouton"
        onClick={multi ? () => onTri(triModes[(triModes.indexOf(tri) + 1) % triModes.length]) : undefined}
        style={multi ? undefined : { cursor: 'default' }}
        title={multi ? 'Basculer le tri' : undefined}
      >
        {multi && <I.Echange t={14} />}
        {TRI_LABEL[tri]}
      </button>
      <button
        className="tri-bouton tri-sens"
        onClick={() => onSens(sens === 'asc' ? 'desc' : 'asc')}
        title={sens === 'asc' ? 'Ordre croissant — cliquer pour inverser' : 'Ordre décroissant — cliquer pour inverser'}
      >
        <I.FlecheVert t={16} bas={sens === 'desc'} />
      </button>
      <button
        className="tri-bouton tri-cols"
        onClick={cycler}
        title="Nombre de tuiles par ligne"
      >
        <I.Grille t={14} /> {colonnes}/ligne
      </button>
      <input
        className="biblio-recherche"
        type="text"
        value={q}
        onChange={(e) => onQ(e.target.value)}
        placeholder={'Rechercher : titre, artiste, lieu, description, tags, numéro' + (avecNote ? ', mes notes…' : '…')}
      />
      {tags && <SelecteurTags {...tags} />}
      {avecNote && (
        <button className={'tri-bouton' + (avecNote.actif ? ' actif' : '')} onClick={avecNote.basculer}
          title="Seulement les tuiles qui ont une note personnelle">
          <I.Note t={14} /> Avec note
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------- galeries (tags) */

// Un seul gabarit pour Livre / Étoile / À revoir : seuls le tag interroge et
// la couleur d'accent changent d'une page a l'autre.
export function Galerie({ nom, tag, couleur, Icone, description, onEtat }) {
  const [brut, setBrut] = useState(null);
  const [tri, setTri] = usePref('galerie:' + tag + ':tri', 'ajout');
  const [sens, setSens] = usePref('galerie:' + tag + ':sens', 'asc');
  const [q, setQ] = useSession('galerie:' + tag + ':recherche', '');
  const [apercuId, setApercuId] = useState(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => { setBrut(null); }, [tag]);
  useEffect(() => {
    let vivant = true;
    const h = setTimeout(async () => {
      const r = await window.api.oeuvres.parTag(tag, q.trim() || undefined);
      if (vivant) setBrut(r);
    }, 120);
    return () => { vivant = false; clearTimeout(h); };
  }, [tag, q, nonce]);

  const retirer = async (id) => {
    await window.api.tags.basculer(id, tag);
    setNonce((n) => n + 1);
    if (onEtat) onEtat();
  };
  const fermerApercu = () => { setApercuId(null); setNonce((n) => n + 1); };
  const menuTuile = useMenuTuile({ onMaj: () => setNonce((n) => n + 1), onAgrandir: (o) => setApercuId(o.id), onEtat });

  // souris4 : refermer l'aperçu avant de quitter la page.
  const { setRetour } = useContext(NavContext);
  useEffect(() => {
    setRetour(apercuId ? () => { fermerApercu(); return true; } : null);
    return () => setRetour(null);
  }, [apercuId]);

  const ordonnees = useMemo(() => (brut ? trier(brut, tri, sens) : null), [brut, tri, sens]);
  const filtre = q.trim().length > 0;

  return (
    <div className="galerie" style={{ '--accent': couleur }}>
      <div className="galerie-tete">
        <span className="galerie-icone"><Icone t={22} /></span>
        <div>
          <h2>{nom}</h2>
          <div className="soustitre">{description}</div>
        </div>
        <span className="galerie-compte">{brut ? brut.length : '…'}</span>
      </div>

      <BarreFiltres
        triModes={['ajout', 'numero']}
        tri={tri} onTri={setTri}
        sens={sens} onSens={setSens}
        q={q} onQ={setQ}
      />

      {!ordonnees ? (
        <div className="chargement">chargement…</div>
      ) : ordonnees.length === 0 ? (
        <div className="galerie-vide">
          {filtre ? 'Aucun résultat.' : `Aucune tuile marquée ${nom.toLowerCase()} pour l'instant.`}
        </div>
      ) : (
        <div className="galerie-grille">
          {ordonnees.map((o) => (
            <CarteTuile
              key={o.id}
              o={o}
              onOuvrir={() => setApercuId(o.id)}
              onRetirer={() => retirer(o.id)}
              nomRetirer={'Retirer de ' + nom}
              onMenu={menuTuile.surMenu}
            />
          ))}
        </div>
      )}
      {menuTuile.rendu}

      {apercuId && (
        <RecouvrementApercu id={apercuId} onFermer={fermerApercu} onEtat={onEtat} />
      )}
    </div>
  );
}

export function PageLivre({ onEtat }) {
  return <Galerie nom="Livre" tag="livre" couleur="var(--livre)" Icone={I.Livre}
    description="Tuiles à approfondir" onEtat={onEtat} />;
}

export function PageEtoile({ onEtat }) {
  return <Galerie nom="Étoile" tag="etoile" couleur="var(--etoile)" Icone={I.Etoile}
    description="Tuiles favorites" onEtat={onEtat} />;
}

export function PageRevoir({ onEtat }) {
  return <Galerie nom="À revoir" tag="bad_smiley" couleur="var(--revoir)" Icone={I.Revoir}
    description="Ratées la dernière fois" onEtat={onEtat} />;
}

/* ----------------------------------------------------------- bibliotheque */

// Toutes les tuiles du corpus. Le filtre passe par la recherche permissive
// de la base (accents / casse / ponctuation ignores des deux cotes, chaque
// mot devant apparaitre quelque part hors image). Clic = agrandir, avec le
// rail de marquage comme partout.
export function PageBibliotheque({ onEtat, onChoisirTuile }) {
  const [q, setQ] = useSession('bibliotheque:recherche', '');
  const [tri, setTri] = usePref('bibliotheque:tri', 'date');
  const [sens, setSens] = usePref('bibliotheque:sens', 'asc');
  const [catsFiltre, setCatsFiltre] = usePref('bibliotheque:categories', []);       // tags selectionnes
  const [soustractif, setSoustractif] = usePref('bibliotheque:soustractif', false);
  const [avecNote, setAvecNote] = useSession('bibliotheque:avecNote', false);   // Mes notes
  const [resultats, setResultats] = useState(null);
  const [total, setTotal] = useState(null);
  const [apercuId, setApercuId] = useState(null);
  const [nonce, setNonce] = useState(0);
  const choix = !!onChoisirTuile;

  useEffect(() => {
    let vivant = true;
    const t = setTimeout(async () => {
      const criteres = {};
      if (q.trim()) criteres.texte = q;
      if (catsFiltre.length) { criteres.categories = catsFiltre; criteres.soustractif = soustractif; }
      if (avecNote) criteres.avecNote = true;
      const actif = Object.keys(criteres).length > 0;
      const r = await window.api.oeuvres.toutes(actif ? criteres : undefined);
      if (!vivant) return;
      setResultats(r);
      if (!actif) setTotal(r.length);
    }, 120);
    return () => { vivant = false; clearTimeout(t); };
  }, [q, catsFiltre, soustractif, nonce, avecNote]);

  const fermerApercu = () => { setApercuId(null); setNonce((n) => n + 1); };
  // Mode choix (liste d'Edition) : pas d'apercu, toucher = modifier.
  const menuTuile = useMenuTuile({ onMaj: () => setNonce((n) => n + 1), onAgrandir: choix ? null : (o) => setApercuId(o.id), onEtat });

  // souris4 : refermer l'aperçu d'abord (sauf en mode choix, géré par PageEdition).
  const { setRetour } = useContext(NavContext);
  useEffect(() => {
    if (choix) return undefined;
    setRetour(apercuId ? () => { fermerApercu(); return true; } : null);
    return () => setRetour(null);
  }, [apercuId, choix]);

  const filtre = q.trim().length > 0 || catsFiltre.length > 0 || avecNote;
  const affichees = useMemo(
    () => (resultats ? trier(resultats, tri, sens) : null),
    [resultats, tri, sens]
  );

  return (
    <div className="galerie" style={{ '--accent': 'var(--laiton)' }}>
      <div className="galerie-tete">
        <span className="galerie-icone"><I.Bibliotheque t={22} /></span>
        <div>
          <h2>{choix ? 'Choisir une tuile' : 'Bibliothèque'}</h2>
          <div className="soustitre">{choix ? 'Clic pour la modifier ou la supprimer' : 'Toutes les tuiles'}</div>
        </div>
        <span className="galerie-compte">
          {affichees ? affichees.length : '…'}
          {filtre && total != null ? ' / ' + total : ''}
        </span>
      </div>

      <BarreFiltres
        triModes={['date', 'numero']}
        tri={tri} onTri={setTri}
        sens={sens} onSens={setSens}
        q={q} onQ={setQ}
        tags={{
          choisies: catsFiltre, onChoisies: setCatsFiltre,
          soustractif, onSoustractif: setSoustractif
        }}
        avecNote={{ actif: avecNote, basculer: () => setAvecNote((x) => !x) }}
      />

      {!affichees ? (
        <div className="chargement">chargement…</div>
      ) : affichees.length === 0 ? (
        <div className="galerie-vide">Aucune tuile ne correspond.</div>
      ) : (
        <div className="galerie-grille">
          {affichees.map((o) => (
            <CarteTuile key={o.id} o={o}
              onOuvrir={choix ? () => onChoisirTuile(o) : () => setApercuId(o.id)}
              onMenu={menuTuile.surMenu} />
          ))}
        </div>
      )}
      {menuTuile.rendu}

      {!choix && apercuId && (
        <RecouvrementApercu id={apercuId} onFermer={fermerApercu} onEtat={onEtat} />
      )}
    </div>
  );
}
