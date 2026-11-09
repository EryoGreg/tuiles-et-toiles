'use strict';
/**
 * Dates des tuiles : une seule convention d'ecriture, et sa lecture en annees
 * (frise chronologique).
 *
 * Convention (celle de la grande majorite des tuiles du pack) :
 *   1665                         annee
 *   1550-1560                    periode d'execution, annees completes
 *   vers 1580 · vers 1550-1560   date estimee
 *   années 1760                  decennie
 *   février 1928                 mois connu
 *   XIXe siècle · XVIe-XVIIe siècle
 *   début / milieu / fin XIXe siècle · 1re moitié / 2de moitié XVe siècle
 *   1er tiers / 2e tiers / dernier tiers XIXe siècle
 *   avant 1856 · après 1750 · depuis 2009
 *   450 av. J.-C. · 700-500 av. J.-C. · Ve-IVe siècle av. J.-C. · vers 17 000 av. J.-C.
 *   64 apr. J.-C. · IIe siècle apr. J.-C.  (apr. J.-C. seulement avant l'an 1000)
 * Une precision accessoire suit entre parentheses : « Ve-IVe siècle av. J.-C. (XIXe siècle) ».
 *
 * normaliser(texte) -> texte a la convention (inchange s'il n'est pas compris)
 * analyser(texte)   -> { debut, fin, estimee } en annees (av. J.-C. = negatif ;
 *                      pas d'an 0 : 1 av. J.-C. = -1), ou null
 */

const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août',
  'septembre', 'octobre', 'novembre', 'décembre'];
const sansAccents = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const MOIS_SA = MOIS.map(sansAccents);

const ROMAINS = { I: 1, V: 5, X: 10, L: 50, C: 100 };
function deRomain(r) {
  let n = 0;
  const u = r.toUpperCase();
  for (let i = 0; i < u.length; i++) {
    const v = ROMAINS[u[i]], w = ROMAINS[u[i + 1]] || 0;
    if (!v) return null;
    n += v < w ? -v : v;
  }
  return n > 0 && n <= 30 ? n : null;
}
function versRomain(n) {
  const t = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let s = '';
  for (const [v, r] of t) while (n >= v) { s += r; n -= v; }
  return s;
}
const siecle = (n) => versRomain(n) + (n === 1 ? 'er' : 'e');

// Qualificatifs de siecle : texte canonique + fraction du siecle couverte.
const QUALIFS = [
  { re: /^(?:le\s+)?d[ée]but(?:\s+du)?$/i, txt: 'début', f: [0, 0.3] },
  { re: /^(?:le\s+)?milieu(?:\s+du)?$/i, txt: 'milieu', f: [0.35, 0.65] },
  { re: /^(?:la\s+)?fin(?:\s+du)?$/i, txt: 'fin', f: [0.7, 1] },
  { re: /^(?:1(?:[èe]?re|ere|re)|premi[èe]re)\s+moiti[ée](?:\s+du)?$/i, txt: '1re moitié', f: [0, 0.5] },
  { re: /^(?:2(?:de|nde|e|[èe]me)|seconde|deuxi[èe]me)\s+moiti[ée](?:\s+du)?$/i, txt: '2de moitié', f: [0.5, 1] },
  { re: /^(?:1er|premier)\s+tiers(?:\s+du)?$/i, txt: '1er tiers', f: [0, 0.34] },
  { re: /^(?:2e|2[èe]me|deuxi[èe]me|second)\s+tiers(?:\s+du)?$/i, txt: '2e tiers', f: [0.33, 0.67] },
  { re: /^(?:3e|3[èe]me|troisi[èe]me|dernier)\s+tiers(?:\s+du)?$/i, txt: 'dernier tiers', f: [0.66, 1] }
];
const QUALIF_TXT = new Map(QUALIFS.map((q) => [q.txt, q.f]));

const NOMBRE = '\\d{1,3}(?:[ \\u00a0\\u202f]\\d{3})+|\\d+';
const RE_ROM = '[IVXL]+';
const SUF_SIECLE = '(?:\\s*(?:er|e|[èe]me))?(?:\\s*(?:s\\.?|si[èe]cles?))?';

const RE_BC = /\s*,?\s*\bav(?:ant|\.)?\s*J\.?\s*-?\s*C\.?/i;
const RE_AD = /\s*,?\s*\b(?:ap|apr|apr[èe]s)\.?\s*J\.?\s*-?\s*C\.?/i;

// Dates nommees (periodes historiques) rencontrees dans les tuiles.
const NOMMEES = { directoire: '1795-1799', consulat: '1799-1804', 'premier empire': '1804-1815', regence: '1715-1723' };

const nombre = (s) => parseInt(String(s).replace(/[ \u00a0\u202f]/g, ''), 10);
const ecrireNombre = (n) => (n >= 10000 ? String(n).replace(/\B(?=(\d{3})+$)/g, ' ') : String(n));

/** Fin de periode abregee : 1570-75 -> 1575, 1766-7 -> 1767. */
function completer(a, b) {
  const sa = String(a), sb = String(b);
  if (sb.length < sa.length && b < a) return nombre(sa.slice(0, sa.length - sb.length) + sb);
  return b;
}

/** Une partie de date (sans precision entre parentheses). Renvoie null si pas comprise. */
function normaliserPartie(brut, era) {
  let s = brut.trim();
  if (!s) return '';
  let bc = era.bc, ad = era.ad;
  if (RE_BC.test(s)) { bc = true; s = s.replace(RE_BC, '').trim(); }
  if (RE_AD.test(s)) { ad = true; s = s.replace(RE_AD, '').trim(); }
  s = s.replace(/[,;.]+$/, '').trim();
  // « -450 » sans mention : avant J.-C.
  if (/^-\s*\d/.test(s)) { bc = true; }
  if (bc) s = s.replace(/(^|[\s/-])-\s*(?=\d)/g, '$1').replace(/^-/, '').trim();
  const finEre = bc ? ' av. J.-C.' : '';
  const nommee = NOMMEES[sansAccents(s).toLowerCase()];
  if (nommee) return nommee;

  // Prefixe d'estimation / de borne
  let pre = '';
  let m;
  if ((m = s.match(/^(?:vers|v\.?|c\.?|ca\.?|circa)\s*(?=\d)/i))) { pre = 'vers '; s = s.slice(m[0].length); }
  else if ((m = s.match(/^vers\s+/i))) { pre = 'vers '; s = s.slice(m[0].length); }
  else if ((m = s.match(/^(?:à|a)\s+partir\s+de\s+|^apr[èe]s\s+/i))) { pre = 'après '; s = s.slice(m[0].length); }
  else if ((m = s.match(/^avant\s+/i))) { pre = 'avant '; s = s.slice(m[0].length); }
  else if ((m = s.match(/^depuis\s+/i))) { pre = 'depuis '; s = s.slice(m[0].length); }
  s = s.replace(/\bl(?=\d{3}\b)/g, '1');

  const avecEre = (txt, max) => txt + (bc ? finEre : ad && max < 1000 ? ' apr. J.-C.' : '');

  // entre A et B
  if ((m = s.match(new RegExp('^entre\\s+(' + NOMBRE + ')\\s+et\\s+(' + NOMBRE + ')$', 'i')))) {
    s = m[1] + '-' + m[2];
  }
  // A, A-B, A / B, A à B
  if ((m = s.match(new RegExp('^(' + NOMBRE + ')(?:\\s*(?:-|/|à|a|au)\\s*(' + NOMBRE + '))?$', 'i')))) {
    const a = nombre(m[1]);
    if (m[2] == null) return pre + avecEre(ecrireNombre(a), a);
    const b = bc ? nombre(m[2]) : completer(a, nombre(m[2]));
    if (b === a) return pre + avecEre(ecrireNombre(a), a);
    return pre + avecEre(ecrireNombre(a) + '-' + ecrireNombre(b), Math.max(a, b));
  }
  // années 1760
  if ((m = s.match(/^ann[ée]es\s+(\d{2,4})$/i))) return 'années ' + m[1];
  // mois annee
  if ((m = s.match(/^([a-zéèûô]+)\s+(\d{3,4})$/i))) {
    const i = MOIS_SA.indexOf(sansAccents(m[1]).toLowerCase());
    if (i >= 0) return pre + MOIS[i] + ' ' + m[2];
  }
  // siecles, avec qualificatif eventuel
  let qual = '';
  const mq = s.match(new RegExp('^(.*?)\\s*(?:du\\s+)?(' + RE_ROM + ')' + SUF_SIECLE + '(?:\\s*-\\s*(' + RE_ROM + ')' + SUF_SIECLE + ')?$'));
  if (mq) {
    const q = mq[1].trim();
    if (q) {
      const t = QUALIFS.find((x) => x.re.test(q));
      if (!t) return null;
      qual = t.txt + ' ';
    }
    const n1 = deRomain(mq[2]);
    const n2 = mq[3] ? deRomain(mq[3]) : null;
    if (!n1 || (mq[3] && !n2)) return null;
    const corps = n2 && n2 !== n1 ? siecle(n1) + '-' + siecle(n2) + ' siècle' : siecle(n1) + ' siècle';
    return pre + qual + corps + (bc ? finEre : ad && Math.max(n1, n2 || 0) < 10 ? ' apr. J.-C.' : '');
  }
  return null;
}

/**
 * Texte a la convention. Ce qui n'est pas compris est rendu tel quel
 * (espaces et ponctuation finale nettoyes) : la date n'est jamais perdue.
 */
function normaliser(brut) {
  if (brut == null) return '';
  let s = String(brut).normalize('NFC').replace(/[‐-―−]/g, '-').replace(/\s+/g, ' ').trim();
  s = s.replace(/[,;]+$/, '').replace(/(\d)\.$/, '$1').trim();
  if (!s) return '';
  // Precision entre parentheses deja ecrite a la convention
  let comp = '';
  const mp = s.match(/^(.*?)\s*\(([^()]*)\)$/);
  if (mp) { s = mp[1]; comp = mp[2]; }
  // Ere commune a toute la date (« V-IV av. J.-C, XIX » : l'ere vaut pour la 1re partie)
  const parties = comp ? [s] : s.split(/\s*,\s*/);
  const era = { bc: false, ad: false };
  const tete = normaliserPartie(parties[0], era);
  if (tete == null) return s + (comp ? ' (' + comp + ')' : '');
  const reste = (comp ? [comp] : parties.slice(1)).filter(Boolean)
    .map((p) => { const n = normaliserPartie(p, { bc: false, ad: false }); return n == null ? p.trim() : n; });
  return tete + (reste.length ? ' (' + reste.join(', ') + ')' : '');
}

/**
 * Lecture d'une date (de preference deja normalisee).
 * @returns {{ debut:number, fin:number, estimee:boolean }|null}
 */
function analyser(brut) {
  let s = normaliser(brut);
  if (!s) return null;
  s = s.replace(/\s*\([^()]*\)$/, '');
  let bc = false;
  if (/ av\. J\.-C\.$/.test(s)) { bc = true; s = s.replace(/ av\. J\.-C\.$/, ''); }
  s = s.replace(/ apr\. J\.-C\.$/, '');
  let estimee = false, borne = null;
  let m;
  if ((m = s.match(/^(vers|avant|après|depuis) /))) {
    estimee = true; borne = m[1]; s = s.slice(m[0].length);
  }
  const an = (n) => (bc ? -n : n);
  const ordonne = (a, b) => (a <= b ? { debut: a, fin: b } : { debut: b, fin: a });
  let r = null;
  if ((m = s.match(new RegExp('^(' + NOMBRE + ')(?:-(' + NOMBRE + '))?$')))) {
    const a = an(nombre(m[1])), b = m[2] ? an(nombre(m[2])) : a;
    r = ordonne(a, b);
  } else if ((m = s.match(/^années (\d{2,4})$/))) {
    const a = nombre(m[1]); r = { debut: a, fin: a + 9 }; estimee = true;
  } else if ((m = s.match(/^([a-zéèûô]+) (\d{3,4})$/)) && MOIS.includes(m[1])) {
    const a = nombre(m[2]); r = { debut: a, fin: a };
  } else if ((m = s.match(new RegExp('^(?:(.+) )?(' + RE_ROM + ')(?:er|e)(?:-(' + RE_ROM + ')(?:er|e))? siècle$')))) {
    const n1 = deRomain(m[2]), n2 = m[3] ? deRomain(m[3]) : n1;
    if (!n1 || !n2) return null;
    // Siecle oriente dans le temps : du plus ancien au plus recent.
    const bornes = (n) => (bc ? [-n * 100, -(n - 1) * 100 - 1] : [(n - 1) * 100 + 1, n * 100]);
    const [a0] = bornes(bc ? Math.max(n1, n2) : Math.min(n1, n2));
    const [, b0] = bornes(bc ? Math.min(n1, n2) : Math.max(n1, n2));
    let a = a0, b = b0;
    if (m[1]) {
      const f = QUALIF_TXT.get(m[1]);
      if (!f) return null;
      const L = b0 - a0;
      a = Math.round(a0 + L * f[0]); b = Math.round(a0 + L * f[1]);
    }
    r = { debut: a, fin: b }; estimee = true;
  }
  if (!r) return null;
  if (borne === 'avant') r = { debut: r.debut - 20, fin: r.debut };
  else if (borne === 'après') r = { debut: r.fin, fin: r.fin + 20 };
  else if (borne === 'depuis') r = { debut: r.fin, fin: Math.max(r.fin, new Date().getFullYear()) };
  return { debut: r.debut, fin: r.fin, estimee };
}

module.exports = { normaliser, analyser, deRomain };
