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
 * Ce module = l'appareil courant sur la base ouverte (db.instance()). La
 * logique vit dans moteur.js, instanciable (plusieurs appareils en test).
 *
 * Entites :
 *   locale    cle = local:<uuid>  champ = artiste…image | ref_local | _existe
 *   override  cle = p:…           champ = nom du champ   valeur = {valeur, valeur_source}
 *   archive   cle = p:…           champ = '_'            valeur = 1
 *   tag       cle = oeuvre_id     champ = livre | etoile | bad_smiley   valeur = 1
 * valeur NULL = absent (tag retire, override annule).
 * Tuile supprimee : _existe = { vu } (pierre tombale, voir moteur.js).
 *
 * Hors journal : user_stats (compteur par appareil, emis au push — E2d),
 * reglages (propres a chaque appareil), user_corrections (aucun ecrivain au
 * runtime pour l'instant).
 */

const db = require('../db');
const moteur = require('./moteur');
const { creerHorloge, formater } = require('./hlc');
const journal = require('../journal');

const { CHAMPS_LOCALE } = moteur;

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

/** Contexte moteur de l'appareil courant sur la base ouverte. */
function contexte() {
  return { d: db.instance(), appareil: lAppareil(), horloge };
}

const valeur = (entite, cle, champ) => moteur.valeur(contexte(), entite, cle, champ);
const lignes = (entite, cle) => moteur.lignes(contexte(), entite, cle);
const existe = (cle) => moteur.existe(contexte(), cle);
const ecrire = (entite, cle, champ, val, opts) => moteur.ecrire(contexte(), entite, cle, champ, val, opts);
const supprimerLocale = (cle) => moteur.supprimerLocale(contexte(), cle);
const conflits = () => moteur.conflits(contexte());
const resoudre = (id, choix) => moteur.resoudre(contexte(), id, choix);

/** Regroupe plusieurs ecritures dans une seule transaction. */
function lot(fn) {
  return db.instance().transaction(fn)();
}

// --- ouverture : migration + genese --------------------------------------

/** user_stats v1 (cle = oeuvre_id seul) -> un compteur par appareil. */
function migrerStats(d) {
  const cols = d.prepare('PRAGMA table_info(user_stats)').all().map((c) => c.name);
  if (!cols.includes('appareil')) {
    journal.evt('db', 'migration-stats-par-appareil', { lignes: d.prepare('SELECT COUNT(*) n FROM user_stats').get().n });
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
    const cols = d.prepare('PRAGMA table_info(changements)').all().map((c) => c.name);
    if (!cols.includes('vus')) d.exec('ALTER TABLE changements ADD COLUMN vus TEXT');
    const faite = d.prepare("SELECT valeur FROM sync WHERE cle = 'genese_faite'").get();
    if (!faite) {
      const n = genese(d);
      d.prepare("INSERT OR REPLACE INTO sync (cle, valeur) VALUES ('genese_faite', ?)")
        .run(JSON.stringify({ le: new Date().toISOString(), appareil: appareil.id, ops: n }));
      journal.evt('synchro', 'genese', { appareil: appareil.id, ops: n });
    }
  })();
  const max = d.prepare('SELECT MAX(hlc) h FROM changements').get().h;
  horloge.caler(max);
  journal.evt('synchro', 'journal-local', {
    appareil: appareil.id, prefixe: appareil.prefixe_ref, derniereHlc: max,
    ops: d.prepare('SELECT COUNT(*) n FROM changements').get().n,
    aPousser: d.prepare('SELECT COUNT(*) n FROM changements WHERE pousse=0').get().n,
    conflitsOuverts: d.prepare('SELECT COUNT(*) n FROM conflits WHERE resolu=0').get().n
  });
}

module.exports = {
  configurer, contexte, appareil: lAppareil, valeur, lignes, existe, ecrire, supprimerLocale,
  lot, conflits, resoudre, CHAMPS_LOCALE
};
