'use strict';
/**
 * Qui est qui : entree d'un appareil neuf, decision « remplace-t-il un
 * autre ? », remplacement (nom et lettre repris, ancien retire, numerotation a
 * la suite), reprise automatique par empreinte materielle, ancien appareil qui
 * revient (supplante), fiche qui fait foi pour la lettre. Cycle complet
 * (synchro/cycle.js) sur un transport en memoire, horloge controlee.
 *
 *     node scripts/lancer-node.js tests/synchro-remplacement.test.js [nbScenarios] [graine]
 */

const assert = require('assert/strict');
const path = require('path');
const Database = require('better-sqlite3');

const RACINE = path.resolve(__dirname, '..');
const { SCHEMA_USER } = require(path.join(RACINE, 'src/main/db'));
const moteur = require(path.join(RACINE, 'src/main/synchro/moteur'));
const cycle = require(path.join(RACINE, 'src/main/synchro/cycle'));
const compaction = require(path.join(RACINE, 'src/main/synchro/compaction'));
const { plusGrandNumero, candidats, DecisionRequise } = require(path.join(RACINE, 'src/main/synchro/rejoindre'));
const { creerHorloge } = require(path.join(RACINE, 'src/main/synchro/hlc'));
const { creerTransportMemoire } = require(path.join(RACINE, 'src/main/synchro/transport-memoire'));
const { nomPour } = require(path.join(RACINE, 'src/main/synchro/noms'));

const NB_SCENARIOS = parseInt(process.argv[2] || '60', 10);
const GRAINE = parseInt(process.argv[3] || '20261002', 10);
const HEURE = 3600e3;
const JOUR = 24 * HEURE;

let nOk = 0, nKo = 0;
async function test(nom, fn) {
  try { await fn(); nOk++; console.log('  ok  ' + nom); }
  catch (e) { nKo++; console.log('  KO  ' + nom + '\n      ' + String(e.stack || e).split('\n').slice(0, 8).join('\n      ')); }
}

// --- monde de test ------------------------------------------------------------

function creerMonde() {
  const monde = { t: Date.parse('2026-10-01T10:00:00Z'), transport: creerTransportMemoire(), appareils: [] };
  monde.avancer = (ms) => { monde.t += Math.floor(ms); };
  /**
   * Un appareil : identite comme appareil.json (nom memorable, type, empreinte).
   * `enregistre` compte les sauvegardes demandees par la synchro.
   */
  monde.appareil = (id, { materiel = null, type = 'Android', nom, nomPerso = false } = {}) => {
    const d = new Database(':memory:');
    d.exec(SCHEMA_USER);
    const a = { id, prefixe_ref: 'L', nom: nom || nomPour(id), type, materiel, ...(nomPerso ? { nom_perso: true } : {}) };
    const ctx = { d, appareil: a, horloge: creerHorloge(id, { maintenant: () => monde.t }), enregistre: [] };
    ctx.val = (e, c, ch) => moteur.valeur(ctx, e, c, ch);
    ctx.synchro = () => cycle.executer(ctx, monde.transport, {
      nom: a.nom, type: a.type, materiel: a.materiel, exigerDecision: true,
      enregistrerPrefixe: (p) => ctx.enregistre.push('prefixe:' + p),
      enregistrerAppareil: () => ctx.enregistre.push('appareil'),
      maintenant: () => monde.t
    });
    /** Cree une tuile comme edition.creer : numero = plus grand connu pour sa lettre + 1. */
    ctx.creer = (titre) => {
      const cle = 'local:' + id + '-' + (++ctx.n);
      const ref = a.prefixe_ref + (plusGrandNumero(ctx, a.prefixe_ref) + 1);
      d.transaction(() => {
        moteur.ecrire(ctx, 'locale', cle, '_existe', 1);
        moteur.ecrire(ctx, 'locale', cle, 'ref_local', ref);
        moteur.ecrire(ctx, 'locale', cle, 'titre', titre);
      })();
      return { cle, ref };
    };
    ctx.n = 0;
    ctx.ref = (cle) => moteur.valeur(ctx, 'locale', cle, 'ref_local');
    monde.appareils.push(ctx);
    return ctx;
  };
  monde.converger = async (qui) => {
    for (let tour = 0; tour < 4; tour++) for (const a of qui) await a.synchro();
  };
  return monde;
}

const fiche = async (m, id) => (await m.transport.lireFiches()).find((f) => f.id === id);
const refs = (ctx) => ctx.d.prepare('SELECT ref_local FROM oeuvres_locales ORDER BY ref_local').all().map((r) => r.ref_local);
const etatDe = (ctx) => ctx.d.prepare('SELECT entite, cle, champ, valeur FROM etat WHERE entite<>\'stat\' ORDER BY 1, 2, 3').all();

async function attendreDecision(promesse) {
  try { await promesse; } catch (e) { if (e instanceof DecisionRequise) return e; throw e; }
  throw new Error('DecisionRequise attendue');
}

/** Monde de depart : PC (L) et ancien telephone (M) avec 3 tuiles, puis le telephone se tait. */
async function departAvecAncienTelephone() {
  const m = creerMonde();
  const pc = m.appareil('aaaa0001', { type: 'Windows · POSTE', materiel: 'pc-1' });
  await pc.synchro();
  const vieux = m.appareil('bbbb0002', { type: 'Android · Samsung SM-G998B', materiel: 'tel-1' });
  vieux.appareil.remplace = 'aucun';
  await vieux.synchro();
  for (let i = 1; i <= 3; i++) vieux.creer('Tuile du vieux telephone ' + i);
  pc.creer('Tuile du PC');
  await m.converger([pc, vieux]);
  m.avancer(5 * JOUR);   // le vieux telephone se tait (perdu, reinitialise)
  return { m, pc, vieux };
}

// --- scenarios --------------------------------------------------------------------

async function scenarios() {
  console.log('entree d\'un appareil');

  await test('premier appareil seul : aucune decision, garde L, inscrit', async () => {
    const m = creerMonde();
    const a = m.appareil('aaaa0001');
    const r = await a.synchro();
    assert.equal(r.rejoindre.prefixe, 'L');
    assert.equal(a.appareil.inscrit, true);
    assert.ok(a.enregistre.includes('appareil'));
  });

  await test('appareil neuf, d\'autres existent : DecisionRequise, RIEN ecrit sur le Drive', async () => {
    const { m, pc } = await departAvecAncienTelephone();
    const neuf = m.appareil('cccc0003', { materiel: 'tel-2' });
    neuf.creer('Faite avant de se connecter');
    const avant = m.transport.taille();
    const e = await attendreDecision(neuf.synchro());
    assert.deepEqual(e.candidats.map((c) => c.id).sort(), ['aaaa0001', 'bbbb0002']);
    assert.equal(await fiche(m, 'cccc0003'), undefined, 'pas de fiche');
    assert.equal(m.transport.taille(), avant, 'pas de segment');
    assert.equal(neuf.appareil.inscrit, undefined);
    assert.equal(neuf.appareil.prefixe_ref, 'L');
    assert.equal(neuf.d.prepare('SELECT COUNT(*) n FROM changements WHERE pousse=0').get().n > 0, true, 'rien n\'est parti');
    void pc;
  });

  await test('candidats : nom, type, lettre ; les muets d\'abord, les recents marques', async () => {
    const { m, pc, vieux } = await departAvecAncienTelephone();
    await pc.synchro();   // le PC reste actif
    const e = await attendreDecision(m.appareil('cccc0003').synchro());
    assert.equal(e.candidats[0].id, vieux.appareil.id, 'le muet en premier');
    assert.equal(e.candidats[0].nom, vieux.appareil.nom);
    assert.equal(e.candidats[0].type, 'Android · Samsung SM-G998B');
    assert.equal(e.candidats[0].prefixe, 'M');
    assert.equal(e.candidats[0].recent, false);
    assert.equal(e.candidats[1].id, 'aaaa0001');
    assert.equal(e.candidats[1].recent, true);
  });

  await test('decision « nouvel appareil » : lettre libre (N), renumerotation de ses tuiles', async () => {
    const { m } = await departAvecAncienTelephone();
    const neuf = m.appareil('cccc0003');
    const t = neuf.creer('Avant connexion');
    await attendreDecision(neuf.synchro());
    neuf.appareil.remplace = 'aucun';
    const r = await neuf.synchro();
    assert.equal(r.rejoindre.prefixe, 'N');
    assert.equal(r.rejoindre.remplacement, undefined);
    assert.equal(neuf.ref(t.cle), 'N1');
    assert.ok(neuf.enregistre.includes('prefixe:N'));
  });

  console.log('remplacement choisi');

  await test('reprend le nom et la lettre de l\'ancien ; l\'ancien est retire', async () => {
    const { m, pc, vieux } = await departAvecAncienTelephone();
    const neuf = m.appareil('cccc0003', { materiel: 'tel-2' });
    neuf.appareil.remplace = vieux.appareil.id;
    const r = await neuf.synchro();
    assert.equal(r.rejoindre.prefixe, 'M');
    assert.deepEqual(r.rejoindre.remplacement, { id: 'bbbb0002', nom: vieux.appareil.nom, prefixe: 'M', auto: false });
    assert.equal(neuf.appareil.nom, vieux.appareil.nom);
    assert.equal(neuf.appareil.prefixe_ref, 'M');
    const f = await fiche(m, 'cccc0003');
    assert.equal(f.remplace, 'bbbb0002');
    assert.equal(f.nom, vieux.appareil.nom);
    assert.equal(f.type, 'Android');
    assert.equal(f.prefixe_ref, 'M');
    assert.ok(f.rejoint_le, 'la fiche finale garde ce que rejoindre a ecrit');
    assert.ok(f.retires.some((x) => x.id === 'bbbb0002'));
    // Le PC voit l'ancien comme retire (il ne bloque plus le menage).
    await pc.synchro();
    assert.ok(compaction.retires(pc, await m.transport.lireFiches()).has('bbbb0002'));
  });

  await test('tuiles creees avant la connexion : numerotees A LA SUITE de l\'ancien (M4, M5), apres reception', async () => {
    const { m, pc, vieux } = await departAvecAncienTelephone();
    const neuf = m.appareil('cccc0003');
    const t1 = neuf.creer('Avant connexion 1');
    const t2 = neuf.creer('Avant connexion 2');
    assert.equal(t1.ref, 'L1');
    neuf.appareil.remplace = vieux.appareil.id;
    const r = await neuf.synchro();
    assert.deepEqual(r.rejoindre.renumerotees.map((x) => [x.avant, x.apres]), [['L1', 'M4'], ['L2', 'M5']]);
    assert.equal(neuf.ref(t1.cle), 'M4');
    assert.equal(neuf.ref(t2.cle), 'M5');
    await m.converger([pc, neuf]);
    assert.deepEqual(refs(pc), ['L1', 'M1', 'M2', 'M3', 'M4', 'M5']);
    assert.deepEqual(etatDe(pc), etatDe(neuf));
    assert.deepEqual(moteur.conflits(pc), []);
    // Les numeros provisoires (L1, L2) ne sont visibles nulle part.
    assert.ok(!pc.d.prepare("SELECT 1 FROM oeuvres_locales WHERE id IN (?, ?) AND ref_local LIKE 'L%'").get(t1.cle, t2.cle));
  });

  await test('tuile creee ensuite : M6 (a la suite), jamais un doublon', async () => {
    const { m, pc, vieux } = await departAvecAncienTelephone();
    const neuf = m.appareil('cccc0003');
    neuf.appareil.remplace = vieux.appareil.id;
    await neuf.synchro();
    assert.equal(neuf.creer('Nouvelle').ref, 'M4');
    await m.converger([pc, neuf]);
    const toutes = refs(pc);
    assert.equal(new Set(toutes).size, toutes.length, 'refs uniques');
  });

  await test('nom choisi par l\'utilisateur : garde au remplacement (seule la lettre est reprise)', async () => {
    const { m, vieux } = await departAvecAncienTelephone();
    const neuf = m.appareil('cccc0003', { nom: 'Mon Pixel', nomPerso: true });
    neuf.appareil.remplace = vieux.appareil.id;
    await neuf.synchro();
    assert.equal(neuf.appareil.nom, 'Mon Pixel');
    assert.equal(neuf.appareil.prefixe_ref, 'M');
    assert.equal((await fiche(m, 'cccc0003')).nom, 'Mon Pixel');
  });

  await test('appareil choisi introuvable (fiche disparue) : entre comme nouvel appareil', async () => {
    const { m } = await departAvecAncienTelephone();
    const neuf = m.appareil('cccc0003');
    neuf.appareil.remplace = 'dddd9999';
    const r = await neuf.synchro();
    assert.equal(r.rejoindre.prefixe, 'N');
    assert.equal(r.rejoindre.remplacement, undefined);
  });

  await test('un appareil deja remplace n\'est plus propose', async () => {
    const { m, vieux } = await departAvecAncienTelephone();
    const neuf = m.appareil('cccc0003');
    neuf.appareil.remplace = vieux.appareil.id;
    await neuf.synchro();
    const encore = await attendreDecision(m.appareil('dddd0004').synchro());
    assert.ok(!encore.candidats.some((c) => c.id === 'bbbb0002'));
    assert.ok(encore.candidats.some((c) => c.id === 'cccc0003'));
  });

  console.log('reprise automatique (meme appareil reinstalle)');

  await test('meme empreinte materielle : remplacement sans question, auto', async () => {
    const { m, pc, vieux } = await departAvecAncienTelephone();
    const reinstalle = m.appareil('cccc0003', { materiel: 'tel-1' });
    const r = await reinstalle.synchro();
    assert.deepEqual(r.rejoindre.remplacement, { id: 'bbbb0002', nom: vieux.appareil.nom, prefixe: 'M', auto: true });
    assert.equal(reinstalle.appareil.prefixe_ref, 'M');
    await m.converger([pc, reinstalle]);
    assert.deepEqual(refs(reinstalle), ['L1', 'M1', 'M2', 'M3']);
  });

  await test('empreinte d\'un appareil deja remplace : pas de reprise automatique', async () => {
    const { m, vieux } = await departAvecAncienTelephone();
    const neuf = m.appareil('cccc0003');
    neuf.appareil.remplace = vieux.appareil.id;
    await neuf.synchro();
    await attendreDecision(m.appareil('dddd0004', { materiel: 'tel-1' }).synchro());
  });

  await test('empreinte inconnue : question posee (pas de reprise au hasard)', async () => {
    const { m } = await departAvecAncienTelephone();
    await attendreDecision(m.appareil('cccc0003', { materiel: 'autre' }).synchro());
  });

  console.log('ancien appareil qui revient');

  await test('supplante : nouvelle lettre pour ses PROCHAINES tuiles, les anciennes gardent la leur', async () => {
    const { m, pc, vieux } = await departAvecAncienTelephone();
    const neuf = m.appareil('cccc0003');
    neuf.appareil.remplace = vieux.appareil.id;
    await neuf.synchro();
    neuf.creer('Du nouveau');                    // M4
    await neuf.synchro();
    m.avancer(HEURE);
    const r = await vieux.synchro();             // le vieux telephone revient
    assert.ok(r.rejoindre.supplante, 'supplante');
    assert.equal(r.rejoindre.supplante.par.id, 'cccc0003');
    assert.equal(r.rejoindre.supplante.ancienPrefixe, 'M');
    assert.equal(vieux.appareil.prefixe_ref, 'N');
    assert.ok(vieux.enregistre.includes('prefixe:N'));
    const ancienne = vieux.d.prepare("SELECT ref_local FROM oeuvres_locales WHERE titre='Tuile du vieux telephone 1'").get();
    assert.equal(ancienne.ref_local, 'M1', 'une ref partagee ne change jamais');
    assert.equal(vieux.creer('Apres retour').ref, 'N1');
    await m.converger([pc, neuf, vieux]);
    const toutes = refs(pc);
    assert.equal(new Set(toutes).size, toutes.length, 'refs uniques : ' + toutes.join(' '));
    assert.deepEqual(etatDe(pc), etatDe(vieux));
    assert.deepEqual(etatDe(pc), etatDe(neuf));
  });

  await test('supplante avec des tuiles pas encore envoyees : renumerotees vers sa nouvelle lettre (aucun doublon)', async () => {
    const { m, pc, vieux } = await departAvecAncienTelephone();
    const pendant = vieux.creer('Faite hors ligne');   // M4 chez le vieux, jamais envoyee
    const neuf = m.appareil('cccc0003');
    neuf.appareil.remplace = vieux.appareil.id;
    await neuf.synchro();
    assert.equal(neuf.creer('Du remplacant').ref, 'M4');
    await neuf.synchro();
    const r = await vieux.synchro();
    assert.deepEqual(r.rejoindre.supplante.renumerotees.map((x) => [x.avant, x.apres]), [['M4', 'N1']]);
    assert.equal(vieux.ref(pendant.cle), 'N1');
    await m.converger([pc, neuf, vieux]);
    assert.deepEqual(refs(pc), ['L1', 'M1', 'M2', 'M3', 'M4', 'N1']);
    assert.deepEqual(etatDe(pc), etatDe(vieux));
  });

  await test('chaine A <- B <- C : B revient apres que C a lui-meme ete remplace ; aucune lettre partagee', async () => {
    const { m, pc, vieux } = await departAvecAncienTelephone();   // vieux = A (M)
    const b = m.appareil('cccc0003');
    b.appareil.remplace = vieux.appareil.id;
    await b.synchro();                                            // B reprend M
    const c = m.appareil('dddd0004');
    c.appareil.remplace = b.appareil.id;
    await c.synchro();                                            // C reprend M
    m.avancer(HEURE);
    await b.synchro();                                            // B revient : supplante par C
    assert.notEqual(b.appareil.prefixe_ref, 'M');
    await vieux.synchro();                                        // A revient : M porte par C
    assert.notEqual(vieux.appareil.prefixe_ref, 'M');
    const lettres = [pc, vieux, b, c].map((x) => x.appareil.prefixe_ref);
    assert.equal(new Set(lettres).size, 4, lettres.join(' '));
    for (const x of [vieux, b, c]) x.creer('apres');
    await m.converger([pc, vieux, b, c]);
    const toutes = refs(pc);
    assert.equal(new Set(toutes).size, toutes.length, toutes.join(' '));
  });

  await test('le retrait de l\'ancien s\'eteint quand il revient (il compte de nouveau pour le menage)', async () => {
    const { m, pc, vieux } = await departAvecAncienTelephone();
    const neuf = m.appareil('cccc0003');
    neuf.appareil.remplace = vieux.appareil.id;
    await neuf.synchro();
    m.avancer(HEURE);
    await vieux.synchro();
    assert.ok(!compaction.retires(pc, await m.transport.lireFiches()).has('bbbb0002'));
  });

  console.log('identite deja inscrite');

  await test('appareil.json perime (copie de secours ancienne) : la fiche fait foi pour la lettre', async () => {
    const { m, vieux } = await departAvecAncienTelephone();
    vieux.appareil.prefixe_ref = 'L';            // copie restauree d'avant l'inscription
    const r = await vieux.synchro();
    assert.equal(r.rejoindre.premiereFois, false);
    assert.equal(vieux.appareil.prefixe_ref, 'M');
    assert.ok(vieux.enregistre.includes('prefixe:M'));
    assert.equal(vieux.creer('Encore').ref, 'M4');
  });

  await test('deja inscrit : pas de decision, nom et type rafraichis dans la fiche', async () => {
    const { m, vieux } = await departAvecAncienTelephone();
    vieux.appareil.nom = 'Telephone de secours';
    vieux.appareil.type = 'Android · Samsung SM-G998B (Android 15)';
    await cycle.executer(vieux, m.transport, {
      nom: vieux.appareil.nom, type: vieux.appareil.type, exigerDecision: true,
      enregistrerPrefixe: () => {}, maintenant: () => m.t
    });
    const f = await fiche(m, 'bbbb0002');
    assert.equal(f.nom, 'Telephone de secours');
    assert.equal(f.type, 'Android · Samsung SM-G998B (Android 15)');
  });

  await test('sans exigerDecision (outils, tests historiques) : entree directe comme avant', async () => {
    const { m } = await departAvecAncienTelephone();
    const neuf = m.appareil('cccc0003');
    const r = await cycle.executer(neuf, m.transport, { nom: 'x', enregistrerPrefixe: () => {}, maintenant: () => m.t });
    assert.equal(r.rejoindre.prefixe, 'N');
  });

  await test('candidats() : fonction pure, ignore l\'appareil lui-meme', () => {
    const t = Date.parse('2026-10-02T12:00:00Z');
    const c = candidats([
      { id: 'a', nom: 'A', prefixe_ref: 'L', vu_le: '2026-10-02T11:00:00Z' },
      { id: 'b', nom: 'B', prefixe_ref: 'M', vu_le: '2026-09-20T11:00:00Z' },
      { id: 'moi', prefixe_ref: 'N' }
    ], 'moi', t);
    assert.deepEqual(c.map((x) => [x.id, x.recent]), [['b', false], ['a', true]]);
  });
}

// --- propriete : sequences aleatoires --------------------------------------------

function alea(graine) {
  let s = graine >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

async function propriete() {
  console.log(`propriete : ${NB_SCENARIOS} scenarios aleatoires (graine ${GRAINE})`);
  let echecs = 0;
  for (let k = 0; k < NB_SCENARIOS; k++) {
    const r = alea(GRAINE + k);
    // TT_TRACE=<k> : deroule le scenario k action par action.
    const trace = process.env.TT_TRACE === String(k) ? (...x) => console.log('        ', ...x) : () => {};
    const m = creerMonde();
    const vivants = [];
    const tous = [];
    let n = 0;
    const nouveau = (materiel) => {
      const id = (0x10000000 + (++n) * 7919 + k).toString(16).slice(-8);
      const ctx = m.appareil(id, { materiel });
      tous.push(ctx);
      return ctx;
    };
    try {
      const premier = nouveau('m0');
      await premier.synchro();
      vivants.push(premier);
      for (let pas = 0; pas < 25; pas++) {
        const x = r();
        if (x < 0.45 && vivants.length) {
          const v = vivants[Math.floor(r() * vivants.length)];
          trace(v.appareil.id, 'cree', v.creer('t' + pas).ref);
        } else if (x < 0.7 && vivants.length) {
          const v = vivants[Math.floor(r() * vivants.length)];
          const res = await v.synchro();
          trace(v.appareil.id, 'synchro', v.appareil.prefixe_ref, res.rejoindre.supplante ? 'SUPPLANTE ' + JSON.stringify(res.rejoindre.supplante.renumerotees) : '');
        } else if (x < 0.82) {
          // Arrivee : nouvel appareil, remplacement d'un autre, ou meme machine reinstallee.
          const choix = r();
          const remplacable = tous.filter((t) => t.appareil.inscrit);
          const cible = remplacable.length ? remplacable[Math.floor(r() * remplacable.length)] : null;
          const neuf = nouveau(choix < 0.25 && cible ? cible.appareil.materiel : 'm' + n);
          if (r() < 0.5) neuf.creer('avant-' + pas);
          try { await neuf.synchro(); } catch (e) {
            if (!(e instanceof DecisionRequise)) throw e;
            neuf.appareil.remplace = choix < 0.6 && cible && e.candidats.some((c) => c.id === cible.appareil.id)
              ? cible.appareil.id : 'aucun';
            await neuf.synchro();
          }
          trace(neuf.appareil.id, 'ARRIVE', 'materiel=' + neuf.appareil.materiel, 'remplace=' + neuf.appareil.remplace,
            'lettre=' + neuf.appareil.prefixe_ref, refs(neuf).join(' '));
          vivants.push(neuf);
          // L'appareil remplace se tait... ou pas (il revient parfois). Meme
          // empreinte = meme machine : l'ancienne installation n'existe plus.
          const rem = neuf.appareil.remplace && neuf.appareil.remplace !== 'aucun'
            ? vivants.findIndex((v) => v.appareil.id === neuf.appareil.remplace) : -1;
          const memeMachine = rem >= 0 && vivants[rem].appareil.materiel === neuf.appareil.materiel;
          if (rem >= 0 && (memeMachine || r() < 0.7)) vivants.splice(rem, 1);
        } else {
          m.avancer(r() * 2 * JOUR);
        }
      }
      await m.converger(vivants);
      const ref = vivants[0];
      const toutes = refs(ref);
      assert.equal(new Set(toutes).size, toutes.length, 'refs en double : ' + toutes.join(' '));
      for (const v of vivants.slice(1)) assert.deepEqual(etatDe(v), etatDe(ref), v.appareil.id + ' diverge');
      // Chaque lettre active n'appartient qu'a un appareil vivant.
      const lettres = vivants.map((v) => v.appareil.prefixe_ref);
      assert.equal(new Set(lettres).size, lettres.length, 'lettres partagees : ' + lettres.join(' '));
    } catch (e) {
      echecs++;
      if (echecs <= 3) console.log('      scenario ' + k + ' : ' + String(e.message).split('\n')[0]);
    }
  }
  if (echecs) { nKo++; console.log(`  KO  ${echecs} / ${NB_SCENARIOS} scenarios`); }
  else { nOk++; console.log(`  ok  ${NB_SCENARIOS} scenarios : refs uniques, etats identiques, une lettre par appareil vivant`); }
}

(async () => {
  await scenarios();
  await propriete();
  console.log(`\n${nOk} ok, ${nKo} KO`);
  process.exit(nKo ? 1 : 0);
})();
