import { useEffect, useState, useCallback, useRef, useMemo, createContext, useContext, Fragment } from 'react';
import * as I from './icones.jsx';

// Densite de la grille des galeries (tuiles visibles par ligne). Reglage
// global, cycle 5 -> 7 -> 9 -> 5, pilote par le bouton de BarreFiltres.
const GrilleContext = createContext({ colonnes: 5, cycler: () => {} });
const DENSITES = [5, 7, 9];

// Retour « intra-page » : une page ayant un état interne (aperçu ouvert,
// éditeur, partie en cours) enregistre ici un gestionnaire. souris4 le
// consulte AVANT de reculer dans l'historique des pages — sinon un aperçu
// ouvert dans Livre renverrait direct à la page précédente au lieu de se
// refermer. Le gestionnaire renvoie true s'il a absorbé le retour.
const NavContext = createContext({ setRetour: () => {} });

/* ---------------------------------------------------- preferences d'affichage */

// Tri, sens et filtres de chaque page : gardes d'un onglet a l'autre ET d'un
// lancement a l'autre (reglage « prefs_affichage » de cet appareil, non
// synchronise). Charges une fois avant le premier affichage des pages (App),
// donc lus de facon synchrone : pas de clignotement a l'ouverture.
const PREFS = { valeurs: {}, charge: false, minuteur: null };
function chargerPrefs(v) {
  if (PREFS.charge) return;   // ensuite, la memoire fait foi (ecriture differee)
  PREFS.valeurs = v && typeof v === 'object' ? v : {};
  PREFS.charge = true;
}
function enregistrerPrefs() {
  clearTimeout(PREFS.minuteur);
  PREFS.minuteur = setTimeout(() => {
    window.api.reglages.definir('prefs_affichage', JSON.stringify(PREFS.valeurs));
  }, 300);
}

/** Comme useState, mais la valeur survit au changement d'onglet et au redemarrage. */
function usePref(cle, defaut) {
  const [v, setV] = useState(() => (cle in PREFS.valeurs ? PREFS.valeurs[cle] : defaut));
  const courant = useRef(v);
  const poser = useCallback((x) => {
    const n = typeof x === 'function' ? x(courant.current) : x;
    courant.current = n;
    PREFS.valeurs = { ...PREFS.valeurs, [cle]: n };
    enregistrerPrefs();
    setV(n);
  }, [cle]);
  return [v, poser];
}

// Texte de recherche : garde en changeant d'onglet, oublie au redemarrage
// (une vieille recherche oubliee ferait croire a une page vide).
const MEMOIRE_SESSION = new Map();
function useSession(cle, defaut) {
  const [v, setV] = useState(() => (MEMOIRE_SESSION.has(cle) ? MEMOIRE_SESSION.get(cle) : defaut));
  const poser = useCallback((x) => {
    setV((ancien) => {
      const n = typeof x === 'function' ? x(ancien) : x;
      MEMOIRE_SESSION.set(cle, n);
      return n;
    });
  }, [cle]);
  return [v, poser];
}

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

/* ------------------------------------------------------------------- jeu */

const MARQUES = [
  ['livre', I.Livre, 'livre'],
  ['etoile', I.Etoile, 'etoile'],
  ['bad_smiley', I.Revoir, 'revoir']
];

function Tuile({
  tuile, revele, sur, onReveler,
  onSuivante, onPrecedente, onMarquer, peutRevenir,
  apercu = false, onFermer, onChanger
}) {
  // Vue plein cadre de l'image (85% de la fenetre) : locale, pas dans
  // l'historique de Jeu — changer de tuile referme toujours la vue.
  const [agrandie, setAgrandie] = useState(false);
  useEffect(() => { setAgrandie(false); }, [tuile && tuile.id]);
  useEffect(() => {
    if (!agrandie) return undefined;
    const clavier = (e) => { if (e.key === 'Escape') setAgrandie(false); };
    window.addEventListener('keydown', clavier);
    return () => window.removeEventListener('keydown', clavier);
  }, [agrandie]);

  if (!tuile) return <div className="chargement">{apercu ? 'ouverture…' : 'tirage…'}</div>;
  const d = revele || tuile.champs;
  // En apercu tout est visible d'office. Sinon : un champ revele mais vide
  // (25 oeuvres sans artiste, 81 sans lieu) reste revele — on suit l'etat,
  // pas la verite de la valeur.
  const voit = (c) => apercu || !!revele || sur.has(c) || tuile.champs[c] != null;
  const ou = (v) => (v == null || String(v).trim() === '' ? '—' : v);

  const Cache = ({ champ, label }) => (
    <button className="masque" onClick={() => onReveler(champ)}>
      <I.OeilBarre /> {label || 'masqué'}
    </button>
  );

  return (
    <>
      {/* Tuile centrale + tuile suivante, meme rangee : meme taille, meme
          alignement haut/bas, un seul et meme intervalle entre elles. Le
          rail des marques est cale en haut a gauche de la tuile centrale. */}
      <div className="rangee-tuiles">
        <div className="rail">
          {MARQUES.map(([tag, Icone, classe]) => (
            <button
              key={tag}
              className={'marque ' + classe + (tuile.tagsUtilisateur.includes(tag) ? ' on' : '')}
              onClick={() => onMarquer(tag)}
              title={tag}
            >
              <Icone t={32} />
            </button>
          ))}
        </div>

        <div className="tuile">
          <div className="tete">
            <span className="numero">#{tuile.ref}</span>
            <span style={{ fontSize: 11.5, color: 'var(--discret)' }}>
              {apercu
                ? 'Tuile complète — rien n’est masqué'
                : 'Clic sur une zone masquée pour la révéler'}
            </span>
          </div>

          {/* Image a hauteur fluide (clamp) ; chaque champ garde une hauteur
              fixe (.valeur) donc reveler un champ ne deplace jamais les
              autres. Sur une fenetre courte, .corps defile plutot que de
              rogner les tags. */}
          <div className="corps">
            {voit('image') && d.image
              // <img> est un element remplace : un flex-basis dessus n'est pas
              // fiable (retombe sur sa taille naturelle, 1400px). Un cadre en
              // div porte la hauteur ; l'image se contente de le remplir.
              ? <div className="cadre-image">
                  <img className="visuel" src={d.image} alt="" onClick={() => setAgrandie(true)} />
                </div>
              : <button className="masque image" onClick={() => onReveler('image')}>
                  <I.OeilBarre t={26} /> image masquée
                </button>}

            <div className="corps-reste">
              <div className="grille2">
                <div className="champ">
                  <div className="etiquette">Titre</div>
                  <div className="valeur valeur-titre">
                    {voit('titre')
                      ? <div style={{ fontFamily: 'var(--serif)', fontSize: 22, lineHeight: 1.2 }}>{ou(d.titre)}</div>
                      : <Cache champ="titre" />}
                  </div>
                </div>

                <div className="champ">
                  <div className="etiquette">Artiste</div>
                  <div className="valeur">
                    {voit('artiste')
                      ? <div style={{ fontSize: 14.5, color: 'var(--tuile-ink)' }}>{ou(d.artiste)}</div>
                      : <Cache champ="artiste" />}
                  </div>
                </div>

                <div className="champ">
                  <div className="etiquette">Année / période</div>
                  {/* Jamais visible au tirage, mais revelable au clic comme
                      n'importe quel autre champ. Deja a hauteur fixe
                      (.annee), partagee entre masque et revele. */}
                  {voit('date')
                    ? <div className="annee">
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 14 }}>{ou(d.date)}</span>
                      </div>
                    : <button className="annee cachee" onClick={() => onReveler('date')}>
                        <span className="points">? ? ? ?</span>
                        <span className="note">cliquer pour révéler</span>
                      </button>}
                </div>

                <div className="champ">
                  <div className="etiquette">Conservation</div>
                  <div className="valeur">
                    {voit('lieu')
                      ? <div style={{ fontSize: 14.5, color: 'var(--tuile-ink)' }}>{ou(d.lieu)}</div>
                      : <Cache champ="lieu" />}
                  </div>
                </div>
              </div>

              {/* Seul champ de longueur vraiment variable : sa case a une
                  hauteur bornee (clamp) ; le texte defile a l'interieur si
                  besoin, scrollbar masquee. */}
              <div className="champ champ-description">
                <div className="etiquette">Description</div>
                <div className="valeur-description">
                  {voit('description')
                    ? <div className="texte-description">{ou(d.description)}</div>
                    : <Cache champ="description" />}
                </div>
              </div>

              <div className="champ">
                <div className="etiquette">Tags</div>
                <div className="valeur">
                  {voit('tags')
                    ? <div style={{ fontSize: 13, color: 'var(--attenue)' }}>{ou(d.tags)}</div>
                    : <Cache champ="tags" label={(tuile.tagVisible ? tuile.tagVisible + ' · ' : '') + 'tags masqués'} />}
                </div>
              </div>
            </div>
          </div>
        </div>

        {!apercu && <div className="suivante" onClick={onSuivante} />}
      </div>

      {/* Sous la tuile, alignee sur elle (pas sur le rail) : actions. En
          apercu (tuile agrandie depuis une galerie) tout est deja visible :
          seul « Fermer ». */}
      <div className="ligne-actions">
        {apercu ? (
          <>
            <span className="compteur-sac">Aperçu — aucune donnée masquée</span>
            <div className="actions-droite">
              <button className="bouton-neutre" onClick={onFermer}>
                <I.Croix t={14} /> Fermer
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="actions-gauche">
              {onChanger && (
                <button className="bouton-neutre" onClick={onChanger} title="Choisir un autre mode de tirage">
                  <I.Fleche t={16} retour /> Mode
                </button>
              )}
              <span className="compteur-sac">{tuile.restant} tuiles restantes dans le sac</span>
            </div>
            <div className="actions-droite">
              <button
                className="bouton-neutre"
                onClick={onPrecedente}
                disabled={!peutRevenir}
                style={peutRevenir ? undefined : { opacity: 0.35, cursor: 'default' }}
                title="Tuile précédente (flèche gauche)"
              >
                <I.Fleche t={18} retour /> Précédente
              </button>
              <button className="bouton-valide" onClick={() => onReveler(null)}>
                <I.Coche /> Tout révéler
              </button>
              <button className="bouton-neutre" onClick={onSuivante}>
                Suivante <I.Fleche />
              </button>
            </div>
          </>
        )}
      </div>

      {/* Reclic sur l'image (ou n'importe ou autour) pour refermer. */}
      {agrandie && d.image && (
        <div className="recouvrement-image" onClick={() => setAgrandie(false)}>
          <div className="cadre-image-agrandie">
            <img className="image-agrandie" src={d.image} alt="" />
          </div>
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------ nouvelle partie */

// Ecran de choix du mode, avant le premier tirage. Aleatoire : toutes les
// oeuvres, tag de jeu toujours censure. Categorie : une ou plusieurs familles
// de tags (choix multiple), tag de jeu visible s'il est seul sur la tuile.
function NouvellePartie({ onLancer }) {
  const [mode, setMode] = usePref('partie:mode', 'aleatoire');
  const [cats, setCats] = useState(null);
  const [choisies, setChoisies] = usePref('partie:categories', []);   // valeurs de categorie
  const [q, setQ] = useSession('partie:recherche', '');
  // Combinaison des catégories choisies :
  //   additif (défaut) : l'œuvre porte AU MOINS UNE des catégories
  //   soustractif      : l'œuvre porte TOUTES les catégories
  const [soustractif, setSoustractif] = usePref('partie:soustractif', false);
  const [apercu, setApercu] = useState(null);     // { total, possibles }

  useEffect(() => {
    window.api.jeu.categories().then((l) => {
      setCats(l);
      // Categories memorisees disparues depuis (pack mis a jour, tuile supprimee) : retirees.
      const connues = new Set(l.map((c) => c.valeur));
      setChoisies((s) => (s.every((v) => connues.has(v)) ? s : s.filter((v) => connues.has(v))));
    });
  }, []);

  // Aperçu du résultat (nb de tuiles, catégories encore ajoutables en
  // soustractif). Tout en mémoire côté main sur ~431 lignes → instantané.
  useEffect(() => {
    if (mode !== 'categorie') { setApercu(null); return undefined; }
    let vivant = true;
    const h = setTimeout(async () => {
      const r = await window.api.jeu.apercuCategories({ cats: choisies, soustractif });
      if (vivant) setApercu(r);
    }, 70);
    return () => { vivant = false; clearTimeout(h); };
  }, [mode, choisies, soustractif]);

  const filtrees = useMemo(() => {
    if (!cats) return [];
    const n = q.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (!n) return cats;
    return cats.filter((c) => c.valeur.includes(n) || c.label.toLowerCase().includes(n));
  }, [cats, q]);

  const basculerCat = (v) => setChoisies((s) =>
    s.includes(v) ? s.filter((x) => x !== v) : [...s, v]);

  // En soustractif, une catégorie qui ferait tomber le résultat à 0 est
  // désactivée (sauf si déjà choisie — on peut toujours la retirer).
  const possibles = apercu && apercu.possibles ? new Set(apercu.possibles) : null;
  const bloquee = (v) => !!possibles && !choisies.includes(v) && !possibles.has(v);

  const total = apercu ? apercu.total : null;
  const peutLancer = mode === 'aleatoire'
    || (choisies.length > 0 && (total == null || total > 0));
  const lancer = () => {
    if (peutLancer) onLancer(mode === 'categorie' ? { cats: choisies, soustractif } : null);
  };

  return (
    <div className="nouvelle-partie">
      <div className="np-tete">
        <h2>Nouvelle partie</h2>
        <div className="soustitre">Choisir un mode de tirage, puis lancer.</div>
      </div>

      <div className="np-modes">
        <button
          className={'np-mode' + (mode === 'aleatoire' ? ' actif' : '')}
          onClick={() => setMode('aleatoire')}
        >
          <span className="np-radio" />
          <span>
            <div className="np-mode-nom">Aléatoire</div>
            <div className="np-mode-desc">
              Tirage dans toutes les œuvres, sac sans remise. Le tag de jeu est toujours censuré.
            </div>
          </span>
        </button>

        <button
          className={'np-mode' + (mode === 'categorie' ? ' actif' : '')}
          onClick={() => setMode('categorie')}
        >
          <span className="np-radio" />
          <span>
            <div className="np-mode-nom">Par catégorie</div>
            <div className="np-mode-desc">
              Tirage dans une ou plusieurs catégories. Le tag de jeu reste visible s’il est seul
              sur la tuile, censuré s’il en accompagne d’autres.
            </div>
          </span>
        </button>

        <button
          className={'np-lancer' + (peutLancer ? '' : ' off')}
          disabled={!peutLancer}
          onClick={lancer}
        >
          <span>Lancer <I.Fleche /></span>
          {mode === 'categorie' && (
            <span className="np-lancer-sub">
              {choisies.length === 0
                ? 'choisir au moins une catégorie'
                : total == null ? '…'
                : total === 0 ? 'aucune tuile — combinaison impossible'
                : total + (total > 1 ? ' tuiles' : ' tuile')}
            </span>
          )}
        </button>
      </div>

      {mode === 'categorie' && (
        <div className="np-cats">
          <div className="np-cats-barre">
            <input
              className="biblio-recherche"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filtrer les catégories…"
            />
            <button
              className={'np-combi ' + (soustractif ? 'soustr' : 'addit')}
              onClick={() => setSoustractif((s) => !s)}
              title={soustractif
                ? 'Soustractif : les tuiles portant TOUTES les catégories choisies. Cliquer pour repasser en additif.'
                : 'Additif : les tuiles portant AU MOINS UNE catégorie choisie. Cliquer pour passer en soustractif.'}
            >
              <span className="np-combi-signe">{soustractif ? '−' : '+'}</span>
              <span className="np-combi-mot">{soustractif ? 'toutes' : 'au moins une'}</span>
            </button>
          </div>
          {!cats ? (
            <div className="chargement">chargement…</div>
          ) : filtrees.length === 0 ? (
            <div className="galerie-vide">Aucune catégorie.</div>
          ) : (
            <div className="np-chips">
              {filtrees.map((c) => (
                <button
                  key={c.valeur}
                  className={'np-chip' + (choisies.includes(c.valeur) ? ' actif' : '')
                    + (bloquee(c.valeur) ? ' bloquee' : '')}
                  disabled={bloquee(c.valeur)}
                  onClick={() => basculerCat(c.valeur)}
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

// Choix du mode, puis la partie. La cle sur <Partie> force un etat neuf
// (sac, historique) a chaque changement de mode.
function Jeu({ onEtat }) {
  const [filtre, setFiltre] = useState(undefined);   // undefined = pas encore choisi

  // souris4 : revenir au choix du mode avant de quitter la page Jouer.
  const { setRetour } = useContext(NavContext);
  useEffect(() => {
    setRetour(filtre !== undefined ? () => { setFiltre(undefined); return true; } : null);
    return () => setRetour(null);
  }, [filtre]);

  if (filtre === undefined) return <NouvellePartie onLancer={setFiltre} />;
  return (
    <Partie
      key={JSON.stringify(filtre)}
      filtre={filtre}
      onChanger={() => setFiltre(undefined)}
      onEtat={onEtat}
    />
  );
}

function Partie({ filtre, onChanger, onEtat }) {
  const [tuile, setTuile] = useState(null);
  const [revele, setRevele] = useState(null);
  const [sur, setSur] = useState(new Set());
  // Pile des tuiles deja vues : revenir en arriere ne repioche pas dans le
  // sac, on restitue la tuile telle qu'elle etait, revelations comprises.
  const [historique, setHistorique] = useState([]);
  // Pile inverse : la ou "Precedente" depose la tuile quittee, pour que
  // "Suivante" la retrouve au lieu de retirer une tuile neuve du sac. Un
  // vrai nouveau tirage (pile vide) la laisse intacte a vide.
  const futurRef = useRef([]);

  const tirer = useCallback(async () => {
    setTuile((precedente) => {
      if (precedente) {
        setHistorique((h) => [...h, { tuile: precedente, revele, sur }].slice(-50));
      }
      return precedente;
    });

    if (futurRef.current.length) {
      const suivante = futurRef.current.pop();
      setRevele(suivante.revele);
      setSur(suivante.sur);
      setTuile(suivante.tuile);
    } else {
      const suivante = await window.api.jeu.tirer(filtre);
      setRevele(null);
      setSur(new Set());
      setTuile(suivante);
    }
  }, [revele, sur, filtre]);

  const precedente = useCallback(() => {
    setHistorique((h) => {
      if (!h.length) return h;
      const derniere = h[h.length - 1];
      setTuile((actuelle) => {
        futurRef.current.push({ tuile: actuelle, revele, sur });
        if (futurRef.current.length > 50) futurRef.current.shift();
        return derniere.tuile;
      });
      setRevele(derniere.revele);
      setSur(derniere.sur);
      return h.slice(0, -1);
    });
  }, [revele, sur]);

  useEffect(() => { window.api.jeu.tirer(filtre).then(setTuile); }, [filtre]);

  const reveler = async (champ) => {
    if (champ === null) {
      setRevele(await window.api.jeu.reveler(tuile.id));
    } else {
      setSur((s) => new Set(s).add(champ));
      const complet = await window.api.jeu.reveler(tuile.id);
      setTuile((t) => ({ ...t, champs: { ...t.champs, [champ]: complet[champ] } }));
    }
  };

  const marquer = async (tag) => {
    const r = await window.api.tags.basculer(tuile.id, tag);
    setTuile((t) => ({
      ...t,
      tagsUtilisateur: r.actif
        ? [...t.tagsUtilisateur, tag]
        : t.tagsUtilisateur.filter((x) => x !== tag)
    }));
    onEtat();
  };

  useEffect(() => {
    const clavier = (e) => {
      if (e.code === 'Space') { e.preventDefault(); reveler(null); }
      if (e.code === 'ArrowRight') tirer();
      if (e.code === 'ArrowLeft') precedente();
      if (e.key.toLowerCase() === 'l') marquer('livre');
      if (e.key.toLowerCase() === 'e') marquer('etoile');
      if (e.key.toLowerCase() === 's') marquer('bad_smiley');
    };
    window.addEventListener('keydown', clavier);
    return () => window.removeEventListener('keydown', clavier);
  });

  return (
    <div className="jeu">
      <Tuile
        tuile={tuile} revele={revele} sur={sur}
        onReveler={reveler} onSuivante={tirer} onPrecedente={precedente}
        onMarquer={marquer} peutRevenir={historique.length > 0}
        onChanger={onChanger}
      />
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

function EnChantier({ nom }) {
  return <div className="chargement">{nom} — à construire</div>;
}

/* ----------------------------------------------- apercu (tuile agrandie) */

// Ordre d'affichage des pastilles de tag sur une carte : livre, etoile,
// a-revoir — le meme que le rail du jeu.
const PIPS = [
  ['livre', 'var(--livre)'],
  ['etoile', 'var(--etoile)'],
  ['bad_smiley', 'var(--revoir)']
];

// Carte commune a la Bibliotheque et aux galeries. Clic n'importe ou =
// agrandir ; la croix (galeries seulement) retire le tag sans agrandir.
function CarteTuile({ o, onOuvrir, onRetirer, nomRetirer }) {
  return (
    <div className="carte-galerie" onClick={onOuvrir}>
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
        ? <img className="carte-galerie-image" src={o.image} alt="" loading="lazy" />
        : <div className="carte-galerie-image carte-galerie-image-vide" />}
      <div className="carte-galerie-corps">
        <span className="numero">#{o.ref}</span>
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

// Recouvrement plein ecran : la tuile agrandie a la taille exacte du jeu,
// mais TOUT visible (rien de masque). Les sections qu'un tirage cacherait
// sont soulignees en pointilles dore. Marquer y fonctionne partout —
// Bibliotheque, Livre, Étoile, À revoir.
const SUR_VIDE = new Set();

function RecouvrementApercu({ id, onFermer, onEtat }) {
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
        // Une vue image plein cadre est ouverte par-dessus : la laisser se
        // fermer d'abord, ne pas refermer tout l'apercu du meme coup.
        if (document.querySelector('.recouvrement-image')) return;
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

/* ------------------------------------------- barre de filtres commune */

const TRI_LABEL = { ajout: 'Ordre d’ajout', numero: 'Numéro', date: 'Date d’ajout' };

const parNumero = (a, b) => String(a.ref).localeCompare(String(b.ref), undefined, { numeric: true });

// Trie une liste de tuiles.
//   'ajout'  (galeries) : la liste arrive deja triee par date du tag, cote base
//   'numero' : #002… puis L1, M1…
//   'date'   (Bibliotheque) : date d'ajout de la tuile ; les oeuvres du pack
//            (sans date) passent avant tout ajout, dans l'ordre des numeros
function trier(tuiles, tri, sens) {
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
function SelecteurTags({ choisies, onChoisies, soustractif, onSoustractif }) {
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
function BarreFiltres({ triModes, tri, onTri, sens, onSens, q, onQ, tags }) {
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
        placeholder="Rechercher : titre, artiste, lieu, description, tags, numéro…"
      />
      {tags && <SelecteurTags {...tags} />}
    </div>
  );
}

/* ------------------------------------------------------- galeries (tags) */

// Un seul gabarit pour Livre / Étoile / À revoir : seuls le tag interroge et
// la couleur d'accent changent d'une page a l'autre.
function Galerie({ nom, tag, couleur, Icone, description, onEtat }) {
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
            />
          ))}
        </div>
      )}

      {apercuId && (
        <RecouvrementApercu id={apercuId} onFermer={fermerApercu} onEtat={onEtat} />
      )}
    </div>
  );
}

function PageLivre({ onEtat }) {
  return <Galerie nom="Livre" tag="livre" couleur="var(--livre)" Icone={I.Livre}
    description="Tuiles à approfondir" onEtat={onEtat} />;
}
function PageEtoile({ onEtat }) {
  return <Galerie nom="Étoile" tag="etoile" couleur="var(--etoile)" Icone={I.Etoile}
    description="Tuiles favorites" onEtat={onEtat} />;
}
function PageRevoir({ onEtat }) {
  return <Galerie nom="À revoir" tag="bad_smiley" couleur="var(--revoir)" Icone={I.Revoir}
    description="Ratées la dernière fois" onEtat={onEtat} />;
}

/* ----------------------------------------------------------- bibliotheque */

// Toutes les tuiles du corpus. Le filtre passe par la recherche permissive
// de la base (accents / casse / ponctuation ignores des deux cotes, chaque
// mot devant apparaitre quelque part hors image). Clic = agrandir, avec le
// rail de marquage comme partout.
function PageBibliotheque({ onEtat, onChoisirTuile }) {
  const [q, setQ] = useSession('bibliotheque:recherche', '');
  const [tri, setTri] = usePref('bibliotheque:tri', 'date');
  const [sens, setSens] = usePref('bibliotheque:sens', 'asc');
  const [catsFiltre, setCatsFiltre] = usePref('bibliotheque:categories', []);       // tags selectionnes
  const [soustractif, setSoustractif] = usePref('bibliotheque:soustractif', false);
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
      const actif = Object.keys(criteres).length > 0;
      const r = await window.api.oeuvres.toutes(actif ? criteres : undefined);
      if (!vivant) return;
      setResultats(r);
      if (!actif) setTotal(r.length);
    }, 120);
    return () => { vivant = false; clearTimeout(t); };
  }, [q, catsFiltre, soustractif, nonce]);

  const fermerApercu = () => { setApercuId(null); setNonce((n) => n + 1); };

  // souris4 : refermer l'aperçu d'abord (sauf en mode choix, géré par PageEdition).
  const { setRetour } = useContext(NavContext);
  useEffect(() => {
    if (choix) return undefined;
    setRetour(apercuId ? () => { fermerApercu(); return true; } : null);
    return () => setRetour(null);
  }, [apercuId, choix]);

  const filtre = q.trim().length > 0 || catsFiltre.length > 0;
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
      />

      {!affichees ? (
        <div className="chargement">chargement…</div>
      ) : affichees.length === 0 ? (
        <div className="galerie-vide">Aucune tuile ne correspond.</div>
      ) : (
        <div className="galerie-grille">
          {affichees.map((o) => (
            <CarteTuile key={o.id} o={o}
              onOuvrir={choix ? () => onChoisirTuile(o) : () => setApercuId(o.id)} />
          ))}
        </div>
      )}

      {!choix && apercuId && (
        <RecouvrementApercu id={apercuId} onFermer={fermerApercu} onEtat={onEtat} />
      )}
    </div>
  );
}

/* --------------------------------------------------------------- edition */

// Un champ texte de l'editeur, dans la meme case (.valeur) qu'en affichage.
function ChampEdit({ etiquette, v, onChange, placeholder, serif, mono, grand }) {
  return (
    <div className="champ">
      <div className="etiquette">{etiquette}</div>
      <div className={'valeur' + (grand ? ' valeur-titre' : '')}>
        <input
          className={'editeur-input' + (serif ? ' e-serif' : '') + (mono ? ' e-mono' : '')}
          value={v}
          onChange={onChange}
          placeholder={placeholder}
          spellCheck={false}
        />
      </div>
    </div>
  );
}

// Meme gabarit qu'une tuile affichee, tous les champs editables et vides.
// L'ID/ref est attribue a l'enregistrement. Image : S4.
function pesee(o) {
  const ko = Math.round(o / 1024);
  return ko >= 1024 ? (ko / 1024).toFixed(1) + ' Mo' : ko + ' Ko';
}

const CHAMPS_VIDES = { titre: '', artiste: '', date: '', lieu: '', description: '', tags: '', image: '' };
function memeChamps(a, b) {
  return Object.keys(CHAMPS_VIDES).every((c) => (a[c] || '') === (b[c] || ''));
}

// Cextrait une URL d'image d'un depot venant d'une page web.
function urlDepuisDrop(dt) {
  const uri = dt.getData('text/uri-list');
  if (uri) { const l = uri.split(/\r?\n/).find((x) => x && !x.startsWith('#')); if (l) return l.trim(); }
  const html = dt.getData('text/html');
  const m = html && html.match(/<img[^>]+src\s*=\s*["']([^"']+)["']/i);
  if (m) return m[1];
  const txt = dt.getData('text/plain');
  if (txt && /^https?:\/\//i.test(txt.trim())) return txt.trim();
  return null;
}

// Meme gabarit qu'une tuile affichee, champs editables.
//   mode 'creer'    : champs vides, bouton « Valider la création »
//   mode 'modifier' : champs pre-remplis, « Valider les changements » (grise
//                     tant que rien n'a change), + « Supprimer la tuile »
function EditeurTuile({ mode, tuile, onFini, onAnnuler, onSupprimer }) {
  const initial = mode === 'modifier'
    ? Object.fromEntries(Object.keys(CHAMPS_VIDES).map((c) => [c, tuile[c] || '']))
    : CHAMPS_VIDES;
  const imageInitiale = initial.image;

  const [champs, setChamps] = useState(initial);
  const [imgInfo, setImgInfo] = useState(null);
  const [imgErreur, setImgErreur] = useState(null);
  const [imgEnCours, setImgEnCours] = useState(false);
  const [survol, setSurvol] = useState(false);
  const [enCours, setEnCours] = useState(false);
  const [historique, setHistorique] = useState(null);   // null | 'chargement' | [{ champ, versions }]
  const [aVersions, setAVersions] = useState(false);

  // Le bouton n'apparait que s'il y a un historique a montrer.
  useEffect(() => {
    if (mode !== 'modifier') return;
    window.api.edition.versions(tuile.id).then((v) => setAVersions(v.length > 0));
  }, [mode, tuile && tuile.id]);
  const ouvrirHistorique = async () => {
    setHistorique('chargement');
    setHistorique(await window.api.edition.versions(tuile.id));
  };
  // Reprendre une version = la remettre dans le champ ; elle ne s'applique
  // qu'a « Valider les changements », comme toute modification.
  const reprendre = (champ, valeur) => {
    window.api.evt('edition', 'reprendre-version', { id: tuile.id, champ });
    setChamps((x) => ({ ...x, [champ]: valeur }));
    setHistorique(null);
  };

  const set = (c) => (e) => setChamps((x) => ({ ...x, [c]: e.target.value }));

  const dirty = !memeChamps(champs, initial);
  const peutValider = mode === 'modifier'
    ? dirty
    : (champs.titre.trim().length > 0 || champs.image.trim().length > 0);

  // Ne « oublie » que les images importees pendant cette session.
  const purge = (nom) => { if (nom && nom !== imageInitiale) window.api.edition.oublierImage(nom); };

  const poser = (info) => {
    setImgErreur(null);
    if (!info) return;
    if (info.erreur) { setImgErreur(info.erreur); return; }
    purge(champs.image);
    setChamps((x) => ({ ...x, image: info.nom }));
    setImgInfo(info);
  };
  const retirerImage = () => {
    purge(champs.image);
    setChamps((x) => ({ ...x, image: '' }));
    setImgInfo(null);
  };

  // Echec inattendu (exception cote principal) : message visible + journal.
  const echecImage = (origine, err) => {
    window.api.evt('image', 'import-exception', { origine, message: String(err && err.message || err) }, 'ERREUR');
    setImgErreur('Import impossible : ' + String(err && err.message || err) + ' — détails dans le journal.');
  };

  const choisir = async () => {
    if (imgEnCours || champs.image) return;
    setImgEnCours(true);
    try { poser(await window.api.edition.choisirImage()); }
    catch (err) { echecImage('selecteur', err); }
    finally { setImgEnCours(false); }
  };
  const deposer = async (e) => {
    e.preventDefault();
    setSurvol(false);
    if (imgEnCours) return;
    const tous = [...(e.dataTransfer.files || [])];
    const f = tous.find((x) => x.type.startsWith('image/'));
    const url = f ? null : urlDepuisDrop(e.dataTransfer);
    const detail = {
      fichiers: tous.map((x) => ({ nom: x.name, type: x.type || '(vide)', octets: x.size })),
      types: [...(e.dataTransfer.types || [])], url
    };
    if (!f && !url) {
      window.api.evt('image', 'depot-non-reconnu', detail, 'WARN');
      setImgErreur('Dépôt non reconnu — glisse un fichier ou une image d’une page web.');
      return;
    }
    window.api.evt('image', 'depot', { ...detail, retenu: f ? f.name : url });
    setImgEnCours(true);
    try {
      poser(f
        ? await window.api.edition.importerImage(await f.arrayBuffer(), { nom: f.name, type: f.type, octets: f.size })
        : await window.api.edition.importerImageUrl(url));
    } catch (err) { echecImage(f ? 'depot-fichier' : 'depot-url', err); }
    finally { setImgEnCours(false); }
  };

  const annuler = () => { purge(champs.image); onAnnuler(); };
  const valider = async () => {
    if (!peutValider || enCours) return;
    setEnCours(true);
    try {
      onFini(mode === 'modifier'
        ? await window.api.edition.modifier(tuile.id, champs)
        : await window.api.edition.creer(champs));
    } catch (e) {
      window.api.evt('edition', mode + '-exception', { id: tuile && tuile.id, message: String(e && e.message || e) }, 'ERREUR');
      setEnCours(false);
    }
  };

  const teteInfo = mode === 'modifier'
    ? (tuile.estLocale ? 'tuile locale' : 'œuvre du pack — tes corrections priment, réversibles')
    : 'champs libres — le numéro est attribué à l’enregistrement';

  return (
    <div className="jeu apercu-jeu editeur-jeu">
      <div className="rangee-tuiles">
        <div className="tuile">
          <div className="tete">
            <span className="numero">{mode === 'modifier' ? '#' + tuile.ref : 'nouvelle tuile'}</span>
            <span style={{ fontSize: 11.5, color: 'var(--discret)' }}>{teteInfo}</span>
          </div>

          <div className="corps">
            <div
              className={'cadre-image editeur-image' + (survol ? ' survol' : '')}
              onClick={choisir}
              onDragOver={(e) => { e.preventDefault(); setSurvol(true); }}
              onDragLeave={() => setSurvol(false)}
              onDrop={deposer}
            >
              {champs.image ? (
                <>
                  <img className="visuel" src={'tuile://' + champs.image} alt="" />
                  <button className="editeur-image-x" onClick={retirerImage} title="Retirer l’image">
                    <I.Croix t={13} />
                  </button>
                  {imgInfo && (
                    <span className="editeur-image-info">
                      {imgInfo.largeur}×{imgInfo.hauteur} · {pesee(imgInfo.octets)}
                      {imgInfo.redimensionnee ? ' · redimensionnée' : ''}
                    </span>
                  )}
                </>
              ) : (
                <div className="editeur-image-vide">
                  <I.OeilBarre t={24} />
                  <span>{imgEnCours ? 'import…' : 'Glisser une image ici ou cliquer'}</span>
                  <span style={{ textTransform: 'none', letterSpacing: 0, opacity: 0.7 }}>
                    {imgErreur || 'fichier ou image d’une page web · redimensionnée ≤ 500 Ko'}
                  </span>
                </div>
              )}
            </div>

            <div className="corps-reste">
              <div className="grille2">
                <ChampEdit etiquette="Titre" v={champs.titre} onChange={set('titre')} serif grand />
                <ChampEdit etiquette="Artiste" v={champs.artiste} onChange={set('artiste')} />
                <ChampEdit etiquette="Année / période" v={champs.date} onChange={set('date')} mono
                  placeholder="masquée au tirage" />
                <ChampEdit etiquette="Conservation" v={champs.lieu} onChange={set('lieu')} />
              </div>

              <div className="champ champ-description">
                <div className="etiquette">Description</div>
                <textarea
                  className="editeur-textarea"
                  value={champs.description}
                  onChange={set('description')}
                  spellCheck={false}
                />
              </div>

              <ChampEdit etiquette="Tags" v={champs.tags} onChange={set('tags')}
                placeholder="séparés par des virgules" />
            </div>
          </div>
        </div>
      </div>

      <div className="ligne-actions">
        <div className="actions-gauche">
          {mode === 'modifier' && (
            <button className="bouton-danger" onClick={() => onSupprimer(tuile)}>
              <I.Croix t={14} /> Supprimer la tuile
            </button>
          )}
          {mode === 'modifier' && aVersions && (
            <button className="bouton-neutre" onClick={ouvrirHistorique}>
              <I.Rafraichir t={14} /> Versions précédentes
            </button>
          )}
          <span className="compteur-sac">
            {mode === 'modifier' && !tuile.estLocale
              ? 'Correction locale — la source reste intacte'
              : 'Tuile locale — jamais envoyée au pack, exportable'}
          </span>
        </div>
        <div className="actions-droite">
          <button className="bouton-neutre" onClick={annuler}>
            <I.Croix t={14} /> Annuler
          </button>
          <button
            className="bouton-valide"
            onClick={valider}
            disabled={!peutValider || enCours}
            style={(!peutValider || enCours) ? { opacity: 0.4, cursor: 'default' } : undefined}
          >
            <I.Coche /> {mode === 'modifier' ? 'Valider les changements' : 'Valider la création'}
          </button>
        </div>
      </div>

      {historique && (
        <BoiteVersions
          historique={historique} actuels={champs}
          onReprendre={reprendre} onFermer={() => setHistorique(null)}
        />
      )}
    </div>
  );
}

const LIBELLES_CHAMPS = {
  titre: 'Titre', artiste: 'Artiste', date: 'Année / période', lieu: 'Conservation',
  description: 'Description', tags: 'Tags'
};

// Toutes les valeurs qu'ont eues les champs de la tuile, tous appareils
// confondus (journal de synchro). « Reprendre » remet la valeur dans
// l'editeur, sans rien enregistrer.
function BoiteVersions({ historique, actuels, onReprendre, onFermer }) {
  useEffect(() => {
    const clavier = (e) => { if (e.key === 'Escape') onFermer(); };
    window.addEventListener('keydown', clavier);
    return () => window.removeEventListener('keydown', clavier);
  }, [onFermer]);

  return (
    <div className="recouvrement" onClick={onFermer}>
      <div className="boite-dialogue boite-versions" onClick={(e) => e.stopPropagation()}>
        <h3>Versions précédentes</h3>
        <p>
          Toutes les valeurs qu’ont eues les champs de cette tuile, sur tous tes appareils. « Reprendre »
          remet la valeur dans l’éditeur : rien n’est enregistré avant « Valider les changements ».
        </p>
        {historique === 'chargement' ? <div className="chargement">chargement…</div> : (
          historique.map(({ champ, versions }) => (
            <div key={champ} className="versions-champ">
              <div className="etiquette">{LIBELLES_CHAMPS[champ] || champ}</div>
              {versions.map((v, i) => {
                const enCours = String(actuels[champ] || '') === v.valeur;
                return (
                  <div key={i} className={'version' + (i === 0 ? ' actuelle' : '')}>
                    <div className="version-qui">
                      {v.duPack ? 'Valeur du pack' : dateCourte(v.le) + ' · ' + v.appareil}
                      {i === 0 && <span className="conflit-badge">enregistrée</span>}
                    </div>
                    <div className="version-valeur">{v.valeur === '' ? '(vide)' : v.valeur}</div>
                    {enCours
                      ? <span className="version-dans">dans l’éditeur</span>
                      : <button className="bouton-neutre" onClick={() => onReprendre(champ, v.valeur)}>Reprendre</button>}
                  </div>
                );
              })}
            </div>
          ))
        )}
        <div className="actions">
          <button className="bouton-neutre" onClick={onFermer}>Fermer</button>
        </div>
      </div>
    </div>
  );
}

function PageEdition({ onEtat }) {
  const [mode, setMode] = useState(null);   // null (choix) | 'creer' | 'liste' | { tuile }
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
    else if (mode === 'creer' || mode === 'liste') f = () => { setMode(null); return true; };
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
  const finiModif = (r) => {
    setMode(null);
    if (onEtat) onEtat();
    notifier(`#${r.ref} enregistrée${r.masques === 0 ? ' — 0 masque valide' : ` (${r.masques} masques)`}.`);
  };
  const ouvrir = async (o) => {
    const t = await window.api.edition.tuile(o.id);
    if (t) setMode({ tuile: t });
  };
  const confirmerSuppr = async () => {
    const t = demandeSuppr;
    setDemandeSuppr(null);
    const r = await window.api.edition.supprimer(t.id);
    setMode(null);
    if (onEtat) onEtat();
    notifier(`#${t.ref} mise à la corbeille.`);
  };

  if (mode === 'creer') {
    return <EditeurTuile mode="creer" onFini={finiCreation} onAnnuler={() => setMode(null)} />;
  }
  if (mode === 'liste') {
    return (
      <>
        <PageBibliotheque onEtat={onEtat} onChoisirTuile={ouvrir} />
        <button className="edition-retour" onClick={() => setMode(null)}>
          <I.Fleche t={16} retour /> Retour
        </button>
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
          </span>
        </button>
        <button className="carte" onClick={() => setMode('liste')}>
          <span className="pastille"><I.Bibliotheque t={22} /></span>
          <span>
            <div className="nom">Modifier ou supprimer</div>
            <div className="desc">Choisir une tuile dans la liste</div>
          </span>
        </button>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- options */

const THEMES = [
  ['auto', 'Auto (Windows)'],
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

const RACCOURCIS = [
  ['bureau', 'Ajouter au bureau', 'Sur le bureau — retirer'],
  ['menu', 'Ajouter au menu Démarrer', 'Dans le menu Démarrer — retirer'],
  ['taskbar', 'Épingler à la barre des tâches', 'Épinglé à la barre — détacher']
];

// Resume d'une synchro ou d'un import en mots (echange.resumer).
function direChangements(s, images) {
  const l = [];
  const n = (k, un, plusieurs) => { if (s && s[k]) l.push(s[k] + ' ' + (s[k] > 1 ? plusieurs : un)); };
  n('tuilesNouvelles', 'nouvelle tuile', 'nouvelles tuiles');
  n('tuilesModifiees', 'tuile modifiée', 'tuiles modifiées');
  n('tuilesSupprimees', 'tuile supprimée', 'tuiles supprimées');
  n('tuilesRestaurees', 'tuile restaurée', 'tuiles restaurées');
  n('oeuvresCorrigees', 'œuvre corrigée', 'œuvres corrigées');
  n('marques', 'marque', 'marques');
  n('archives', 'archivage', 'archivages');
  if (images) l.push(images + ' image' + (images > 1 ? 's' : ''));
  return l.join(', ');
}

// « Envoyé : … Reçu : … » d'un bilan de synchro (service.js).
function phraseBilan(r) {
  // Bilan d'avant les resumes (0.2.2 et avant) : compte d'ops seulement.
  if (!r.envoye && !r.recu && (r.poussees || r.appliquees)) {
    return (r.poussees || 0) + ' modification(s) envoyée(s), ' + (r.appliquees || 0) + ' reçue(s).';
  }
  const envoye = direChangements(r.envoye, r.imagesEnvoyees);
  const recu = direChangements(r.recu, r.imagesRecues);
  return !envoye && !recu ? 'Tout était déjà à jour.'
    : [envoye && 'Envoyé : ' + envoye + '.', recu && 'Reçu : ' + recu + '.'].filter(Boolean).join(' ');
}

function Options({ etat, onEtat, aller }) {
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
    window.location.reload();   // la base a changé — repartir propre
  };

  useEffect(() => { window.api.drive.etat().then(setDrv); }, []);
  const drvFlash = (m) => { setDrvMsg(m); setTimeout(() => setDrvMsg(null), 8000); };

  const drvConnecter = async () => {
    setDrvOccupe(true); setDrvMsg(null); setDrvAction('connexion');
    const r = await window.api.drive.connecter();
    setDrvOccupe(false); setDrvAction(null);
    setDrv(r);
    if (r.erreur) drvFlash({ erreur: r.erreur });
  };
  const drvDeconnecter = async () => { setDrv(await window.api.drive.deconnecter()); };

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
    if (r.erreur) { setMsg({ erreur: r.erreur }); return; }
    const morceaux = [];
    if (r.reconnecte) morceaux.push('Reconnecté à Google.');
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
      window.location.reload();   // la base a change — repartir propre
      return;
    }
    setMsg(msg);
    setSyn(await window.api.synchro.etat());
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
    annoncer(r, 'drive');
  };
  const syncDrive = prog.enCours && prog.par === 'drive';
  const syncDossier = prog.enCours && prog.par === 'dossier';

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
              Les raccourcis pointent vers l’exe portable actuel. Si tu le déplaces, refais-les.
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
          <I.Croix t={14} /> Effacer toutes les marques livre / étoile / à revoir
        </button>
        {effacementFait != null && (
          <div className="options-confirmation">
            <I.Coche t={14} /> {effacementFait} marque{effacementFait > 1 ? 's' : ''} effacée{effacementFait > 1 ? 's' : ''}
          </div>
        )}
        <div className="options-note">
          {totalMarques > 0
            ? `${totalMarques} tuile${totalMarques > 1 ? 's' : ''} actuellement marquée${totalMarques > 1 ? 's' : ''}.`
            : 'Aucune tuile marquée pour l’instant.'}
        </div>
      </section>

      <div className="filet" />

      <SectionMaj etat={etat} definir={definir} />

      <div className="filet" />

      <section>
        <div className="etiquette">Google Drive</div>
        {!drv ? (
          <div className="options-note">…</div>
        ) : !drv.configure ? (
          <div className="options-note">
            Synchronisation non disponible sur cette version (client OAuth absent).
          </div>
        ) : !drv.connecte ? (
          <>
            <button className="bouton-neutre" onClick={drvConnecter} disabled={drvOccupe}>
              <I.Nuage t={16} /> {drvOccupe ? 'Connexion…' : 'Connecter Google Drive'}
            </button>
            <div className="options-note">
              Ouvre le navigateur pour autoriser l’accès. L’application ne voit que le
              dossier « Tuiles et Toiles » qu’elle crée dans ton Drive — rien d’autre.
            </div>
          </>
        ) : (
          <>
            <div className="choix-raccourcis">
              <button className="bouton-neutre" onClick={drvSynchroniser} disabled={drvOccupe || prog.enCours}>
                <I.Echange t={16} /> {syncDrive ? 'Synchro en cours…' : 'Synchroniser'}
              </button>
              <button className="bouton-neutre" onClick={drvDeconnecter} disabled={drvOccupe || prog.enCours}>
                <I.Croix t={14} /> Déconnecter
              </button>
            </div>
            <div className="options-note">
              Connecté : {drv.email || 'compte Google'}.{' '}
              {syn && syn.derniereDrive
                ? 'Dernière synchro le ' + new Date(syn.derniereDrive.le).toLocaleString('fr-FR') + '.'
                : 'Jamais synchronisé depuis ce poste.'}
              {syn && syn.conflits ? ' ' + syn.conflits + ' conflit(s) à trancher.' : ''}
            </div>
            {!drvMsg && syn && syn.derniereDrive && (
              <div className="options-note">Dernière fois : {phraseBilan(syn.derniereDrive)}</div>
            )}
            <div className="options-note">
              <strong>Synchroniser</strong> envoie les changements faits sur cet appareil et
              récupère ceux de tes autres appareils. Rien n’est écrasé : chaque modification
              est fusionnée. Si une même tuile a été modifiée des deux côtés, la version la plus
              récente s’affiche et l’autre t’est proposée dans « Conflits ».
            </div>
          </>
        )}
        {drvAction && (
          <div className="drive-encours">
            <span className="drive-pastille" />
            Connexion à Google Drive — autorise l’accès dans le navigateur…
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
      </section>

      {syn && drv && (drv.connecte || syn.dossier) && (
        <>
          <div className="filet" />
          <section>
            <div className="etiquette">Synchro automatique</div>
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
            {syn.auto && syn.auto.pauseDrive && drv.connecte && (
              <div className="options-note" style={{ color: 'var(--revoir)' }}>
                Session Google expirée : la synchro automatique avec Drive est en pause. Clique
                « Synchroniser » ci-dessus pour autoriser de nouveau l’accès.
              </div>
            )}
            <div className="options-note">
              Au lancement, une vingtaine de secondes après chaque modification, toutes les 15 minutes
              et à la fermeture de l’appli s’il reste des changements à envoyer. Silencieuse : sans
              connexion, elle réessaie plus tard ; elle n’ouvre jamais le navigateur toute seule.
            </div>
          </section>
        </>
      )}

      <div className="filet" />

      <section>
        <div className="etiquette">Synchro entre appareils</div>
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
      </section>

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

/* ------------------------------------------------------ progression synchro */

// Etape en cours, compteur (images), temps ecoule : l'utilisateur voit que
// sa demande avance, sans avoir a changer d'onglet ni recliquer.
function ProgressionSynchro({ p, titre }) {
  const s = Math.max(0, Math.round((Date.now() - (p.debut || Date.now())) / 1000));
  const duree = s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + String(s % 60).padStart(2, '0') + ' s';
  const reconnexion = p.etape === 'reconnexion';
  return (
    <div className={'drive-encours' + (reconnexion ? ' attente' : '')} role="status" aria-live="polite">
      <span className="drive-pastille" />
      <span>
        <strong>{titre}</strong> — {p.libelle || 'en cours…'}
        {p.total ? ' (' + p.faits + ' / ' + p.total + ')' : ''}
        <span className="progression-duree"> · {duree}</span>
      </span>
    </div>
  );
}

/* ---------------------------------------------------------------- conflits */

const dateCourte = (iso) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
const texteValeur = (v, champ) => (v == null || v === '' ? '(vide)' : champ === 'image' ? 'une image' : String(v));

// Conflits de synchro : le meme champ modifie sur deux appareils sans que
// l'un ait vu l'autre, ou une tuile supprimee ici et modifiee la-bas. La
// valeur la plus recente est affichee en attendant ; rien ne bloque.
function PageConflits({ onEtat }) {
  const [liste, setListe] = useState(null);
  const [enCours, setEnCours] = useState(null);

  useEffect(() => { window.api.conflits.liste().then(setListe); }, []);

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
            Modifications faites sur deux appareils sans qu’ils se soient vus. En attendant ton choix,
            la plus récente est affichée — ton choix partira à la prochaine synchro.
          </div>
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
                <span className="conflit-champ">{c.type === 'suppression' ? 'supprimée ici, modifiée là-bas' : c.libelle}</span>
              </div>
              {c.type === 'suppression' ? (
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

function Version({ titre, date, texte, bouton, actuelle, occupe, onChoisir }) {
  return (
    <div className={'conflit-version' + (actuelle ? ' actuelle' : '')}>
      <div className="conflit-qui">{titre}{actuelle && <span className="conflit-badge">affichée</span>}</div>
      <div className="conflit-quand">{dateCourte(date)}</div>
      <div className="conflit-valeur">{texte}</div>
      <button className="bouton-neutre" onClick={onChoisir} disabled={occupe}><I.Coche t={14} /> {bouton}</button>
    </div>
  );
}

/* --------------------------------------------------------------- corbeille */

// Tuiles supprimees (encore restaurables) et oeuvres du pack archivees.
// Restaurer = une modification ordinaire : elle part a la prochaine synchro.
function PageCorbeille({ onEtat }) {
  const [liste, setListe] = useState(null);
  const [enCours, setEnCours] = useState(null);
  const [msg, setMsg] = useState(null);

  useEffect(() => { window.api.corbeille.liste().then(setListe); }, []);

  const restaurer = async (o) => {
    setEnCours(o.id); setMsg(null);
    const r = await window.api.corbeille.restaurer(o.id);
    setEnCours(null);
    if (r.erreur) { setMsg({ erreur: r.erreur }); setListe(await window.api.corbeille.liste()); return; }
    setListe(r.liste);
    setMsg({ ok: '#' + (r.ref || o.ref) + ' restaurée.' });
    onEtat();
  };
  const jour = (iso) => new Date(iso).toLocaleDateString('fr-FR', { dateStyle: 'long' });

  return (
    <div className="galerie" style={{ '--accent': 'var(--discret)' }}>
      <div className="galerie-tete">
        <span className="galerie-icone"><I.Corbeille t={22} /></span>
        <div>
          <h2>Corbeille</h2>
          <div className="soustitre">
            Tuiles supprimées, avec leurs marques. Une tuile que tu as créée reste restaurable
            90 jours ; une œuvre du pack, toujours. La restauration part vers tes autres appareils
            à la prochaine synchro.
          </div>
        </div>
        <span className="galerie-compte">{liste ? liste.length : '…'}</span>
      </div>

      {msg && msg.ok && <div className="options-confirmation"><I.Coche t={14} /> {msg.ok}</div>}
      {msg && msg.erreur && <div className="options-note" style={{ color: 'var(--revoir)' }}>{msg.erreur}</div>}

      {!liste ? <div className="chargement">chargement…</div> : !liste.length ? (
        <div className="galerie-vide">La corbeille est vide.</div>
      ) : (
        <div className="galerie-grille">
          {liste.map((o) => (
            <div key={o.id} className="carte-galerie carte-corbeille">
              {o.image
                ? <img className="carte-galerie-image" src={o.image} alt="" loading="lazy" />
                : <div className="carte-galerie-image carte-galerie-image-vide" />}
              <div className="carte-galerie-corps">
                <span className="numero">#{o.ref}{o.estLocale ? '' : ' · pack'}</span>
                <div className="carte-galerie-titre">{o.titre || '—'}</div>
                <div className="carte-galerie-artiste">{o.artiste || '—'}{o.date ? ' · ' + o.date : ''}</div>
                <div className="corbeille-dates">
                  Supprimée le {jour(o.supprimeeLe)}
                  {o.effaceeLe && <><br />Effacée définitivement le {jour(o.effaceeLe)}</>}
                </div>
                <button className="bouton-neutre corbeille-restaurer" onClick={() => restaurer(o)} disabled={enCours === o.id}>
                  <I.Rafraichir t={14} /> {enCours === o.id ? 'Restauration…' : 'Restaurer'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------- rapport d'erreur */

// Un clic : le rapport (formulaire + journaux masques) part directement au
// script de reception, qui le transmet par mail. Apercu depliable avant envoi.
// Hors ligne : mis en attente, renvoye au prochain lancement.
function FormulaireRapport({ onFermer }) {
  const [choix, setChoix] = useState(null);
  const [f, setF] = useState({ sujet: '', depuis: '', reproductible: '', description: '', email: '' });
  const [apercu, setApercu] = useState(null);
  const [occupe, setOccupe] = useState(false);
  const [fini, setFini] = useState(null);       // resultat de l'envoi
  const [msg, setMsg] = useState(null);

  useEffect(() => { window.api.rapport.choix().then(setChoix); }, []);
  useEffect(() => {
    const clavier = (e) => { if (e.key === 'Escape') onFermer(); };
    window.addEventListener('keydown', clavier);
    return () => window.removeEventListener('keydown', clavier);
  }, [onFermer]);

  const set = (k) => (e) => { setF((x) => ({ ...x, [k]: e.target.value })); setApercu(null); };
  const complet = f.sujet && f.depuis && f.reproductible;
  const voir = async (e) => { if (e.target.open && !apercu) setApercu(await window.api.rapport.apercu(f)); };

  const envoyer = async () => {
    setOccupe(true); setMsg(null);
    const r = await window.api.rapport.envoyer(f);
    setOccupe(false);
    if (r.erreur && !r.enAttente) { setMsg({ erreur: r.erreur }); return; }
    setFini(r);
  };
  const copier = async () => {
    await window.api.rapport.copier(f);
    setMsg({ ok: 'Texte du rapport copié : colle-le dans un mail à ' + choix.destinataire + '.' });
  };

  if (fini) {
    return (
      <div className="recouvrement" onClick={onFermer}>
        <div className="boite-dialogue boite-rapport" onClick={(e) => e.stopPropagation()}>
          <h3>{fini.ok ? 'Rapport envoyé' : fini.enAttente ? 'Rapport mis de côté' : 'Messagerie ouverte'}</h3>
          <p>
            {fini.ok && <>Merci ! Le rapport <strong>{fini.id}</strong> est parti avec le journal complet.</>}
            {fini.enAttente && <>Pas de connexion pour l’instant ({fini.erreur}). Le rapport <strong>{fini.id}</strong> partira
              tout seul au prochain lancement de l’application.</>}
            {fini.secours && <>L’envoi direct n’est pas encore configuré : ta messagerie s’est ouverte avec le rapport
              (texte seul, sans le journal complet). Il ne reste qu’à cliquer « Envoyer ».</>}
          </p>
          <div className="actions">
            <button className="bouton-valide" onClick={onFermer}><I.Coche t={14} /> Fermer</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="recouvrement" onClick={onFermer}>
      <div className="boite-dialogue boite-rapport" onClick={(e) => e.stopPropagation()}>
        <h3>Envoyer le log pour rapport d’erreur</h3>
        {!choix ? <p>Chargement…</p> : (
          <>
            <label className="rapport-champ">
              <span>Quel est le problème ?</span>
              <select className="editeur-input" value={f.sujet} onChange={set('sujet')} autoFocus>
                <option value="">— choisir —</option>
                {choix.sujets.map((x) => <option key={x.cle} value={x.cle}>{x.libelle}</option>)}
              </select>
            </label>
            <label className="rapport-champ">
              <span>Depuis quand ?</span>
              <select className="editeur-input" value={f.depuis} onChange={set('depuis')}>
                <option value="">— choisir —</option>
                {choix.depuis.map((x) => <option key={x.cle} value={x.cle}>{x.libelle}</option>)}
              </select>
            </label>
            <label className="rapport-champ">
              <span>Le problème se reproduit-il ?</span>
              <select className="editeur-input" value={f.reproductible} onChange={set('reproductible')}>
                <option value="">— choisir —</option>
                {choix.reproductible.map((x) => <option key={x.cle} value={x.cle}>{x.libelle}</option>)}
              </select>
            </label>
            <label className="rapport-champ">
              <span>Que s’est-il passé ? Qu’attendais-tu ? <em>(facultatif)</em></span>
              <textarea className="editeur-textarea rapport-description" value={f.description} onChange={set('description')}
                placeholder="Ex. : j’ai glissé une photo nommée « Москва.jpg », rien ne s’est affiché." spellCheck />
            </label>
            <label className="rapport-champ">
              <span>Ton email, pour qu’on puisse te répondre <em>(facultatif)</em></span>
              <input className="editeur-input" type="email" value={f.email} onChange={set('email')} />
            </label>

            {complet && (
              <details className="rapport-apercu" onToggle={voir}>
                <summary>Voir ce qui sera envoyé</summary>
                {!apercu ? <p>Préparation…</p> : apercu.erreur ? <p>{apercu.erreur}</p> : (
                  <>
                    <pre>{'Objet : ' + apercu.objet + '\n\n' + apercu.corps}</pre>
                    <p>
                      Journaux joints : {apercu.journaux.map((j) => j.nom + ' (' + Math.round(j.octets / 1024) + ' Ko)').join(', ')}
                      {' '}— nom d’utilisateur Windows, nom de l’ordinateur et emails masqués.
                    </p>
                  </>
                )}
              </details>
            )}

            {choix.enAttente > 0 && (
              <div className="options-note">{choix.enAttente} rapport(s) précédent(s) en attente : ils repartiront au prochain lancement.</div>
            )}
            {msg && msg.ok && <div className="options-confirmation"><I.Coche t={14} /> {msg.ok}</div>}
            {msg && msg.erreur && <div className="options-note" style={{ color: 'var(--revoir)' }}>{msg.erreur}</div>}
            <div className="actions rapport-actions">
              <button className="bouton-neutre" onClick={copier} disabled={!complet}>Copier le texte</button>
              <button className="bouton-neutre" onClick={onFermer}>Annuler</button>
              <button className="bouton-valide" onClick={envoyer} disabled={!complet || occupe}>
                <I.Coche t={14} /> {occupe ? 'Envoi…' : choix.envoiDirect ? 'Envoyer le rapport' : 'Ouvrir ma messagerie'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- confirmation */

// Boite de dialogue commune (fermeture de l'appli, effacement des marques…).
// Clic dehors ou Échap = Annuler.
// validerEntree : Entrée ou Espace (hors focus sur un bouton) valent « oui ».
// confirmerVariante : 'danger' (rouge, défaut) ou 'valide' (vert, action non destructive).
function BoiteConfirmation({ titre, texteConfirmer, onAnnuler, onConfirmer, validerEntree = false, confirmerVariante = 'danger', children }) {
  useEffect(() => {
    const clavier = (e) => {
      if (e.key === 'Escape') { onAnnuler(); return; }
      if (!validerEntree) return;
      const surBouton = e.target && e.target.tagName === 'BUTTON';
      if (!surBouton && (e.key === 'Enter' || e.key === ' ' || e.code === 'Space')) {
        e.preventDefault();
        onConfirmer();
      }
    };
    window.addEventListener('keydown', clavier);
    return () => window.removeEventListener('keydown', clavier);
  }, [onAnnuler, onConfirmer, validerEntree]);

  return (
    <div className="recouvrement" onClick={onAnnuler}>
      <div className="boite-dialogue" onClick={(e) => e.stopPropagation()}>
        <h3>{titre}</h3>
        {children}
        <div className="actions">
          <button className="bouton-neutre" onClick={onAnnuler}>Annuler</button>
          {confirmerVariante === 'valide' ? (
            <button className="bouton-valide" onClick={onConfirmer}>
              <I.Coche t={14} /> {texteConfirmer}
            </button>
          ) : (
            <button className="bouton-danger" onClick={onConfirmer}>
              <I.Croix t={14} /> {texteConfirmer}
            </button>
          )}
        </div>
      </div>
    </div>
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

/* ---------------------------------------------------------- mise a jour */

// Etat de mise a jour partage entre le bandeau (verification au lancement) et
// la section Options. phase : null | 'verif' | 'ajour' | 'dispo' |
// 'telechargement' | 'pret' | 'erreur'. Rien n'est telecharge sans clic.
function useMaj() {
  const [s, setS] = useState({ phase: null });
  const [progression, setProgression] = useState(null);
  useEffect(() => window.api.maj.onProgression(setProgression), []);

  const verifier = useCallback(async (silencieux) => {
    setS({ phase: 'verif' });
    const r = await window.api.maj.verifier();
    if (r.disponible) setS({ phase: 'dispo', info: r });
    else if (r.aJour) setS({ phase: silencieux ? null : 'ajour' });
    else setS(silencieux ? { phase: null } : { phase: 'erreur', erreur: r.erreur });
  }, []);

  const telecharger = useCallback(async () => {
    setProgression(null);
    setS((p) => ({ ...p, phase: 'telechargement', erreur: null }));
    const r = await window.api.maj.telecharger();
    if (r.ok) setS((p) => ({ ...p, phase: 'pret' }));
    else setS((p) => ({ ...p, phase: 'dispo', erreur: r.pageOuverte ? null : r.erreur }));
  }, []);

  const installer = useCallback(async () => {
    const r = await window.api.maj.installer();
    if (r.erreur) setS((p) => ({ ...p, erreur: r.erreur }));
  }, []);

  return { ...s, progression, verifier, telecharger, installer };
}

const MajContext = createContext(null);

const enMo = (octets) => Math.round(octets / 1048576) + ' Mo';

function pourcent(p) {
  return p && p.total ? Math.floor((p.recu / p.total) * 100) : 0;
}

// Boutons d'action selon la phase (bandeau et Options).
function ActionsMaj({ maj }) {
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
        <I.Rafraichir t={14} /> Redémarrer sur la version {maj.info.version}
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
function BandeauMaj() {
  const maj = useContext(MajContext);
  const [masque, setMasque] = useState(false);
  if (!maj || masque || !['dispo', 'telechargement', 'pret'].includes(maj.phase)) return null;
  return (
    <div className="maj-bandeau">
      <div className="maj-bandeau-titre">
        {maj.phase === 'pret'
          ? 'Version ' + maj.info.version + ' prête'
          : 'Version ' + maj.info.version + ' disponible'}
      </div>
      <div className="options-note">
        {maj.phase === 'pret'
          ? 'L’application va se fermer et se relancer. Tes données sont conservées.'
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
function SectionMaj({ etat, definir }) {
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
      {maj.phase === 'ajour' && (
        <div className="options-confirmation"><I.Coche t={14} /> Tu as la dernière version.</div>
      )}
      {maj.erreur && <div className="options-note" style={{ color: 'var(--revoir)' }}>{maj.erreur}</div>}
      <div className="options-note">
        Version installée : {etat.version}. Les nouvelles versions viennent de
        github.com/EryoGreg/tuiles-et-toiles ; seul l’exe est remplacé, tes données restent.
      </div>
    </section>
  );
}

export default function App() {
  const [etat, setEtat] = useState(null);
  const [page, setPage] = useState('menu');
  const [repliee, setRepliee] = useState(false);
  const [confirmerFermeture, setConfirmerFermeture] = useState(false);
  const [racPerimes, setRacPerimes] = useState(null);
  const [proposerRaccourcis, setProposerRaccourcis] = useState(false);
  const [colonnes, setColonnes] = useState(5);

  // Historique de navigation (souris4 = reculer, souris5 = avancer). `nonce`
  // rejoue le montage de la page : cliquer l'onglet parent depuis une
  // sous-page (Édition -> modifier) ramène bien à la page parent.
  const histoRef = useRef({ pile: ['menu'], pos: 0 });
  const [navNonce, setNavNonce] = useState(0);

  // Gestionnaire de retour interne posé par la page courante (voir NavContext).
  const retourInterneRef = useRef(null);
  const setRetour = useCallback((fn) => { retourInterneRef.current = fn || null; }, []);
  const navValue = useMemo(() => ({ setRetour }), [setRetour]);

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
  const conflitsAvant = useRef(null);
  useEffect(() => {
    window.api.synchro.etat().then((s) => { if (s.progression && s.progression.enCours) setSynchroEnCours(s.progression); });
    return window.api.synchro.onProgression((p) => {
      setSynchroEnCours(p.enCours ? p : null);
      if (p.enCours) return;
      charger();   // compteurs (conflits…) a jour sans changer d'onglet
      const r = p.resultat;
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
  // cyclee 5 -> 7 -> 9 par le bouton de BarreFiltres.
  useEffect(() => {
    if (etat && etat.grilleColonnes) setColonnes(etat.grilleColonnes);
  }, [etat && etat.grilleColonnes]);
  useEffect(() => {
    document.documentElement.style.setProperty('--grille-cols', colonnes);
  }, [colonnes]);
  const cyclerColonnes = useCallback(() => {
    setColonnes((c) => {
      const n = DENSITES[(DENSITES.indexOf(c) + 1) % DENSITES.length] || DENSITES[0];
      window.api.reglages.definir('grille_colonnes', String(n));
      window.api.log('grille -> ' + n + '/ligne');
      return n;
    });
  }, []);

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

  const reculer = useCallback(() => {
    // D'abord fermer l'état interne de la page (aperçu, éditeur…) s'il y en a.
    if (retourInterneRef.current && retourInterneRef.current()) return;
    const h = histoRef.current;
    if (h.pos <= 0) return;
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
  // une saisie en cours serait perdue).
  const PAGES_LISTES = ['bibliotheque', 'livre', 'etoile', 'revoir', 'corbeille', 'conflits'];
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
        <BandeauMaj />
      </div>
     </NavContext.Provider>
    </GrilleContext.Provider>
   </MajContext.Provider>
  );
}
