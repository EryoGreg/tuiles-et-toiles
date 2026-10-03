// Decoupe d'App.jsx (etape 1 de Bristol) : code inchange, voir scripts/decouper-app.js.
import { useEffect, useState } from 'react';
import * as I from '../icones.jsx';

/* ------------------------------------------------------------------- jeu */

export const MARQUES = [
  ['livre', I.Livre, 'livre'],
  ['etoile', I.Etoile, 'etoile'],
  ['bad_smiley', I.Revoir, 'revoir']
];

export function Tuile({
  tuile, revele, sur, onReveler,
  onSuivante, onPrecedente, onMarquer, peutRevenir,
  apercu = false, onFermer, onChanger,
  compteur, actions   // revision : texte a gauche et boutons a droite a la place des boutons de jeu
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
  // Police qui diminue avec la longueur : un titre long reste lisible d'une
  // traite (#399, #214) au lieu d'etre rogne par sa case.
  const long = (v, a, b) => {
    const n = v == null ? 0 : String(v).length;
    return n > b ? ' tres-long' : n > a ? ' long' : '';
  };
  // « a,b, c » -> « a, b, c » : des tags colles sans espace formaient un seul
  // mot insecable qui elargissait toute la tuile (#L3 sur mobile).
  const tags = (v) => (v == null ? v : String(v).split(/\s*,\s*/).filter(Boolean).join(', '));

  const Marques = ({ classe }) => (
    <div className={classe}>
      {MARQUES.map(([tag, Icone, cl]) => (
        <button
          key={tag}
          className={'marque ' + cl + (tuile.tagsUtilisateur.includes(tag) ? ' on' : '')}
          onClick={() => onMarquer(tag)}
          title={tag}
        >
          <Icone t={32} />
        </button>
      ))}
    </div>
  );

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
        <Marques classe="rail" />

        <div className="tuile">
          <div className="tete">
            <span className="numero">
              #{tuile.ref}
              {!apercu && (tuile.revision
                ? <span className="compteur-tete"> · {tuile.revision.nouvelle ? 'nouvelle' : 'à revoir'}</span>
                : <span className="compteur-tete"> · {tuile.restant} restantes</span>)}
            </span>
            <span className="tete-aide">
              {apercu
                ? 'Tuile complète — rien n’est masqué'
                : 'Clic sur une zone masquée pour la révéler'}
            </span>
            {/* Mobile : les marques passent dans l'en-tete (le rail y est masque). */}
            <Marques classe="marques-tete" />
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
                <div className="champ champ-titre">
                  <div className="etiquette">Titre</div>
                  <div className="valeur valeur-titre">
                    {voit('titre')
                      ? <div className={'texte-titre' + long(d.titre, 32, 64)}>{ou(d.titre)}</div>
                      : <Cache champ="titre" />}
                  </div>
                </div>

                <div className="champ">
                  <div className="etiquette">Artiste</div>
                  <div className="valeur">
                    {voit('artiste')
                      ? <div className={'texte-champ' + long(d.artiste, 28, 48)}>{ou(d.artiste)}</div>
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

                <div className="champ champ-lieu">
                  <div className="etiquette">Conservation</div>
                  <div className="valeur">
                    {voit('lieu')
                      ? <div className={'texte-champ' + long(d.lieu, 40, 70)}>{ou(d.lieu)}</div>
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

              <div className="champ champ-tags">
                <div className="etiquette">Tags</div>
                <div className="valeur">
                  {voit('tags')
                    ? <div className="texte-tags">{ou(tags(d.tags))}</div>
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
                  <I.Fleche t={16} retour /> <span className="libelle-bouton">Mode</span>
                </button>
              )}
              <span className="compteur-sac">{compteur != null ? compteur : tuile.restant + ' tuiles restantes dans le sac'}</span>
            </div>
            {actions ? <div className="actions-droite">{actions}</div> : (
            <div className="actions-droite">
              <button
                className="bouton-neutre"
                onClick={onPrecedente}
                disabled={!peutRevenir}
                style={peutRevenir ? undefined : { opacity: 0.35, cursor: 'default' }}
                title="Tuile précédente (flèche gauche)"
              >
                <I.Fleche t={18} retour /> <span className="libelle-bouton">Précédente</span>
              </button>
              <button className="bouton-valide" onClick={() => onReveler(null)}>
                <I.Coche /> Tout révéler
              </button>
              <button className="bouton-neutre" onClick={onSuivante}>
                Suivante <I.Fleche />
              </button>
            </div>
            )}
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
