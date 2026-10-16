'use strict';
/**
 * Photos en vrais fichiers sur mobile (src/mobile/shims/vfs-externe.js), avec
 * un Filesystem Capacitor simule (ecritures lentes, ordre, echecs).
 *
 *     node scripts/lancer-node.js tests/vfs-externe.test.js
 */

const assert = require('assert/strict');
const path = require('path');
const { creer, RACINE } = require(path.resolve(__dirname, '..', 'src/mobile/shims/vfs-externe'));

function fauxFilesystem({ lent = 5, echouer = () => false } = {}) {
  const disque = new Map();   // 'images-locales/x.jpg' -> base64
  const attendre = () => new Promise((r) => setTimeout(r, lent));
  const Fs = {
    disque,
    mkdir: async () => {},
    getUri: async ({ path: p }) => ({ uri: 'file:///data/user/0/app/files/' + p }),
    readdir: async ({ path: p }) => ({ files: [...disque.keys()].filter((k) => k.startsWith(p + '/'))
      .map((k) => ({ name: k.slice(p.length + 1), type: 'file', size: Buffer.from(disque.get(k), 'base64').length, mtime: 1 })) }),
    writeFile: async ({ path: p, data }) => { await attendre(); if (echouer(p)) throw new Error('disque plein'); disque.set(p, data); },
    readFile: async ({ path: p }) => { await attendre(); if (!disque.has(p)) throw new Error('absent'); return { data: disque.get(p) }; },
    deleteFile: async ({ path: p }) => { await attendre(); if (!disque.has(p)) throw new Error('absent'); disque.delete(p); },
    rename: async ({ from, to }) => { await attendre(); if (!disque.has(from)) throw new Error('absent'); disque.set(to, disque.get(from)); disque.delete(from); },
    stat: async ({ path: p }) => { if (!disque.has(p)) throw new Error('absent'); return { size: Buffer.from(disque.get(p), 'base64').length }; }
  };
  return Fs;
}
const nouveau = (Fs) => creer({ Filesystem: Fs, Directory: { Data: 'DATA' }, convertir: (u) => u.replace('file://', 'https://localhost/_capacitor_file_') });
const octets = (n, v = 7) => new Uint8Array(n).fill(v);

let nOk = 0, nKo = 0;
async function test(nom, fn) {
  try { await fn(); nOk++; console.log('  ok  ' + nom); }
  catch (e) { nKo++; console.log('  KO  ' + nom + '\n      ' + String(e.stack || e).split('\n').slice(0, 6).join('\n      ')); }
}

(async () => {
  await test('init : photos deja sur disque connues (nom, taille), .tmp ignores', async () => {
    const Fs = fauxFilesystem();
    Fs.disque.set('images-locales/a.jpg', Buffer.from(octets(10)).toString('base64'));
    Fs.disque.set('images-locales/b.jpg.12.tmp', Buffer.from(octets(3)).toString('base64'));
    const e = nouveau(Fs);
    assert.equal(await e.init(), 1);
    assert.ok(e.estExterne(RACINE + '/a.jpg'));
    assert.ok(!e.estExterne('/data/utilisateur.db'));
    assert.ok(!e.estExterne(RACINE + '/sous/x.jpg'));
    assert.deepEqual(e.noms(), ['a.jpg']);
    assert.equal(e.stat(RACINE + '/a.jpg').taille, 10);
    assert.equal(e.adresse(RACINE + '/a.jpg'), 'https://localhost/_capacitor_file_/data/user/0/app/files/images-locales/a.jpg');
  });

  await test('ecrire : visible tout de suite (octets en attente), puis sur disque et hors memoire', async () => {
    const Fs = fauxFilesystem({ lent: 20 });
    const e = nouveau(Fs); await e.init();
    const p = RACINE + '/photo.jpg';
    e.ecrire(p, octets(5000, 9));
    assert.ok(e.existe(p));
    assert.equal(e.stat(p).taille, 5000);
    assert.equal(e.adresse(p), null, 'pas encore d adresse : affichage par les octets en attente');
    assert.equal(e.enAttente(p).length, 5000);
    assert.equal(e.occupation().enMemoire, 5000);
    await e.vider();
    assert.equal(e.enAttente(p), null);
    assert.equal(e.occupation().enMemoire, 0);
    assert.ok(e.adresse(p).endsWith('/images-locales/photo.jpg'));
    assert.deepEqual([...(await e.lire(p))], [...octets(5000, 9)]);
  });

  await test('ordre garanti : ecrire puis supprimer aussitot -> rien sur disque', async () => {
    const Fs = fauxFilesystem({ lent: 10 });
    const e = nouveau(Fs); await e.init();
    e.ecrire(RACINE + '/x.jpg', octets(10));
    e.supprimer(RACINE + '/x.jpg');
    assert.ok(!e.existe(RACINE + '/x.jpg'));
    await e.vider();
    assert.equal(Fs.disque.size, 0);
  });

  await test('reception atomique (tmp puis renommer, comme transport-dossier.ecrireAtomique)', async () => {
    const Fs = fauxFilesystem({ lent: 10 });
    const e = nouveau(Fs); await e.init();
    e.ecrire(RACINE + '/r.jpg.42.tmp', octets(300, 3));
    assert.ok(e.renommer(RACINE + '/r.jpg.42.tmp', RACINE + '/r.jpg'));
    assert.ok(e.existe(RACINE + '/r.jpg') && !e.existe(RACINE + '/r.jpg.42.tmp'));
    assert.equal(e.enAttente(RACINE + '/r.jpg').length, 300, 'servie pendant l ecriture');
    await e.vider();
    assert.deepEqual([...Fs.disque.keys()], ['images-locales/r.jpg']);
    assert.equal((await e.lire(RACINE + '/r.jpg')).length, 300);
    assert.equal(e.renommer(RACINE + '/inconnu.jpg', RACINE + '/y.jpg'), false);
  });

  await test('lire une photo absente : ENOENT ; reecrire : derniere version gagnante', async () => {
    const Fs = fauxFilesystem({ lent: 5 });
    const e = nouveau(Fs); await e.init();
    await assert.rejects(e.lire(RACINE + '/rien.jpg'), (x) => x.code === 'ENOENT');
    e.ecrire(RACINE + '/v.jpg', octets(10, 1));
    e.ecrire(RACINE + '/v.jpg', octets(20, 2));
    assert.equal(e.enAttente(RACINE + '/v.jpg').length, 20);
    await e.vider();
    assert.deepEqual([...(await e.lire(RACINE + '/v.jpg'))], [...octets(20, 2)]);
    assert.equal(e.enAttente(RACINE + '/v.jpg'), null);
  });

  await test('ecriture qui echoue : notee (echecs), la file continue', async () => {
    const Fs = fauxFilesystem({ lent: 2, echouer: (p) => p.endsWith('mauvaise.jpg') });
    const e = nouveau(Fs); await e.init();
    e.ecrire(RACINE + '/mauvaise.jpg', octets(5));
    e.ecrire(RACINE + '/bonne.jpg', octets(5));
    await e.vider();
    assert.equal(e.echecs().length, 1);
    assert.ok(Fs.disque.has('images-locales/bonne.jpg'));
    assert.equal(await e.tailleNative('bonne.jpg'), 5);
    assert.equal(await e.tailleNative('mauvaise.jpg'), -1, 'la migration ne l effacerait pas d IndexedDB');
  });

  await test('photo de 4 Mo : encodage par blocs, relue a l identique', async () => {
    const Fs = fauxFilesystem({ lent: 1 });
    const e = nouveau(Fs); await e.init();
    const o = new Uint8Array(4 * 1024 * 1024);
    for (let i = 0; i < o.length; i++) o[i] = (i * 31) & 255;
    e.ecrire(RACINE + '/grande.jpg', o);
    await e.vider();
    const r = await e.lire(RACINE + '/grande.jpg');
    assert.equal(r.length, o.length);
    assert.ok(r.every((x, i) => x === o[i]));
  });

  console.log(`\n${nOk} ok, ${nKo} KO`);
  process.exit(nKo ? 1 : 0);
})();
