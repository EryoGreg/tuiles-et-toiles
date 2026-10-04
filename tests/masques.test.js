'use strict';
/**
 * Moteur de masques : image absente, seuil « artiste evocateur », fuite
 * generalisee (un champ visible ne trahit aucun champ cache), et masques
 * minimaux (aucun masque domine). Regression sur le vrai pack : rien de bloque.
 *
 *     node scripts/lancer-node.js tests/masques.test.js
 */

const assert = require('assert/strict');
const path = require('path');

const RACINE = path.resolve(__dirname, '..');
const { calculer, CHAMPS, BIT } = require(path.join(RACINE, 'src/main/masques.js'));

let nOk = 0, nKo = 0;
function test(nom, fn) {
  try { fn(); nOk++; console.log('  ok  ' + nom); }
  catch (e) { nKo++; console.log('  KO  ' + nom + '\n      ' + String(e.stack || e).split('\n').slice(0, 6).join('\n      ')); }
}

const vide = { artiste: '', titre: '', date: '', lieu: '', description: '', tags: '', image: '' };
const oeuvre = (id, o) => ({ id, ...vide, ...o });
const DESC = 'Une description assez longue pour compter comme un indice evocateur a elle seule.'; // >= 60
const champsDe = (m) => CHAMPS.filter((c) => m & BIT[c]);
const aLeBit = (masks, bits) => masks.some((m) => m === bits);

console.log('image absente');

test('tuile sans image : aucun masque ne montre l\'image, mais elle reste jouable', () => {
  const oeuvres = [
    oeuvre('a', { titre: 'Les Glaneuses', description: DESC }),
    oeuvre('b', { titre: 'Angelus', description: DESC })
  ];
  const m = calculer(oeuvres);
  const ma = m.get('a');
  assert.ok(ma.length > 0, 'la tuile sans image doit rester jouable');
  assert.ok(!ma.some((mk) => mk & BIT.image), 'aucun masque ne doit montrer une image inexistante');
});

test('deux tuiles sans image, meme texte visible : l\'image ne discrimine pas', () => {
  // Memes titre/description : seule une image les distinguerait — elles n'en ont
  // pas, donc aucune n'est discriminable -> aucun masque (ancien bug : l'id
  // servait d'image fantome et {image} passait).
  const oeuvres = [
    oeuvre('a', { titre: 'Sans titre', description: DESC }),
    oeuvre('b', { titre: 'Sans titre', description: DESC })
  ];
  const m = calculer(oeuvres);
  assert.equal(m.get('a').length, 0);
  assert.equal(m.get('b').length, 0);
});

test('tuile avec image : {image} seule est un masque valide', () => {
  const oeuvres = [
    oeuvre('a', { titre: 'Toile A', image: 'a.jpg' }),
    oeuvre('b', { titre: 'Toile B', image: 'b.jpg' })
  ];
  const m = calculer(oeuvres);
  assert.ok(aLeBit(m.get('a'), BIT.image), '{image} doit etre valide quand l\'image existe');
});

console.log('fuite generalisee');

test('lieu « Musee Picasso » ne s\'affiche jamais pendant que l\'artiste « Picasso » est cache', () => {
  const oeuvres = [
    oeuvre('a', { artiste: 'Picasso', titre: 'Guernica', lieu: 'Musee Picasso', description: DESC, image: 'a.jpg' }),
    oeuvre('b', { artiste: 'Dali', titre: 'Persistance', lieu: 'MoMA', description: DESC, image: 'b.jpg' })
  ];
  const m = calculer(oeuvres);
  for (const mk of m.get('a')) {
    const fuite = (mk & BIT.lieu) && !(mk & BIT.artiste);
    assert.ok(!fuite, 'masque fuyant: ' + champsDe(mk).join('+'));
  }
});

console.log('artiste evocateur (jusqu\'a 6 oeuvres)');

function memeArtiste(n) {
  // n toiles du meme artiste, titres et tags uniques, sans image ni description
  // forte -> le seul evocateur possible d'un masque {artiste,tags} est l'artiste.
  return Array.from({ length: n }, (_, i) =>
    oeuvre('o' + i, { artiste: 'Monet', titre: 'Toile ' + i, tags: 'serie' + i }));
}

test('artiste a 6 oeuvres : {artiste, tags} (titre cache) est evocateur et valide', () => {
  const m = calculer(memeArtiste(6));
  assert.ok(aLeBit(m.get('o0'), BIT.artiste | BIT.tags), '{artiste,tags} doit survivre a 6 oeuvres');
});

test('artiste a 7 oeuvres : {artiste, tags} n\'est plus evocateur', () => {
  const m = calculer(memeArtiste(7));
  assert.ok(!aLeBit(m.get('o0'), BIT.artiste | BIT.tags), '{artiste,tags} ne doit pas passer a 7 oeuvres');
  assert.ok(m.get('o0').some((mk) => mk & BIT.titre), 'la tuile reste jouable via le titre');
});

console.log('masques minimaux (antichaine)');

function antichaine(masks) {
  return !masks.some((a) => masks.some((b) => a !== b && (a & b) === b));
}

test('aucun masque n\'est domine par un autre (corpus synthetique)', () => {
  const oeuvres = [
    oeuvre('a', { artiste: 'Repine', titre: 'Les bateliers de la Volga', lieu: 'Musee Russe', description: DESC, image: 'a.jpg' }),
    oeuvre('b', { artiste: 'Serov', titre: 'Jeune fille', lieu: 'Tretiakov', description: DESC, image: 'b.jpg' })
  ];
  const m = calculer(oeuvres);
  assert.ok(antichaine(m.get('a')), 'masques de a non minimaux : ' + m.get('a').map(champsDe).map((x) => x.join('+')));
});

console.log('regression sur le vrai pack');

test('pack : 0 oeuvre bloquee, antichaine partout, <= 2 champs visibles par masque', () => {
  const Database = require(path.join(RACINE, 'node_modules/better-sqlite3'));
  const d = new Database(path.join(RACINE, 'data/pack.db'), { readonly: true });
  const oeuvres = d.prepare('SELECT * FROM oeuvres').all();
  d.close();
  const m = calculer(oeuvres);
  let bloquees = 0, maxChamps = 0;
  for (const o of oeuvres) {
    const masks = m.get(o.id) || [];
    if (!masks.length) bloquees++;
    assert.ok(antichaine(masks), 'masque domine pour #' + o.ref);
    for (const mk of masks) maxChamps = Math.max(maxChamps, champsDe(mk).length);
  }
  assert.equal(bloquees, 0, bloquees + ' oeuvre(s) du pack bloquee(s)');
  assert.ok(maxChamps <= 2, 'un masque du pack montre ' + maxChamps + ' champs (trop)');
});

console.log(`\n${nOk} ok, ${nKo} KO`);
process.exit(nKo ? 1 : 0);
