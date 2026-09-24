'use strict';
/**
 * Couche synchronisable de utilisateur.db : registre `etat` + journal
 * `changements`.
 *
 * Toute ecriture de donnee utilisateur synchronisable passe par ecrire() :
 * dans une meme transaction, elle emet une op (HLC + base), met a jour le
 * registre, puis projette dans la table lue par le reste de l'app
 * (user_tags, user_archive, user_overrides, oeuvres_locales). Le code de
 * lecture ne change donc pas.
 *
 * Entites :
 *   locale    cle = local:<uuid>  champ = artiste…image | ref_local | _existe
 *   override  cle = p:…           champ = nom du champ   valeur = {valeur, valeur_source}
 *   archive   cle = p:…           champ = '_'            valeur = 1
 *   tag       cle = oeuvre_id     champ = livre | etoile | bad_smiley   valeur = 1
 * valeur NULL = absent (tag retire, override annule, tuile supprimee).
 *
 * Hors journal : user_stats (compteur par appareil, emis au push — E2d),
 * reglages (propres a chaque appareil), user_corrections (aucun ecrivain au
 * runtime pour l'instant).
 */

const db = require('../db');
const { creerHorloge, formater, versIso } = require('./hlc');

const CHAMPS_LOCALE = ['artiste', 'titre', 'date', 'lieu', 'description', 'tags', 'image'];

let appareil = null;
let horloge = null;
let accroche = false;

/**
 * A appeler avant db.ouvrir().
 * @param {{ appareil: { id, nom, prefixe_ref }, maintenant?: () => number }} cfg
 */
function configurer(cfg) {
  appareil = cfg.appareil;
  horloge = creerHorloge(appareil.id, { maintenant: cfg.maintenant });
  if (!accroche) { db.surOuverture(preparer); accroche = true; }
}

function lAppareil() {
  if (!appareil) throw new Error('synchro/etat : configurer() pas appele.');
  return appareil;
}

// --- lecture du registre ------------------------------------------------

function parse(v) { return v == null ? null : JSON.parse(v); }

/** Valeur courante d'un champ (null si absent). */
function valeur(entite, cle, champ) {
  const r = db.instance().prepare('SELECT valeur FROM etat WHERE entite=? AND cle=? AND champ=?')
    .get(entite, cle, champ);
  return r ? parse(r.valeur) : null;
}

/** Tous les champs d'une cle : { champ: { valeur, hlc } }. */
function lignes(entite, cle) {
  const out = {};
  for (const r of db.instance().prepare('SELECT champ, valeur, hlc FROM etat WHERE entite=? AND cle=?')
    .all(entite, cle)) {
    out[r.champ] = { valeur: parse(r.valeur), hlc: r.hlc };
  }
  return out;
}

// --- projections ----------------------------------------------------------

function projeterLocale(d, cle) {
  const l = lignes('locale', cle);
  if (!l._existe || l._existe.valeur == null) {
    d.prepare('DELETE FROM oeuvres_locales WHERE id=?').run(cle);
    return;
  }
  const row = { id: cle, ref_local: l.ref_local ? l.ref_local.valeur : null };
  for (const c of CHAMPS_LOCALE) row[c] = l[c] && l[c].valeur != null ? String(l[c].valeur) : '';
  // Dates derivees des HLC : creation = op _existe, modification = derniere op.
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

function projeter(d, entite, cle, champ, val, hlc) {
  const t = versIso(hlc);
  switch (entite) {
    case 'locale':
      return projeterLocale(d, cle);
    case 'override':
      if (val == null) {
        d.prepare('DELETE FROM user_overrides WHERE oeuvre_id=? AND champ=?').run(cle, champ);
      } else {
        d.prepare(`INSERT INTO user_overrides (oeuvre_id, champ, valeur, valeur_source, cree_le, modifie_le)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(oeuvre_id, champ) DO UPDATE SET
            valeur=excluded.valeur, valeur_source=excluded.valeur_source, modifie_le=excluded.modifie_le`)
          .run(cle, champ, val.valeur, val.valeur_source, t, t);
      }
      return;
    case 'archive':
      if (val == null) d.prepare('DELETE FROM user_archive WHERE oeuvre_id=?').run(cle);
      else d.prepare('INSERT OR IGNORE INTO user_archive (oeuvre_id, cree_le) VALUES (?, ?)').run(cle, t);
      return;
    case 'tag':
      if (val == null) d.prepare('DELETE FROM user_tags WHERE oeuvre_id=? AND tag=?').run(cle, champ);
      else d.prepare('INSERT OR REPLACE INTO user_tags (oeuvre_id, tag, cree_le) VALUES (?, ?, ?)').run(cle, champ, t);
      return;
    default:
      throw new Error('synchro/etat : entite inconnue ' + entite);
  }
}

// --- ecriture -------------------------------------------------------------

/**
 * Ecrit un champ synchronise. No-op (null) si la valeur ne change pas : pas
 * d'op fantome dans le journal.
 * @param {*} val valeur JSON-serialisable, null/undefined = absent
 * @returns {string|null} HLC de l'op emise
 */
function ecrire(entite, cle, champ, val) {
  lAppareil();
  const d = db.instance();
  return d.transaction(() => {
    const cour = d.prepare('SELECT hlc, valeur FROM etat WHERE entite=? AND cle=? AND champ=?')
      .get(entite, cle, champ);
    const v = val == null ? null : JSON.stringify(val);
    if (cour ? cour.valeur === v : v == null) return null;
    const h = horloge.tic();
    const base = cour ? cour.hlc : null;
    d.prepare(`INSERT INTO changements (hlc, appareil, entite, cle, champ, valeur, base, pousse)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)`).run(h, appareil.id, entite, cle, champ, v, base);
    d.prepare(`INSERT INTO etat (entite, cle, champ, valeur, hlc, base) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(entite, cle, champ) DO UPDATE SET
        valeur=excluded.valeur, hlc=excluded.hlc, base=excluded.base`)
      .run(entite, cle, champ, v, h, base);
    projeter(d, entite, cle, champ, parse(v), h);
    return h;
  })();
}

/** Regroupe plusieurs ecrire() dans une seule transaction. */
function lot(fn) {
  return db.instance().transaction(fn)();
}

// --- ouverture : migration + genese --------------------------------------

/** user_stats v1 (cle = oeuvre_id seul) -> un compteur par appareil. */
function migrerStats(d) {
  const cols = d.prepare('PRAGMA table_info(user_stats)').all().map((c) => c.name);
  if (!cols.includes('appareil')) {
    d.exec(`
      ALTER TABLE user_stats RENAME TO user_stats_v1;
      CREATE TABLE user_stats (
        oeuvre_id   TEXT NOT NULL,
        appareil    TEXT NOT NULL DEFAULT '',
        vues        INTEGER DEFAULT 0,
        dernier_vu  TEXT,
        PRIMARY KEY (oeuvre_id, appareil)
      );
      INSERT INTO user_stats (oeuvre_id, appareil, vues, dernier_vu)
        SELECT oeuvre_id, '', vues, dernier_vu FROM user_stats_v1;
      DROP TABLE user_stats_v1;`);
  }
  // Lignes orphelines d'appareil (v1, migration tuiles.db) -> cet appareil.
  d.prepare(`INSERT INTO user_stats (oeuvre_id, appareil, vues, dernier_vu)
      SELECT oeuvre_id, ?, vues, dernier_vu FROM user_stats WHERE appareil = ''
    ON CONFLICT(oeuvre_id, appareil) DO UPDATE SET
      vues = vues + excluded.vues,
      dernier_vu = NULLIF(max(COALESCE(dernier_vu, ''), COALESCE(excluded.dernier_vu, '')), '')`)
    .run(appareil.id);
  d.prepare("DELETE FROM user_stats WHERE appareil = ''").run();
}

function msDe(iso, maintenant) {
  const ms = Date.parse(iso || '');
  // Date absente -> la plus ancienne possible : elle ne doit gagner contre rien.
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), maintenant) : 0;
}

/**
 * Genese : une op par ligne deja presente dans les tables user, une seule
 * fois par base. HLC = date REELLE de la ligne (cree_le / modifie_le) : a la
 * fusion avec un autre appareil, c'est la valeur modifiee le plus recemment
 * qui gagne, pas celle de l'appareil active en dernier.
 * @returns {number} nombre d'ops emises
 */
function genese(d) {
  const now = Date.now();
  const ops = [];
  const pousser = (iso, entite, cle, champ, val) =>
    ops.push({ ms: msDe(iso, now), entite, cle, champ, valeur: JSON.stringify(val) });

  for (const r of d.prepare('SELECT * FROM oeuvres_locales').all()) {
    const modif = r.modifie_le || r.cree_le;
    pousser(r.cree_le, 'locale', r.id, '_existe', 1);
    if (r.ref_local) pousser(r.cree_le, 'locale', r.id, 'ref_local', r.ref_local);
    for (const c of CHAMPS_LOCALE) if (r[c]) pousser(modif, 'locale', r.id, c, r[c]);
  }
  for (const r of d.prepare('SELECT * FROM user_overrides').all()) {
    pousser(r.modifie_le || r.cree_le, 'override', r.oeuvre_id, r.champ,
      { valeur: r.valeur, valeur_source: r.valeur_source });
  }
  for (const r of d.prepare('SELECT * FROM user_archive').all()) {
    pousser(r.cree_le, 'archive', r.oeuvre_id, '_', 1);
  }
  for (const r of d.prepare('SELECT * FROM user_tags').all()) {
    pousser(r.cree_le, 'tag', r.oeuvre_id, r.tag, 1);
  }

  // Compteur par milliseconde : plusieurs champs d'une meme tuile partagent sa date.
  const cpt = new Map();
  const insChg = d.prepare(`INSERT INTO changements (hlc, appareil, entite, cle, champ, valeur, base, pousse)
    VALUES (?, ?, ?, ?, ?, ?, NULL, 0)`);
  const insEtat = d.prepare(`INSERT OR IGNORE INTO etat (entite, cle, champ, valeur, hlc, base)
    VALUES (?, ?, ?, ?, ?, NULL)`);
  for (const o of ops) {
    const n = cpt.get(o.ms) || 0;
    cpt.set(o.ms, n + 1);
    const h = formater(o.ms, n, appareil.id);
    insChg.run(h, appareil.id, o.entite, o.cle, o.champ, o.valeur);
    insEtat.run(o.entite, o.cle, o.champ, o.valeur, h);
  }
  return ops.length;
}

/**
 * Hook d'ouverture (db.surOuverture) : migre user_stats, fait la genese si la
 * base n'en a jamais eu, recale l'horloge sur la plus grande HLC connue.
 * Tourne aussi apres un import zip : une sauvegarde d'avant E2a y passe en
 * genese, une sauvegarde recente garde son journal.
 */
function preparer(d) {
  lAppareil();
  d.transaction(() => {
    migrerStats(d);
    const faite = d.prepare("SELECT valeur FROM sync WHERE cle = 'genese_faite'").get();
    if (!faite) {
      const n = genese(d);
      d.prepare("INSERT OR REPLACE INTO sync (cle, valeur) VALUES ('genese_faite', ?)")
        .run(JSON.stringify({ le: new Date().toISOString(), appareil: appareil.id, ops: n }));
    }
  })();
  const max = d.prepare('SELECT MAX(hlc) h FROM changements').get().h;
  horloge.caler(max);
}

module.exports = {
  configurer, appareil: lAppareil, valeur, lignes, ecrire, lot, CHAMPS_LOCALE
};
