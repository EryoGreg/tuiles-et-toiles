'use strict';
/**
 * Mise a jour de l'application depuis les Releases GitHub (depot public).
 *
 * electron-updater ne gere pas la cible « portable » : on le fait a la main.
 *   1. verifier()    : GET releases/latest, compare a app.getVersion().
 *   2. telecharger() : l'exe de la release est ecrit a cote de l'exe courant
 *                      (.part puis renommage), taille + SHA-256 verifies
 *                      contre le digest publie par GitHub.
 *   3. installer()   : lance le nouvel exe et laisse un marqueur ; au demarrage
 *                      suivant, nettoyerApresMaj() supprime l'ancien exe.
 *
 * Regle 1 : rien de bloquant. Hors ligne ou GitHub en panne -> { erreur },
 * l'appli continue. Rien n'est telecharge sans clic de l'utilisateur.
 * Les donnees (%APPDATA%) ne sont jamais touchees : seul l'exe change.
 */

const fs = require('fs');
const journal = require('./journal');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { app, net, shell } = require('electron');

const DEPOT = 'EryoGreg/tuiles-et-toiles';
const MOTIF_EXE = /^Tuiles-et-Toiles-\d+\.\d+\.\d+\.exe$/;
const PREFIXE_URL = 'https://github.com/' + DEPOT + '/releases/download/';
const DELAI_API = 10000;

let trouvee = null;   // derniere release plus recente trouvee
let pret = null;      // chemin de l'exe telecharge et verifie
let marqueur = null;  // %APPDATA%\...\maj-en-cours.json

function configurer({ dossierUser }) {
  marqueur = path.join(dossierUser, 'maj-en-cours.json');
}

// Exe portable lance par l'utilisateur (absent en dev / exe non portable).
function exeCourant() {
  return process.env.PORTABLE_EXECUTABLE_FILE || null;
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
  journal.evt('maj', 'derniere-release', {
    actuelle, tag: r.tag_name, publiee: r.published_at, assets: (r.assets || []).map((a) => ({ nom: a.name, octets: a.size, digest: !!a.digest }))
  });

  const version = String(r.tag_name || '').replace(/^v/, '');
  if (!versionSuperieure(version, actuelle)) return { aJour: true, actuelle };

  const exe = (r.assets || []).find((a) => MOTIF_EXE.test(a.name));
  if (!exe || !String(exe.browser_download_url).startsWith(PREFIXE_URL)) {
    journal.avertir('maj', 'exe-absent', { version, motif: String(MOTIF_EXE) });
    return { erreur: 'La version ' + version + ' ne contient pas d’exe téléchargeable.', actuelle };
  }
  const digest = String(exe.digest || '');
  trouvee = {
    version,
    nom: exe.name,
    url: exe.browser_download_url,
    taille: exe.size,
    sha256: digest.startsWith('sha256:') ? digest.slice(7).toLowerCase() : null,
    page: r.html_url
  };
  return {
    disponible: true,
    actuelle,
    version,
    notes: r.body || '',
    taille: exe.size,
    installable: !!exeCourant()
  };
}

// --- 2. telecharger ------------------------------------------------------

// Dossier de l'exe courant s'il est inscriptible, sinon Telechargements.
function dossierCible() {
  const d = path.dirname(exeCourant());
  try { fs.accessSync(d, fs.constants.W_OK); return d; }
  catch { return app.getPath('downloads'); }
}

async function telecharger(surProgression) {
  if (!trouvee) return { erreur: 'Aucune mise à jour trouvée.' };
  // Dev ou exe non portable : on ouvre simplement la page de la release.
  if (!exeCourant()) { shell.openExternal(trouvee.page); return { pageOuverte: true }; }

  const cible = path.join(dossierCible(), trouvee.nom);
  if (path.resolve(cible) === path.resolve(exeCourant())) return { erreur: 'Déjà sur cette version.' };
  const part = cible + '.part';
  const t0 = Date.now();
  journal.evt('maj', 'telechargement:debut', { version: trouvee.version, cible, octets: trouvee.taille, sha256: !!trouvee.sha256 });

  let fd = null;
  try {
    const res = await net.fetch(trouvee.url);
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
      if (surProgression && t - dernierEnvoi > 200) { dernierEnvoi = t; surProgression(recu, trouvee.taille); }
    }
    fs.closeSync(fd); fd = null;

    if (recu !== trouvee.taille) throw new Error('Fichier incomplet (' + recu + ' / ' + trouvee.taille + ' octets).');
    if (trouvee.sha256 && hash.digest('hex') !== trouvee.sha256) {
      throw new Error('Empreinte SHA-256 incorrecte : fichier corrompu ou modifié.');
    }
    fs.renameSync(part, cible);
    pret = cible;
    if (surProgression) surProgression(recu, trouvee.taille);
    journal.evt('maj', 'telechargement:fin', { cible, octets: recu, ms: Date.now() - t0, empreinteVerifiee: !!trouvee.sha256 });
    return { ok: true, chemin: cible };
  } catch (e) {
    journal.erreur('maj', 'telechargement', e, { cible, ms: Date.now() - t0 });
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* deja ferme */ } }
    try { fs.rmSync(part, { force: true }); } catch { /* deja parti */ }
    return { erreur: e.message || String(e) };
  }
}

// --- 3. installer ----------------------------------------------------------

// Lance le nouvel exe ; l'appelant ferme ensuite l'application.
function installer() {
  if (!pret || !fs.existsSync(pret)) return { erreur: 'Mise à jour non téléchargée.' };
  try {
    fs.writeFileSync(marqueur, JSON.stringify({ ancien: exeCourant(), nouveau: pret }));
    spawn(pret, [], { detached: true, stdio: 'ignore', cwd: path.dirname(pret) }).unref();
    journal.evt('maj', 'installation-lancee', { ancien: exeCourant(), nouveau: pret });
    return { ok: true };
  } catch (e) {
    journal.erreur('maj', 'installation', e, { nouveau: pret });
    return { erreur: e.message || String(e) };
  }
}

// Au demarrage du nouvel exe : supprime l'ancien. Il reste verrouille tant
// que son lanceur portable n'a pas fini de se fermer -> quelques essais.
function nettoyerApresMaj(journal) {
  if (!marqueur || !fs.existsSync(marqueur)) return;
  let m;
  try { m = JSON.parse(fs.readFileSync(marqueur, 'utf8')); } catch { m = null; }
  const oublier = () => { try { fs.rmSync(marqueur, { force: true }); } catch { /* rien */ } };
  if (!m || !m.ancien || !m.nouveau) { oublier(); return; }

  // Lancement qui n'est pas celui du nouvel exe (l'ancien relance a la main,
  // ou le dev) : on garde le marqueur pour le prochain lancement du nouveau.
  const courant = exeCourant();
  if (!courant || path.resolve(m.nouveau) !== path.resolve(courant)) return;

  // Garde-fou : ne supprimer qu'un exe de l'appli, jamais l'exe courant.
  if (!MOTIF_EXE.test(path.basename(m.ancien)) || path.resolve(m.ancien) === path.resolve(courant)) {
    oublier();
    return;
  }
  let essais = 0;
  const essayer = () => {
    essais += 1;
    try {
      fs.rmSync(m.ancien, { force: true });
      fs.rmSync(marqueur, { force: true });
      if (journal) journal.evt('maj', 'ancien-exe-supprime', { ancien: m.ancien });
    } catch (e) {
      if (essais < 30) setTimeout(essayer, 2000);
      else if (journal) journal.avertir('maj', 'ancien-exe-non-supprime', { ancien: m.ancien, erreur: e.message });
    }
  };
  setTimeout(essayer, 3000);
}

module.exports = { configurer, verifier, telecharger, installer, nettoyerApresMaj, versionSuperieure };
