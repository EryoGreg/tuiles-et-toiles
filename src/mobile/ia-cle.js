'use strict';
/**
 * Mobile : remplace src/main/ia-cle.js (meme interface). La cle API Claude est
 * rangee dans le stockage prive de l'appli (/data/ia-cle.json, IndexedDB de la
 * WebView, inaccessible aux autres applis Android). Jamais synchronisee ni
 * journalisee.
 */

const fs = require('fs');

const FICHIER = '/data/ia-cle.json';
const RE_CLE = /^sk-ant-[A-Za-z0-9_-]{20,}$/;

function configurer() { /* emplacement fixe */ }

function lire() {
  try { return JSON.parse(fs.readFileSync(FICHIER, 'utf8')).cle || null; } catch { return null; }
}

function definir(cle) {
  const c = String(cle || '').trim();
  if (!RE_CLE.test(c)) return { erreur: 'Ce n’est pas une clé API Anthropic (elle commence par « sk-ant- »).' };
  fs.writeFileSync(FICHIER, JSON.stringify({ cle: c }));
  return { ok: true };
}

function oublier() { try { fs.rmSync(FICHIER, { force: true }); } catch { /* deja absente */ } }

function etat() {
  const c = lire();
  return { configure: !!c, apercu: c ? 'sk-ant-…' + c.slice(-4) : null };
}

module.exports = { configurer, lire, definir, oublier, etat, RE_CLE };
