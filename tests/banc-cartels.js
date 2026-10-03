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
 *     ... banc-cartels.js <dossier> --ia [--haiku]                 lecture par Claude (PAYANT : environ
 *                                                                  1,5 centime par image) ; cle lue dans
 *                                                                  ia-cle-dev.txt a la racine (gitignore)
 *                                                                  ou TT_CLE_IA. Tags non notes : Claude
 *                                                                  rend des categories, pas la technique.
 *
 * Note par champ : exact (memes lettres, accents / casse / ponctuation ignores),
 * proche (similarite >= 85 %) ou faux. Lecture brute : taux d'erreur par
 * caractere (CER) du texte lu contre le texte attendu.
 */

const fs = require('fs');
const path = require('path');
const cartel = require('../src/main/cartel-pc');
const ia = require('../src/main/cartel-ia');

/** Categories du pack (champ tags), les plus frequentes d'abord : ce que l'appli envoie a Claude. */
function categoriesDuPack() {
  const Database = require('better-sqlite3');
  const d = new Database(path.join(__dirname, '..', 'data', 'pack.db'), { readonly: true });
  const n = new Map();
  for (const r of d.prepare('SELECT tags FROM oeuvres').all()) {
    for (const t of String(r.tags || '').split(',').map((x) => x.trim()).filter(Boolean)) {
      const k = t.toLowerCase();
      if (!n.has(k)) n.set(k, { label: t, n: 0 });
      n.get(k).n++;
    }
  }
  d.close();
  return [...n.values()].sort((a, b) => b.n - a.n).map((x) => x.label);
}
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
  const avecIA = args.includes('--ia');
  const arg = args.find((a) => !a.startsWith('-'));
  let cle = null, categories = [];
  if (avecIA) {
    const f = path.join(__dirname, '..', 'ia-cle-dev.txt');
    cle = process.env.TT_CLE_IA || (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : null);
    if (!cle) { console.log('Cle absente : mets ta cle API dans ia-cle-dev.txt (racine du projet, ignore par git).'); return; }
    categories = categoriesDuPack();
  }
  let depense = 0;
  const lireUn = async (fichier) => {
    if (!avecIA) return cartel.lire(fichier);
    const image = await cartel.imageIA(fichier);
    const r = await ia.lire({ image, categories, cle, gamme: args.includes('--haiku') ? 'haiku' : 'sonnet' });
    depense += r.cout || 0;
    return r;
  };
  const dossier = !arg ? path.join(__dirname, 'photos-cartels')
    : arg === 'synthese' ? path.join(__dirname, 'cartels-synthese') : path.resolve(arg);
  const fichiers = fs.readdirSync(dossier).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
  const total = { exact: 0, proche: 0, faux: 0 };
  const parChamp = Object.fromEntries(CHAMPS.map((c) => [c, { exact: 0, proche: 0, faux: 0 }]));
  let cerSomme = 0, cerN = 0, ms = 0;
  for (const f of fichiers) {
    const v = verite(path.join(dossier, f));
    const r = await lireUn(path.join(dossier, f));
    ms += r.ms || 0;
    if (r.erreur) { console.log(f.padEnd(28), 'ERREUR', r.erreur); continue; }
    const notes = [];
    if (v) {
      for (const c of CHAMPS) {
        if (!(c in v.attendu) || (avecIA && c === 'tags')) continue;
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
    console.log(f.padEnd(28), String(r.ms).padStart(5), 'ms ', notes.join('  ')
      + (avecIA ? '  ' + (r.cout * 100).toFixed(2) + ' ct$  tags « ' + (r.proposition.tags || '') + ' »' : ''));
    if (verbeux) {
      for (const l of r.lignes) console.log('      ', ('[' + l.role + ']').padEnd(13), avecIA ? '' : 'b' + l.bloc + ' h' + l.hauteur, l.texte);
      if (v) for (const c of CHAMPS) if (c in v.attendu && !(avecIA && c === 'tags') && noter(r.proposition[c] || '', v.attendu[c]) !== 'exact') {
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
  if (avecIA) console.log('cout Claude : ' + (depense * 100).toFixed(2) + ' centimes de dollar au total, '
    + (depense * 100 / Math.max(fichiers.length, 1)).toFixed(2) + ' par cartel');
})();
