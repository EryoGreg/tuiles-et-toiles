'use strict';
/**
 * Durcissement contre des entrees hostiles venues d'une source partagee
 * (dossier de synchro, Google Drive) ou d'un zip fabrique :
 *   - bombe de decompression dans un snapshot (.json.gz) ;
 *   - segment .ndjson demesure (octets, nombre d'ops) ;
 *   - zip dont le dossier images contient des noms pirates ou des fichiers
 *     enormes, et dont utilisateur.db est une bombe.
 *
 *     node scripts/lancer-node.js tests/securite.test.js
 */

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const AdmZip = require('adm-zip');

const RACINE = path.resolve(__dirname, '..');
const src = (p) => require(path.join(RACINE, 'src/main', p));
const format = src('synchro/format');
const db = src('db');
const etat = src('synchro/etat');
const edition = src('edition');
const jeu = src('jeu');
const appareil = src('synchro/appareil');
const service = src('synchro/service');
const sauvegarde = src('sauvegarde');
const journal = src('journal');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-securite-'));
const PACK = path.join(TMP, 'pack.db');
fs.copyFileSync(path.join(RACINE, 'data/pack.db'), PACK);
journal.configurer(path.join(TMP, 'logs'), {}, { console: false });

let nOk = 0, nKo = 0;
function test(nom, fn) {
  try { fn(); nOk++; console.log('  ok  ' + nom); }
  catch (e) { nKo++; console.log('  KO  ' + nom + '\n      ' + String(e.stack || e).split('\n').slice(0, 8).join('\n      ')); }
}

function ouvrir(dir) {
  db.fermer();
  const a = appareil.charger(dir, { nom: path.basename(dir) });
  etat.configurer({ appareil: a });
  const images = path.join(dir, 'images-locales');
  fs.mkdirSync(images, { recursive: true });
  edition.configurer(images);
  service.configurer({ dossierUser: dir, imagesLocales: images });
  sauvegarde.configurer({ user: path.join(dir, 'utilisateur.db'), imagesLocales: images, pack: PACK, versionApp: 'test' });
  db.ouvrir(path.join(dir, 'utilisateur.db'), PACK);
  jeu.reinitialiserSac();
  return { dir, images };
}

console.log('snapshots gzip');

test('bombe de decompression rejetee sans tout allouer', () => {
  // 400 Mo de zeros -> ~400 Ko compresses, ISIZE honnete = 400 Mo.
  const bombe = zlib.gzipSync(Buffer.alloc(400 * 1024 * 1024));
  assert.ok(bombe.length < 2 * 1024 * 1024, 'la bombe doit rester petite compressee');
  const avant = process.memoryUsage().rss;
  assert.throws(() => format.decoderSnapshot(bombe), /volumineux/i);
  const pic = (process.memoryUsage().rss - avant) / 1e6;
  assert.ok(pic < 150, 'pas de grosse allocation (pic ~' + pic.toFixed(0) + ' Mo)');
});

test('snapshot compresse trop gros rejete', () => {
  const gros = Buffer.concat([zlib.gzipSync(Buffer.from('{}')), Buffer.alloc(format.SNAPSHOT_COMPRESSE_MAX + 1)]);
  assert.throws(() => format.decoderSnapshot(gros), /volumineux/i);
});

test('snapshot legitime passe', () => {
  const obj = { tetes: {}, vecteur: { aaaa1111: '0001' }, n: 42 };
  assert.deepEqual(format.decoderSnapshot(format.encoderSnapshot(obj)), obj);
});

console.log('segments ndjson');

test('segment avec trop d ops rejete', () => {
  const ligne = JSON.stringify({ hlc: '0', appareil: 'a', entite: 'tag', cle: 'x', champ: 'livre', valeur: null });
  const brut = (ligne + '\n').repeat(format.SEGMENT_OPS_MAX + 5);
  assert.throws(() => format.lireNdjson(brut, 'test'), /volumineux/i);
});

test('segment trop gros en octets rejete', () => {
  const brut = 'x'.repeat(format.SEGMENT_OCTETS_MAX + 1);
  assert.throws(() => format.lireNdjson(brut, 'test'), /volumineux/i);
});

test('segment normal relu', () => {
  const ops = [{ hlc: '1', appareil: 'a', entite: 'tag', cle: 'x', champ: 'livre', valeur: '1' }];
  assert.deepEqual(format.lireNdjson(format.ecrireNdjson(ops), 'test'), ops);
});

console.log('import zip');

function zipDeBase(user) {
  const zip = new AdmZip();
  zip.addLocalFile(user, '');
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({ app: 'test' })));
  return zip;
}

test('image a nom pirate non ecrite dans images-locales', () => {
  const a = ouvrir(fs.mkdtempSync(path.join(TMP, 'a-')));
  const refZip = fs.mkdtempSync(path.join(TMP, 'z-'));
  const user = path.join(refZip, 'utilisateur.db');
  db.exporterVers(user);
  const zip = zipDeBase(user);
  zip.addFile('images-locales/piege.exe', Buffer.from('MZ...'));
  zip.addFile('images-locales/..%2f..%2fevil.lnk', Buffer.from('x'));
  zip.addFile('images-locales/' + '0'.repeat(8) + '-' + '0'.repeat(4) + '-' + '0'.repeat(4) + '-' + '0'.repeat(4) + '-' + '0'.repeat(12) + '.jpg', Buffer.from('vraie image'));
  const cheminZip = path.join(refZip, 's.zip');
  zip.writeZip(cheminZip);

  const r = sauvegarde.importer(cheminZip);
  assert.ok(!r.erreur, 'import ok : ' + r.erreur);
  const fichiers = fs.readdirSync(a.images);
  assert.ok(!fichiers.includes('piege.exe'), 'le .exe ne doit pas etre ecrit');
  assert.ok(!fichiers.some((f) => /evil|\.lnk/.test(f)), 'aucun nom pirate');
  assert.ok(fichiers.some((f) => format.RE_IMAGE.test(f)), 'la vraie image uuid est copiee');
});

test('utilisateur.db demesure refuse', () => {
  const a = ouvrir(fs.mkdtempSync(path.join(TMP, 'a-')));
  const refZip = fs.mkdtempSync(path.join(TMP, 'z-'));
  // Faux « utilisateur.db » enorme (zeros, tres compressible) : AdmZip annonce
  // sa taille decompressee -> refus avant allocation.
  const faux = path.join(refZip, 'utilisateur.db');
  fs.writeFileSync(faux, Buffer.alloc(600 * 1024 * 1024));
  const zip = new AdmZip();
  zip.addLocalFile(faux, '');
  const cheminZip = path.join(refZip, 'bombe.zip');
  zip.writeZip(cheminZip);
  const r = sauvegarde.importer(cheminZip);
  assert.ok(r.erreur && /volumineuse/i.test(r.erreur), 'doit refuser : ' + JSON.stringify(r));
});

console.log(`\n${nOk} ok, ${nKo} KO`);
process.exit(nKo ? 1 : 0);
