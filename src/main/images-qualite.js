'use strict';
/**
 * Reglage « Qualite des images » (Options → Images des œuvres), commun PC et
 * mobile :
 *   reduite    aucun telechargement : la version reduite embarquee (480 px)
 *              partout, sauf grande image deja en cache (gratuite)
 *   affichage  la grande image est telechargee quand une tuile s'affiche en
 *              grand, puis gardee (mobile : en Wi-Fi seulement)
 *   tout       toutes les grandes images telechargees d'avance pour le
 *              hors-ligne (mobile : en Wi-Fi seulement)
 * Remplace la case « Tout garder pour le hors-ligne » (images_hors_ligne,
 * jusqu'en 0.3.12) : coche -> tout, decoche -> affichage. Defaut : tout sur
 * PC (comme avant), affichage sur mobile (la case n'y faisait rien).
 */

const QUALITES = ['reduite', 'affichage', 'tout'];

/**
 * @param {(cle: string, defaut: string) => string} reglage  db.reglage
 * @param {{ mobile?: boolean }} o
 */
function lire(reglage, { mobile = false } = {}) {
  const q = reglage('images_qualite', '');
  if (QUALITES.includes(q)) return q;
  const ancien = reglage('images_hors_ligne', '');
  if (ancien === '1') return 'tout';
  if (ancien === '0') return 'affichage';
  return mobile ? 'affichage' : 'tout';
}

module.exports = { QUALITES, lire };
