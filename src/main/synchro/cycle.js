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
const { rejoindre } = require('./rejoindre');

/**
 * @param {object} ctx  contexte moteur
 * @param {object} t    transport
 * @param {{ nom, enregistrerPrefixe, maintenant?, seuils?,
 *   pas?: (nom, fn) => Promise, crochets?: { imagesEnvoi?, imagesReception? } }} o
 */
async function executer(ctx, t, o) {
  const pas = o.pas || ((_nom, fn) => fn());
  const crochets = o.crochets || {};
  const maintenant = o.maintenant || Date.now;
  const opts = { maintenant, seuils: o.seuils };
  const moi = ctx.appareil.id;

  if (t.preparer) await pas('preparer', () => t.preparer(moi));
  const rj = await pas('rejoindre', () => rejoindre(ctx, t, { nom: o.nom, enregistrerPrefixe: o.enregistrerPrefixe }));
  const fiches = rj.fiches;
  const rattrapage = await pas('rattrapage', () => compaction.rattraper(ctx, t, fiches));
  const tombes = await pas('tombes', () => compaction.purgerTombes(ctx, opts));
  const stats = await pas('stats', () => moteur.emettreStats(ctx));
  const imagesEnvoyees = crochets.imagesEnvoi ? await pas('images-envoi', crochets.imagesEnvoi) : 0;
  const pousse = await pas('pousser', () => echange.pousser(ctx, t));
  compaction.noterSegmentEnvoye(ctx, pousse.segment);
  const tire = await pas('tirer', () => echange.tirer(ctx, t));
  const imagesRecues = crochets.imagesReception ? await pas('images-reception', crochets.imagesReception) : 0;

  const snapshot = await pas('snapshot', () => compaction.snapshotSiUtile(ctx, t, fiches, opts));
  const maFiche = fiches.find((f) => f.id === moi) || {};
  const monSnapshot = snapshot ? { nom: snapshot.nom, vecteur: snapshot.vecteur } : (maFiche.snapshot || null);
  const purge = await pas('purge', () => compaction.purgerSegments(ctx, t, fiches, monSnapshot, maFiche.purge, opts));
  await pas('fiche', () => t.ecrireFiche({
    ...maFiche, id: moi, nom: o.nom, prefixe_ref: ctx.appareil.prefixe_ref,
    vu_le: new Date(maintenant()).toISOString(),
    lu: compaction.curseurs(ctx), purge: purge.purge, snapshot: monSnapshot
  }));

  return { rejoindre: rj, rattrapage, stats, imagesEnvoyees, pousse, tire, imagesRecues, snapshot, purge, tombes };
}

module.exports = { executer };
