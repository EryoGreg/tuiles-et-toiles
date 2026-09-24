'use strict';
/**
 * Ajouts locaux : creer / modifier / supprimer des tuiles.
 *
 * Les tuiles creees vivent dans oeuvres_locales (utilisateur.db). Toutes les
 * ecritures passent par le journal de synchro (synchro/etat.ecrire), qui
 * projette dans oeuvres_locales / user_overrides / user_archive / user_tags.
 * Toute ecriture reconstruit oeuvres_effectives (force) et vide le sac.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const jeu = require('./jeu');
const etat = require('./synchro/etat');
const lisezmoi = require('./lisezmoi');

const CHAMPS = etat.CHAMPS_LOCALE;

let dossierImages = null;
function configurer(dossierImagesLocales) { dossierImages = dossierImagesLocales; }

/**
 * Noms d'images encore references. Inclut le registre de synchro : une tuile
 * supprimee y garde son image tant que sa pierre tombale vit (restauration
 * possible apres un conflit de synchro).
 */
function imagesReferencees() {
  const d = db.instance();
  const out = new Set();
  for (const r of d.prepare("SELECT image FROM oeuvres_locales WHERE image <> ''").all()) out.add(r.image);
  for (const r of d.prepare("SELECT valeur FROM user_overrides WHERE champ = 'image' AND valeur <> ''").all()) out.add(r.valeur);
  for (const r of d.prepare("SELECT entite, valeur FROM etat WHERE champ = 'image' AND valeur IS NOT NULL").all()) {
    const v = JSON.parse(r.valeur);
    const nom = r.entite === 'override' ? v && v.valeur : v;
    if (nom) out.add(nom);
  }
  return out;
}

/**
 * Supprime les fichiers de images-locales/ qu'aucune tuile locale ni override
 * ne reference (import annule, image remplacee, crash en cours d'edition).
 */
function nettoyerOrphelines() {
  if (!dossierImages || !fs.existsSync(dossierImages)) return;
  const utilises = imagesReferencees();
  for (const f of fs.readdirSync(dossierImages)) {
    if (f === lisezmoi.NOM || utilises.has(f)) continue;
    try { fs.rmSync(path.join(dossierImages, f)); } catch { /* verrou */ }
  }
}

/** Supprime une image tout juste importee si rien ne la reference (annulation). */
function oublierImage(nom) {
  if (!dossierImages || !nom) return;
  if (!imagesReferencees().has(nom)) { try { fs.rmSync(path.join(dossierImages, nom)); } catch { /* deja parti */ } }
}

/**
 * Numero d'affichage local, monotone, jamais reutilise : L1, L2… avec le
 * prefixe de CET appareil (M1… sur un appareil qui a rejoint un compte) —
 * deux appareils ne peuvent pas produire la meme ref.
 * Jamais en dessous du plus grand numero deja present pour ce prefixe (base
 * importee d'un autre poste).
 */
function prochainRefLocal() {
  const prefixe = etat.appareil().prefixe_ref;
  const cle = prefixe === 'L' ? 'ref_local_seq' : 'ref_local_seq:' + prefixe;
  let n = parseInt(db.reglage(cle, '0'), 10) || 0;
  const motif = new RegExp('^' + prefixe + '(\\d+)$');
  for (const r of db.instance().prepare("SELECT valeur FROM etat WHERE entite='locale' AND champ='ref_local'").all()) {
    const m = motif.exec(JSON.parse(r.valeur) || '');
    if (m) n = Math.max(n, parseInt(m[1], 10));
  }
  n += 1;
  db.definirReglage(cle, String(n));
  return prefixe + n;
}

/**
 * Cree une tuile locale.
 * @param {Object} champs { artiste, titre, date, lieu, description, tags, image }
 *   image = nom d'un fichier deja depose dans images-locales/ (S4), ou ''.
 * @returns {{ id, ref, masques }} masques = nombre de masques valides (0 -> la
 *   tuile n'apparaitra jamais au tirage).
 */
function creer(champs = {}) {
  const id = 'local:' + crypto.randomUUID();
  let ref = null;

  etat.lot(() => {
    ref = prochainRefLocal();
    etat.ecrire('locale', id, '_existe', 1);
    etat.ecrire('locale', id, 'ref_local', ref);
    for (const c of CHAMPS) etat.ecrire('locale', id, c, texte(champs, c) || null);
  });

  appliquer();
  const o = db.oeuvre(id);
  return { id, ref, masques: JSON.parse((o && o.masques) || '[]').length };
}

/** Valeurs effectives d'une tuile, pretes pour l'editeur (image = nom brut). */
function tuile(id) {
  const o = db.oeuvre(id);
  if (!o) return null;
  const out = { id, ref: o.ref, estLocale: !!o.est_locale };
  for (const c of CHAMPS) out[c] = o[c] || '';
  return out;
}

/**
 * Applique des changements a une tuile.
 *  - tuile locale : un champ journalise par champ modifie
 *  - tuile du pack : ecrit/retire des overrides (comparaison a la
 *    valeur DU PACK, pas a la valeur effective). Remettre un champ a la valeur
 *    du pack retire l'override. Vider l'image d'une tuile du pack = revenir a
 *    l'image du pack.
 */
function modifier(id, champs = {}) {
  const d = db.instance();

  if (id.startsWith('local:')) {
    if (!etat.existe(id)) return { erreur: 'oeuvre introuvable' };
    etat.lot(() => {
      for (const c of CHAMPS) etat.ecrire('locale', id, c, texte(champs, c) || null);
    });
  } else {
    const pack = d.prepare('SELECT * FROM pack.oeuvres WHERE id = ?').get(id);
    if (!pack) return { erreur: 'oeuvre introuvable' };
    etat.lot(() => {
      for (const c of CHAMPS) {
        const nouv = texte(champs, c);
        const valPack = String(pack[c] == null ? '' : pack[c]);
        const revenirAuPack = nouv === valPack || (c === 'image' && nouv === '');
        if (revenirAuPack) { etat.ecrire('override', id, c, null); continue; }
        // valeur_source = valeur du pack lors de la PREMIERE correction : c'est
        // elle qui permet de reperer qu'une MAJ de pack a touche ce champ.
        const cour = etat.valeur('override', id, c);
        etat.ecrire('override', id, c, { valeur: nouv, valeur_source: cour ? cour.valeur_source : valPack });
      }
    });
  }

  appliquer();
  const o = db.oeuvre(id);
  return { id, ref: o && o.ref, masques: JSON.parse((o && o.masques) || '[]').length };
}

/**
 * Supprime une tuile.
 *  - locale : pierre tombale _existe = { vu } (la ligne quitte oeuvres_locales,
 *             ses champs restent dans le registre) + tags retires, stats effacees
 *  - pack   : archive (masquee, jamais vraiment supprimee)
 */
function supprimer(id) {
  const d = db.instance();
  if (id.startsWith('local:')) {
    etat.lot(() => {
      for (const r of d.prepare("SELECT champ FROM etat WHERE entite='tag' AND cle=? AND valeur IS NOT NULL").all(id)) {
        etat.ecrire('tag', id, r.champ, null);
      }
      etat.supprimerLocale(id);
      d.prepare('DELETE FROM user_stats WHERE oeuvre_id=?').run(id);
    });
    appliquer();
    return { archivee: false };
  }
  etat.ecrire('archive', id, '_', 1);
  appliquer();
  return { archivee: true };
}

/** Champ texte d'un formulaire, nettoye ('' si absent). */
function texte(champs, c) {
  return String(champs[c] == null ? '' : champs[c]).trim();
}

function appliquer() {
  db.reconstruireVue({ force: true });
  jeu.reinitialiserSac();
  nettoyerOrphelines();
}

module.exports = {
  configurer, creer, tuile, modifier, supprimer, nettoyerOrphelines, oublierImage, imagesReferencees
};
