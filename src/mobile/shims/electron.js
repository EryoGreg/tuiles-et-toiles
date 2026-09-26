'use strict';
/**
 * Faux module `electron` du mobile : juste ce qu'utilise src/main/preload.js.
 * Le vrai preload construit donc window.api a l'identique du PC ; ses appels
 * (invoke / send / on) arrivent ici et sont servis par la table des canaux
 * (src/mobile/canaux.js) dans la meme page : pas de second processus.
 */

const gestionnaires = new Map();   // canal -> fn(...args)
const ecouteurs = new Map();       // canal -> Set(fn)
let pret = Promise.resolve();
let apresAppel = null;             // (canal, resultat) -> resultat

/** Enregistre le gestionnaire d'un canal (equivalent de ipcMain.handle). */
function gerer(canal, fn) { gestionnaires.set(canal, fn); }
/** Envoie un evenement aux ecouteurs du rendu (equivalent de webContents.send). */
function emettre(canal, ...args) {
  for (const f of ecouteurs.get(canal) || []) { try { f({}, ...args); } catch (e) { console.error(e); } }
}
function configurer({ attendre, transformer }) {
  if (attendre) pret = attendre;
  if (transformer) apresAppel = transformer;
}

async function appeler(canal, args) {
  await pret;
  const fn = gestionnaires.get(canal);
  if (!fn) {
    console.warn('[mobile] canal non disponible :', canal);
    return { erreur: 'Indisponible sur mobile.' };
  }
  const r = await fn(...args);
  return apresAppel ? apresAppel(canal, r) : r;
}

const ipcRenderer = {
  invoke: (canal, ...args) => appeler(canal, args),
  send: (canal, ...args) => { appeler(canal, args).catch(() => {}); },
  on: (canal, fn) => { if (!ecouteurs.has(canal)) ecouteurs.set(canal, new Set()); ecouteurs.get(canal).add(fn); },
  removeListener: (canal, fn) => { const s = ecouteurs.get(canal); if (s) s.delete(fn); }
};

const contextBridge = {
  exposeInMainWorld: (nom, objet) => { window[nom] = objet; }
};

module.exports = { ipcRenderer, contextBridge, gerer, emettre, configurer };
