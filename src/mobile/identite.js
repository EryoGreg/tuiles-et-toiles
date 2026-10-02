'use strict';
/**
 * Identite de l'appareil mobile (voir src/main/synchro/appareil.js), par le
 * module natif Identite (IdentitePlugin.java) :
 *
 *   infos()        type (« Android · Samsung SM-G998B ») et empreinte materielle
 *                  (ANDROID_ID, jamais publie en clair)
 *   restaurer()    appareil.json absent du stockage de la page mais present dans
 *                  la copie de secours (preferences Android) ET de ce meme
 *                  telephone -> remis en place : pas de nouvel appareil.
 *   copier(a)      tient la copie de secours a jour (chaque enregistrement)
 *   persistance()  demande au systeme de ne jamais vider ce stockage pour faire
 *                  de la place (navigator.storage.persist).
 * Navigateur de test : rien de natif, type « Navigateur », pas d'empreinte.
 */

const fs = require('fs');
const journal = require('../main/journal');
const appareil = require('../main/synchro/appareil');

function natif() {
  const C = typeof window !== 'undefined' && window.Capacitor;
  if (!C || !C.isNativePlatform || !C.isNativePlatform()) return null;
  return C.registerPlugin('Identite');
}

async function infos() {
  const I = natif();
  if (!I) return { type: 'Navigateur', materiel: null };
  try {
    const r = await I.infos();
    const modele = [r.fabricant, r.modele].filter(Boolean).join(' ').trim();
    return {
      type: 'Android' + (modele ? ' · ' + modele.charAt(0).toUpperCase() + modele.slice(1) : ''),
      materiel: r.androidId ? appareil.empreinte('android', r.androidId) : null
    };
  } catch (e) {
    journal.erreur('app', 'identite-infos', e);
    return { type: 'Android', materiel: null };
  }
}

async function restaurer(dossier, materiel) {
  const I = natif();
  const chemin = dossier + '/appareil.json';
  if (!I || !materiel || fs.existsSync(chemin)) return false;
  try {
    const { json } = await I.lireCopie();
    if (!json) return false;
    const a = JSON.parse(json);
    if (!a || a.materiel !== materiel) {
      journal.avertir('app', 'identite-copie-ignoree', { raison: 'autre appareil', id: a && a.id });
      return false;
    }
    fs.mkdirSync(dossier, { recursive: true });
    fs.writeFileSync(chemin, json);
    journal.avertir('app', 'identite-restauree', { id: a.id, nom: a.nom, prefixe: a.prefixe_ref });
    return true;
  } catch (e) {
    journal.erreur('app', 'identite-restaurer', e);
    return false;
  }
}

function copier(a) {
  const I = natif();
  if (!I) return;
  const { evenement, ancien, ...propre } = a;
  I.sauverCopie({ json: JSON.stringify(propre) }).catch((e) => journal.erreur('app', 'identite-copie', e));
}

async function persistance() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return null;
    const deja = await navigator.storage.persisted();
    const ok = deja || await navigator.storage.persist();
    journal.evt('app', 'stockage-persistant', { accorde: ok, deja });
    return ok;
  } catch (e) {
    journal.erreur('app', 'stockage-persistant', e);
    return null;
  }
}

module.exports = { infos, restaurer, copier, persistance };
