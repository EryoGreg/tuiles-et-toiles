'use strict';
/**
 * Raccourcis Windows (.lnk) : bureau, menu Demarrer, barre des taches.
 *
 * Cible = l'exe portable que l'utilisateur a lance (PORTABLE_EXECUTABLE_FILE),
 * pas l'exe extrait dans le cache temporaire ; version installee : son exe.
 * Si l'utilisateur deplace le portable, ou passe a la version installee, les
 * raccourcis pointent dans le vide : detectes au lancement (perimes()).
 * L'installateur n'en cree aucun lui-meme (nsis.create*Shortcut = false) :
 * ceux de l'appli, proposes au premier lancement, suffisent.
 *
 * Icone : lue dans un fichier STABLE (%APPDATA%\Tuiles et Toiles\icone.ico), pas
 * dans l'exe. La mise a jour de la version installee retire l'exe quelques
 * secondes : si Windows relit l'icone a ce moment, il met en cache une icone
 * vide, qui survit aux relances. Au demarrage, reparerIcones() repointe vers
 * ce fichier tout raccourci visant l'exe (y compris ceux que Windows a
 * crees en epinglant l'appli) et rafraichit le cache d'icones.
 *
 * La barre des taches ne s'epingle pas par API sur Windows 10/11 : on invoque
 * le verbe du menu contextuel (« Epingler a la barre des taches »). Selon la
 * version de Windows le verbe existe ou non ; l'echec est silencieux.
 */

const { app, shell } = require('electron');
/* eslint-disable no-empty */
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const NOM = 'Tuiles & Toiles';
const WIN = process.platform === 'win32';

function cible() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

let iconeStable = null;

/**
 * Copie l'icone de l'appli (resources/icone.ico) dans le dossier de donnees,
 * que ni les mises a jour ni la desinstallation ne touchent.
 */
function preparerIcone(dossierUser, source) {
  if (!WIN || !source || !fs.existsSync(source)) return null;
  const dest = path.join(dossierUser, 'icone.ico');
  try {
    const neuf = fs.readFileSync(source);
    if (!fs.existsSync(dest) || !fs.readFileSync(dest).equals(neuf)) fs.writeFileSync(dest, neuf);
    iconeStable = dest;
  } catch { iconeStable = null; }
  return iconeStable;
}

function iconeRaccourci() {
  return iconeStable && fs.existsSync(iconeStable) ? iconeStable : cible();
}

const CHEMINS = {
  bureau: () => path.join(app.getPath('desktop'), NOM + '.lnk'),
  menu: () => path.join(app.getPath('appData'), 'Microsoft', 'Windows',
    'Start Menu', 'Programs', NOM + '.lnk'),
  // Emplacement ou Windows depose le .lnk d'un element epingle a la barre.
  taskbar: () => path.join(app.getPath('appData'), 'Microsoft', 'Internet Explorer',
    'Quick Launch', 'User Pinned', 'TaskBar', NOM + '.lnk')
};

function existe(type) {
  try { return fs.existsSync(CHEMINS[type]()); } catch { return false; }
}

// Comparaison de chemins Windows : casse et separateurs ignores.
function memeChemin(a, b) {
  const n = (p) => {
    try { return path.win32.normalize(String(p || '')).toLowerCase().replace(/[\\/]+$/, ''); }
    catch { return String(p || '').toLowerCase(); }
  };
  return n(a) === n(b);
}

/** Cible pointee par un raccourci existant, ou null. */
function cibleDe(type) {
  try { return shell.readShortcutLink(CHEMINS[type]()).target || null; }
  catch { return null; }
}

/** @returns {{bureau:boolean, menu:boolean, taskbar:boolean}|null} null hors Windows */
function etat() {
  if (!WIN) return null;
  return { bureau: existe('bureau'), menu: existe('menu'), taskbar: existe('taskbar') };
}

function ecrire(type) {
  const chemin = CHEMINS[type]();
  fs.mkdirSync(path.dirname(chemin), { recursive: true });
  const exe = cible();
  const op = fs.existsSync(chemin) ? 'replace' : 'create';
  return shell.writeShortcutLink(chemin, op, {
    target: exe,
    icon: iconeRaccourci(),
    iconIndex: 0,
    appUserModelId: 'fr.tuilesettoiles.app',
    description: 'Entraînement mémoriel — histoire de l’art'
  });
}

function supprimer(type) {
  try { fs.rmSync(CHEMINS[type]()); } catch { /* deja absent */ }
}

// Invoque le verbe « Epingler / Detacher … barre des taches » du menu
// contextuel de l'exe. Windows 10 2004+ / 11 l'ont retire -> renvoie false,
// l'appelant bascule alors sur une manip manuelle.
function verbeBarre(epingler) {
  return new Promise((ok) => {
    const exe = cible().replace(/'/g, "''");
    const motif = epingler
      ? "'(épingl|attach|pin).*(barre|tâche|taskbar)|taskbar.*pin'"
      : "'(détach|dérét|retir|unpin).*(barre|tâche|taskbar)|unpin.*taskbar'";
    const ps = [
      "$ErrorActionPreference='SilentlyContinue'",
      '$sh = New-Object -ComObject Shell.Application',
      `$it = $sh.Namespace((Split-Path -Parent '${exe}')).ParseName((Split-Path -Leaf '${exe}'))`,
      '$done = $false',
      'if ($it) { foreach ($v in $it.Verbs()) {',
      `  if (($v.Name -replace '&','') -match ${motif}) { $v.DoIt(); Start-Sleep -Milliseconds 600; $done = $true; break }`,
      '} }',
      'if ($done) { Write-Output OK }'
    ].join('; ');
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 15000 }, (_e, out) => ok(String(out).includes('OK')));
  });
}

/**
 * Ajoute le raccourci s'il est absent, le retire s'il est present.
 * @returns {Promise<{manuel:boolean}>} manuel=true : Windows n'automatise pas,
 *   le dossier a ete ouvert pour un epinglage a la main.
 */
async function basculer(type) {
  if (!WIN) return { manuel: false };

  if (type === 'taskbar') {
    const pose = existe('taskbar');
    // Il faut un raccourci quelque part pour pouvoir l'epingler a la main.
    if (!pose && !existe('menu') && !existe('bureau')) ecrire('menu');
    const ok = await verbeBarre(!pose);
    if (!ok) {
      const source = existe('menu') ? CHEMINS.menu() : CHEMINS.bureau();
      try { shell.showItemInFolder(source); } catch {}
      return { manuel: true };
    }
    return { manuel: false };
  }

  if (existe(type)) supprimer(type);
  else ecrire(type);
  return { manuel: false };
}

/**
 * Raccourcis existants qui pointent vers un AUTRE emplacement que l'exe
 * courant (portable deplace, ancienne version…).
 * @returns {Array<{type:string, cibleActuelle:string}>}
 */
function perimes() {
  if (!WIN) return [];
  const courant = cible();
  const out = [];
  for (const type of ['bureau', 'menu', 'taskbar']) {
    if (!existe(type)) continue;
    const t = cibleDe(type);
    if (t && !memeChemin(t, courant)) out.push({ type, cibleActuelle: t });
  }
  return out;
}

/**
 * Tout raccourci (bureau, menu Demarrer, barre des taches) qui vise l'exe
 * courant prend l'icone stable ; si au moins un a change, le cache d'icones
 * de Windows est rafraichi (ie4uinit -show). @returns {string[]} modifies
 */
function reparerIcones(journal) {
  if (!WIN || !iconeStable) return [];
  const dossiers = [
    app.getPath('desktop'),
    path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(app.getPath('appData'), 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar')
  ];
  const courant = cible();
  const modifies = [];
  for (const d of dossiers) {
    let noms = [];
    try { noms = fs.readdirSync(d).filter((f) => f.toLowerCase().endsWith('.lnk')); } catch { continue; }
    for (const nom of noms) {
      const lnk = path.join(d, nom);
      let l;
      try { l = shell.readShortcutLink(lnk); } catch { continue; }
      if (!memeChemin(l.target, courant) || memeChemin(l.icon, iconeStable)) continue;
      try {
        shell.writeShortcutLink(lnk, 'update', { icon: iconeStable, iconIndex: 0 });
        modifies.push(lnk);
      } catch (e) {
        if (journal) journal.avertir('app', 'raccourci-icone-echec', { lnk, erreur: e.message });
      }
    }
  }
  if (modifies.length) {
    execFile('ie4uinit.exe', ['-show'], { windowsHide: true, timeout: 15000 }, () => {});
    if (journal) journal.evt('app', 'raccourcis-icone-stable', { modifies, icone: iconeStable });
  }
  return modifies;
}

/** Recree/replace les raccourcis donnes pour qu'ils pointent vers l'exe courant. */
function reparer(types) {
  if (!WIN) return;
  for (const type of types || []) {
    try { ecrire(type); } catch { /* verrouille ou droits : tant pis */ }
  }
}

module.exports = { etat, basculer, perimes, reparer, preparerIcone, reparerIcones, WIN };
