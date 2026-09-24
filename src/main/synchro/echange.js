'use strict';
/**
 * Echange des ops avec les autres appareils, a travers un transport.
 *
 * Transport (async) — memoire (tests), dossier local (E2c), Google Drive (E2d) :
 *   listerAppareils()                 -> [id]
 *   listerSegments(appareil)          -> [nom]
 *   lireSegment(appareil, nom)        -> [op]
 *   ecrireSegment(appareil, nom, ops) -> jamais d'ecrasement : nom deja pris = rien
 *
 * Chaque appareil n'ecrit QUE dans son propre dossier, en segments immuables
 * nommes `<premiere hlc>_<derniere hlc>` : aucun conflit d'ecriture possible,
 * et le tri des noms suit l'ordre d'emission. Un envoi interrompu puis refait
 * produit un segment qui recouvre le precedent : les ops deja connues sont
 * ignorees a la reception (idempotence par hlc).
 *
 * Les ops ne sont PAS regroupees avant envoi : supprimer une op intermediaire
 * casserait la chaine des `base` chez les autres (faux conflits).
 */

const moteur = require('./moteur');

const COLONNES = 'hlc, appareil, entite, cle, champ, valeur, base, vus';

function curseur(ctx, app) {
  const r = ctx.d.prepare('SELECT valeur FROM sync WHERE cle=?').get('curseur:' + app);
  return r ? r.valeur : null;
}

/**
 * Envoie les ops locales pas encore parties (toutes, y compris celles d'une
 * ancienne identite de cet appareil).
 * @returns {Promise<{ poussees: number, segment?: string }>}
 */
async function pousser(ctx, transport) {
  const ops = ctx.d.prepare(`SELECT ${COLONNES} FROM changements WHERE pousse=0 ORDER BY hlc`).all();
  if (!ops.length) return { poussees: 0 };
  const derniere = ops[ops.length - 1].hlc;
  const nom = ops[0].hlc + '_' + derniere;
  await transport.ecrireSegment(ctx.appareil.id, nom, ops);
  // Borne par `derniere` : une ecriture locale survenue pendant l'envoi
  // reste a pousser.
  ctx.d.prepare('UPDATE changements SET pousse=1 WHERE pousse=0 AND hlc <= ?').run(derniere);
  return { poussees: ops.length, segment: nom };
}

/**
 * Recupere et applique les segments des autres appareils non encore lus.
 * Toutes les ops recues sont appliquees en une transaction, triees par HLC.
 * Si une op fait echouer l'application (horloge distante dereglee), rien
 * n'est applique et les curseurs ne bougent pas.
 * @returns {Promise<{ appliquees, rejetees, conflits, bilan }>}
 */
async function tirer(ctx, transport) {
  const recues = [];
  const curseurs = {};
  const parAppareil = {};
  for (const app of await transport.listerAppareils()) {
    if (app === ctx.appareil.id) continue;
    const cur = curseur(ctx, app);
    const tous = await transport.listerSegments(app);
    const noms = tous.filter((n) => !cur || n > cur).sort();
    let ops = 0;
    for (const nom of noms) {
      const l = await transport.lireSegment(app, nom);
      ops += l.length;
      recues.push(...l);
    }
    parAppareil[app] = { segments: tous.length, nouveaux: noms.length, ops, curseur: cur };
    if (noms.length) curseurs[app] = noms[noms.length - 1];
  }

  const bilan = {};
  ctx.d.transaction(() => {
    recues.sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0));
    for (const op of recues) {
      const r = moteur.appliquer(ctx, op);
      bilan[r] = (bilan[r] || 0) + 1;
    }
    const maj = ctx.d.prepare('INSERT OR REPLACE INTO sync (cle, valeur) VALUES (?, ?)');
    for (const [app, nom] of Object.entries(curseurs)) maj.run('curseur:' + app, nom);
  })();

  const appliquees = bilan.avance || 0;
  return {
    appliquees,
    rejetees: bilan.rejetee || 0,
    conflits: ctx.d.prepare('SELECT COUNT(*) n FROM conflits WHERE resolu=0').get().n,
    bilan,
    parAppareil,
    // Ops refusees (mal formees) : a examiner, elles viennent d'un autre appareil.
    exemplesRejetes: recues.filter((op) => !moteur.valide(op)).slice(0, 5)
  };
}

module.exports = { pousser, tirer };
