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
const compaction = require('./compaction');
const appareilFichier = require('./appareil');
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

// Progression de la synchro en cours, diffusee a l'interface (surProgression)
// et relue par toute page qui s'ouvre (etatSynchro) : l'utilisateur voit en
// permanence ce qui se passe, meme s'il change d'onglet.
let progression = { enCours: false };
let nCycles = 0;
const LIBELLES_ETAPES = {
  depart: 'Démarrage…',
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

function etatSynchro() {
  const a = etat.appareil();
  return {
    dossier: a.dossier_synchro || null,
    appareil: { id: a.id, nom: a.nom, prefixe: a.prefixe_ref },
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
      nom: a.nom, enregistrerPrefixe: () => sauverAppareil(), pas,
      crochets: {
        imagesEnvoi: () => transfererImages(t, 'envoi'),
        imagesReception: () => transfererImages(t, 'reception')
      }
    });
    const rj = c.rejoindre;
    const r = c.tire;
    // Noms des appareils, pour l'ecran des conflits (« modifie sur Telephone »).
    db.definirEtatSync('appareils_connus', JSON.stringify(rj.appareils || []));
    journal.evt('synchro', 'appareils', {
      premiereFois: rj.premiereFois, prefixe: rj.prefixe, renumerotees: rj.renumerotees, appareils: rj.appareils
    });
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
      rattrapage: c.rattrapage ? (c.rattrapage.snapshot || 'impossible') : null,
      snapshot: c.snapshot ? c.snapshot.nom : null, segmentsPurges: c.purge.supprimes.length,
      tuilesOubliees: c.tombes.length, change: !!change
    };
    journal.evt('synchro', 'fin', { par: sorte, ...bilan, ms: Date.now() - t0 });
    return bilan;
  } catch (e) {
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
  catch (e) { r = { erreur: 'Synchro interrompue : ' + e.message }; }
  finally { enCours = false; }
  r = { ...r, cycle, auto };
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
  if (!a.dossier_synchro) return Promise.resolve({ erreur: 'Aucun dossier de synchro choisi.' });
  if (!fs.existsSync(a.dossier_synchro)) {
    journal.avertir('synchro', 'dossier-introuvable', { dossier: a.dossier_synchro });
    return Promise.resolve({ erreur: 'Dossier de synchro introuvable (clé USB débranchée, lecteur réseau absent ?).' });
  }
  return exclusif('dossier', async () => {
    try {
      const bilan = await coeur(creerTransportDossier(racine(a.dossier_synchro)), 'dossier');
      db.definirEtatSync('dossier_derniere', JSON.stringify(bilan));
      return bilan;
    } catch (e) {
      return { erreur: 'Synchro interrompue : ' + e.message };
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
  return exclusif('drive', async () => {
    const op = async (oauth) => {
      const bilan = await coeur(creerTransportDrive(apiTest || drive.api(oauth)), 'drive');
      db.definirEtatSync('drive_fusion_derniere', JSON.stringify(bilan));
      return bilan;
    };
    if (apiTest) {
      try { return await op(null); } catch (e) { return { erreur: 'Synchro interrompue : ' + e.message }; }
    }
    return drive.avecReconnexion(op,
      () => { signaler({ etape: 'reconnexion' }); if (surReconnexion) surReconnexion(); },
      () => signaler({ etape: 'reprise' }),
      { sansReconnexion: auto });
  }, auto);
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
  return etat.conflits().map((c) => {
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
  });
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
    ...f, moi: f.id === a.id, retireIci: locaux.has(f.id), retire: f.id !== a.id && (locaux.has(f.id) || !!f.retire)
  }));
  if (!out.some((f) => f.moi)) out.push({ id: a.id, nom: a.nom, prefixe: a.prefixe_ref, vu_le: null, moi: true, retire: false });
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
  journal.evt('synchro', retirer ? 'appareil-retire' : 'appareil-remis', { id, retires: l });
  return { ok: true, appareils: listeAppareils() };
}

/**
 * Tranche un conflit (choix = 'gagnant' | 'perdant') et remet la vue a jour.
 * L'op emise partira a la prochaine synchro et fermera le conflit ailleurs.
 */
function resoudre(id, choix) {
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
  synchroniser, synchroniserDrive, resoudre, listeConflits, listeAppareils, retirerAppareil, SOUS_DOSSIER
};
