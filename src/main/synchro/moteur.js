'use strict';
/**
 * Moteur de synchro : ecriture locale, application d'une op distante,
 * conflits.
 *
 * Aucun etat global : chaque fonction recoit un contexte
 *   ctx = { d, appareil, horloge }
 *     d        connexion better-sqlite3 portant le schema user (etat, changements…)
 *     appareil { id, prefixe_ref, … }
 *     horloge  creerHorloge(appareil.id)
 * -> on peut faire tourner plusieurs appareils dans un meme processus (tests).
 *
 * Deux regles, chacune fonction du seul ENSEMBLE des ops connues (pas de
 * leur ordre d'arrivee) -> tous les appareils convergent :
 *
 * 1. Valeur d'un champ (triplet entite / cle / champ) = l'op de plus grande
 *    HLC. Un descendant a toujours une HLC superieure a ses ancetres : une
 *    edition faite en connaissance de cause gagne toujours.
 *
 * 2. Conflit = le champ a plusieurs tetes de valeurs differentes. Une tete
 *    est une op qu'aucune autre n'a vue : aucune op ne la cite dans sa
 *    `base` (la version remplacee) ni dans ses `vus` (les autres tetes que
 *    son auteur avait sous les yeux). Toute ecriture locale cite toutes les
 *    tetes du champ -> editer ou trancher un champ en conflit le ferme,
 *    ici puis partout ou l'op arrive.
 *
 * Tuile supprimee : _existe = { vu: <plus grande HLC connue de la tuile par
 * l'auteur de la suppression> }. Une op de champ de cette tuile au-dessus de
 * `vu` a ete faite sans voir la suppression -> conflit « supprimee ici,
 * modifiee la-bas ». La suppression gagne par defaut ; restaurer = _existe = 1.
 */

const { versIso } = require('./hlc');

const CHAMPS_LOCALE = ['artiste', 'titre', 'date', 'lieu', 'description', 'tags', 'image'];
const TAGS = ['livre', 'etoile', 'bad_smiley'];
// stat : cle = oeuvre_id, champ = id de l'appareil qui compte, valeur =
// { vues, dernier_vu }. Un seul ecrivain par champ (l'appareil lui-meme) :
// jamais de conflit, total = somme des appareils.
const ENTITES = ['locale', 'override', 'archive', 'tag', 'stat'];
const RE_APPAREIL = /^[0-9a-f]{8}$/;

function parse(v) { return v == null ? null : JSON.parse(v); }

// --- lecture ----------------------------------------------------------------

function lire(ctx, entite, cle, champ) {
  return ctx.d.prepare('SELECT valeur, hlc, base FROM etat WHERE entite=? AND cle=? AND champ=?')
    .get(entite, cle, champ);
}

function valeur(ctx, entite, cle, champ) {
  const r = lire(ctx, entite, cle, champ);
  return r ? parse(r.valeur) : null;
}

function lignes(ctx, entite, cle) {
  const out = {};
  for (const r of ctx.d.prepare('SELECT champ, valeur, hlc FROM etat WHERE entite=? AND cle=?').all(entite, cle)) {
    out[r.champ] = { valeur: parse(r.valeur), hlc: r.hlc };
  }
  return out;
}

/** Une tuile locale existe (et n'est ni supprimee ni inconnue). */
function existe(ctx, cle) {
  return valeur(ctx, 'locale', cle, '_existe') === 1;
}

// --- projections ------------------------------------------------------------
// Fonctions du seul registre : identiques sur tous les appareils. Les dates
// sont derivees des HLC de la version courante.

function projeterLocale(ctx, cle) {
  const d = ctx.d;
  const l = lignes(ctx, 'locale', cle);
  if (!l._existe || l._existe.valeur !== 1) {
    d.prepare('DELETE FROM oeuvres_locales WHERE id=?').run(cle);
    return;
  }
  const row = { id: cle, ref_local: l.ref_local ? l.ref_local.valeur : null };
  for (const c of CHAMPS_LOCALE) row[c] = l[c] && l[c].valeur != null ? String(l[c].valeur) : '';
  // Creation = op _existe, modification = derniere op.
  const derniere = Object.values(l).reduce((m, x) => (x.hlc > m ? x.hlc : m), '');
  row.cree_le = versIso(l._existe.hlc);
  row.modifie_le = versIso(derniere);
  d.prepare(`INSERT INTO oeuvres_locales
    (id, ref_local, artiste, titre, date, lieu, description, tags, image, cree_le, modifie_le)
    VALUES (@id, @ref_local, @artiste, @titre, @date, @lieu, @description, @tags, @image, @cree_le, @modifie_le)
    ON CONFLICT(id) DO UPDATE SET
      ref_local=excluded.ref_local, artiste=excluded.artiste, titre=excluded.titre,
      date=excluded.date, lieu=excluded.lieu, description=excluded.description,
      tags=excluded.tags, image=excluded.image, cree_le=excluded.cree_le,
      modifie_le=excluded.modifie_le`).run(row);
}

function projeter(ctx, entite, cle, champ, val, hlc) {
  const d = ctx.d;
  const t = versIso(hlc);
  switch (entite) {
    case 'locale':
      return projeterLocale(ctx, cle);
    case 'override':
      if (val == null) {
        d.prepare('DELETE FROM user_overrides WHERE oeuvre_id=? AND champ=?').run(cle, champ);
      } else {
        d.prepare(`INSERT OR REPLACE INTO user_overrides (oeuvre_id, champ, valeur, valeur_source, cree_le, modifie_le)
          VALUES (?, ?, ?, ?, ?, ?)`).run(cle, champ, val.valeur, val.valeur_source, t, t);
      }
      return;
    case 'archive':
      if (val == null) d.prepare('DELETE FROM user_archive WHERE oeuvre_id=?').run(cle);
      else d.prepare('INSERT OR REPLACE INTO user_archive (oeuvre_id, cree_le) VALUES (?, ?)').run(cle, t);
      return;
    case 'tag':
      if (val == null) d.prepare('DELETE FROM user_tags WHERE oeuvre_id=? AND tag=?').run(cle, champ);
      else d.prepare('INSERT OR REPLACE INTO user_tags (oeuvre_id, tag, cree_le) VALUES (?, ?, ?)').run(cle, champ, t);
      return;
    case 'stat':
      if (val == null) d.prepare('DELETE FROM user_stats WHERE oeuvre_id=? AND appareil=?').run(cle, champ);
      else {
        d.prepare('INSERT OR REPLACE INTO user_stats (oeuvre_id, appareil, vues, dernier_vu) VALUES (?, ?, ?, ?)')
          .run(cle, champ, val.vues, val.dernier_vu || null);
      }
      return;
    default:
      throw new Error('synchro : entite inconnue ' + entite);
  }
}

// --- tetes et conflits ------------------------------------------------------

/** Tetes du champ (ops que personne n'a vues), plus grande HLC d'abord. */
function tetes(ctx, entite, cle, champ) {
  const ops = ctx.d.prepare(
    'SELECT hlc, valeur, base, vus, remplace FROM changements WHERE entite=? AND cle=? AND champ=?'
  ).all(entite, cle, champ);
  const vues = new Set();
  for (const o of ops) {
    if (o.base) vues.add(o.base);
    if (o.vus) for (const h of JSON.parse(o.vus)) vues.add(h);
  }
  // remplace = 1 : op dont on sait (par un snapshot) qu'elle a ete remplacee,
  // meme si le maillon qui la cite nous manque (compaction.rattraper).
  return ops.filter((o) => !vues.has(o.hlc) && !o.remplace).sort((a, b) => (a.hlc < b.hlc ? 1 : -1));
}

function estVisible(entite) {
  return entite === 'locale' || entite === 'override';
}

/** Deux valeurs (JSON brut) different-elles pour l'utilisateur ? */
function differe(entite, champ, a, b) {
  if (entite === 'locale' && champ === '_existe') return (parse(a) === 1) !== (parse(b) === 1);
  if (entite === 'override') {
    const va = parse(a), vb = parse(b);
    return (va ? va.valeur : null) !== (vb ? vb.valeur : null);
  }
  return a !== b;
}

/** Suppression faite sans voir des modifications de la tuile. */
function conflitSuppression(ctx, cle) {
  const t = lire(ctx, 'locale', cle, '_existe');
  if (!t) return null;
  const tv = parse(t.valeur);
  if (tv === 1) return null;
  const vu = (tv && tv.vu) || t.hlc;
  // Parmi les TETES des champs de la tuile (identiques sur tous les appareils,
  // meme ceux repartis d'un snapshot), la plus recente posterieure a `vu`.
  // Un champ vide ecrit apres la suppression n'est pas une « modification » :
  // c'est l'oubli du contenu (compaction.purgerTombes), ou un effacement sans
  // enjeu. Seules les vraies valeurs ouvrent le conflit.
  let m = null;
  for (const r of ctx.d.prepare("SELECT DISTINCT champ FROM changements WHERE entite='locale' AND cle=? AND champ<>'_existe'").all(cle)) {
    for (const h of tetes(ctx, 'locale', cle, r.champ)) {
      if (h.valeur != null && h.hlc > vu && (!m || h.hlc > m.hlc)) m = { hlc: h.hlc, valeur: h.valeur };
    }
  }
  return m ? { g: { hlc: t.hlc, valeur: t.valeur }, p: m } : null;
}

function conflitOuvert(ctx, entite, cle, champ) {
  return ctx.d.prepare('SELECT * FROM conflits WHERE entite=? AND cle=? AND champ=? AND resolu=0')
    .get(entite, cle, champ);
}

/** Met la table conflits en accord avec le journal pour ce champ. */
function recalculerConflit(ctx, entite, cle, champ) {
  if (!estVisible(entite)) return;
  let voulu = null;
  // Champ d'une tuile supprimee : conflit sans objet tant qu'elle l'est (le
  // trancher reviendrait a editer une tuile morte). Recalcule a la restauration.
  const muet = entite === 'locale' && champ !== '_existe' && !existe(ctx, cle);
  const t = muet ? [] : tetes(ctx, entite, cle, champ);
  if (t.length > 1) {
    const p = t.find((x) => differe(entite, champ, x.valeur, t[0].valeur));
    if (p) voulu = { g: t[0], p };
  }
  if (!voulu && entite === 'locale' && champ === '_existe') voulu = conflitSuppression(ctx, cle);

  const d = ctx.d;
  const ouvert = conflitOuvert(ctx, entite, cle, champ);
  if (!voulu) {
    if (ouvert) d.prepare('UPDATE conflits SET resolu=1 WHERE id=?').run(ouvert.id);
    return;
  }
  const { g, p } = voulu;
  if (ouvert) {
    if (ouvert.hlc_gagnant === g.hlc && ouvert.hlc_perdant === p.hlc) return;
    d.prepare(`UPDATE conflits SET hlc_gagnant=?, valeur_gagnante=?, hlc_perdant=?, valeur_perdante=?
      WHERE id=?`).run(g.hlc, g.valeur, p.hlc, p.valeur, ouvert.id);
  } else {
    d.prepare(`INSERT INTO conflits (entite, cle, champ, hlc_gagnant, valeur_gagnante,
      hlc_perdant, valeur_perdante, detecte_le) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(entite, cle, champ, g.hlc, g.valeur, p.hlc, p.valeur, new Date().toISOString());
  }
}

/**
 * Apres une op : conflit du champ, et pour une tuile locale celui de sa
 * suppression — ou, si l'op touche l'existence, ceux de tous ses champs.
 */
function apres(ctx, op) {
  recalculerConflit(ctx, op.entite, op.cle, op.champ);
  if (op.entite !== 'locale') return;
  if (op.champ !== '_existe') { recalculerConflit(ctx, 'locale', op.cle, '_existe'); return; }
  for (const r of ctx.d.prepare("SELECT DISTINCT champ FROM changements WHERE entite='locale' AND cle=? AND champ<>'_existe'").all(op.cle)) {
    recalculerConflit(ctx, 'locale', op.cle, r.champ);
  }
}

/** Valeur de pierre tombale pour une tuile locale : ce que la suppression a vu. */
function pierreTombale(ctx, cle) {
  const r = ctx.d.prepare("SELECT MAX(hlc) h FROM changements WHERE entite='locale' AND cle=?").get(cle);
  return { vu: (r && r.h) || '' };
}

// --- ecriture ---------------------------------------------------------------

function poser(ctx, op) {
  ctx.d.prepare(`INSERT INTO etat (entite, cle, champ, valeur, hlc, base) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(entite, cle, champ) DO UPDATE SET
      valeur=excluded.valeur, hlc=excluded.hlc, base=excluded.base`)
    .run(op.entite, op.cle, op.champ, op.valeur, op.hlc, op.base);
  projeter(ctx, op.entite, op.cle, op.champ, parse(op.valeur), op.hlc);
}

function insererOp(ctx, op, pousse, remplace = 0) {
  ctx.d.prepare(`INSERT INTO changements (hlc, appareil, entite, cle, champ, valeur, base, vus, pousse, remplace)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(op.hlc, op.appareil, op.entite, op.cle, op.champ, op.valeur, op.base, op.vus, pousse, remplace);
}

/**
 * Ecriture locale. No-op (null) si la valeur ne change pas, sauf `force`
 * (trancher un conflit en gardant la valeur affichee : l'op doit partir pour
 * fermer le conflit chez les autres).
 * @returns {string|null} HLC de l'op emise
 */
function ecrire(ctx, entite, cle, champ, val, { force = false } = {}) {
  return ctx.d.transaction(() => {
    const cour = lire(ctx, entite, cle, champ);
    const v = val == null ? null : JSON.stringify(val);
    if (!force && (cour ? cour.valeur === v : v == null)) return null;
    const base = cour ? cour.hlc : null;
    const autres = tetes(ctx, entite, cle, champ).map((t) => t.hlc).filter((h) => h !== base);
    const op = {
      hlc: ctx.horloge.tic(), appareil: ctx.appareil.id, entite, cle, champ,
      valeur: v, base, vus: autres.length ? JSON.stringify(autres) : null
    };
    insererOp(ctx, op, 0);
    poser(ctx, op);
    apres(ctx, op);
    // Annuler / retablir (annuler.js) : valeur avant / apres, JSON brut.
    if (ctx.surEcriture) ctx.surEcriture({ entite, cle, champ, avant: cour ? cour.valeur : null, apres: v });
    return op.hlc;
  })();
}

/** Supprime une tuile locale (pierre tombale). */
function supprimerLocale(ctx, cle) {
  return ecrire(ctx, 'locale', cle, '_existe', pierreTombale(ctx, cle));
}

/**
 * Compteurs de vues de CET appareil -> ops 'stat' (a appeler juste avant un
 * envoi). Le tirage incremente user_stats directement, sans journal : une op
 * par tirage serait du bruit, une op par oeuvre et par envoi suffit.
 * @returns {number} ops emises
 */
function emettreStats(ctx) {
  const id = ctx.appareil.id;
  let n = 0;
  ctx.d.transaction(() => {
    for (const r of ctx.d.prepare('SELECT oeuvre_id, vues, dernier_vu FROM user_stats WHERE appareil=?').all(id)) {
      if (ecrire(ctx, 'stat', r.oeuvre_id, id, { vues: r.vues || 0, dernier_vu: r.dernier_vu || null })) n++;
    }
  })();
  return n;
}

// --- application d'une op distante ------------------------------------------

function jsonOk(v, verif = () => true) {
  if (v == null) return true;
  if (typeof v !== 'string') return false;
  try { return verif(JSON.parse(v)); } catch { return false; }
}

/** Op recue bien formee ? Une op rejetee l'est sur tous les appareils (convergence). */
function valide(op) {
  if (!op || typeof op.hlc !== 'string' || typeof op.cle !== 'string' || typeof op.champ !== 'string') return false;
  if (!ENTITES.includes(op.entite)) return false;
  if (op.entite === 'tag' && !TAGS.includes(op.champ)) return false;
  if (op.base != null && typeof op.base !== 'string') return false;
  const okValeur = op.entite === 'stat'
    ? RE_APPAREIL.test(op.champ) && jsonOk(op.valeur, (v) => v === null || (v && Number.isInteger(v.vues) && v.vues >= 0))
    : jsonOk(op.valeur);
  return okValeur && jsonOk(op.vus, (x) => Array.isArray(x) && x.every((h) => typeof h === 'string'));
}

/**
 * Applique une op venue d'un autre appareil. A appeler dans une transaction.
 * @param {{ pousse?: 0|1, remplace?: 0|1 }} o  pousse = 0 : op a renvoyer a la
 *   prochaine synchro (import d'une sauvegarde : les autres appareils ne l'ont
 *   peut-etre jamais vue) ; remplace : marquage repris de la base d'origine
 * @returns {'connue'|'rejetee'|'avance'|'ignoree'} ignoree = plus ancienne que
 *   la valeur courante (gardee au journal : elle compte pour les conflits)
 */
function appliquer(ctx, r, { pousse = 1, remplace = 0 } = {}) {
  if (!valide(r)) return 'rejetee';
  if (ctx.d.prepare('SELECT 1 FROM changements WHERE hlc=?').get(r.hlc)) return 'connue';
  ctx.horloge.recevoir(r.hlc);
  const op = { hlc: r.hlc, appareil: r.appareil, entite: r.entite, cle: r.cle, champ: r.champ,
    valeur: r.valeur == null ? null : r.valeur, base: r.base || null, vus: r.vus || null };
  insererOp(ctx, op, pousse, remplace ? 1 : 0);
  const v = lire(ctx, op.entite, op.cle, op.champ);
  const avance = !v || op.hlc > v.hlc;
  if (avance) poser(ctx, op);
  apres(ctx, op);
  return avance ? 'avance' : 'ignoree';
}

// --- conflits : lecture et resolution ---------------------------------------

function conflits(ctx) {
  return ctx.d.prepare('SELECT * FROM conflits WHERE resolu=0 ORDER BY detecte_le, id').all()
    .map((c) => ({ ...c, valeur_gagnante: parse(c.valeur_gagnante), valeur_perdante: parse(c.valeur_perdante) }));
}

/**
 * Tranche un conflit. choix = 'gagnant' (garder la valeur affichee) ou
 * 'perdant' (reprendre l'autre). Emet toujours une op, qui cite toutes les
 * tetes : elle ferme le conflit ici et, une fois propagee, chez les autres.
 * Suppression : 'gagnant' confirme l'etat affiche (supprimee ou restauree),
 * 'perdant' bascule dans l'autre.
 */
function resoudre(ctx, id, choix) {
  return ctx.d.transaction(() => {
    const c = ctx.d.prepare('SELECT * FROM conflits WHERE id=?').get(id);
    if (!c || c.resolu) return null;
    if (c.entite === 'locale' && c.champ === '_existe') {
      const gagnantSupprime = parse(c.valeur_gagnante) !== 1;
      const supprimer = choix === 'gagnant' ? gagnantSupprime : !gagnantSupprime;
      return supprimer
        ? ecrire(ctx, 'locale', c.cle, '_existe', pierreTombale(ctx, c.cle), { force: true })
        : ecrire(ctx, 'locale', c.cle, '_existe', 1, { force: true });
    }
    const v = choix === 'gagnant' ? c.valeur_gagnante : c.valeur_perdante;
    return ecrire(ctx, c.entite, c.cle, c.champ, parse(v), { force: true });
  })();
}

module.exports = {
  CHAMPS_LOCALE, TAGS, ENTITES,
  lire, valeur, lignes, existe, ecrire, supprimerLocale, pierreTombale, emettreStats,
  appliquer, tetes, conflits, resoudre, valide, recalculer: apres
};
