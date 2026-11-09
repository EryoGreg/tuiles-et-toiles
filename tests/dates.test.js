'use strict';
/**
 * Dates des tuiles (src/main/dates.js) : convention d'ecriture, lecture en
 * annees, idempotence sur tout le pack, normalisation a l'ecriture (edition).
 *
 *     node scripts/lancer-node.js tests/dates.test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const RACINE = path.resolve(__dirname, '..');
const src = (p) => require(path.join(RACINE, 'src/main', p));
const dates = src('dates');

let nOk = 0, nKo = 0;
function test(nom, fn) {
  try { fn(); nOk++; console.log('  ok  ' + nom); }
  catch (e) { nKo++; console.log('  KO  ' + nom + '\n      ' + String(e.stack || e).split('\n').slice(0, 6).join('\n      ')); }
}

test('convention : formes relevees dans les tuiles', () => {
  const cas = {
    '1665': '1665', '1550-1560': '1550-1560', '1570-75': '1570-1575', '1766–67': '1766-1767',
    '1588 - 1599': '1588-1599', '1888 -1891': '1888-1891', 'entre 1920 et 1930': '1920-1930', '1926 à 1928': '1926-1928',
    'vers 1580': 'vers 1580', 'Vers 1700': 'vers 1700', 'V.1860': 'vers 1860', 'V1813': 'vers 1813', 'C. 1930': 'vers 1930',
    'c1970': 'vers 1970', 'Circa 1780': 'vers 1780', 'C. 1542-1545,': 'vers 1542-1545', 'V.1645-1648': 'vers 1645-1648',
    '1820,': '1820', 'février 1928.': 'février 1928', 'années 1760': 'années 1760', 'l897': '1897',
    'XIXs': 'XIXe siècle', 'XIX siècle': 'XIXe siècle', 'XVII s': 'XVIIe siècle', 'XVI-XVII': 'XVIe-XVIIe siècle',
    'V-XVI': 'Ve-XVIe siècle', 'Fin XIX': 'fin XIXe siècle', '1ere moitié XVs': '1re moitié XVe siècle',
    'première moitié XVIIIs': '1re moitié XVIIIe siècle', 'premier tiers du XIX siècle': '1er tiers XIXe siècle',
    '-450 av J.-C': '450 av. J.-C.', '-700 / -500 av J.-C.': '700-500 av. J.-C.', 'V. 17 000 av J.-C.': 'vers 17 000 av. J.-C.',
    'V-IV av. J.-C, XIX': 'Ve-IVe siècle av. J.-C. (XIXe siècle)', '64 ap J.-C.': '64 apr. J.-C.',
    'I siècle après JC': 'Ier siècle apr. J.-C.', 'II s ap J.-C.': 'IIe siècle apr. J.-C.',
    'à partir de 1750': 'après 1750', 'avant 1856': 'avant 1856', 'depuis 2009': 'depuis 2009',
    'Directoire': '1795-1799', '': '', '  1904  ': '1904'
  };
  for (const [e, s] of Object.entries(cas)) assert.equal(dates.normaliser(e), s, JSON.stringify(e));
});

test('texte incompris : rendu tel quel (nettoye), jamais perdu', () => {
  assert.equal(dates.normaliser('  époque  Meiji '), 'époque Meiji');
  assert.equal(dates.analyser('époque Meiji'), null);
});

test('lecture en annees', () => {
  assert.deepEqual(dates.analyser('1665'), { debut: 1665, fin: 1665, estimee: false });
  assert.deepEqual(dates.analyser('1550-1560'), { debut: 1550, fin: 1560, estimee: false });
  assert.deepEqual(dates.analyser('vers 1580'), { debut: 1580, fin: 1580, estimee: true });
  assert.deepEqual(dates.analyser('années 1760'), { debut: 1760, fin: 1769, estimee: true });
  assert.deepEqual(dates.analyser('XIXe siècle'), { debut: 1801, fin: 1900, estimee: true });
  assert.deepEqual(dates.analyser('fin XIXe siècle'), { debut: 1870, fin: 1900, estimee: true });
  assert.deepEqual(dates.analyser('700-500 av. J.-C.'), { debut: -700, fin: -500, estimee: false });
  assert.deepEqual(dates.analyser('Ve-IVe siècle av. J.-C. (XIXe siècle)'), { debut: -500, fin: -301, estimee: true });
  assert.deepEqual(dates.analyser('vers 17 000 av. J.-C.'), { debut: -17000, fin: -17000, estimee: true });
  assert.deepEqual(dates.analyser('64 apr. J.-C.'), { debut: 64, fin: 64, estimee: false });
  assert.deepEqual(dates.analyser('février 1928'), { debut: 1928, fin: 1928, estimee: false });
  assert.equal(dates.analyser('depuis 2009').debut, 2009);
  assert.equal(dates.analyser(''), null);
});

test('pack : toutes les dates a la convention, lisibles, normaliser idempotent', () => {
  const d = new Database(path.join(RACINE, 'data/pack.db'), { readonly: true });
  const l = d.prepare('SELECT ref, date FROM oeuvres').all();
  d.close();
  const illisibles = l.filter((o) => o.date && !dates.analyser(o.date)).map((o) => o.ref + ' ' + o.date);
  const non = l.filter((o) => dates.normaliser(o.date) !== o.date).map((o) => o.ref + ' ' + o.date);
  assert.deepEqual(illisibles, []);
  assert.deepEqual(non, []);
});

test('edition : la date est ecrite a la convention', () => {
  const db = src('db');
  const etat = src('synchro/etat');
  const edition = src('edition');
  const appareil = src('synchro/appareil');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-dates-'));
  const pack = path.join(tmp, 'pack.db');
  fs.copyFileSync(path.join(RACINE, 'data/pack.db'), pack);
  etat.configurer({ appareil: appareil.charger(tmp, { nom: 'essai' }) });
  edition.configurer(path.join(tmp, 'images-locales'));
  db.ouvrir(path.join(tmp, 'utilisateur.db'), pack);
  const r = edition.creer({ titre: 'Essai', artiste: 'X', date: 'C. 1542-45,' });
  assert.equal(edition.tuile(r.id).date, 'vers 1542-1545');
  edition.modifier(r.id, { ...edition.tuile(r.id), date: 'XIXs' });
  assert.equal(edition.tuile(r.id).date, 'XIXe siècle');
  db.fermer();
});

console.log(`\n${nOk} ok, ${nKo} KO`);
process.exit(nKo ? 1 : 0);
