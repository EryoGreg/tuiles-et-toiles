'use strict';
/**
 * Entree d'un appareil dans un espace de synchro (dossier partage, Drive).
 *
 * Chaque appareil publie une fiche (appareils/<id>.json) : nom memorable,
 * type, empreinte materielle, lettre de ref. A la PREMIERE synchro, si sa
 * lettre est deja prise par un autre appareil, il en prend une libre et
 * renumerote ses tuiles locales : elles n'ont encore jamais ete partagees,
 * donc personne n'a vu leur ancien numero (« ref figee » vaut a partir du
 * partage). Le premier appareil garde 'L'.
 *
 * Course : deux appareils qui rejoignent en meme temps avec la meme lettre se
 * voient en relisant les fiches ; celui dont l'id est le plus grand cede.
 *
 * REMPLACEMENT (telephone change, appli reinstallee, PC reinstalle) : un
 * nouvel appareil peut reprendre le NOM et la LETTRE d'un ancien, qui est
 * retire. L'id reste neuf (deux appareils vivants sous le meme id
 * corrompraient la synchro).
 *   - automatique si l'empreinte materielle est la meme (meme telephone, meme
 *     poste Windows et meme utilisateur) : l'ancienne installation ne peut
 *     plus tourner a cote ;
 *   - sinon, decision de l'utilisateur AVANT la premiere inscription
 *     (opts.exigerDecision) : DecisionRequise est levee avec les candidats,
 *     rien n'est ecrit ; la decision est rangee dans appareil.json
 *     (`remplace` = id | 'aucun') et la synchro relancee.
 * Les tuiles creees ici avant de rejoindre sont renumerotees APRES reception
 * des tuiles de l'ancien appareil (cycle.js : `renumeroterApres`), a la suite
 * de son plus grand numero : jamais de doublon.
 * Un ancien appareil qui revient et constate qu'un autre l'a remplace prend
 * une nouvelle lettre pour ses PROCHAINES tuiles (les existantes gardent la
 * leur, deja partagee) : `supplante`.
 */

const moteur = require('./moteur');
const { retiresEnVigueur } = require('./compaction');

// Sans I ni O (confondus avec 1 et 0). 'L' d'abord : le prefixe historique.
const LETTRES = 'LMNPQRSTUVWXYZABCDEFGHJK'.split('');
const RECENT_MS = 24 * 3600e3;   // vu depuis moins : sans doute encore en service

class DecisionRequise extends Error {
  constructor(candidats) {
    super('Avant la première synchro : cet appareil en remplace-t-il un autre ?');
    this.decisionRequise = true;
    this.candidats = candidats;
  }
}

function prefixeLibre(pris) {
  for (const l of LETTRES) if (!pris.has(l)) return l;
  for (const a of LETTRES) for (const b of LETTRES) if (!pris.has(a + b)) return a + b;
  throw new Error('Plus de prefixe de ref disponible.');
}

/** Plus grand numero deja donne a la lettre `prefixe` (toutes tuiles connues, sauf celles de `saufAppareil`). */
function plusGrandNumero(ctx, prefixe, saufAppareil) {
  const motif = new RegExp('^' + prefixe + '(\\d+)$');
  let n = 0;
  for (const r of ctx.d.prepare("SELECT valeur, hlc FROM etat WHERE entite='locale' AND champ='ref_local'").all()) {
    if (saufAppareil && r.hlc.endsWith('-' + saufAppareil)) continue;
    const m = motif.exec(JSON.parse(r.valeur) || '');
    if (m) n = Math.max(n, parseInt(m[1], 10));
  }
  return n;
}

/**
 * Renumerote les tuiles creees sur cet appareil sous `ancien` : ancien3,
 * ancien7… -> nouveau<depart>, nouveau<depart+1>… dans l'ordre de creation.
 * @returns {Array<{ cle, avant, apres }>}
 */
function renumeroter(ctx, ancien, nouveau, depart = 1, { nonPartageesSeulement = false } = {}) {
  const motif = new RegExp('^' + ancien + '(\\d+)$');
  const suffixe = '-' + ctx.appareil.id;
  const envoyee = ctx.d.prepare('SELECT pousse FROM changements WHERE hlc=?');
  const tuiles = ctx.d.prepare("SELECT cle, valeur, hlc FROM etat WHERE entite='locale' AND champ='ref_local'")
    .all()
    .map((r) => ({ cle: r.cle, ref: JSON.parse(r.valeur), hlc: r.hlc }))
    .filter((t) => typeof t.ref === 'string' && motif.test(t.ref) && t.hlc.endsWith(suffixe))
    // Numero deja envoye = deja vu ailleurs : jamais renumerote.
    .filter((t) => !nonPartageesSeulement || ((envoyee.get(t.hlc) || {}).pousse === 0))
    .sort((a, b) => (a.hlc < b.hlc ? -1 : 1));
  const faites = [];
  ctx.d.transaction(() => {
    tuiles.forEach((t, i) => {
      const apres = nouveau + (depart + i);
      if (apres === t.ref) return;
      moteur.ecrire(ctx, 'locale', t.cle, 'ref_local', apres);
      faites.push({ cle: t.cle, avant: t.ref, apres });
    });
  })();
  return faites;
}

/** Apres reprise de la lettre d'un appareil remplace : tuiles d'ici a la suite des siennes. */
function renumeroterSuite(ctx, provisoire, prefixe) {
  return renumeroter(ctx, provisoire, prefixe, plusGrandNumero(ctx, prefixe, ctx.appareil.id) + 1);
}

/** Appareils proposables comme « remplace » : tous les autres, les muets d'abord. */
function candidats(fiches, id, maintenant) {
  const autres = fiches.filter((f) => f.id !== id);
  const r = retiresEnVigueur(autres.flatMap((f) => (Array.isArray(f.retires) ? f.retires : [])), autres, id);
  const deja = new Set(autres.map((f) => f.remplace).filter(Boolean));
  return autres
    .filter((f) => !deja.has(f.id))   // deja remplace par un autre : sa lettre est reprise
    .map((f) => ({
      id: f.id, nom: f.nom || f.id, type: f.type || null, prefixe: f.prefixe_ref, vu_le: f.vu_le || null,
      retire: r.has(f.id), recent: !!f.vu_le && maintenant - Date.parse(f.vu_le) < RECENT_MS
    }))
    .sort((a, b) => (a.recent !== b.recent ? (a.recent ? 1 : -1) : String(b.vu_le || '').localeCompare(String(a.vu_le || ''))));
}

function lireRetires(ctx) {
  try { return JSON.parse((ctx.d.prepare("SELECT valeur FROM sync WHERE cle='appareils_retires'").get() || {}).valeur || '[]'); }
  catch { return []; }
}

/**
 * Publie / met a jour la fiche de cet appareil ; a la premiere entree, regle
 * la lettre (ou reprend celle d'un appareil remplace). Modifie ctx.appareil.
 * @param {{ nom?, type?, materiel?, enregistrerPrefixe: (p) => void, enregistrerAppareil?: () => void,
 *   exigerDecision?: boolean, maintenant?: () => number }} opts
 *   enregistrerPrefixe : la lettre a change (p = nouvelle lettre) ;
 *   enregistrerAppareil : autre changement d'appareil.json (inscrit, nom, remplace).
 * @returns {Promise<{ premiereFois, prefixe, renumerotees, appareils, fiches, fiche,
 *   remplacement?, renumeroterApres?, supplante? }>}
 */
async function rejoindre(ctx, transport, opts) {
  const a = ctx.appareil;
  const id = a.id;
  const t = (opts.maintenant || Date.now)();
  const maintenant = new Date(t).toISOString();
  const enregistrerPrefixe = opts.enregistrerPrefixe || (() => {});
  const enregistrerAppareil = opts.enregistrerAppareil || (() => {});
  const nom = () => opts.nom || a.nom || id;
  const signes = () => ({
    ...(opts.type || a.type ? { type: opts.type || a.type } : {}),
    ...(opts.materiel || a.materiel ? { materiel: opts.materiel || a.materiel } : {})
  });
  const fiches = await transport.lireFiches();
  const moi = fiches.find((f) => f.id === id);

  const resume = (l) => {
    const r = retiresEnVigueur(l.flatMap((f) => (Array.isArray(f.retires) ? f.retires : [])), l, id);
    return l.map((f) => ({
      id: f.id, nom: f.nom, type: f.type || null, prefixe: f.prefixe_ref, vu_le: f.vu_le, retire: r.has(f.id),
      remplace: f.remplace || null
    }));
  };

  if (moi) {
    // Identite deja inscrite : la fiche fait foi pour la lettre (copie de
    // secours d'appareil.json plus ancienne que la derniere renumerotation).
    const lettreAvant = a.prefixe_ref;
    let change = false;
    if (moi.prefixe_ref && moi.prefixe_ref !== a.prefixe_ref) a.prefixe_ref = moi.prefixe_ref;
    // Un autre appareil declare me remplacer (j'etais cru perdu) et ma lettre
    // est portee ailleurs — par lui, ou par celui qui l'a remplace a son tour
    // (chaine A <- B <- C) : nouvelle lettre pour mes prochaines tuiles.
    let supplante = null;
    const remplacant = fiches.find((f) => f.id !== id && f.remplace === id);
    const porteur = fiches.find((f) => f.id !== id && f.prefixe_ref === a.prefixe_ref);
    if (remplacant && porteur) {
      const pris = new Set(fiches.filter((f) => f.id !== id).map((f) => f.prefixe_ref));
      const nouveau = prefixeLibre(pris);
      // Tuiles creees ici depuis, pas encore envoyees : personne n'a vu leur
      // numero, qui doublonnerait ceux du remplacant -> nouvelle lettre.
      const renumerotees = renumeroter(ctx, a.prefixe_ref, nouveau, plusGrandNumero(ctx, nouveau) + 1,
        { nonPartageesSeulement: true });
      supplante = {
        par: { id: remplacant.id, nom: remplacant.nom || remplacant.id }, ancienPrefixe: a.prefixe_ref, prefixe: nouveau,
        renumerotees
      };
      a.prefixe_ref = nouveau;
    }
    if (!a.inscrit) { a.inscrit = true; change = true; }
    if (a.prefixe_ref !== lettreAvant) enregistrerPrefixe(a.prefixe_ref);
    else if (change) enregistrerAppareil();
    const fiche = { ...moi, nom: nom(), ...signes(), prefixe_ref: a.prefixe_ref, vu_le: maintenant };
    await transport.ecrireFiche(fiche);
    const toutes = fiches.map((f) => (f.id === id ? fiche : f));
    return {
      premiereFois: false, prefixe: a.prefixe_ref, renumerotees: supplante ? supplante.renumerotees : [],
      appareils: resume(toutes), fiches: toutes, fiche, supplante
    };
  }

  // --- premiere entree --------------------------------------------------------
  const autres = fiches.filter((f) => f.id !== id);
  const proposables = candidats(fiches, id, t);
  let remplace = null;
  let auto = false;
  const materiel = opts.materiel || a.materiel;
  if (materiel) {
    remplace = autres.find((f) => f.materiel === materiel && proposables.some((c) => c.id === f.id)) || null;
    auto = !!remplace;
  }
  if (!remplace && a.remplace && a.remplace !== 'aucun') {
    remplace = autres.find((f) => f.id === a.remplace) || null;
  }
  if (!remplace && a.remplace === undefined && opts.exigerDecision && proposables.length) {
    throw new DecisionRequise(proposables);
  }

  if (remplace) {
    const provisoire = a.prefixe_ref;
    a.prefixe_ref = remplace.prefixe_ref;
    if (!a.nom_perso && remplace.nom) a.nom = remplace.nom;
    a.remplace = remplace.id;
    a.inscrit = true;
    if (a.prefixe_ref !== provisoire) enregistrerPrefixe(a.prefixe_ref);
    enregistrerAppareil();
    const retires = lireRetires(ctx).filter((r) => r && r.id !== remplace.id);
    retires.push({ id: remplace.id, le: maintenant });
    ctx.d.prepare("INSERT OR REPLACE INTO sync (cle, valeur) VALUES ('appareils_retires', ?)").run(JSON.stringify(retires));
    const fiche = {
      id, nom: a.nom || nom(), ...signes(), prefixe_ref: a.prefixe_ref, rejoint_le: maintenant, vu_le: maintenant,
      remplace: remplace.id, retires
    };
    await transport.ecrireFiche(fiche);
    const toutes = [...autres, fiche];
    return {
      premiereFois: true, prefixe: a.prefixe_ref, renumerotees: [], appareils: resume(toutes), fiches: toutes, fiche,
      remplacement: { id: remplace.id, nom: remplace.nom || remplace.id, prefixe: remplace.prefixe_ref, auto },
      renumeroterApres: provisoire
    };
  }

  const renumerotees = [];
  const changer = (pris) => {
    const ancien = a.prefixe_ref;
    const nouveau = prefixeLibre(pris);
    renumerotees.push(...renumeroter(ctx, ancien, nouveau));
    a.prefixe_ref = nouveau;
    enregistrerPrefixe(nouveau);
  };

  let rivaux = autres;
  if (rivaux.some((f) => f.prefixe_ref === a.prefixe_ref)) {
    changer(new Set(rivaux.map((f) => f.prefixe_ref)));
  }
  let fiche = null;
  for (let essai = 0; essai < 5; essai++) {
    fiche = { id, nom: nom(), ...signes(), prefixe_ref: a.prefixe_ref, rejoint_le: maintenant, vu_le: maintenant };
    await transport.ecrireFiche(fiche);
    rivaux = (await transport.lireFiches()).filter((f) => f.id !== id);
    const rival = rivaux.find((f) => f.prefixe_ref === a.prefixe_ref && f.id < id);
    if (!rival) break;
    changer(new Set(rivaux.map((f) => f.prefixe_ref)));
  }
  if (!a.inscrit) { a.inscrit = true; enregistrerAppareil(); }
  // Fusionner les renumerotations successives d'une meme tuile (course).
  const parCle = new Map();
  for (const r of renumerotees) {
    const deja = parCle.get(r.cle);
    parCle.set(r.cle, deja ? { ...deja, apres: r.apres } : r);
  }
  const toutes = await transport.lireFiches();
  return {
    premiereFois: true, prefixe: a.prefixe_ref, renumerotees: [...parCle.values()],
    appareils: resume(toutes), fiches: toutes, fiche: toutes.find((f) => f.id === id) || fiche
  };
}

module.exports = {
  rejoindre, renumeroter, renumeroterSuite, plusGrandNumero, prefixeLibre, candidats, DecisionRequise, RECENT_MS
};
