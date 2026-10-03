'use strict';
/**
 * Repetition espacee (FSRS-4.5, fsrs.js) : Jouer → « Révision ».
 *
 * Chaque note (1 Encore · 2 Difficile · 3 Bien · 4 Facile) est une ecriture
 * ordinaire de l'entite synchronisee `revision` (cle = oeuvre, champ =
 * <appareil>.<horodatage>, un seul ecrivain : jamais de conflit), projetee
 * dans `user_revisions`. L'etat FSRS d'une tuile n'est stocke nulle part : il
 * se recalcule en rejouant ses notes dans l'ordre chronologique, sur tous
 * les appareils pareil — reviser sur le telephone puis sur le PC converge
 * sans rien fusionner. Annuler (Ctrl+Z) une note = l'effacer.
 *
 * File du jour :
 *   dues       tuiles deja vues dont l'echeance est passee (les plus en retard
 *              d'abord) ; « Encore » = de nouveau due 10 min plus tard
 *   nouvelles  tuiles jamais notees, dans un ordre melange stable pour la
 *              journee, dans la limite de `revision_nouvelles` par jour (tous
 *              appareils confondus : une tuile « introduite » aujourd'hui l'est
 *              par sa premiere note)
 * Reglages (propres a l'appareil) : revision_nouvelles (10), revision_retention (0,9).
 */

const db = require('./db');
const etat = require('./synchro/etat');
const jeu = require('./jeu');
const fsrs = require('./fsrs');
const journal = require('./journal');

const JOUR = 86400000;
const REVOIR_ENCORE_MS = 10 * 60000;     // « Encore » : de nouveau due 10 min plus tard
const AVANCE_MS = 20 * 60000;            // plus rien de du : une « Encore » proche passe en avance

function reglages() {
  const n = parseInt(db.reglage('revision_nouvelles', '10'), 10);
  const r = parseFloat(db.reglage('revision_retention', '0.9'));
  return {
    nouvelles: Number.isFinite(n) ? Math.min(Math.max(n, 0), 200) : 10,
    retention: Number.isFinite(r) ? Math.min(Math.max(r, 0.7), 0.97) : 0.9
  };
}

/** Notes de toutes les tuiles : Map id -> [{ n, le, t }] dans l'ordre chronologique. */
function notesParTuile() {
  const m = new Map();
  for (const r of db.instance().prepare('SELECT oeuvre_id, rid, note, le FROM user_revisions ORDER BY le, rid').all()) {
    const t = Date.parse(r.le);
    if (Number.isNaN(t)) continue;
    if (!m.has(r.oeuvre_id)) m.set(r.oeuvre_id, []);
    m.get(r.oeuvre_id).push({ n: r.note, le: r.le, t });
  }
  return m;
}

/**
 * Etat FSRS d'une tuile en rejouant ses notes. Fonction pure.
 * @param {Array<{ n: number, t: number }>} notes  ordre chronologique
 * @returns {null|{ stabilite, difficulte, dernier_vu, du, n, derniereNote, intervalleJours }}
 */
function etatCarte(notes, retention) {
  if (!notes || !notes.length) return null;
  let carte = null, dernier = null, intervalle = 0;
  for (const r of notes) {
    if (!carte) {
      const p = fsrs.premiere(r.n);
      carte = { stabilite: p.stabilite, difficulte: p.difficulte };
      intervalle = r.n === 1 ? 0 : fsrs.intervalleJours(p.stabilite, retention);
    } else {
      const s = fsrs.suivante(carte, r.n, Math.max(0, (r.t - dernier) / JOUR), retention);
      carte = { stabilite: s.stabilite, difficulte: s.difficulte };
      intervalle = s.intervalleJours;
    }
    dernier = r.t;
  }
  const der = notes[notes.length - 1];
  return {
    ...carte, dernier_vu: new Date(dernier).toISOString(), n: notes.length, derniereNote: der.n,
    intervalleJours: intervalle, du: dernier + (intervalle ? intervalle * JOUR : REVOIR_ENCORE_MS)
  };
}

function debutJour(maintenant) {
  const d = new Date(maintenant);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Ordre melange, stable pour la journee (pas le meme ordre chaque jour). */
function ordreDuJour(ids, maintenant) {
  const jour = new Date(debutJour(maintenant)).toISOString().slice(0, 10);
  // FNV-1a 32 bits : leger, identique PC / mobile.
  const h = (id) => {
    let x = 0x811c9dc5;
    for (const ch of jour + id) { x ^= ch.charCodeAt(0); x = Math.imul(x, 0x01000193) >>> 0; }
    return x;
  };
  return ids.map((id) => [h(id), id]).sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1)).map((x) => x[1]);
}

/** Tuiles revisables : presentes et avec au moins un masque valide. */
function eligibles() {
  return db.instance().prepare('SELECT id, masques FROM oeuvres_effectives').all()
    .filter((o) => { try { return JSON.parse(o.masques || '[]').length > 0; } catch { return false; } })
    .map((o) => o.id);
}

/**
 * File du jour.
 * @returns {{ dues: string[], nouvelles: string[], cartes: Map, compte: object }}
 */
function file(maintenant = Date.now()) {
  const { nouvelles: quota, retention } = reglages();
  const notes = notesParTuile();
  const ids = eligibles();
  const dj = debutJour(maintenant);
  const cartes = new Map();
  const dues = [];
  let introduites = 0, faites = 0, prochaine = null, apprises = 0;
  for (const [id, l] of notes) {
    if (l[0].t >= dj) introduites++;
    faites += l.filter((r) => r.t >= dj).length;
  }
  const presentes = new Set(ids);
  for (const id of ids) {
    const c = etatCarte(notes.get(id), retention);
    if (!c) continue;
    cartes.set(id, c);
    apprises++;
    if (c.du <= maintenant) dues.push(id);
    else if (prochaine == null || c.du < prochaine) prochaine = c.du;
  }
  dues.sort((a, b) => cartes.get(a).du - cartes.get(b).du);
  const restantes = Math.max(0, quota - introduites);
  const nouvelles = ordreDuJour(ids.filter((id) => !notes.has(id)), maintenant).slice(0, restantes);
  return {
    dues, nouvelles, cartes,
    compte: {
      dues: dues.length, nouvelles: nouvelles.length, faitesAujourdhui: faites, introduitesAujourdhui: introduites,
      apprises, total: presentes.size, prochaine: prochaine ? new Date(prochaine).toISOString() : null,
      quotaNouvelles: quota, retention
    }
  };
}

/** Compteurs pour l'ecran Jouer. */
function resume(maintenant = Date.now()) { return file(maintenant).compte; }

/**
 * Prochaine tuile a reviser, masque tire au hasard comme au jeu, avec ce que
 * donnerait chaque note (intervalles). null + compte quand c'est fini.
 * @param {string[]} [exclure] tuiles a ne pas reproposer tout de suite (la derniere vue)
 */
function tirer(exclure = [], maintenant = Date.now()) {
  const f = file(maintenant);
  const ex = new Set(exclure);
  let id = f.dues.find((x) => !ex.has(x)) || f.nouvelles.find((x) => !ex.has(x));
  if (!id) {
    // Plus rien de du : une « Encore » qui revient dans peu de temps passe en avance.
    const proche = [...f.cartes.entries()]
      .filter(([x, c]) => !ex.has(x) && c.du > maintenant && c.du - maintenant <= AVANCE_MS)
      .sort((a, b) => a[1].du - b[1].du)[0];
    id = proche && proche[0];
  }
  if (!id && f.dues.length) id = f.dues[0];     // seule tuile restante : tant pis, la reproposer
  if (!id) return { fini: true, compte: f.compte };
  const t = jeu.tuile(id, null);
  if (!t) return { fini: true, compte: f.compte };
  const carte = f.cartes.get(id) || null;
  const { retention } = reglages();
  return {
    ...t,
    revision: {
      nouvelle: !carte,
      apercu: fsrs.apercu(carte, retention, new Date(maintenant)),
      derniere: carte ? { le: carte.dernier_vu, note: carte.derniereNote } : null,
      compte: f.compte
    }
  };
}

let dernierT = 0;
/** Identifiant de note : <appareil>.<horodatage base 36>, strictement croissant ici. */
function nouveauRid(maintenant) {
  let t = maintenant;
  if (t <= dernierT) t = dernierT + 1;
  dernierT = t;
  return etat.appareil().id + '.' + t.toString(36);
}

/**
 * Note une tuile. Ecriture synchronisee (entite revision).
 * @returns {{ ok, du, intervalleJours } | { erreur }}
 */
function noter(id, note, maintenant = Date.now()) {
  const n = Number(note);
  if (![1, 2, 3, 4].includes(n)) return { erreur: 'note invalide' };
  if (!db.oeuvre(id)) return { erreur: 'tuile introuvable' };
  const le = new Date(maintenant).toISOString();
  etat.ecrire('revision', id, nouveauRid(maintenant), { n, le });
  const { retention } = reglages();
  const c = etatCarte(notesParTuile().get(id), retention);
  journal.evt('jeu', 'revision-note', { id, note: n, intervalleJours: c && c.intervalleJours, n: c && c.n });
  return { ok: true, du: c ? new Date(c.du).toISOString() : null, intervalleJours: c ? c.intervalleJours : 0 };
}

module.exports = { reglages, file, resume, tirer, noter, etatCarte, ordreDuJour, REVOIR_ENCORE_MS };
