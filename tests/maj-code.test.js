'use strict';
/**
 * Mise a jour partielle sur PC : choix du lanceur (src/main/lanceur-etat.js) et
 * telechargement verifie (src/main/maj-code.js), avec un faux GitHub et une cle
 * de signature de test.
 *
 *     node scripts/lancer-node.js tests/maj-code.test.js
 */

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const AdmZip = require('adm-zip');

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
const signer = (b) => crypto.sign(null, Buffer.from(b), privateKey).toString('base64');
const chargerOrig = Module._load;
Module._load = function (demande, parent, ...reste) {
  if (demande === './cle-maj-web' && parent && /maj-code\.js$/.test(parent.filename)) return PUB;
  return chargerOrig.call(this, demande, parent, ...reste);
};

const RACINE_SRC = path.resolve(__dirname, '..', 'src', 'main');
const etat = require(path.join(RACINE_SRC, 'lanceur-etat'));
const majCode = require(path.join(RACINE_SRC, 'maj-code'));
const { PREFIXE_URL } = require(path.join(RACINE_SRC, 'maj-github'));
const NOM = majCode.NOM_ASSET;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function dossierNeuf() { return fs.mkdtempSync(path.join(os.tmpdir(), 'tt-code-')); }

// Release publiee sur un faux GitHub.
function publier(version, { exeMin = 320, fichiers, signatureFausse, altererZip, cheminPiege } = {}) {
  const contenus = fichiers || {
    'package.json': JSON.stringify({ version }),
    'src/main/index.js': '// v' + version, 'src/main/preload.js': '//', 'dist/index.html': '<html>' + version + '</html>'
  };
  const z = new AdmZip();
  const decrits = {};
  for (const [k, v] of Object.entries(contenus)) { const b = Buffer.from(v); z.addFile(k, b); decrits[k] = { octets: b.length, sha256: sha(b) }; }
  if (cheminPiege) { const b = Buffer.from('x'); z.addFile('dist/x.js', b); decrits['../x.js'] = { octets: 1, sha256: sha(b) }; }
  let zip = z.toBuffer();
  const nomZip = NOM + '-code-' + version + '-n' + exeMin + '.zip';
  const m = Buffer.from(JSON.stringify({ version, exeMin, zip: { nom: nomZip, octets: zip.length, sha256: sha(zip) }, fichiers: decrits }));
  if (altererZip) { const z2 = new AdmZip(zip); z2.updateFile('src/main/index.js', Buffer.from('piege')); zip = z2.toBuffer(); }
  const sig = Buffer.from(signatureFausse ? signer(Buffer.from('autre')) : signer(m));
  const servis = new Map();
  const assets = [];
  for (const [nom, b] of [[NOM + '-code-' + version + '.json', m], [NOM + '-code-' + version + '.json.sig', sig], [nomZip, zip]]) {
    const url = PREFIXE_URL + 'v' + version + '/' + nom;
    servis.set(url, b);
    assets.push({ name: nom, size: b.length, digest: 'sha256:' + sha(b), browser_download_url: url });
  }
  const fetch = async (url) => {
    const b = servis.get(url);
    return b ? { ok: true, status: 200, arrayBuffer: async () => b } : { ok: false, status: 404 };
  };
  return { release: { tag_name: 'v' + version, assets }, fetch };
}

let nOk = 0, nKo = 0;
async function test(nom, fn) {
  try { await fn(); nOk++; console.log('  ok  ' + nom); }
  catch (e) { nKo++; console.log('  KO  ' + nom + '\n      ' + String(e.stack || e).split('\n').slice(0, 6).join('\n      ')); }
}

(async () => {
  await test('trouver : paquet si exeMin <= exe, sinon exe complet', async () => {
    const { release } = publier('0.3.21', { exeMin: 320 });
    assert.equal(majCode.trouver(release, { actuelle: '0.3.20', versionExe: '0.3.20' }).version, '0.3.21');
    assert.equal(majCode.trouver(release, { actuelle: '0.3.20', versionExe: '0.3.19' }), null);
    assert.equal(majCode.trouver(release, { actuelle: '0.3.21', versionExe: '0.3.20' }), null);
    assert.equal(majCode.trouver(release, { actuelle: '0.3.20', versionExe: '0.3.20', refusees: ['0.3.21'] }), null);
  });

  await test('telecharger puis lanceur : essai, validation, lancements suivants', async () => {
    const racine = dossierNeuf();
    const { release, fetch } = publier('0.3.21');
    let relances = 0;
    majCode.configurer({ racine, fetch, relancer: () => { relances++; } });
    const p = majCode.trouver(release, { actuelle: '0.3.20', versionExe: '0.3.20' });
    assert.deepEqual(await majCode.telecharger(p), { ok: true });
    assert.equal(fs.readFileSync(path.join(racine, '0.3.21', 'dist', 'index.html'), 'utf8'), '<html>0.3.21</html>');
    assert.deepEqual(majCode.redemarrer(), { ok: true });
    assert.equal(relances, 1);
    const c = etat.choisir(racine, '0.3.20');
    assert.equal(c.version, '0.3.21');
    assert.equal(c.essai, true);
    assert.equal(etat.valider(racine, '0.3.21'), true);
    const c2 = etat.choisir(racine, '0.3.20');
    assert.equal(c2.version, '0.3.21');
    assert.equal(c2.essai, false);
    assert.equal(etat.lireEtat(racine).ok, '0.3.21');
  });

  await test('jamais valide : 2 essais puis refuse, code de l\'exe', async () => {
    const racine = dossierNeuf();
    const { release, fetch } = publier('0.3.21');
    majCode.configurer({ racine, fetch, relancer: () => {} });
    await majCode.telecharger(majCode.trouver(release, { actuelle: '0.3.20', versionExe: '0.3.20' }));
    assert.equal(etat.choisir(racine, '0.3.20').version, '0.3.21');
    assert.equal(etat.choisir(racine, '0.3.20').version, '0.3.21');
    assert.equal(etat.choisir(racine, '0.3.20').version, null);
    const e = etat.lireEtat(racine);
    assert.deepEqual(e.refusees, ['0.3.21']);
    assert.ok(!fs.existsSync(path.join(racine, '0.3.21')));
    assert.equal(majCode.trouver(release, { actuelle: '0.3.20', versionExe: '0.3.20', refusees: e.refusees }), null);
  });

  await test('echec immediat au chargement : refuse tout de suite', async () => {
    const racine = dossierNeuf();
    const { release, fetch } = publier('0.3.21');
    majCode.configurer({ racine, fetch, relancer: () => {} });
    await majCode.telecharger(majCode.trouver(release, { actuelle: '0.3.20', versionExe: '0.3.20' }));
    etat.choisir(racine, '0.3.20');
    etat.refuser(racine, '0.3.21', 'SyntaxError');
    const c = etat.choisir(racine, '0.3.20');
    assert.equal(c.version, null);
    assert.ok(c.evenements.some((x) => x.quoi === 'refuse' && x.motif === 'SyntaxError'));   // dit au lancement suivant
    assert.equal(etat.lireEtat(racine).echec, null);
    assert.deepEqual(etat.lireEtat(racine).refusees, ['0.3.21']);
  });

  await test('exe plus recent installe : paquet oublie, menage', async () => {
    const racine = dossierNeuf();
    const { release, fetch } = publier('0.3.21');
    majCode.configurer({ racine, fetch, relancer: () => {} });
    await majCode.telecharger(majCode.trouver(release, { actuelle: '0.3.20', versionExe: '0.3.20' }));
    etat.choisir(racine, '0.3.20');
    etat.valider(racine, '0.3.21');
    assert.equal(etat.choisir(racine, '0.3.22').version, null);
    assert.equal(etat.lireEtat(racine).ok, null);
    assert.ok(!fs.existsSync(path.join(racine, '0.3.21')));
  });

  await test('signature invalide / zip altere / chemin piege : refuses, rien d\'ecrit', async () => {
    for (const o of [{ signatureFausse: true }, { altererZip: true }, { cheminPiege: true }]) {
      const racine = dossierNeuf();
      const { release, fetch } = publier('0.3.21', o);
      majCode.configurer({ racine, fetch, relancer: () => {} });
      const r = await majCode.telecharger(majCode.trouver(release, { actuelle: '0.3.20', versionExe: '0.3.20' }));
      assert.ok(r.erreur, JSON.stringify(o));
      assert.ok(!fs.existsSync(path.join(racine, '0.3.21')), JSON.stringify(o));
      assert.equal(etat.lireEtat(racine).attente, null);
    }
  });

  await test('paquet sans index.js : refuse au telechargement', async () => {
    const racine = dossierNeuf();
    const { release, fetch } = publier('0.3.21', { fichiers: { 'package.json': '{}', 'dist/index.html': 'x' } });
    majCode.configurer({ racine, fetch, relancer: () => {} });
    const r = await majCode.telecharger(majCode.trouver(release, { actuelle: '0.3.20', versionExe: '0.3.20' }));
    assert.match(r.erreur, /index\.js/);
  });

  await test('paquet efface a la main : le lanceur repart sur l\'exe', async () => {
    const racine = dossierNeuf();
    const { release, fetch } = publier('0.3.21');
    majCode.configurer({ racine, fetch, relancer: () => {} });
    await majCode.telecharger(majCode.trouver(release, { actuelle: '0.3.20', versionExe: '0.3.20' }));
    fs.rmSync(path.join(racine, '0.3.21'), { recursive: true });
    assert.equal(etat.choisir(racine, '0.3.20').version, null);
  });

  console.log(`\n${nOk} ok, ${nKo} KO`);
  process.exit(nKo ? 1 : 0);
})();
