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
 * Reglages (propres a l'appareil) : revision_nouvelles (10, ou 'illimite' : toutes les
 * tuiles jamais notees sont proposees), revision_retention (0,9).
 */

const db = require('./db');
const etat = require('./synchro/etat');
const jeu = require('./jeu');
const fsrs = require('./fsrs');
const journal = require('./journal');

const JOUR = 86400000;
const REVOIR_ENCORE_MS = 10 * 60000;     // « Encore » : de nouveau due 10 min plus tard
const AVANCE_MS = 20 * 60000;            // plus rien de du : une « Encore » proche passe en avance
const ECART_ENCORE = 3;                  // une « Encore » ne revient qu'apres 3 autres tuiles notees
const STABILITE_SOLIDE = 3;              // jours : en dessous, tuile « fragile » (difficile pour le joueur)
const FRAGILES_DE_SUITE = 2;             // au plus 2 fragiles d'affilee, puis une tuile de respiration

/** Valeur du reglage revision_nouvelles qui leve la limite de nouvelles tuiles par jour. */
const ILLIMITE = 'illimite';

function reglages() {
  const brut = db.reglage('revision_nouvelles', '10');
  const n = parseInt(brut, 10);
  const r = parseFloat(db.reglage('revision_retention', '0.9'));
  return {
    // Infinity = sans limite (jamais renvoye tel quel a l'interface : voir compte.quotaNouvelles).
    nouvelles: brut === ILLIMITE ? Infinity : Number.isFinite(n) ? Math.min(Math.max(n, 0), 200) : 10,
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
    dues, nouvelles, cartes, notes,
    compte: {
      dues: dues.length, nouvelles: nouvelles.length, faitesAujourdhui: faites, introduitesAujourdhui: introduites,
      apprises, total: presentes.size, prochaine: prochaine ? new Date(prochaine).toISOString() : null,
      // null = illimite (Infinity ne survit pas a JSON).
      quotaNouvelles: quota === Infinity ? null : quota, illimite: quota === Infinity, retention
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
const estFragile = (c) => !!c && c.stabilite < STABILITE_SOLIDE;

/**
 * Notes d'aujourd'hui, de la plus recente a la plus ancienne, tous appareils :
 * { id, t, fragile } ou `fragile` = la tuile l'etait AVANT cette note (une
 * nouvelle tuile ne l'est pas).
 */
function notesDuJour(notes, retention, maintenant) {
  const dj = debutJour(maintenant);
  const out = [];
  for (const [id, l] of notes) {
    for (let k = 0; k < l.length; k++) {
      if (l[k].t < dj || l[k].t > maintenant) continue;
      out.push({ id, t: l[k].t, fragile: k > 0 && estFragile(etatCarte(l.slice(0, k), retention)) });
    }
  }
  return out.sort((a, b) => b.t - a.t);
}

/** Tuiles fragiles notees d'affilee, en remontant depuis la derniere note. */
function fragilesDeSuite(recentes) {
  let n = 0;
  for (const r of recentes) { if (!r.fragile) break; n++; }
  return n;
}

/** Nombre de notes posees sur d'AUTRES tuiles depuis la derniere note de `id`. */
function autresDepuis(id, carte, recentes) {
  const t = Date.parse(carte.dernier_vu);
  let n = 0;
  for (const r of recentes) { if (r.t <= t) break; if (r.id !== id) n++; }
  return n;
}

/**
 * Choix de la prochaine tuile (fonction de la file, sans ecriture).
 *  1. « Encore » echue (10 min passees) et deja 3 autres tuiles notees depuis :
 *     passe avant tout (sinon, dans une file de 1 000 tuiles, elle se perdrait
 *     derriere les plus en retard).
 *  2. Ordre ordinaire : dues (les plus en retard d'abord), puis nouvelles.
 *  3. Si cette tuile est fragile et que les 2 dernieres l'etaient aussi :
 *     respiration — une due solide, sinon une nouvelle, sinon une tuile solide
 *     pas encore due (revision en avance, FSRS en tient compte : un rappel sur
 *     de l'acquis fait a peine bouger la stabilite).
 *  4. Plus rien : « Encore » retenue par l'ecart de 3, puis « Encore » proche
 *     en avance, puis la seule tuile restante.
 * @returns {{ id: string, respiration?: boolean } | null}
 */
function choisir(f, exclure, maintenant, retention) {
  const ex = new Set(exclure);
  const recentes = notesDuJour(f.notes, retention, maintenant);
  const encore = (id) => { const c = f.cartes.get(id); return c && c.intervalleJours === 0; };
  const retenues = new Set(f.dues.filter((id) => encore(id) && autresDepuis(id, f.cartes.get(id), recentes) < ECART_ENCORE));

  const prioritaire = f.dues.filter((id) => !ex.has(id) && encore(id) && !retenues.has(id))
    .sort((a, b) => f.cartes.get(a).du - f.cartes.get(b).du)[0];
  if (prioritaire) return { id: prioritaire };

  const dues = f.dues.filter((id) => !ex.has(id) && !retenues.has(id));
  const nouvelles = f.nouvelles.filter((id) => !ex.has(id));
  const naturelle = dues[0] || nouvelles[0];
  if (naturelle && estFragile(f.cartes.get(naturelle)) && fragilesDeSuite(recentes) >= FRAGILES_DE_SUITE) {
    const solide = dues.find((id) => !estFragile(f.cartes.get(id)));
    if (solide) return { id: solide };
    if (nouvelles[0]) return { id: nouvelles[0] };
    const vuesAujourdhui = new Set(recentes.map((r) => r.id));
    const avance = [...f.cartes.entries()]
      .filter(([id, c]) => !ex.has(id) && !vuesAujourdhui.has(id) && c.du > maintenant && !estFragile(c))
      .sort((a, b) => a[1].du - b[1].du)[0];
    if (avance) return { id: avance[0], respiration: true };
  }
  if (naturelle) return { id: naturelle };

  const retenue = f.dues.find((id) => !ex.has(id) && retenues.has(id));
  if (retenue) return { id: retenue };
  // Plus rien de du : une « Encore » qui revient dans peu de temps passe en avance.
  const proche = [...f.cartes.entries()]
    .filter(([x, c]) => !ex.has(x) && c.du > maintenant && c.du - maintenant <= AVANCE_MS)
    .sort((a, b) => a[1].du - b[1].du)[0];
  if (proche) return { id: proche[0] };
  if (f.dues.length) return { id: f.dues[0] };   // seule tuile restante : tant pis, la reproposer
  return null;
}

function tirer(exclure = [], maintenant = Date.now()) {
  const f = file(maintenant);
  const { retention } = reglages();
  const choix = choisir(f, exclure, maintenant, retention);
  if (!choix) return { fini: true, compte: f.compte };
  const id = choix.id;
  const t = jeu.tuile(id, null);
  if (!t) return { fini: true, compte: f.compte };
  const carte = f.cartes.get(id) || null;
  return {
    ...t,
    revision: {
      nouvelle: !carte,
      enAvance: !!choix.respiration,
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

module.exports = {
  ILLIMITE, reglages, file, resume, tirer, noter, etatCarte, ordreDuJour,
  REVOIR_ENCORE_MS, ECART_ENCORE, STABILITE_SOLIDE, FRAGILES_DE_SUITE
};
