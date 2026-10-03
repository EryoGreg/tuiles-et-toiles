'use strict';
/**
 * Lecture de cartel sur PC (src/main/cartel-pc.js) : conversion des lignes de
 * la reconnaissance de Windows (cadres, hauteurs, blocs reconstitues), puis un
 * vrai passage par Windows.Media.Ocr sur une image fabriquee (Windows seulement).
 *
 *     node scripts/lancer-node.js tests/cartel-pc.test.js
 */

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RACINE = path.resolve(__dirname, '..');
const cartel = require(path.join(RACINE, 'src/main/cartel-pc'));
const { analyser } = require(path.join(RACINE, 'src/main/cartel-analyse'));

let nOk = 0, nKo = 0;
async function test(nom, fn) {
  try { await fn(); nOk++; console.log('  ok  ' + nom); }
  catch (e) { nKo++; console.log('  KO  ' + nom + '\n      ' + String(e.stack || e).split('\n').slice(0, 7).join('\n      ')); }
}

/** Ligne Windows : texte + mots [x, y, l, h] de meme hauteur, cote a cote. */
function ligne(t, x, y, h) {
  let cx = x;
  return { t, m: t.split(' ').map((w) => { const m = [cx, y, Math.round(w.length * h * 0.55), h]; cx += m[2] + Math.round(h * 0.3); return m; }) };
}

(async () => {
  await test('cadre = union des mots, hauteur = moyenne des mots', () => {
    const [l] = cartel.lignesDepuisOcr({ lignes: [{ t: 'Huile sur toile', m: [[10, 20, 50, 30], [70, 22, 40, 26], [120, 18, 60, 34]] }] });
    assert.deepEqual(l.cadre, { x: 10, y: 18, l: 170, h: 34 });
    assert.equal(l.hauteur, 30);
    assert.equal(l.texte, 'Huile sur toile');
    assert.equal(l.bloc, 0);
  });

  await test('lignes remises de haut en bas, vides ignorees', () => {
    const l = cartel.lignesDepuisOcr({ lignes: [ligne('B', 0, 200, 30), { t: '  ', m: [[0, 0, 5, 5]] }, ligne('A', 0, 100, 30), { t: 'sans mots', m: [] }] });
    assert.deepEqual(l.map((x) => x.texte), ['A', 'B']);
  });

  await test('blocs : paragraphe serre = un bloc ; grand ecart ou taille differente = nouveau bloc', () => {
    const l = cartel.lignesDepuisOcr({ lignes: [
      ligne('Claude MONET', 100, 90, 50),
      ligne('Paris, 1840 - Giverny, 1926', 100, 160, 28),       // taille differente
      ligne('La Gare Saint-Lazare', 100, 270, 45),             // grand ecart
      ligne('1877', 100, 330, 44),                             // ecart 15 : meme bloc
      ligne('Monet installe son chevalet', 100, 480, 26),
      ligne('et peint la vapeur.', 100, 516, 26),              // interligne : meme bloc
      ligne('Legs Caillebotte, 1894', 100, 640, 26)            // grand ecart
    ] });
    assert.deepEqual(l.map((x) => x.bloc), [0, 1, 2, 2, 3, 3, 4]);
  });

  await test('le resultat se range comme un cartel lu par ML Kit', () => {
    const l = cartel.lignesDepuisOcr({ lignes: [
      ligne('Claude MONET', 100, 90, 50),
      ligne('Paris, 1840 - Giverny, 1926', 100, 160, 28),
      ligne('La Gare Saint-Lazare', 100, 270, 45),
      ligne('1877', 100, 335, 31),
      ligne('Huile sur toile', 100, 400, 28),
      ligne('Monet installe son chevalet dans la gare et peint la vapeur,', 100, 500, 26),
      ligne('la lumière et le mouvement des locomotives.', 100, 536, 26)
    ] });
    const { champs } = analyser(l);
    assert.equal(champs.titre, 'La Gare Saint-Lazare');
    assert.equal(champs.artiste, 'Claude MONET');
    assert.equal(champs.date, '1877');
    assert.match(champs.description, /^Monet installe .* locomotives\.$/);
  });

  await test('entree vide ou abimee : aucune ligne, pas d\'exception', () => {
    assert.deepEqual(cartel.lignesDepuisOcr(null), []);
    assert.deepEqual(cartel.lignesDepuisOcr({ lignes: [{ t: 'x', m: [[1, 2]] }] }), []);
  });

  await test('script PowerShell : pas de chemin en dur, langue fr-FR demandee, sortie UTF-8', () => {
    assert.match(cartel.SCRIPT, /\$env:TT_OCR_IMAGE/);
    assert.match(cartel.SCRIPT, /fr-FR/);
    assert.match(cartel.SCRIPT, /OutputEncoding = \[Text\.Encoding\]::UTF8/);
  });

  if (process.platform === 'win32') {
    await test('vraie lecture par Windows.Media.Ocr (image fabriquee, ~1 s)', async () => {
      const Jimp = require('jimp');
      const img = new Jimp(1400, 700, 0xF0ECE4FF);
      const grand = await Jimp.loadFont(Jimp.FONT_SANS_64_BLACK);
      const moyen = await Jimp.loadFont(Jimp.FONT_SANS_32_BLACK);
      img.print(grand, 80, 60, 'Claude MONET');
      img.print(moyen, 80, 150, 'Paris, 1840 - Giverny, 1926');
      img.print(grand, 80, 280, 'La Gare Saint-Lazare');
      img.print(moyen, 80, 370, '1877');
      img.print(moyen, 80, 420, 'Huile sur toile');
      const f = path.join(os.tmpdir(), 'tt-cartel-test-' + process.pid + '.jpg');
      await img.quality(90).writeAsync(f);
      try {
        const r = await cartel.lire(f);
        assert.ok(!r.erreur, r.erreur);
        const textes = r.lignes.map((l) => l.texte).join(' | ');
        assert.match(textes, /MONET/i);
        assert.match(textes, /Gare Saint-Lazare/i);
        assert.equal(r.proposition.date, '1877', textes);
        assert.match(r.proposition.titre || '', /Gare Saint-Lazare/i, textes);
      } finally { fs.rmSync(f, { force: true }); }
    });

    await test('fichier introuvable : erreur dite, pas d\'exception', async () => {
      const r = await cartel.lire(path.join(os.tmpdir(), 'nexiste-pas-' + Date.now() + '.jpg'));
      assert.match(r.erreur, /illisible/);
    });
  }

  console.log(`\n${nOk} ok, ${nKo} KO`);
  process.exit(nKo ? 1 : 0);
})();
