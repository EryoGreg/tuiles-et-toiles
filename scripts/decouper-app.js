'use strict';
/**
 * Outil ponctuel (etape 1 de Bristol) : decoupe src/renderer/App.jsx en
 * fichiers par domaine, SANS changer le code des declarations : chaque
 * declaration de premier niveau est recopiee telle quelle (commentaires
 * compris) dans son fichier, exportee, et chaque fichier importe ce qu'il
 * utilise des autres. Verifie ensuite qu'aucun nom n'est reste non defini.
 *
 *     node scripts/decouper-app.js            ecrit les fichiers
 *     node scripts/decouper-app.js --verifier ne fait que la verification
 */

const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const RENDU = path.join(__dirname, '..', 'src', 'renderer');
const SOURCE = path.join(RENDU, 'App.jsx');

// Fichier de destination de chaque declaration (le reste reste dans App.jsx).
const PLAN = {
  'commun/base.jsx': ['GrilleContext', 'DENSITES', 'densiteValide', 'NavContext', 'editionEnAttente', 'PREFS', 'chargerPrefs',
    'enregistrerPrefs', 'usePref', 'MEMOIRE_SESSION', 'useSession', 'SUR_MOBILE', 'urlTuile', 'dateCourte', 'texteValeur',
    'enMo', 'pourcent', 'coupe', 'recharger', 'direChangements', 'phraseBilan'],
  'commun/boites.jsx': ['BoiteConfirmation', 'Puces', 'EnChantier', 'ProgressionSynchro'],
  'tuile/Tuile.jsx': ['MARQUES', 'Tuile'],
  'tuile/Cartes.jsx': ['PIPS', 'PastilleConflit', 'useAppuiLong', 'CarteTuile', 'MARQUES_MENU', 'useMenuTuile', 'SUR_VIDE', 'RecouvrementApercu'],
  'jeu/Jeu.jsx': ['NouvellePartie', 'Jeu', 'Partie'],
  'jeu/Revision.jsx': ['NOTES_REVISION', 'dureeRevision', 'texteRevision', 'Revision'],
  'galeries/Galeries.jsx': ['TRI_LABEL', 'parNumero', 'trier', 'SelecteurTags', 'BarreFiltres', 'Galerie', 'PageLivre', 'PageEtoile',
    'PageRevoir', 'PageBibliotheque'],
  'edition/Editeur.jsx': ['ChampEdit', 'pesee', 'CHAMPS_VIDES', 'memeChamps', 'urlDepuisDrop', 'EditeurTuile', 'LIBELLES_CHAMPS', 'BoiteVersions'],
  'edition/Cartel.jsx': ['CHAMPS_CARTEL', 'ROLE_CHAMP', 'ROLES_CARTEL', 'joindreLignes', 'BoiteCartel'],
  'edition/PageEdition.jsx': ['PageEdition', 'JournalModifs'],
  'options/Options.jsx': ['THEMES', 'RACCOURCIS', 'Options'],
  'options/Sections.jsx': ['nomModeleIA', 'SectionLectureIA', 'SectionRevision', 'QUALITES_IMAGES', 'SectionImages', 'SectionAppareils',
    'BoiteRemplacement'],
  'options/Rapport.jsx': ['FormulaireRapport'],
  'options/Maj.jsx': ['useMaj', 'MajContext', 'ActionsMaj', 'BandeauMaj', 'SectionMaj'],
  'pages/Conflits.jsx': ['PageConflits', 'Version'],
  'pages/Corbeille.jsx': ['PageCorbeille']
};
const OU = new Map();
for (const [f, noms] of Object.entries(PLAN)) for (const n of noms) OU.set(n, f);

const GLOBAUX = new Set(['window', 'document', 'navigator', 'console', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'localStorage', 'sessionStorage', 'Date', 'Math', 'JSON', 'Promise', 'Set', 'Map', 'Object', 'Array', 'String', 'Number',
  'Boolean', 'RegExp', 'Error', 'parseInt', 'parseFloat', 'isNaN', 'encodeURIComponent', 'decodeURIComponent', 'URL', 'Blob',
  'FileReader', 'Image', 'fetch', 'requestAnimationFrame', 'cancelAnimationFrame', 'Infinity', 'NaN', 'undefined', 'Intl',
  'getComputedStyle', 'matchMedia', 'structuredClone', 'queueMicrotask', 'File', 'DataTransfer', 'Event', 'CustomEvent',
  'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'TextEncoder', 'TextDecoder', 'Uint8Array', 'ArrayBuffer', 'atob', 'btoa',
  'confirm', 'alert', 'performance', 'location', 'history', 'screen', 'Symbol', 'WeakMap', 'WeakSet', 'globalThis', 'arguments',
  'ResizeObserver', 'IntersectionObserver', 'MutationObserver', 'AbortController', 'Notification', 'process', 'require',
  'BigInt', 'escape', 'unescape']);

const parse = (code) => parser.parse(code, { sourceType: 'module', plugins: ['jsx'] });

function nomsDeclares(st) {
  const d = st.type === 'ExportNamedDeclaration' || st.type === 'ExportDefaultDeclaration' ? st.declaration : st;
  if (!d) return [];
  if (d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') return d.id ? [d.id.name] : [];
  if (d.type === 'VariableDeclaration') return d.declarations.map((x) => x.id.name).filter(Boolean);
  return [];
}

/** Noms libres (references sans liaison locale) d'un fichier analyse. */
function nomsLibres(ast) {
  const libres = new Set();
  traverse(ast, {
    'Identifier|JSXIdentifier'(p) {
      if (!p.isReferencedIdentifier()) return;
      const n = p.node.name;
      if (p.isJSXIdentifier() && !/^[A-Z]/.test(n) && !p.parentPath.isJSXMemberExpression()) return;   // balise HTML
      if (p.isJSXIdentifier() && p.parentPath.isJSXMemberExpression() && p.parentPath.node.object !== p.node) return;
      if (!p.scope.hasBinding(n, true)) libres.add(n);
    }
  });
  return libres;
}

function verifier(fichiers) {
  let ok = true;
  for (const f of fichiers) {
    const code = fs.readFileSync(f, 'utf8');
    const libres = [...nomsLibres(parse(code))].filter((n) => !GLOBAUX.has(n));
    if (libres.length) { ok = false; console.log('NON DEFINIS dans ' + path.relative(RENDU, f) + ' : ' + libres.join(', ')); }
  }
  console.log(ok ? 'verification : aucun nom non defini' : 'verification : ECHEC');
  return ok;
}

function decouper() {
  let src = fs.readFileSync(SOURCE, 'utf8');
  // Etat de module partage entre App (ecrit) et PageEdition (lit) : un objet,
  // un import ES ne pouvant pas etre reassigne depuis un autre module.
  src = src.replace('let editionEnAttente = null;', 'const editionEnAttente = { id: null };')
    .replace('    if (!editionEnAttente) return;\n    const id = editionEnAttente;\n    editionEnAttente = null;',
      '    if (!editionEnAttente.id) return;\n    const id = editionEnAttente.id;\n    editionEnAttente.id = null;')
    .replace('editionEnAttente = id; naviguer', 'editionEnAttente.id = id; naviguer');
  const ast = parse(src);
  const corps = ast.program.body;
  const importsReact = corps.find((s) => s.type === 'ImportDeclaration' && s.source.value === 'react');
  const reactNoms = importsReact.specifiers.map((s) => s.local.name);

  const morceaux = new Map();   // fichier -> [{ texte, noms }]
  const tous = new Set();
  let debutLibre = null;
  for (const st of corps) {
    if (st.type === 'ImportDeclaration') continue;
    const noms = nomsDeclares(st);
    const debut = Math.min(st.start, ...((st.leadingComments || []).map((c) => c.start)));
    const fin = st.end;
    const fichier = noms.length ? (OU.get(noms[0]) || 'App.jsx') : 'App.jsx';
    let texte = src.slice(debut, fin);
    if (fichier !== 'App.jsx' && st.type !== 'ExportNamedDeclaration') {
      const rel = st.start - debut;
      texte = texte.slice(0, rel) + 'export ' + texte.slice(rel);
    }
    if (!morceaux.has(fichier)) morceaux.set(fichier, []);
    morceaux.get(fichier).push({ texte, noms });
    for (const n of noms) tous.add(n);
    void debutLibre;
  }
  for (const n of OU.keys()) if (!tous.has(n)) throw new Error('declaration introuvable : ' + n);

  const ecrits = [];
  for (const [fichier, liste] of morceaux) {
    const corpsTexte = liste.map((m) => m.texte).join('\n\n') + '\n';
    const propres = new Set(liste.flatMap((m) => m.noms));
    const libres = nomsLibres(parse(corpsTexte));
    const parSource = new Map();
    for (const n of libres) {
      if (propres.has(n)) continue;
      const vient = OU.get(n) || (tous.has(n) ? 'App.jsx' : null);
      if (!vient || vient === fichier) continue;
      if (!parSource.has(vient)) parSource.set(vient, []);
      parSource.get(vient).push(n);
    }
    const dir = path.dirname(path.join(RENDU, fichier));
    const rel = (cible) => { let r = path.relative(dir, path.join(RENDU, cible)).replace(/\\/g, '/'); if (!r.startsWith('.')) r = './' + r; return r; };
    const lignes = [];
    const react = reactNoms.filter((n) => libres.has(n));
    if (react.length) lignes.push('import { ' + react.join(', ') + " } from 'react';");
    if (libres.has('I')) lignes.push("import * as I from '" + rel('icones.jsx') + "';");
    for (const [cible, noms] of [...parSource].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (cible === 'App.jsx') throw new Error(fichier + ' utilise ' + noms.join(', ') + ' qui reste dans App.jsx');
      lignes.push('import { ' + noms.sort().join(', ') + " } from '" + rel(cible) + "';");
    }
    const tete = fichier === 'App.jsx' ? '' : '// Decoupe d\'App.jsx (etape 1 de Bristol) : code inchange, voir scripts/decouper-app.js.\n';
    const sortie = tete + lignes.join('\n') + '\n\n' + corpsTexte;
    const chemin = path.join(RENDU, fichier);
    fs.mkdirSync(path.dirname(chemin), { recursive: true });
    fs.writeFileSync(chemin, sortie);
    ecrits.push(chemin);
    console.log(fichier.padEnd(26), String(sortie.split('\n').length).padStart(5), 'lignes');
  }
  return ecrits;
}

const fichiers = process.argv.includes('--verifier')
  ? [SOURCE, ...Object.keys(PLAN).map((f) => path.join(RENDU, f))]
  : decouper();
process.exit(verifier(fichiers) ? 0 : 1);
