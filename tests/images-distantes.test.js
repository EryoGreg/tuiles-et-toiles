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

function monter(reponse, { qualite = 'affichage' } = {}) {
  const appels = [];
  const cache = fs.mkdtempSync(path.join(TMP, 'cache-'));
  const q = { v: qualite };
  images.configurer({
    cache, vignettes: VIGN, embarquees: null, manifeste: MANIF, qualite: () => q.v,
    fetch: async (url) => { appels.push(url); return reponse(url); },
    journal: { evt() {}, debug() {}, erreur() {} }
  });
  return { appels, cache, q };
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

  console.log('qualite, cache perime, liberer l\'espace (0.3.13)');
  const qualite = require(path.join(RACINE, 'src/main/images-qualite'));

  await test('reglage : migration de l\'ancienne case, defauts PC / mobile', () => {
    const r = (v) => (cle, defaut) => (cle in v ? v[cle] : defaut);
    assert.equal(qualite.lire(r({})), 'tout', 'PC : comme avant');
    assert.equal(qualite.lire(r({}), { mobile: true }), 'affichage', 'mobile : la case n\'y faisait rien');
    assert.equal(qualite.lire(r({ images_hors_ligne: '1' }), { mobile: true }), 'tout');
    assert.equal(qualite.lire(r({ images_hors_ligne: '0' })), 'affichage');
    assert.equal(qualite.lire(r({ images_hors_ligne: '1', images_qualite: 'reduite' })), 'reduite', 'le nouveau reglage gagne');
    assert.equal(qualite.lire(r({ images_qualite: 'nimporte' })), 'tout');
  });

  await test('qualite reduite : aucun telechargement, la vignette ; une grande image deja la sert quand meme', async () => {
    const m = monter(() => reponseOk(GRAND), { qualite: 'reduite' });
    assert.equal(await images.chemin('a.jpg'), path.join(VIGN, 'a.jpg'));
    assert.equal(m.appels.length, 0);
    fs.writeFileSync(path.join(m.cache, 'b.jpg'), GRAND);
    assert.equal(await images.chemin('b.jpg'), path.join(m.cache, 'b.jpg'));
  });

  await test('image du pack changee depuis (taille differente) : copie effacee, re-telechargee', async () => {
    const m = monter(() => reponseOk(GRAND));
    fs.writeFileSync(path.join(m.cache, 'a.jpg'), 'ancienne version de l\'image');
    assert.equal(images.etat().presentes, 0, 'copie perimee : pas comptee');
    assert.equal(fs.existsSync(path.join(m.cache, 'a.jpg')), false, 'et effacee');
    const p = await images.chemin('a.jpg');
    assert.deepEqual(fs.readFileSync(p), GRAND);
    assert.equal(m.appels.length, 1);
  });

  await test('liberer l\'espace : grandes images et .part effaces, LISEZMOI garde, vignettes ensuite', async () => {
    const m = monter(() => reponseOk(GRAND));
    await images.toutTelecharger();
    fs.writeFileSync(path.join(m.cache, 'LISEZMOI.txt'), 'a quoi sert ce dossier');
    fs.writeFileSync(path.join(m.cache, 'x.jpg.part'), 'morceau');
    assert.equal(images.etat().octetsCache, GRAND.length * 2);
    const r = await images.vider();
    assert.equal(r.fichiers, 3);
    assert.deepEqual(fs.readdirSync(m.cache), ['LISEZMOI.txt']);
    assert.equal(images.etat().presentes, 0);
    assert.equal(images.etat().octetsCache, 0);
    m.q.v = 'reduite';
    assert.equal(await images.chemin('a.jpg'), path.join(VIGN, 'a.jpg'));
  });

  await test('liberer pendant un telechargement complet : il s\'arrete', async () => {
    const m = monter(() => new Promise((r) => setTimeout(() => r(reponseOk(GRAND)), 40)));
    const enCours = images.toutTelecharger();
    await new Promise((r) => setTimeout(r, 10));
    const v = await images.vider();
    await enCours;
    assert.ok(images.etat().presentes <= 0, 'rien ne reste apres vider');
    assert.ok(m.appels.length <= 1, 'arrete apres l\'image en cours');
    void v;
  });

  await test('telechargement complet : s\'arrete si la qualite change entre-temps', async () => {
    const m = monter(() => reponseOk(GRAND), { qualite: 'tout' });
    let n = 0;
    const r = await images.toutTelecharger(() => { n++; m.q.v = 'affichage'; }, { arreter: () => m.q.v !== 'tout' });
    assert.equal(r.faites, 1);
    assert.equal(r.restantes, 1);
    assert.equal(n, 1);
  });

  await test('etat : qualite et octets du cache exposes', async () => {
    monter(() => reponseOk(GRAND), { qualite: 'tout' });
    const e = images.etat();
    assert.equal(e.qualite, 'tout');
    assert.equal(e.octetsCache, 0);
    assert.equal(e.octetsTotal, GRAND.length * 2);
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
