'use strict';
/**
 * Pont entre le processus principal et le rendu.
 *
 * Seules les fonctions listees ici sont accessibles depuis l'interface.
 * Aucun acces a Node, au systeme de fichiers ni au jeton OAuth.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  etat: () => ipcRenderer.invoke('etat'),

  // Journal : trace des deplacements et actions cote rendu -> journal.log.
  log: (msg, extra) => ipcRenderer.send('journal', msg, extra),

  jeu: {
    tirer: (tagJeu) => ipcRenderer.invoke('jeu:tirer', tagJeu),
    reveler: (id) => ipcRenderer.invoke('jeu:reveler', id),
    apercu: (id) => ipcRenderer.invoke('jeu:apercu', id),
    categories: () => ipcRenderer.invoke('jeu:categories'),
    apercuCategories: (sel) => ipcRenderer.invoke('jeu:apercuCategories', sel)
  },

  oeuvres: {
    chercher: (criteres) => ipcRenderer.invoke('oeuvres:chercher', criteres),
    numero: (n) => ipcRenderer.invoke('oeuvres:numero', n),
    parTag: (tag, texte) => ipcRenderer.invoke('oeuvres:parTag', { tag, texte }),
    toutes: (criteres) => ipcRenderer.invoke('oeuvres:toutes', criteres)
  },

  tags: {
    basculer: (id, tag) => ipcRenderer.invoke('tags:basculer', { id, tag }),
    effacerTout: () => ipcRenderer.invoke('tags:effacerTout')
  },

  reglages: {
    definir: (cle, valeur) => ipcRenderer.invoke('reglages:definir', { cle, valeur })
  },

  edition: {
    creer: (champs) => ipcRenderer.invoke('edition:creer', champs),
    tuile: (id) => ipcRenderer.invoke('edition:tuile', id),
    modifier: (id, champs) => ipcRenderer.invoke('edition:modifier', { id, champs }),
    supprimer: (id) => ipcRenderer.invoke('edition:supprimer', id),
    choisirImage: () => ipcRenderer.invoke('edition:choisirImage'),
    importerImage: (octets) => ipcRenderer.invoke('edition:importerImage', octets),
    importerImageUrl: (url) => ipcRenderer.invoke('edition:importerImageUrl', url),
    oublierImage: (nom) => ipcRenderer.invoke('edition:oublierImage', nom)
  },

  sauvegarde: {
    exporter: () => ipcRenderer.invoke('sauvegarde:exporter'),
    choisir: () => ipcRenderer.invoke('sauvegarde:choisir'),
    importer: (chemin) => ipcRenderer.invoke('sauvegarde:importer', chemin)
  },

  drive: {
    etat: () => ipcRenderer.invoke('drive:etat'),
    connecter: () => ipcRenderer.invoke('drive:connecter'),
    deconnecter: () => ipcRenderer.invoke('drive:deconnecter'),
    pousser: (opts) => ipcRenderer.invoke('drive:pousser', opts),
    tirer: (opts) => ipcRenderer.invoke('drive:tirer', opts),
    // Session Google expiree pendant un envoi / une restauration : le
    // processus principal relance la connexion dans le navigateur.
    onReconnexion: (fn) => {
      const ecouteur = () => fn();
      ipcRenderer.on('drive:reconnexion', ecouteur);
      return () => ipcRenderer.removeListener('drive:reconnexion', ecouteur);
    }
  },

  maj: {
    verifier: () => ipcRenderer.invoke('maj:verifier'),
    telecharger: () => ipcRenderer.invoke('maj:telecharger'),
    installer: () => ipcRenderer.invoke('maj:installer'),
    onProgression: (fn) => {
      const ecouteur = (_e, p) => fn(p);
      ipcRenderer.on('maj:progression', ecouteur);
      return () => ipcRenderer.removeListener('maj:progression', ecouteur);
    }
  },

  raccourcis: {
    etat: () => ipcRenderer.invoke('raccourcis:etat'),
    perimes: () => ipcRenderer.invoke('raccourcis:perimes'),
    basculer: (type) => ipcRenderer.invoke('raccourcis:basculer', type),
    reparer: (types) => ipcRenderer.invoke('raccourcis:reparer', types)
  },

  themeSysteme: () => ipcRenderer.invoke('theme:systeme'),
  onThemeSysteme: (fn) => {
    const ecouteur = (_e, valeur) => fn(valeur);
    ipcRenderer.on('theme:systeme-change', ecouteur);
    return () => ipcRenderer.removeListener('theme:systeme-change', ecouteur);
  },
  // La croix de la fenetre demande la fermeture ; le rendu affiche le
  // dialogue de confirmation.
  onTenterFermeture: (fn) => {
    const ecouteur = () => fn();
    ipcRenderer.on('app:tenter-fermeture', ecouteur);
    return () => ipcRenderer.removeListener('app:tenter-fermeture', ecouteur);
  },
  // Boutons lateraux de la souris remontes par le processus principal
  // ('reculer' | 'avancer').
  onNav: (fn) => {
    const ecouteur = (_e, sens) => fn(sens);
    ipcRenderer.on('app:nav', ecouteur);
    return () => ipcRenderer.removeListener('app:nav', ecouteur);
  },
  quitter: () => ipcRenderer.invoke('app:quitter')
});
