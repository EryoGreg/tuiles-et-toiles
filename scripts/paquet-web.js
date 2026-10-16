'use strict';
/**
 * Paquet web d'une version (mise a jour partielle, PLAN-maj-partielle.md).
 * Apres build-mobile : le code web (dist-mobile/) SANS le contenu livre
 * (contenu.json, scripts/contenu-livre.js), zippe, decrit et signe.
 *
 *   release/<Nom>-web-x.y.z-n<natifMin>.zip  le code web (~1 Mo)
 *   release/<Nom>-web-x.y.z.json       manifeste : version, natifMin, zip, fichiers
 *   release/<Nom>-web-x.y.z.json.sig   signature Ed25519 du manifeste (base64)
 *
 * natifMin = versionCode minimal de l'APK capable de faire tourner ce code :
 * empreinte de la partie native (sources Android hors web, gradle, config
 * Capacitor, versions installees des modules natifs, contenu livre) comparee a celle retenue
 * dans data/natif.json ; si elle change, natifMin = cette version (APK
 * obligatoire). Jamais laisse a la memoire de celui qui publie.
 *
 *     node scripts/paquet-web.js        (lance par npm run dist:android)
 * Meme fichier dans Tuiles & Toiles et Bristol.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { signer } = require('./cle-maj-web');

const RACINE = path.resolve(__dirname, '..');
const PAQUET = require(path.join(RACINE, 'package.json'));
const VERSION = PAQUET.version;
const NOM = String(PAQUET.build && PAQUET.build.productName || PAQUET.name).replace(/\s+/g, '-');
const SORTIE = path.join(RACINE, 'dist-mobile');
const RELEASE = path.join(RACINE, 'release');
const NATIF = path.join(RACINE, 'data', 'natif.json');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const versionCode = (v) => { const [x, y, z] = v.split('.').map(Number); return x * 10000 + y * 100 + z; };

function lister(dossier, rel, out, ignorer = () => false) {
  const p = path.join(dossier, rel);
  if (ignorer(rel)) return;
  if (fs.statSync(p).isDirectory()) {
    for (const f of fs.readdirSync(p).sort()) lister(dossier, rel ? rel + '/' + f : f, out, ignorer);
  } else out.push(rel);
}

/** Empreinte de tout ce qui fait la partie native de l'APK. */
function empreinteNative() {
  const h = crypto.createHash('sha256');
  const fichiers = [];
  const android = path.join(RACINE, 'android');
  // Sources de l'appli Android, sans la copie du code web (assets/public), ni
  // les fichiers que `cap sync` regenere a l'identique du code web.
  lister(android, 'app/src', fichiers, (rel) => /^app\/src\/main\/assets\/public(\/|$)/.test(rel));
  for (const f of ['app/build.gradle', 'build.gradle', 'variables.gradle', 'capacitor.settings.gradle', 'settings.gradle']) {
    if (fs.existsSync(path.join(android, f))) fichiers.push(f);
  }
  for (const rel of fichiers.sort()) h.update(rel).update('\0').update(fs.readFileSync(path.join(android, rel)));
  for (const f of fs.readdirSync(RACINE).filter((x) => /^capacitor\.config\./.test(x)).sort()) h.update(f).update(fs.readFileSync(path.join(RACINE, f)));
  // Modules natifs : versions reellement installees.
  const deps = Object.keys(PAQUET.dependencies || {}).filter((d) => /^@capacitor\/|^@capgo\//.test(d)).sort();
  for (const d of deps) {
    const v = require(path.join(RACINE, 'node_modules', d, 'package.json')).version;
    h.update(d + '@' + v + '\n');
  }
  // Contenu livre (pack / decks) : un paquet web ne le transporte pas ; s'il
  // change, le nouveau code ne doit pas tourner sur l'ancienne copie -> APK.
  const contenu = path.join(SORTIE, 'contenu.json');
  if (fs.existsSync(contenu)) h.update('contenu:' + JSON.parse(fs.readFileSync(contenu, 'utf8')).id);
  return h.digest('hex').slice(0, 16);
}

function natifMin() {
  const empreinte = empreinteNative();
  const avant = fs.existsSync(NATIF) ? JSON.parse(fs.readFileSync(NATIF, 'utf8')) : null;
  if (avant && avant.empreinte === empreinte) return { natifMin: avant.natifMin, empreinte, change: false };
  const r = { empreinte, natifMin: versionCode(VERSION), version: VERSION };
  fs.writeFileSync(NATIF, JSON.stringify(r, null, 2) + '\n');
  return { natifMin: r.natifMin, empreinte, change: true };
}

function main() {
  const contenu = JSON.parse(fs.readFileSync(path.join(SORTIE, 'contenu.json'), 'utf8'));
  const exclus = new Set([...Object.keys(contenu.fichiers), 'contenu.json']);
  const tous = [];
  lister(SORTIE, '', tous);
  const fichiers = {};
  const zip = new AdmZip();
  for (const rel of tous) {
    if (exclus.has(rel)) continue;
    const b = fs.readFileSync(path.join(SORTIE, rel));
    fichiers[rel] = { octets: b.length, sha256: sha(b) };
    zip.addFile(rel, b);
  }
  if (!fichiers['index.html'] || !fichiers['principal.js']) throw new Error('Paquet web incomplet (index.html, principal.js).');
  const base = NOM + '-web-' + VERSION;
  fs.mkdirSync(RELEASE, { recursive: true });
  const zipOctets = zip.toBuffer();
  // natifMin dans le nom du zip : l'appli choisit paquet web ou APK sans rien
  // telecharger ; le manifeste signe le confirme.
  const n = natifMin();
  const nomZip = base + '-n' + n.natifMin + '.zip';
  for (const f of fs.readdirSync(RELEASE)) if (f.startsWith(base + '-n') && f.endsWith('.zip')) fs.rmSync(path.join(RELEASE, f));
  fs.writeFileSync(path.join(RELEASE, nomZip), zipOctets);
  const manifeste = {
    version: VERSION, natifMin: n.natifMin, natif: n.empreinte, contenu: contenu.id,
    zip: { nom: nomZip, octets: zipOctets.length, sha256: sha(zipOctets) },
    fichiers, cree_le: new Date().toISOString()
  };
  const json = Buffer.from(JSON.stringify(manifeste));
  fs.writeFileSync(path.join(RELEASE, base + '.json'), json);
  fs.writeFileSync(path.join(RELEASE, base + '.json.sig'), signer(json));
  console.log('Paquet web : release/' + nomZip + ' (' + (zipOctets.length / 1024).toFixed(0) + ' Ko, '
    + Object.keys(fichiers).length + ' fichiers), natifMin ' + n.natifMin
    + (n.change ? ' (partie native changee : APK obligatoire pour cette version)' : ''));
}

if (require.main === module) main();
module.exports = { empreinteNative, versionCode };
