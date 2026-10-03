'use strict';
/**
 * Contenus anormaux ou hostiles dans les tuiles et les notes : ecritures non
 * latines, emoji, caracteres invisibles / de controle / nuls, moitie de
 * caractere isolee, HTML et <script>, SQL, jokers LIKE, JSON, __proto__,
 * chemins piege, dates absurdes, textes enormes. Pour chacun : ecriture,
 * relecture, recherche, masques, synchro vers un autre appareil, reouverture
 * (reconciliation muette), sauvegarde zip ; plus des ops hostiles recues d'un
 * « autre appareil ».
 *
 *     node scripts/lancer-node.js tests/anomalies.test.js
 */

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RACINE = path.resolve(__dirname, '..');
const src = (p) => require(path.join(RACINE, 'src/main', p));
const db = src('db');
const etat = src('synchro/etat');
const moteur = src('synchro/moteur');
const edition = src('edition');
const jeu = src('jeu');
const appareil = src('synchro/appareil');
const service = src('synchro/service');
const sauvegarde = src('sauvegarde');
const journal = src('journal');
const { normaliser, normaliserRecherche } = src('masques');
const { viderCaches } = src('synchro/transport-drive');
const { creerFauxDrive } = require('./faux-drive');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-anomalies-'));
const PACK = path.join(TMP, 'pack.db');
fs.copyFileSync(path.join(RACINE, 'data/pack.db'), PACK);
const LOGS = path.join(TMP, 'logs');
journal.configurer(LOGS, {}, { console: false });
const lignesJournal = () => fs.readdirSync(LOGS).map((f) => fs.readFileSync(path.join(LOGS, f), 'utf8')).join('').split('\n').filter(Boolean);

let nOk = 0, nKo = 0;
async function test(nom, fn) {
  try { await fn(); nOk++; console.log('  ok  ' + nom); }
  catch (e) { nKo++; console.log('  KO  ' + nom + '\n      ' + String(e.stack || e).split('\n').slice(0, 8).join('\n      ')); }
}

function ouvrir(dir) {
  db.fermer();
  const a = appareil.charger(dir, { nom: path.basename(dir) });
  etat.configurer({ appareil: a });
  const images = path.join(dir, 'images-locales');
  fs.mkdirSync(images, { recursive: true });
  edition.configurer(images);
  service.configurer({ dossierUser: dir, imagesLocales: images });
  sauvegarde.configurer({ user: path.join(dir, 'utilisateur.db'), imagesLocales: images, pack: PACK, versionApp: 'test' });
  db.ouvrir(path.join(dir, 'utilisateur.db'), PACK);
  jeu.reinitialiserSac();
}
const neuf = () => { const d = fs.mkdtempSync(path.join(TMP, 'a-')); ouvrir(d); return d; };
async function sync(faux) {
  let r = await service.synchroniserDrive(null, faux);
  if (r.decisionRequise) { service.choisirRemplacement(null); r = await service.synchroniserDrive(null, faux); }
  assert.ok(!r.erreur, r.erreur);
  return r;
}

const C = String.fromCharCode;
// Valeur ecrite -> valeur attendue a la relecture (identique sauf mention).
const ANOMALIES = {
  cyrillique: 'Илья Репин — Бурлаки на Волге',
  chinois: '清明上河图 张择端',
  arabe: 'لوحة الموناليزا',
  grec: 'Νίκη της Σαμοθράκης',
  emoji: '🎨🖼️ 👨‍👩‍👧 🏳️‍🌈',
  combinants: 'Ce' + C(0x301) + 'zanne et Cézanne',
  invisibles: 'Mo' + C(0x200B) + 'net' + C(0xFEFF) + C(0x200D) + ' fin',
  controle: 'Tab\tici ' + C(7) + C(27) + '[31mrouge',
  nul: 'avant' + C(0) + 'apres',
  html: '</div><script>window.__xss=1</script><img src=x onerror="window.__xss=2">',
  sql: "'; DROP TABLE user_tags; -- \" OR 1=1",
  jokers: '100 % _ fin',
  json: '{"__proto__":{"pollue":1},"a":[1,2]}',
  proto: '__proto__',
  constructeur: 'constructor',
  sautsLigne: 'ligne1\r\nligne2\rligne3\n\nfin',
  chemin: '..\\..\\Windows\\system32\\x.jpg',
  url: 'javascript:alert(1)',
  nombre: '-99999999999999999999.5e308',
  dateAbsurde: 'Vers l’an 30 000 apr. J.-C. ??',
  long2000: 'X'.repeat(2000)
};
const SURROGAT = 'casse' + C(0xD800) + 'ici';

(async () => {
  console.log('ecriture, relecture, recherche');
  neuf();
  const ids = {};

  await test('chaque anomalie : creee, relue a l\'identique, masques calcules sans erreur', () => {
    for (const [nom, v] of Object.entries(ANOMALIES)) {
      const r = edition.creer({ titre: v, artiste: 'Artiste ' + nom, description: 'desc ' + v + ' ' + 'texte '.repeat(12), tags: nom === 'long2000' ? 'x' : v, date: v.slice(0, 40) });
      assert.ok(r.id && !r.erreur, nom + ' : ' + JSON.stringify(r));
      ids[nom] = r.id;
      const o = edition.tuile(r.id);
      assert.equal(o.titre, v.trim(), nom);
      assert.ok(Number.isInteger(r.masques), nom);
    }
  });

  await test('moitie de caractere isolee : remplacee par « � », a l\'ecriture comme a la relecture', () => {
    const r = edition.creer({ titre: SURROGAT, artiste: 'x', description: 'texte '.repeat(15) });
    ids.surrogat = r.id;
    assert.equal(edition.tuile(r.id).titre, 'casse' + C(0xFFFD) + 'ici');
    assert.equal(etat.valeur('locale', r.id, 'titre'), 'casse' + C(0xFFFD) + 'ici', 'registre = table');
  });

  await test('trop long : refuse avec un message clair, rien d\'ecrit ; a la limite : accepte', () => {
    const avant = db.instance().prepare('SELECT COUNT(*) n FROM oeuvres_locales').get().n;
    const r1 = edition.creer({ titre: 'T', description: 'D'.repeat(20001) });
    assert.match(r1.erreur, /Description.*trop long.*20.000 au plus/);
    const r2 = edition.creer({ titre: 'T'.repeat(2001) });
    assert.match(r2.erreur, /Titre.*trop long/);
    assert.equal(db.instance().prepare('SELECT COUNT(*) n FROM oeuvres_locales').get().n, avant);
    const r3 = edition.creer({ titre: 'Limite', artiste: 'x', description: 'D'.repeat(20000) });
    assert.ok(r3.id);
    const r4 = edition.modifier(r3.id, { ...edition.tuile(r3.id), lieu: 'L'.repeat(2001) });
    assert.match(r4.erreur, /Conservation.*trop long/);
    assert.equal(edition.tuile(r3.id).lieu, '');
  });

  await test('recherche : cyrillique, chinois, arabe, grec trouves ; SQL / jokers / HTML sans effet de bord', () => {
    const trouve = (q) => jeu.listerToutes({ texte: q }).map((o) => o.id);
    assert.deepEqual(trouve('Репин'), [ids.cyrillique]);
    assert.ok(trouve('张择端').includes(ids.chinois));
    assert.ok(trouve('الموناليزا').includes(ids.arabe));
    assert.ok(trouve('Σαμοθράκης').includes(ids.grec), 'accents grecs ignores comme les latins');
    assert.ok(trouve(ANOMALIES.sql).includes(ids.sql));
    assert.equal(db.instance().prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='user_tags'").get().n, 1, 'table intacte');
    assert.ok(trouve('script window xss').includes(ids.html));
    // Que de la ponctuation / des jokers : aucun filtre (toutes les tuiles), pas d'erreur.
    assert.equal(trouve('%').length, trouve('').length);
    assert.equal(trouve('_').length, trouve('').length);
  });

  await test('recherche du pack inchangee : la nouvelle normalisation = l\'ancienne pour tout texte latin', () => {
    const lignes = db.instance().prepare('SELECT artiste, titre, date, lieu, description, tags FROM pack.oeuvres').all();
    for (const o of lignes) {
      const t = Object.values(o).join(' ');
      assert.equal(normaliserRecherche(t), normaliser(t), t.slice(0, 60));
    }
  });

  await test('notes : memes anomalies, relues a l\'identique et cherchables', () => {
    const id = ids.cyrillique;
    for (const v of Object.values(ANOMALIES)) {
      assert.ok(edition.ecrireNote(id, v).ok);
      assert.equal(edition.lireNote(id).texte, v.replace(/\r\n/g, '\n').replace(/\s+$/, ''));
    }
    edition.ecrireNote(id, 'Заметка о картине');
    assert.ok(jeu.listerToutes({ texte: 'заметка' }).some((o) => o.id === id));
  });

  await test('journal : une ligne par evenement meme avec sauts de ligne, controles, HTML', () => {
    const lignes = lignesJournal();
    assert.ok(lignes.length > 10);
    for (const l of lignes) assert.match(l, /^\d{4}-\d\d-\d\dT/, 'ligne coupee : ' + l.slice(0, 80));
  });

  console.log('synchro et sauvegarde');

  await test('synchro vers un autre appareil : valeurs identiques, aucun conflit, bilan exact', async () => {
    viderCaches();
    const faux = creerFauxDrive();
    await sync(faux);
    const valeurs = Object.fromEntries(Object.entries(ids).map(([n, id]) => [n, edition.tuile(id)]));
    const nbA = db.instance().prepare('SELECT COUNT(*) n FROM oeuvres_locales').get().n;
    neuf();
    const r = await sync(faux);
    assert.equal(r.recu.tuilesNouvelles, nbA, JSON.stringify(r.recu));
    for (const [n, id] of Object.entries(ids)) {
      const o = edition.tuile(id);
      assert.ok(o, n + ' absente');
      for (const c of ['titre', 'artiste', 'date', 'description', 'tags']) assert.equal(o[c], valeurs[n][c], n + '.' + c);
    }
    assert.equal(etat.conflits().length, 0);
  });

  await test('reouverture : la reconciliation n\'a rien a reecrire (registre = tables)', () => {
    const dir = path.dirname(db.instance().name);
    const avant = lignesJournal().filter((l) => / reconciliation /.test(l)).length;
    ouvrir(dir); ouvrir(dir);
    const apres = lignesJournal().filter((l) => / reconciliation /.test(l)).length;
    assert.equal(apres, avant);
  });

  await test('sauvegarde zip : exportee puis importee dans une base neuve, valeurs identiques', () => {
    const zip = path.join(TMP, 'anomalies.zip');
    const attendu = Object.fromEntries(Object.entries(ids).map(([n, id]) => [n, edition.tuile(id).titre]));
    sauvegarde.exporter(zip);
    neuf();
    const r = sauvegarde.importer(zip);
    assert.ok(!r.erreur, r.erreur);
    for (const [n, id] of Object.entries(ids)) assert.equal(edition.tuile(id).titre, attendu[n], n);
  });

  console.log('ops hostiles recues d\'un autre appareil');

  const opHostile = (n, x) => ({ hlc: '000179' + String(1000000000 + n).padStart(10, '0') + '-0000-eeeeeeee', appareil: 'eeeeeeee', base: null, ...x });

  await test('cle / champ __proto__ ou constructor : sans pollution, l\'appli continue', () => {
    neuf();
    const ctx = etat.contexte();
    const essais = [
      { entite: 'locale', cle: '__proto__', champ: '_existe', valeur: '1' },
      { entite: 'locale', cle: 'local:x', champ: '__proto__', valeur: JSON.stringify({ pollue: 1 }) },
      { entite: 'tag', cle: 'constructor', champ: 'livre', valeur: '1' },
      { entite: 'note', cle: '__proto__', champ: '_', valeur: JSON.stringify('note') },
      { entite: 'override', cle: 'p:x', champ: 'constructor', valeur: JSON.stringify({ valeur: 'v', valeur_source: 's' }) }
    ];
    essais.forEach((x, i) => { moteur.appliquer(ctx, opHostile(i, x)); });
    edition.rafraichir();
    assert.equal(({}).pollue, undefined, 'prototype intact');
    assert.equal(Object.prototype.pollue, undefined);
    assert.ok(jeu.listerToutes({}).length > 400, 'Bibliotheque toujours lisible');
    assert.ok(jeu.tirer(null), 'tirage toujours possible');
  });

  await test('valeur enorme ou mal formee : rejetee', () => {
    const ctx = etat.contexte();
    assert.equal(moteur.appliquer(ctx, opHostile(20, { entite: 'locale', cle: 'local:y', champ: 'titre', valeur: JSON.stringify('Z'.repeat(moteur.VALEUR_MAX + 100)) })), 'rejetee');
    assert.equal(moteur.appliquer(ctx, opHostile(21, { entite: 'locale', cle: 'local:y', champ: 'titre', valeur: '{pas du json' })), 'rejetee');
    assert.equal(moteur.appliquer(ctx, opHostile(22, { entite: 'locale', cle: 'local:y', champ: 'titre', valeur: 12 })), 'rejetee');
  });

  await test('moitie de caractere recue d\'un autre appareil : bien formee ici aussi (meme valeur partout)', () => {
    const ctx = etat.contexte();
    const r = moteur.appliquer(ctx, opHostile(30, { entite: 'note', cle: ids.cyrillique, champ: '_', valeur: JSON.stringify(SURROGAT) }));
    assert.equal(r, 'avance');
    assert.equal(etat.valeur('note', ids.cyrillique, '_'), 'casse' + C(0xFFFD) + 'ici');
    assert.equal(edition.lireNote(ids.cyrillique).texte, 'casse' + C(0xFFFD) + 'ici');
  });

  await test('image au nom piege (chemin) : jamais resolue hors du dossier', () => {
    const images = src('images-distantes');
    assert.equal(images.nomSur('..\\..\\Windows\\win.ini'), null);
    assert.equal(images.nomSur('../../etc/passwd.jpg'), 'passwd.jpg', 'reduit a son nom');
  });

  db.fermer();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* verrou */ }
  console.log(`\n${nOk} ok, ${nKo} KO`);
  process.exit(nKo ? 1 : 0);
})();
