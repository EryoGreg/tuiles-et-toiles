'use strict';
/**
 * Noms d'appareils faciles a retenir (« Ananas dansant », « Carotte
 * infiltree »), a la maniere de LocalSend ou Mullvad. Tires une fois, a la
 * creation de l'identite (appareil.js), puis gardes et publies dans la fiche
 * de synchro ; renommables dans Options. Ils servent a RECONNAITRE un
 * appareil (« Ananas dansant · Android »), pas a l'identifier : l'identite
 * reste l'id aleatoire.
 *
 * nomPour(id) est deterministe : meme id, meme nom (tests, et un nom stable
 * meme si appareil.json est recree a partir du meme id).
 */

// [nom, genre] — fruits, legumes, animaux : concrets, sans connotation.
const NOMS = [
  ['Ananas', 'm'], ['Carotte', 'f'], ['Poire', 'f'], ['Citron', 'm'], ['Mangue', 'f'], ['Radis', 'm'],
  ['Figue', 'f'], ['Navet', 'm'], ['Prune', 'f'], ['Melon', 'm'], ['Cerise', 'f'], ['Poireau', 'm'],
  ['Olive', 'f'], ['Brocoli', 'm'], ['Noisette', 'f'], ['Artichaut', 'm'], ['Framboise', 'f'], ['Concombre', 'm'],
  ['Tomate', 'f'], ['Kiwi', 'm'], ['Courgette', 'f'], ['Potiron', 'm'], ['Myrtille', 'f'], ['Abricot', 'm'],
  ['Loutre', 'f'], ['Hibou', 'm'], ['Tortue', 'f'], ['Renard', 'm'], ['Baleine', 'f'], ['Castor', 'm'],
  ['Mouette', 'f'], ['Hérisson', 'm'], ['Grenouille', 'f'], ['Panda', 'm'], ['Abeille', 'f'], ['Lama', 'm'],
  ['Girafe', 'f'], ['Koala', 'm'], ['Libellule', 'f'], ['Pingouin', 'm'], ['Chouette', 'f'], ['Écureuil', 'm']
];

// [masculin, feminin]
const ADJECTIFS = [
  ['dansant', 'dansante'], ['infiltré', 'infiltrée'], ['patient', 'patiente'], ['rêveur', 'rêveuse'],
  ['curieux', 'curieuse'], ['malicieux', 'malicieuse'], ['tranquille', 'tranquille'], ['pressé', 'pressée'],
  ['joyeux', 'joyeuse'], ['discret', 'discrète'], ['intrépide', 'intrépide'], ['élégant', 'élégante'],
  ['songeur', 'songeuse'], ['vaillant', 'vaillante'], ['espiègle', 'espiègle'], ['studieux', 'studieuse'],
  ['flâneur', 'flâneuse'], ['moustachu', 'moustachue'], ['pétillant', 'pétillante'], ['zélé', 'zélée'],
  ['farceur', 'farceuse'], ['astucieux', 'astucieuse'], ['bavard', 'bavarde'], ['serein', 'sereine'],
  ['voyageur', 'voyageuse'], ['gourmand', 'gourmande'], ['audacieux', 'audacieuse'], ['savant', 'savante'],
  ['rieur', 'rieuse'], ['prudent', 'prudente'], ['distrait', 'distraite'], ['sportif', 'sportive'],
  ['poétique', 'poétique'], ['lumineux', 'lumineuse'], ['fringant', 'fringante'], ['câlin', 'câline']
];

/** Nom pour un id d'appareil (8 hex) ; deterministe. */
function nomPour(id) {
  const n = parseInt(String(id || '').slice(0, 8), 16);
  const v = Number.isFinite(n) ? n : 0;
  const [nom, genre] = NOMS[v % NOMS.length];
  const adj = ADJECTIFS[Math.floor(v / NOMS.length) % ADJECTIFS.length];
  return nom + ' ' + adj[genre === 'f' ? 1 : 0];
}

/** Nom saisi par l'utilisateur, nettoye ; null s'il est inutilisable. */
function nomValide(s) {
  const t = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return t && t.length <= 40 ? t : null;
}

module.exports = { nomPour, nomValide, NOMS, ADJECTIFS };
