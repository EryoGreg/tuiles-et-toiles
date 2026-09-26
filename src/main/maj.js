'use strict';
/**
 * Mise a jour de l'application depuis les Releases GitHub (depot public).
 *
 * Deux formes de l'appli, deux fichiers par release :
 *   portable   Tuiles-et-Toiles-x.y.z.exe        un seul exe, rien a installer,
 *              mais il se decompresse (~300 Mo, images comprises) a CHAQUE
 *              lancement : lent sur un PC modeste
 *   installee  Tuiles-et-Toiles-Setup-x.y.z.exe  installateur NSIS, par
 *              utilisateur (%LOCALAPPDATA%\Programs, sans droits admin) :
 *              demarrage rapide
 * Les donnees (%APPDATA%\Tuiles et Toiles) sont les memes pour les deux :
 * passer de l'une a l'autre ne touche a rien.
 *
 * Fait a la main (electron-updater ne gere pas le portable) :
 *   1. verifier()    : GET releases/latest, compare a app.getVersion().
 *   2. telecharger() : l'exe de la forme courante (ou l'installateur, pour
 *                      passer du portable a l'installee) ; .part puis
 *                      renommage, taille + SHA-256 verifies contre le digest
 *                      publie par GitHub.
 *   3. installer()   : portable -> lance le nouvel exe ; installee ->
 *                      installateur silencieux (/S), qui relance l'appli ;
 *                      passage portable -> installee : installateur visible.
 *                      Un marqueur permet au lancement suivant de supprimer
 *                      l'ancien exe portable / l'installateur telecharge.
 *
 * Regle 1 : rien de bloquant. Hors ligne ou GitHub en panne -> { erreur },
 * l'appli continue. Rien n'est telecharge sans clic de l'utilisateur.
 */

const fs = require('fs');
const os = require('os');
const journal = require('./journal');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { app, net, shell } = require('electron');

const DEPOT = 'EryoGreg/tuiles-et-toiles';
// Noms d'assets attendus : les changer casse la mise a jour des installations existantes.
const MOTIF_EXE = /^Tuiles-et-Toiles-\d+\.\d+\.\d+\.exe$/;
const MOTIF_SETUP = /^Tuiles-et-Toiles-Setup-\d+\.\d+\.\d+\.exe$/;
const PREFIXE_URL = 'https://github.com/' + DEPOT + '/releases/download/';
const DELAI_API = 10000;

let trouvee = null;   // derniere release : { version, page, portable, setup }
let pret = null;      // { chemin, setup, version } telecharge et verifie
let marqueur = null;  // %APPDATA%\...\maj-en-cours.json

function configurer({ dossierUser }) {
  marqueur = path.join(dossierUser, 'maj-en-cours.json');
}

/** 'dev' | 'portable' | 'installee' */
function mode() {
  if (!app.isPackaged) return 'dev';
  return process.env.PORTABLE_EXECUTABLE_FILE ? 'portable' : 'installee';
}

// Exe que l'utilisateur lance (portable : l'exe d'origine, pas sa copie
// decompressee dans le cache temporaire).
function exeCourant() {
  const m = mode();
  if (m === 'portable') return process.env.PORTABLE_EXECUTABLE_FILE;
  if (m === 'installee') return process.execPath;
  return null;
}

// a strictement superieure a b ? (semver "x.y.z")
function versionSuperieure(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

function memeChemin(a, b) {
  const n = (p) => path.resolve(String(p || '')).toLowerCase();
  return !!a && !!b && n(a) === n(b);
}

function decrireAsset(a) {
  if (!a || !String(a.browser_download_url).startsWith(PREFIXE_URL)) return null;
  const digest = String(a.digest || '');
  return {
    nom: a.name, url: a.browser_download_url, taille: a.size,
    sha256: digest.startsWith('sha256:') ? digest.slice(7).toLowerCase() : null
  };
}

// --- 1. verifier -------------------------------------------------------

async function verifier() {
  const actuelle = app.getVersion();
  let r;
  try {
    const ctl = new AbortController();
    const minuteur = setTimeout(() => ctl.abort(), DELAI_API);
    const res = await net.fetch('https://api.github.com/repos/' + DEPOT + '/releases/latest', {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Tuiles-et-Toiles/' + actuelle },
      signal: ctl.signal
    });
    clearTimeout(minuteur);
    if (!res.ok) {
      const reste = res.headers.get('x-ratelimit-remaining');
      const reprise = res.headers.get('x-ratelimit-reset');
      journal.avertir('maj', 'github-refus', { status: res.status, limite: reste, reprise });
      if ((res.status === 403 || res.status === 429) && reste === '0') {
        const quand = reprise ? new Date(Number(reprise) * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : null;
        return {
          erreur: 'GitHub limite les vérifications depuis ton réseau (trop de requêtes, fréquent derrière un VPN). '
            + (quand ? 'Réessaie après ' + quand + '.' : 'Réessaie dans une heure.'),
          actuelle
        };
      }
      return { erreur: 'GitHub a répondu ' + res.status + '.', actuelle };
    }
    r = await res.json();
  } catch (e) {
    journal.evt('maj', 'github-injoignable', { erreur: e.message, nom: e.name }, 'WARN');
    return { erreur: 'Impossible de joindre GitHub (hors ligne ?).', actuelle };
  }
  const m = mode();
  journal.evt('maj', 'derniere-release', {
    actuelle, mode: m, tag: r.tag_name, publiee: r.published_at,
    assets: (r.assets || []).map((a) => ({ nom: a.name, octets: a.size, digest: !!a.digest }))
  });

  const version = String(r.tag_name || '').replace(/^v/, '');
  const assets = r.assets || [];
  trouvee = {
    version, page: r.html_url,
    portable: decrireAsset(assets.find((a) => MOTIF_EXE.test(a.name))),
    setup: decrireAsset(assets.find((a) => MOTIF_SETUP.test(a.name)))
  };
  // Portable : proposer la version installee (demarrage plus rapide), meme a jour.
  const migration = m === 'portable' && trouvee.setup
    ? { version, taille: trouvee.setup.taille }
    : null;

  if (!versionSuperieure(version, actuelle)) return { aJour: true, actuelle, migration };

  const asset = m === 'installee' ? trouvee.setup : trouvee.portable;
  if (!asset && m !== 'dev') {
    journal.avertir('maj', 'exe-absent', { version, mode: m });
    return { erreur: 'La version ' + version + ' ne contient pas de fichier pour cette installation.', actuelle, migration };
  }
  return {
    disponible: true, actuelle, version, notes: r.body || '',
    taille: asset ? asset.taille : null,
    installable: m !== 'dev' && !!asset,
    migration
  };
}

// --- 2. telecharger ------------------------------------------------------

// Portable : a cote de l'exe courant s'il est inscriptible, sinon
// Telechargements. Installateur : dossier temporaire (supprime apres usage).
function dossierCible(setup) {
  if (setup) return os.tmpdir();
  const d = path.dirname(exeCourant());
  try { fs.accessSync(d, fs.constants.W_OK); return d; }
  catch { return app.getPath('downloads'); }
}

/**
 * @param {(recu, total) => void} surProgression
 * @param {{ versInstallee?: boolean }} o  telecharger l'installateur pour
 *   passer du portable a la version installee
 */
async function telecharger(surProgression, { versInstallee = false } = {}) {
  if (!trouvee) return { erreur: 'Aucune mise à jour trouvée.' };
  const m = mode();
  if (m === 'dev') { shell.openExternal(trouvee.page); return { pageOuverte: true }; }
  const setup = m === 'installee' || versInstallee;
  const asset = setup ? trouvee.setup : trouvee.portable;
  if (!asset) return { erreur: 'Fichier absent de la version ' + trouvee.version + '.' };

  const cible = path.join(dossierCible(setup), asset.nom);
  if (memeChemin(cible, exeCourant())) return { erreur: 'Déjà sur cette version.' };
  const part = cible + '.part';
  const t0 = Date.now();
  journal.evt('maj', 'telechargement:debut', { version: trouvee.version, setup, versInstallee, cible, octets: asset.taille, sha256: !!asset.sha256 });

  let fd = null;
  try {
    const res = await net.fetch(asset.url);
    if (!res.ok || !res.body) throw new Error('Téléchargement ' + res.status);

    const hash = crypto.createHash('sha256');
    fd = fs.openSync(part, 'w');
    let recu = 0; let dernierEnvoi = 0;
    const lecteur = res.body.getReader();
    for (;;) {
      const { done, value } = await lecteur.read();
      if (done) break;
      const morceau = Buffer.from(value);
      fs.writeSync(fd, morceau);
      hash.update(morceau);
      recu += morceau.length;
      const t = Date.now();
      if (surProgression && t - dernierEnvoi > 200) { dernierEnvoi = t; surProgression(recu, asset.taille); }
    }
    fs.closeSync(fd); fd = null;

    if (recu !== asset.taille) throw new Error('Fichier incomplet (' + recu + ' / ' + asset.taille + ' octets).');
    if (asset.sha256 && hash.digest('hex') !== asset.sha256) {
      throw new Error('Empreinte SHA-256 incorrecte : fichier corrompu ou modifié.');
    }
    fs.renameSync(part, cible);
    pret = { chemin: cible, setup, version: trouvee.version };
    if (surProgression) surProgression(recu, asset.taille);
    journal.evt('maj', 'telechargement:fin', { cible, octets: recu, ms: Date.now() - t0, empreinteVerifiee: !!asset.sha256 });
    return { ok: true, chemin: cible };
  } catch (e) {
    journal.erreur('maj', 'telechargement', e, { cible, ms: Date.now() - t0 });
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* deja ferme */ } }
    try { fs.rmSync(part, { force: true }); } catch { /* deja parti */ }
    return { erreur: e.message || String(e) };
  }
}

// --- 3. installer ----------------------------------------------------------

/**
 * Lance le nouvel exe ou l'installateur ; l'appelant ferme ensuite l'appli.
 * Installateur : silencieux pour une mise a jour de la version installee
 * (--force-run : il relance l'appli), visible pour un passage depuis le
 * portable (il relance l'appli a la fin).
 */
function installer() {
  if (!pret || !fs.existsSync(pret.chemin)) return { erreur: 'Mise à jour non téléchargée.' };
  const m = mode();
  const args = pret.setup && m === 'installee' ? ['/S', '--updated', '--force-run'] : [];
  const nouveauMarqueur = {
    version: pret.version,
    vers: pret.setup ? 'installee' : 'portable',
    ancien: m === 'portable' ? exeCourant() : null,     // exe portable a supprimer une fois remplace
    nouveau: pret.setup ? null : pret.chemin,
    setup: pret.setup ? pret.chemin : null              // installateur a supprimer apres usage
  };
  try {
    fs.writeFileSync(marqueur, JSON.stringify(nouveauMarqueur));
    spawn(pret.chemin, args, { detached: true, stdio: 'ignore', cwd: path.dirname(pret.chemin) }).unref();
    journal.evt('maj', 'installation-lancee', { ...nouveauMarqueur, args });
    return { ok: true };
  } catch (e) {
    journal.erreur('maj', 'installation', e, { chemin: pret.chemin });
    return { erreur: e.message || String(e) };
  }
}

/**
 * Au lancement de la nouvelle version : supprime l'ancien exe portable et
 * l'installateur telecharge. Un fichier encore verrouille (lanceur portable
 * qui finit de se fermer) -> quelques essais.
 */
function nettoyerApresMaj(journalApp) {
  const j = journalApp || journal;
  if (!marqueur || !fs.existsSync(marqueur)) return;
  let m;
  try { m = JSON.parse(fs.readFileSync(marqueur, 'utf8')); } catch { m = null; }
  const oublier = () => { try { fs.rmSync(marqueur, { force: true }); } catch { /* rien */ } };
  if (!m || (!m.ancien && !m.setup)) { oublier(); return; }

  // Est-ce bien la nouvelle version qui demarre ? Sinon (ancien exe relance a
  // la main, installation abandonnee) on garde le marqueur pour plus tard.
  const courant = exeCourant();
  if (!courant) return;
  const vers = m.vers || 'portable';   // marqueur d'avant 0.3.2 : portable -> portable
  const arrivee = vers === 'portable'
    ? memeChemin(m.nouveau, courant)
    : mode() === 'installee' && !versionSuperieure(m.version || '0.0.0', app.getVersion());
  if (!arrivee) return;

  // Garde-fous : ne supprimer que des fichiers de l'appli, jamais l'exe courant.
  const aSupprimer = [];
  if (m.ancien && MOTIF_EXE.test(path.basename(m.ancien)) && !memeChemin(m.ancien, courant)) aSupprimer.push(m.ancien);
  if (m.setup && MOTIF_SETUP.test(path.basename(m.setup))) aSupprimer.push(m.setup);
  if (!aSupprimer.length) { oublier(); return; }

  let essais = 0;
  const essayer = () => {
    essais += 1;
    const restent = aSupprimer.filter((f) => {
      try { fs.rmSync(f, { force: true }); return false; } catch { return true; }
    });
    if (!restent.length) {
      oublier();
      j.evt('maj', 'anciens-fichiers-supprimes', { fichiers: aSupprimer, vers });
    } else if (essais < 30) {
      aSupprimer.splice(0, aSupprimer.length, ...restent);
      setTimeout(essayer, 2000);
    } else {
      oublier();
      j.avertir('maj', 'anciens-fichiers-non-supprimes', { fichiers: restent });
    }
  };
  setTimeout(essayer, 3000);
}

module.exports = { configurer, mode, verifier, telecharger, installer, nettoyerApresMaj, versionSuperieure };
