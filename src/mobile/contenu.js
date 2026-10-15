'use strict';
/**
 * Contenu livre avec l'appli (pack ou decks, manifestes, vignettes, images)
 * recopie UNE fois dans les donnees de l'appli (Directory.Data/contenu/).
 *
 * Pourquoi : une mise a jour partielle (PLAN-maj-partielle.md) remplace le
 * code web seul. Capacitor sert alors TOUT https://localhost/ depuis le dossier
 * du paquet telecharge : le contenu livre dans l'APK n'y serait plus. Recopie
 * ici, il est servi par son adresse fichier (Capacitor.convertFileSrc) quel que
 * soit le code qui tourne, et le paquet web reste petit.
 *
 *   preparer()  au demarrage -> { base, source } : prefixe des adresses du
 *               contenu ('' = fichiers livres, ou adresse de la copie).
 *               Copie a jour (meme id que contenu.json livre) -> donnees ;
 *               sinon fichiers livres, et la copie est a faire.
 *   copier()    en arriere-plan apres le demarrage : recopie ce qui manque ou
 *               a change (reprend ou elle s'etait arretee), etat.json ecrit EN
 *               DERNIER (une copie interrompue n'est jamais prise pour prete).
 *   pret()      la copie correspond au contenu livre (condition d'une mise a
 *               jour partielle).
 *
 * contenu.json : scripts/contenu-livre.js. Navigateur (test) : rien n'est
 * recopie, tout vient des fichiers livres. Meme fichier dans T&T et Bristol.
 */

const journal = require('../main/journal');

const DOSSIER = 'contenu';

let livre = null;       // contenu.json livre { id, fichiers: { chemin: octets } } (null : code web sans contenu)
let copie = null;       // etat.json de la copie { id, le } ou null
let baseDonnees = null; // adresse lisible par la page du dossier contenu/ (avec / final)
let source = 'livre';
let enCours = null;

function natif() {
  const C = typeof window !== 'undefined' && window.Capacitor;
  return !!(C && C.isNativePlatform && C.isNativePlatform());
}
const fsCap = () => require('@capacitor/filesystem');
const adresse = (rel) => rel.split('/').map(encodeURIComponent).join('/');

async function lireJson(chemin) {
  const { Filesystem, Directory, Encoding } = fsCap();
  try {
    const r = await Filesystem.readFile({ path: chemin, directory: Directory.Data, encoding: Encoding.UTF8 });
    return JSON.parse(r.data);
  } catch { return null; }
}
async function ecrireJson(chemin, v) {
  const { Filesystem, Directory, Encoding } = fsCap();
  await Filesystem.writeFile({ path: chemin, directory: Directory.Data, encoding: Encoding.UTF8, data: JSON.stringify(v), recursive: true });
}

/** @returns {Promise<{ base: string, source: 'livre' | 'donnees' }>} */
async function preparer() {
  livre = await fetch('contenu.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (natif()) {
    const { Filesystem, Directory } = fsCap();
    copie = await lireJson(DOSSIER + '/etat.json');
    try {
      const { uri } = await Filesystem.getUri({ path: DOSSIER, directory: Directory.Data });
      baseDonnees = window.Capacitor.convertFileSrc(uri).replace(/\/+$/, '') + '/';
    } catch (e) { journal.erreur('app', 'contenu-adresse', e); }
    if (baseDonnees && copie && (!livre || copie.id === livre.id)) source = 'donnees';
    else if (!livre) throw new Error('Contenu introuvable : ni copie dans les données, ni fichiers livrés.');
  }
  return { base: source === 'donnees' ? baseDonnees : '', source };
}

/** Recopie le contenu livre dans les donnees (a lancer apres le demarrage). */
function copier() {
  if (!natif() || !livre || pret()) return Promise.resolve({ fait: false });
  if (!enCours) enCours = copier0().finally(() => { enCours = null; });
  return enCours;
}

async function copier0() {
  const { Filesystem, Directory } = fsCap();
  const { Buffer } = require('buffer');
  const t0 = Date.now();
  // Plus de copie prete pendant qu'on la refait (etat.json reecrit a la fin).
  if (copie) { await Filesystem.deleteFile({ path: DOSSIER + '/etat.json', directory: Directory.Data }).catch(() => {}); copie = null; }
  // Copie commencee pour un AUTRE contenu : on ne reprend rien.
  const enCoursDe = await lireJson(DOSSIER + '/copie.json');
  const reprise = !!(enCoursDe && enCoursDe.id === livre.id);
  await ecrireJson(DOSSIER + '/copie.json', { id: livre.id });

  // Ce qui est deja la, dossier par dossier (ceux du contenu livre).
  const dossiers = new Set(Object.keys(livre.fichiers).map((rel) => rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''));
  const presents = new Map();
  for (const d of dossiers) {
    try {
      const r = await Filesystem.readdir({ path: DOSSIER + (d ? '/' + d : ''), directory: Directory.Data });
      for (const e of r.files || []) if (e.type !== 'directory') presents.set(d ? d + '/' + e.name : e.name, e.size);
    } catch { /* dossier pas encore cree */ }
  }

  let octets = 0, nFichiers = 0, gardes = 0, retires = 0;
  for (const [rel, taille] of Object.entries(livre.fichiers)) {
    if (reprise && presents.get(rel) === taille) { gardes++; continue; }
    const r = await fetch(adresse(rel));
    if (!r.ok) throw new Error(rel + ' : ' + r.status);
    const o = Buffer.from(await r.arrayBuffer());
    await Filesystem.writeFile({ path: DOSSIER + '/' + rel, directory: Directory.Data, data: o.toString('base64'), recursive: true });
    octets += o.length;
    nFichiers++;
  }
  for (const rel of presents.keys()) {
    if (livre.fichiers[rel] !== undefined || rel === 'etat.json' || rel === 'copie.json') continue;
    await Filesystem.deleteFile({ path: DOSSIER + '/' + rel, directory: Directory.Data }).catch(() => {});
    retires++;
  }
  copie = { id: livre.id, le: new Date().toISOString() };
  await ecrireJson(DOSSIER + '/etat.json', copie);
  const r = { fait: true, id: livre.id, fichiers: nFichiers, gardes, retires, octets, ms: Date.now() - t0 };
  journal.evt('app', 'contenu-copie', r);
  return r;
}

// Code web sans contenu livre (paquet d'une mise a jour partielle) : la copie fait foi.
const pret = () => !!(copie && (!livre || copie.id === livre.id));

/** Pour le rapport d'erreur et le journal. */
function etat() {
  return { source, livre: livre && livre.id, copie: copie && copie.id, pret: pret(), enCours: !!enCours };
}

module.exports = { preparer, copier, pret, etat };
