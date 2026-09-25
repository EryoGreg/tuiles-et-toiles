'use strict';
/**
 * Deux bases, deux proprietaires.
 *
 *   pack.db  (attachee sous l'alias `pack`, LECTURE SEULE par convention)
 *     oeuvres      le contenu du pack, remplace en bloc a chaque MAJ de pack
 *     pack_meta    version / hash / date du pack
 *
 *   utilisateur.db  (connexion principale, INSCRIPTIBLE)
 *     user_tags, user_stats, user_corrections   marques et progression
 *     user_archive        oeuvres du pack masquees par l'utilisateur
 *     user_overrides      corrections de champs sur une oeuvre du pack
 *     oeuvres_locales     tuiles creees par l'utilisateur
 *     reglages, sync      preferences et etat de synchro
 *
 * Une MAJ de pack = remplacer pack.db. utilisateur.db n'est jamais touche.
 * Les tables user_* pointent vers les oeuvres par leur `id` (stable a vie),
 * jamais par leur `ref` (numero d'affichage).
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const journal = require('./journal');

// --- schemas -------------------------------------------------------------

const SCHEMA_PACK = `
CREATE TABLE IF NOT EXISTS oeuvres (
  id          TEXT PRIMARY KEY,   -- identifiant stable, jamais reutilise
  ref         TEXT,               -- numero d'affichage fige ("002".."432")
  artiste     TEXT DEFAULT '',
  titre       TEXT DEFAULT '',
  date        TEXT DEFAULT '',
  lieu        TEXT DEFAULT '',
  description TEXT DEFAULT '',
  tags        TEXT DEFAULT '',
  image       TEXT DEFAULT '',
  largeur     INTEGER,
  hauteur     INTEGER,
  octets      INTEGER,
  hash_texte  TEXT,               -- hash du contenu, sert a detecter un conflit d'override
  recherche   TEXT,               -- champ normalise pour la recherche permissive
  masques     TEXT                -- JSON : masques valides precalcules
);
CREATE INDEX IF NOT EXISTS idx_oeuvres_recherche ON oeuvres(recherche);
CREATE TABLE IF NOT EXISTS pack_meta (cle TEXT PRIMARY KEY, valeur TEXT);
`;

const SCHEMA_USER = `
CREATE TABLE IF NOT EXISTS user_tags (
  oeuvre_id TEXT NOT NULL,
  tag       TEXT NOT NULL CHECK (tag IN ('livre', 'etoile', 'bad_smiley')),
  cree_le   TEXT NOT NULL,
  PRIMARY KEY (oeuvre_id, tag)
);

-- Un compteur PAR APPAREIL : a la synchro, les vues s'additionnent (3 ici +
-- 2 sur le telephone = 5) au lieu de s'ecraser. Total = SUM(vues).
-- appareil = '' : ligne venue d'une base v1, rattachee a l'appareil courant a
-- l'ouverture (synchro/etat.js).
CREATE TABLE IF NOT EXISTS user_stats (
  oeuvre_id   TEXT NOT NULL,
  appareil    TEXT NOT NULL DEFAULT '',
  vues        INTEGER DEFAULT 0,
  dernier_vu  TEXT,
  PRIMARY KEY (oeuvre_id, appareil)
);

CREATE TABLE IF NOT EXISTS user_corrections (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  oeuvre_id TEXT NOT NULL,
  texte     TEXT NOT NULL,
  cree_le   TEXT NOT NULL,
  exporte   INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS reglages (cle TEXT PRIMARY KEY, valeur TEXT);
CREATE TABLE IF NOT EXISTS sync    (cle TEXT PRIMARY KEY, valeur TEXT);

-- Oeuvres du pack que l'utilisateur ne veut plus voir. Archivees, jamais
-- supprimees : si le pack les reconduit, elles restent masquees.
CREATE TABLE IF NOT EXISTS user_archive (
  oeuvre_id TEXT PRIMARY KEY,
  cree_le   TEXT NOT NULL
);

-- Corrections de champ sur une oeuvre DU PACK. valeur_source = ce que le pack
-- affichait au moment de la correction, pour reperer un conflit apres MAJ.
CREATE TABLE IF NOT EXISTS user_overrides (
  oeuvre_id     TEXT NOT NULL,
  champ         TEXT NOT NULL,
  valeur        TEXT,
  valeur_source TEXT,
  cree_le       TEXT NOT NULL,
  modifie_le    TEXT,
  PRIMARY KEY (oeuvre_id, champ)
);

-- Tuiles creees par l'utilisateur. Meme forme que pack.oeuvres, plus les dates.
CREATE TABLE IF NOT EXISTS oeuvres_locales (
  id          TEXT PRIMARY KEY,   -- "local:<uuid>"
  ref_local   TEXT,               -- "L1", "L2"...
  artiste     TEXT DEFAULT '',
  titre       TEXT DEFAULT '',
  date        TEXT DEFAULT '',
  lieu        TEXT DEFAULT '',
  description TEXT DEFAULT '',
  tags        TEXT DEFAULT '',
  image       TEXT DEFAULT '',    -- nom de fichier dans images-locales/
  largeur     INTEGER,
  hauteur     INTEGER,
  octets      INTEGER,
  hash_texte  TEXT,
  recherche   TEXT,
  masques     TEXT,
  cree_le     TEXT NOT NULL,
  modifie_le  TEXT
);

-- Vue MATERIALISEE = pack (moins user_archive, overrides plies) + oeuvres_locales.
-- recherche et masques y sont recalcules. Toutes les lectures de contenu la
-- visent ; reconstruite a l'ouverture et apres chaque ecriture de couche user.
CREATE TABLE IF NOT EXISTS oeuvres_effectives (
  id          TEXT PRIMARY KEY,
  ref         TEXT,
  est_locale  INTEGER DEFAULT 0,
  artiste     TEXT DEFAULT '',
  titre       TEXT DEFAULT '',
  date        TEXT DEFAULT '',
  lieu        TEXT DEFAULT '',
  description TEXT DEFAULT '',
  tags        TEXT DEFAULT '',
  image       TEXT DEFAULT '',
  largeur     INTEGER,
  hauteur     INTEGER,
  octets      INTEGER,
  recherche   TEXT,
  masques     TEXT,
  cree_le     TEXT                -- tuile locale : sa creation ; oeuvre du pack : NULL
);
CREATE INDEX IF NOT EXISTS idx_effectives_recherche ON oeuvres_effectives(recherche);

-- Synchro (synchro/etat.js). etat = derniere version connue de chaque champ
-- synchronise : c'est la source de verite, user_tags / user_archive /
-- user_overrides / oeuvres_locales en sont des projections. Garde aussi les
-- valeurs d'une tuile supprimee (pierre tombale _existe = {vu}) pour pouvoir
-- la restaurer. valeur = JSON, NULL = absent.
CREATE TABLE IF NOT EXISTS etat (
  entite  TEXT NOT NULL,   -- 'locale' | 'override' | 'archive' | 'tag'
  cle     TEXT NOT NULL,   -- oeuvre_id
  champ   TEXT NOT NULL,   -- nom du champ, tag, '_existe', '_'
  valeur  TEXT,
  hlc     TEXT NOT NULL,   -- version courante
  base    TEXT,            -- version qu'elle a remplacee
  PRIMARY KEY (entite, cle, champ)
);

-- Journal des operations, locales et recues. hlc unique (suffixe appareil)
-- -> rejouer une op deja connue ne fait rien. pousse = 0 : pas encore envoyee.
CREATE TABLE IF NOT EXISTS changements (
  hlc       TEXT PRIMARY KEY,
  appareil  TEXT NOT NULL,
  entite    TEXT NOT NULL,
  cle       TEXT NOT NULL,
  champ     TEXT NOT NULL,
  valeur    TEXT,
  base      TEXT,
  vus       TEXT,              -- JSON : autres tetes du champ connues a l'ecriture
  remplace  INTEGER NOT NULL DEFAULT 0,  -- 1 : remplacee (su par un snapshot), jamais une tete
  pousse    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_chg_cle ON changements(entite, cle, champ);
CREATE INDEX IF NOT EXISTS idx_chg_a_pousser ON changements(pousse) WHERE pousse = 0;

-- Modifications concurrentes d'un meme champ (aucune n'a vu l'autre).
-- Deduite du journal (synchro/moteur.js) : ouverte tant que le champ a
-- plusieurs tetes de valeurs differentes, fermee par une ecriture qui les cite.
CREATE TABLE IF NOT EXISTS conflits (
  id               INTEGER PRIMARY KEY,
  entite           TEXT NOT NULL,
  cle              TEXT NOT NULL,
  champ            TEXT NOT NULL,
  hlc_gagnant      TEXT NOT NULL,
  valeur_gagnante  TEXT,
  hlc_perdant      TEXT NOT NULL,
  valeur_perdante  TEXT,
  detecte_le       TEXT NOT NULL,
  resolu           INTEGER NOT NULL DEFAULT 0
);
-- Au plus un conflit ouvert par champ (voir moteur.recalculerConflit).
CREATE UNIQUE INDEX IF NOT EXISTS idx_conflit_ouvert ON conflits(entite, cle, champ) WHERE resolu = 0;
`;

const CHAMPS_TXT = ['artiste', 'titre', 'date', 'lieu', 'description', 'tags'];

let db = null;

// Appeles a chaque ouverture (lancement, apres un import zip), avant la
// reconstruction de la vue : migrations et genese du journal (synchro/etat.js).
const apresOuverture = [];
function surOuverture(fn) { apresOuverture.push(fn); }

/**
 * Ouvre utilisateur.db (inscriptible) et attache pack.db en lecture.
 * @param {string} cheminUser
 * @param {string} cheminPack
 */
function ouvrir(cheminUser, cheminPack) {
  if (db) return db;
  const fin = journal.chrono('db', 'ouvrir', { user: cheminUser, pack: cheminPack });
  fs.mkdirSync(path.dirname(cheminUser), { recursive: true });
  db = new Database(cheminUser);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_USER);
  // Vue d'avant la date d'ajout : colonne ajoutee (la vue est derivee, elle
  // se remplit a la reconstruction).
  if (!db.prepare('PRAGMA table_info(oeuvres_effectives)').all().some((c) => c.name === 'cree_le')) {
    db.exec('ALTER TABLE oeuvres_effectives ADD COLUMN cree_le TEXT');
    journal.evt('db', 'migration-vue-date-ajout');
  }
  db.prepare('ATTACH DATABASE ? AS pack').run(cheminPack);
  for (const fn of apresOuverture) fn(db);
  reconstruireVue();   // au lancement : peut sauter si la couche user est vide
  fin({ userOctets: fs.statSync(cheminUser).size, packVersion: (db.prepare("SELECT valeur FROM pack.pack_meta WHERE cle='version'").get() || {}).valeur });
  return db;
}

function instance() {
  if (!db) throw new Error('Base non ouverte : appeler ouvrir() d abord.');
  return db;
}

/** Ferme la connexion (avant de remplacer le fichier utilisateur.db). */
function fermer() {
  if (db) { db.close(); db = null; journal.debug('db', 'fermer'); }
}

/**
 * Copie transactionnellement propre de utilisateur.db (sans -wal, sans la base
 * pack attachee). `cible` ne doit pas exister.
 */
function exporterVers(cible) {
  instance().prepare('VACUUM INTO ?').run(cible);
}

/**
 * Reconstruit `oeuvres_effectives` = pack.oeuvres (moins user_archive,
 * overrides plies) + oeuvres_locales. Recalcule `recherche` et `masques` sur
 * l'ensemble (les masques dependent de tout le corpus). ~100 ms pour 431.
 *
 * force=false (au lancement) : saute si la couche user est ENTIEREMENT vide,
 * que le pack n'a pas change et que la vue est deja peuplee — dans ce cas la
 * vue = copie exacte du pack, rien a refaire. Des tables vides ne peuvent pas
 * cacher un changement -> ce raccourci est incassable.
 * force=true : apres toute ecriture user, appeler avec force puis
 * jeu.reinitialiserSac().
 */
function reconstruireVue({ force = false } = {}) {
  const d = instance();
  const { normaliser, calculer } = require('./masques');

  const hashPack = (d.prepare("SELECT valeur FROM pack.pack_meta WHERE cle = 'hash'").get() || {}).valeur || '';

  if (!force) {
    const vide =
      d.prepare('SELECT COUNT(*) n FROM user_archive').get().n === 0 &&
      d.prepare('SELECT COUNT(*) n FROM user_overrides').get().n === 0 &&
      d.prepare('SELECT COUNT(*) n FROM oeuvres_locales').get().n === 0;
    const dejaPeuplee = d.prepare('SELECT COUNT(*) n FROM oeuvres_effectives').get().n > 0;
    if (vide && dejaPeuplee && reglage('vue_pack_hash') === hashPack) {
      journal.debug('db', 'vue-a-jour', { raison: 'couche user vide, pack inchange' });
      return;
    }
  }
  const t0 = Date.now();

  const archive = new Set(
    d.prepare('SELECT oeuvre_id FROM user_archive').all().map((r) => r.oeuvre_id)
  );
  const overrides = {};
  for (const r of d.prepare('SELECT oeuvre_id, champ, valeur FROM user_overrides').all()) {
    (overrides[r.oeuvre_id] || (overrides[r.oeuvre_id] = {}))[r.champ] = r.valeur;
  }

  const effectives = [];
  for (const o of d.prepare('SELECT * FROM pack.oeuvres').all()) {
    if (archive.has(o.id)) continue;
    const ov = overrides[o.id] || {};
    const e = { id: o.id, ref: o.ref, est_locale: 0, image: ('image' in ov) ? ov.image : o.image,
      largeur: o.largeur, hauteur: o.hauteur, octets: o.octets, cree_le: null };
    for (const c of CHAMPS_TXT) e[c] = (c in ov) ? ov[c] : o[c];
    effectives.push(e);
  }
  for (const o of d.prepare('SELECT * FROM oeuvres_locales').all()) {
    const e = { id: o.id, ref: o.ref_local, est_locale: 1, image: o.image,
      largeur: o.largeur, hauteur: o.hauteur, octets: o.octets, cree_le: o.cree_le };
    for (const c of CHAMPS_TXT) e[c] = o[c];
    effectives.push(e);
  }

  const masques = calculer(effectives);   // clef = id (valeur('image') renvoie o.id)

  const ins = d.prepare(`INSERT INTO oeuvres_effectives
    (id, ref, est_locale, artiste, titre, date, lieu, description, tags, image,
     largeur, hauteur, octets, recherche, masques, cree_le)
    VALUES
    (@id, @ref, @est_locale, @artiste, @titre, @date, @lieu, @description, @tags, @image,
     @largeur, @hauteur, @octets, @recherche, @masques, @cree_le)`);
  d.transaction(() => {
    d.exec('DELETE FROM oeuvres_effectives');
    for (const e of effectives) {
      ins.run({
        ...e,
        // ref inclus : chercher "L1" ou "329" trouve la tuile.
        recherche: normaliser([e.ref, ...CHAMPS_TXT.map((c) => e[c] || '')].join(' ')),
        masques: JSON.stringify(masques.get(e.id) || [])
      });
    }
  })();

  definirReglage('vue_pack_hash', hashPack);
  const sansMasque = effectives.filter((e) => !(masques.get(e.id) || []).length).map((e) => e.ref);
  journal.evt('db', 'vue-reconstruite', {
    force, oeuvres: effectives.length, archivees: archive.size, overrides: Object.keys(overrides).length,
    locales: effectives.filter((e) => e.est_locale).length, sansMasque: sansMasque.length ? sansMasque : undefined,
    ms: Date.now() - t0
  }, sansMasque.length ? 'WARN' : 'DEBUG');
}

/**
 * Cree utilisateur.db et y recopie les tables user_* d'une base v1
 * (tuiles.db monolithique). Les tags sont re-cles vers les identifiants
 * stables via le registre {slug: {id}}. Sans correspondance -> tag ignore.
 */
function migrer(cheminAncien, cheminUser, registre = {}) {
  const u = new Database(cheminUser);
  u.pragma('journal_mode = WAL');
  u.exec(SCHEMA_USER);

  const a = new Database(cheminAncien, { readonly: true, fileMustExist: true });
  const slugVersId = {};
  for (const [slug, e] of Object.entries(registre)) slugVersId[slug] = e.id;

  const table = (nom) => {
    try { return a.prepare('SELECT * FROM ' + nom).all(); } catch { return []; }
  };

  const tx = u.transaction(() => {
    for (const r of table('user_tags')) {
      const id = slugVersId[r.oeuvre_id] || null;
      if (!id) continue;
      u.prepare('INSERT OR IGNORE INTO user_tags (oeuvre_id, tag, cree_le) VALUES (?, ?, ?)')
        .run(id, r.tag, r.cree_le || new Date().toISOString());
    }
    for (const r of table('user_stats')) {
      const id = slugVersId[r.oeuvre_id] || null;
      if (!id) continue;
      u.prepare('INSERT OR IGNORE INTO user_stats (oeuvre_id, vues, dernier_vu) VALUES (?, ?, ?)')
        .run(id, r.vues || 0, r.dernier_vu || null);
    }
    for (const r of table('user_corrections')) {
      const id = slugVersId[r.oeuvre_id] || null;
      if (!id) continue;
      u.prepare('INSERT INTO user_corrections (oeuvre_id, texte, cree_le, exporte) VALUES (?, ?, ?, ?)')
        .run(id, r.texte, r.cree_le || new Date().toISOString(), r.exporte || 0);
    }
    for (const r of table('reglages')) {
      u.prepare('INSERT OR REPLACE INTO reglages (cle, valeur) VALUES (?, ?)').run(r.cle, r.valeur);
    }
    for (const r of table('sync')) {
      u.prepare('INSERT OR REPLACE INTO sync (cle, valeur) VALUES (?, ?)').run(r.cle, r.valeur);
    }
  });
  tx();

  a.close();
  u.close();
}

// --- oeuvres (pack, lecture seule) --------------------------------------

function compterOeuvres() {
  return instance().prepare('SELECT COUNT(*) n FROM oeuvres_effectives').get().n;
}

function oeuvre(id) {
  return instance().prepare('SELECT * FROM oeuvres_effectives WHERE id = ?').get(id);
}

function packMeta() {
  const out = {};
  for (const r of instance().prepare('SELECT cle, valeur FROM pack.pack_meta').all()) {
    out[r.cle] = r.valeur;
  }
  return out;
}

/**
 * Clauses SQL « chaque mot doit apparaitre » pour une recherche texte
 * permissive (accents / casse / ponctuation deja neutralises par normaliser).
 *
 * Un mot doit etre le DEBUT d'un mot indexe, pas un fragment quelconque :
 * « art deco » trouve les tuiles taggees « Art deco » mais plus #066
 * (« martin » contient « art », « decor » contient « deco » — deux faux
 * positifs qui se combinaient). « mauric » trouve toujours « Maurice ».
 * `recherche` est une chaine de mots separes par des espaces ; on prefixe
 * une espace pour que le 1er mot compte aussi comme un debut de mot.
 *
 * Un mot purement numerique matche en plus le numero de tuile (fragment ok :
 * « 66 » retrouve #066).
 */
function clausesTexte(texte, colRecherche = 'recherche', colRef = 'ref') {
  const { normaliser } = require('./masques');
  const sql = [];
  const params = [];
  for (const mot of normaliser(texte || '').split(' ').filter(Boolean)) {
    if (/^\d+$/.test(mot)) {
      sql.push(`((' ' || ${colRecherche}) LIKE ? OR ${colRef} LIKE ?)`);
      params.push('% ' + mot + '%', '%' + mot + '%');
    } else {
      sql.push(`(' ' || ${colRecherche}) LIKE ?`);
      params.push('% ' + mot + '%');
    }
  }
  return { sql, params };
}

/**
 * Recherche permissive : accents, casse et ponctuation ignores des deux cotes.
 * « Simoné teSt. » trouve « Simone, test ».
 *
 * `categories` (optionnel) : filtre supplementaire sur la COLONNE tags, comme
 * parCategorie. soustractif=false -> l'oeuvre porte AU MOINS UN des tags ;
 * soustractif=true -> elle les porte TOUS.
 */
function chercher({ texte = '', categories = null, soustractif = false, limite = 200 } = {}) {
  const { normaliser } = require('./masques');
  let sql = 'SELECT * FROM oeuvres_effectives WHERE 1 = 1';
  const { sql: cs, params } = clausesTexte(texte);
  for (const c of cs) sql += ' AND ' + c;
  sql += ' ORDER BY ref';
  let rows = instance().prepare(sql).all(...params);

  const cibles = [...new Set(categories || [])].filter(Boolean);
  if (cibles.length) {
    rows = rows.filter((o) => {
      const tg = new Set(String(o.tags || '').split(',').map((s) => normaliser(s)).filter(Boolean));
      return soustractif ? cibles.every((c) => tg.has(c)) : cibles.some((c) => tg.has(c));
    });
  }
  return rows.slice(0, limite);
}

/**
 * Oeuvres filtrees par categories de jeu. Le champ `tags` est decoupe par ','
 * et normalise valeur par valeur ; le filtre porte sur la COLONNE tags, pas
 * sur le texte libre.
 *   soustractif=false (additif) : l'oeuvre porte AU MOINS UNE des `valeurs`
 *   soustractif=true            : l'oeuvre porte TOUTES les `valeurs`
 */
function parCategorie(valeurs, soustractif = false) {
  const { normaliser } = require('./masques');
  const cibles = [...new Set(Array.isArray(valeurs) ? valeurs : [valeurs])].filter(Boolean);
  if (!cibles.length) return [];
  return instance().prepare('SELECT * FROM oeuvres_effectives').all().filter((o) => {
    const tags = new Set(String(o.tags || '').split(',').map((s) => normaliser(s)).filter(Boolean));
    return soustractif
      ? cibles.every((c) => tags.has(c))
      : cibles.some((c) => tags.has(c));
  });
}

/** Recherche par numero, tolerante aux zeros superflus ou manquants. */
function parNumero(saisie) {
  const n = parseInt(String(saisie).replace(/\D/g, ''), 10);
  if (!Number.isFinite(n)) return [];
  return instance().prepare(
    'SELECT * FROM oeuvres_effectives WHERE CAST(ref AS INTEGER) = ?'
  ).all(n);
}

// --- tags utilisateur --------------------------------------------------

function tagsDe(oeuvreId) {
  return instance().prepare('SELECT tag FROM user_tags WHERE oeuvre_id = ?')
    .all(oeuvreId).map((r) => r.tag);
}

// Les ecritures de tags passent par le journal (etat.ecrire projette dans
// user_tags). require paresseux : synchro/etat depend de ce module.
function basculerTag(oeuvreId, tag) {
  const etat = require('./synchro/etat');
  const actif = etat.valeur('tag', oeuvreId, tag) != null;
  etat.ecrire('tag', oeuvreId, tag, actif ? null : 1);
  return !actif;
}

/**
 * Oeuvres portant un tag utilisateur, dans l'ordre CHRONOLOGIQUE d'ajout du
 * tag. tag_cree_le remonte avec l'oeuvre : le rendu peut reordonner sans
 * refaire d'appel.
 */
function parTagUtilisateur(tag, texte = '') {
  let sql = `SELECT o.*, t.cree_le AS tag_cree_le FROM oeuvres_effectives o
       JOIN user_tags t ON t.oeuvre_id = o.id
      WHERE t.tag = ?`;
  const { sql: cs, params: cp } = clausesTexte(texte, 'o.recherche', 'o.ref');
  for (const c of cs) sql += ' AND ' + c;
  sql += ' ORDER BY t.cree_le, o.ref';
  return instance().prepare(sql).all(tag, ...cp);
}

/**
 * Retire toutes les marques livre / etoile / bad_smiley des tuiles visibles
 * (celles d'une tuile en Corbeille reviennent avec elle). @returns {number}
 */
function effacerTousLesTags() {
  const etat = require('./synchro/etat');
  const lignes = instance().prepare(
    'SELECT t.oeuvre_id, t.tag FROM user_tags t JOIN oeuvres_effectives o ON o.id = t.oeuvre_id'
  ).all();
  etat.lot(() => { for (const r of lignes) etat.ecrire('tag', r.oeuvre_id, r.tag, null); });
  return lignes.length;
}

function comptesTags() {
  // Tuiles visibles seulement : une tuile en Corbeille garde ses marques.
  const lignes = instance().prepare(
    'SELECT t.tag, COUNT(*) n FROM user_tags t JOIN oeuvres_effectives o ON o.id = t.oeuvre_id GROUP BY t.tag'
  ).all();
  const out = { livre: 0, etoile: 0, bad_smiley: 0 };
  for (const l of lignes) out[l.tag] = l.n;
  return out;
}

// --- reglages et synchro ----------------------------------------------

function reglage(cle, defaut = null) {
  const r = instance().prepare('SELECT valeur FROM reglages WHERE cle = ?').get(cle);
  return r ? r.valeur : defaut;
}

function definirReglage(cle, valeur) {
  instance().prepare(
    'INSERT INTO reglages (cle, valeur) VALUES (?, ?) ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur'
  ).run(cle, String(valeur));
}

function etatSync(cle, defaut = null) {
  const r = instance().prepare('SELECT valeur FROM sync WHERE cle = ?').get(cle);
  return r ? r.valeur : defaut;
}

function definirEtatSync(cle, valeur) {
  instance().prepare(
    'INSERT INTO sync (cle, valeur) VALUES (?, ?) ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur'
  ).run(cle, String(valeur));
}

module.exports = {
  ouvrir, surOuverture, instance, fermer, exporterVers, migrer, reconstruireVue, SCHEMA_PACK, SCHEMA_USER,
  CHAMPS_TXT,
  compterOeuvres, oeuvre, packMeta, chercher, parCategorie, parNumero,
  tagsDe, basculerTag, parTagUtilisateur, comptesTags, effacerTousLesTags,
  reglage, definirReglage, etatSync, definirEtatSync
};
