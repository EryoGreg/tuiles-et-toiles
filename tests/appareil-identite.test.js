'use strict';
/**
 * Identite d'un appareil (synchro/appareil.js) et noms memorables (synchro/noms.js).
 *
 *     node scripts/lancer-node.js tests/appareil-identite.test.js
 */

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const RACINE = path.resolve(__dirname, '..');
const appareil = require(path.join(RACINE, 'src/main/synchro/appareil'));
const { nomPour, nomValide, NOMS, ADJECTIFS } = require(path.join(RACINE, 'src/main/synchro/noms'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-identite-'));
let nDossier = 0;
const dossier = () => path.join(TMP, 'd' + (++nDossier));
const lireFichier = (d) => JSON.parse(fs.readFileSync(path.join(d, 'appareil.json'), 'utf8'));
const ecrireFichier = (d, a) => { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'appareil.json'), JSON.stringify(a)); };

let nOk = 0, nKo = 0;
function test(nom, fn) {
  try { fn(); nOk++; console.log('  ok  ' + nom); }
  catch (e) { nKo++; console.log('  KO  ' + nom + '\n      ' + String(e.stack || e).split('\n').slice(0, 5).join('\n      ')); }
}

console.log('noms memorables');

test('deterministe : meme id, meme nom', () => {
  assert.equal(nomPour('3b660940'), nomPour('3b660940'));
  assert.notEqual(nomPour('3b660940'), nomPour('3b660941'));
});

test('deux mots, accord du genre (feminin -> adjectif feminin)', () => {
  const fem = new Map(ADJECTIFS.map(([m, f]) => [f, m]));
  for (let i = 0; i < NOMS.length * ADJECTIFS.length; i += 7) {
    const id = i.toString(16).padStart(8, '0');
    const [nom, adj] = nomPour(id).split(' ');
    const genre = NOMS.find(([n]) => n === nom)[1];
    const paire = ADJECTIFS.find(([m, f]) => m === adj || f === adj);
    assert.ok(paire, adj);
    assert.equal(adj, genre === 'f' ? paire[1] : paire[0], nom + ' ' + adj);
    if (paire[0] !== paire[1]) assert.equal(fem.has(adj), genre === 'f');
  }
});

test('variete : 2000 identites tirees -> plus de 700 noms differents', () => {
  const vus = new Set();
  for (let i = 0; i < 2000; i++) vus.add(nomPour(crypto.randomBytes(4).toString('hex')));
  assert.ok(vus.size > 700, vus.size + ' noms');
});

test('id illisible : un nom quand meme', () => {
  assert.match(nomPour(''), /^\S+ \S+$/);
  assert.match(nomPour(null), /^\S+ \S+$/);
});

test('nom saisi : nettoye ; vide, blanc ou trop long refuse', () => {
  assert.equal(nomValide('  PC   du  salon '), 'PC du salon');
  assert.equal(nomValide('Tab' + String.fromCharCode(9) + 'lette' + String.fromCharCode(7)), 'Tab lette');
  assert.equal(nomValide(''), null);
  assert.equal(nomValide('   '), null);
  assert.equal(nomValide(null), null);
  assert.equal(nomValide('x'.repeat(40)), 'x'.repeat(40));
  assert.equal(nomValide('x'.repeat(41)), null);
});

console.log('identite (appareil.json)');

test('premier lancement : nom memorable, type et empreinte enregistres', () => {
  const d = dossier();
  const a = appareil.charger(d, { nom: 'POSTE', type: 'Windows · POSTE', materiel: 'aaaa' });
  assert.equal(a.evenement, 'cree');
  assert.match(a.id, /^[0-9a-f]{8}$/);
  assert.equal(a.nom, nomPour(a.id));
  assert.equal(a.prefixe_ref, 'L');
  const f = lireFichier(d);
  assert.equal(f.type, 'Windows · POSTE');
  assert.equal(f.materiel, 'aaaa');
  assert.equal(f.evenement, undefined, 'le compte rendu n\'est pas enregistre');
});

test('relu ensuite : meme identite, aucun evenement', () => {
  const d = dossier();
  const a = appareil.charger(d, { nom: 'POSTE', type: 'Windows · POSTE', materiel: 'aaaa' });
  const b = appareil.charger(d, { nom: 'POSTE', type: 'Windows · POSTE', materiel: 'aaaa' });
  assert.equal(b.id, a.id);
  assert.equal(b.nom, a.nom);
  assert.equal(b.evenement, undefined);
});

test('migration : ancien nom = nom du poste -> nom memorable ; id et lettre gardes', () => {
  const d = dossier();
  ecrireFichier(d, { id: '60b7003c', nom: 'DESKTOP-69VU945', prefixe_ref: 'M', cree_le: '2026-09-01T00:00:00Z', inscrit: true });
  const a = appareil.charger(d, { nom: 'DESKTOP-69VU945', type: 'Windows · DESKTOP-69VU945' });
  assert.equal(a.evenement, 'migre');
  assert.equal(a.id, '60b7003c');
  assert.equal(a.prefixe_ref, 'M');
  assert.equal(a.nom, nomPour('60b7003c'));
  assert.equal(lireFichier(d).nom, nomPour('60b7003c'));
  assert.equal(lireFichier(d).inscrit, true);
  // Une seule fois : un nom memorable n'est plus jamais touche.
  assert.equal(appareil.charger(d, { nom: 'DESKTOP-69VU945' }).evenement, undefined);
});

test('migration : « Téléphone » (ancien nom mobile) -> nom memorable', () => {
  const d = dossier();
  ecrireFichier(d, { id: '3b660940', nom: 'Téléphone', prefixe_ref: 'P' });
  const a = appareil.charger(d, { nom: 'Téléphone', type: 'Android · Samsung SM-G998B' });
  assert.equal(a.nom, nomPour('3b660940'));
  assert.equal(a.type, 'Android · Samsung SM-G998B');
});

test('nom choisi par l\'utilisateur : jamais remplace', () => {
  const d = dossier();
  ecrireFichier(d, { id: '11112222', nom: 'POSTE', nom_perso: true, prefixe_ref: 'L' });
  assert.equal(appareil.charger(d, { nom: 'POSTE' }).nom, 'POSTE');
});

test('type recalcule a chaque lancement', () => {
  const d = dossier();
  appareil.charger(d, { type: 'Android · A' });
  assert.equal(appareil.charger(d, { type: 'Android · B' }).type, 'Android · B');
  assert.equal(lireFichier(d).type, 'Android · B');
});

test('empreinte absente du fichier (version precedente) : ajoutee, identite gardee', () => {
  const d = dossier();
  ecrireFichier(d, { id: 'cef571ef', nom: 'Poire rêveuse', nom_memorable: true, prefixe_ref: 'L' });
  const a = appareil.charger(d, { materiel: 'm1' });
  assert.equal(a.id, 'cef571ef');
  assert.equal(lireFichier(d).materiel, 'm1');
});

test('identite recopiee sur une autre machine : nouvelle identite, l\'ancienne proposee', () => {
  const d = dossier();
  ecrireFichier(d, { id: 'cef571ef', nom: 'Poire rêveuse', nom_memorable: true, prefixe_ref: 'P', materiel: 'm1',
    inscrit: true, dossier_synchro: 'C:\\partage' });
  const a = appareil.charger(d, { materiel: 'm2', type: 'Windows · AUTRE' });
  assert.equal(a.evenement, 'copie');
  assert.notEqual(a.id, 'cef571ef');
  assert.equal(a.prefixe_ref, 'L');
  assert.equal(a.inscrit, undefined, 'pas encore inscrit');
  assert.equal(a.copie_de, 'cef571ef');
  assert.deepEqual(a.ancien, { id: 'cef571ef', nom: 'Poire rêveuse', prefixe: 'P' });
  assert.equal(a.dossier_synchro, 'C:\\partage', 'le dossier de synchro choisi reste');
  assert.equal(lireFichier(d).materiel, 'm2');
});

test('empreinte illisible (null) : identite gardee, pas de fausse copie', () => {
  const d = dossier();
  ecrireFichier(d, { id: 'cef571ef', nom: 'Poire rêveuse', nom_memorable: true, prefixe_ref: 'P', materiel: 'm1' });
  assert.equal(appareil.charger(d, { materiel: null }).id, 'cef571ef');
});

test('fichier illisible ou invalide : nouvelle identite', () => {
  const d = dossier();
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'appareil.json'), '{pas du json');
  assert.equal(appareil.charger(d).evenement, 'cree');
  const d2 = dossier();
  ecrireFichier(d2, { id: 'XYZ', prefixe_ref: 'L' });
  assert.equal(appareil.charger(d2).evenement, 'cree');
});

test('sauver : jamais les champs de compte rendu', () => {
  const d = dossier();
  const a = appareil.charger(d, { materiel: 'm2' });
  appareil.sauver(d, { ...a, evenement: 'copie', ancien: { id: 'x' }, prefixe_ref: 'Q' });
  const f = lireFichier(d);
  assert.equal(f.prefixe_ref, 'Q');
  assert.equal(f.evenement, undefined);
  assert.equal(f.ancien, undefined);
});

test('copie de secours (mobile) : appelee a chaque enregistrement, avec le contenu ecrit', () => {
  const copies = [];
  appareil.apresEnregistrement((a) => copies.push(a));
  try {
    const d = dossier();
    const a = appareil.charger(d, { materiel: 'm3' });
    appareil.sauver(d, { ...a, prefixe_ref: 'R' });
    assert.equal(copies.length, 2);
    assert.equal(copies[1].prefixe_ref, 'R');
    assert.equal(copies[1].evenement, undefined);
  } finally { appareil.apresEnregistrement(null); }
});

test('copie de secours en echec : n\'empeche pas l\'enregistrement', () => {
  appareil.apresEnregistrement(() => { throw new Error('preferences indisponibles'); });
  try {
    const d = dossier();
    const a = appareil.charger(d);
    assert.equal(lireFichier(d).id, a.id);
  } finally { appareil.apresEnregistrement(null); }
});

test('empreinte : stable, courte, jamais l\'identifiant en clair ; vide -> null', () => {
  const e = appareil.empreinte('android', '9774d56d682e549c');
  assert.match(e, /^[0-9a-f]{16}$/);
  assert.equal(e, appareil.empreinte('android', '9774d56d682e549c'));
  assert.notEqual(e, appareil.empreinte('android', '9774d56d682e549d'));
  assert.ok(!e.includes('9774d56d'));
  assert.equal(appareil.empreinte(), null);
  assert.equal(appareil.empreinte(null, ''), null);
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* verrou */ }
console.log(`\n${nOk} ok, ${nKo} KO`);
process.exit(nKo ? 1 : 0);
