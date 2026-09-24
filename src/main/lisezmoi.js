'use strict';
/**
 * LISEZMOI.txt deposes dans CHAQUE dossier que l'application cree, en local
 * comme sur Google Drive : l'utilisateur qui tombe dessus doit comprendre a
 * quoi il sert, ce qu'il contient et ce qu'il ne faut pas y toucher.
 *
 * Textes centralises ici (une cle par sorte de dossier). Deposer = ecrire si
 * absent ou different : une nouvelle version de l'app met les textes a jour.
 */

const fs = require('fs');
const path = require('path');

const NOM = 'LISEZMOI.txt';

const titre = (t) => [t, '='.repeat(t.length), ''];

const TEXTES = {
  // Racine partagee : Google Drive ou dossier choisi dans Options.
  racine: [
    ...titre('Dossier « Tuiles et Toiles »'),
    'Ce dossier est créé et géré par l\'application Tuiles et Toiles',
    '(entraînement mémoriel en histoire de l\'art). Il relie tes appareils',
    '(PC, téléphone…) : chacun y dépose ses modifications et lit celles des',
    'autres. Il peut vivre sur Google Drive ou dans un dossier partagé (clé',
    'USB, OneDrive, Dropbox, Syncthing).',
    '',
    'Il ne contient QUE ce que TU as produit : tuiles créées, corrections,',
    'archives, marques (livre / étoile / à revoir). Jamais le contenu du',
    'pack d\'œuvres.',
    '',
    'utilisateur.zip',
    '  Sauvegarde complète de tes données (« Sauvegarder sur Drive »).',
    '  « Restaurer depuis Drive » la relit et remplace les données locales.',
    '',
    'historique/',
    '  Copies automatiques des versions précédentes d\'utilisateur.zip.',
    '',
    'journaux/',
    '  La synchro entre appareils : un sous-dossier par appareil, un',
    '  fichier par envoi. Les appareils fusionnent ces modifications ligne',
    '  à ligne — rien n\'est écrasé.',
    '',
    'appareils/',
    '  Une fiche par appareil inscrit (nom, lettre de ses tuiles L, M…).',
    '',
    'images/',
    '  Les images des tuiles que tu as créées.',
    '',
    'À savoir :',
    '  - Ne renomme ni ne déplace les fichiers : l\'application ne les',
    '    retrouverait plus.',
    '  - Ne supprime pas journaux/ ni images/ tant que tu utilises la',
    '    synchro : un appareil qui n\'a pas encore lu les dernières',
    '    modifications ne les recevrait jamais.',
    '  - Tes données restent aussi sur chaque appareil : supprimer ce',
    '    dossier ne les efface pas, il coupe seulement le lien entre eux.'
  ],

  historique: [
    ...titre('historique/'),
    'Copies automatiques de la sauvegarde utilisateur.zip, faites juste',
    'avant chaque remplacement par l\'application Tuiles et Toiles.',
    '',
    'Filet de sécurité : si une sauvegarde en a écrasé une autre par',
    'erreur, la version d\'avant est ici (le nom porte sa date). Pour la',
    'reprendre : télécharge-la, puis Options → « Importer une sauvegarde… ».',
    '',
    'Tu peux supprimer les plus anciennes pour gagner de la place.'
  ],

  journaux: [
    ...titre('journaux/'),
    'Synchro entre appareils de Tuiles et Toiles. Un sous-dossier par',
    'appareil (son identifiant) ; chaque fichier .ndjson contient une série',
    'de modifications (une par ligne), écrites une seule fois et jamais',
    'modifiées ensuite.',
    '',
    'Ne modifie, ne renomme et ne supprime aucun fichier ici : les autres',
    'appareils les lisent pour se mettre à jour. L\'application fera',
    'elle-même le ménage quand tous les appareils les auront lus.'
  ],

  journal_appareil: [
    ...titre('Modifications d\'un appareil'),
    'Toutes les modifications envoyées par UN appareil Tuiles et Toiles',
    '(son identifiant est le nom de ce dossier ; sa fiche est dans',
    'appareils/). Seul cet appareil écrit ici ; les autres lisent.',
    '',
    'Ne modifie, ne renomme et ne supprime aucun fichier.'
  ],

  appareils: [
    ...titre('appareils/'),
    'Une fiche par appareil inscrit à la synchro Tuiles et Toiles : son',
    'nom, la lettre qui numérote ses tuiles (L1, M1…), sa dernière synchro.',
    '',
    'Supprimer la fiche d\'un appareil que tu n\'utilises plus est sans',
    'danger. Ne modifie pas celles des appareils en service.'
  ],

  images: [
    ...titre('images/'),
    'Images des tuiles créées dans Tuiles et Toiles, partagées entre tes',
    'appareils. Chaque appareil y dépose les siennes et récupère celles',
    'des autres. Les noms sont des identifiants : ne les renomme pas.'
  ],

  sauvegarde: [
    ...titre('Sauvegarde Tuiles et Toiles'),
    'Archive exportée par l\'application Tuiles et Toiles (Options →',
    '« Exporter mes données »). Pour la restaurer : Options → « Importer',
    'une sauvegarde… » — elle REMPLACE les données locales (une copie de',
    'l\'ancienne base est gardée à côté).',
    '',
    'utilisateur.db     Tes données : tuiles créées, corrections, archives,',
    '                   marques, progression, réglages.',
    'images-locales/    Images des tuiles que tu as créées.',
    'manifest.json      Date, version et comptes (vérifiés avant import).',
    '',
    'Ne modifie pas le contenu de l\'archive : l\'import pourrait échouer.'
  ],

  // %APPDATA%\Tuiles et Toiles\ (dossier de donnees de l'installation).
  donnees: [
    ...titre('Données de Tuiles et Toiles sur cet appareil'),
    'Dossier de travail de l\'application Tuiles et Toiles. Ne le déplace',
    'pas et ne modifie pas son contenu pendant que l\'application tourne.',
    '',
    'utilisateur.db     Tes données : tuiles créées, corrections, archives,',
    '                   marques, progression, réglages. LE fichier précieux.',
    'pack.db            Le pack d\'œuvres (contenu fourni, remplaçable).',
    'appareil.json      Identité de cette installation pour la synchro.',
    'images-locales/    Images des tuiles que tu as créées.',
    'logs/              Journal de fonctionnement (utile pour signaler un bug).',
    'drive-jeton.bin    Accès Google Drive, chiffré (si tu l\'as connecté).',
    'utilisateur.db.avant-…',
    '                   Copies de sécurité faites avant un import ou une',
    '                   restauration. Supprimables une fois vérifié que tout',
    '                   va bien.',
    '',
    'Les autres dossiers (Cache, GPUCache, Local Storage…) sont des caches',
    'techniques recréés automatiquement.',
    '',
    'Pour sauvegarder ou changer de poste : Options → « Exporter mes',
    'données (.zip) », ou la synchro entre appareils.'
  ],

  images_locales: [
    ...titre('images-locales/'),
    'Images des tuiles que tu as créées dans Tuiles et Toiles, sur cet',
    'appareil (redimensionnées, ≤ 500 Ko). Référencées par utilisateur.db :',
    'ne les renomme pas et ne les supprime pas à la main — l\'application',
    'fait elle-même le ménage des images qui ne servent plus.'
  ],

  logs: [
    ...titre('logs/'),
    'Journal de fonctionnement de Tuiles et Toiles (journal.log). Aucune',
    'donnée personnelle au-delà de tes actions dans l\'application. Utile',
    'pour comprendre un bug : joins-le à ton signalement. Supprimable.'
  ]
};

function texte(cle) {
  const t = TEXTES[cle];
  if (!t) throw new Error('LISEZMOI inconnu : ' + cle);
  return t.join('\n') + '\n';
}

/**
 * Depose (ou met a jour) le LISEZMOI d'un dossier local. Ne leve jamais :
 * un dossier en lecture seule ne doit pas bloquer l'application.
 */
function deposer(dossier, cle) {
  try {
    fs.mkdirSync(dossier, { recursive: true });
    const chemin = path.join(dossier, NOM);
    const t = texte(cle);
    let actuel = null;
    try { actuel = fs.readFileSync(chemin, 'utf8'); } catch { /* absent */ }
    if (actuel !== t) fs.writeFileSync(chemin, t, 'utf8');
    return true;
  } catch { return false; }
}

module.exports = { NOM, texte, deposer, CLES: Object.keys(TEXTES) };
