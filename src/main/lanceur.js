'use strict';
/**
 * Point d'entree de l'exe (package.json "main"). Minuscule a dessein : c'est la
 * seule piece qui ne se met jamais a jour a chaud (PLAN-maj-partielle.md,
 * etape 5). Choisit le code a charger :
 *   - un paquet de code telecharge (<userData>/code/<version>/, maj-code.js),
 *     s'il est plus recent que l'exe et pas refuse (lanceur-etat.js) ;
 *   - sinon le code livre avec l'exe (./index.js).
 * Le code charge voit les node_modules de l'exe (NODE_PATH) et sa propre
 * version (app.getVersion). Echec au chargement -> paquet refuse, relance de
 * l'exe sur le code livre. Developpement : toujours le code livre.
 */

const { app } = require('electron');
const path = require('path');

const versionExe = app.getVersion();
global.__ttLanceur = { versionExe, version: versionExe, paquet: false, essai: false, evenements: [], valider: () => false };

function chargerPaquet() {
  if (!app.isPackaged || process.env.TT_CODE_LIVRE === '1') return false;
  const etat = require('./lanceur-etat');
  const racine = path.join(app.getPath('userData'), 'code');
  let choix;
  try { choix = etat.choisir(racine, versionExe); } catch (e) {
    global.__ttLanceur.evenements.push({ quoi: 'choix-impossible', erreur: e.message });
    return false;
  }
  global.__ttLanceur.evenements.push(...choix.evenements);
  if (!choix.version) return false;

  // Les modules de l'exe (better-sqlite3, adm-zip…) pour le code du paquet.
  const Module = require('module');
  process.env.NODE_PATH = [path.join(app.getAppPath(), 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  Module._initPaths();
  app.getVersion = () => choix.version;
  Object.assign(global.__ttLanceur, {
    version: choix.version, paquet: true, essai: choix.essai, dossier: choix.dossier,
    valider: () => etat.valider(racine, choix.version)
  });
  try {
    require(path.join(choix.dossier, 'src', 'main', 'index.js'));
    return true;
  } catch (e) {
    // Le code a pu s'executer en partie : on ne recharge pas l'autre par-dessus.
    etat.refuser(racine, choix.version, e.message);
    // Portable : relancer l'exe portable, pas sa copie decompressee dans Temp.
    app.relaunch(process.env.PORTABLE_EXECUTABLE_FILE ? { execPath: process.env.PORTABLE_EXECUTABLE_FILE } : undefined);
    app.exit(0);
    return true;
  }
}

if (!chargerPaquet()) require('./index.js');
