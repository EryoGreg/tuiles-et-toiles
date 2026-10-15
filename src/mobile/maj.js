'use strict';
/**
 * Mise a jour de l'appli Android depuis les Releases GitHub : l'equivalent
 * mobile de src/main/maj.js, memes canaux (maj:verifier / telecharger /
 * installer), meme interface dans Options.
 *
 *   verifier()    releases/latest (maj-github.js, commun au PC), asset
 *                 Tuiles-et-Toiles-x.y.z.apk
 *   telecharger() par le module natif MiseAJour (MiseAJourPlugin.java) :
 *                 dans le cache de l'appli, taille + SHA-256 verifies
 *   installer()   ouvre l'installateur d'Android. Premiere fois : Android
 *                 demande d'autoriser l'appli a installer des applis
 *                 ({ permission: false }) ; l'utilisateur revient et relance.
 *
 * Mise a jour PARTIELLE (maj-web.js) : si la release contient un paquet web
 * utilisable par cet APK (natifMin), c'est lui qui est propose (~1 Mo, ni
 * installateur ni reglage Android) ; « installer » = redemarrer dessus.
 *
 * L'APK doit etre signe par la MEME cle que l'appli installee, sinon Android
 * refuse la mise a jour (voir CLAUDE.md, « Appli mobile »).
 * Regle 1 : rien de bloquant ; hors ligne -> { erreur } ; rien n'est
 * telecharge sans geste de l'utilisateur (donnees mobiles comprises).
 */

const journal = require('../main/journal');
const { versionSuperieure, decrireAsset, derniereRelease } = require('../main/maj-github');
const majWeb = require('./maj-web');
const contenu = require('./contenu');
const reseau = require('./reseau');

// Nom d'asset attendu : le changer casse la mise a jour des installations existantes.
const MOTIF_APK = /^Tuiles-et-Toiles-\d+\.\d+\.\d+\.apk$/;

let trouvee = null;   // { version, page, apk, web }
let pret = null;      // { chemin, version } | { web: true, version }
let actuelle = '0.0.0';
let versionCode = 0;  // de l'APK installe (natifMin d'un paquet web)

function natif() {
  const C = typeof window !== 'undefined' && window.Capacitor;
  if (!C || !C.isNativePlatform || !C.isNativePlatform()) return null;
  return C.registerPlugin('MiseAJour');
}

/** Version de l'appli (celle du build web, identique au versionName de l'APK). */
async function configurer({ version }) {
  actuelle = version;
  const M = natif();
  if (!M) return;
  try {
    const i = await M.infos();
    versionCode = Number(i.versionCode) || 0;
    // Code web plus recent que l'APK : mise a jour partielle appliquee (normal).
    if (i.versionName && i.versionName !== version) {
      journal.evt('maj', 'versions', { web: version, apk: i.versionName, versionCode });
    }
    // APK d'une mise a jour precedente (installee ou abandonnee) : inutile.
    const n = await M.nettoyer();
    if (n.supprimes) journal.evt('maj', 'apk-supprimes', { n: n.supprimes });
  } catch (e) { journal.erreur('maj', 'natif-infos', e); }
}

async function verifier() {
  const d = await derniereRelease(fetch, actuelle);
  if (d.erreur) return { erreur: d.erreur, actuelle };
  const r = d.release;
  trouvee = {
    version: d.version, page: r.html_url,
    apk: decrireAsset((r.assets || []).find((a) => MOTIF_APK.test(a.name)))
  };
  if (!versionSuperieure(d.version, actuelle)) return { aJour: true, actuelle };
  // Paquet web utilisable par cet APK : propose a la place de l'APK.
  if (natif()) {
    const e = await majWeb.lireEtat().catch(() => ({ refusees: [] }));
    trouvee.web = majWeb.trouver(r, { actuelle, versionCode, refusees: e.refusees });
    if (trouvee.web) {
      return {
        disponible: true, actuelle, version: d.version, notes: r.body || '', type: 'web',
        taille: trouvee.web.zip.taille, wifi: reseau.wifi(), installable: true
      };
    }
  }
  if (!trouvee.apk) {
    journal.avertir('maj', 'apk-absent', { version: d.version });
    return { erreur: 'La version ' + d.version + ' n’existe pas encore pour Android.', actuelle };
  }
  return {
    disponible: true, actuelle, version: d.version, notes: r.body || '',
    taille: trouvee.apk.taille,
    installable: !!natif()
  };
}

async function telecharger(surProgression) {
  if (trouvee && trouvee.web) {
    // Le nouveau code lit le contenu (pack, vignettes) dans la copie des donnees.
    try { await contenu.copier(); } catch (e) { journal.erreur('maj', 'web-contenu', e); }
    if (!contenu.pret()) return { erreur: 'Préparation du contenu impossible : réessaie dans un instant.' };
    journal.evt('maj', 'web-telechargement:debut', { version: trouvee.version, octets: trouvee.web.zip.taille, wifi: reseau.wifi() });
    const r = await majWeb.telecharger(trouvee.web, surProgression);
    if (r.ok) pret = { web: true, version: trouvee.version };
    return r;
  }
  if (!trouvee || !trouvee.apk) return { erreur: 'Aucune mise à jour trouvée.' };
  const M = natif();
  if (!M) {
    // Navigateur de test : la page de la version.
    window.open(trouvee.page, '_blank');
    return { pageOuverte: true };
  }
  const a = trouvee.apk;
  const t0 = Date.now();
  journal.evt('maj', 'telechargement:debut', { version: trouvee.version, octets: a.taille, sha256: !!a.sha256 });
  const ecoute = await M.addListener('progression', (p) => surProgression && surProgression(p.recu, p.total));
  try {
    const r = await M.telecharger({ url: a.url, nom: a.nom, taille: a.taille, sha256: a.sha256 || '' });
    pret = { chemin: r.chemin, version: trouvee.version };
    journal.evt('maj', 'telechargement:fin', { octets: r.octets, ms: Date.now() - t0, empreinteVerifiee: r.empreinteVerifiee });
    return { ok: true };
  } catch (e) {
    journal.erreur('maj', 'telechargement', e, { ms: Date.now() - t0 });
    return { erreur: (e && e.message) || String(e) };
  } finally {
    ecoute.remove();
  }
}

async function installer() {
  if (pret && pret.web) return majWeb.appliquerMaintenant();
  const M = natif();
  if (!M || !pret) return { erreur: 'Mise à jour non téléchargée.' };
  try {
    const r = await M.installer({ chemin: pret.chemin });
    journal.evt('maj', 'installation-lancee', { version: pret.version, permission: r.permission !== false });
    if (r.permission === false) {
      return {
        permission: false,
        erreur: 'Android demande d’abord ton accord : active « Autoriser depuis cette source » pour Tuiles & Toiles, '
          + 'reviens ici puis appuie de nouveau sur « Installer ».'
      };
    }
    return { ok: true };
  } catch (e) {
    journal.erreur('maj', 'installation', e);
    return { erreur: (e && e.message) || String(e) };
  }
}

const webPret = () => !!(pret && pret.web);

module.exports = { configurer, verifier, telecharger, installer, webPret };
