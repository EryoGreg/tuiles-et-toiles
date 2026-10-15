'use strict';
/**
 * Mobile, copies d'affichage des photos locales (src/mobile/images-url.js) :
 * chaque URL blob garde une copie de la photo ; au-dela de MAX_URLS, les plus
 * anciennes qu'aucune image de la page n'affiche sont liberees (en differe), et
 * une image qui cite encore une adresse liberee la voit recreee.
 *
 *     node scripts/lancer-node.js tests/images-url-memoire.test.js
 */

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Faux document : la liste des <img> de la page et l'ecouteur d'erreurs.
const ecouteurs = [];
const page = { images: [] };
global.document = {
  get images() { return page.images; },
  addEventListener: (type, f) => { if (type === 'error') ecouteurs.push(f); }
};
const img = (src) => {
  const e = { tagName: 'IMG', src, getAttribute: (k) => (k === 'src' ? e.src : null) };
  return e;
};

// @noble/hashes v2 est un module ES (le Node d'Electron ne le charge pas par
// require) : crypto le remplace, le telechargement n'est pas teste ici.
const Module = require('module');
const chargerOrig = Module._load;
Module._load = function (demande, ...reste) {
  if (demande === '@noble/hashes/sha2.js') {
    return { sha256: (o) => new Uint8Array(require('crypto').createHash('sha256').update(o).digest()) };
  }
  return chargerOrig.call(this, demande, ...reste);
};

const imagesUrl = require(path.resolve(__dirname, '..', 'src/mobile/images-url'));

let nOk = 0, nKo = 0;
async function test(nom, fn) {
  try { await fn(); nOk++; console.log('  ok  ' + nom); }
  catch (e) { nKo++; console.log('  KO  ' + nom + '\n      ' + String(e.stack || e).split('\n').slice(0, 6).join('\n      ')); }
}
const attendre = (ms) => new Promise((ok) => setTimeout(ok, ms));

(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-images-url-'));
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(TMP, 'p' + i + '.jpg'), Buffer.from('photo ' + i));
  // configurer() range le dossier puis echoue sur IndexedDB (absent ici) : sans effet pour ce test.
  await imagesUrl.configurer({ manifeste: { ref: 't', images: {} }, locales: TMP }).catch(() => {});
  const max = imagesUrl.memoire().maxCopies;

  let adresses;
  await test('une liste plus longue que MAX est traduite sans rien liberer tout de suite', async () => {
    adresses = Array.from({ length: 60 }, (_, i) => imagesUrl.traduire('tuile://mini/p' + i + '.jpg'));
    assert.ok(adresses.every((u) => u.startsWith('blob:')));
    assert.equal(new Set(adresses).size, 60);
    assert.equal(imagesUrl.memoire().copiesAffichage, 60);
    assert.equal(imagesUrl.memoire().liberees, 0);
  });

  await test('meme photo = meme adresse (pas de nouvelle copie)', async () => {
    assert.equal(imagesUrl.traduire('tuile://p3.jpg'), adresses[3]);
    assert.equal(imagesUrl.memoire().copiesAffichage, 60);
  });

  await test('liberation differee : les images affichees sont gardees', async () => {
    page.images = adresses.map(img);   // toute la liste est a l'ecran
    await attendre(2300);
    assert.equal(imagesUrl.memoire().copiesAffichage, 60);
    assert.equal(imagesUrl.memoire().liberees, 0);
  });

  await test('page quittee : les plus anciennes au-dela de MAX sont liberees', async () => {
    page.images = [img(adresses[0])];   // seule p0 reste affichee
    fs.writeFileSync(path.join(TMP, 'p60.jpg'), 'photo 60');
    imagesUrl.traduire('tuile://p60.jpg');   // nouvelle copie -> liberation programmee
    await attendre(2300);
    const m = imagesUrl.memoire();
    assert.equal(m.copiesAffichage, max);
    assert.equal(m.liberees, 61 - max);
    // p0 etait affichee : gardee meme si c'est la plus ancienne (p3 a ete re-servie).
    assert.equal(imagesUrl.traduire('tuile://p0.jpg'), adresses[0]);
  });

  await test('adresse liberee encore citee par une image : recreee a l\'erreur', async () => {
    const e = img(adresses[1]);   // p1 : liberee (ancienne, plus affichee)
    for (const f of ecouteurs) f({ target: e });
    assert.notEqual(e.src, adresses[1]);
    assert.ok(e.src.startsWith('blob:'));
    const b = await (await fetch(e.src)).text();
    assert.equal(b, 'photo 1');
  });

  await test('erreur d\'une autre image : rien n\'est touche', async () => {
    const e = img('https://exemple.test/x.jpg');
    for (const f of ecouteurs) f({ target: e });
    assert.equal(e.src, 'https://exemple.test/x.jpg');
  });

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${nOk} ok, ${nKo} KO`);
  process.exit(nKo ? 1 : 0);
})();
