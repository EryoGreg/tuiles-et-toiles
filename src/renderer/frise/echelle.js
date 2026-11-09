// Echelle de la frise des dates : lineaire par morceaux, une epoque = un
// morceau. Les tuiles se concentrent sur les derniers siecles : une echelle
// lineaire ecraserait 1400-2000 dans les derniers pourcents (la plus ancienne
// est a -17 000), une echelle logarithmique deformerait chaque siecle. Ici,
// chaque epoque recoit une part fixe (toujours visible, meme vide) plus une
// part proportionnelle a son nombre de tuiles ; a l'interieur d'une epoque
// le temps est lineaire, donc lisible. Les limites sont marquees sur l'axe.

const ANNEE = new Date().getFullYear();

export const EPOQUES = [
  { a: -40000, b: -3000, nom: 'Préhistoire', court: 'Préhist.' },
  { a: -3000, b: 500, nom: 'Antiquité', court: 'Antiq.' },
  { a: 500, b: 1400, nom: 'Moyen Âge', court: 'M. Âge' },
  { a: 1400, b: 1500, nom: 'XVe siècle', court: 'XVe' },
  { a: 1500, b: 1600, nom: 'XVIe siècle', court: 'XVIe' },
  { a: 1600, b: 1700, nom: 'XVIIe siècle', court: 'XVIIe' },
  { a: 1700, b: 1800, nom: 'XVIIIe siècle', court: 'XVIIIe' },
  { a: 1800, b: 1850, nom: '1800 – 1850', court: '1800' },
  { a: 1850, b: 1900, nom: '1850 – 1900', court: '1850' },
  { a: 1900, b: 1950, nom: '1900 – 1950', court: '1900' },
  { a: 1950, b: ANNEE + 1, nom: 'Depuis 1950', court: '1950' }
];

const PART_FIXE = 0.3;     // repartie a egalite entre les epoques
const PART_MIN = 0.03;     // aucune epoque plus etroite

/** Annee de reference d'une tuile sur la frise : milieu de sa periode. */
export const milieu = (p) => (p.debut + p.fin) / 2;

/**
 * @param {number[]} annees  milieux des tuiles datees (tout le corpus : les
 *   positions ne bougent pas quand on filtre)
 * @returns {{ epoques, x(annee)->[0,1], annee(f)->annee }}
 */
export function creerEchelle(annees) {
  const min = annees.length ? Math.min(...annees) : 0;
  const ep = EPOQUES.map((e) => ({ ...e }));
  ep[0].a = Math.min(ep[0].a, Math.floor(min / 1000) * 1000 - 1000);
  const n = ep.length;
  const total = annees.length || 1;
  for (const e of ep) e.n = 0;
  for (const y of annees) {
    const e = ep.find((x) => y < x.b) || ep[n - 1];
    e.n++;
  }
  let parts = ep.map((e) => PART_FIXE / n + (1 - PART_FIXE) * (e.n / total));
  parts = parts.map((p) => Math.max(p, PART_MIN));
  const somme = parts.reduce((s, p) => s + p, 0);
  let cumul = 0;
  ep.forEach((e, i) => { e.part = parts[i] / somme; e.debut = cumul; cumul += e.part; });

  const x = (y) => {
    if (y <= ep[0].a) return 0;
    for (const e of ep) {
      if (y < e.b) return e.debut + ((y - e.a) / (e.b - e.a)) * e.part;
    }
    return 1;
  };
  const annee = (f) => {
    for (const e of ep) {
      if (f < e.debut + e.part) return e.a + ((f - e.debut) / e.part) * (e.b - e.a);
    }
    return ep[n - 1].b;
  };
  return { epoques: ep, x, annee };
}

const PAS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];

/** Graduations d'une frise de largeur `W` px : [{ x, annee, limite }] */
export function graduations(ech, W, ecartMin = 84) {
  const out = [];
  for (const e of ech.epoques) {
    out.push({ x: e.debut * W, annee: e.a, limite: true });
    const pxAn = (e.part * W) / (e.b - e.a);
    const pas = PAS.find((p) => p * pxAn >= ecartMin);
    if (!pas) continue;
    const g = ecartMin * 0.6;   // pas de graduation collee a une limite
    for (let y = Math.ceil((e.a + 1) / pas) * pas; y < e.b; y += pas) {
      const px = ech.x(y) * W;
      if (px - e.debut * W < g || (e.debut + e.part) * W - px < g) continue;
      out.push({ x: px, annee: y, limite: false });
    }
  }
  // Une etiquette trop pres de la precedente est tue (le trait reste).
  out.sort((p, q) => p.x - q.x);
  let libre = -Infinity;   // abscisse ou la prochaine etiquette peut commencer
  for (const t of out) {
    t.etiquette = t.x >= libre;
    if (t.etiquette) libre = t.x + Math.max(ecartMin * 0.75, texteAnnee(t.annee).length * 6.6 + 12);
  }
  return out;
}

/** Nom d'epoque qui tient dans `px` pixels : complet, court, ou rien. */
export function nomQuiTient(e, px, parCar = 7.4) {
  if (px >= e.nom.length * parCar + 16) return e.nom;
  if (px >= e.court.length * parCar + 10) return e.court;
  return '';
}

export function texteAnnee(y) {
  const r = Math.round(y);
  if (r > 0) return String(r);
  const v = Math.abs(r);
  return (v >= 10000 ? String(v).replace(/\B(?=(\d{3})+$)/g, ' ') : String(v)) + ' av. J.-C.';
}

/**
 * Rangement des cartes en couloirs : chaque carte (largeur `C`) se pose sur
 * le premier couloir ou elle ne chevauche personne.
 * @returns {{ places: Map<id, {gauche, couloir, cx}>, couloirs }}
 */
export function ranger(tuiles, ech, W, C, ecart = 4) {
  const tri = tuiles.map((o) => ({ o, cx: ech.x(milieu(o.periode)) * W }))
    .sort((p, q) => p.cx - q.cx);
  const fins = [];
  const places = new Map();
  for (const { o, cx } of tri) {
    const gauche = Math.min(Math.max(0, cx - C / 2), Math.max(0, W - C));
    let i = fins.findIndex((f) => f + ecart <= gauche);
    if (i < 0) { i = fins.length; fins.push(0); }
    fins[i] = gauche + C;
    places.set(o.id, { gauche, couloir: i, cx });
  }
  return { places, couloirs: fins.length };
}
