'use strict';
/**
 * Entree d'un appareil dans un espace de synchro (dossier partage, Drive).
 *
 * Chaque appareil publie une fiche (appareils/<id>.json). A la PREMIERE
 * synchro, si son prefixe de ref est deja pris par un autre appareil, il en
 * prend un libre et renumerote ses tuiles locales : elles n'ont encore jamais
 * ete partagees, donc personne n'a vu leur ancien numero (« ref figee » vaut a
 * partir du partage). Le premier appareil garde 'L'.
 *
 * Course : deux appareils qui rejoignent en meme temps avec le meme prefixe se
 * voient en relisant les fiches ; celui dont l'id est le plus grand cede.
 */

const moteur = require('./moteur');

// Sans I ni O (confondus avec 1 et 0). 'L' d'abord : le prefixe historique.
const LETTRES = 'LMNPQRSTUVWXYZABCDEFGHJK'.split('');

function prefixeLibre(pris) {
  for (const l of LETTRES) if (!pris.has(l)) return l;
  for (const a of LETTRES) for (const b of LETTRES) if (!pris.has(a + b)) return a + b;
  throw new Error('Plus de prefixe de ref disponible.');
}

/**
 * Renumerote les tuiles creees sur cet appareil sous `ancien` : ancien3,
 * ancien7… -> nouveau1, nouveau2… dans l'ordre de creation.
 * @returns {Array<{ cle, avant, apres }>}
 */
function renumeroter(ctx, ancien, nouveau) {
  const motif = new RegExp('^' + ancien + '(\\d+)$');
  const suffixe = '-' + ctx.appareil.id;
  const tuiles = ctx.d.prepare("SELECT cle, valeur, hlc FROM etat WHERE entite='locale' AND champ='ref_local'")
    .all()
    .map((r) => ({ cle: r.cle, ref: JSON.parse(r.valeur), hlc: r.hlc }))
    .filter((t) => typeof t.ref === 'string' && motif.test(t.ref) && t.hlc.endsWith(suffixe))
    .sort((a, b) => (a.hlc < b.hlc ? -1 : 1));
  const faites = [];
  ctx.d.transaction(() => {
    tuiles.forEach((t, i) => {
      const apres = nouveau + (i + 1);
      moteur.ecrire(ctx, 'locale', t.cle, 'ref_local', apres);
      faites.push({ cle: t.cle, avant: t.ref, apres });
    });
  })();
  return faites;
}

/**
 * Publie / met a jour la fiche de cet appareil ; a la premiere entree, regle
 * le prefixe. Modifie ctx.appareil.prefixe_ref si besoin.
 * @param {{ nom: string, enregistrerPrefixe: (p: string) => void }} opts
 * @returns {Promise<{ premiereFois, prefixe, renumerotees: Array }>}
 */
async function rejoindre(ctx, transport, { nom, enregistrerPrefixe }) {
  const id = ctx.appareil.id;
  const maintenant = new Date().toISOString();
  const fiches = await transport.lireFiches();
  const moi = fiches.find((f) => f.id === id);

  const resume = (l) => l.map((f) => ({ id: f.id, nom: f.nom, prefixe: f.prefixe_ref, vu_le: f.vu_le }));
  if (moi) {
    await transport.ecrireFiche({ ...moi, nom, vu_le: maintenant });
    return { premiereFois: false, prefixe: ctx.appareil.prefixe_ref, renumerotees: [], appareils: resume(fiches) };
  }

  const renumerotees = [];
  const changer = (pris) => {
    const ancien = ctx.appareil.prefixe_ref;
    const nouveau = prefixeLibre(pris);
    renumerotees.push(...renumeroter(ctx, ancien, nouveau));
    ctx.appareil.prefixe_ref = nouveau;
    enregistrerPrefixe(nouveau);
  };

  let autres = fiches.filter((f) => f.id !== id);
  if (autres.some((f) => f.prefixe_ref === ctx.appareil.prefixe_ref)) {
    changer(new Set(autres.map((f) => f.prefixe_ref)));
  }
  for (let essai = 0; essai < 5; essai++) {
    await transport.ecrireFiche({ id, nom, prefixe_ref: ctx.appareil.prefixe_ref, rejoint_le: maintenant, vu_le: maintenant });
    autres = (await transport.lireFiches()).filter((f) => f.id !== id);
    const rival = autres.find((f) => f.prefixe_ref === ctx.appareil.prefixe_ref && f.id < id);
    if (!rival) break;
    changer(new Set(autres.map((f) => f.prefixe_ref)));
  }
  // Fusionner les renumerotations successives d'une meme tuile (course).
  const parCle = new Map();
  for (const r of renumerotees) {
    const deja = parCle.get(r.cle);
    parCle.set(r.cle, deja ? { ...deja, apres: r.apres } : r);
  }
  return {
    premiereFois: true, prefixe: ctx.appareil.prefixe_ref, renumerotees: [...parCle.values()],
    appareils: resume(await transport.lireFiches())
  };
}

module.exports = { rejoindre, renumeroter, prefixeLibre };
