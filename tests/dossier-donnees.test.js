'use strict';
/**
 * Reprise de l'ancien dossier de donnees PC (« Tuiles et Toiles » ->
 * « tuiles-et-toiles », src/main/dossier-donnees.js).
 *
 *     node scripts/lancer-node.js tests/dossier-donnees.test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RACINE = path.resolve(__dirname, '..');
const dd = require(path.join(RACINE, 'src/main/dossier-donnees'));

let nOk = 0, nKo = 0;
function test(nom, fn) {
  try { fn(); nOk++; console.log('  ok  ' + nom); }
  catch (e) { nKo++; console.log('  KO  ' + nom + '\n      ' + String(e.stack || e).split('\n').slice(0, 6).join('\n      ')); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-dossier-'));
let n = 0;
function ancienPlein() {
  const d = path.join(TMP, 'ancien-' + (++n));
  fs.mkdirSync(path.join(d, 'images-locales'), { recursive: true });
  fs.mkdirSync(path.join(d, 'images-cache'), { recursive: true });
  fs.writeFileSync(path.join(d, 'utilisateur.db'), 'BASE');
  fs.writeFileSync(path.join(d, 'appareil.json'), '{"id":"aaaa0000"}');
  fs.writeFileSync(path.join(d, 'drive-jeton.bin'), 'JETON');
  fs.writeFileSync(path.join(d, 'pack.db'), 'PACK');
  fs.writeFileSync(path.join(d, 'images-locales', 'a.jpg'), 'A');
  fs.writeFileSync(path.join(d, 'images-cache', 'p.jpg'), 'P');
  fs.writeFileSync(path.join(d, 'Preferences'), 'chromium');   // pas repris
  return d;
}
const neuf = () => path.join(TMP, 'nouveau-' + (++n));
const lire = (...p) => fs.readFileSync(path.join(...p), 'utf8');

test('nouveau dossier sans base : tout ce qui compte est recopie, a l\'identique', () => {
  const a = ancienPlein(), b = neuf();
  const r = dd.reprendre(a, b);
  assert.deepEqual(r.copies.sort(), ['appareil.json', 'drive-jeton.bin', 'images-cache/', 'images-locales/', 'pack.db', 'utilisateur.db'].sort());
  assert.equal(lire(b, 'utilisateur.db'), 'BASE');
  assert.equal(lire(b, 'appareil.json'), '{"id":"aaaa0000"}');
  assert.equal(lire(b, 'images-locales', 'a.jpg'), 'A');
  assert.equal(lire(b, 'images-cache', 'p.jpg'), 'P');
  assert.ok(!fs.existsSync(path.join(b, 'Preferences')));
  assert.ok(!fs.existsSync(path.join(b, 'utilisateur.db.reprise')));
  assert.equal(lire(a, 'utilisateur.db'), 'BASE', 'ancien intact');
});

test('le nouveau a deja une base : rien n\'est touche', () => {
  const a = ancienPlein(), b = neuf();
  fs.mkdirSync(b, { recursive: true });
  fs.writeFileSync(path.join(b, 'utilisateur.db'), 'ACTUELLE');
  assert.equal(dd.reprendre(a, b), null);
  assert.equal(lire(b, 'utilisateur.db'), 'ACTUELLE');
  assert.ok(!fs.existsSync(path.join(b, 'appareil.json')));
});

test('ancien sans base (ou absent) : rien', () => {
  const a = path.join(TMP, 'vide'), b = neuf();
  fs.mkdirSync(a);
  assert.equal(dd.reprendre(a, b), null);
  assert.equal(dd.reprendre(path.join(TMP, 'inexistant'), b), null);
  assert.ok(!fs.existsSync(b), 'pas de dossier cree pour rien');
});

test('meme dossier (casse differente sous Windows) ou arguments vides : rien', () => {
  const a = ancienPlein();
  assert.equal(dd.reprendre(a, a.toUpperCase()), null);
  assert.equal(dd.reprendre(a, a), null);
  assert.equal(dd.reprendre('', a), null);
  assert.equal(dd.reprendre(a, null), null);
});

test('fichier deja present dans le nouveau dossier : jamais ecrase', () => {
  const a = ancienPlein(), b = neuf();
  fs.mkdirSync(path.join(b, 'images-locales'), { recursive: true });
  fs.writeFileSync(path.join(b, 'appareil.json'), '{"id":"bbbb1111"}');
  fs.writeFileSync(path.join(b, 'images-locales', 'a.jpg'), 'NOUVELLE');
  const r = dd.reprendre(a, b);
  assert.ok(!r.copies.includes('appareil.json'));
  assert.equal(lire(b, 'appareil.json'), '{"id":"bbbb1111"}');
  assert.equal(lire(b, 'images-locales', 'a.jpg'), 'NOUVELLE');
  assert.equal(lire(b, 'utilisateur.db'), 'BASE');
});

test('reprise interrompue (images copiees, pas encore la base) : refaite au lancement suivant', () => {
  const a = ancienPlein(), b = neuf();
  fs.mkdirSync(path.join(b, 'images-locales'), { recursive: true });
  fs.writeFileSync(path.join(b, 'images-locales', 'a.jpg'), 'A');
  fs.writeFileSync(path.join(b, 'utilisateur.db.reprise'), 'MOITIE');   // copie coupee net
  const r = dd.reprendre(a, b);
  assert.ok(r.copies.includes('utilisateur.db'));
  assert.equal(lire(b, 'utilisateur.db'), 'BASE');
  assert.equal(dd.reprendre(a, b), null, 'une seule fois');
});

test('noms des dossiers', () => {
  assert.equal(dd.NOM, 'tuiles-et-toiles');
  assert.equal(dd.ANCIEN_NOM, 'Tuiles et Toiles');
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* verrou */ }
console.log(`\n${nOk} ok, ${nKo} KO`);
process.exit(nKo ? 1 : 0);
