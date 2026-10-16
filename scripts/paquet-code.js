'use strict';
/**
 * Paquet de code PC d'une version (mise a jour partielle, PLAN-maj-partielle.md,
 * etape 5). Apres `npm run dist` : le code de l'appli (src/main/**, dist/**,
 * package.json), zippe, decrit et signe. Charge par le lanceur (src/main/lanceur.js).
 *
 *   release/<Nom>-code-x.y.z-n<exeMin>.zip   le code (~400 Ko)
 *   release/<Nom>-code-x.y.z.json            manifeste : version, exeMin, zip, fichiers
 *   release/<Nom>-code-x.y.z.json.sig        signature Ed25519 du manifeste (base64)
 *
 * exeMin = version minimale de l'exe (x*10000+y*100+z) capable de faire tourner ce
 * code : empreinte de tout ce qui NE voyage PAS dans le paquet (Electron, modules
 * installes, configuration du build, lanceur, contenu livre en resources : pack,
 * vignettes…) comparee a celle de data/natif-pc.json ; si elle change, exeMin =
 * cette version (exe complet obligatoire).
 *
 *     node scripts/paquet-code.js        (lance par npm run dist)
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
const RELEASE = path.join(RACINE, (process.argv.find((a) => a.startsWith('--sortie=')) || '--sortie=release').slice(9));
const NATIF = path.join(RACINE, 'data', 'natif-pc.json');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const versionCode = (v) => { const [x, y, z] = v.split('.').map(Number); return x * 10000 + y * 100 + z; };

function lister(rel, out) {
  const p = path.join(RACINE, rel);
  if (!fs.existsSync(p)) return;
  if (fs.statSync(p).isDirectory()) for (const f of fs.readdirSync(p).sort()) lister(rel + '/' + f, out);
  else out.push(rel);
}

/** Empreinte de ce que le paquet ne remplace pas. */
function empreinteExe() {
  const h = crypto.createHash('sha256');
  h.update('electron@' + require(path.join(RACINE, 'node_modules', 'electron', 'package.json')).version + '\n');
  for (const d of Object.keys(PAQUET.dependencies || {}).sort()) {
    let v = '?';
    try { v = require(path.join(RACINE, 'node_modules', d, 'package.json')).version; } catch { /* absent */ }
    h.update(d + '@' + v + '\n');
  }
  h.update(JSON.stringify(PAQUET.build || {}));
  // Le lanceur de l'exe (jamais remplace a chaud) et le contenu livre en resources.
  const fichiers = ['src/main/lanceur.js', 'src/main/lanceur-etat.js'];
  for (const r of (PAQUET.build && PAQUET.build.extraResources) || []) lister(typeof r === 'string' ? r : r.from, fichiers);
  for (const rel of fichiers) {
    const p = path.join(RACINE, rel);
    if (fs.existsSync(p)) h.update(rel).update('\0').update(fs.readFileSync(p));
  }
  return h.digest('hex').slice(0, 16);
}

function exeMin() {
  const empreinte = empreinteExe();
  const avant = fs.existsSync(NATIF) ? JSON.parse(fs.readFileSync(NATIF, 'utf8')) : null;
  if (avant && avant.empreinte === empreinte) return { exeMin: avant.exeMin, empreinte, change: false };
  const r = { empreinte, exeMin: versionCode(VERSION), version: VERSION };
  fs.writeFileSync(NATIF, JSON.stringify(r, null, 2) + '\n');
  return { exeMin: r.exeMin, empreinte, change: true };
}

function main() {
  const tous = ['package.json'];
  lister('src/main', tous);
  lister('dist', tous);
  if (!tous.includes('dist/index.html')) throw new Error('dist/ absent : lancer `npm run dist` (ou vite build) avant.');
  const fichiers = {};
  const zip = new AdmZip();
  for (const rel of tous) {
    const b = fs.readFileSync(path.join(RACINE, rel));
    fichiers[rel] = { octets: b.length, sha256: sha(b) };
    zip.addFile(rel, b);
  }
  const n = exeMin();
  const base = NOM + '-code-' + VERSION;
  const nomZip = base + '-n' + n.exeMin + '.zip';
  fs.mkdirSync(RELEASE, { recursive: true });
  for (const f of fs.readdirSync(RELEASE)) if (f.startsWith(base + '-n') && f.endsWith('.zip')) fs.rmSync(path.join(RELEASE, f));
  const octets = zip.toBuffer();
  fs.writeFileSync(path.join(RELEASE, nomZip), octets);
  const manifeste = {
    version: VERSION, exeMin: n.exeMin, exe: n.empreinte,
    zip: { nom: nomZip, octets: octets.length, sha256: sha(octets) },
    fichiers, cree_le: new Date().toISOString()
  };
  const json = Buffer.from(JSON.stringify(manifeste));
  fs.writeFileSync(path.join(RELEASE, base + '.json'), json);
  fs.writeFileSync(path.join(RELEASE, base + '.json.sig'), signer(json));
  console.log('Paquet de code : ' + path.relative(RACINE, path.join(RELEASE, nomZip)) + ' (' + (octets.length / 1024).toFixed(0) + ' Ko, '
    + Object.keys(fichiers).length + ' fichiers), exeMin ' + n.exeMin
    + (n.change ? ' (exe change : exe complet obligatoire pour cette version)' : ''));
}

if (require.main === module) main();
module.exports = { empreinteExe, versionCode };
