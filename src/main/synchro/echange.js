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

/**
 * Resume d'un lot d'ops en termes utilisateur (le bilan affiche). Une tuile
 * creee = une dizaine d'ops (existence, numero, titre…) : compter les ops
 * donnerait « 10 modifications » pour une seule tuile. Les compteurs de vues
 * (stat) ne sont pas des changements pour l'utilisateur.
 * @param {Array} ops  ops appliquees (reception) ou envoyees
 * @param {(op) => *} existaitAvant  pour une op _existe : valeur d'existence
 *   precedente (1, pierre tombale, ou null si tuile inconnue)
 */
function resumer(ops, existaitAvant) {
  const nouvelles = new Set(), modifiees = new Set(), supprimees = new Set(), restaurees = new Set();
  const corrections = new Set();
  let marques = 0, archives = 0;
  for (const op of ops) {
    const v = op.valeur == null ? null : JSON.parse(op.valeur);
    if (op.entite === 'locale' && op.champ === '_existe') {
      const avant = existaitAvant(op);
      if (v === 1) (avant == null ? nouvelles : restaurees).add(op.cle);
      else supprimees.add(op.cle);
    } else if (op.entite === 'locale') modifiees.add(op.cle);
    else if (op.entite === 'override') corrections.add(op.cle);
    else if (op.entite === 'tag') marques++;
    else if (op.entite === 'archive') archives++;
  }
  for (const c of [...nouvelles, ...supprimees, ...restaurees]) modifiees.delete(c);
  return {
    tuilesNouvelles: nouvelles.size, tuilesModifiees: modifiees.size, tuilesSupprimees: supprimees.size,
    tuilesRestaurees: restaurees.size, oeuvresCorrigees: corrections.size, marques, archives
  };
}

/**
 * Applique un lot d'ops (trie par HLC) et resume ce qui a change. Commun a la
 * reception d'une synchro et a l'import d'une sauvegarde.
 * @param {{ pousse?: 0|1 }} o  voir moteur.appliquer
 * @returns {{ bilan, appliquees: object[], resume }}
 */
function fusionner(ctx, ops, { pousse = 1 } = {}) {
  const bilan = {};
  const appliquees = [];
  const existenceAvant = new Map();
  ctx.d.transaction(() => {
    const tries = [...ops].sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0));
    for (const op of tries) {
      if (op.entite === 'locale' && op.champ === '_existe' && !existenceAvant.has(op.cle)) {
        existenceAvant.set(op.cle, moteur.valeur(ctx, 'locale', op.cle, '_existe'));
      }
      const r = moteur.appliquer(ctx, op, { pousse, remplace: op.remplace });
      bilan[r] = (bilan[r] || 0) + 1;
      if (r === 'avance') appliquees.push(op);
    }
  })();
  return { bilan, appliquees, resume: resumer(appliquees, (op) => existenceAvant.get(op.cle)) };
}

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
  // Nom croissant d'un envoi a l'autre : les autres appareils ne lisent que
  // les segments de nom superieur a leur curseur. Des ops anciennes a envoyer
  // (import d'une sauvegarde) donneraient un nom plus petit -> jamais lues.
  // La fin du nom borne aussi les ops couvertes (compaction.rattraper).
  const prec = ctx.d.prepare("SELECT valeur FROM sync WHERE cle='dernier_segment'").get();
  let debut = ops[0].hlc, fin = derniere;
  if (prec && prec.valeur && debut <= prec.valeur) {
    debut = ctx.horloge.tic();
    if (fin < debut) fin = debut;
  }
  const nom = debut + '_' + fin;
  await transport.ecrireSegment(ctx.appareil.id, nom, ops);
  // Borne par `derniere` : une ecriture locale survenue pendant l'envoi
  // reste a pousser.
  ctx.d.prepare('UPDATE changements SET pousse=1 WHERE pousse=0 AND hlc <= ?').run(derniere);
  // Envoi : une existence sans version precedente (base) = tuile creee ici.
  const resume = resumer(ops, (op) => (op.base ? 1 : null));
  return { poussees: ops.length, segment: nom, resume };
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

  let f;
  ctx.d.transaction(() => {
    // Ops recues : jamais d'accompagnement `remplace` (propre a chaque base).
    f = fusionner(ctx, recues.map((op) => ({ ...op, remplace: 0 })));
    const maj = ctx.d.prepare('INSERT OR REPLACE INTO sync (cle, valeur) VALUES (?, ?)');
    for (const [app, nom] of Object.entries(curseurs)) maj.run('curseur:' + app, nom);
  })();

  const { bilan } = f;
  return {
    appliquees: bilan.avance || 0,
    resume: f.resume,
    rejetees: bilan.rejetee || 0,
    conflits: ctx.d.prepare('SELECT COUNT(*) n FROM conflits WHERE resolu=0').get().n,
    bilan,
    parAppareil,
    // Ops refusees (mal formees) : a examiner, elles viennent d'un autre appareil.
    exemplesRejetes: recues.filter((op) => !moteur.valide(op)).slice(0, 5)
  };
}

module.exports = { pousser, tirer, resumer, fusionner };
