// Appareil photo DANS l'appli (mobile) : apercu getUserMedia + declencheur.
//
// Pourquoi : l'appareil photo d'Android est une autre appli. Pendant la prise
// de vue, Tuiles & Toiles passe en arriere-plan et, sur un telephone a court
// de memoire, Android la ferme (rapport R261015122225-c91b : editeur ferme a
// chaque photo). Ici l'appli reste au premier plan : elle n'est pas fermee.
// Secours (permission refusee, pas de camera dans la WebView) : l'appareil
// photo du telephone (getPhoto + reprise du brouillon, voir Editeur.jsx).
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as I from '../icones.jsx';

export const APPAREIL_INTEGRE = typeof navigator !== 'undefined'
  && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

// Photo du flux. L'image de l'apercu d'abord : instantanee et fiable, et assez
// grande des 1 400 px (taille finale de l'import). ImageCapture seulement si
// l'apercu est plus petit (emulateur : 960x1280), plafonne a 2 560 px et borne
// dans le temps : sur de vrais telephones, takePhoto a la resolution du capteur
// (12 a 50 Mpx) peut ne jamais repondre -- le declencheur semblait mort -- et
// une telle photo decodee pese des centaines de Mo.
const COTE_SUFFISANT = 1400;
const COTE_MAX_CAPTURE = 2560;

function depuisApercu(video) {
  const c = document.createElement('canvas');
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  return new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.92));
}

const avecDelai = (p, ms, quoi) => Promise.race([
  p, new Promise((_, ko) => setTimeout(() => ko(new Error(quoi + ' : pas de reponse en ' + ms + ' ms')), ms))
]);

async function capturer(video, piste) {
  const apercu = video.videoWidth + 'x' + video.videoHeight;
  const cote = Math.max(video.videoWidth, video.videoHeight);
  if (cote >= COTE_SUFFISANT || typeof window.ImageCapture !== 'function' || !piste) {
    window.api.evt('image', 'appareil-integre-capture', { apercu, retenue: 'apercu' });
    return depuisApercu(video);
  }
  try {
    const ic = new window.ImageCapture(piste);
    const cap = await avecDelai(ic.getPhotoCapabilities(), 1500, 'getPhotoCapabilities').catch(() => null);
    let reglages;
    if (cap && cap.imageWidth && cap.imageWidth.max && cap.imageHeight && cap.imageHeight.max) {
      const k = Math.min(1, COTE_MAX_CAPTURE / Math.max(cap.imageWidth.max, cap.imageHeight.max));
      reglages = { imageWidth: Math.round(cap.imageWidth.max * k), imageHeight: Math.round(cap.imageHeight.max * k) };
    }
    const blob = await avecDelai(ic.takePhoto(reglages), 4000, 'takePhoto');
    const bmp = await createImageBitmap(blob);
    const grande = bmp.width * bmp.height >= video.videoWidth * video.videoHeight;
    window.api.evt('image', 'appareil-integre-capture', {
      photo: bmp.width + 'x' + bmp.height, apercu, retenue: grande ? 'photo' : 'apercu'
    });
    bmp.close();
    if (grande) return blob;
  } catch (e) { window.api.evt('image', 'appareil-integre-imagecapture', { apercu, message: String(e && e.message || e) }, 'WARN'); }
  return depuisApercu(video);
}

// onPhoto(blob) ; onSecours(raison) : passer a l'appareil photo du telephone.
export function BoiteAppareil({ titre, onPhoto, onSecours, onFermer }) {
  const video = useRef(null);
  const flux = useRef(null);
  const [etat, setEtat] = useState('ouverture');   // ouverture | pret | capture | { refus }
  useEffect(() => {
    let fini = false;
    const t0 = Date.now();
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1920 } },
      audio: false
    }).then((f) => {
      if (fini) { f.getTracks().forEach((p) => p.stop()); return; }
      flux.current = f;
      video.current.srcObject = f;
      const r = f.getVideoTracks()[0] && f.getVideoTracks()[0].getSettings();
      window.api.evt('image', 'appareil-integre-ouvert', { ms: Date.now() - t0, largeur: r && r.width, hauteur: r && r.height });
      setEtat('pret');
    }).catch((e) => {
      if (fini) return;
      const nom = e && e.name;
      window.api.evt('image', 'appareil-integre-echec', { nom, message: String(e && e.message || e) }, 'WARN');
      // Refus explicite : on le dit (l'utilisateur peut changer d'avis) ;
      // toute autre panne : appareil photo du telephone directement.
      if (nom === 'NotAllowedError' || nom === 'SecurityError') setEtat({ refus: true });
      else onSecours(nom || 'echec');
    });
    return () => {
      fini = true;
      if (flux.current) flux.current.getTracks().forEach((p) => p.stop());
    };
  }, []);

  useEffect(() => {
    const clavier = (e) => { if (e.key === 'Escape') onFermer(); };
    window.addEventListener('keydown', clavier);
    return () => window.removeEventListener('keydown', clavier);
  }, [onFermer]);

  const declencher = async () => {
    window.api.evt('image', 'appareil-integre-declencher', {
      etat: typeof etat === 'string' ? etat : 'refus',
      apercu: video.current ? video.current.videoWidth + 'x' + video.current.videoHeight : null
    });
    if (etat !== 'pret') return;
    setEtat('capture');
    const piste = flux.current && flux.current.getVideoTracks()[0];
    let blob = null;
    try { blob = await capturer(video.current, piste); }
    catch (e) { window.api.evt('image', 'appareil-integre-capture', { message: String(e && e.message || e) }, 'ERREUR'); }
    if (!blob) { setEtat('pret'); return; }
    window.api.evt('image', 'appareil-integre-photo', { octets: blob.size, type: blob.type });
    onPhoto(blob);
  };

  // Portail : hors de .jeu, dont les regles (grille) deformaient l'apercu.
  return createPortal(
    <div className="recouvrement appareil">
      <video ref={video} className="appareil-video" autoPlay playsInline muted />
      <div className="appareil-titre">{titre}</div>
      {etat === 'ouverture' && <div className="appareil-message">Ouverture de l’appareil photo…</div>}
      {etat && etat.refus && (
        <div className="appareil-message">
          L’appli n’a pas accès à l’appareil photo.
          <button className="bouton-neutre" onClick={() => onSecours('refus')}>Utiliser l’appareil photo du téléphone</button>
        </div>
      )}
      <div className="appareil-barre">
        <button className="appareil-annuler" onClick={onFermer} aria-label="Annuler"><I.Croix t={22} /></button>
        <button className="appareil-declencheur" onClick={declencher} disabled={etat !== 'pret'}
          aria-label="Prendre la photo">{etat === 'capture' ? '…' : ''}</button>
        <button className="appareil-secours" onClick={() => onSecours('choix')} title="Appareil photo du téléphone">
          <I.Appareil t={20} />
        </button>
      </div>
    </div>,
    document.body
  );
}
