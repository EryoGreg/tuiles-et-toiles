'use strict';
/**
 * Type de connexion (Wi-Fi ou donnees mobiles), tenu a jour par
 * @capacitor/network. Hors appli (navigateur de test) : considere Wi-Fi.
 */

let type = 'wifi';

async function demarrer() {
  try {
    const { Network } = require('@capacitor/network');
    const s = await Network.getStatus();
    type = s.connected ? s.connectionType : 'none';
    Network.addListener('networkStatusChange', (e) => { type = e.connected ? e.connectionType : 'none'; });
  } catch { type = 'wifi'; }
}

/** Wi-Fi (ou reseau filaire / inconnu hors telephone). */
const wifi = () => type === 'wifi' || type === 'unknown';

module.exports = { demarrer, wifi, type: () => type };
