// Decoupe d'App.jsx (etape 1 de Bristol) : code inchange, voir scripts/decouper-app.js.
import { useEffect, useState } from 'react';
import * as I from '../icones.jsx';
import { SUR_MOBILE } from '../commun/base.jsx';
import { LIBELLES_CHAMPS } from './Editeur.jsx';
import { nomModeleIA } from '../options/Sections.jsx';

// --- lecture du cartel -------------------------------------------------------

// Conservation : jamais proposee par l'analyse (un cartel ne dit pas ou l'oeuvre
// est conservee, ou alors dans un sens trompeur), mais on peut y mettre une ligne.
export const CHAMPS_CARTEL = ['titre', 'artiste', 'date', 'lieu', 'description', 'tags'];

// Ce que l'analyse (src/main/cartel-analyse.js) a reconnu dans chaque ligne.
// Role -> champ ou l'analyse range la ligne.
export const ROLE_CHAMP = { titre: 'titre', artiste: 'artiste', date: 'date', texte: 'description', technique: 'tags' };

export const ROLES_CARTEL = {
  artiste: 'artiste', titre: 'titre', date: 'date', texte: 'description', technique: 'tags',
  vie: 'dates de vie', provenance: 'provenance', numero: 'numéro', traduction: 'traduction',
  doublon: 'doublon', autre: ''
};

// Lignes choisies -> un texte : meme bloc = meme paragraphe.
export function joindreLignes(lignes) {
  let s = '';
  let bloc = null;
  for (const l of lignes) {
    const t = l.texte.trim();
    if (!s) s = t;
    else if (l.bloc !== bloc) s += '\n' + t;
    else if (/-$/.test(s)) s += t;
    else s += ' ' + t;
    bloc = l.bloc;
  }
  return s;
}

// Proposition de l'analyse, corrigeable : toucher des lignes puis un champ.
// Rien n'est ecrit avant « Valider » dans l'editeur.
export function BoiteCartel({ lecture, actuels, onRemplir, onRelire, onFermer, onClaude, iaEnCours }) {
  const [prop, setProp] = useState(() => ({ ...(lecture.proposition || {}) }));
  const [coches, setCoches] = useState(() => Object.fromEntries(CHAMPS_CARTEL.map((c) => {
    const v = (lecture.proposition || {})[c];
    return [c, !!v && !String(actuels[c] || '').trim()];   // un champ deja rempli n'est pas ecrase d'office
  })));
  const [sel, setSel] = useState([]);   // indices, dans l'ordre ou l'utilisateur les a touches
  // Champ -> lignes qui le composent, dans l'ordre. Au depart : ce que l'analyse
  // a reconnu ; chaque ligne n'appartient qu'a un champ.
  const [affect, setAffect] = useState(() => {
    const a = Object.fromEntries(CHAMPS_CARTEL.map((c) => [c, []]));
    lecture.lignes.forEach((l, i) => { const c = ROLE_CHAMP[l.role]; if (c) a[c].push(i); });
    return a;
  });
  useEffect(() => {
    const clavier = (e) => { if (e.key === 'Escape') onFermer(); };
    window.addEventListener('keydown', clavier);
    return () => window.removeEventListener('keydown', clavier);
  }, [onFermer]);

  if (lecture.erreur) {
    return (
      <div className="recouvrement" onClick={onFermer}>
        <div className="boite-dialogue" onClick={(e) => e.stopPropagation()}>
          <h3>Lecture du cartel</h3>
          <p>{lecture.erreur}</p>
          <div className="actions">
            <button className="bouton-neutre" onClick={onFermer}>Fermer</button>
            {onClaude && (
              <button className="bouton-neutre" onClick={onClaude} disabled={iaEnCours}>
                <I.Echange t={14} /> {iaEnCours ? 'Claude lit le cartel…' : 'Relire avec Claude'}
              </button>
            )}
            <button className="bouton-valide" onClick={onRelire}><I.Appareil t={14} /> {SUR_MOBILE ? 'Reprendre une photo' : 'Choisir une autre photo'}</button>
          </div>
        </div>
      </div>
    );
  }

  const basculer = (i) => setSel((x) => (x.includes(i) ? x.filter((k) => k !== i) : [...x, i]));
  // Retire les lignes choisies de leur champ, puis (champ donne) les y met dans
  // l'ordre de selection. Les champs touches sont recalcules depuis leurs lignes.
  const affecter = (champ) => {
    const a = Object.fromEntries(CHAMPS_CARTEL.map((c) => [c, affect[c].filter((i) => !sel.includes(i))]));
    if (champ) a[champ] = sel.slice();
    const touches = CHAMPS_CARTEL.filter((c) => c === champ || a[c].length !== affect[c].length);
    const valeurs = Object.fromEntries(touches.map((c) => [c, joindreLignes(a[c].map((i) => lecture.lignes[i]))]));
    setAffect(a);
    setProp((p) => ({ ...p, ...valeurs }));
    setCoches((x) => ({ ...x, ...Object.fromEntries(touches.map((c) => [c, !!valeurs[c]])) }));
    window.api.evt('edition', 'cartel-correction', { champ: champ || '(retire)', lignes: sel.length });
    setSel([]);
  };
  const choisis = CHAMPS_CARTEL.filter((c) => coches[c] && String(prop[c] || '').trim());
  const remplir = () => onRemplir(Object.fromEntries(choisis.map((c) => [c, prop[c]])));
  const etiquetteDe = (i, l) => {
    const c = CHAMPS_CARTEL.find((k) => affect[k].includes(i));
    return c ? LIBELLES_CHAMPS[c].toLowerCase() : ROLE_CHAMP[l.role] ? '' : ROLES_CARTEL[l.role] || '';
  };

  return (
    <div className="recouvrement" onClick={onFermer}>
      <div className="boite-dialogue boite-cartel" onClick={(e) => e.stopPropagation()}>
        <h3>Texte lu sur le cartel</h3>
        {lecture.ia && (
          <div className="cartel-ia">
            Lu par Claude ({nomModeleIA(lecture.modele)}) en {Math.round((lecture.ms || 0) / 100) / 10} s
            {' '}— {(lecture.cout * 100).toFixed(2).replace('.', ',')} centime(s) de dollar.
            {lecture.remplace && ' Modèle retiré, remplacé par ' + lecture.remplace.apres + '.'}
            {' '}Catégories prises dans les tiennes ; vérifie avant de remplir.
          </div>
        )}
        {lecture.erreurIA && <div className="options-note" style={{ color: 'var(--revoir)' }}>{lecture.erreurIA}</div>}

        <div className="cartel-propositions">
          {CHAMPS_CARTEL.map((c) => (
            <label key={c} className={'cartel-prop' + (prop[c] ? '' : ' vide')}>
              <input type="checkbox" checked={!!coches[c] && !!prop[c]} disabled={!prop[c]}
                onChange={(e) => setCoches((x) => ({ ...x, [c]: e.target.checked }))} />
              <span className="etiquette">{LIBELLES_CHAMPS[c]}</span>
              <span className="cartel-prop-valeur">
                {prop[c] || '—'}
                {prop[c] && String(actuels[c] || '').trim() && (
                  <em> — remplace « {String(actuels[c]).slice(0, 40)}{String(actuels[c]).length > 40 ? '…' : ''} »</em>
                )}
              </span>
            </label>
          ))}
        </div>

        <div className="options-note">
          Pour corriger : touche une ou plusieurs lignes (dans l’ordre voulu), puis le champ où les mettre, ou « Retirer ».
        </div>
        <div className="cartel-lignes">
          {lecture.lignes.map((l, i) => {
            const nouveauBloc = i > 0 && lecture.lignes[i - 1].bloc !== l.bloc;
            const eti = etiquetteDe(i, l);
            const rang = sel.indexOf(i);
            const range = CHAMPS_CARTEL.some((k) => affect[k].includes(i));
            return (
              <button key={i} className={'cartel-ligne role-' + (l.role || 'autre') + (range ? ' rangee' : '')
                + (rang >= 0 ? ' choisie' : '') + (nouveauBloc ? ' nouveau-bloc' : '')}
                onClick={() => basculer(i)}>
                {rang >= 0 && <span className="cartel-ligne-rang">{rang + 1}</span>}
                <span className="cartel-ligne-texte">{l.texte}</span>
                {eti && <span className="cartel-ligne-role">{eti}</span>}
              </button>
            );
          })}
        </div>

        {sel.length > 0 && (
          <div className="cartel-cibles">
            <span>Mettre {sel.length > 1 ? 'ces ' + sel.length + ' lignes' : 'cette ligne'} dans :</span>
            {CHAMPS_CARTEL.map((c) => (
              <button key={c} className="puce" onClick={() => affecter(c)}>{LIBELLES_CHAMPS[c]}</button>
            ))}
            {sel.some((i) => CHAMPS_CARTEL.some((k) => affect[k].includes(i))) && (
              <button className="puce puce-retirer" onClick={() => affecter(null)}><I.Croix t={11} /> Retirer du champ</button>
            )}
          </div>
        )}

        <div className="actions">
          <button className="bouton-neutre" onClick={onFermer}>Annuler</button>
          {onClaude && (
            <button className="bouton-neutre" onClick={onClaude} disabled={iaEnCours}
              title="Envoie cette photo à Claude (payant, environ 1 à 2 centimes) : meilleure lecture, catégories prises dans les tiennes">
              <I.Echange t={14} /> {iaEnCours ? 'Claude lit le cartel…' : 'Relire avec Claude'}
            </button>
          )}
          <button className="bouton-valide" onClick={remplir} disabled={!choisis.length}>
            <I.Coche t={14} /> {choisis.length ? 'Remplir ' + choisis.length + ' champ' + (choisis.length > 1 ? 's' : '') : 'Rien de coché'}
          </button>
        </div>
      </div>
    </div>
  );
}
