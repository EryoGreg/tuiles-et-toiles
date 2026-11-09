'use strict';
/**
 * Frise des dates : echelle par epoques, graduations, rangement des vignettes
 * (src/renderer/frise/echelle.js), sur les vraies dates du pack ; robustesse de
 * dates.js face a n'importe quel texte (la frise lit toutes les dates).
 *
 *     node scripts/lancer-node.js tests/frise.test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const RACINE = path.resolve(__dirname, '..');
const dates = require(path.join(RACINE, 'src/main/dates'));

let nOk = 0, nKo = 0;
async function test(nom, fn) {
  try { await fn(); nOk++; console.log('  ok  ' + nom); }
  catch (e) { nKo++; console.log('  KO  ' + nom + '\n      ' + String(e.stack || e).split('\n').slice(0, 6).join('\n      ')); }
}

// Generateur pseudo-aleatoire reproductible.
function alea(graine) {
  let s = graine >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

(async () => {
  // echelle.js est un module ES (rendu) : charge tel quel.
  const source = fs.readFileSync(path.join(RACINE, 'src/renderer/frise/echelle.js'), 'utf8');
  const E = await import('data:text/javascript,' + encodeURIComponent(source));

  const d = new Database(path.join(RACINE, 'data/pack.db'), { readonly: true });
  const pack = d.prepare('SELECT id, date FROM oeuvres').all();
  d.close();
  const tuiles = pack.map((o) => ({ id: o.id, periode: dates.analyser(o.date) })).filter((o) => o.periode);
  const milieux = tuiles.map((o) => E.milieu(o.periode));
  const ech = E.creerEchelle(milieux);

  await test('epoques : parts > 0, somme 1, contigues, plancher respecte', () => {
    const s = ech.epoques.reduce((t, e) => t + e.part, 0);
    assert.ok(Math.abs(s - 1) < 1e-9, 'somme ' + s);
    let attendu = 0;
    for (const e of ech.epoques) {
      assert.ok(Math.abs(e.debut - attendu) < 1e-9, e.nom);
      assert.ok(e.part >= 0.03 / 1.5, e.nom + ' trop etroite : ' + e.part);
      attendu += e.part;
    }
  });

  await test('x croissante, dans [0,1], et annee() en est l\'inverse', () => {
    let avant = -1;
    for (let y = -40000; y <= new Date().getFullYear(); y += y < 0 ? 97 : 3) {
      const f = ech.x(y);
      assert.ok(f >= 0 && f <= 1, y + ' -> ' + f);
      assert.ok(f >= avant, 'decroit a ' + y);
      avant = f;
      if (y > ech.epoques[0].a) assert.ok(Math.abs(ech.annee(f) - y) < 1e-6 * Math.max(1, Math.abs(y)), 'inverse ' + y);
    }
    assert.equal(ech.x(-1e9), 0);
    assert.equal(ech.x(1e9), 1);
  });

  await test('les derniers siecles ont la place : 1800-aujourd\'hui > la moitie, avant J.-C. < 15 %', () => {
    const apres1800 = 1 - ech.x(1800);
    const avantJC = ech.x(0);
    assert.ok(apres1800 > 0.5, 'apres 1800 : ' + apres1800);
    assert.ok(avantJC < 0.15, 'avant J.-C. : ' + avantJC);
  });

  await test('date tres ancienne (au-dela de -40 000) : la premiere epoque s\'etend', () => {
    const e2 = E.creerEchelle([-60000, 1900]);
    assert.ok(e2.epoques[0].a <= -60000);
    assert.ok(e2.x(-60000) >= 0 && e2.x(-60000) < e2.x(-3000));
  });

  await test('corpus vide : echelle utilisable', () => {
    const e0 = E.creerEchelle([]);
    assert.ok(Math.abs(e0.epoques.reduce((t, e) => t + e.part, 0) - 1) < 1e-9);
    assert.ok(e0.x(1900) > 0 && e0.x(1900) < 1);
  });

  await test('graduations : toutes les limites d\'epoque, etiquettes sans chevauchement (PC et telephone)', () => {
    for (const [W, ecart] of [[375, 70], [1100, 90], [3300, 90], [26400, 90]]) {
      const g = E.graduations(ech, W, ecart);
      for (const e of ech.epoques) assert.ok(g.some((t) => t.limite && Math.abs(t.x - e.debut * W) < 1e-6), W + ' : limite ' + e.nom);
      const etiq = g.filter((t) => t.etiquette).sort((a, b) => a.x - b.x);
      for (let i = 1; i < etiq.length; i++) {
        const largeur = E.texteAnnee(etiq[i - 1].annee).length * 6.6 + 12;
        assert.ok(etiq[i].x - etiq[i - 1].x >= Math.min(largeur, ecart * 0.75) - 1e-6, W + ' : ' + etiq[i - 1].annee + ' / ' + etiq[i].annee);
      }
      for (const t of g) assert.ok(t.x >= 0 && t.x <= W + 1e-6);
    }
  });

  await test('rangement : chaque tuile placee, aucune vignette ne chevauche sa voisine de couloir', () => {
    for (const [W, C] of [[375, 46], [1125, 46], [1100, 62], [6600, 62]]) {
      const r = E.ranger(tuiles, ech, W, C);
      assert.equal(r.places.size, tuiles.length);
      const parCouloir = new Map();
      for (const p of r.places.values()) {
        assert.ok(p.gauche >= 0 && p.gauche + C <= Math.max(W, C) + 1e-6, 'hors frise');
        if (!parCouloir.has(p.couloir)) parCouloir.set(p.couloir, []);
        parCouloir.get(p.couloir).push(p.gauche);
      }
      for (const l of parCouloir.values()) {
        l.sort((a, b) => a - b);
        for (let i = 1; i < l.length; i++) assert.ok(l[i] - l[i - 1] >= C, 'chevauchement W=' + W);
      }
      assert.equal(r.couloirs, parCouloir.size);
    }
  });

  await test('rangement : liste vide, et largeur plus petite qu\'une vignette', () => {
    assert.equal(E.ranger([], ech, 1000, 60).couloirs, 0);
    const r = E.ranger(tuiles.slice(0, 5), ech, 20, 60);
    assert.equal(r.places.size, 5);
    for (const p of r.places.values()) assert.equal(p.gauche, 0);
  });

  await test('texteAnnee et noms d\'epoque', () => {
    assert.equal(E.texteAnnee(1850), '1850');
    assert.equal(E.texteAnnee(-450), '450 av. J.-C.');
    assert.equal(E.texteAnnee(-17000), '17 000 av. J.-C.');
    const e = ech.epoques.find((x) => x.nom === 'XVIIIe siècle');
    assert.equal(E.nomQuiTient(e, 500), 'XVIIIe siècle');
    assert.equal(E.nomQuiTient(e, 60), 'XVIIIe');
    assert.equal(E.nomQuiTient(e, 10), '');
  });

  await test('dates.js : 20 000 textes au hasard, jamais d\'exception, normaliser idempotent, analyser coherent', () => {
    const r = alea(20261109);
    const morceaux = ['vers ', 'V.', 'C. ', 'c', 'Circa ', 'av J.-C.', ' ap J.-C.', 'XIX', 'XVIs', ' siècle', 'Fin ', 'début ',
      '1ere moitié ', 'premier tiers du ', '-', ' - ', '/', ' à ', 'entre ', ' et ', ',', '.', '(', ')', 'années ', 'février ',
      'l897', '17 000', '1570', '75', '1888', '0', '99999', '  ', 'é', '​', '\u0000', '<script>', 'MMXX', 'IIII', 'Directoire'];
    for (let i = 0; i < 20000; i++) {
      let s = '';
      const n = 1 + Math.floor(r() * 5);
      for (let k = 0; k < n; k++) s += r() < 0.3 ? String(Math.floor(r() * 3000) - 500) : morceaux[Math.floor(r() * morceaux.length)];
      const nv = dates.normaliser(s);
      assert.equal(typeof nv, 'string');
      assert.equal(dates.normaliser(nv), nv, 'pas idempotent : ' + JSON.stringify(s) + ' -> ' + JSON.stringify(nv));
      const a = dates.analyser(s);
      if (a) {
        assert.ok(Number.isFinite(a.debut) && Number.isFinite(a.fin), JSON.stringify(s));
        assert.ok(a.debut <= a.fin, 'debut > fin : ' + JSON.stringify(s) + ' ' + JSON.stringify(a));
        assert.equal(typeof a.estimee, 'boolean');
      }
    }
  });

  console.log(`\n${nOk} ok, ${nKo} KO`);
  process.exit(nKo ? 1 : 0);
})();
