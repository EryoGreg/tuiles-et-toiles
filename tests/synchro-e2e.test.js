'use strict';
/**
 * E2e — compaction : snapshots, accuses de lecture, purge des segments,
 * rattrapage d'un appareil nouveau ou revenu apres une longue absence, purge
 * des pierres tombales. Cycle complet (synchro/cycle.js), horloge controlee.
 *
 *     node scripts/lancer-node.js tests/synchro-e2e.test.js [nbScenarios] [graine]
 */

const assert = require('assert/strict');
const path = require('path');
const Database = require('better-sqlite3');

const RACINE = path.resolve(__dirname, '..');
const { SCHEMA_USER } = require(path.join(RACINE, 'src/main/db'));
const moteur = require(path.join(RACINE, 'src/main/synchro/moteur'));
const cycle = require(path.join(RACINE, 'src/main/synchro/cycle'));
const compaction = require(path.join(RACINE, 'src/main/synchro/compaction'));
const { creerHorloge } = require(path.join(RACINE, 'src/main/synchro/hlc'));
const { creerTransportMemoire } = require(path.join(RACINE, 'src/main/synchro/transport-memoire'));

const NB_SCENARIOS = parseInt(process.argv[2] || '150', 10);
const GRAINE = parseInt(process.argv[3] || '20260925', 10);
const JOUR = 86400e3;
const SEUILS = { opsParSnapshot: 15 };   // petit seuil : snapshots frequents en test

let nOk = 0, nKo = 0;
async function test(nom, fn) {
  try { await fn(); nOk++; console.log('  ok  ' + nom); }
  catch (e) { nKo++; console.log('  KO  ' + nom + '\n      ' + String(e.stack || e).split('\n').slice(0, 8).join('\n      ')); }
}

function creerMonde() {
  const monde = { t: Date.parse('2026-09-25T10:00:00Z'), transport: creerTransportMemoire(), appareils: [] };
  monde.avancer = (ms) => { monde.t += Math.floor(ms); };
  monde.appareil = (id, decalage = 0) => {
    const d = new Database(':memory:');
    d.exec(SCHEMA_USER);
    const ctx = { d, appareil: { id, prefixe_ref: 'L' }, horloge: creerHorloge(id, { maintenant: () => monde.t + decalage }) };
    ctx.ecrire = (...a) => moteur.ecrire(ctx, ...a);
    ctx.val = (e, c, ch) => moteur.valeur(ctx, e, c, ch);
    ctx.synchro = () => cycle.executer(ctx, monde.transport, {
      nom: id, enregistrerPrefixe: () => {}, maintenant: () => monde.t + decalage, seuils: SEUILS
    });
    monde.appareils.push(ctx);
    return ctx;
  };
  monde.converger = async (qui = monde.appareils) => {
    for (let tour = 0; tour < 6; tour++) for (const a of qui) await a.synchro();
  };
  return monde;
}

function photo(ctx) {
  const d = ctx.d;
  return {
    etat: d.prepare('SELECT entite, cle, champ, valeur, hlc FROM etat ORDER BY 1, 2, 3').all(),
    locales: d.prepare('SELECT * FROM oeuvres_locales ORDER BY id').all(),
    tags: d.prepare('SELECT * FROM user_tags ORDER BY 1, 2').all(),
    archive: d.prepare('SELECT * FROM user_archive ORDER BY 1').all(),
    overrides: d.prepare('SELECT * FROM user_overrides ORDER BY 1, 2').all(),
    stats: d.prepare('SELECT * FROM user_stats ORDER BY 1, 2').all(),
    conflits: d.prepare(`SELECT entite, cle, champ, hlc_gagnant, valeur_gagnante, hlc_perdant, valeur_perdante
      FROM conflits WHERE resolu=0 ORDER BY 1, 2, 3`).all()
  };
}

function memeEtat(appareils) {
  const [ref, ...autres] = appareils.map(photo);
  for (const [i, p] of autres.entries()) {
    for (const k of Object.keys(ref)) assert.deepEqual(p[k], ref[k], `${appareils[i + 1].appareil.id} diverge sur ${k}`);
  }
  return ref;
}

const segments = async (m, app) => (await m.transport.listerSegments(app)).length;
const fiche = async (m, id) => (await m.transport.lireFiches()).find((f) => f.id === id);
function editer(a, n, prefixe = 'x') {
  for (let i = 0; i < n; i++) a.ecrire('override', 'p:' + (i % 5), 'titre', { valeur: prefixe + i + '-' + a.appareil.id, valeur_source: 'S' });
}

async function scenarios() {
  console.log('scenarios');

  await test('snapshot apres le seuil, annonce dans la fiche ; accuses de lecture publies', async () => {
    const m = creerMonde();
    const A = m.appareil('aaaa0001'), B = m.appareil('bbbb0002');
    editer(A, 20);
    await m.converger();
    const fa = await fiche(m, 'aaaa0001');
    assert.ok(fa.snapshot && fa.snapshot.nom, 'snapshot annonce');
    assert.ok(fa.snapshot.vecteur.aaaa0001, 'vecteur couvre ses propres segments');
    const fb = await fiche(m, 'bbbb0002');
    assert.ok(fb.lu && fb.lu.aaaa0001, 'B accuse avoir lu A');
    memeEtat([A, B]);
  });

  await test('purge : segments lus par tous et couverts par un snapshot supprimes ; un nouveau venu repart du snapshot', async () => {
    const m = creerMonde();
    const A = m.appareil('aaaa0001'), B = m.appareil('bbbb0002');
    for (let k = 0; k < 4; k++) { editer(A, 8, 'k' + k); editer(B, 3, 'k' + k); m.avancer(3600e3); await m.converger(); }
    m.avancer(3600e3);
    await m.converger();
    const purge = (await fiche(m, 'aaaa0001')).purge;
    assert.ok(purge, 'purge annoncee');
    const restants = await m.transport.listerSegments('aaaa0001');
    assert.ok(restants.every((s) => s > purge), 'seuls restent les segments posterieurs a la purge');
    // Nouveau venu : les premiers segments de A n'existent plus.
    const C = m.appareil('cccc0003');
    const r = await C.synchro();
    assert.ok(r.rattrapage && r.rattrapage.snapshot, JSON.stringify(r.rattrapage));
    await m.converger();
    memeEtat([A, B, C]);
  });

  await test('un appareil actif qui n\'a pas lu bloque la purge', async () => {
    const m = creerMonde();
    const A = m.appareil('aaaa0001'), B = m.appareil('bbbb0002');
    await m.converger();
    for (let k = 0; k < 3; k++) { editer(A, 10, 'k' + k); m.avancer(3600e3); await A.synchro(); }
    const r = await A.synchro();
    assert.deepEqual(r.purge.supprimes, [], 'B n\'a encore rien lu');
    assert.ok(r.purge.limite === '' || r.purge.bloquants.length || r.purge.limite, JSON.stringify(r.purge));
    await m.converger();
    memeEtat([A, B]);
  });

  await test('appareil muet plus de 90 jours : ne bloque plus ; a son retour, rattrapage et ses modifs partent', async () => {
    const m = creerMonde();
    const A = m.appareil('aaaa0001'), B = m.appareil('bbbb0002'), C = m.appareil('cccc0003');
    await m.converger();
    C.ecrire('tag', 'p:9', 'livre', 1);           // en attente, C part en voyage
    for (let k = 0; k < 6; k++) {
      editer(A, 6, 'k' + k); editer(B, 2, 'k' + k);
      m.avancer(20 * JOUR);
      await m.converger([A, B]);
    }
    assert.ok((await fiche(m, 'aaaa0001')).purge, 'A a purge sans attendre C');
    const r = await C.synchro();
    assert.ok(r.rattrapage && r.rattrapage.snapshot, 'C repart du snapshot');
    await m.converger();
    memeEtat([A, B, C]);
    assert.equal(A.val('tag', 'p:9', 'livre'), 1, 'la modif de C est arrivee');
  });

  await test('pierre tombale : contenu oublie apres 90 jours partout (la pierre reste) ; avant, restaurable', async () => {
    const m = creerMonde();
    const A = m.appareil('aaaa0001'), B = m.appareil('bbbb0002');
    A.ecrire('locale', 'local:1', '_existe', 1);
    A.ecrire('locale', 'local:1', 'titre', 'Nympheas');
    A.ecrire('tag', 'local:1', 'etoile', 1);
    await m.converger();
    moteur.supprimerLocale(A, 'local:1');
    m.avancer(30 * JOUR);
    await m.converger();
    assert.ok(B.val('locale', 'local:1', 'titre'), 'encore au registre a 30 jours');
    m.avancer(61 * JOUR);
    await m.converger();
    const restes = A.d.prepare("SELECT champ, valeur FROM etat WHERE cle='local:1' AND champ<>'_existe'").all();
    assert.ok(restes.length && restes.every((r) => r.valeur === null), 'contenu vide : ' + JSON.stringify(restes));
    assert.ok(A.val('locale', 'local:1', '_existe').vu, 'pierre tombale gardee');
    assert.equal(A.d.prepare("SELECT COUNT(*) n FROM user_tags WHERE oeuvre_id='local:1'").get().n, 0);
    assert.deepEqual(moteur.conflits(A), [], 'l\'oubli n\'ouvre pas de conflit');
    memeEtat([A, B]);
    assert.match(compaction.purgeeLe(require(path.join(RACINE, 'src/main/synchro/hlc')).formater(Date.parse('2026-01-01T00:00:00Z'), 0, 'a')), /^2026-04-01/);
  });

  await test('au plus 2 snapshots par appareil', async () => {
    const m = creerMonde();
    const A = m.appareil('aaaa0001');
    for (let k = 0; k < 5; k++) { editer(A, 20, 'k' + k); await A.synchro(); }
    const miens = (await m.transport.listerSnapshots()).filter((s) => s.appareil === 'aaaa0001');
    assert.equal(miens.length, 2);
  });

  await test('rattrapage : conflits identiques a ceux des appareils qui ont tout l\'historique', async () => {
    const m = creerMonde();
    const A = m.appareil('aaaa0001'), B = m.appareil('bbbb0002');
    A.ecrire('override', 'p:9', 'titre', { valeur: 'X', valeur_source: 'S' });
    B.ecrire('override', 'p:9', 'titre', { valeur: 'Y', valeur_source: 'S' });
    for (let k = 0; k < 4; k++) { editer(A, 10, 'k' + k); m.avancer(3600e3); await m.converger(); }
    assert.equal(photo(A).conflits.length > 0, true);
    const C = m.appareil('cccc0003');
    await m.converger();
    memeEtat([A, B, C]);
  });
}

// --- propriete -----------------------------------------------------------------

function prng(graine) {
  let s = graine >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pour chaque cle dont le registre differe : registre, journal et conflits de chaque appareil. */
function diagnostic(apps, t) {
  const cles = new Map();
  for (const a of apps) {
    for (const r of a.d.prepare('SELECT entite, cle, champ, valeur, hlc FROM etat').all()) {
      const k = r.entite + '|' + r.cle + '|' + r.champ;
      if (!cles.has(k)) cles.set(k, new Map());
      cles.get(k).set(a.appareil.id, r.hlc + ' ' + r.valeur);
    }
  }
  const lignes = ['      maintenant ' + new Date(t).toISOString()];
  for (const [k, par] of cles) {
    const valeurs = new Set(apps.map((a) => par.get(a.appareil.id) || '-'));
    if (valeurs.size === 1) continue;
    const [entite, cle] = k.split('|');
    lignes.push('      CLE ' + k);
    for (const a of apps) {
      lignes.push('        ' + a.appareil.id + ' etat : ' + (par.get(a.appareil.id) || '-'));
      for (const o of a.d.prepare('SELECT hlc, champ, valeur, base, vus, remplace, pousse FROM changements WHERE entite=? AND cle=? ORDER BY hlc').all(entite, cle)) {
        lignes.push('          ' + o.hlc + ' ' + o.champ + '=' + o.valeur + ' base=' + o.base + (o.vus ? ' vus=' + o.vus : '') + (o.remplace ? ' R' : '') + (o.pousse ? '' : ' (non pousse)'));
      }
      for (const c of a.d.prepare('SELECT champ, hlc_gagnant, hlc_perdant FROM conflits WHERE cle=? AND resolu=0').all(cle)) {
        lignes.push('          conflit ' + c.champ + ' ' + c.hlc_gagnant + ' / ' + c.hlc_perdant);
      }
    }
    if (lignes.length > 60) break;
  }
  return lignes.join('\n');
}

async function scenarioAleatoire(graine, nbActions) {
  const alea = prng(graine);
  const choix = (t) => t[Math.floor(alea() * t.length)];
  const m = creerMonde();
  const ids = ['aaaa0001', 'bbbb0002', 'cccc0003', 'dddd0004'];
  const apps = ids.slice(0, 2).map((id) => m.appareil(id, Math.round((alea() - 0.5) * 4000)));
  const journalActions = [];
  let n = 0;
  const vivantes = (a, v) => a.d.prepare("SELECT cle, valeur FROM etat WHERE entite='locale' AND champ='_existe'").all()
    .filter((r) => (JSON.parse(r.valeur) === 1) === v).map((r) => r.cle);

  for (let i = 0; i < nbActions; i++) {
    const r = alea();
    // Un nouvel appareil arrive en cours de route.
    if (apps.length < ids.length && r < 0.03) {
      apps.push(m.appareil(ids[apps.length], Math.round((alea() - 0.5) * 4000)));
      journalActions.push('+ ' + ids[apps.length - 1]);
      continue;
    }
    const a = choix(apps);
    let act;
    if (r < 0.10) {
      const id = 'local:' + a.appareil.id + '-' + (++n);
      a.ecrire('locale', id, '_existe', 1);
      a.ecrire('locale', id, 'titre', choix(['A', 'B', 'C']));
      act = 'creer ' + id;
    } else if (r < 0.30) {
      const t = vivantes(a, true);
      if (!t.length) continue;
      const id = choix(t);
      a.ecrire('locale', id, choix(['titre', 'lieu']), choix(['A', 'B', 'C', null]));
      act = 'editer ' + id;
    } else if (r < 0.35) {
      const t = vivantes(a, true);
      if (!t.length) continue;
      moteur.supprimerLocale(a, choix(t));
      act = 'supprimer';
    } else if (r < 0.37) {
      const t = vivantes(a, false);
      if (!t.length) continue;
      a.ecrire('locale', choix(t), '_existe', 1);
      act = 'restaurer';
    } else if (r < 0.50) {
      const id = choix(['p:1', 'p:2', 'p:3']), tag = choix(moteur.TAGS);
      a.ecrire('tag', id, tag, a.val('tag', id, tag) ? null : 1);
      act = 'tag';
    } else if (r < 0.60) {
      a.ecrire('override', choix(['p:1', 'p:2', 'p:3']), 'titre', { valeur: choix(['A', 'B', 'C']), valeur_source: 'S' });
      act = 'override';
    } else if (r < 0.63) {
      const cs = moteur.conflits(a);
      if (!cs.length) continue;
      moteur.resoudre(a, choix(cs).id, choix(['gagnant', 'perdant']));
      act = 'resoudre';
    } else {
      await a.synchro();
      act = 'synchro';
    }
    journalActions.push(a.appareil.id.slice(0, 1) + ' ' + act);
    // Le temps passe : de quelques minutes a plusieurs semaines (absences, purges).
    const saut = alea();
    m.avancer(saut < 0.8 ? alea() * 3 * 3600e3 : saut < 0.97 ? alea() * 10 * JOUR : alea() * 60 * JOUR);
  }
  await m.converger(apps);
  try {
    const p = memeEtat(apps);
    // Un appareil tranche tout : plus aucun conflit nulle part.
    const juge = choix(apps);
    for (let tour = 0; tour < 20 && moteur.conflits(juge).length; tour++) {
      for (const c of moteur.conflits(juge)) moteur.resoudre(juge, c.id, choix(['gagnant', 'perdant']));
    }
    await m.converger(apps);
    assert.deepEqual(memeEtat(apps).conflits, [], 'conflits restes ouverts apres resolution');
    return p;
  } catch (e) {
    e.message += '\n      graine ' + graine + '\n' + diagnostic(apps, m.t) + '\n      actions :\n        ' + journalActions.slice(-60).join('\n        ');
    throw e;
  }
}

async function propriete() {
  console.log(`propriete : ${NB_SCENARIOS} scenarios, 2 a 4 appareils, arrivees et absences (graine ${GRAINE})`);
  let echecs = 0;
  const stats = { conflits: 0 };
  const t0 = Date.now();
  for (let s = 0; s < NB_SCENARIOS; s++) {
    try { stats.conflits += (await scenarioAleatoire(GRAINE + s, 60 + (s % 4) * 40)).conflits.length; }
    catch (e) { if (echecs++ < 1) console.log('  KO  ' + String(e.message).split('\n').slice(0, 60).join('\n')); }
  }
  if (echecs) { nKo++; console.log(`  KO  ${echecs}/${NB_SCENARIOS} scenarios divergent`); }
  else { nOk++; console.log(`  ok  ${NB_SCENARIOS} scenarios convergent (${stats.conflits} conflits ouverts, ${Date.now() - t0} ms)`); }
}

(async () => {
  await scenarios();
  await propriete();
  console.log(`\n${nOk} ok, ${nKo} KO`);
  process.exit(nKo ? 1 : 0);
})();
