'use strict';
/**
 * Compaction de l'espace de synchro (E2e) : snapshots, purge des segments,
 * rattrapage, purge des pierres tombales.
 *
 * Fiche d'appareil (appareils/<id>.json), champs utilises ici :
 *   lu        { <appareil>: <dernier segment lu> }  accuse de lecture (= curseurs)
 *   purge     dernier de SES segments qu'il a supprime
 *   snapshot  { nom, vecteur } son snapshot le plus recent
 *   vu_le     derniere synchro (appareil inactif au-dela de 90 jours)
 *
 * Snapshot (snapshots/<id>/<hlc>.json.gz) = les TETES de tous les champs
 * (ops que personne n'a vues, moteur.js) + le vecteur des segments qu'il
 * resume. Garder les tetes, pas seulement les valeurs gagnantes, preserve
 * la detection des conflits : un appareil qui repart d'un snapshot calcule
 * les memes conflits que ceux qui ont tout l'historique.
 *
 * Purge : chaque appareil ne supprime que SES segments, et seulement ceux
 * (1) lus par tous les appareils actifs et (2) couverts par un snapshot.
 * Un appareil nouveau, ou revenu apres plus de 90 jours alors que des
 * segments qu'il n'a pas lus ont ete purges, repart du snapshot (rattrapage)
 * puis lit les segments suivants. Ses propres ops en attente partent
 * normalement : rien a rejouer.
 *
 * Pas de compaction du journal LOCAL (changements) : supprimer d'anciennes
 * ops pourrait faire passer un ancetre pour une tete lors d'un rattrapage
 * (faux conflit). Le cout est faible (~200 octets par op).
 */

const moteur = require('./moteur');
const { lire: lireHlc } = require('./hlc');

const JOUR = 86400e3;
const SEUILS = {
  opsParSnapshot: 1000,       // snapshot apres 1 000 ops…
  ageSnapshot: 7 * JOUR,      // …ou 7 jours (s'il y a du nouveau)
  inactif: 90 * JOUR,         // appareil muet : ne bloque plus la purge
  agePierreTombale: 90 * JOUR,
  snapshotsGardes: 2
};
const COLONNES = 'hlc, appareil, entite, cle, champ, valeur, base, vus';
const FIN = String.fromCharCode(0xffff);   // plus grand que tout nom de segment

const seuils = (opts) => ({ ...SEUILS, ...((opts && opts.seuils) || {}) });
const maxNom = (l) => l.filter(Boolean).reduce((m, x) => (x > m ? x : m), '');

function curseurs(ctx) {
  const out = {};
  for (const r of ctx.d.prepare("SELECT cle, valeur FROM sync WHERE cle LIKE 'curseur:%'").all()) {
    out[r.cle.slice('curseur:'.length)] = r.valeur;
  }
  return out;
}

function sync(ctx, cle) {
  const r = ctx.d.prepare('SELECT valeur FROM sync WHERE cle=?').get(cle);
  return r ? r.valeur : null;
}

function poserSync(ctx, cle, valeur) {
  ctx.d.prepare('INSERT OR REPLACE INTO sync (cle, valeur) VALUES (?, ?)').run(cle, valeur);
}

/** Retient le dernier segment envoye par cet appareil (vecteur des snapshots). */
function noterSegmentEnvoye(ctx, nom) {
  if (nom && nom > (sync(ctx, 'dernier_segment') || '')) poserSync(ctx, 'dernier_segment', nom);
}

/** Toutes les tetes du journal local (ops que personne ne cite, non remplacees). */
function tetes(ctx) {
  const ops = ctx.d.prepare(`SELECT ${COLONNES}, remplace FROM changements ORDER BY hlc`).all();
  const cites = new Set();
  for (const o of ops) {
    if (o.base) cites.add(o.base);
    if (o.vus) for (const h of JSON.parse(o.vus)) cites.add(h);
  }
  return ops.filter((o) => !cites.has(o.hlc) && !o.remplace).map(({ remplace, ...o }) => o);
}

/** Snapshots annonces dans les fiches : [{ appareil, nom, vecteur }]. */
/**
 * Appareils retires (perdus, vendus…) : [{ id, le }] retires par CET appareil
 * (sync.appareils_retires, publie dans sa fiche) ou annonces par une autre
 * fiche. Un appareil retire ne bloque plus la purge. Le retrait s'eteint de
 * lui-meme si l'appareil se resynchronise apres coup (fiche vue apres `le`) :
 * il repart alors d'un snapshot (rattrapage), comme apres 90 jours.
 * @returns {Set<string>} ids retires en vigueur
 */
function retires(ctx, fiches = []) {
  const entrees = [...JSON.parse(sync(ctx, 'appareils_retires') || '[]')];
  for (const f of fiches) if (Array.isArray(f.retires)) entrees.push(...f.retires);
  return retiresEnVigueur(entrees, fiches, ctx.appareil.id);
}

function retiresEnVigueur(entrees, fiches, moi) {
  const vuLe = new Map(fiches.map((f) => [f.id, f.vu_le || '']));
  const out = new Set();
  for (const r of entrees) {
    if (!r || typeof r.id !== 'string' || r.id === moi) continue;
    if ((vuLe.get(r.id) || '') <= String(r.le || '')) out.add(r.id);
  }
  return out;
}

function snapshotsAnnonces(fiches) {
  return fiches.filter((f) => f.snapshot && f.snapshot.nom && f.snapshot.vecteur)
    .map((f) => ({ appareil: f.id, nom: f.snapshot.nom, vecteur: f.snapshot.vecteur }));
}

/**
 * Faut-il repartir d'un snapshot ? Oui si des segments non lus d'un autre
 * appareil ont ete purges (trou), ou a la toute premiere synchro (plus court
 * que relire tout l'historique).
 */
function besoins(ctx, fiches) {
  const cur = curseurs(ctx);
  const moi = ctx.appareil.id;
  const trous = {};
  for (const f of fiches) {
    if (f.id === moi || !f.purge) continue;
    if (!cur[f.id] || cur[f.id] < f.purge) trous[f.id] = f.purge;
  }
  const autres = fiches.some((f) => f.id !== moi);
  return { trous, premiere: autres && Object.keys(cur).length === 0 };
}

/**
 * Rattrapage : applique le snapshot le plus recent qui couvre les trous,
 * puis avance les curseurs jusqu'a son vecteur.
 * @returns {null | { snapshot, ops, bilan, trous, premiere } | { manque }}
 */
async function rattraper(ctx, t, fiches) {
  const { trous, premiere } = besoins(ctx, fiches);
  const aTrous = Object.keys(trous).length > 0;
  if (!premiere && !aTrous) return null;
  const moiMeme = ctx.appareil.id;
  const candidats = snapshotsAnnonces(fiches)
    // Premiere synchro sans trou : son propre snapshot n'apprend rien.
    .filter((s) => aTrous || s.appareil !== moiMeme)
    .filter((s) => Object.entries(trous).every(([a, p]) => s.vecteur[a] && s.vecteur[a] >= p))
    .sort((a, b) => (a.nom < b.nom ? 1 : -1));
  if (!candidats.length) return aTrous ? { manque: trous } : null;

  const s = candidats[0];
  const obj = await t.lireSnapshot(s.appareil, s.nom);
  const bilan = {};
  const moi = ctx.appareil.id;
  let remplacees = 0;
  ctx.d.transaction(() => {
    const ops = [...(obj.ops || [])].sort((a, b) => (a.hlc < b.hlc ? -1 : 1));
    for (const op of ops) {
      const r = moteur.appliquer(ctx, op);
      bilan[r] = (bilan[r] || 0) + 1;
    }
    // Ops locales que l'auteur du snapshot avait forcement vues (couvertes par
    // son vecteur) mais qui n'en sont pas des tetes : elles ont ete remplacees,
    // par un maillon qui nous manque peut-etre. Sans ce marquage, elles
    // passeraient pour des tetes (faux conflits).
    const tetesSnapshot = new Set(ops.map((o) => o.hlc));
    const derniereVue = {};
    for (const [app, seg] of Object.entries(obj.vecteur || {})) derniereVue[app] = String(seg).split('_')[1] || '';
    const marquer = ctx.d.prepare('UPDATE changements SET remplace=1 WHERE hlc=?');
    const touches = new Map();
    for (const x of ctx.d.prepare('SELECT hlc, appareil, entite, cle, champ, pousse FROM changements WHERE remplace=0').all()) {
      if (tetesSnapshot.has(x.hlc)) continue;
      const lim = derniereVue[x.appareil];
      if (!lim || x.hlc > lim || (x.appareil === moi && !x.pousse)) continue;
      marquer.run(x.hlc);
      remplacees++;
      touches.set(x.entite + '|' + x.cle + '|' + x.champ, x);
    }
    for (const x of touches.values()) moteur.recalculer(ctx, x);
    const cur = curseurs(ctx);
    for (const [app, nom] of Object.entries(obj.vecteur || {})) {
      if (app !== moi && (!cur[app] || cur[app] < nom)) poserSync(ctx, 'curseur:' + app, nom);
    }
  })();
  return { snapshot: s.appareil + '/' + s.nom, ops: (obj.ops || []).length, bilan, remplacees, trous, premiere };
}

/**
 * Ecrit un snapshot si c'est utile : tout est envoye, et il y a du nouveau
 * depuis le plus recent (1 000 ops, ou 7 jours), ou il n'en existe aucun.
 * Garde les 2 plus recents de cet appareil.
 * @returns {null | { nom, vecteur, ops }}
 */
async function snapshotSiUtile(ctx, t, fiches, opts = {}) {
  const S = seuils(opts);
  const maintenant = (opts.maintenant || Date.now)();
  const d = ctx.d;
  if (d.prepare('SELECT COUNT(*) n FROM changements WHERE pousse=0').get().n) return null;
  const dernier = maxNom(snapshotsAnnonces(fiches).map((s) => s.nom));
  const nouvelles = dernier
    ? d.prepare('SELECT COUNT(*) n FROM changements WHERE hlc > ?').get(dernier).n
    : d.prepare('SELECT COUNT(*) n FROM changements').get().n;
  if (!nouvelles) return null;
  if (dernier && nouvelles < S.opsParSnapshot && maintenant - lireHlc(dernier).ms < S.ageSnapshot) return null;

  const moi = ctx.appareil.id;
  const nom = ctx.horloge.tic();
  const vecteur = { ...curseurs(ctx) };
  const seg = sync(ctx, 'dernier_segment');
  if (seg) vecteur[moi] = seg;
  const ops = tetes(ctx);
  await t.ecrireSnapshot(moi, nom, { v: 1, nom, par: moi, cree_le: new Date(maintenant).toISOString(), vecteur, ops });

  const miens = (await t.listerSnapshots()).filter((s) => s.appareil === moi).map((s) => s.nom).sort();
  for (const vieux of miens.slice(0, -S.snapshotsGardes)) await t.supprimerSnapshot(moi, vieux);
  return { nom, vecteur, ops: ops.length, nouvelles };
}

/**
 * Supprime les segments de CET appareil lus par tous les appareils actifs et
 * couverts par un snapshot.
 * @param {object|null} monSnapshot { nom, vecteur } le plus recent de cet appareil
 * @param {string|null} purgeAvant  valeur `purge` de la fiche
 * @returns {{ supprimes: string[], purge: string|null, limite, couvert, bloquants }}
 */
async function purgerSegments(ctx, t, fiches, monSnapshot, purgeAvant, opts = {}) {
  const S = seuils(opts);
  const maintenant = (opts.maintenant || Date.now)();
  const moi = ctx.appareil.id;
  const exclus = retires(ctx, fiches);
  const actifs = fiches.filter((f) => f.id !== moi && !exclus.has(f.id) && f.vu_le && maintenant - Date.parse(f.vu_le) < S.inactif);
  let limite = FIN;
  const bloquants = [];
  for (const f of actifs) {
    const l = f.lu && f.lu[moi];
    if (!l) { bloquants.push(f.id); limite = ''; continue; }
    if (l < limite) limite = l;
  }
  const couverts = [...snapshotsAnnonces(fiches), monSnapshot].filter((s) => s && s.vecteur).map((s) => s.vecteur[moi]);
  const couvert = maxNom(couverts);
  const rien = { supprimes: [], purge: purgeAvant || null, limite: limite === FIN ? null : limite, couvert, bloquants };
  if (!limite || !couvert) return rien;

  const supprimes = (await t.listerSegments(moi)).filter((s) => s <= limite && s <= couvert);
  for (const s of supprimes) await t.supprimerSegment(moi, s);
  return { ...rien, supprimes, purge: maxNom([purgeAvant, ...supprimes]) || null };
}

/**
 * Oubli du contenu des tuiles supprimees depuis plus de 90 jours : champs,
 * marques et vues sont remis a vide PAR DES OPS ordinaires, propagees et
 * fusionnees comme toute modification. Un effacement local direct ne
 * convergerait pas (un appareil qui recoit une restauration juste avant sa
 * propre purge garderait le contenu). La pierre tombale reste : un appareil
 * absent plus longtemps la recoit encore par le snapshot, au lieu de faire
 * revivre la tuile. Pas d'oubli tant qu'un conflit « supprimee ici, modifiee
 * la-bas » est ouvert : l'utilisateur tranche d'abord.
 * L'image n'etant plus referencee, le menage des images la retire ensuite.
 * @returns {string[]} cles videes
 */
function purgerTombes(ctx, opts = {}) {
  const S = seuils(opts);
  const maintenant = (opts.maintenant || Date.now)();
  const d = ctx.d;
  const conflit = d.prepare("SELECT 1 FROM conflits WHERE entite='locale' AND cle=? AND champ='_existe' AND resolu=0");
  const contenu = d.prepare(`SELECT entite, champ FROM etat WHERE cle=? AND valeur IS NOT NULL
    AND entite IN ('locale', 'tag', 'stat') AND NOT (entite='locale' AND champ='_existe')`);
  const videes = [];
  d.transaction(() => {
    for (const r of d.prepare("SELECT cle, valeur, hlc FROM etat WHERE entite='locale' AND champ='_existe'").all()) {
      if (JSON.parse(r.valeur) === 1 || maintenant - lireHlc(r.hlc).ms < S.agePierreTombale || conflit.get(r.cle)) continue;
      const champs = contenu.all(r.cle);
      if (!champs.length) continue;
      for (const c of champs) moteur.ecrire(ctx, c.entite, r.cle, c.champ, null);
      videes.push(r.cle);
    }
  })();
  return videes;
}

/** Date a laquelle une pierre tombale sera purgee (pour la Corbeille). */
function purgeeLe(hlcPierreTombale, opts = {}) {
  return new Date(lireHlc(hlcPierreTombale).ms + seuils(opts).agePierreTombale).toISOString();
}

module.exports = {
  SEUILS, curseurs, tetes, besoins, rattraper, snapshotSiUtile, purgerSegments, purgerTombes, purgeeLe, retires,
  retiresEnVigueur,
  noterSegmentEnvoye, snapshotsAnnonces
};
