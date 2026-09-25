'use strict';
/**
 * Copie de securite automatique : une fois par semaine, sans rien demander,
 * le zip de sauvegarde.js (tuiles creees, corrections, archives, marques,
 * images) est range dans « Documents\Tuiles et Toiles - sauvegardes\ ». Les 4
 * plus recentes sont gardees (un mois).
 *
 * Filet pour les catastrophes que la synchro ne couvre pas : dossier de
 * synchro supprime ou corrompu, appareil unique perdu, erreur propagee a tous
 * les appareils. Documents plutot que %APPDATA% : souvent sauvegarde par
 * Windows (OneDrive) et visible de l'utilisateur. Reprise : Options ->
 * « Importer une sauvegarde… » (fusion, rien n'est efface).
 */

const fs = require('fs');
const path = require('path');

const journal = require('./journal');
const lisezmoi = require('./lisezmoi');

const PERIODE = 7 * 86400e3;
const GARDER = 4;
const RE_COPIE = /^sauvegarde-(\d{4}-\d{2}-\d{2})\.zip$/;

let cfg = null;
/**
 * @param {{ dossier, exporter: (chemin) => object, aDesDonnees: () => boolean,
 *   maintenant?: () => number }} c
 */
function configurer(c) { cfg = c; }
const maintenant = () => (cfg.maintenant || Date.now)();

/** Copies presentes, plus recente d'abord. */
function lister() {
  if (!fs.existsSync(cfg.dossier)) return [];
  return fs.readdirSync(cfg.dossier)
    .filter((f) => RE_COPIE.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(cfg.dossier, f));
      return { nom: f, le: st.mtime.toISOString(), octets: st.size };
    })
    .sort((a, b) => (a.nom < b.nom ? 1 : a.nom > b.nom ? -1 : 0));
}

function etat() {
  const l = lister();
  return { dossier: cfg.dossier, derniere: l[0] || null, nombre: l.length };
}

/**
 * Fait la copie si la derniere a plus d'une semaine (ou s'il n'y en a pas).
 * @param {{ forcer?: boolean, raison?: string }} o
 * @returns {{ faite: false, raison } | { faite: true, nom, octets, supprimees }}
 */
function siBesoin({ forcer = false, raison = 'hebdomadaire' } = {}) {
  const t0 = Date.now();
  const l = lister();
  if (!forcer && l[0] && maintenant() - Date.parse(l[0].le) < PERIODE) return { faite: false, raison: 'recente' };
  if (!cfg.aDesDonnees()) return { faite: false, raison: 'aucune-donnee' };

  fs.mkdirSync(cfg.dossier, { recursive: true });
  lisezmoi.deposer(cfg.dossier, 'sauvegardes_auto');
  const nom = 'sauvegarde-' + new Date(maintenant()).toISOString().slice(0, 10) + '.zip';
  const cible = path.join(cfg.dossier, nom);
  const tmp = cible + '.tmp';
  try {
    cfg.exporter(tmp);
    fs.renameSync(tmp, cible);   // jamais de zip a moitie ecrit sous le nom final
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* deja parti */ }
    journal.erreur('sauvegarde', 'copie-securite', e, { cible, raison });
    return { faite: false, raison: 'echec', erreur: e.message };
  }
  const supprimees = [];
  for (const vieille of lister().slice(GARDER)) {
    try { fs.rmSync(path.join(cfg.dossier, vieille.nom)); supprimees.push(vieille.nom); }
    catch (e) { journal.erreur('sauvegarde', 'copie-securite-menage', e, { fichier: vieille.nom }); }
  }
  const octets = fs.statSync(cible).size;
  journal.evt('sauvegarde', 'copie-securite', { nom, octets, raison, supprimees, gardees: GARDER, ms: Date.now() - t0 });
  return { faite: true, nom, octets, supprimees };
}

module.exports = { configurer, lister, etat, siBesoin, PERIODE, GARDER };
