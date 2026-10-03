'use strict';
/**
 * Cle API Claude de l'utilisateur (lecture amelioree des cartels, cartel-ia.js).
 * PC : chiffree par safeStorage (DPAPI Windows) dans %APPDATA%\Tuiles et
 * Toiles\ia-cle.bin, comme le jeton Drive. Jamais synchronisee, jamais
 * journalisee (journal.js masque les chaines « sk-ant-… »), jamais dans le depot.
 * Mobile : src/mobile/ia-cle.js (meme interface).
 */

const fs = require('fs');
const path = require('path');

let fichier = null;
const RE_CLE = /^sk-ant-[A-Za-z0-9_-]{20,}$/;

function configurer(dossier) { fichier = path.join(dossier, 'ia-cle.bin'); }

function safe() {
  try { return require('electron').safeStorage; } catch { return null; }
}

function lire() {
  try {
    const buf = fs.readFileSync(fichier);
    const s = safe();
    return s && s.isEncryptionAvailable() ? s.decryptString(buf) : buf.toString('utf8');
  } catch { return null; }
}

/** @returns {{ ok: true } | { erreur }} */
function definir(cle) {
  const c = String(cle || '').trim();
  if (!RE_CLE.test(c)) return { erreur: 'Ce n’est pas une clé API Anthropic (elle commence par « sk-ant- »).' };
  const s = safe();
  fs.mkdirSync(path.dirname(fichier), { recursive: true });
  fs.writeFileSync(fichier, s && s.isEncryptionAvailable() ? s.encryptString(c) : Buffer.from(c, 'utf8'));
  return { ok: true };
}

function oublier() { try { fs.rmSync(fichier, { force: true }); } catch { /* deja absente */ } }

/** Ce que l'interface peut montrer : presence et 4 derniers caracteres. */
function etat() {
  const c = lire();
  return { configure: !!c, apercu: c ? 'sk-ant-…' + c.slice(-4) : null };
}

module.exports = { configurer, lire, definir, oublier, etat, RE_CLE };
