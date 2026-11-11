'use strict';
/**
 * Repetition espacee (src/main/revision.js + fsrs.js) : etat FSRS rejoue
 * depuis les notes, file du jour (dues, nouvelles, quota), annulation, et
 * synchro entre deux appareils (faux Drive) : memes echeances partout.
 * Plus : ops d'une entite inconnue gardees en attente (appareil plus recent).
 *
 *     node scripts/lancer-node.js tests/revision.test.js
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
const annuler = src('annuler');
const revision = src('revision');
const fsrs = src('fsrs');
const { viderCaches } = src('synchro/transport-drive');
const { creerFauxDrive } = require('./faux-drive');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-revision-'));
const PACK = path.join(TMP, 'pack.db');
fs.copyFileSync(path.join(RACINE, 'data/pack.db'), PACK);
const JOUR = 86400000;
const MIN = 60000;

let nOk = 0, nKo = 0;
async function test(nom, fn) {
  try { await fn(); nOk++; console.log('  ok  ' + nom); }
  catch (e) { nKo++; console.log('  KO  ' + nom + '\n      ' + String(e.stack || e).split('\n').slice(0, 7).join('\n      ')); }
}

function ouvrir(dir) {
  db.fermer();
  const a = appareil.charger(dir, { nom: path.basename(dir) });
  etat.configurer({ appareil: a });
  const images = path.join(dir, 'images-locales');
  fs.mkdirSync(images, { recursive: true });
  edition.configurer(images);
  service.configurer({ dossierUser: dir, imagesLocales: images });
  db.ouvrir(path.join(dir, 'utilisateur.db'), PACK);
  jeu.reinitialiserSac();
  annuler.vider();
}
const neuf = () => { const d = fs.mkdtempSync(path.join(TMP, 'a-')); ouvrir(d); return d; };
// Midi local d'un jour fixe : loin de minuit, les « aujourd'hui » sont nets.
const T0 = new Date(2026, 9, 5, 12, 0, 0).getTime();

(async () => {
  console.log('etat FSRS rejoue depuis les notes');

  await test('aucune note : pas de carte', () => {
    assert.equal(revision.etatCarte([], 0.9), null);
  });

  await test('premiere note « Bien » : echeance = intervalle FSRS de la stabilite initiale', () => {
    const c = revision.etatCarte([{ n: 3, t: T0 }], 0.9);
    const attendu = fsrs.intervalleJours(fsrs.premiere(3).stabilite, 0.9);
    assert.equal(c.intervalleJours, attendu);
    assert.equal(c.du, T0 + attendu * JOUR);
    assert.equal(c.n, 1);
  });

  await test('« Encore » : de nouveau due 10 minutes plus tard', () => {
    const c = revision.etatCarte([{ n: 3, t: T0 }, { n: 1, t: T0 + 5 * JOUR }], 0.9);
    assert.equal(c.intervalleJours, 0);
    assert.equal(c.du, T0 + 5 * JOUR + 10 * MIN);
  });

  await test('notes « Bien » successives a l\'echeance : intervalles croissants', () => {
    let notes = [{ n: 3, t: T0 }];
    const inter = [];
    for (let i = 0; i < 5; i++) {
      const c = revision.etatCarte(notes, 0.9);
      inter.push(c.intervalleJours);
      notes = [...notes, { n: 3, t: c.du }];
    }
    for (let i = 1; i < inter.length; i++) assert.ok(inter[i] > inter[i - 1], inter.join(' → '));
  });

  await test('retention plus haute = intervalles plus courts', () => {
    const a = revision.etatCarte([{ n: 3, t: T0 }, { n: 3, t: T0 + 4 * JOUR }], 0.85);
    const b = revision.etatCarte([{ n: 3, t: T0 }, { n: 3, t: T0 + 4 * JOUR }], 0.95);
    assert.ok(b.intervalleJours < a.intervalleJours);
  });

  await test('ordre du jour : melange stable dans la journee, autre ordre le lendemain', () => {
    const ids = Array.from({ length: 40 }, (_, i) => 'p:' + i);
    const a = revision.ordreDuJour(ids, T0), b = revision.ordreDuJour(ids, T0 + 3 * 3600000);
    assert.deepEqual(a, b);
    assert.notDeepEqual(a, revision.ordreDuJour(ids, T0 + JOUR));
    assert.deepEqual([...a].sort(), [...ids].sort());
  });

  console.log('file du jour');

  await test('base neuve : 0 due, 10 nouvelles (quota), rien d\'appris', () => {
    neuf();
    const c = revision.resume(T0);
    assert.equal(c.dues, 0);
    assert.equal(c.nouvelles, 10);
    assert.equal(c.apprises, 0);
    assert.ok(c.total >= 431);
  });

  await test('noter une nouvelle : quota entame, tuile apprise, pas due avant son echeance', () => {
    neuf();
    const t = revision.tirer([], T0);
    assert.equal(t.revision.nouvelle, true);
    assert.deepEqual(Object.keys(t.revision.apercu), ['1', '2', '3', '4']);
    assert.ok(t.masque && t.champs, 'une tuile de jeu, masque compris');
    assert.equal(t.champs.date, null, 'la date n\'est jamais visible au tirage (regle 2)');
    const r = revision.noter(t.id, 3, T0);
    assert.ok(r.ok);
    const c = revision.resume(T0 + MIN);
    assert.equal(c.nouvelles, 9);
    assert.equal(c.apprises, 1);
    assert.equal(c.introduitesAujourdhui, 1);
    assert.equal(c.dues, 0);
    assert.equal(revision.resume(T0 + r.intervalleJours * JOUR + MIN).dues, 1, 'due a l\'echeance');
  });

  await test('« Encore » : revient dans la session (en avance si plus rien d\'autre), due apres 10 min', () => {
    neuf();
    db.definirReglage ? db.definirReglage('revision_nouvelles', '1') : db.instance().prepare("INSERT OR REPLACE INTO reglages (cle, valeur) VALUES ('revision_nouvelles', '1')").run();
    const t = revision.tirer([], T0);
    revision.noter(t.id, 1, T0);
    assert.equal(revision.resume(T0 + MIN).dues, 0);
    const avance = revision.tirer([], T0 + MIN);
    assert.equal(avance.id, t.id, 'plus rien de du : l\'« Encore » revient en avance');
    assert.equal(revision.resume(T0 + 11 * MIN).dues, 1);
  });

  await test('quota de nouvelles atteint et rien de du : fini, avec la prochaine echeance', () => {
    neuf();
    db.instance().prepare("INSERT OR REPLACE INTO reglages (cle, valeur) VALUES ('revision_nouvelles', '2')").run();
    for (let i = 0; i < 2; i++) { const t = revision.tirer([], T0 + i); revision.noter(t.id, 4, T0 + i); }
    const r = revision.tirer([], T0 + MIN);
    assert.equal(r.fini, true);
    assert.ok(r.compte.prochaine);
    assert.equal(revision.resume(T0 + JOUR).nouvelles, 2, 'nouveau quota le lendemain');
  });

  await test('quota « illimite » : toutes les tuiles jamais notees, compte sans Infinity', () => {
    neuf();
    db.instance().prepare("INSERT OR REPLACE INTO reglages (cle, valeur) VALUES ('revision_nouvelles', ?)").run(revision.ILLIMITE);
    assert.equal(revision.reglages().nouvelles, Infinity);
    const c = revision.resume(T0);
    assert.equal(c.illimite, true);
    assert.equal(c.quotaNouvelles, null, 'Infinity ne passe pas par JSON');
    assert.equal(c.nouvelles, c.total, 'toutes les tuiles proposees');
    assert.ok(c.nouvelles > 200, 'au-dela de l\'ancien plafond de 200');
    for (let i = 0; i < 40; i++) { const t = revision.tirer([], T0 + i); revision.noter(t.id, 4, T0 + i); }
    const apres = revision.resume(T0 + MIN);
    assert.equal(apres.nouvelles, c.total - 40, 'pas de quota atteint apres 40 nouvelles');
    assert.equal(revision.tirer([], T0 + MIN).revision.nouvelle, true);
    // Retour a un nombre : quota ordinaire, illimite retombe.
    db.instance().prepare("INSERT OR REPLACE INTO reglages (cle, valeur) VALUES ('revision_nouvelles', '30')").run();
    const borne = revision.resume(T0 + MIN);
    assert.equal(borne.illimite, false);
    assert.equal(borne.quotaNouvelles, 30);
    assert.equal(borne.nouvelles, 0, '40 deja introduites aujourd\'hui > 30');
  });

  const quota = (v) => db.instance().prepare("INSERT OR REPLACE INTO reglages (cle, valeur) VALUES ('revision_nouvelles', ?)").run(String(v));
  const ids = (n) => { quota(revision.ILLIMITE); const l = revision.file(T0).nouvelles.slice(0, n); return l; };

  await test('« Encore » echue apres 3 autres tuiles : passe avant les dues plus en retard', () => {
    neuf();
    const l = ids(10);
    for (const id of l.slice(1)) revision.noter(id, 3, T0 - 30 * JOUR);   // 9 dues tres en retard
    quota(0);
    const x = l[0];
    revision.noter(x, 1, T0);
    for (let i = 1; i <= 3; i++) {
      const t = revision.tirer([], T0 + i * MIN);
      assert.notEqual(t.id, x, 'pas avant 10 min');
      revision.noter(t.id, 3, T0 + i * MIN);
    }
    const t = revision.tirer([], T0 + 11 * MIN);
    assert.equal(t.id, x, 'l\'« Encore » passe devant les dues');
  });

  await test('garde-fou : une « Encore » echue ne revient pas avant 3 autres tuiles', () => {
    neuf();
    const l = ids(10);
    for (const id of l.slice(1)) revision.noter(id, 3, T0 - 30 * JOUR);
    quota(0);
    const x = l[0];
    revision.noter(x, 1, T0);
    const vues = [];
    for (let i = 0; i < 3; i++) {
      const t = revision.tirer([], T0 + 20 * MIN + i);   // 10 min passees, mais 0, 1, 2 autres seulement
      assert.notEqual(t.id, x, 'retenue apres ' + i + ' autre(s)');
      vues.push(t.id); revision.noter(t.id, 3, T0 + 20 * MIN + i);
    }
    assert.equal(revision.tirer([], T0 + 20 * MIN + 5).id, x);
  });

  await test('garde-fou leve s\'il ne reste rien d\'autre', () => {
    neuf();
    const l = ids(1);
    quota(0);
    revision.noter(l[0], 1, T0);
    assert.equal(revision.tirer([], T0 + 11 * MIN).id, l[0]);
  });

  await test('alternance : apres 2 fragiles, une due solide passe avant la fragile suivante', () => {
    neuf();
    const l = ids(6);
    for (const id of l.slice(0, 5)) revision.noter(id, 2, T0 - 30 * JOUR);  // fragiles tres en retard (S ~ 1,2 j)
    revision.noter(l[5], 4, T0 - 20 * JOUR);                                  // solide due, moins en retard (S ~ 15 j)
    quota(0);
    const suite = [];
    for (let i = 0; i < 6; i++) {
      const t = revision.tirer([], T0 + i * MIN);
      assert.ok(!t.fini, 'tirage ' + i);
      suite.push(t.id);
      revision.noter(t.id, 3, T0 + i * MIN);
    }
    assert.equal(suite[2], l[5], 'la solide passe en 3e, avant les fragiles plus en retard');
    assert.equal(new Set(suite).size, 6);
  });

  await test('respiration : que des fragiles dues → une tuile solide en avance toutes les 2', () => {
    neuf();
    const l = ids(8);
    for (const id of l.slice(0, 5)) revision.noter(id, 2, T0 - 3 * JOUR);   // fragiles dues
    for (const id of l.slice(5)) revision.noter(id, 4, T0 - 2 * JOUR);       // solides pas dues
    quota(0);
    const solides = new Set(l.slice(5));
    const a = revision.tirer([], T0); assert.ok(!solides.has(a.id)); revision.noter(a.id, 3, T0);
    const b = revision.tirer([], T0 + MIN); assert.ok(!solides.has(b.id)); revision.noter(b.id, 3, T0 + MIN);
    const c = revision.tirer([], T0 + 2 * MIN);
    assert.ok(solides.has(c.id), 'tuile solide pour souffler');
    assert.equal(c.revision.enAvance, true);
    assert.equal(c.revision.nouvelle, false);
    revision.noter(c.id, 4, T0 + 2 * MIN);
    const d = revision.tirer([], T0 + 3 * MIN);
    assert.ok(!solides.has(d.id), 'retour aux fragiles');
    assert.equal(d.revision.enAvance, false);
    // Revision en avance d'une tuile acquise : echeance pas raccourcie.
    const avant = revision.etatCarte([{ n: 4, t: T0 - 2 * JOUR }], 0.9);
    const apres = revision.file(T0 + 3 * MIN).cartes.get(c.id);
    assert.ok(apres.du >= avant.du, 'l\'avance ne rapproche pas l\'echeance');
  });

  await test('respiration : une nouvelle tuile sert aussi a souffler, pas de solide en avance si rien de solide', () => {
    neuf();
    const l = ids(3);
    for (const id of l) revision.noter(id, 2, T0 - 3 * JOUR);
    quota(1);
    const vus = [];
    for (let i = 0; i < 4; i++) {
      const t = revision.tirer([], T0 + i * MIN);
      vus.push(t); revision.noter(t.id, 3, T0 + i * MIN);
    }
    assert.equal(vus[2].revision.nouvelle, true, 'la nouvelle passe en 3e');
    assert.ok(vus.every((t) => !t.revision.enAvance));
  });

  await test('dues avant les nouvelles, les plus en retard d\'abord ; « exclure » saute la derniere vue', () => {
    neuf();
    const a = revision.tirer([], T0); revision.noter(a.id, 3, T0);
    const b = revision.tirer([], T0 + 1); revision.noter(b.id, 2, T0 + 1);
    const plusTard = T0 + 60 * JOUR;
    const t = revision.tirer([], plusTard);
    assert.ok([a.id, b.id].includes(t.id));
    assert.equal(t.revision.nouvelle, false);
    const autre = revision.tirer([t.id], plusTard);
    assert.notEqual(autre.id, t.id);
  });

  await test('tuile sans masque valide ou supprimee : jamais proposee', () => {
    neuf();
    const id = edition.creer({ titre: 'x' }).id;    // trop pauvre : 0 masque
    const f = revision.file(T0);
    assert.ok(!f.nouvelles.includes(id));
    assert.equal(revision.noter('p:inexistant', 3).erreur, 'tuile introuvable');
    assert.equal(revision.noter(f.nouvelles[0], 7).erreur, 'note invalide');
  });

  await test('Ctrl+Z sur une note : elle disparait (la tuile redevient nouvelle)', () => {
    neuf();
    const t = revision.tirer([], T0);
    annuler.action('Note', () => revision.noter(t.id, 3, T0));
    assert.equal(revision.resume(T0).apprises, 1);
    annuler.annuler();
    assert.equal(revision.resume(T0).apprises, 0);
    assert.equal(db.instance().prepare('SELECT COUNT(*) n FROM user_revisions').get().n, 0);
    annuler.retablir();
    assert.equal(revision.resume(T0).apprises, 1);
  });

  await test('deux notes dans la meme milliseconde : deux identifiants distincts', () => {
    neuf();
    const t = revision.tirer([], T0);
    revision.noter(t.id, 1, T0);
    revision.noter(t.id, 3, T0);
    assert.equal(db.instance().prepare('SELECT COUNT(*) n FROM user_revisions WHERE oeuvre_id=?').get(t.id).n, 2);
  });

  console.log('synchro entre appareils');

  await test('notes sur le PC puis sur le telephone : memes echeances partout', async () => {
    viderCaches();
    const faux = creerFauxDrive();
    const PC = neuf();
    assert.ok(!(await service.synchroniserDrive(null, faux)).erreur);
    const TEL = neuf();
    await service.synchroniserDrive(null, faux);
    service.choisirRemplacement(null);
    assert.ok(!(await service.synchroniserDrive(null, faux)).erreur);

    ouvrir(PC);
    const t = revision.tirer([], T0);
    revision.noter(t.id, 3, T0);
    assert.ok(!(await service.synchroniserDrive(null, faux)).erreur);

    ouvrir(TEL);
    assert.ok(!(await service.synchroniserDrive(null, faux)).erreur);
    const surTel = revision.file(T0 + 10 * JOUR).cartes.get(t.id);
    assert.ok(surTel, 'la note du PC est arrivee');
    revision.noter(t.id, 2, T0 + 10 * JOUR);           // le telephone continue
    assert.ok(!(await service.synchroniserDrive(null, faux)).erreur);
    const telFin = revision.file(T0 + 10 * JOUR + MIN).cartes.get(t.id);

    ouvrir(PC);
    assert.ok(!(await service.synchroniserDrive(null, faux)).erreur);
    const pcFin = revision.file(T0 + 10 * JOUR + MIN).cartes.get(t.id);
    assert.equal(pcFin.n, 2);
    assert.equal(pcFin.du, telFin.du);
    assert.equal(pcFin.stabilite, telFin.stabilite);
    assert.equal(etat.conflits().length, 0);
  });

  await test('notes simultanees sur deux appareils : toutes gardees, rejouees dans l\'ordre chronologique', async () => {
    viderCaches();
    const faux = creerFauxDrive();
    const A = neuf(); await service.synchroniserDrive(null, faux);
    const B = neuf(); await service.synchroniserDrive(null, faux); service.choisirRemplacement(null); await service.synchroniserDrive(null, faux);
    ouvrir(A);
    const id = revision.tirer([], T0).id;
    revision.noter(id, 3, T0);
    ouvrir(B);
    revision.noter(id, 1, T0 + 2 * JOUR);
    ouvrir(A);
    revision.noter(id, 4, T0 + 3 * JOUR);
    await service.synchroniserDrive(null, faux);
    ouvrir(B); await service.synchroniserDrive(null, faux);
    ouvrir(A); await service.synchroniserDrive(null, faux);
    const ca = revision.file(T0 + 4 * JOUR).cartes.get(id);
    ouvrir(B);
    const cb = revision.file(T0 + 4 * JOUR).cartes.get(id);
    assert.equal(ca.n, 3);
    assert.equal(ca.du, cb.du);
    assert.equal(ca.derniereNote, 4);
    assert.equal(etat.conflits().length, 0);
  });

  console.log('compatibilite : entite inconnue (appareil plus recent)');

  await test('op d\'une entite inconnue : gardee en attente, pas rejetee', () => {
    neuf();
    const ctx = etat.contexte();
    const r = moteur.appliquer(ctx, { hlc: '0001790000000000-0000-aaaaaaaa', appareil: 'aaaaaaaa', entite: 'futur', cle: 'p:x', champ: 'y', valeur: '1' });
    assert.equal(r, 'attente');
    assert.equal(db.instance().prepare('SELECT COUNT(*) n FROM ops_attente').get().n, 1);
    assert.equal(moteur.appliquer(ctx, { hlc: 'x', entite: 'Pas Bien!', cle: 'a', champ: 'b' }), 'rejetee');
  });

  await test('ops en attente d\'une entite devenue connue : appliquees a l\'ouverture', () => {
    const dir = neuf();
    const id = db.instance().prepare('SELECT id FROM oeuvres_effectives ORDER BY ref LIMIT 1').get().id;
    // Ce qu'une ancienne version (qui ignorait 'revision') aurait range de cote.
    const op = { hlc: '0001790000000000-0000-bbbbbbbb', appareil: 'bbbbbbbb', entite: 'revision', cle: id,
      champ: 'bbbbbbbb.abc', valeur: JSON.stringify({ n: 3, le: new Date(T0).toISOString() }), pousse: 1 };
    db.instance().prepare('INSERT INTO ops_attente (hlc, entite, op) VALUES (?, ?, ?)').run(op.hlc, op.entite, JSON.stringify(op));
    ouvrir(dir);
    assert.equal(db.instance().prepare('SELECT COUNT(*) n FROM ops_attente').get().n, 0);
    assert.equal(revision.file(T0 + MIN).cartes.get(id).n, 1);
  });

  await test('op revision mal formee : rejetee', () => {
    neuf();
    const ctx = etat.contexte();
    const base = { hlc: '0001790000000001-0000-cccccccc', appareil: 'cccccccc', entite: 'revision', cle: 'p:x' };
    assert.equal(moteur.appliquer(ctx, { ...base, champ: 'pas-un-id', valeur: JSON.stringify({ n: 3, le: '2026-10-05T10:00:00Z' }) }), 'rejetee');
    assert.equal(moteur.appliquer(ctx, { ...base, champ: 'cccccccc.a1', valeur: JSON.stringify({ n: 5, le: '2026-10-05T10:00:00Z' }) }), 'rejetee');
    assert.equal(moteur.appliquer(ctx, { ...base, champ: 'cccccccc.a1', valeur: JSON.stringify({ n: 2, le: 'demain' }) }), 'rejetee');
  });

  db.fermer();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* verrou */ }
  console.log(`\n${nOk} ok, ${nKo} KO`);
  process.exit(nKo ? 1 : 0);
})();
