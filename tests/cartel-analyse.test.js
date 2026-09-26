'use strict';
/**
 * Rangement des lignes d'un cartel dans les champs (src/main/cartel-analyse.js),
 * sur de vrais cartels retranscrits (tests/cartels-exemples.js).
 *
 *     node tests/cartel-analyse.test.js
 */

const assert = require('assert/strict');
const path = require('path');

const RACINE = path.resolve(__dirname, '..');
const { analyser, estDate, joindre } = require(path.join(RACINE, 'src/main/cartel-analyse'));
const EXEMPLES = require('./cartels-exemples');

let nOk = 0, nKo = 0;
function test(nom, fn) {
  try { fn(); nOk++; console.log('  ok  ' + nom); }
  catch (e) { nKo++; console.log('  KO  ' + nom + '\n      ' + String(e.message || e).split('\n').slice(0, 8).join('\n      ')); }
}

console.log('cartel : reconnaissance');

test('dates', () => {
  for (const d of ['1632', 'Vers 1890', 'vers 1863', 'Fin IVe – début Ve siècle apr. J.-C', 'milieu du XVIe siècle',
    '1908-1910', 'XIXe siècle', 'entre 1823 et 1842', 'IIe siècle av. J.-C.']) assert.ok(estDate(d), d);
  for (const d of ['Huile sur toile', 'Buire', 'Journées de juillet 1830', 'Le Bain de Diane', 'Paris, vers 1863']) assert.ok(!estDate(d), d);
});

test('jointure : coupure de mot, trait d’union, puces, blocs', () => {
  assert.equal(joindre([{ texte: 'une ap-', bloc: 0 }, { texte: 'proche', bloc: 0 }]), 'une approche');
  assert.equal(joindre([{ texte: 'Sainte-', bloc: 0 }, { texte: 'Victoire', bloc: 0 }]), 'Sainte-Victoire');
  assert.equal(joindre([{ texte: 'a', bloc: 0 }, { texte: '• b', bloc: 0 }, { texte: 'c', bloc: 1 }]), 'a\n• b\nc');
});

console.log('cartel : exemples reels');

for (const ex of EXEMPLES) {
  test(ex.nom, () => {
    const entree = ex.lignes.map(([texte, hauteur, bloc]) => ({ texte, hauteur, bloc }));
    const { champs, roles } = analyser(entree);
    const bilan = ex.lignes.map(([t], i) => '        ' + roles[i].padEnd(11) + t).join('\n');
    for (const [k, v] of Object.entries(ex.attendu)) {
      const ok = v instanceof RegExp ? v.test(champs[k]) : champs[k] === v;
      assert.ok(ok, k + ' = ' + JSON.stringify(champs[k]) + ', attendu ' + v + '\n' + bilan);
    }
  });
}

test('suite d’une ligne de provenance : provenance (Corot, « 1858. »)', () => {
  const ex = EXEMPLES.find((e) => /Corot/.test(e.nom));
  const { roles } = analyser(ex.lignes.map(([texte, hauteur, bloc]) => ({ texte, hauteur, bloc })));
  assert.equal(roles[ex.lignes.findIndex(([t]) => t === '1858.')], 'provenance');
});

test('rien lu -> champs vides', () => {
  const { champs } = analyser([]);
  assert.deepEqual(champs, { titre: '', artiste: '', date: '', description: '', tags: '' });
});

console.log(`\n${nOk} ok, ${nKo} KO`);
process.exit(nKo ? 1 : 0);
