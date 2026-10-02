'use strict';
/**
 * Erreurs de synchro dites a l'utilisateur : un TYPE et une phrase courte
 * (« Synchro impossible : pas de connexion. »), le detail technique restant au
 * journal (`detail`). Classement sur le message, d'ou qu'il vienne (Drive en
 * REST, connexion Google mobile, dossier partage, moteur).
 *
 *   session   jeton refuse : reconnecter Google Drive
 *   compte    Google Drive pas connecte
 *   reseau    pas de connexion (silencieux en synchro auto, regle 1)
 *   limite    Google Drive limite les acces (quota, trop de requetes)
 *   drive     Google Drive en panne / ne repond pas
 *   refus     Google Drive refuse l'acces a un fichier ou dossier
 *   dossier   dossier partage introuvable (cle USB debranchee…)
 *   encours   une synchro tourne deja
 *   interne   erreur de l'appli : « Signaler un probleme »
 */

const TYPES = {
  session: 'session Google expirée — reconnecte Google Drive',
  compte: 'Google Drive n’est pas connecté',
  reseau: 'pas de connexion',
  limite: 'Google Drive limite les accès pour l’instant, nouvel essai plus tard',
  drive: 'Google Drive ne répond pas (panne passagère)',
  refus: 'Google Drive a refusé l’accès à un fichier',
  dossier: 'dossier de synchro introuvable (clé USB débranchée, lecteur absent ?)',
  encours: 'une synchro est déjà en cours',
  interne: 'erreur dans l’application (Options → Signaler un problème)'
};

const MOTIFS = [
  ['session', /session google expir|invalid_grant|jeton (refus|vide)|\b401\b|autorisation drive manquante/i],
  ['compte', /non connect/i],
  ['reseau', /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|ERR_INTERNET|ERR_NAME|ERR_NETWORK|ERR_CONNECTION|ERR_TIMED_OUT|ERR_ADDRESS|failed to fetch|fetch failed|networkerror|network request failed|socket hang up|hors ligne|aborted|abortError|joindre/i],
  ['limite', /\b429\b|ratelimit|userratelimit|quota|limite les/i],
  ['drive', /(drive|envoi|lecture drive|suppression drive)\s*5\d\d|\b50[0234]\b|backendError|internalError/i],
  ['refus', /(drive|envoi|lecture drive|suppression drive)\s*40[34]|insufficient|forbidden|notFound|introuvable sur le drive/i],
  ['dossier', /dossier de synchro introuvable|aucun dossier|cl[ée] usb|impossible d.[ée]crire dans ce dossier/i],
  ['encours', /d[ée]j[aà] en cours/i]
];

/**
 * @param {{ erreur?: string, jetonMort?: boolean }|Error|string} r
 * @returns {{ type: string, libelle: string, message: string }}
 */
function classer(r) {
  const brut = typeof r === 'string' ? r : (r && (r.erreur || r.message)) || '';
  let type = r && r.jetonMort ? 'session' : null;
  if (!type) for (const [t, re] of MOTIFS) if (re.test(brut)) { type = t; break; }
  if (!type) type = 'interne';
  return { type, libelle: TYPES[type], message: 'Synchro impossible : ' + TYPES[type] + '.' };
}

module.exports = { classer, TYPES };
