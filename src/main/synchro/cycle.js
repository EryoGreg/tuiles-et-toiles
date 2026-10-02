'use strict';
/**
 * Un cycle de synchro complet, independant de l'app (service.js l'appelle
 * avec ses crochets : images, journal ; les tests l'appellent tel quel).
 *
 *   preparer -> rejoindre (fiche, prefixe) -> rattrapage (snapshot si trou)
 *   -> oubli des tuiles supprimees depuis 90 j -> compteurs de vues
 *   -> [images envoi] -> pousser -> tirer -> [images reception]
 *   -> snapshot si utile -> purge de ses segments -> fiche (accuse de lecture)
 */

const moteur = require('./moteur');
const echange = require('./echange');
const compaction = require('./compaction');
const { rejoindre, renumeroterSuite, memeFiche } = require('./rejoindre');

// Signe de vie : la fiche est reecrite au moins toutes les 6 h meme sans
// changement (vu_le : appareils muets, retraits, candidats au remplacement).
const POULS_MS = 6 * 3600e3;

/**
 * @param {object} ctx  contexte moteur
 * @param {object} t    transport
 * @param {{ nom, type?, materiel?, enregistrerPrefixe, exigerDecision?, maintenant?, seuils?,
 *   pas?: (nom, fn) => Promise, crochets?: { imagesEnvoi?, imagesReception? } }} o
 *   exigerDecision : un appareil neuf demande « remplace-t-il un autre ? »
 *   avant sa premiere inscription (rejoindre.js, DecisionRequise).
 *   pouls : delai max sans reecrire sa fiche (defaut 6 h).
 */
async function executer(ctx, t, o) {
  const pas = o.pas || ((_nom, fn) => fn());
  const crochets = o.crochets || {};
  const maintenant = o.maintenant || Date.now;
  const opts = { maintenant, seuils: o.seuils };
  const moi = ctx.appareil.id;

  if (t.preparer) await pas('preparer', () => t.preparer(moi));
  const rj = await pas('rejoindre', () => rejoindre(ctx, t, {
    nom: o.nom, type: o.type, materiel: o.materiel, enregistrerPrefixe: o.enregistrerPrefixe,
    enregistrerAppareil: o.enregistrerAppareil,
    exigerDecision: o.exigerDecision, maintenant
  }));
  const fiches = rj.fiches;
  const rattrapage = await pas('rattrapage', () => compaction.rattraper(ctx, t, fiches));
  const tombes = await pas('tombes', () => compaction.purgerTombes(ctx, opts));
  const stats = await pas('stats', () => moteur.emettreStats(ctx));
  const imagesEnvoyees = crochets.imagesEnvoi ? await pas('images-envoi', crochets.imagesEnvoi) : 0;
  let pousse, tire;
  const envoyer = async () => {
    pousse = await pas('pousser', () => echange.pousser(ctx, t));
    compaction.noterSegmentEnvoye(ctx, pousse.segment);
  };
  if (rj.renumeroterApres) {
    // Remplacement : recevoir d'abord les tuiles de l'appareil remplace, puis
    // numeroter celles d'ici a la suite (P8 apres son P7), puis envoyer.
    tire = await pas('tirer', () => echange.tirer(ctx, t));
    rj.renumerotees.push(...renumeroterSuite(ctx, rj.renumeroterApres, ctx.appareil.prefixe_ref));
    await envoyer();
  } else {
    await envoyer();
    tire = await pas('tirer', () => echange.tirer(ctx, t));
  }
  const imagesRecues = crochets.imagesReception ? await pas('images-reception', crochets.imagesReception) : 0;

  const snapshot = await pas('snapshot', () => compaction.snapshotSiUtile(ctx, t, fiches, opts));
  // Base : la fiche que rejoindre vient d'ecrire (remplace, type, rejoint_le…).
  const maFiche = rj.fiche || fiches.find((f) => f.id === moi) || {};
  const monSnapshot = snapshot ? { nom: snapshot.nom, vecteur: snapshot.vecteur } : (maFiche.snapshot || null);
  const purge = await pas('purge', () => compaction.purgerSegments(ctx, t, fiches, monSnapshot, maFiche.purge, opts));
  // Fiche : reecrite seulement si son contenu change (accuses de lecture,
  // purge, snapshot, retraits…), si elle date de plus que le pouls, ou si un
  // autre appareil m'a retire depuis (me signaler annule le retrait). Chaque
  // ecriture reveille les autres appareils : pas d'ecriture pour rien.
  const nouvelle = {
    ...maFiche, id: moi, nom: maFiche.nom || o.nom, prefixe_ref: ctx.appareil.prefixe_ref,
    lu: compaction.curseurs(ctx), purge: purge.purge, snapshot: monSnapshot,
    retires: JSON.parse((ctx.d.prepare("SELECT valeur FROM sync WHERE cle='appareils_retires'").get() || {}).valeur || '[]')
  };
  const vuLe = maFiche.vu_le || '';
  const retireIci = fiches.some((f) => f.id !== moi
    && (Array.isArray(f.retires) ? f.retires : []).some((r) => r && r.id === moi && String(r.le || '') >= vuLe));
  const ficheEcrite = !memeFiche(nouvelle, maFiche) || retireIci
    || maintenant() - (Date.parse(vuLe) || 0) >= (o.pouls != null ? o.pouls : POULS_MS);
  if (ficheEcrite) {
    await pas('fiche', () => t.ecrireFiche({ ...nouvelle, vu_le: new Date(maintenant()).toISOString() }));
  }

  return {
    rejoindre: rj, rattrapage, stats, imagesEnvoyees, pousse, tire, imagesRecues, snapshot, purge, tombes,
    ficheEcrite: ficheEcrite || !!rj.ficheEcrite
  };
}

module.exports = { executer };
