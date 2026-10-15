'use strict';
/**
 * Appareil photo qui survit a la mort de l'appli.
 *
 * Sur un telephone a court de memoire, Android tue l'appli pendant que
 * l'appareil photo est ouvert : au retour, la page repart de zero (rapport
 * R261015122225-c91b, Honor RKY-LX1 : une nouvelle session 20 s apres chaque
 * « Prendre une photo », editeur ferme, photo perdue).
 *
 * - Camera.getPhoto (ancien flux du module) : Capacitor garde l'appel en
 *   cours dans l'etat sauvegarde de l'activite, et livre son resultat au
 *   redemarrage par l'evenement `appRestoredResult`. Camera.takePhoto (flux
 *   recent) tient l'appel en memoire seulement : photo perdue.
 * - Le rendu range son brouillon avant d'ouvrir l'appareil photo
 *   (commun/brouillon.js) et, au redemarrage, rouvre l'editeur puis demande
 *   la photo restauree ici (`reprise()`).
 */

const journal = require('../main/journal');

let restauree = null;   // { path, webPath, le } livree au redemarrage

function natif() {
  const C = typeof window !== 'undefined' && window.Capacitor;
  return !!(C && C.isNativePlatform && C.isNativePlatform());
}

/** A appeler au demarrage, avant l'interface : l'evenement est garde jusqu'a l'ecoute. */
function ecouter() {
  if (!natif()) return;
  require('@capacitor/app').App.addListener('appRestoredResult', (ev) => {
    const d = ev && ev.data;
    journal.evt('image', 'photo-restauree', {
      module: ev && ev.pluginId, methode: ev && ev.methodName, ok: !!(ev && ev.success),
      chemin: !!(d && (d.path || d.webPath)), erreur: ev && ev.error && ev.error.message
    });
    if (!ev || ev.pluginId !== 'Camera' || !ev.success || !d || !(d.path || d.webPath)) return;
    restauree = { path: d.path, webPath: d.webPath, le: Date.now() };
  });
}

/**
 * Photo prise sur le moment.
 * @returns {Promise<{ path?: string, webPath?: string } | null>} null si annulee
 */
async function prendre() {
  const { Camera } = require('@capacitor/camera');
  try {
    return await Camera.getPhoto({
      source: 'CAMERA', resultType: 'uri', quality: 90, correctOrientation: true, saveToGallery: false
    });
  } catch (e) {
    if (/cancel|annul|no image|no picture/i.test(String(e && e.message))) return null;   // l'utilisateur a renonce
    throw e;
  }
}

/** Photo livree au redemarrage (une seule fois), ou null. */
function reprise() {
  const r = restauree;
  restauree = null;
  return r;
}

/** Adresse lisible par la page (fetch) d'un resultat de prendre() / reprise(). */
function adresse(m) {
  if (!m) return null;
  const C = window.Capacitor;
  return m.webPath || (m.path && C && C.convertFileSrc ? C.convertFileSrc(m.path) : null);
}

module.exports = { ecouter, prendre, reprise, adresse };
