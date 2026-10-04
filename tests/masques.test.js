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
const { calculer, CHAMPS, BIT, valeur } = require(path.join(RACINE, 'src/main/masques.js'));

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

console.log('paliers de difficulte (minC et minC+1)');

const nb = (m) => champsDe(m).length;
const palier = (masks, mode) => {
  const minC = Math.min(...masks.map(nb));
  if (mode === 'normal') { const p = masks.filter((m) => nb(m) === minC + 1); if (p.length) return p; }
  return masks.filter((m) => nb(m) === minC);
};

test('chaque masque stocke montre minC ou minC+1 champs (pas plus)', () => {
  const oeuvres = [
    oeuvre('a', { artiste: 'Repine', titre: 'Les bateliers de la Volga', lieu: 'Musee Russe', description: DESC, image: 'a.jpg' }),
    oeuvre('b', { artiste: 'Serov', titre: 'Jeune fille', lieu: 'Tretiakov', description: DESC, image: 'b.jpg' })
  ];
  const masks = calculer(oeuvres).get('a');
  const minC = Math.min(...masks.map(nb));
  assert.ok(masks.every((m) => nb(m) <= minC + 1), 'un masque depasse minC+1 : ' + masks.map(champsDe).map((x) => x.join('+')));
  // difficile = 1 champ, normal = 2 champs (cette tuile a une image -> {image} seul possible)
  assert.ok(palier(masks, 'difficile').every((m) => nb(m) === 1));
  assert.ok(palier(masks, 'normal').every((m) => nb(m) === 2));
});

console.log('regression sur le vrai pack');

test('pack : 0 bloquee, difficile=1 champ et normal=2 champs pour toutes', () => {
  const Database = require(path.join(RACINE, 'node_modules/better-sqlite3'));
  const d = new Database(path.join(RACINE, 'data/pack.db'), { readonly: true });
  const oeuvres = d.prepare('SELECT * FROM oeuvres').all();
  d.close();
  const m = calculer(oeuvres);
  let bloquees = 0, maxChamps = 0, difficile1 = 0, normal2 = 0;
  for (const o of oeuvres) {
    const masks = m.get(o.id) || [];
    if (!masks.length) { bloquees++; continue; }
    const minC = Math.min(...masks.map(nb));
    for (const mk of masks) { assert.ok(nb(mk) <= minC + 1); maxChamps = Math.max(maxChamps, nb(mk)); }
    if (palier(masks, 'difficile').every((x) => nb(x) === 1)) difficile1++;
    if (palier(masks, 'normal').every((x) => nb(x) === 2)) normal2++;
  }
  assert.equal(bloquees, 0, bloquees + ' oeuvre(s) bloquee(s)');
  assert.equal(difficile1, oeuvres.length, 'difficile != 1 champ pour ' + (oeuvres.length - difficile1) + ' tuiles');
  assert.equal(normal2, oeuvres.length, 'normal != 2 champs pour ' + (oeuvres.length - normal2) + ' tuiles');
  assert.ok(maxChamps <= 2, 'max champs stockes = ' + maxChamps);
});

console.log('aucun champ vide / ponctuation revele');

test('un champ vide ou « - » n\'est jamais revele ; « N/A » (texte) reste valide', () => {
  // lieu « - » : ne doit jamais apparaitre dans un masque (valeur normalisee vide).
  const oeuvres = [
    oeuvre('a', { artiste: 'Picasso', titre: 'Guernica', lieu: '-', description: DESC, image: 'a.jpg' }),
    oeuvre('b', { artiste: 'Dali', titre: 'Persistance', lieu: '?', description: DESC, image: 'b.jpg' })
  ];
  const m = calculer(oeuvres);
  for (const mk of m.get('a')) assert.ok(!(mk & BIT.lieu), 'lieu « - » revele : ' + champsDe(mk).join('+'));

  // « N/A » comme artiste : du texte reel -> peut etre revele.
  const avecNA = [
    oeuvre('x', { artiste: 'N/A', titre: 'Sans attribution', description: DESC, image: 'x.jpg' }),
    oeuvre('y', { artiste: 'N/A', titre: 'Autre anonyme', description: DESC, image: 'y.jpg' })
  ];
  const mx = calculer(avecNA).get('x');
  assert.ok(mx.some((mk) => mk & BIT.artiste), '« N/A » devrait pouvoir servir d\'indice');
});

test('pack : aucun masque ne revele un champ vide', () => {
  const Database = require(path.join(RACINE, 'node_modules/better-sqlite3'));
  const d = new Database(path.join(RACINE, 'data/pack.db'), { readonly: true });
  const pack = d.prepare('SELECT * FROM oeuvres').all();
  d.close();
  const mp = calculer(pack);
  let vides = 0;
  for (const o of pack) for (const mk of mp.get(o.id) || []) {
    for (const c of CHAMPS) if ((mk & BIT[c]) && valeur(o, c) === '') vides++;
  }
  assert.equal(vides, 0, vides + ' masque(s) revelent un champ vide');
});

console.log('difficile ne montre jamais lieu / tags / date seuls');

test('aucun masque 1-champ n\'est lieu, tags ou date (evocateur obligatoire)', () => {
  // La date n'est meme pas un champ affichable (regle non negociable).
  assert.ok(!CHAMPS.includes('date'), 'la date ne doit pas etre un champ de masque');
  const EVOC1 = new Set([BIT.image, BIT.artiste, BIT.titre, BIT.description]);

  // Synthetique : lieu et titre remplis -> difficile montre le titre, jamais le lieu.
  const oeuvres = [
    oeuvre('a', { titre: 'La Ronde de nuit', lieu: 'Rijksmuseum', image: 'a.jpg' }),
    oeuvre('b', { titre: 'La Laitiere', lieu: 'Rijksmuseum', image: 'b.jpg' })
  ];
  for (const mk of calculer(oeuvres).get('a')) {
    if (nb(mk) === 1) assert.ok(EVOC1.has(mk), 'masque 1-champ non evocateur : ' + champsDe(mk).join('+'));
    assert.ok(mk !== BIT.lieu && mk !== BIT.tags, 'masque {lieu}/{tags} seul interdit');
  }

  // Pack entier : idem.
  const Database = require(path.join(RACINE, 'node_modules/better-sqlite3'));
  const d = new Database(path.join(RACINE, 'data/pack.db'), { readonly: true });
  const pack = d.prepare('SELECT * FROM oeuvres').all();
  d.close();
  const mp = calculer(pack);
  for (const o of pack) {
    for (const mk of mp.get(o.id) || []) {
      assert.ok(mk !== BIT.lieu && mk !== BIT.tags, '#' + o.ref + ' a un masque {lieu}/{tags} seul');
      if (nb(mk) === 1) assert.ok(EVOC1.has(mk), '#' + o.ref + ' masque 1-champ non evocateur : ' + champsDe(mk).join('+'));
    }
  }
});

console.log('champs manquants (avertissement editeur)');

test('manquesDe liste les champs vides / description trop courte', () => {
  const { manquesDe } = require(path.join(RACINE, 'src/main/edition.js'));
  // Tuile titre seul : tout le reste manque.
  assert.deepEqual(
    manquesDe({ titre: 'test', artiste: '', date: '', lieu: '', description: '', tags: '', image: '' }).sort(),
    ['artiste', 'date', 'description', 'image', 'lieu', 'tags'].sort()
  );
  // Description < 60 car. compte comme manquante.
  assert.ok(manquesDe({ titre: 't', description: 'court' }).includes('description'));
  // Tuile complete : rien ne manque.
  assert.deepEqual(manquesDe({
    titre: 'La Joconde', artiste: 'De Vinci', date: '1503', lieu: 'Louvre',
    description: DESC, tags: 'portrait, renaissance', image: 'x.jpg'
  }), []);
});

console.log(`\n${nOk} ok, ${nKo} KO`);
process.exit(nKo ? 1 : 0);
