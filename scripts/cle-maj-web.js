'use strict';
/**
 * Cle Ed25519 des mises a jour partielles (PLAN-maj-partielle.md, « Securite »).
 *
 * La cle PRIVEE vit hors de tout depot : %USERPROFILE%\.cles-maj\maj-web-ed25519.pem
 * (une seule pour Tuiles & Toiles et Bristol). A SAUVEGARDER avec debug.keystore :
 * perdue, plus aucun paquet web ne serait accepte par les appareils (l'APK
 * complet reste possible). La cle PUBLIQUE est embarquee dans l'appli
 * (src/mobile/cle-maj-web.js).
 *
 *   node scripts/cle-maj-web.js          cree la cle si absente, affiche la publique
 *   require('./cle-maj-web').signer(buf) signature base64 (paquet-web.js)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const FICHIER = process.env.TT_CLE_MAJ_WEB || path.join(os.homedir(), '.cles-maj', 'maj-web-ed25519.pem');

function privee() {
  if (!fs.existsSync(FICHIER)) throw new Error('Cle de signature absente : ' + FICHIER + ' (node scripts/cle-maj-web.js pour la creer, ou la restaurer depuis la sauvegarde).');
  return crypto.createPrivateKey(fs.readFileSync(FICHIER));
}

/** Cle publique brute (32 octets), en base64. */
function publique(cle = privee()) {
  const der = crypto.createPublicKey(cle).export({ type: 'spki', format: 'der' });
  return der.subarray(der.length - 32).toString('base64');
}

/** Signature Ed25519 de `octets`, en base64. */
function signer(octets) {
  return crypto.sign(null, Buffer.from(octets), privee()).toString('base64');
}

if (require.main === module) {
  if (!fs.existsSync(FICHIER)) {
    fs.mkdirSync(path.dirname(FICHIER), { recursive: true });
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(FICHIER, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    console.log('Cle creee : ' + FICHIER + '\nA SAUVEGARDER avec debug.keystore.');
  } else {
    console.log('Cle existante : ' + FICHIER);
  }
  console.log('Cle publique (src/mobile/cle-maj-web.js) : ' + publique());
}

module.exports = { FICHIER, signer, publique };
