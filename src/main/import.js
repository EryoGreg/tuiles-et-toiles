'use strict';
/**
 * Fabrique le pack :  data/manifest.csv + data/registre.json  ->  data/pack.db
 *
 * pack.db ne contient QUE du contenu (table oeuvres + pack_meta). Les tables
 * user_* vivent dans utilisateur.db et ne sont jamais touchees ici.
 *
 * Le registre gele l'identifiant stable et le numero d'affichage de chaque
 * oeuvre. Une oeuvre absente du registre = nouvelle : on lui attribue un id et
 * le ref suivant, et on complete le registre (jamais on ne modifie l'existant).
 *
 *     npm run import
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { SCHEMA_PACK } = require('./db');
const { calculer, normaliser } = require('./masques');
const dates = require('./dates');

const RACINE = path.resolve(__dirname, '..', '..');
const CSV = path.join(RACINE, 'data', 'manifest.csv');
const REGISTRE = path.join(RACINE, 'data', 'registre.json');
const PACK = path.join(RACINE, 'data', 'pack.db');
const VERSION = '1.1.0';   // 1.1.0 : dates a la convention de dates.js

/** Lecteur CSV minimal : separateur ';', guillemets doubles echappes. */
function lireCsv(texte) {
  const lignes = [];
  let champ = '', ligne = [], dansGuillemets = false;
  for (let i = 0; i < texte.length; i++) {
    const c = texte[i];
    if (dansGuillemets) {
      if (c === '"') {
        if (texte[i + 1] === '"') { champ += '"'; i++; } else dansGuillemets = false;
      } else champ += c;
    } else if (c === '"') dansGuillemets = true;
    else if (c === ';') { ligne.push(champ); champ = ''; }
    else if (c === '\n') { ligne.push(champ); lignes.push(ligne); ligne = []; champ = ''; }
    else if (c !== '\r') champ += c;
  }
  if (champ || ligne.length) { ligne.push(champ); lignes.push(ligne); }
  if (!lignes.length) return [];
  const entetes = lignes[0].map((h) => h.replace(/^﻿/, '').trim());
  return lignes.slice(1)
    .filter((l) => l.some((v) => v.trim()))
    .map((l) => Object.fromEntries(entetes.map((h, i) => [h, (l[i] || '').trim()])));
}

function hashTexte(o) {
  return crypto.createHash('sha1')
    .update([o.artiste, o.titre, o.date, o.lieu, o.description, o.tags].join(' '))
    .digest('hex')
    .slice(0, 16);
}

function main() {
  for (const [nom, f] of [['manifeste', CSV], ['registre', REGISTRE]]) {
    if (!fs.existsSync(f)) {
      console.error(`${nom} introuvable : ${f}`);
      if (f === REGISTRE) console.error('  -> lance d abord : node scripts/registre-init.js');
      process.exit(1);
    }
  }

  const brutes = lireCsv(fs.readFileSync(CSV, 'utf8'));
  const registre = JSON.parse(fs.readFileSync(REGISTRE, 'utf8'));
  let refMax = Math.max(0, ...Object.values(registre).map((e) => parseInt(e.ref, 10) || 0));
  let nouveaux = 0;

  // Chaque oeuvre recoit son id / ref GELE depuis le registre.
  const oeuvres = brutes.map((o) => {
    let e = registre[o.id];
    if (!e) {
      refMax += 1;
      e = { id: 'p:' + crypto.randomBytes(5).toString('hex'), ref: String(refMax).padStart(3, '0') };
      registre[o.id] = e;
      nouveaux += 1;
    }
    return {
      id: e.id,
      ref: e.ref,
      artiste: o.artiste || '',
      titre: o.titre || '',
      date: dates.normaliser(o.date || ''),
      lieu: o.lieu || '',
      description: o.description || '',
      tags: o.tags || '',
      image: o.image || '',
      largeur: parseInt(o.largeur, 10) || null,
      hauteur: parseInt(o.hauteur, 10) || null,
      octets: parseInt(o.octets, 10) || null
    };
  });

  if (nouveaux) {
    fs.writeFileSync(REGISTRE, JSON.stringify(registre, null, 1) + '\n');
    console.log('Registre complete : %d nouvelle(s) oeuvre(s)', nouveaux);
  }

  const t0 = Date.now();
  const masques = calculer(oeuvres);   // clef = id stable (valeur('image') renvoie o.id)
  console.log('Masques calcules en %d ms', Date.now() - t0);

  fs.rmSync(PACK, { force: true });
  fs.rmSync(PACK + '-wal', { force: true });
  fs.rmSync(PACK + '-shm', { force: true });
  const d = new Database(PACK);
  d.exec(SCHEMA_PACK);

  const inserer = d.prepare(`
    INSERT INTO oeuvres
      (id, ref, artiste, titre, date, lieu, description, tags,
       image, largeur, hauteur, octets, hash_texte, recherche, masques)
    VALUES
      (@id, @ref, @artiste, @titre, @date, @lieu, @description, @tags,
       @image, @largeur, @hauteur, @octets, @hash_texte, @recherche, @masques)
  `);
  const meta = d.prepare('INSERT OR REPLACE INTO pack_meta (cle, valeur) VALUES (?, ?)');

  d.transaction(() => {
    for (const o of oeuvres) {
      inserer.run({
        ...o,
        hash_texte: hashTexte(o),
        recherche: normaliser([o.artiste, o.titre, o.date, o.lieu, o.description, o.tags].join(' ')),
        masques: JSON.stringify(masques.get(o.id) || [])
      });
    }
    const contenu = JSON.stringify(oeuvres) + '|' + [...masques.entries()].sort().join(';');
    meta.run('version', VERSION);
    meta.run('cree_le', new Date().toISOString());
    meta.run('n_oeuvres', String(oeuvres.length));
    meta.run('hash', crypto.createHash('sha1').update(contenu).digest('hex').slice(0, 16));
  })();

  d.pragma('wal_checkpoint(TRUNCATE)');
  d.close();
  fs.rmSync(PACK + '-wal', { force: true });
  fs.rmSync(PACK + '-shm', { force: true });

  const stats = oeuvres.map((o) => (masques.get(o.id) || []).length).sort((a, b) => a - b);
  console.log('pack.db : %d oeuvres | masques min %d / med %d / max %d',
    oeuvres.length, stats[0], stats[stats.length >> 1], stats[stats.length - 1]);
  const bloquees = oeuvres.filter((o) => (masques.get(o.id) || []).length === 0);
  console.log('Sans aucun masque valide : %d', bloquees.length);
  console.log('-> %s', PACK);
}

if (require.main === module) main();
module.exports = { lireCsv, hashTexte };
