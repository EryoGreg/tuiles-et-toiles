'use strict';
/**
 * Synchro automatique (reglage synchro_auto, active par defaut). Declencheurs :
 *   - le lancement (6 s apres)
 *   - une modification locale, une fois le calme revenu : 20 s sans nouvelle
 *     modification (on ne synchronise pas au milieu d'une saisie)
 *   - toutes les 15 min, pour recevoir ce que font les autres appareils ;
 *     toutes les 2 min tant que des conflits sont ouverts (un choix fait sur
 *     un autre appareil les ferme ici sans attendre)
 *   - juste apres qu'un conflit a ete tranche (differer), et a l'ouverture de
 *     l'ecran Conflits (declencher force)
 *   - le reveil de l'ordinateur
 *   - la fermeture de l'app, s'il reste des modifications a envoyer (10 s max)
 *
 * Jamais de fenetre ni de navigateur : une session Google expiree met la
 * synchro Drive automatique en pause (index.js) jusqu'au prochain clic sur
 * « Synchroniser ». Un echec (hors ligne, cle USB debranchee…) est silencieux
 * et retente 5 min plus tard (regle 1 : la synchro ne bloque jamais rien).
 *
 * Aucune dependance a l'app : tout arrive par les options (tests).
 */

const DELAIS = {
  lancement: 6e3,
  verification: 15e3,   // frequence de la surveillance
  calme: 20e3,          // sans nouvelle modification avant d'envoyer
  periode: 15 * 60e3,   // reception reguliere
  periodeConflits: 2 * 60e3,   // idem, tant que des conflits sont ouverts
  apresEchec: 5 * 60e3,
  fermeture: 10e3
};

/**
 * @param {{
 *   actif: () => boolean,
 *   cibles: () => string[],                 // 'drive', 'dossier' (configurees et joignables)
 *   lancer: (cible, raison) => Promise<object>,   // resultat de service.synchroniser*
 *   aEnvoyer: () => number,                 // ops locales pas encore parties
 *   conflitsOuverts?: () => number,
 *   reseauPermis?: () => boolean,           // mobile : faux en donnees mobiles si « Wi-Fi seulement »
 *   journal?: { evt, avertir },
 *   maintenant?: () => number,
 *   delais?: object
 * }} o
 */
function creerAuto(o) {
  const D = { ...DELAIS, ...(o.delais || {}) };
  const maintenant = o.maintenant || Date.now;
  const journal = o.journal || { evt() {}, avertir() {} };
  let enCours = null;          // promesse de la synchro auto en cours
  let derniere = maintenant(); // derniere synchro auto (la periode part du lancement)
  let reprendreApres = 0;      // pause apres un echec
  let vuN = 0;                 // nombre d'ops en attente au dernier passage
  let changeLe = 0;            // quand ce nombre a bouge
  let minuteurs = [];

  async function executer(raison, { forcer = false } = {}) {
    if (enCours) return enCours;
    // Pas de synchro automatique hors Wi-Fi si l'utilisateur l'a demande ; un
    // geste explicite (conflit tranche…) passe quand meme.
    if (!forcer && o.reseauPermis && !o.reseauPermis()) return null;
    const cibles = o.cibles();
    if (!cibles.length) return null;
    enCours = (async () => {
      journal.evt('synchro', 'auto', { raison, cibles, aEnvoyer: o.aEnvoyer() });
      const resultats = {};
      for (const c of cibles) {
        let r;
        try { r = await o.lancer(c, raison); } catch (e) { r = { erreur: e.message || String(e) }; }
        resultats[c] = r;
        // Synchro manuelle deja en cours : pas un echec, on repassera.
        if (r && r.erreur && !r.enCoursPar) {
          reprendreApres = maintenant() + D.apresEchec;
          journal.avertir('synchro', 'auto-echec', { cible: c, raison, erreur: r.erreur, reprise: new Date(reprendreApres).toISOString() });
        }
      }
      derniere = maintenant();
      return resultats;
    })();
    try { return await enCours; } finally { enCours = null; }
  }

  /** Un passage de surveillance (toutes les 15 s). */
  function tic() {
    if (!o.actif() || enCours) return null;
    const t = maintenant();
    const n = o.aEnvoyer();
    if (n !== vuN) { vuN = n; changeLe = t; }
    if (t < reprendreApres) return null;
    if (n > 0 && t - changeLe >= D.calme) return executer('modification');
    const periode = o.conflitsOuverts && o.conflitsOuverts() > 0 ? D.periodeConflits : D.periode;
    if (t - derniere >= periode) return executer(periode === D.periode ? 'periodique' : 'conflits-ouverts');
    return null;
  }

  function demarrer() {
    arreter();
    minuteurs = [
      setTimeout(() => { if (o.actif()) executer('lancement'); }, D.lancement),
      setInterval(tic, D.verification)
    ];
  }

  function arreter() {
    for (const m of minuteurs) { clearTimeout(m); clearInterval(m); }
    minuteurs = [];
  }

  /**
   * Declenchement ponctuel (reveil de l'ordinateur…), sauf pendant une pause
   * d'echec. forcer : suite directe d'une action de l'utilisateur (conflit
   * tranche, ecran Conflits ouvert) -> meme synchro auto desactivee ou en
   * pause ; si une synchro auto tourne deja, une autre suit, pour emporter ce
   * qui vient d'etre ecrit.
   */
  async function declencher(raison, { forcer = false } = {}) {
    if (!forcer && (!o.actif() || maintenant() < reprendreApres)) return null;
    if (forcer && enCours) { try { await enCours; } catch { /* sans importance */ } }
    return executer(raison, { forcer });
  }

  let minuteurDiffere = null;
  /**
   * Synchro forcee dans `ms` (0 = tout de suite), repoussee a chaque nouvel
   * appel : trancher plusieurs conflits d'affilee n'en fait partir qu'une.
   */
  function differer(raison, ms) {
    if (minuteurDiffere) clearTimeout(minuteurDiffere);
    minuteurDiffere = null;
    if (!ms) return declencher(raison, { forcer: true });
    return new Promise((resoudre) => {
      minuteurDiffere = setTimeout(() => { minuteurDiffere = null; resoudre(declencher(raison, { forcer: true })); }, ms);
    });
  }

  /**
   * Avant de quitter : envoie ce qui reste, sans jamais retenir la fermeture
   * plus de 10 s. @returns {Promise<'rien'|'fini'|'delai'>}
   */
  async function avantFermeture() {
    if (!o.actif() || (!enCours && (!o.aEnvoyer() || !o.cibles().length))) return 'rien';
    const envoi = enCours || executer('fermeture');
    let minuteur;
    const delai = new Promise((r) => { minuteur = setTimeout(() => r('delai'), D.fermeture); });
    const issue = await Promise.race([envoi.then(() => 'fini', () => 'fini'), delai]);
    clearTimeout(minuteur);
    journal.evt('synchro', 'auto-fermeture', { issue, resteAEnvoyer: o.aEnvoyer() }, issue === 'delai' ? 'WARN' : 'INFO');
    return issue;
  }

  return { demarrer, arreter, tic, declencher, differer, avantFermeture, _executer: executer };
}

module.exports = { creerAuto, DELAIS };
