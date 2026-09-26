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
const compaction = require('./synchro/compaction');
const { versIso } = require('./synchro/hlc');
const lisezmoi = require('./lisezmoi');
const journal = require('./journal');

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
  // Images qu'une annulation / un retablissement remettrait (require
  // paresseux : annuler.js depend de synchro/etat, comme ce module).
  for (const nom of require('./annuler').images()) out.add(nom);
  return out;
}

/**
 * Supprime les fichiers de images-locales/ qu'aucune tuile locale ni override
 * ne reference (import annule, image remplacee, crash en cours d'edition).
 */
function nettoyerOrphelines() {
  if (!dossierImages || !fs.existsSync(dossierImages)) return;
  const utilises = imagesReferencees();
  const supprimees = [];
  for (const f of fs.readdirSync(dossierImages)) {
    if (f === lisezmoi.NOM || utilises.has(f)) continue;
    try { fs.rmSync(path.join(dossierImages, f)); supprimees.push(f); }
    catch (e) { journal.erreur('image', 'menage-echec', e, { fichier: f }); }
  }
  if (supprimees.length) journal.evt('image', 'menage', { supprimees });
}

/** Supprime une image tout juste importee si rien ne la reference (annulation). */
function oublierImage(nom) {
  if (!dossierImages || !nom) return;
  if (imagesReferencees().has(nom)) { journal.debug('image', 'oublier-gardee', { nom }); return; }
  try { fs.rmSync(path.join(dossierImages, nom)); journal.evt('image', 'oubliee', { nom }); }
  catch (e) { journal.debug('image', 'oublier-absente', { nom, erreur: e.code }); }
}

/** Champs decrits pour le journal (longueur, alphabets, caracteres speciaux). */
function decrireChamps(champs) {
  const out = {};
  for (const c of CHAMPS) {
    const v = texte(champs, c);
    if (v) out[c] = c === 'image' ? v : journal.decrireTexte(v);
  }
  return out;
}

/** Image referencee : existe-t-elle vraiment sur disque ? */
function etatImage(nom) {
  if (!nom) return null;
  const p = dossierImages ? path.join(dossierImages, nom) : null;
  return { nom, presente: !!(p && fs.existsSync(p)), octets: p && fs.existsSync(p) ? fs.statSync(p).size : null };
}

/** Bilan apres ecriture : 0 masque = la tuile ne sortira jamais au tirage. */
function journaliser(quoi, id, extra) {
  const o = db.oeuvre(id);
  const masques = JSON.parse((o && o.masques) || '[]').length;
  journal.evt('edition', quoi, { id, ref: o && o.ref, masques, ...extra }, masques === 0 && o ? 'WARN' : 'INFO');
  if (o && masques === 0) {
    journal.avertir('edition', 'tuile-sans-masque', {
      id, ref: o.ref, raison: 'aucun jeu de champs visibles ne la distingue des autres (doublon ? champs vides ?)'
    });
  }
  return masques;
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

  const t0 = Date.now();
  try {
    etat.lot(() => {
      ref = prochainRefLocal();
      etat.ecrire('locale', id, '_existe', 1);
      etat.ecrire('locale', id, 'ref_local', ref);
      for (const c of CHAMPS) etat.ecrire('locale', id, c, texte(champs, c) || null);
    });
    appliquer();
  } catch (e) {
    journal.erreur('edition', 'creer-echec', e, { id, ref, champs: decrireChamps(champs) });
    throw e;
  }
  const masques = journaliser('creer', id, {
    champs: decrireChamps(champs), image: etatImage(texte(champs, 'image')), ms: Date.now() - t0
  });
  return { id, ref, masques };
}

/** Valeurs effectives d'une tuile, pretes pour l'editeur (image = nom brut). */
function tuile(id) {
  const o = db.oeuvre(id);
  if (!o) return null;
  const out = { id, ref: o.ref, estLocale: !!o.est_locale, conflit: db.oeuvresEnConflit().has(id) };
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
  const t0 = Date.now();
  const avant = db.oeuvre(id) || {};
  const changes = {};
  for (const c of CHAMPS) {
    const v = texte(champs, c);
    if (v !== String(avant[c] || '')) changes[c] = { avant: journal.decrireTexte(avant[c] || ''), apres: journal.decrireTexte(v) };
  }

  if (id.startsWith('local:')) {
    if (!etat.existe(id)) {
      journal.avertir('edition', 'modifier-introuvable', { id, local: true });
      return { erreur: 'oeuvre introuvable' };
    }
    etat.lot(() => {
      for (const c of CHAMPS) etat.ecrire('locale', id, c, texte(champs, c) || null);
    });
  } else {
    const pack = d.prepare('SELECT * FROM pack.oeuvres WHERE id = ?').get(id);
    if (!pack) {
      journal.avertir('edition', 'modifier-introuvable', { id, local: false });
      return { erreur: 'oeuvre introuvable' };
    }
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
  const masques = journaliser('modifier', id, {
    local: id.startsWith('local:'), changes, image: changes.image ? etatImage(texte(champs, 'image')) : undefined,
    ms: Date.now() - t0
  });
  return { id, ref: o && o.ref, masques };
}

/**
 * Supprime une tuile : elle part dans la Corbeille.
 *  - locale : pierre tombale _existe = { vu } (la ligne quitte oeuvres_locales,
 *             ses champs restent dans le registre)
 *  - pack   : archive (masquee, jamais vraiment supprimee)
 * Marques et vues sont gardees : invisibles tant que la tuile est absente
 * (les listes joignent oeuvres_effectives), de retour si elle est restauree.
 */
function supprimer(id) {
  if (id.startsWith('local:')) {
    etat.supprimerLocale(id);
    appliquer();
    journal.evt('edition', 'supprimer', { id, local: true });
    return { archivee: false };
  }
  etat.ecrire('archive', id, '_', 1);
  appliquer();
  journal.evt('edition', 'archiver', { id, local: false });
  return { archivee: true };
}

/**
 * Contenu de la Corbeille, plus recent d'abord :
 *  - tuiles locales supprimees dont le contenu est encore au registre ; il est
 *    oublie 90 jours apres la suppression (compaction.purgerTombes) -> effaceeLe
 *  - oeuvres du pack archivees (jamais oubliees, effaceeLe = null)
 */
function corbeille() {
  const d = db.instance();
  const out = [];
  const enConflit = db.oeuvresEnConflit();
  for (const r of d.prepare("SELECT cle, valeur, hlc FROM etat WHERE entite='locale' AND champ='_existe'").all()) {
    if (JSON.parse(r.valeur) === 1) continue;
    const l = etat.lignes('locale', r.cle);
    const v = (c) => (l[c] && l[c].valeur != null ? String(l[c].valeur) : '');
    if (!CHAMPS.some((c) => v(c))) continue;   // contenu deja oublie : plus rien a rendre
    out.push({
      id: r.cle, estLocale: true, ref: v('ref_local'), titre: v('titre'), artiste: v('artiste'), date: v('date'),
      image: v('image') ? 'tuile://' + v('image') : null,
      supprimeeLe: versIso(r.hlc), effaceeLe: compaction.purgeeLe(r.hlc), conflit: enConflit.has(r.cle)
    });
  }
  const pack = d.prepare('SELECT id, ref, titre, artiste, date, image FROM pack.oeuvres WHERE id = ?');
  for (const r of d.prepare("SELECT cle, hlc FROM etat WHERE entite='archive' AND champ='_' AND valeur IS NOT NULL").all()) {
    const o = pack.get(r.cle);
    if (!o) continue;   // retiree du pack par une mise a jour
    const corrige = (c) => { const x = etat.valeur('override', r.cle, c); return x && x.valeur ? x.valeur : o[c]; };
    out.push({
      id: r.cle, estLocale: false, ref: o.ref, titre: corrige('titre'), artiste: corrige('artiste'), date: corrige('date'),
      image: corrige('image') ? 'tuile://' + corrige('image') : null,
      supprimeeLe: versIso(r.hlc), effaceeLe: null
    });
  }
  return out.sort((a, b) => (a.supprimeeLe < b.supprimeeLe ? 1 : a.supprimeeLe > b.supprimeeLe ? -1 : 0));
}

/**
 * Sort une tuile de la Corbeille : ecriture ordinaire, propagee par la synchro
 * (et qui ferme un eventuel conflit « supprimee ici, modifiee la-bas »).
 * @returns {{ ok, ref, liste } | { erreur }}
 */
function restaurer(id) {
  const local = String(id).startsWith('local:');
  const avant = local ? etat.valeur('locale', id, '_existe') : etat.valeur('archive', id, '_');
  if (local ? avant == null || avant === 1 : avant == null) {
    journal.avertir('edition', 'restaurer-introuvable', { id, local, avant });
    return { erreur: 'Cette tuile n’est plus dans la corbeille.' };
  }
  if (local) etat.ecrire('locale', id, '_existe', 1);
  else etat.ecrire('archive', id, '_', null);
  appliquer();
  const o = db.oeuvre(id);
  journal.evt('edition', 'restaurer', { id, local, ref: o && o.ref, masques: o ? JSON.parse(o.masques || '[]').length : null });
  return { ok: true, ref: o && o.ref, liste: corbeille() };
}

/**
 * Versions precedentes des champs d'une tuile, tirees du journal de synchro
 * (toutes les valeurs qu'un champ a eues, sur tous les appareils). Plus
 * recente d'abord : la premiere est la valeur affichee. Deux versions
 * successives identiques n'en font qu'une. Oeuvre du pack : « valeur du
 * pack » en dernier. L'image n'y figure pas : une image remplacee est effacee
 * du disque (menage des images).
 * @returns {Array<{ champ, versions: Array<{ valeur, le, appareil, duPack }> }>}
 *   seulement les champs qui ont au moins deux versions
 */
function versions(id) {
  const d = db.instance();
  const local = String(id).startsWith('local:');
  const pack = local ? null : d.prepare('SELECT * FROM pack.oeuvres WHERE id = ?').get(id);
  if (!local && !pack) return [];
  const moi = etat.appareil();
  const noms = new Map([[moi.id, moi.nom + ' (cet appareil)']]);
  try {
    for (const f of JSON.parse(db.etatSync('appareils_connus') || '[]')) if (f.id !== moi.id) noms.set(f.id, f.nom || f.id);
  } catch { /* liste illisible : identifiants bruts */ }
  const ops = d.prepare('SELECT hlc, appareil, valeur FROM changements WHERE entite = ? AND cle = ? AND champ = ? ORDER BY hlc DESC');
  const out = [];
  for (const c of CHAMPS) {
    if (c === 'image') continue;
    const valeurPack = pack ? String(pack[c] == null ? '' : pack[c]) : '';
    const liste = [];
    for (const op of ops.all(local ? 'locale' : 'override', id, c)) {
      let v = op.valeur == null ? null : JSON.parse(op.valeur);
      if (!local) v = v ? v.valeur : null;   // override retire = valeur du pack
      const valeur = v == null ? valeurPack : String(v);
      if (liste.length && liste[liste.length - 1].valeur === valeur) continue;
      liste.push({ valeur, le: versIso(op.hlc), appareil: noms.get(op.appareil) || op.appareil, duPack: !local && v == null });
    }
    if (!local && liste.length && liste[liste.length - 1].valeur !== valeurPack) {
      liste.push({ valeur: valeurPack, le: null, appareil: null, duPack: true });
    }
    if (liste.length > 1) out.push({ champ: c, versions: liste });
  }
  journal.debug('edition', 'versions', { id, champs: out.map((x) => x.champ + ':' + x.versions.length) });
  return out;
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
  configurer, creer, tuile, modifier, supprimer, corbeille, restaurer, versions, nettoyerOrphelines, oublierImage,
  rafraichir: appliquer,
  imagesReferencees
};
