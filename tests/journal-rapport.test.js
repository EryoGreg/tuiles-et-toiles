'use strict';
/**
 * Journal de fonctionnement et rapport d'erreur.
 *
 *     node scripts/lancer-node.js tests/journal-rapport.test.js
 */

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');

const RACINE = path.resolve(__dirname, '..');
const journal = require(path.join(RACINE, 'src/main/journal'));
const rapport = require(path.join(RACINE, 'src/main/rapport'));
const lisezmoi = require(path.join(RACINE, 'src/main/lisezmoi'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-journal-'));
const LOGS = path.join(TMP, 'logs');

let nOk = 0, nKo = 0;
function test(nom, fn) {
  try { fn(); nOk++; console.log('  ok  ' + nom); }
  catch (e) { nKo++; console.log('  KO  ' + nom + '\n      ' + String(e.stack || e).split('\n').slice(0, 5).join('\n      ')); }
}
const lignes = () => fs.readFileSync(path.join(LOGS, 'journal.log'), 'utf8').split('\n').filter(Boolean);
const derniere = () => lignes().slice(-1)[0];

// Caracteres fabriques par code (pas d'echappement dans le source).
const ZWSP = String.fromCharCode(0x200B);
const CTRL = String.fromCharCode(0x07);
const EMOJI = String.fromCodePoint(0x1F3A8);

console.log('journal');

journal.configurer(LOGS, { version: 'test' }, { console: false });

test('en-tete de session', () => {
  assert.match(lignes()[0], /INFO\s+app\s+=== SESSION ===\s+s=[0-9a-f]{6}\s+\{"pid":\d+,"version":"test"\}/);
});

test('format : horodatage, niveau, domaine, evenement, session, JSON', () => {
  journal.evt('image', 'import:debut', { octets: 12 }, 'WARN');
  const m = /^(\S+)\s+(WARN)\s+(image)\s+(import:debut)\s+s=([0-9a-f]{6})\s+(\{.*\})$/.exec(derniere());
  assert.ok(m, derniere());
  assert.ok(!Number.isNaN(Date.parse(m[1])));
  assert.equal(m[5], journal.SESSION);
  assert.deepEqual(JSON.parse(m[6]), { octets: 12 });
});

test('jamais de secret : cles de type jeton masquees', () => {
  journal.evt('drive', 'x', { refresh_token: 'SECRET1', access_token: 'SECRET2', Authorization: 'Bearer SECRET3', code_verifier: 'SECRET4', ok: 1 });
  const l = derniere();
  assert.ok(!/SECRET/.test(l), l);
  assert.match(l, /"ok":1/);
});

test('erreur : message, code et pile', () => {
  const e = new Error('boum'); e.code = 'EBOUM';
  journal.erreur('synchro', 'echec', e, { etape: 'tirer' });
  const d = JSON.parse(derniere().replace(/^.*?\s(\{.*\})$/, '$1'));
  assert.equal(d.erreur, 'boum');
  assert.equal(d.code, 'EBOUM');
  assert.equal(d.etape, 'tirer');
  assert.match(d.stack, /journal-rapport\.test\.js/);
  assert.match(derniere(), /\sERREUR\s/);
});

test('valeurs enormes et binaires resumees', () => {
  journal.evt('ipc', 'x', { gros: 'a'.repeat(5000), octets: Buffer.alloc(3000), liste: Array.from({ length: 80 }, (_, i) => i) });
  const d = JSON.parse(derniere().replace(/^.*?\s(\{.*\})$/, '$1'));
  assert.ok(d.gros.length < 2100 && /\+3000 car/.test(d.gros));
  assert.deepEqual(d.octets, { octets: 3000 });
  assert.equal(d.liste.length, 51);
});

test('decrireTexte : cyrillique, emoji, invisibles, controles, interdits', () => {
  const d = journal.decrireTexte(' Москва' + ZWSP + EMOJI + CTRL + '?.jpg');
  assert.deepEqual(d.scripts, ['latin', 'cyrillique', 'emoji']);
  assert.equal(d.invisibles, 1);
  assert.equal(d.controles, 1);
  assert.equal(d.horsBMP, true);
  assert.equal(d.interditsFichier, true);
  assert.equal(d.espacesBords, true);
  assert.equal(journal.decrireTexte('Monet').scripts.join(), 'latin');
  assert.equal(journal.decrireTexte('Monet').controles, undefined);
});

test('ancienne API ligne() : [ui] -> domaine ui, ERREUR -> niveau ERREUR', () => {
  journal.ligne('[ui] page -> jeu');
  assert.match(derniere(), /\sINFO\s+ui\s+page -> jeu/);
  journal.ligne('ERREUR quelque chose', { a: 1 });
  assert.match(derniere(), /\sERREUR\s+app\s+quelque chose/);
});

test('rotation : 5 Mo par fichier, 5 fichiers au plus', () => {
  const bloc = 'x'.repeat(1900);
  for (let i = 0; i < 16000; i++) journal.evt('test', 'remplissage', { i, bloc });
  const f = journal.fichiers().map((x) => path.basename(x));
  assert.deepEqual(f, ['journal.log', 'journal.log.1', 'journal.log.2', 'journal.log.3', 'journal.log.4']);
  for (const x of journal.fichiers()) assert.ok(fs.statSync(x).size <= 5.1 * 1024 * 1024, x);
});

// --- rapport ------------------------------------------------------------------

console.log('rapport');

const moi = os.userInfo().username;
const poste = os.hostname();

test('masquage : utilisateur dans les chemins (simple et double antislash), poste, emails', () => {
  const t = [
    'C:\\Users\\' + moi + '\\AppData\\Roaming',
    JSON.stringify({ p: 'C:\\Users\\' + moi + '\\Documents' }),
    '/home/' + moi + '/x',
    'appareil ' + poste + ' pret',
    'contact : jean.dupont@exemple.fr, dest : ' + rapport.DESTINATAIRE
  ].join('\n');
  const m = rapport.masquer(t);
  assert.ok(!new RegExp('Users\\\\{1,2}' + moi, 'i').test(m), m);
  assert.ok(!m.includes('/home/' + moi));
  assert.ok(m.includes('<utilisateur>'));
  if (poste.length >= 3) assert.ok(!new RegExp('(^|[^A-Za-z0-9])' + poste + '([^A-Za-z0-9]|$)', 'i').test(m), m);
  assert.ok(m.includes('<email>'));
  assert.ok(m.includes(rapport.DESTINATAIRE), 'le destinataire reste lisible');
  assert.ok(rapport.masquer('moi@ici.fr', { garder: ['moi@ici.fr'] }).includes('moi@ici.fr'));
});

test('horodatage local avec decalage + UTC', () => {
  const h = rapport.horodatage(new Date('2026-09-24T11:45:07Z'));
  assert.match(h.local, /^2026-09-24T\d{2}:45:07[+-]\d{2}:\d{2}$/);
  assert.equal(h.utc, '2026-09-24T11:45:07.000Z');
  assert.match(h.fichier, /^2026-09-24_\d{6}$/);
});

test('rapport complet : zip (LISEZMOI, rapport, journaux masques) + mail pre-rempli', () => {
  journal.evt('image', 'chemin', { chemin: 'C:\\Users\\' + moi + '\\Pictures\\Москва.jpg' }, 'ERREUR');
  const DOSSIER = path.join(TMP, 'rapports');
  rapport.configurer({
    dossier: DOSSIER, version: '9.9.9',
    infos: () => ({ os: 'win32 test', appareil: { id: 'aaaa0001', nom: poste }, donnees: { dossier: 'C:\\Users\\' + moi } })
  });
  const r = rapport.preparer({
    sujet: 'image', depuis: 'semaine', reproductible: 'toujours',
    description: 'La photo Москва.jpg ne s’importe pas', email: 'testeur@exemple.fr'
  });
  assert.ok(fs.existsSync(r.chemin));
  assert.match(r.nom, /^rapport-\d{4}-\d{2}-\d{2}_\d{6}-image\.zip$/);
  assert.ok(fs.existsSync(path.join(DOSSIER, lisezmoi.NOM)), 'LISEZMOI du dossier des rapports');
  assert.match(r.objet, /^\[T&T rapport\] Image non importée ou mal affichée — v9\.9\.9 — \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.match(r.corps, /Depuis quand : Depuis quelques jours/);
  assert.match(r.corps, /Reproductible : Oui, à chaque fois/);
  assert.match(r.corps, /Contact : testeur@exemple\.fr/);
  assert.match(r.corps, new RegExp(r.nom.replace(/\./g, '\\.')));
  assert.ok(r.apercu.niveaux.ERREUR >= 1);

  const zip = new AdmZip(r.chemin);
  const noms = zip.getEntries().map((e) => e.entryName).sort();
  assert.ok(noms.includes('LISEZMOI.txt') && noms.includes('rapport.txt') && noms.includes('rapport.json'));
  assert.ok(noms.includes('journaux/journal.log'));
  const log = zip.readAsText('journaux/journal.log');
  assert.ok(log.includes('Москва.jpg'), 'les textes restent');
  assert.ok(!new RegExp('Users\\\\{1,2}' + moi, 'i').test(log), 'utilisateur masque dans le journal');
  const json = JSON.parse(zip.readAsText('rapport.json'));
  assert.equal(json.formulaire.email, 'testeur@exemple.fr', 'email saisi volontairement : garde');
  assert.equal(json.application.donnees.dossier, 'C:\\Users\\<utilisateur>');
  assert.ok(json.horodatage.local && json.horodatage.utc);
  assert.equal(json.session, journal.SESSION);
  // Le mail : destinataire, objet et corps encodes.
  const m = rapport.dernierRapport().mailto;
  assert.ok(m.startsWith('mailto:' + rapport.DESTINATAIRE + '?subject='));
  assert.ok(decodeURIComponent(m).includes('[T&T rapport]'));
  assert.ok(m.length < 4000, 'mailto raisonnable : ' + m.length);
});

test('sujet inconnu -> « Autre »', () => {
  assert.match(rapport.preparer({ sujet: 'nimporte', depuis: 'inconnu', reproductible: 'parfois' }).objet, /\] Autre — /);
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* verrou */ }
console.log(`\n${nOk} ok, ${nKo} KO`);
process.exit(nKo ? 1 : 0);
