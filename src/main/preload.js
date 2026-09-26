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
  // Journal structure : domaine, evenement, details, niveau (DEBUG/INFO/WARN/ERREUR).
  evt: (domaine, quoi, donnees, niveau) => ipcRenderer.send('journal:evt', domaine, quoi, donnees, niveau),

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
    versions: (id) => ipcRenderer.invoke('edition:versions', id),
    journal: (opts) => ipcRenderer.invoke('edition:journal', opts),
    choisirImage: () => ipcRenderer.invoke('edition:choisirImage'),
    importerImage: (octets, meta) => ipcRenderer.invoke('edition:importerImage', octets, meta),
    importerImageUrl: (url) => ipcRenderer.invoke('edition:importerImageUrl', url),
    oublierImage: (nom) => ipcRenderer.invoke('edition:oublierImage', nom)
  },

  annuler: {
    annuler: () => ipcRenderer.invoke('annuler:annuler'),
    retablir: () => ipcRenderer.invoke('annuler:retablir'),
    etat: () => ipcRenderer.invoke('annuler:etat')
  },

  corbeille: {
    liste: () => ipcRenderer.invoke('corbeille:liste'),
    restaurer: (id) => ipcRenderer.invoke('corbeille:restaurer', id)
  },

  sauvegarde: {
    exporter: () => ipcRenderer.invoke('sauvegarde:exporter'),
    choisir: () => ipcRenderer.invoke('sauvegarde:choisir'),
    importer: (chemin) => ipcRenderer.invoke('sauvegarde:importer', chemin)
  },

  copieSecurite: {
    etat: () => ipcRenderer.invoke('copie:etat'),
    ouvrir: () => ipcRenderer.invoke('copie:ouvrir')
  },

  drive: {
    etat: () => ipcRenderer.invoke('drive:etat'),
    connecter: () => ipcRenderer.invoke('drive:connecter'),
    deconnecter: () => ipcRenderer.invoke('drive:deconnecter')
  },

  appareils: {
    liste: () => ipcRenderer.invoke('appareils:liste'),
    retirer: (id, retirer = true) => ipcRenderer.invoke('appareils:retirer', { id, retirer })
  },

  synchro: {
    etat: () => ipcRenderer.invoke('synchro:etat'),
    choisirDossier: () => ipcRenderer.invoke('synchro:choisirDossier'),
    oublier: () => ipcRenderer.invoke('synchro:oublier'),
    synchroniser: () => ipcRenderer.invoke('synchro:synchroniser'),
    drive: () => ipcRenderer.invoke('synchro:drive'),
    // Progression de la synchro en cours : { enCours, par, cycle, etape,
    // libelle, faits, total, debut, resultat } — a chaque etape et a la fin.
    onProgression: (fn) => {
      const ecouteur = (_e, p) => fn(p);
      ipcRenderer.on('synchro:progression', ecouteur);
      return () => ipcRenderer.removeListener('synchro:progression', ecouteur);
    }
  },

  conflits: {
    liste: () => ipcRenderer.invoke('conflits:liste'),
    trancher: (id, choix) => ipcRenderer.invoke('conflits:trancher', { id, choix }),
    actualiser: () => ipcRenderer.invoke('conflits:actualiser')
  },

  rapport: {
    choix: () => ipcRenderer.invoke('rapport:choix'),
    apercu: (formulaire) => ipcRenderer.invoke('rapport:apercu', formulaire),
    envoyer: (formulaire) => ipcRenderer.invoke('rapport:envoyer', formulaire),
    copier: (formulaire) => ipcRenderer.invoke('rapport:copier', formulaire)
  },

  maj: {
    verifier: () => ipcRenderer.invoke('maj:verifier'),
    telecharger: (opts) => ipcRenderer.invoke('maj:telecharger', opts),
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
