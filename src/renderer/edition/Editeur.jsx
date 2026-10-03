// Decoupe d'App.jsx (etape 1 de Bristol) : code inchange, voir scripts/decouper-app.js.
import { useEffect, useState } from 'react';
import * as I from '../icones.jsx';
import { SUR_MOBILE, dateCourte, urlTuile } from '../commun/base.jsx';
import { BoiteCartel } from './Cartel.jsx';
import { PastilleConflit } from '../tuile/Cartes.jsx';

/* --------------------------------------------------------------- edition */

// Un champ texte de l'editeur, dans la meme case (.valeur) qu'en affichage.
export function ChampEdit({ etiquette, v, onChange, placeholder, serif, mono, grand }) {
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
export function pesee(o) {
  const ko = Math.round(o / 1024);
  return ko >= 1024 ? (ko / 1024).toFixed(1) + ' Mo' : ko + ' Ko';
}

export const CHAMPS_VIDES = { titre: '', artiste: '', date: '', lieu: '', description: '', tags: '', image: '' };

export function memeChamps(a, b) {
  return Object.keys(CHAMPS_VIDES).every((c) => (a[c] || '') === (b[c] || ''));
}

// Cextrait une URL d'image d'un depot venant d'une page web.
export function urlDepuisDrop(dt) {
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
export function EditeurTuile({ mode, tuile, onFini, onAnnuler, onSupprimer }) {
  const initial = mode === 'modifier'
    ? Object.fromEntries(Object.keys(CHAMPS_VIDES).map((c) => [c, tuile[c] || '']))
    : CHAMPS_VIDES;
  const imageInitiale = initial.image;

  const [champs, setChamps] = useState(initial);
  // Mes notes : a part des champs de la tuile (jamais au tirage, hors masques).
  const [note, setNote] = useState('');
  const [noteInitiale, setNoteInitiale] = useState('');
  useEffect(() => {
    if (mode !== 'modifier') return;
    window.api.notes.lire(tuile.id).then((r) => { setNote(r.texte || ''); setNoteInitiale(r.texte || ''); });
  }, [mode, tuile && tuile.id]);
  const [imgInfo, setImgInfo] = useState(null);
  const [imgErreur, setImgErreur] = useState(null);
  const [imgEnCours, setImgEnCours] = useState(false);
  const [survol, setSurvol] = useState(false);
  const [enCours, setEnCours] = useState(false);
  const [historique, setHistorique] = useState(null);   // null | 'chargement' | [{ champ, versions }]
  const [aVersions, setAVersions] = useState(false);
  // Lecture du cartel (mobile : ML Kit ; PC : Windows) : null | 'lecture' | { lignes, proposition } | { erreur }
  const [cartel, setCartel] = useState(null);
  const lireCartel = async (source) => {
    setCartel('lecture');
    let r;
    try { r = await window.api.edition.lireCartel(source); }
    catch (err) { r = { erreur: String(err && err.message || err) }; }
    setCartel(r && (r.erreur || (r.lignes && r.lignes.length)) ? r
      : r ? { erreur: 'Aucun texte trouvé sur la photo. Rapproche-toi du cartel, sans reflet.' } : null);
  };
  // Relire la meme photo avec Claude (cle API dans Options) : la boite reste
  // ouverte pendant la lecture, puis montre le resultat de Claude.
  const [iaPrete, setIaPrete] = useState(false);
  const [iaEnCours, setIaEnCours] = useState(false);
  useEffect(() => { window.api.ia.etat().then((e) => setIaPrete(!!e.configure)).catch(() => {}); }, []);
  const relireAvecClaude = async () => {
    setIaEnCours(true);
    let r;
    try { r = await window.api.edition.lireCartelIA(); }
    catch (err) { r = { erreur: String(err && err.message || err) }; }
    setIaEnCours(false);
    setCartel((avant) => (r && r.erreur && avant && avant.lignes ? { ...avant, erreurIA: r.erreur } : { ...r, cle: Date.now() }));
  };
  const remplirDepuisCartel = (valeurs) => {
    window.api.evt('edition', 'cartel-remplir', { champs: Object.keys(valeurs) });
    setChamps((x) => ({ ...x, ...valeurs }));
    setCartel(null);
  };

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

  const noteChangee = note.replace(/\s+$/, '') !== noteInitiale;
  const dirty = !memeChamps(champs, initial) || noteChangee;
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
  // Mobile : photo prise sur le moment (au musee), sans passer par la galerie.
  const photographier = async () => {
    if (imgEnCours || champs.image) return;
    setImgEnCours(true);
    try { poser(await window.api.edition.prendrePhoto()); }
    catch (err) { echecImage('appareil-photo', err); }
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
      let r;
      if (mode === 'modifier') {
        r = !memeChamps(champs, initial)
          ? await window.api.edition.modifier(tuile.id, champs)
          : { id: tuile.id, ref: tuile.ref };   // seule la note a change
      } else {
        r = await window.api.edition.creer(champs);
      }
      if (noteChangee && r && r.id && !r.erreur) await window.api.notes.ecrire(r.id, note);
      onFini(r);
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
            <span className="numero">
              {mode === 'modifier' ? '#' + tuile.ref : 'nouvelle tuile'}
              {mode === 'modifier' && tuile.conflit && <PastilleConflit />}
            </span>
            <span style={{ fontSize: 11.5, color: 'var(--discret)' }}>
              {mode === 'modifier' && tuile.conflit
                ? 'conflit de synchro : la version la plus récente est affichée, choisis dans « Conflits »'
                : teteInfo}
            </span>
          </div>

          <div className="corps">
            <div
              className={'cadre-image editeur-image' + (survol ? ' survol' : '')}
              onClick={SUR_MOBILE ? undefined : choisir}
              onDragOver={(e) => { e.preventDefault(); setSurvol(true); }}
              onDragLeave={() => setSurvol(false)}
              onDrop={deposer}
            >
              {champs.image ? (
                <>
                  <img className="visuel" src={urlTuile(champs.image)} alt="" />
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
                  <span>{imgEnCours ? 'import…' : SUR_MOBILE ? 'Image de la tuile' : 'Glisser une image ici ou cliquer'}</span>
                  {SUR_MOBILE && !imgEnCours && (
                    <span className="editeur-image-boutons">
                      <button className="bouton-valide" onClick={photographier}><I.Appareil t={16} /> Prendre une photo</button>
                      <button className="bouton-neutre" onClick={choisir}>Galerie</button>
                    </span>
                  )}
                  <span style={{ textTransform: 'none', letterSpacing: 0, opacity: 0.7 }}>
                    {imgErreur || (SUR_MOBILE ? 'appareil photo ou galerie · redimensionnée ≤ 500 Ko' : 'fichier ou image d’une page web · redimensionnée ≤ 500 Ko')}
                  </span>
                </div>
              )}
            </div>

            {SUR_MOBILE ? (
              <div className="cartel-boutons">
                <button className="bouton-neutre" onClick={() => lireCartel('camera')} disabled={cartel === 'lecture'}>
                  <I.Appareil t={15} /> {cartel === 'lecture' ? 'Lecture…' : 'Lire le cartel'}
                </button>
                <button className="bouton-neutre" onClick={() => lireCartel('galerie')} disabled={cartel === 'lecture'}>
                  Cartel depuis la galerie
                </button>
              </div>
            ) : (
              <div className="cartel-boutons">
                <button className="bouton-neutre" onClick={() => lireCartel('fichier')} disabled={cartel === 'lecture'}
                  title="Photo d’un cartel de musée : titre, artiste, date… proposés, à vérifier avant de valider">
                  <I.Appareil t={15} /> {cartel === 'lecture' ? 'Lecture…' : 'Lire un cartel (photo)…'}
                </button>
              </div>
            )}

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

              <div className="champ champ-description champ-note">
                <div className="etiquette"><I.Note t={12} /> Ma note — personnelle, jamais affichée au tirage</div>
                <textarea
                  className="editeur-textarea"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Un moyen mnémotechnique, une confusion à éviter, un lien avec une autre œuvre…"
                />
              </div>
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

      {cartel && cartel !== 'lecture' && (
        <BoiteCartel key={cartel.cle || (cartel.ia ? 'ia' : 'local')} lecture={cartel} actuels={champs} onRemplir={remplirDepuisCartel}
          onRelire={() => lireCartel(SUR_MOBILE ? 'camera' : 'fichier')} onFermer={() => setCartel(null)}
          onClaude={iaPrete && !cartel.ia ? relireAvecClaude : null} iaEnCours={iaEnCours} />
      )}
      {historique && (
        <BoiteVersions
          historique={historique} actuels={champs}
          onReprendre={reprendre} onFermer={() => setHistorique(null)}
        />
      )}
    </div>
  );
}

export const LIBELLES_CHAMPS = {
  titre: 'Titre', artiste: 'Artiste', date: 'Année / période', lieu: 'Conservation',
  description: 'Description', tags: 'Tags'
};

// Toutes les valeurs qu'ont eues les champs de la tuile, tous appareils
// confondus (journal de synchro). « Reprendre » remet la valeur dans
// l'editeur, sans rien enregistrer.
export function BoiteVersions({ historique, actuels, onReprendre, onFermer }) {
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
