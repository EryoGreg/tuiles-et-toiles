'use strict';
/**
 * Construit l'appli mobile (et sa version navigateur) dans dist-mobile/ :
 *   1. l'interface React (Vite, la meme que sur PC) ;
 *   2. principal.js : le pont mobile + les modules du processus principal,
 *      empaquetes par esbuild, les modules Node remplaces (src/mobile/shims) ;
 *   3. les fichiers livres : pack.db, vignettes, manifeste des images, sql.js.
 * Capacitor (android/) copie ensuite dist-mobile/ dans l'appli :
 *   npx cap sync android
 *
 *     node scripts/build-mobile.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const esbuild = require('esbuild');

const RACINE = path.resolve(__dirname, '..');
const SORTIE = path.join(RACINE, 'dist-mobile');
const shim = (f) => path.join(RACINE, 'src', 'mobile', 'shims', f);
const version = require(path.join(RACINE, 'package.json')).version;

(async () => {
  const t0 = Date.now();
  // 1. Interface
  execFileSync(process.execPath, [path.join(RACINE, 'node_modules', 'vite', 'bin', 'vite.js'), 'build',
    '--outDir', SORTIE, '--emptyOutDir'], { cwd: RACINE, stdio: 'inherit' });

  // 2. Pont + modules du processus principal
  const remplacer = {
    'src/main/images.js': path.join(RACINE, 'src', 'mobile', 'images-import.js'),
    'src/main/drive.js': path.join(RACINE, 'src', 'mobile', 'drive.js')
  };
  // Client OAuth Google « Web » (sa connexion native Android s'appuie dessus) :
  // src/mobile/google-config.json { "webClientId": "…" }, hors depot.
  let google = {};
  try { google = JSON.parse(fs.readFileSync(path.join(RACINE, 'src', 'mobile', 'google-config.json'), 'utf8')); }
  catch { console.log('(src/mobile/google-config.json absent : connexion Drive desactivee)'); }
  await esbuild.build({
    entryPoints: [path.join(RACINE, 'src', 'mobile', 'principal.js')],
    outfile: path.join(SORTIE, 'principal.js'),
    bundle: true, format: 'iife', platform: 'browser', target: 'es2020',
    minify: true, sourcemap: false, legalComments: 'none',
    inject: [shim('globaux.js')],
    define: {
      __VERSION__: JSON.stringify(version), 'process.env.NODE_ENV': '"production"',
      __GOOGLE_WEB_CLIENT_ID__: JSON.stringify(google.webClientId || '')
    },
    alias: {
      'better-sqlite3': shim('sqlite.js'),
      fs: shim('vfs.js'),
      path: 'path-browserify',
      crypto: shim('crypto.js'),
      zlib: shim('zlib.js'),
      os: shim('os.js'),
      electron: shim('electron.js')
    },
    plugins: [{
      name: 'remplacements-mobile',
      setup(b) {
        b.onResolve({ filter: /^\.\.?\// }, (a) => {
          const cible = path.resolve(a.resolveDir, a.path.endsWith('.js') ? a.path : a.path + '.js');
          const rel = path.relative(RACINE, cible).replace(/\\/g, '/');
          return remplacer[rel] ? { path: remplacer[rel] } : undefined;
        });
      }
    }],
    logLevel: 'warning'
  });

  // 3. Fichiers livres
  const copier = (de, vers) => fs.cpSync(path.join(RACINE, de), path.join(SORTIE, vers), { recursive: true });
  copier('data/pack.db', 'pack.db');
  copier('data/images-manifest.json', 'images-manifest.json');
  copier('data/vignettes', 'vignettes');
  copier('node_modules/sql.js/dist/sql-wasm-browser.wasm', 'sql-wasm-browser.wasm');

  // Le pont doit exister avant l'interface : script classique en tete.
  const index = path.join(SORTIE, 'index.html');
  let html = fs.readFileSync(index, 'utf8');
  html = html.replace('<head>', '<head>\n    <script src="./principal.js"></script>')
    .replace('width=device-width, initial-scale=1', 'width=device-width, initial-scale=1, viewport-fit=cover');
  fs.writeFileSync(index, html);

  const taille = (p) => { let n = 0; for (const f of fs.readdirSync(p, { recursive: true })) { const s = fs.statSync(path.join(p, f)); if (s.isFile()) n += s.size; } return n; };
  console.log('dist-mobile : ' + (taille(SORTIE) / 1048576).toFixed(1) + ' Mo, principal.js '
    + (fs.statSync(path.join(SORTIE, 'principal.js')).size / 1024).toFixed(0) + ' Ko, '
    + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
})().catch((e) => { console.error(e); process.exit(1); });
