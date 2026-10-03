'use strict';
/**
 * Banc d'essai de la lecture de cartel sur PC (reconnaissance de Windows +
 * cartel-analyse.js) : pas un test de `npm test` (photos et images de synthese
 * hors depot), un outil de mesure.
 *
 *     node scripts/lancer-node.js tests/banc-cartels.js            vraies photos (tests/photos-cartels/)
 *     node scripts/lancer-node.js tests/banc-cartels.js synthese   cartels fabriques (tests/cartels-synthese/,
 *                                                                  voir tools/fabriquer-cartels.py)
 *     ... banc-cartels.js <dossier> -v                             detail ligne par ligne
 *
 * Note par champ : exact (memes lettres, accents / casse / ponctuation ignores),
 * proche (similarite >= 85 %) ou faux. Lecture brute : taux d'erreur par
 * caractere (CER) du texte lu contre le texte attendu.
 */

const fs = require('fs');
const path = require('path');
const cartel = require('../src/main/cartel-pc');
const exemples = require('./cartels-exemples');

const CHAMPS = ['artiste', 'titre', 'date', 'tags', 'description'];
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[’'`]/g, "'").replace(/[^a-z0-9']+/g, ' ').trim();

// Attendus retranscrits avec l'apostrophe typographique ; la reconnaissance rend souvent la droite.
const apos = (s) => String(s || '').replace(/'/g, '’');

function distance(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return m || n;
  let prec = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cour = [i];
    for (let j = 1; j <= n; j++) cour[j] = Math.min(prec[j] + 1, cour[j - 1] + 1, prec[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prec = cour;
  }
  return prec[n];
}
const similarite = (a, b) => { const x = norm(a), y = norm(b); return !x && !y ? 1 : 1 - distance(x, y) / Math.max(x.length, y.length, 1); };

/** 'exact' | 'proche' | 'faux' pour un champ (attendu : texte ou RegExp). */
function noter(lu, attendu) {
  if (attendu instanceof RegExp) return attendu.test(apos(lu)) || attendu.test(lu || '') ? 'exact' : similariteRegex(lu, attendu) ? 'proche' : 'faux';
  if (norm(lu) === norm(attendu)) return 'exact';
  return similarite(lu, attendu) >= 0.85 ? 'proche' : 'faux';
}
// Description attendue en RegExp (debut…fin) : proche si debut et fin y sont a peu pres.
function similariteRegex(lu, re) {
  const m = re.source.match(/^\^(.*?)\.\*(.*?)\$$/);
  if (!m || !lu) return false;
  const deb = m[1].replace(/\\/g, ''), fin = m[2].replace(/\\/g, '');
  return similarite(lu.slice(0, deb.length + 5), deb) > 0.7 && similarite(lu.slice(-fin.length - 5), fin) > 0.7;
}

/** Verite terrain d'un fichier : photo -> exemple retranscrit ; synthese -> .json voisin. */
function verite(fichier) {
  const json = fichier.replace(/\.(jpe?g|png)$/i, '.json');
  if (fs.existsSync(json)) return JSON.parse(fs.readFileSync(json, 'utf8'));
  const cle = path.basename(fichier).replace(/\.\w+$/, '').toLowerCase();
  const ex = exemples.find((e) => norm(e.nom).split(' ').some((m) => m === norm(cle)) && !/sortie ml kit/i.test(e.nom));
  return ex ? { attendu: ex.attendu, lignes: ex.lignes.map((l) => l[0]), nom: ex.nom } : null;
}

(async () => {
  const args = process.argv.slice(2);
  const verbeux = args.includes('-v');
  const arg = args.find((a) => a !== '-v');
  const dossier = !arg ? path.join(__dirname, 'photos-cartels')
    : arg === 'synthese' ? path.join(__dirname, 'cartels-synthese') : path.resolve(arg);
  const fichiers = fs.readdirSync(dossier).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
  const total = { exact: 0, proche: 0, faux: 0 };
  const parChamp = Object.fromEntries(CHAMPS.map((c) => [c, { exact: 0, proche: 0, faux: 0 }]));
  let cerSomme = 0, cerN = 0, ms = 0;
  for (const f of fichiers) {
    const v = verite(path.join(dossier, f));
    const r = await cartel.lire(path.join(dossier, f));
    ms += r.ms || 0;
    if (r.erreur) { console.log(f.padEnd(28), 'ERREUR', r.erreur); continue; }
    const notes = [];
    if (v) {
      for (const c of CHAMPS) {
        if (!(c in v.attendu)) continue;
        const n = noter(r.proposition[c] || '', v.attendu[c]);
        total[n]++; parChamp[c][n]++;
        notes.push(c + ':' + (n === 'exact' ? '✓' : n === 'proche' ? '≈' : '✗'));
      }
      if (v.lignes) {
        const lu = norm(r.lignes.map((l) => l.texte).join(' ')), att = norm(v.lignes.join(' '));
        const cer = distance(lu, att) / Math.max(att.length, 1);
        cerSomme += cer; cerN++;
        notes.push('CER ' + (cer * 100).toFixed(1) + ' %');
      }
    }
    console.log(f.padEnd(28), String(r.ms).padStart(5), 'ms ', notes.join('  '));
    if (verbeux) {
      for (const l of r.lignes) console.log('      ', ('[' + l.role + ']').padEnd(13), 'b' + l.bloc, 'h' + l.hauteur, l.texte);
      if (v) for (const c of CHAMPS) if (c in v.attendu && noter(r.proposition[c] || '', v.attendu[c]) !== 'exact') {
        console.log('       ✗', c, ': lu « ' + (r.proposition[c] || '') + ' »\n              attendu « ' + v.attendu[c] + ' »');
      }
    }
  }
  const n = total.exact + total.proche + total.faux;
  console.log('\nchamps : ' + total.exact + ' exacts, ' + total.proche + ' proches, ' + total.faux + ' faux sur ' + n
    + ' (' + Math.round(100 * total.exact / Math.max(n, 1)) + ' % exacts, ' + Math.round(100 * (total.exact + total.proche) / Math.max(n, 1)) + ' % exacts ou proches)');
  for (const c of CHAMPS) {
    const p = parChamp[c], t = p.exact + p.proche + p.faux;
    if (t) console.log('  ' + c.padEnd(12) + p.exact + '/' + t + ' exacts, ' + p.proche + ' proches');
  }
  if (cerN) console.log('lecture brute : CER moyen ' + (100 * cerSomme / cerN).toFixed(1) + ' % sur ' + cerN + ' images');
  console.log('temps moyen : ' + Math.round(ms / Math.max(fichiers.length, 1)) + ' ms');
})();
