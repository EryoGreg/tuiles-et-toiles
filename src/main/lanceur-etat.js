'use strict';
/**
 * Choix du code a charger au demarrage du PC (mise a jour partielle,
 * PLAN-maj-partielle.md, etape 5). Pur Node, sans Electron : teste par
 * tests/maj-code.test.js. Utilise par lanceur.js (choisir, valider) et
 * maj-code.js (lireEtat, ecrireEtat).
 *
 * Dossier <userData>/code/ :
 *   etat.json   { attente: { version, essais } | null, ok: version | null, refusees: [version] }
 *   <version>/  un paquet de code verifie (src/main/**, dist/**, package.json)
 *
 * Memes regles que le mobile (src/mobile/maj-web.js) : un paquet en attente est
 * essaye ; il n'est retenu (ok) qu'apres un demarrage complet (valider) ; 2
 * essais sans validation -> refuse, jamais reessaye ; un exe plus recent que le
 * paquet reprend la main (menage). Toute anomalie -> code livre avec l'exe.
 */

const fs = require('fs');
const path = require('path');

const ESSAIS_MAX = 2;

function versionSuperieure(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

function lireEtat(racine) {
  try {
    const e = JSON.parse(fs.readFileSync(path.join(racine, 'etat.json'), 'utf8'));
    return { attente: e.attente || null, ok: e.ok || null, refusees: Array.isArray(e.refusees) ? e.refusees : [], echec: e.echec || null };
  } catch { return { attente: null, ok: null, refusees: [], echec: null }; }
}

function ecrireEtat(racine, e) {
  fs.mkdirSync(racine, { recursive: true });
  const f = path.join(racine, 'etat.json');
  fs.writeFileSync(f + '.tmp', JSON.stringify(e));
  fs.renameSync(f + '.tmp', f);
}

/** Efface les paquets (dossiers) sauf ceux cites. */
function menage(racine, garder) {
  let noms = [];
  try { noms = fs.readdirSync(racine, { withFileTypes: true }); } catch { return; }
  for (const d of noms) {
    if (!d.isDirectory() || garder.includes(d.name)) continue;
    try { fs.rmSync(path.join(racine, d.name), { recursive: true, force: true }); } catch { /* verrouille : plus tard */ }
  }
}

const paquetComplet = (racine, v) => fs.existsSync(path.join(racine, v, 'src', 'main', 'index.js'))
  && fs.existsSync(path.join(racine, v, 'dist', 'index.html'));

/**
 * @param {string} racine    <userData>/code
 * @param {string} versionExe version du code livre avec l'exe
 * @returns {{ version, dossier, essai: boolean, evenements: object[] } | { version: null, evenements }}
 */
function choisir(racine, versionExe) {
  const ev = [];
  const e = lireEtat(racine);
  let change = false;
  // Echec immediat au lancement precedent (avant le journal) : dit maintenant.
  if (e.echec) { ev.push({ quoi: 'refuse', paquet: e.echec.version, motif: e.echec.motif, le: e.echec.le }); e.echec = null; change = true; }
  if (e.ok && !versionSuperieure(e.ok, versionExe)) {   // exe plus recent installe par-dessus
    ev.push({ quoi: 'remplace-par-exe', paquet: e.ok, exe: versionExe });
    e.ok = null; change = true;
  }
  if (e.attente && !versionSuperieure(e.attente.version, versionExe)) {
    ev.push({ quoi: 'attente-depassee', paquet: e.attente.version, exe: versionExe });
    e.attente = null; change = true;
  }
  if (e.attente && !paquetComplet(racine, e.attente.version)) {
    ev.push({ quoi: 'paquet-incomplet', paquet: e.attente.version });
    e.refusees = [...new Set([...e.refusees, e.attente.version])];
    e.attente = null; change = true;
  }
  if (e.attente && (e.attente.essais || 0) >= ESSAIS_MAX) {
    ev.push({ quoi: 'refuse', paquet: e.attente.version, essais: e.attente.essais, motif: 'demarrage jamais valide' });
    e.refusees = [...new Set([...e.refusees, e.attente.version])];
    e.attente = null; change = true;
  }
  let version = null;
  let essai = false;
  if (e.attente) {
    e.attente.essais = (e.attente.essais || 0) + 1;
    version = e.attente.version; essai = true; change = true;
    ev.push({ quoi: 'essai', paquet: version, essai: e.attente.essais });
  } else if (e.ok && paquetComplet(racine, e.ok)) {
    version = e.ok;
  } else if (e.ok) {
    ev.push({ quoi: 'paquet-disparu', paquet: e.ok });
    e.ok = null; change = true;
  }
  if (change) {
    ecrireEtat(racine, e);
    menage(racine, [e.ok, e.attente && e.attente.version].filter(Boolean));
  }
  if (!version) return { version: null, evenements: ev };
  return { version, dossier: path.join(racine, version), essai, evenements: ev };
}

/** Le code `version` a demarre sans encombre : il devient celui de chaque lancement. */
function valider(racine, version) {
  const e = lireEtat(racine);
  if (!e.attente || e.attente.version !== version) return false;
  e.ok = version;
  e.attente = null;
  ecrireEtat(racine, e);
  menage(racine, [version]);
  return true;
}

/** Echec immediat au chargement : refuse tout de suite (le lanceur relance sur le code livre). */
function refuser(racine, version, motif) {
  const e = lireEtat(racine);
  e.refusees = [...new Set([...e.refusees, version])];
  if (e.attente && e.attente.version === version) e.attente = null;
  if (e.ok === version) e.ok = null;
  e.echec = { version, motif: String(motif || '').slice(0, 500), le: new Date().toISOString() };
  ecrireEtat(racine, e);
  menage(racine, [e.ok].filter(Boolean));
  return motif;
}

module.exports = { ESSAIS_MAX, versionSuperieure, lireEtat, ecrireEtat, menage, choisir, valider, refuser };
