'use strict';
/**
 * FSRS-4.5 — planificateur de repetition espacee.
 *
 * Port maison (aucune dependance) de l'algorithme Free Spaced Repetition
 * Scheduler, version 4.5, avec les 19 poids par defaut publies. Fonctions
 * pures : aucune I/O, aucun effet de bord.
 *
 * Vocabulaire :
 *   S (stabilite)   nb de jours au bout duquel la retrievabilite retombe a la
 *                   retention cible. C'est aussi l'intervalle a 90 %.
 *   D (difficulte)  1 (facile) .. 10 (dur).
 *   note            1 Encore · 2 Difficile · 3 Bien · 4 Facile.
 *
 * Pas d'etape d'apprentissage infra-journaliere : une note « Encore » est
 * geree en amont (la tuile revient dans la session, revision.js) ; ici elle
 * met juste a jour S et D et renvoie un intervalle < 1 jour.
 * Repris de Bristol (meme auteur).
 */

const DECAY = -0.5;
const FACTOR = 19 / 81;                 // 0.9^(1/DECAY) - 1
const S_MIN = 0.01;
const S_MAX = 36500;
const MAX_INTERVALLE = 36500;

// Poids par defaut FSRS-4.5.
const W = [
  0.4072, 1.1829, 3.1262, 15.4722, 7.2102, 0.5316, 1.0651, 0.0234, 1.616,
  0.1544, 1.0824, 1.9813, 0.0953, 0.2975, 2.2042, 0.2407, 2.9466, 0.5034, 0.6567
];

const borne = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

/** Retrievabilite : probabilite de rappel apres `t` jours pour une stabilite S. */
function retrievabilite(t, S) {
  return Math.pow(1 + FACTOR * Math.max(t, 0) / S, DECAY);
}

/** Intervalle (jours) pour retomber a `retention` depuis la stabilite S. */
function intervalleJours(S, retention) {
  const j = (S / FACTOR) * (Math.pow(retention, 1 / DECAY) - 1);
  return borne(Math.round(j), 1, MAX_INTERVALLE);
}

/** Difficulte initiale pour une premiere note. */
function difficulteInitiale(note) {
  return borne(W[4] - Math.exp(W[5] * (note - 1)) + 1, 1, 10);
}

/** Etat FSRS apres la toute premiere revision d'une fiche. */
function premiere(note) {
  return {
    stabilite: borne(W[note - 1], S_MIN, S_MAX),
    difficulte: difficulteInitiale(note)
  };
}

function prochaineD(D, note) {
  const dp = D - W[6] * (note - 3);
  const cible = difficulteInitiale(4);
  return borne(W[7] * cible + (1 - W[7]) * dp, 1, 10);
}

function stabiliteRappel(S, D, R, note) {
  const penaliteDur = note === 2 ? W[15] : 1;
  const bonusFacile = note === 4 ? W[16] : 1;
  const inc = Math.exp(W[8]) * (11 - D) * Math.pow(S, -W[9])
    * (Math.exp(W[10] * (1 - R)) - 1) * penaliteDur * bonusFacile;
  return borne(S * (1 + inc), S_MIN, S_MAX);
}

function stabiliteOubli(S, D, R) {
  const s = W[11] * Math.pow(D, -W[12]) * (Math.pow(S + 1, W[13]) - 1)
    * Math.exp(W[14] * (1 - R));
  return borne(Math.min(s, S), S_MIN, S_MAX);
}

/**
 * Etat FSRS apres une revision (fiche deja vue au moins une fois).
 * @param {{stabilite:number, difficulte:number}} carte
 * @param {number} note            1..4
 * @param {number} elapsedJours    jours ecoules depuis la derniere revision
 * @param {number} retention       retention cible (ex. 0.9)
 * @returns {{stabilite:number, difficulte:number, intervalleJours:number}}
 */
function suivante(carte, note, elapsedJours, retention) {
  const R = retrievabilite(elapsedJours, carte.stabilite);
  const difficulte = prochaineD(carte.difficulte, note);
  const stabilite = note === 1
    ? stabiliteOubli(carte.stabilite, carte.difficulte, R)
    : stabiliteRappel(carte.stabilite, carte.difficulte, R, note);
  return {
    stabilite,
    difficulte,
    intervalleJours: note === 1 ? 0 : intervalleJours(stabilite, retention)
  };
}

/**
 * Intervalles (jours) que donnerait chaque note MAINTENANT, sans rien ecrire.
 * Sert a annoter les 4 boutons de notation.
 * @param {null|{stabilite:number, difficulte:number, dernier_vu?:string}} carte
 * @param {number} retention
 * @param {Date}   [maintenant]
 * @returns {{1:number, 2:number, 3:number, 4:number}}
 */
function apercu(carte, retention, maintenant = new Date()) {
  const out = {};
  if (!carte) {
    for (let n = 1; n <= 4; n++) {
      const p = premiere(n);
      out[n] = n === 1 ? 0 : intervalleJours(p.stabilite, retention);
    }
    return out;
  }
  const elapsed = carte.dernier_vu
    ? Math.max(0, (maintenant - new Date(carte.dernier_vu)) / 86400000)
    : 0;
  for (let n = 1; n <= 4; n++) {
    out[n] = suivante(carte, n, elapsed, retention).intervalleJours;
  }
  return out;
}

module.exports = {
  W, DECAY, FACTOR, MAX_INTERVALLE,
  retrievabilite, intervalleJours, premiere, suivante, apercu
};
