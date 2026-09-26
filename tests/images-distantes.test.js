'use strict';
/**
 * Images du pack a la demande (src/main/images-distantes.js) : vignette en
 * repli, telechargement verifie (taille + SHA-256), cache, hors ligne.
 *
 *     node scripts/lancer-node.js tests/images-distantes.test.js
 *     TT_RESEAU=1 ... : ajoute un vrai telechargement depuis GitHub
 */

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const RACINE = path.resolve(__dirname, '..');
const images = require(path.join(RACINE, 'src/main/images-distantes'));

let nOk = 0, nKo = 0;
async function test(nom, fn) {
  try { await fn(); nOk++; console.log('  ok  ' + nom); }
  catch (e) { nKo++; console.log('  KO  ' + nom + '\n      ' + String(e.stack || e).split('\n').slice(0, 6).join('\n      ')); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-images-'));
const VIGN = path.join(TMP, 'vignettes');
fs.mkdirSync(VIGN);
const GRAND = Buffer.from('grande image de test');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
fs.writeFileSync(path.join(VIGN, 'a.jpg'), 'vignette a');
fs.writeFileSync(path.join(VIGN, 'b.jpg'), 'vignette b');
const MANIF = path.join(TMP, 'manifeste.json');
fs.writeFileSync(MANIF, JSON.stringify({ ref: 'images-1', images: {
  'a.jpg': { octets: GRAND.length, sha256: sha(GRAND) },
  'b.jpg': { octets: GRAND.length, sha256: sha(GRAND) }
} }));

function monter(reponse) {
  const appels = [];
  const cache = fs.mkdtempSync(path.join(TMP, 'cache-'));
  images.configurer({
    cache, vignettes: VIGN, embarquees: null, manifeste: MANIF,
    fetch: async (url) => { appels.push(url); return reponse(url); },
    journal: { evt() {}, debug() {}, erreur() {} }
  });
  return { appels, cache };
}
const reponseOk = (corps) => ({ ok: true, status: 200, arrayBuffer: async () => corps });

(async () => {
  console.log('images a la demande');

  await test('vignette servie sans reseau ; nom dangereux refuse', async () => {
    const m = monter(() => { throw new Error('pas de reseau'); });
    assert.equal(await images.chemin('a.jpg', { mini: true }), path.join(VIGN, 'a.jpg'));
    assert.equal(await images.chemin('../../secret.jpg', { mini: true }), null, 'basename seulement');
    assert.equal(await images.chemin('x.exe'), null);
    assert.equal(m.appels.length, 0);
  });

  await test('grande image : telechargee depuis le tag, verifiee, puis servie du cache', async () => {
    const m = monter(() => reponseOk(GRAND));
    const p = await images.chemin('a.jpg');
    assert.equal(p, path.join(m.cache, 'a.jpg'));
    assert.deepEqual(fs.readFileSync(p), GRAND);
    assert.equal(m.appels[0], 'https://raw.githubusercontent.com/EryoGreg/tuiles-et-toiles/images-1/data/images/a.jpg');
    await images.chemin('a.jpg');
    assert.equal(m.appels.length, 1, 'deuxieme fois : cache');
  });

  await test('fichier tronque ou modifie : rejete, la vignette le remplace', async () => {
    let m = monter(() => reponseOk(GRAND.subarray(0, 5)));
    assert.equal(await images.chemin('a.jpg'), path.join(VIGN, 'a.jpg'));
    assert.equal(fs.existsSync(path.join(m.cache, 'a.jpg')), false);
    m = monter(() => reponseOk(Buffer.from('X'.repeat(GRAND.length))));
    assert.equal(await images.chemin('a.jpg'), path.join(VIGN, 'a.jpg'));
    assert.equal(fs.existsSync(path.join(m.cache, 'a.jpg')), false);
  });

  await test('deux affichages simultanes : un seul telechargement', async () => {
    const m = monter(() => new Promise((r) => setTimeout(() => r(reponseOk(GRAND)), 30)));
    const [x, y] = await Promise.all([images.chemin('b.jpg'), images.chemin('b.jpg')]);
    assert.equal(x, y);
    assert.equal(m.appels.length, 1);
  });

  await test('tout telecharger : etat, puis arret apres 3 echecs de suite (hors ligne)', async () => {
    let m = monter(() => reponseOk(GRAND));
    assert.equal(images.etat().presentes, 0);
    const r = await images.toutTelecharger();
    assert.deepEqual(r, { faites: 2, echecs: 0, restantes: 0 });
    assert.equal(images.etat().presentes, 2);
    m = monter(() => ({ ok: false, status: 503 }));
    const r2 = await images.toutTelecharger();
    assert.equal(r2.faites, 0);
    assert.equal(r2.restantes, 2);
    assert.ok(m.appels.length <= 3);
  });

  if (process.env.TT_RESEAU) {
    await test('vrai telechargement depuis GitHub (tag du manifeste)', async () => {
      const vrai = path.join(RACINE, 'data', 'images-manifest.json');
      const cache = fs.mkdtempSync(path.join(TMP, 'vrai-'));
      images.configurer({ cache, vignettes: path.join(RACINE, 'data', 'vignettes'), embarquees: null, manifeste: vrai,
        fetch: (u, o) => fetch(u, o), journal: { evt: (...a) => console.log('      ', ...a), debug() {}, erreur() {} } });
      const nom = Object.keys(JSON.parse(fs.readFileSync(vrai, 'utf8')).images)[0];
      assert.equal(await images.chemin(nom), path.join(cache, nom));
    });
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* verrou */ }
  console.log(`\n${nOk} ok, ${nKo} KO`);
  process.exit(nKo ? 1 : 0);
})();
