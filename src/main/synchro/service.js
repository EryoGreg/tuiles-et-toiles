'use strict';
/**
 * Synchro ligne a ligne de l'appareil courant, par un dossier partage (E2c)
 * ou par Google Drive (E2d). Meme cœur, meme arborescence « Tuiles et
 * Toiles/ » (format.js) ; seul le transport change.
 *
 * Une synchro = un cycle (cycle.js) : fiche d'appareil, rattrapage par
 * snapshot si besoin, envoi des images puis des ops, reception des ops puis
 * des images, snapshot et purge (compaction.js), puis reconstruction de la
 * vue si quelque chose a change.
 *
 * Toujours optionnelle et non bloquante (regle 1) : dossier absent, pas de
 * reseau, compte deconnecte = message, rien d'autre ne change.
 */

const fs = require('fs');
const path = require('path');
const db = require('../db');
const jeu = require('../jeu');
const edition = require('../edition');
const drive = require('../drive');
const etat = require('./etat');
const cycle = require('./cycle');
const moteur = require('./moteur');
const erreurs = require('./erreurs');
const compaction = require('./compaction');
const appareilFichier = require('./appareil');
const { nomValide } = require('./noms');
const { NOM_RACINE } = require('./format');
const { creerTransportDossier } = require('./transport-dossier');
const { creerTransportDrive } = require('./transport-drive');
const journal = require('../journal');

const SOUS_DOSSIER = NOM_RACINE;

// Dossier local tenu par Google Drive pour ordinateur (« G:\Mon Drive\… ») :
// les fichiers qu'y depose le client Drive ne sont PAS visibles de l'app via
// l'API Drive (scope drive.file = fichiers crees par l'app). Un telephone
// synchronise par l'API ne les verrait jamais -> on previent.
const RE_MIROIR_DRIVE = /(^|[\\/])(Mon Drive|My Drive|Google Drive|Drive partagés|Shared drives)([\\/]|$)/i;

let cfg = null;
let enCours = false;

// Synchro rapide (Drive, synchro automatique) : une requete au fil des
// changements suffit quand rien n'a bouge. Une synchro complete est forcee au
// moins toutes les 6 h, et apres tout ce qui pourrait avoir echappe au fil.
const COMPLETE_MAX_MS = 6 * 3600e3;

/** La prochaine synchro Drive sera complete (renommage, retrait, remplacement…). */
function demanderComplete(raison) {
  db.definirEtatSync('synchro_complete', JSON.stringify({ raison, le: new Date().toISOString() }));
}

// Progression de la synchro en cours, diffusee a l'interface (surProgression)
// et relue par toute page qui s'ouvre (etatSynchro) : l'utilisateur voit en
// permanence ce qui se passe, meme s'il change d'onglet.
let progression = { enCours: false };
let nCycles = 0;
const LIBELLES_ETAPES = {
  depart: 'Démarrage…',
  rapide: 'Vérification des nouveautés',
  preparer: 'Préparation du dossier de synchro',
  rejoindre: 'Inscription de cet appareil',
  rattrapage: 'Rattrapage depuis un snapshot',
  tombes: 'Nettoyage des tuiles supprimées',
  stats: 'Compteurs de vues',
  'images-envoi': 'Envoi des images',
  pousser: 'Envoi des modifications',
  tirer: 'Réception des modifications',
  'images-reception': 'Réception des images',
  snapshot: 'Écriture d’un snapshot',
  purge: 'Ménage des anciens journaux',
  fiche: 'Mise à jour de la fiche de l’appareil',
  vue: 'Mise à jour de l’affichage',
  reconnexion: 'Session Google expirée — autorise de nouveau l’accès dans le navigateur…',
  reprise: 'Reconnecté à Google — reprise de la synchro'
};

function signaler(p) {
  progression = { ...progression, ...p, maj: Date.now() };
  if (p.etape && !p.libelle) progression.libelle = LIBELLES_ETAPES[p.etape] || p.etape;
  if (cfg && cfg.surProgression) { try { cfg.surProgression(progression); } catch { /* fenetre fermee */ } }
}

/** @param {{ dossierUser, imagesLocales, surProgression? }} c */
function configurer(c) { cfg = c; }

function racine(dossier) {
  return path.basename(dossier) === SOUS_DOSSIER ? dossier : path.join(dossier, SOUS_DOSSIER);
}

function avertissement(dossier) {
  return dossier && RE_MIROIR_DRIVE.test(dossier)
    ? 'Ce dossier semble être ton Google Drive sur l’ordinateur. Ça marche entre ordinateurs, '
      + 'mais un téléphone connecté à Google Drive ne verra pas ces fichiers : pour Drive, '
      + 'préfère « Synchroniser » dans la section Google Drive.'
    : null;
}

function sauverAppareil() {
  appareilFichier.sauver(cfg.dossierUser, etat.appareil());
}

function lire(cle) {
  try { return JSON.parse(db.etatSync(cle) || 'null'); } catch { return null; }
}

/** Decision « cet appareil en remplace-t-il un autre ? » en attente (rejoindre.js). */
function decisionEnAttente() {
  const d = lire('decision_requise');
  return d && Array.isArray(d.candidats) && etat.appareil().remplace === undefined ? d : null;
}

/**
 * Session Google refusee (jeton mort), en synchro auto OU manuelle : etat garde
 * (`sync.drive_pause_auto` = date) jusqu'a une connexion ou une synchro Drive
 * reussie. Options l'affiche a la place de « Connecte » ; la synchro auto Drive
 * attend (jamais de navigateur sans clic).
 */
function noterSession(r) {
  if (!r || r.decisionRequise) return;
  const avant = db.etatSync('drive_pause_auto');
  if (r.typeErreur === 'session' || r.jetonMort) {
    if (!avant) {
      db.definirEtatSync('drive_pause_auto', new Date().toISOString());
      journal.avertir('synchro', 'session-expiree', { auto: !!r.auto, detail: r.detail || r.erreur || null });
    }
  } else if (!r.erreur && avant) {
    sessionRetablie();
  }
}

/** Connexion Google refaite ou synchro reussie : la session expiree est oubliee. */
function sessionRetablie() {
  if (!db.etatSync('drive_pause_auto')) return;
  db.definirEtatSync('drive_pause_auto', '');
  journal.evt('synchro', 'session-retablie');
}

function sessionExpiree() { return db.etatSync('drive_pause_auto') || null; }

function etatSynchro() {
  const a = etat.appareil();
  return {
    dossier: a.dossier_synchro || null,
    appareil: { id: a.id, nom: a.nom, type: a.type || null, prefixe: a.prefixe_ref, inscrit: !!a.inscrit },
    decision: decisionEnAttente(),
    sessionExpiree: sessionExpiree(),
    // Dernier echec (type + phrase courte), efface a la synchro reussie suivante.
    echec: lire('synchro_echec'),
    derniere: lire('dossier_derniere'),
    derniereDrive: lire('drive_fusion_derniere'),
    progression,
    conflits: etat.conflits().length,
    avertissement: avertissement(a.dossier_synchro),
    enCours
  };
}

async function definirDossier(dossier) {
  if (!dossier || !fs.existsSync(dossier)) return { erreur: 'Dossier introuvable.' };
  try {
    fs.mkdirSync(racine(dossier), { recursive: true });
    const essai = path.join(racine(dossier), '.essai-' + process.pid);
    fs.writeFileSync(essai, '');
    fs.rmSync(essai);
  } catch (e) {
    journal.erreur('synchro', 'dossier-non-inscriptible', e, { dossier, dossierTexte: journal.decrireTexte(dossier) });
    return { erreur: 'Impossible d’écrire dans ce dossier : ' + e.message };
  }
  journal.evt('synchro', 'dossier-choisi', {
    dossier, dossierTexte: journal.decrireTexte(dossier), miroirDrive: !!avertissement(dossier)
  });
  await creerTransportDossier(racine(dossier)).preparer(etat.appareil().id);
  etat.appareil().dossier_synchro = dossier;
  sauverAppareil();
  return etatSynchro();
}

function oublierDossier() {
  delete etat.appareil().dossier_synchro;
  sauverAppareil();
  return etatSynchro();
}

/**
 * Images dans un sens. Une image en echec est journalisee et ne bloque pas
 * la synchro : elle sera retentee a la suivante.
 */
async function transfererImages(t, sens) {
  let n = 0;
  const faites = [], manquantes = [], echecs = [], invalides = [];
  const toutes = [...edition.imagesReferencees()];
  let i = 0;
  for (const nom of toutes) {
    i++;
    if (toutes.length > 3) signaler({ faits: i, total: toutes.length });
    if (!t.imageValide(nom)) { invalides.push(nom); continue; }
    const local = path.join(cfg.imagesLocales, nom);
    try {
      if (sens === 'envoi') {
        if (!fs.existsSync(local)) { manquantes.push(nom); continue; }
        if (await t.envoyerImage(nom, local)) { n++; faites.push({ nom, octets: fs.statSync(local).size }); }
      } else if (!fs.existsSync(local)) {
        if (await t.recupererImage(nom, local)) { n++; faites.push({ nom, octets: fs.statSync(local).size }); }
        else manquantes.push(nom);
      }
    } catch (e) {
      if (e && e.jetonMort) throw e;
      echecs.push({ nom, erreur: e.message });
      journal.erreur('synchro', 'image-' + sens, e, { nom });
    }
  }
  // A reprendre a la prochaine synchro complete : un echec de transfert,
  // toujours ; une image annoncee mais pas encore sur le Drive, pendant 24 h
  // (au-dela, son appareil d'origine l'a sans doute perdue : inutile de forcer
  // une synchro complete a chaque fois).
  if (sens === 'reception') {
    if (manquantes.length) {
      if (!db.etatSync('images_manquantes_depuis')) db.definirEtatSync('images_manquantes_depuis', new Date().toISOString());
    } else db.definirEtatSync('images_manquantes_depuis', '');
  }
  const depuis = Date.parse(db.etatSync('images_manquantes_depuis') || '') || 0;
  if (echecs.length || (sens === 'reception' && manquantes.length && Date.now() - depuis < 24 * 3600e3)) {
    db.definirEtatSync('images_a_reprendre', JSON.stringify({ sens, echecs: echecs.length, manquantes: manquantes.length }));
  }
  const niveau = echecs.length ? 'WARN' : 'INFO';
  journal.evt('synchro', 'images-' + sens, {
    transferees: faites, manquantes: manquantes.length ? manquantes : undefined,
    echecs: echecs.length ? echecs : undefined, nomsInvalides: invalides.length ? invalides : undefined
  }, niveau);
  return n;
}

/**
 * Cœur commun : un cycle complet (cycle.js) avec les images et le journal.
 * Leve en cas d'echec (le jeton Drive mort doit remonter) ; l'etape en cours
 * est ajoutee au message et journalisee.
 */
async function coeur(t, sorte) {
  const a = etat.appareil();
  db.definirEtatSync('images_a_reprendre', '');
  fs.mkdirSync(cfg.imagesLocales, { recursive: true });
  const ctx = etat.contexte();
  const t0 = Date.now();
  let etape = 'depart';
  const pas = async (nom, fn) => {
    etape = nom;
    signaler({ etape: nom, libelle: null, faits: null, total: null });
    const t1 = Date.now();
    const r = await fn();
    journal.debug('synchro', 'etape:' + nom, { ms: Date.now() - t1 });
    return r;
  };
  journal.evt('synchro', 'debut', {
    par: sorte, appareil: a.id, nom: a.nom, prefixe: a.prefixe_ref,
    racine: t.racine || (sorte === 'drive' ? 'Google Drive/' + SOUS_DOSSIER : undefined),
    aPousser: ctx.d.prepare('SELECT COUNT(*) n FROM changements WHERE pousse=0').get().n,
    curseurs: ctx.d.prepare("SELECT cle, valeur FROM sync WHERE cle LIKE 'curseur:%'").all()
  });

  try {
    const c = await cycle.executer(ctx, t, {
      nom: a.nom, type: a.type, materiel: a.materiel, exigerDecision: true,
      enregistrerPrefixe: () => sauverAppareil(), enregistrerAppareil: () => sauverAppareil(), pas,
      crochets: {
        imagesEnvoi: () => transfererImages(t, 'envoi'),
        imagesReception: () => transfererImages(t, 'reception')
      }
    });
    const rj = c.rejoindre;
    const r = c.tire;
    // Noms des appareils, pour l'ecran des conflits (« modifie sur Telephone »).
    db.definirEtatSync('appareils_connus', JSON.stringify(rj.appareils || []));
    db.definirEtatSync('decision_requise', '');
    journal.evt('synchro', 'appareils', {
      premiereFois: rj.premiereFois, prefixe: rj.prefixe, renumerotees: rj.renumerotees, appareils: rj.appareils,
      remplacement: rj.remplacement || undefined, supplante: rj.supplante || undefined
    }, rj.supplante ? 'WARN' : 'INFO');
    if (c.rattrapage) {
      journal.evt('synchro', 'rattrapage', c.rattrapage, c.rattrapage.manque ? 'ERREUR' : 'INFO');
    }
    if (c.tombes.length) journal.evt('synchro', 'tuiles-oubliees', { cles: c.tombes, raison: 'supprimees depuis plus de 90 jours' });
    journal.evt('synchro', 'pousse', { ops: c.pousse.poussees, segment: c.pousse.segment, stats: c.stats });
    journal.evt('synchro', 'tire', {
      appliquees: r.appliquees, bilan: r.bilan, parAppareil: r.parAppareil, conflits: r.conflits
    }, r.rejetees ? 'WARN' : 'INFO');
    if (r.rejetees) journal.avertir('synchro', 'ops-rejetees', { n: r.rejetees, exemples: r.exemplesRejetes });
    if (c.snapshot) journal.evt('synchro', 'snapshot-ecrit', { nom: c.snapshot.nom, tetes: c.snapshot.ops, nouvelles: c.snapshot.nouvelles, vecteur: c.snapshot.vecteur });
    journal.evt('synchro', 'purge-segments', c.purge, c.purge.supprimes.length ? 'INFO' : 'DEBUG');

    const change = r.appliquees || rj.renumerotees.length || c.imagesRecues || c.tombes.length
      || (c.rattrapage && c.rattrapage.bilan && c.rattrapage.bilan.avance);
    if (change) await pas('vue', () => { db.reconstruireVue({ force: true }); jeu.reinitialiserSac(); });
    const ouverts = etat.conflits();
    if (ouverts.length) {
      journal.avertir('synchro', 'conflits-ouverts', ouverts.map((x) => ({
        entite: x.entite, cle: x.cle, champ: x.champ, gagnant: x.hlc_gagnant, perdant: x.hlc_perdant
      })));
    }
    const bilan = {
      le: new Date().toISOString(),
      poussees: c.pousse.poussees, appliquees: r.appliquees, rejetees: r.rejetees, conflits: r.conflits,
      envoye: c.pousse.resume || null, recu: r.resume || null,
      imagesEnvoyees: c.imagesEnvoyees, imagesRecues: c.imagesRecues,
      prefixe: rj.prefixe, premiereFois: rj.premiereFois, renumerotees: rj.renumerotees,
      remplacement: rj.remplacement || null, supplante: rj.supplante || null, nom: a.nom,
      rattrapage: c.rattrapage ? (c.rattrapage.snapshot || 'impossible') : null,
      snapshot: c.snapshot ? c.snapshot.nom : null, segmentsPurges: c.purge.supprimes.length,
      tuilesOubliees: c.tombes.length, change: !!change
    };
    journal.evt('synchro', 'fin', { par: sorte, ...bilan, ms: Date.now() - t0 });
    return bilan;
  } catch (e) {
    if (e && e.decisionRequise) {
      // Appareil neuf, d'autres existent deja : rien n'est ecrit tant que
      // l'utilisateur n'a pas dit s'il en remplace un (Options).
      db.definirEtatSync('decision_requise', JSON.stringify({ candidats: e.candidats, le: new Date().toISOString(), par: sorte }));
      journal.evt('synchro', 'decision-requise', { par: sorte, candidats: e.candidats }, 'WARN');
      return { erreur: e.message, decisionRequise: true, candidats: e.candidats };
    }
    journal.erreur('synchro', 'echec', e, { par: sorte, etape, ms: Date.now() - t0, jetonMort: !!e.jetonMort });
    if (!e.jetonMort) e.message = '[' + etape + '] ' + e.message;
    throw e;
  }
}

async function exclusif(par, fn, auto = false) {
  if (enCours) return { erreur: 'Une synchro est déjà en cours.', enCoursPar: progression.par, cycle: progression.cycle };
  enCours = true;
  const cycle = ++nCycles;
  signaler({ enCours: true, par, auto, cycle, debut: Date.now(), etape: 'depart', libelle: null, faits: null, total: null, resultat: null });
  let r;
  try { r = await fn(); }
  catch (e) { r = { erreur: e.message, jetonMort: !!(e && e.jetonMort) }; }
  finally { enCours = false; }
  r = { ...r, cycle, auto };
  // Echec : type + phrase courte pour l'utilisateur, detail au journal.
  if (r.erreur && !r.decisionRequise) {
    const c = erreurs.classer(r);
    journal.evt('synchro', 'echec-signale', { par, auto, type: c.type, detail: r.erreur }, c.type === 'reseau' ? 'INFO' : 'WARN');
    r = { ...r, detail: r.erreur, erreur: c.message, typeErreur: c.type };
    db.definirEtatSync('synchro_echec', JSON.stringify({ type: c.type, libelle: c.libelle, par, auto, le: new Date().toISOString() }));
  } else if (!r.erreur) {
    db.definirEtatSync('synchro_echec', '');
  }
  signaler({ enCours: false, etape: 'fin', libelle: r.erreur ? 'Échec' : 'Terminé', faits: null, total: null, resultat: r });
  return r;
}

/**
 * Synchro par le dossier partage choisi dans Options.
 * @param {{ auto?: boolean }} o  auto : lancee par synchro/auto.js (le rendu
 *   ne recharge pas la page, il propose d'actualiser)
 */
function synchroniser({ auto = false } = {}) {
  const a = etat.appareil();
  const echec = (detail) => {
    const c = erreurs.classer(detail);
    db.definirEtatSync('synchro_echec', JSON.stringify({ type: c.type, libelle: c.libelle, par: 'dossier', auto, le: new Date().toISOString() }));
    return Promise.resolve({ erreur: c.message, typeErreur: c.type, detail, auto });
  };
  if (!a.dossier_synchro) return echec('Aucun dossier de synchro choisi.');
  if (!fs.existsSync(a.dossier_synchro)) {
    journal.avertir('synchro', 'dossier-introuvable', { dossier: a.dossier_synchro });
    return echec('Dossier de synchro introuvable (clé USB débranchée, lecteur réseau absent ?).');
  }
  return exclusif('dossier', async () => {
    try {
      const bilan = await coeur(creerTransportDossier(racine(a.dossier_synchro)), 'dossier');
      db.definirEtatSync('dossier_derniere', JSON.stringify(bilan));
      return bilan;
    } catch (e) {
      return { erreur: e.message };
    }
  }, auto);
}

/**
 * Synchro par Google Drive (compte connecte dans Options). Session Google
 * expiree : reconnexion dans le navigateur puis nouvel essai (drive.js).
 * @param {() => void} [surReconnexion] previent l'interface
 * @param {object} [apiTest] api Drive de substitution (tests : faux Drive)
 * @param {{ auto?: boolean }} [o]  auto : pas de reconnexion (jamais de
 *   navigateur ouvert sans clic) -> { erreur, jetonMort }
 */
function synchroniserDrive(surReconnexion, apiTest, { auto = false } = {}) {
  return synchroniserDrive0(surReconnexion, apiTest, auto).then((r) => { noterSession(r); return r; });
}

function synchroniserDrive0(surReconnexion, apiTest, auto) {
  return exclusif('drive', async () => {
    const op = async (oauth) => {
      const api = apiTest || drive.api(oauth);
      const cle = cleCompte(apiTest);
      if (auto) {
        const rapide = await essaiRapide(api, cle);
        if (rapide) return rapide;
      }
      const t = creerTransportDrive(api, { cleCache: cle });
      // Jeton du fil pris AVANT : rien de ce que les autres ecrivent pendant
      // cette synchro ne peut echapper a la suivante.
      let jeton0 = null;
      if (api.jetonChangements) {
        try { jeton0 = await api.jetonChangements(); }
        catch (e) { if (e && e.jetonMort) throw e; journal.avertir('synchro', 'fil-jeton-echec', { erreur: e.message }); }
      }
      let bilan;
      try { bilan = await coeur(t, 'drive'); }
      catch (e) { t.oublierDossiers(); throw e; }
      if (bilan.decisionRequise) return bilan;
      await noterFil(api, t, jeton0, cle);
      db.definirEtatSync('drive_fusion_derniere', JSON.stringify(bilan));
      return bilan;
    };
    if (apiTest) {
      try { return await op(null); } catch (e) { return { erreur: e.message, jetonMort: !!e.jetonMort }; }
    }
    return drive.avecReconnexion(op,
      () => { signaler({ etape: 'reconnexion' }); if (surReconnexion) surReconnexion(); },
      () => signaler({ etape: 'reprise' }),
      { sansReconnexion: auto });
  }, auto);
}

/** Cle du compte Drive (caches et jeton du fil ne passent pas d'un compte a l'autre). */
function cleCompte(apiTest) {
  if (apiTest) return apiTest;
  const e = drive.etat();
  return 'drive:' + ((e && e.email) || 'compte');
}

/**
 * Apres une synchro complete : fil des changements depuis jeton0, sans nos
 * propres ecritures. Ce qui reste a ete ecrit par un autre appareil PENDANT
 * cette synchro (peut-etre apres notre lecture) -> la suivante sera complete.
 */
async function noterFil(api, t, jeton0, cle) {
  if (!jeton0 || !api.changements) { db.definirEtatSync('drive_fil', ''); return; }
  try {
    const L = await api.changements(jeton0);
    const etrangers = L.changes.filter((c) => !t.ecrits.has(c.fileId));
    if (etrangers.some((c) => c.dossier || c.removed || c.trashed)) t.oublierDossiers();
    db.definirEtatSync('drive_fil', JSON.stringify({
      jeton: L.nouveauJeton, complet_le: new Date().toISOString(), relire: etrangers.length > 0,
      cle: typeof cle === 'string' ? cle : 'test'
    }));
    db.definirEtatSync('synchro_complete', '');
    journal.debug('synchro', 'fil-note', { changements: L.changes.length, etrangers: etrangers.length });
  } catch (e) {
    if (e && e.jetonMort) throw e;
    db.definirEtatSync('drive_fil', '');
    journal.avertir('synchro', 'fil-echec', { erreur: e.message });
  }
}

/**
 * Synchro automatique sans rien a envoyer : le fil des changements dit si un
 * autre appareil a ecrit quelque chose. Rien -> fin (une requete, ~0,3 s au
 * lieu de ~20 et ~10 s). Le moindre doute -> null (synchro complete).
 */
async function essaiRapide(api, cle) {
  const a = etat.appareil();
  const fil = lire('drive_fil');
  const raison = !a.inscrit ? 'pas inscrit'
    : decisionEnAttente() ? 'decision en attente'
    : !fil || !fil.jeton ? 'pas de jeton'
    : fil.cle !== (typeof cle === 'string' ? cle : 'test') ? 'autre compte'
    : fil.relire ? 'ecritures concurrentes a relire'
    : Date.now() - (Date.parse(fil.complet_le) || 0) >= COMPLETE_MAX_MS ? 'synchro complete periodique'
    : lire('synchro_complete') ? 'demandee (' + lire('synchro_complete').raison + ')'
    : lire('images_a_reprendre') ? 'images a reprendre'
    : !api.changements ? 'fil indisponible'
    : null;
  if (raison) { journal.debug('synchro', 'rapide-non', { raison }); return null; }
  const ctx = etat.contexte();
  moteur.emettreStats(ctx);   // compteurs de vues -> ops a envoyer eventuelles
  const aPousser = ctx.d.prepare('SELECT COUNT(*) n FROM changements WHERE pousse=0').get().n;
  if (aPousser) { journal.debug('synchro', 'rapide-non', { raison: 'a envoyer', ops: aPousser }); return null; }
  const t0 = Date.now();
  signaler({ etape: 'rapide', libelle: 'Vérification des nouveautés' });
  let L;
  try { L = await api.changements(fil.jeton); }
  catch (e) {
    if (e && e.jetonMort) throw e;
    journal.avertir('synchro', 'rapide-echec', { erreur: e.message });
    return null;
  }
  if (L.changes.length) {
    journal.debug('synchro', 'rapide-non', { raison: 'changements', n: L.changes.length, ms: Date.now() - t0 });
    return null;
  }
  db.definirEtatSync('drive_fil', JSON.stringify({ ...fil, jeton: L.nouveauJeton }));
  const bilan = {
    le: new Date().toISOString(), rapide: true,
    poussees: 0, appliquees: 0, rejetees: 0, conflits: etat.conflits().length,
    envoye: null, recu: null, imagesEnvoyees: 0, imagesRecues: 0,
    prefixe: a.prefixe_ref, premiereFois: false, renumerotees: [], remplacement: null, supplante: null, nom: a.nom,
    rattrapage: null, snapshot: null, segmentsPurges: 0, tuilesOubliees: 0, change: false
  };
  journal.evt('synchro', 'rapide', { ms: Date.now() - t0, derniereComplete: fil.complet_le });
  db.definirEtatSync('drive_fusion_derniere', JSON.stringify(bilan));
  return bilan;
}

const LIBELLES = {
  titre: 'Titre', artiste: 'Artiste', date: 'Année / période', lieu: 'Conservation',
  description: 'Description', tags: 'Tags', image: 'Image', ref_local: 'Numéro', _existe: 'Existence'
};

/**
 * Conflits ouverts, prets a afficher : oeuvre concernee, champ, et pour
 * chaque version sa valeur, l'appareil et la date.
 */
function listeConflits() {
  const d = db.instance();
  const a = etat.appareil();
  const noms = new Map([[a.id, a.nom + ' (cet appareil)']]);
  for (const f of lire('appareils_connus') || []) if (f.id !== a.id) noms.set(f.id, f.nom || f.id);
  const { lire: lireHlc } = require('./hlc');
  const version = (hlc, valeurJson, entite) => {
    const h = lireHlc(hlc);
    let v = valeurJson;
    if (entite === 'override' && v && typeof v === 'object') v = v.valeur;
    return { hlc, valeur: v, appareil: h.appareil, nomAppareil: noms.get(h.appareil) || h.appareil, le: new Date(h.ms).toISOString() };
  };
  // MAJ de pack contre correction locale (edition.conflitsPack) : propres a cet
  // appareil (meme pack partout = memes conflits), en tete de liste.
  const pack = edition.conflitsPack().map((c) => ({
    id: c.id, entite: 'pack', cle: c.oeuvreId, champ: c.champ, libelle: LIBELLES[c.champ] || c.champ,
    oeuvre: { titre: c.titre, ref: c.ref, locale: false }, type: 'pack',
    correction: c.correction, ancienPack: c.ancienPack, nouveauPack: c.nouveauPack
  }));
  return pack.concat(etat.conflits().map((c) => {
    const o = db.oeuvre(c.cle);
    const l = c.entite === 'locale' ? etat.lignes('locale', c.cle) : {};
    const titre = (o && o.titre) || (l.titre && l.titre.valeur) || '(sans titre)';
    const ref = (o && o.ref) || (l.ref_local && l.ref_local.valeur) || null;
    const base = {
      id: c.id, entite: c.entite, cle: c.cle, champ: c.champ, libelle: LIBELLES[c.champ] || c.champ,
      oeuvre: { titre, ref, locale: c.entite === 'locale' }, detecteLe: c.detecte_le
    };
    if (c.entite === 'locale' && c.champ === '_existe') {
      const m = d.prepare('SELECT champ FROM changements WHERE hlc=?').get(c.hlc_perdant);
      const supprimee = c.valeur_gagnante !== 1;
      return {
        ...base, type: 'suppression', supprimee,
        gagnant: version(c.hlc_gagnant, c.valeur_gagnante, c.entite),
        perdant: { ...version(c.hlc_perdant, c.valeur_perdante, c.entite), champ: m && m.champ, libelleChamp: m && (LIBELLES[m.champ] || m.champ) }
      };
    }
    return {
      ...base, type: 'valeur',
      gagnant: version(c.hlc_gagnant, c.valeur_gagnante, c.entite),
      perdant: version(c.hlc_perdant, c.valeur_perdante, c.entite)
    };
  }));
}

/** Nombre de conflits ouverts (synchro + MAJ de pack) : compteur de la barre laterale. */
function nombreConflits() {
  return etat.conflits().length + edition.conflitsPack().length;
}

/**
 * Appareils inscrits a la synchro (vus a la derniere synchro), celui-ci en
 * premier. `retire` : retire par cet appareil (en attente de synchro) ou par
 * un autre.
 */
function listeAppareils() {
  const a = etat.appareil();
  const connus = lire('appareils_connus') || [];
  const locaux = compaction.retiresEnVigueur(lire('appareils_retires') || [],
    connus.map((f) => ({ id: f.id, vu_le: f.vu_le })), a.id);
  const out = connus.map((f) => ({
    ...f, ...(f.id === a.id ? { nom: a.nom, type: a.type || f.type || null } : {}),
    moi: f.id === a.id, retireIci: locaux.has(f.id), retire: f.id !== a.id && (locaux.has(f.id) || !!f.retire)
  }));
  // Pas encore synchronise : sa lettre n'est pas encore attribuee (elle l'est en
  // rejoignant, selon celles deja prises) -> pas de lettre provisoire affichee.
  if (!out.some((f) => f.moi)) out.push({ id: a.id, nom: a.nom, type: a.type || null, prefixe: null, vu_le: null, moi: true, retire: false });
  return out.sort((x, y) => (x.moi ? -1 : y.moi ? 1 : String(y.vu_le || '').localeCompare(String(x.vu_le || ''))));
}

/**
 * Retire (ou remet) un appareil : il ne bloque plus le menage du dossier de
 * synchro. Publie a la prochaine synchro, dans la fiche de cet appareil. Ne
 * coupe pas son acces a Google Drive (a faire dans le compte Google).
 */
function retirerAppareil(id, retirer = true) {
  const a = etat.appareil();
  if (!id || id === a.id) return { erreur: 'Impossible de retirer cet appareil-ci.' };
  const l = (lire('appareils_retires') || []).filter((r) => r && r.id !== id);
  if (retirer) l.push({ id, le: new Date().toISOString() });
  db.definirEtatSync('appareils_retires', JSON.stringify(l));
  demanderComplete(retirer ? 'appareil retire' : 'appareil remis');
  journal.evt('synchro', retirer ? 'appareil-retire' : 'appareil-remis', { id, retires: l });
  return { ok: true, appareils: listeAppareils() };
}

/** Renomme cet appareil (publie a la prochaine synchro). */
function renommer(nom) {
  const n = nomValide(nom);
  if (!n) return { erreur: 'Nom vide ou trop long (40 caractères au plus).' };
  const a = etat.appareil();
  const avant = a.nom;
  a.nom = n;
  a.nom_perso = true;
  sauverAppareil();
  demanderComplete('appareil renomme');
  const connus = (lire('appareils_connus') || []).map((f) => (f.id === a.id ? { ...f, nom: n } : f));
  db.definirEtatSync('appareils_connus', JSON.stringify(connus));
  journal.evt('synchro', 'appareil-renomme', { avant, apres: n });
  return { ok: true, appareils: listeAppareils(), etat: etatSynchro() };
}

/**
 * Decision avant la premiere synchro : id de l'appareil remplace, ou null
 * (« nouvel appareil »). La synchro suivante l'applique (rejoindre.js).
 */
function choisirRemplacement(id) {
  const a = etat.appareil();
  if (a.inscrit) return { erreur: 'Cet appareil est déjà inscrit à la synchro.' };
  const d = lire('decision_requise');
  if (id && !(d && (d.candidats || []).some((c) => c.id === id))) return { erreur: 'Appareil inconnu.' };
  a.remplace = id || 'aucun';
  sauverAppareil();
  demanderComplete('remplacement choisi');
  db.definirEtatSync('decision_requise', '');
  journal.evt('synchro', 'remplacement-choisi', { remplace: a.remplace, candidat: id ? d.candidats.find((c) => c.id === id) : null });
  return { ok: true, etat: etatSynchro() };
}

/**
 * Tranche un conflit (choix = 'gagnant' | 'perdant') et remet la vue a jour.
 * L'op emise partira a la prochaine synchro et fermera le conflit ailleurs.
 */
function resoudre(id, choix) {
  if (typeof id === 'string' && id.startsWith('pack:')) {
    edition.trancherPack(id, choix === 'perdant' ? 'pack' : 'garder');
    return { conflits: etat.conflits() };
  }
  const c = etat.conflits().find((x) => x.id === id);
  const h = etat.resoudre(id, choix);
  journal.evt('synchro', 'conflit-tranche', {
    id, choix, entite: c && c.entite, cle: c && c.cle, champ: c && c.champ, op: h
  });
  db.reconstruireVue({ force: true });
  jeu.reinitialiserSac();
  return { hlc: h, conflits: etat.conflits() };
}

module.exports = {
  configurer, etat: etatSynchro, definirDossier, oublierDossier,
  synchroniser, synchroniserDrive, resoudre, listeConflits, listeAppareils, retirerAppareil, SOUS_DOSSIER,
  renommer, choisirRemplacement, decisionEnAttente, sessionExpiree, sessionRetablie, nombreConflits
};
