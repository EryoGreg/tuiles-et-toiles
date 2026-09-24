'use strict';
/**
 * E2b — moteur de fusion : scenarios cibles + test de propriete.
 *
 *     node scripts/lancer-node.js tests/synchro-e2b.test.js [nbScenarios] [graine]
 *
 * TT_TRANSPORT=dossier : meme suite sur le transport dossier (disque, E2c).
 * TT_TRANSPORT=drive   : meme suite sur le transport Drive (faux Drive en memoire, E2d).
 *
 * Plusieurs appareils dans un meme processus, chacun sur sa base en memoire,
 * relies par un transport memoire. Propriete verifiee : quelles que soient les
 * ecritures et l'ordre des synchros, une fois que tout le monde a pousse et
 * tire, tous les appareils ont le meme registre, les memes tables projetees et
 * les memes conflits ouverts.
 */

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const RACINE = path.resolve(__dirname, '..');
const { SCHEMA_USER } = require(path.join(RACINE, 'src/main/db'));
const moteur = require(path.join(RACINE, 'src/main/synchro/moteur'));
const echange = require(path.join(RACINE, 'src/main/synchro/echange'));
const { creerHorloge, formater } = require(path.join(RACINE, 'src/main/synchro/hlc'));
const { creerTransportMemoire } = require(path.join(RACINE, 'src/main/synchro/transport-memoire'));
const { creerTransportDossier } = require(path.join(RACINE, 'src/main/synchro/transport-dossier'));

const { creerTransportDrive } = require(path.join(RACINE, 'src/main/synchro/transport-drive'));
const { creerFauxDrive } = require('./faux-drive');

const TRANSPORT = process.env.TT_TRANSPORT || 'memoire';
const SUR_DISQUE = TRANSPORT === 'dossier';
const TMP = SUR_DISQUE ? fs.mkdtempSync(path.join(os.tmpdir(), 'tt-e2b-')) : null;
let nMondes = 0;
/** Un « espace partage » par monde ; chaque appareil y accede par SON transport. */
function creerEspace() {
  if (TRANSPORT === 'drive') {
    const faux = creerFauxDrive();
    return () => creerTransportDrive(faux);
  }
  if (SUR_DISQUE) {
    const racine = path.join(TMP, String(++nMondes));
    return () => creerTransportDossier(racine);
  }
  const t = creerTransportMemoire();
  return () => t;
}

const NB_SCENARIOS = parseInt(process.argv[2] || '400', 10);
const GRAINE = parseInt(process.argv[3] || '20260924', 10);

let nOk = 0, nKo = 0;
async function test(nom, fn) {
  try { await fn(); nOk++; console.log('  ok  ' + nom); }
  catch (e) { nKo++; console.log('  KO  ' + nom + '\n      ' + String(e.stack || e).split('\n').slice(0, 6).join('\n      ')); }
}

// --- monde de test ------------------------------------------------------------

/** Horloge murale partagee ; chaque appareil a son decalage (horloge du telephone). */
function creerMonde() {
  const espace = creerEspace();
  const monde = { t: Date.parse('2026-09-24T10:00:00Z'), transport: espace(), appareils: [] };
  monde.avancer = (ms) => { monde.t += ms; };
  monde.appareil = (id, decalage = 0) => {
    const d = new Database(':memory:');
    d.exec(SCHEMA_USER);
    const a = { id, prefixe_ref: 'L' };
    const ctx = { d, appareil: a, horloge: creerHorloge(id, { maintenant: () => monde.t + decalage }) };
    const t = espace();
    ctx.pousser = () => echange.pousser(ctx, t);
    ctx.tirer = () => echange.tirer(ctx, t);
    ctx.ecrire = (...args) => moteur.ecrire(ctx, ...args);
    ctx.val = (e, c, ch) => moteur.valeur(ctx, e, c, ch);
    ctx.conflits = () => moteur.conflits(ctx);
    monde.appareils.push(ctx);
    return ctx;
  };
  /** Tout le monde pousse puis tire, jusqu'a ce que plus rien ne bouge. */
  monde.converger = async () => {
    for (let tour = 0; tour < 10; tour++) {
      let bouge = 0;
      for (const a of monde.appareils) bouge += (await a.pousser()).poussees;
      for (const a of monde.appareils) bouge += (await a.tirer()).appliquees;
      for (const a of monde.appareils) bouge += (await a.pousser()).poussees;
      if (!bouge) return;
    }
    throw new Error('pas de convergence en 10 tours');
  };
  return monde;
}

function photo(ctx) {
  const d = ctx.d;
  return {
    etat: d.prepare('SELECT entite, cle, champ, valeur, hlc, base FROM etat ORDER BY 1, 2, 3').all(),
    journal: d.prepare('SELECT hlc, entite, cle, champ, valeur, base, vus FROM changements ORDER BY hlc').all(),
    locales: d.prepare('SELECT * FROM oeuvres_locales ORDER BY id').all(),
    tags: d.prepare('SELECT * FROM user_tags ORDER BY 1, 2').all(),
    archive: d.prepare('SELECT * FROM user_archive ORDER BY 1').all(),
    overrides: d.prepare('SELECT * FROM user_overrides ORDER BY 1, 2').all(),
    stats: d.prepare('SELECT * FROM user_stats ORDER BY 1, 2').all(),
    conflits: d.prepare(`SELECT entite, cle, champ, hlc_gagnant, valeur_gagnante, hlc_perdant, valeur_perdante
      FROM conflits WHERE resolu=0 ORDER BY 1, 2, 3`).all()
  };
}

function memeEtat(monde) {
  const [ref, ...autres] = monde.appareils.map(photo);
  for (const [i, p] of autres.entries()) {
    for (const k of Object.keys(ref)) {
      assert.deepEqual(p[k], ref[k], `appareil ${monde.appareils[i + 1].appareil.id} diverge sur ${k}`);
    }
  }
  return ref;
}

const creerTuile = (a, id, titre) => {
  a.ecrire('locale', id, '_existe', 1);
  a.ecrire('locale', id, 'titre', titre);
};

// --- scenarios cibles ---------------------------------------------------------

async function scenarios() {
  console.log('scenarios');

  await test('avance simple dans les deux sens : aucun conflit', async () => {
    const m = creerMonde();
    const A = m.appareil('aaaa0001'), B = m.appareil('bbbb0002');
    creerTuile(A, 'local:1', 'Nympheas');
    await m.converger();
    assert.equal(B.val('locale', 'local:1', 'titre'), 'Nympheas');
    m.avancer(1000);
    B.ecrire('locale', 'local:1', 'titre', 'Nympheas, salle 3');
    await m.converger();
    assert.equal(A.val('locale', 'local:1', 'titre'), 'Nympheas, salle 3');
    assert.deepEqual(A.conflits(), []);
    memeEtat(m);
  });

  await test('modification concurrente : meme gagnant (plus grande HLC), meme conflit des deux cotes', async () => {
    const m = creerMonde();
    const A = m.appareil('aaaa0001'), B = m.appareil('bbbb0002');
    A.ecrire('override', 'p:1', 'titre', { valeur: 'Portrait de Lisa Gherardini', valeur_source: 'La Joconde' });
    m.avancer(1000);
    B.ecrire('override', 'p:1', 'titre', { valeur: 'La Joconde (Mona Lisa)', valeur_source: 'La Joconde' });
    await m.converger();
    const p = memeEtat(m);
    assert.equal(A.val('override', 'p:1', 'titre').valeur, 'La Joconde (Mona Lisa)');
    assert.equal(p.conflits.length, 1);
    assert.equal(JSON.parse(p.conflits[0].valeur_perdante).valeur, 'Portrait de Lisa Gherardini');
  });

  await test('meme valeur des deux cotes : pas de conflit', async () => {
    const m = creerMonde();
    const A = m.appareil('aaaa0001'), B = m.appareil('bbbb0002');
    A.ecrire('override', 'p:1', 'lieu', { valeur: 'Louvre', valeur_source: '' });
    B.ecrire('override', 'p:1', 'lieu', { valeur: 'Louvre', valeur_source: '' });
    await m.converger();
    assert.deepEqual(memeEtat(m).conflits, []);
  });

  await test('resolution d\'un cote (garder le perdant) : conflit ferme et valeur propagee partout', async () => {
    const m = creerMonde();
    const A = m.appareil('aaaa0001'), B = m.appareil('bbbb0002');
    A.ecrire('override', 'p:1', 'titre', { valeur: 'X', valeur_source: 'S' });
    m.avancer(10);
    B.ecrire('override', 'p:1', 'titre', { valeur: 'Y', valeur_source: 'S' });
    await m.converger();
    const [c] = A.conflits();
    moteur.resoudre(A, c.id, 'perdant');
    assert.deepEqual(A.conflits(), []);
    await m.converger();
    assert.deepEqual(B.conflits(), []);
    assert.equal(B.val('override', 'p:1', 'titre').valeur, 'X');
    memeEtat(m);
  });

  await test('resolution en gardant le gagnant : op forcee, conflit ferme chez l\'autre aussi', async () => {
    const m = creerMonde();
    const A = m.appareil('aaaa0001'), B = m.appareil('bbbb0002');
    creerTuile(A, 'local:1', 'depart');
    await m.converger();
    A.ecrire('locale', 'local:1', 'titre', 'X');
    m.avancer(10);
    B.ecrire('locale', 'local:1', 'titre', 'Y');
    await m.converger();
    moteur.resoudre(B, B.conflits()[0].id, 'gagnant');
    await m.converger();
    assert.deepEqual(A.conflits(), []);
    assert.equal(A.val('locale', 'local:1', 'titre'), 'Y');
  });

  await test('une simple edition apres le conflit le ferme (elle a vu le gagnant)', async () => {
    const m = creerMonde();
    const A = m.appareil('aaaa0001'), B = m.appareil('bbbb0002');
    creerTuile(A, 'local:1', 'depart');
    await m.converger();
    A.ecrire('locale', 'local:1', 'titre', 'X');
    B.ecrire('locale', 'local:1', 'titre', 'Y');
    await m.converger();
    assert.equal(A.conflits().length, 1);
    A.ecrire('locale', 'local:1', 'titre', 'Z');
    await m.converger();
    assert.deepEqual(memeEtat(m).conflits, []);
  });

  await test('supprimee ici, modifiee la-bas : suppression gagne, conflit des deux cotes, restauration propagee', async () => {
    const m = creerMonde();
    const A = m.appareil('aaaa0001'), B = m.appareil('bbbb0002');
    creerTuile(A, 'local:1', 'Nympheas');
    await m.converger();
    m.avancer(1000);
    moteur.supprimerLocale(A, 'local:1');          // PC
    m.avancer(1000);
    B.ecrire('locale', 'local:1', 'lieu', 'Orangerie');   // telephone, hors ligne
    await m.converger();
    const p = memeEtat(m);
    assert.equal(p.locales.length, 0, 'suppression gagne par defaut');
    assert.equal(p.conflits.length, 1);
    assert.equal(p.conflits[0].champ, '_existe');
    moteur.resoudre(B, B.conflits()[0].id, 'perdant');   // restaurer
    await m.converger();
    const q = memeEtat(m);
    assert.equal(q.locales.length, 1);
    assert.equal(q.locales[0].lieu, 'Orangerie');
    assert.equal(q.locales[0].titre, 'Nympheas');
    assert.deepEqual(q.conflits, []);
  });

  await test('confirmer la suppression ferme le conflit partout', async () => {
    const m = creerMonde();
    const A = m.appareil('aaaa0001'), B = m.appareil('bbbb0002');
    creerTuile(A, 'local:1', 'Nympheas');
    await m.converger();
    moteur.supprimerLocale(A, 'local:1');
    B.ecrire('locale', 'local:1', 'lieu', 'Orangerie');
    await m.converger();
    moteur.resoudre(A, A.conflits()[0].id, 'gagnant');
    await m.converger();
    const p = memeEtat(m);
    assert.equal(p.locales.length, 0);
    assert.deepEqual(p.conflits, []);
  });

  await test('suppression faite en ayant vu les modifications : pas de conflit', async () => {
    const m = creerMonde();
    const A = m.appareil('aaaa0001'), B = m.appareil('bbbb0002');
    creerTuile(A, 'local:1', 'Nympheas');
    await m.converger();
    B.ecrire('locale', 'local:1', 'lieu', 'Orangerie');
    await m.converger();
    moteur.supprimerLocale(A, 'local:1');
    await m.converger();
    assert.deepEqual(memeEtat(m).conflits, []);
  });

  await test('chaine A -> B -> C tiree d\'un coup par C : pas de faux conflit', async () => {
    const m = creerMonde();
    const A = m.appareil('aaaa0001'), B = m.appareil('bbbb0002'), C = m.appareil('cccc0003');
    A.ecrire('locale', 'local:1', 'titre', 'v1');
    await A.pousser(); await B.tirer();
    B.ecrire('locale', 'local:1', 'titre', 'v2');
    await B.pousser();
    await C.tirer();
    assert.equal(C.val('locale', 'local:1', 'titre'), 'v2');
    assert.deepEqual(C.conflits(), []);
  });

  await test('C recoit B avant A (A pas encore visible) puis A : A ignoree, pas de conflit', async () => {
    const m = creerMonde();
    const A = m.appareil('aaaa0001'), B = m.appareil('bbbb0002'), C = m.appareil('cccc0003');
    A.ecrire('locale', 'local:1', 'titre', 'v1');
    const [opA] = A.d.prepare('SELECT * FROM changements').all();
    // B recoit A par un autre chemin (test direct du moteur), ecrit par-dessus.
    B.d.transaction(() => moteur.appliquer(B, opA))();
    B.ecrire('locale', 'local:1', 'titre', 'v2');
    await B.pousser(); await C.tirer();
    await A.pousser(); const r = await C.tirer();
    assert.equal(r.bilan.ignoree, 1);
    assert.equal(C.val('locale', 'local:1', 'titre'), 'v2');
    assert.deepEqual(C.conflits(), []);
  });

  await test('tags ajoutes / retires en concurrence : convergent, jamais de conflit', async () => {
    const m = creerMonde();
    const A = m.appareil('aaaa0001'), B = m.appareil('bbbb0002');
    A.ecrire('tag', 'p:1', 'etoile', 1);
    await m.converger();
    A.ecrire('tag', 'p:1', 'etoile', null);     // A retire
    m.avancer(5);
    B.ecrire('tag', 'p:1', 'etoile', null);     // B retire aussi…
    m.avancer(5);
    B.ecrire('tag', 'p:1', 'etoile', 1);        // …puis remet (plus tard) : gagne
    B.ecrire('tag', 'p:1', 'livre', 1);
    A.ecrire('tag', 'p:1', 'livre', 1);         // meme ajout des deux cotes
    await m.converger();
    const p = memeEtat(m);
    assert.deepEqual(p.conflits, []);
    assert.deepEqual(p.tags.map((t) => t.tag).sort(), ['etoile', 'livre']);
  });

  await test('idempotence : retirer deux fois, segment renvoye deux fois', async () => {
    const m = creerMonde();
    const A = m.appareil('aaaa0001'), B = m.appareil('bbbb0002');
    A.ecrire('tag', 'p:1', 'etoile', 1);
    const ops = A.d.prepare('SELECT hlc, appareil, entite, cle, champ, valeur, base, vus FROM changements').all();
    await A.pousser();
    // envoi interrompu puis refait avec une op de plus : segment qui recouvre le premier
    A.ecrire('tag', 'p:1', 'livre', 1);
    const tout = A.d.prepare('SELECT hlc, appareil, entite, cle, champ, valeur, base, vus FROM changements ORDER BY hlc').all();
    await m.transport.ecrireSegment('aaaa0001', ops[0].hlc + '_' + tout[1].hlc, tout);
    const r1 = await B.tirer();
    const r2 = await B.tirer();
    assert.equal(r1.appliquees, 2);
    assert.equal(r1.bilan.connue, 1);
    assert.equal(r2.appliquees, 0);
  });

  await test('op mal formee : rejetee partout, le reste passe', async () => {
    const m = creerMonde();
    const B = m.appareil('bbbb0002');
    const h = (n) => formater(m.t, n, 'ffff0009');
    await m.transport.ecrireSegment('ffff0009', h(0) + '_' + h(2), [
      { hlc: h(0), appareil: 'ffff0009', entite: 'virus', cle: 'x', champ: 'y', valeur: '1', base: null },
      { hlc: h(1), appareil: 'ffff0009', entite: 'tag', cle: 'p:1', champ: 'pas_un_tag', valeur: '1', base: null },
      { hlc: h(2), appareil: 'ffff0009', entite: 'tag', cle: 'p:1', champ: 'etoile', valeur: '1', base: null }
    ]);
    const r = await B.tirer();
    assert.equal(r.rejetees, 2);
    assert.equal(r.appliquees, 1);
  });

  await test('horloge du telephone 10 min en retard : son edition posterieure gagne quand meme', async () => {
    const m = creerMonde();
    const A = m.appareil('aaaa0001'), B = m.appareil('bbbb0002', -10 * 60e3);
    A.ecrire('locale', 'local:1', 'titre', 'PC');
    await m.converger();
    B.ecrire('locale', 'local:1', 'titre', 'telephone');   // B a vu l'op de A
    await m.converger();
    assert.equal(A.val('locale', 'local:1', 'titre'), 'telephone');
    assert.deepEqual(A.conflits(), []);
  });

  await test('horloge distante 2 jours dans le futur : tirage refuse, rien applique, curseurs intacts', async () => {
    const m = creerMonde();
    const A = m.appareil('aaaa0001'), B = m.appareil('bbbb0002', 2 * 86400e3);
    A.ecrire('tag', 'p:1', 'livre', 1);
    await A.pousser();
    B.ecrire('tag', 'p:1', 'etoile', 1);
    await B.pousser();
    await assert.rejects(() => A.tirer(), /trop en avance/);
    assert.equal(A.d.prepare("SELECT COUNT(*) n FROM sync WHERE cle LIKE 'curseur:%'").get().n, 0);
    assert.equal(A.d.prepare('SELECT COUNT(*) n FROM changements').get().n, 1);
  });

  await test('ecriture locale pendant un envoi : reste a pousser', async () => {
    const m = creerMonde();
    const A = m.appareil('aaaa0001');
    A.ecrire('tag', 'p:1', 'livre', 1);
    const envoi = A.pousser();
    A.ecrire('tag', 'p:1', 'etoile', 1);   // arrive pendant l'await
    await envoi;
    assert.equal(A.d.prepare('SELECT COUNT(*) n FROM changements WHERE pousse=0').get().n, 1);
  });
}

// --- test de propriete --------------------------------------------------------

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

async function scenarioAleatoire(graine, nbActions) {
  const alea = prng(graine);
  const choix = (t) => t[Math.floor(alea() * t.length)];
  const m = creerMonde();
  const apps = ['aaaa0001', 'bbbb0002', 'cccc0003']
    .map((id) => m.appareil(id, Math.round((alea() - 0.5) * 4000)));
  const PACK = ['p:1', 'p:2', 'p:3'];
  const VALEURS = ['A', 'B', 'C', ''];
  const journalActions = [];
  let n = 0;

  const locales = (a, vivante) => a.d.prepare(
    "SELECT cle, valeur FROM etat WHERE entite='locale' AND champ='_existe'").all()
    .filter((r) => (JSON.parse(r.valeur) === 1) === vivante).map((r) => r.cle);

  for (let i = 0; i < nbActions; i++) {
    const a = choix(apps);
    const r = alea();
    let act;
    if (r < 0.08) {
      const id = 'local:' + a.appareil.id + '-' + (++n);
      creerTuile(a, id, choix(VALEURS) || 'sans titre');
      act = 'creer ' + id;
    } else if (r < 0.30) {
      const t = locales(a, true);
      if (!t.length) continue;
      const id = choix(t), ch = choix(['titre', 'lieu']), v = choix(VALEURS);
      a.ecrire('locale', id, ch, v || null);
      act = `editer ${id}.${ch}=${v}`;
    } else if (r < 0.36) {
      const t = locales(a, true);
      if (!t.length) continue;
      const id = choix(t);
      moteur.supprimerLocale(a, id);
      act = 'supprimer ' + id;
    } else if (r < 0.39) {
      const t = locales(a, false);
      if (!t.length) continue;
      const id = choix(t);
      a.ecrire('locale', id, '_existe', 1);
      act = 'restaurer ' + id;
    } else if (r < 0.50) {
      const id = choix([...PACK, ...locales(a, true)]), tag = choix(moteur.TAGS);
      a.ecrire('tag', id, tag, a.val('tag', id, tag) ? null : 1);
      act = `tag ${id}.${tag}`;
    } else if (r < 0.60) {
      const id = choix(PACK), v = choix(VALEURS);
      a.ecrire('override', id, 'titre', v ? { valeur: v, valeur_source: 'pack' } : null);
      act = `override ${id}=${v}`;
    } else if (r < 0.64) {
      const id = choix(PACK);
      a.ecrire('archive', id, '_', a.val('archive', id, '_') ? null : 1);
      act = 'archive ' + id;
    } else if (r < 0.66) {
      // Tirages comptes localement, emis en ops 'stat' avant l'envoi.
      const id = choix(PACK);
      a.d.prepare(`INSERT INTO user_stats (oeuvre_id, appareil, vues, dernier_vu) VALUES (?, ?, 1, ?)
        ON CONFLICT(oeuvre_id, appareil) DO UPDATE SET vues = vues + 1, dernier_vu = excluded.dernier_vu`)
        .run(id, a.appareil.id, new Date(m.t).toISOString());
      moteur.emettreStats(a);
      act = 'vue ' + id;
    } else if (r < 0.68) {
      const cs = a.conflits();
      if (!cs.length) continue;
      const c = choix(cs), ch = choix(['gagnant', 'perdant']);
      moteur.resoudre(a, c.id, ch);
      act = `resoudre ${c.cle}.${c.champ} ${ch}`;
    } else if (r < 0.82) {
      await a.pousser();
      act = 'pousser';
    } else {
      await a.tirer();
      act = 'tirer';
    }
    journalActions.push(a.appareil.id.slice(0, 1) + ' ' + act);
    m.avancer(Math.floor(alea() * 3000));
  }

  await m.converger();
  try {
    const p = memeEtat(m);
    // Un seul appareil tranche tout : plus aucun conflit nulle part.
    // (Restaurer une tuile peut faire reapparaitre ses conflits de champ.)
    const juge = choix(apps);
    for (let tour = 0; tour < 20 && juge.conflits().length; tour++) {
      for (const c of juge.conflits()) moteur.resoudre(juge, c.id, choix(['gagnant', 'perdant']));
    }
    await m.converger();
    assert.deepEqual(memeEtat(m).conflits, [], 'conflits restes ouverts apres resolution');
    return p;
  } catch (e) {
    e.message += '\n      graine ' + graine + ' — actions :\n        ' + journalActions.join('\n        ');
    throw e;
  }
}

async function propriete() {
  console.log(`propriete : ${NB_SCENARIOS} scenarios x 3 appareils (graine ${GRAINE}, transport ${TRANSPORT})`);
  const stats = { conflits: 0, locales: 0, ops: 0 };
  let echecs = 0;
  const t0 = Date.now();
  for (let s = 0; s < NB_SCENARIOS; s++) {
    try {
      const p = await scenarioAleatoire(GRAINE + s, 40 + (s % 5) * 30);
      stats.conflits += p.conflits.length;
      stats.locales += p.locales.length;
      stats.ops += p.journal.length;
    } catch (e) {
      if (echecs++ < 1) console.log('  KO  ' + String(e.message).split('\n').slice(0, 60).join('\n'));
    }
  }
  if (echecs) { nKo++; console.log(`  KO  ${echecs}/${NB_SCENARIOS} scenarios divergent`); }
  else {
    nOk++;
    console.log(`  ok  ${NB_SCENARIOS} scenarios convergent (${stats.ops} ops, ${stats.conflits} conflits ouverts, `
      + `${stats.locales} tuiles vivantes au total, ${Date.now() - t0} ms)`);
  }
}

(async () => {
  await scenarios();
  await propriete();
  if (TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* verrou */ } }
  console.log(`\n${nOk} ok, ${nKo} KO`);
  process.exit(nKo ? 1 : 0);
})();
