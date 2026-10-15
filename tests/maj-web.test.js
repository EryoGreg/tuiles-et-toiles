'use strict';
/**
 * Mise a jour partielle (src/mobile/maj-web.js) avec un systeme de fichiers,
 * une WebView et un telechargeur simules, et une cle de signature de test.
 *
 *     node scripts/lancer-node.js tests/maj-web.test.js
 */

const assert = require('assert/strict');
const crypto = require('crypto');
const path = require('path');
const Module = require('module');
const { zipSync } = require('fflate');

// Cle de test : la vraie cle publique de l'appli est remplacee.
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
const signer = (b) => crypto.sign(null, Buffer.from(b), privateKey).toString('base64');
const chargerOrig = Module._load;
Module._load = function (demande, parent, ...reste) {
  if (demande === './cle-maj-web' && parent && /maj-web\.js$/.test(parent.filename)) return PUB;
  return chargerOrig.call(this, demande, parent, ...reste);
};
global.atob = global.atob || ((s) => Buffer.from(s, 'base64').toString('binary'));

const majWeb = require(path.resolve(__dirname, '..', 'src/mobile/maj-web'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const NOM = majWeb.NOM_ASSET;
const PREFIXE = 'https://github.com/EryoGreg/tuiles-et-toiles/releases/download/';

// --- faux appareil ------------------------------------------------------------
function appareil() {
  const fichiers = new Map();   // 'web/0.3.20/index.html' -> Buffer
  const telechargeables = new Map();   // nom d'asset -> Buffer
  const appels = { base: [], persiste: 0 };
  const dossiersDe = (rel) => {
    const pre = rel.replace(/\/$/, '') + '/';
    const noms = new Map();
    for (const k of fichiers.keys()) {
      if (!k.startsWith(pre)) continue;
      const reste = k.slice(pre.length);
      const nom = reste.split('/')[0];
      noms.set(nom, reste.includes('/') ? 'directory' : 'file');
    }
    return [...noms].map(([name, type]) => ({ name, type, size: type === 'file' ? fichiers.get(pre + name).length : 0 }));
  };
  const Filesystem = {
    readFile: async ({ path: p }) => { if (!fichiers.has(p)) throw new Error('absent'); return { data: fichiers.get(p).toString('utf8') }; },
    writeFile: async ({ path: p, data, encoding }) => { fichiers.set(p, encoding ? Buffer.from(data, 'utf8') : Buffer.from(data, 'base64')); return { uri: 'file:///d/' + p }; },
    readdir: async ({ path: p }) => { const f = dossiersDe(p); if (!f.length) throw new Error('absent'); return { files: f }; },
    rmdir: async ({ path: p }) => { for (const k of [...fichiers.keys()]) if (k.startsWith(p + '/')) fichiers.delete(k); },
    rename: async ({ from, to }) => {
      for (const k of [...fichiers.keys()]) if (k.startsWith(from + '/')) { fichiers.set(to + k.slice(from.length), fichiers.get(k)); fichiers.delete(k); }
    },
    getUri: async ({ path: p }) => ({ uri: 'file:///data/user/0/app/files/' + p })
  };
  const deps = {
    Filesystem, Directory: { Data: 'DATA' }, Encoding: { UTF8: 'utf8' },
    WebView: {
      setServerBasePath: async ({ path: p }) => { appels.base.push(p); },
      persistServerBasePath: async () => { appels.persiste++; }
    },
    MiseAJour: {
      addListener: async () => ({ remove() {} }),
      telecharger: async ({ nom, sha256 }) => {
        const b = telechargeables.get(nom);
        if (!b) throw new Error('404 ' + nom);
        if (sha256 && sha(b) !== sha256) throw new Error('Empreinte SHA-256 incorrecte');
        return { chemin: '/cache/maj/' + nom };
      }
    },
    lire: async (chemin) => new Uint8Array(telechargeables.get(chemin.split('/').pop())),
    unzip: (o) => require('fflate').unzipSync(o),
    sha256: (o) => sha(o),
    subtle: crypto.webcrypto.subtle
  };
  return { fichiers, telechargeables, appels, deps };
}

// Paquet publie : assets d'une release + contenu telechargeable.
function publier(dev, version, { natifMin = 320, fichiers, altererZip, signatureFausse, cheminPiege } = {}) {
  const contenus = fichiers || { 'index.html': '<html>v' + version + '</html>', 'principal.js': 'console.log("' + version + '")', 'assets/a.js': 'a' };
  const z = {};
  const decrits = {};
  for (const [k, v] of Object.entries(contenus)) {
    const b = Buffer.from(v);
    z[k] = new Uint8Array(b);
    decrits[k] = { octets: b.length, sha256: sha(b) };
  }
  if (cheminPiege) { z['../x.js'] = new Uint8Array(Buffer.from('x')); decrits['../x.js'] = { octets: 1, sha256: sha(Buffer.from('x')) }; }
  let zip = Buffer.from(zipSync(z));
  const nomZip = NOM + '-web-' + version + '-n' + natifMin + '.zip';
  const m = Buffer.from(JSON.stringify({ version, natifMin, zip: { nom: nomZip, octets: zip.length, sha256: sha(zip) }, fichiers: decrits }));
  if (altererZip) {   // contenu change apres la publication du manifeste ET du digest
    const z2 = { ...z, 'principal.js': new Uint8Array(Buffer.from('piege')) };
    zip = Buffer.from(zipSync(z2));
  }
  const sig = Buffer.from(signatureFausse ? signer(Buffer.from('autre chose')) : signer(m));
  const assets = [];
  for (const [nom, b] of [[NOM + '-web-' + version + '.json', m], [NOM + '-web-' + version + '.json.sig', sig], [nomZip, zip]]) {
    dev.telechargeables.set(nom, b);
    assets.push({ name: nom, size: b.length, digest: 'sha256:' + sha(b), browser_download_url: PREFIXE + 'v' + version + '/' + nom });
  }
  return { tag_name: 'v' + version, assets };
}

let nOk = 0, nKo = 0;
async function test(nom, fn) {
  try { await fn(); nOk++; console.log('  ok  ' + nom); }
  catch (e) { nKo++; console.log('  KO  ' + nom + '\n      ' + String(e.stack || e).split('\n').slice(0, 6).join('\n      ')); }
}

(async () => {
  await test('trouver : paquet web si natifMin <= APK installe, sinon rien (APK complet)', async () => {
    const dev = appareil(); majWeb.configurer(dev.deps);
    const r = publier(dev, '0.3.21', { natifMin: 320 });
    const p = majWeb.trouver(r, { actuelle: '0.3.20', versionCode: 320 });
    assert.equal(p.version, '0.3.21');
    assert.equal(p.natifMin, 320);
    assert.equal(majWeb.trouver(r, { actuelle: '0.3.20', versionCode: 319 }), null);
    assert.equal(majWeb.trouver(r, { actuelle: '0.3.21', versionCode: 320 }), null);
    assert.equal(majWeb.trouver(r, { actuelle: '0.3.20', versionCode: 320, refusees: ['0.3.21'] }), null);
    assert.equal(majWeb.trouver({ tag_name: 'v0.3.21', assets: r.assets.slice(0, 2) }, { actuelle: '0.3.20', versionCode: 320 }), null);
    const etranger = { tag_name: 'v0.3.21', assets: r.assets.map((a) => ({ ...a, browser_download_url: 'https://evil.test/' + a.name })) };
    assert.equal(majWeb.trouver(etranger, { actuelle: '0.3.20', versionCode: 320 }), null);
  });

  await test('telecharger : verifie, ecrit web/<v>/, marque en attente', async () => {
    const dev = appareil(); majWeb.configurer(dev.deps);
    const p = majWeb.trouver(publier(dev, '0.3.21'), { actuelle: '0.3.20', versionCode: 320 });
    const r = await majWeb.telecharger(p);
    assert.deepEqual(r, { ok: true });
    assert.equal(dev.fichiers.get('web/0.3.21/index.html').toString(), '<html>v0.3.21</html>');
    assert.ok(dev.fichiers.has('web/0.3.21/assets/a.js'));
    assert.ok(![...dev.fichiers.keys()].some((k) => k.includes('.tmp/')));
    assert.deepEqual((await majWeb.lireEtat()).attente, { version: '0.3.21', essais: 0 });
  });

  await test('signature invalide : refuse, rien d\'ecrit', async () => {
    const dev = appareil(); majWeb.configurer(dev.deps);
    const p = majWeb.trouver(publier(dev, '0.3.21', { signatureFausse: true }), { actuelle: '0.3.20', versionCode: 320 });
    const r = await majWeb.telecharger(p);
    assert.match(r.erreur, /Signature/);
    assert.ok(![...dev.fichiers.keys()].some((k) => k.startsWith('web/0.3.21')));
    assert.equal((await majWeb.lireEtat()).attente, null);
  });

  await test('zip altere (digest GitHub coherent mais manifeste signe non) : refuse', async () => {
    const dev = appareil(); majWeb.configurer(dev.deps);
    const p = majWeb.trouver(publier(dev, '0.3.21', { altererZip: true }), { actuelle: '0.3.20', versionCode: 320 });
    const r = await majWeb.telecharger(p);
    assert.match(r.erreur, /corrompu|altéré/);
    assert.equal((await majWeb.lireEtat()).attente, null);
  });

  await test('chemin piege (..) dans un paquet signe : refuse', async () => {
    const dev = appareil(); majWeb.configurer(dev.deps);
    const p = majWeb.trouver(publier(dev, '0.3.21', { cheminPiege: true }), { actuelle: '0.3.20', versionCode: 320 });
    const r = await majWeb.telecharger(p);
    assert.ok(r.erreur);
    assert.ok(![...dev.fichiers.keys()].some((k) => k.includes('x.js')));
  });

  await test('demarrage : applique, puis le nouveau code valide (persiste)', async () => {
    const dev = appareil(); majWeb.configurer(dev.deps);
    await majWeb.telecharger(majWeb.trouver(publier(dev, '0.3.21'), { actuelle: '0.3.20', versionCode: 320 }));
    assert.equal(await majWeb.demarrage('0.3.20'), 'recharge');
    assert.deepEqual(dev.appels.base, ['/data/user/0/app/files/web/0.3.21']);
    majWeb.configurer(dev.deps);   // la page repart : nouveau module
    assert.equal(await majWeb.demarrage('0.3.21'), 'normal');
    assert.equal(await majWeb.valider(), true);
    assert.equal(dev.appels.persiste, 1);
    const e = await majWeb.lireEtat();
    assert.equal(e.ok, '0.3.21');
    assert.equal(e.attente, null);
    assert.equal(await majWeb.demarrage('0.3.21'), 'normal');   // lancement suivant : rien a faire
    assert.equal(dev.appels.base.length, 1);
  });

  await test('nouveau code qui ne demarre jamais : 2 essais puis refuse, l\'ancien reste', async () => {
    const dev = appareil(); majWeb.configurer(dev.deps);
    await majWeb.telecharger(majWeb.trouver(publier(dev, '0.3.21'), { actuelle: '0.3.20', versionCode: 320 }));
    assert.equal(await majWeb.demarrage('0.3.20'), 'recharge');   // essai 1 : plante avant valider()
    majWeb.configurer(dev.deps);
    assert.equal(await majWeb.demarrage('0.3.20'), 'recharge');   // relance : ancien code, essai 2
    majWeb.configurer(dev.deps);
    assert.equal(await majWeb.demarrage('0.3.20'), 'normal');     // refuse
    const e = await majWeb.lireEtat();
    assert.deepEqual(e.refusees, ['0.3.21']);
    assert.equal(e.attente, null);
    assert.equal(dev.appels.persiste, 0);
    assert.ok(![...dev.fichiers.keys()].some((k) => k.startsWith('web/0.3.21/')));
    // ... et plus jamais propose
    const r = publier(dev, '0.3.21');
    assert.equal(majWeb.trouver(r, { actuelle: '0.3.20', versionCode: 320, refusees: e.refusees }), null);
  });

  await test('APK plus recent installe par-dessus : paquet oublie, menage', async () => {
    const dev = appareil(); majWeb.configurer(dev.deps);
    await majWeb.telecharger(majWeb.trouver(publier(dev, '0.3.21'), { actuelle: '0.3.20', versionCode: 320 }));
    await majWeb.demarrage('0.3.20');
    majWeb.configurer(dev.deps);
    await majWeb.demarrage('0.3.21');
    await majWeb.valider();
    majWeb.configurer(dev.deps);
    assert.equal(await majWeb.demarrage('0.3.22'), 'normal');   // APK 0.3.22 (Capacitor ignore le chemin)
    assert.equal((await majWeb.lireEtat()).ok, null);
    assert.ok(![...dev.fichiers.keys()].some((k) => k.startsWith('web/0.3.21/')));
  });

  await test('paquet en attente depasse par l\'APK : abandonne sans recharger', async () => {
    const dev = appareil(); majWeb.configurer(dev.deps);
    await majWeb.telecharger(majWeb.trouver(publier(dev, '0.3.21'), { actuelle: '0.3.20', versionCode: 320 }));
    assert.equal(await majWeb.demarrage('0.3.22'), 'normal');
    assert.equal(dev.appels.base.length, 0);
    assert.equal((await majWeb.lireEtat()).attente, null);
  });

  await test('« Redemarrer maintenant » : applique tout de suite', async () => {
    const dev = appareil(); majWeb.configurer(dev.deps);
    await majWeb.telecharger(majWeb.trouver(publier(dev, '0.3.21'), { actuelle: '0.3.20', versionCode: 320 }));
    assert.deepEqual(await majWeb.appliquerMaintenant(), { ok: true });
    assert.equal(dev.appels.base.length, 1);
    assert.equal((await majWeb.lireEtat()).attente.essais, 1);
  });

  console.log(`\n${nOk} ok, ${nKo} KO`);
  process.exit(nKo ? 1 : 0);
})();
