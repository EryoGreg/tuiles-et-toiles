// Decoupe d'App.jsx (etape 1 de Bristol) : code inchange, voir scripts/decouper-app.js.
import { useEffect, useState, useCallback, useRef, useMemo, useContext } from 'react';
import * as I from '../icones.jsx';
import { NavContext, usePref, useSession } from '../commun/base.jsx';
import { Revision, texteRevision } from './Revision.jsx';
import { Tuile } from '../tuile/Tuile.jsx';
import { MARQUES_MENU, PIPS } from '../tuile/Cartes.jsx';

// Icone et couleur des marques connues ; une marque inconnue (marque creee
// par l'utilisateur, plus tard) s'affiche avec son seul libelle.
const ICONE_MARQUE = new Map(MARQUES_MENU.map(([v, , Icone]) => [v, Icone]));
const COULEUR_MARQUE = new Map(PIPS);

/* ------------------------------------------------------ nouvelle partie */

// Ecran de choix du mode, avant le premier tirage. Aleatoire : toutes les
// oeuvres, tag de jeu toujours censure. Categorie : une ou plusieurs familles
// de tags (choix multiple), tag de jeu visible s'il est seul sur la tuile.
export function NouvellePartie({ onLancer }) {
  const [mode, setMode] = usePref('partie:mode', 'aleatoire');
  const [cats, setCats] = useState(null);
  const [choisies, setChoisies] = usePref('partie:categories', []);   // valeurs de categorie
  const [q, setQ] = useSession('partie:recherche', '');
  // Combinaison des catégories choisies :
  //   additif (défaut) : l'œuvre porte AU MOINS UNE des catégories
  //   soustractif      : l'œuvre porte TOUTES les catégories
  const [soustractif, setSoustractif] = usePref('partie:soustractif', false);
  // Difficulte (par appareil, persistee) : « difficile » (defaut) = 1 indice,
  // « normal » = 2. Lue par le processus principal au tirage (jeu.tuile).
  const [difficulte, setDifficulte] = usePref('difficulte', 'difficile');
  // Aleatoire restreint (facultatif) : tuiles portant au moins une des marques
  // choisies (Livre, Etoile, A revoir, ou marque utilisateur future). Aucune = tout.
  const [marquesChoisies, setMarquesChoisies] = usePref('partie:marques', []);
  const [marques, setMarques] = useState(null);   // { liste, total }
  const [apercu, setApercu] = useState(null);     // { total, possibles }
  const [rev, setRev] = useState(null);           // compteurs de la revision espacee
  useEffect(() => { window.api.revision.etat().then(setRev).catch(() => {}); }, []);

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

  useEffect(() => {
    if (mode !== 'aleatoire') return undefined;
    let vivant = true;
    window.api.jeu.marques({ marques: marquesChoisies }).then((r) => {
      if (!vivant) return;
      // Marque memorisee disparue depuis (marque utilisateur supprimee) : retiree.
      const connues = new Set(r.liste.map((m) => m.valeur));
      if (!marquesChoisies.every((v) => connues.has(v))) {
        setMarquesChoisies((s) => s.filter((v) => connues.has(v)));
        return;
      }
      setMarques(r);
    }).catch(() => {});
    return () => { vivant = false; };
  }, [mode, marquesChoisies]);
  const basculerMarque = (v) => setMarquesChoisies((s) =>
    s.includes(v) ? s.filter((x) => x !== v) : [...s, v]);
  const totalMarques = marquesChoisies.length && marques ? marques.total : null;

  // Ordre des catégories : les plus fournies d'abord (défaut) ou A → Z.
  const [triCats, setTriCats] = usePref('partie:tri-categories', 'n');
  const filtrees = useMemo(() => {
    if (!cats) return [];
    const n = q.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const l = n ? cats.filter((c) => c.valeur.includes(n) || c.label.toLowerCase().includes(n)) : cats.slice();
    return triCats === 'az'
      ? l.sort((a, b) => a.label.localeCompare(b.label, 'fr', { sensitivity: 'base' }))
      : l.sort((a, b) => b.n - a.n || a.label.localeCompare(b.label, 'fr', { sensitivity: 'base' }));
  }, [cats, q, triCats]);
  const labelDe = useMemo(() => new Map((cats || []).map((c) => [c.valeur, c.label])), [cats]);

  const basculerCat = (v) => setChoisies((s) =>
    s.includes(v) ? s.filter((x) => x !== v) : [...s, v]);

  // En soustractif, une catégorie qui ferait tomber le résultat à 0 est
  // désactivée (sauf si déjà choisie — on peut toujours la retirer).
  const possibles = apercu && apercu.possibles ? new Set(apercu.possibles) : null;
  const bloquee = (v) => !!possibles && !choisies.includes(v) && !possibles.has(v);

  const total = apercu ? apercu.total : null;
  const peutLancer = (mode === 'aleatoire' && totalMarques !== 0) || mode === 'revision'
    || (choisies.length > 0 && (total == null || total > 0));
  const lancer = () => {
    if (!peutLancer) return;
    onLancer(mode === 'categorie' ? { cats: choisies, soustractif }
      : mode === 'revision' ? { revision: true }
      : marquesChoisies.length ? { marques: marquesChoisies } : null);
  };

  return (
    // Par catégorie : écran compact (modes en onglets, sans description ;
    // Lancer en pied de page) pour laisser la hauteur à la liste des catégories.
    <div className={'nouvelle-partie' + (mode === 'categorie' ? ' np-compacte' : '')}>
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
          className={'np-mode' + (mode === 'revision' ? ' actif' : '')}
          onClick={() => setMode('revision')}
        >
          <span className="np-radio" />
          <span>
            <div className="np-mode-nom">Révision espacée</div>
            <div className="np-mode-desc">
              Chaque tuile revient au bon moment : juste avant que tu l’oublies. Après « Tout
              révéler », dis si tu t’en souvenais (Encore · Difficile · Bien · Facile).
              {rev && ' ' + texteRevision(rev)}
            </div>
          </span>
        </button>

        {mode !== 'categorie' && (
          <button
            className={'np-lancer' + (peutLancer ? '' : ' off')}
            disabled={!peutLancer}
            onClick={lancer}
          >
            <span>Lancer <I.Fleche /></span>
            {mode === 'aleatoire' && marquesChoisies.length > 0 && (
              <span className="np-lancer-sub">
                {totalMarques == null ? '…' : totalMarques === 0 ? 'aucune tuile marquée' : totalMarques + ' tuile' + (totalMarques > 1 ? 's' : '')}
              </span>
            )}
            {mode === 'revision' && rev && (
              <span className="np-lancer-sub">
                {rev.dues + rev.nouvelles === 0 ? 'rien à revoir pour l’instant' : (rev.dues + rev.nouvelles) + ' tuile' + (rev.dues + rev.nouvelles > 1 ? 's' : '') + ' aujourd’hui'}
              </span>
            )}
          </button>
        )}
        <div className="np-difficulte">
          <div className="np-diff-tete">Difficulté</div>
          <div className="np-diff-choix">
            <button
              type="button"
              className={'np-diff' + (difficulte === 'normal' ? ' actif' : '')}
              onClick={() => setDifficulte('normal')}
            >
              <span className="np-diff-nom">Normal</span>
              <span className="np-diff-desc">2 indices affichés</span>
            </button>
            <button
              type="button"
              className={'np-diff' + (difficulte === 'difficile' ? ' actif' : '')}
              onClick={() => setDifficulte('difficile')}
            >
              <span className="np-diff-nom">Difficile</span>
              <span className="np-diff-desc">1 seul indice</span>
            </button>
          </div>
        </div>

        {mode === 'aleatoire' && (
          <div className="np-marques">
            <div className="np-diff-tete">Marques <span className="np-facultatif">facultatif</span></div>
            <div className="np-marques-choix">
              {(marques ? marques.liste : MARQUES_MENU.map(([valeur, label]) => ({ valeur, label, n: null }))).map((m) => {
                const Icone = ICONE_MARQUE.get(m.valeur);
                const actif = marquesChoisies.includes(m.valeur);
                const vide = m.n === 0 && !actif;
                return (
                  <button
                    key={m.valeur}
                    type="button"
                    className={'np-marque' + (actif ? ' actif' : '') + (vide ? ' bloquee' : '')}
                    style={{ '--marque': COULEUR_MARQUE.get(m.valeur) || 'var(--laiton)' }}
                    disabled={vide}
                    aria-pressed={actif}
                    title={vide ? 'Aucune tuile marquée « ' + m.label + ' »' : actif ? 'Retirer de la sélection' : 'Ne tirer que parmi les tuiles marquées (au moins une marque choisie)'}
                    onClick={() => basculerMarque(m.valeur)}
                  >
                    {Icone && <Icone t={14} />}
                    <span className="np-marque-nom">{m.label}</span>
                    {m.n != null && <span className="np-chip-n">{m.n}</span>}
                  </button>
                );
              })}
            </div>
            <div className="np-marques-desc">
              {marquesChoisies.length === 0
                ? 'Aucune : tirage dans toutes les œuvres.'
                : 'Tuiles portant au moins une des marques choisies.'}
            </div>
          </div>
        )}

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
            <button
              className="np-combi np-tri"
              onClick={() => setTriCats((t) => (t === 'az' ? 'n' : 'az'))}
              title={triCats === 'az' ? 'Ordre alphabétique. Cliquer pour classer par nombre de tuiles.' : 'Les plus fournies d’abord. Cliquer pour l’ordre alphabétique.'}
            >
              <span className="np-combi-mot">{triCats === 'az' ? 'A → Z' : 'les plus fournies'}</span>
            </button>
          </div>
          {choisies.length > 0 && (
            <div className="np-choisies">
              {choisies.map((v) => (
                <button key={v} className="np-choisie" onClick={() => basculerCat(v)} title="Retirer">
                  {labelDe.get(v) || v} <span aria-hidden="true">×</span>
                </button>
              ))}
              {choisies.length > 1 && (
                <button className="np-choisies-vider" onClick={() => setChoisies([])}>Tout retirer</button>
              )}
            </div>
          )}
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

      {mode === 'categorie' && (
        <div className="np-pied">
          <span className="np-pied-compte">
            {choisies.length === 0
              ? 'Choisir au moins une catégorie'
              : total == null ? '…'
              : total === 0 ? 'Aucune tuile — combinaison impossible'
              : total + (total > 1 ? ' tuiles' : ' tuile')
                + ' · ' + choisies.length + (choisies.length > 1 ? ' catégories' : ' catégorie')}
          </span>
          <button
            className={'np-lancer' + (peutLancer ? '' : ' off')}
            disabled={!peutLancer}
            onClick={lancer}
          >
            <span>Lancer <I.Fleche /></span>
          </button>
        </div>
      )}
    </div>
  );
}

// Choix du mode, puis la partie. La cle sur <Partie> force un etat neuf
// (sac, historique) a chaque changement de mode.
export function Jeu({ onEtat }) {
  const [filtre, setFiltre] = useState(undefined);   // undefined = pas encore choisi

  // souris4 : revenir au choix du mode avant de quitter la page Jouer.
  const { setRetour } = useContext(NavContext);
  useEffect(() => {
    setRetour(filtre !== undefined ? () => { setFiltre(undefined); return true; } : null);
    return () => setRetour(null);
  }, [filtre]);

  if (filtre === undefined) return <NouvellePartie onLancer={setFiltre} />;
  if (filtre && filtre.revision) return <Revision onChanger={() => setFiltre(undefined)} onEtat={onEtat} />;
  return (
    <Partie
      key={JSON.stringify(filtre)}
      filtre={filtre}
      onChanger={() => setFiltre(undefined)}
      onEtat={onEtat}
    />
  );
}

export function Partie({ filtre, onChanger, onEtat }) {
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
      if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;   // saisie (Ma note)
      if (document.querySelector('.boite-note')) return;
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
