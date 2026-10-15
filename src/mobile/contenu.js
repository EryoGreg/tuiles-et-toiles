'use strict';
/**
 * Contenu livre avec l'appli (pack.db, manifeste des images, vignettes) recopie
 * UNE fois dans les donnees de l'appli (Directory.Data/contenu/).
 *
 * Pourquoi : une mise a jour partielle (PLAN-maj-partielle.md) remplacera le
 * code web seul. Capacitor sert alors TOUT https://localhost/ depuis le dossier
 * du paquet telecharge : le contenu livre dans l'APK n'y serait plus. Recopie
 * ici, il est servi par son adresse fichier (Capacitor.convertFileSrc) quel que
 * soit le code qui tourne, et le paquet web reste petit (~1 Mo, sans les 15 Mo
 * de vignettes).
 *
 *   preparer()  au demarrage : d'ou lire le pack et le manifeste, adresse des
 *               vignettes. Copie a jour (meme id que contenu.json livre) ->
 *               donnees ; sinon -> fichiers livres, et la copie est a faire.
 *   copier()    en arriere-plan apres le demarrage : recopie ce qui manque ou a
 *               change (reprend ou elle s'etait arretee), etat.json ecrit EN
 *               DERNIER (une copie interrompue n'est jamais prise pour prete).
 *   pret()      la copie correspond au contenu livre (condition d'une mise a
 *               jour partielle, etape 3).
 *
 * Navigateur (test) : rien n'est recopie, tout vient des fichiers livres.
 */

const journal = require('../main/journal');

const DOSSIER = 'contenu';
const FICHIERS = ['pack.db', 'images-manifest.json'];

let livre = null;       // contenu.json livre (null : code web sans contenu, ex. paquet telecharge)
let copie = null;       // etat.json de la copie { id, le } ou null
let baseDonnees = null; // adresse lisible par la page du dossier contenu/ (avec / final)
let source = 'livre';
let enCours = null;

function natif() {
  const C = typeof window !== 'undefined' && window.Capacitor;
  return !!(C && C.isNativePlatform && C.isNativePlatform());
}
const fsCap = () => require('@capacitor/filesystem');

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

/**
 * @returns {Promise<{ pack: ArrayBuffer, manifeste: object, vignettes: string, source: string }>}
 *   vignettes : prefixe d'adresse des vignettes ('vignettes/' ou adresse fichier)
 */
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
  const base = source === 'donnees' ? baseDonnees : '';
  const [pack, manifeste] = await Promise.all([
    fetch(base + 'pack.db').then((r) => { if (!r.ok) throw new Error('pack.db : ' + r.status); return r.arrayBuffer(); }),
    fetch(base + 'images-manifest.json').then((r) => r.json()).catch(() => ({ ref: null, images: {} }))
  ]);
  return { pack, manifeste, vignettes: base + 'vignettes/', source };
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
  const ecrire = async (chemin, url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(url + ' : ' + r.status);
    const octets = Buffer.from(await r.arrayBuffer());
    await Filesystem.writeFile({ path: chemin, directory: Directory.Data, data: octets.toString('base64'), recursive: true });
    return octets.length;
  };
  // Plus de copie prete pendant qu'on la refait (etat.json reecrit a la fin).
  if (copie) { await Filesystem.deleteFile({ path: DOSSIER + '/etat.json', directory: Directory.Data }).catch(() => {}); copie = null; }
  // Copie commencee pour un AUTRE contenu : on ne reprend rien de ses vignettes.
  const enCoursDe = await lireJson(DOSSIER + '/copie.json');
  const reprise = enCoursDe && enCoursDe.id === livre.id;
  await ecrireJson(DOSSIER + '/copie.json', { id: livre.id });

  let octets = 0, nFichiers = 0, gardees = 0;
  for (const f of FICHIERS) { octets += await ecrire(DOSSIER + '/' + f, f); nFichiers++; }

  const presentes = new Map();
  try {
    const r = await Filesystem.readdir({ path: DOSSIER + '/vignettes', directory: Directory.Data });
    for (const e of r.files || []) presentes.set(e.name, e.size);
  } catch { /* dossier pas encore cree */ }
  for (const [nom, taille] of Object.entries(livre.vignettes)) {
    if (reprise && presentes.get(nom) === taille) { gardees++; continue; }
    octets += await ecrire(DOSSIER + '/vignettes/' + nom, 'vignettes/' + encodeURIComponent(nom));
    nFichiers++;
  }
  let retirees = 0;
  for (const nom of presentes.keys()) {
    if (livre.vignettes[nom] !== undefined) continue;
    await Filesystem.deleteFile({ path: DOSSIER + '/vignettes/' + nom, directory: Directory.Data }).catch(() => {});
    retirees++;
  }
  copie = { id: livre.id, le: new Date().toISOString() };
  await ecrireJson(DOSSIER + '/etat.json', copie);
  const r = { fait: true, id: livre.id, fichiers: nFichiers, gardees, retirees, octets, ms: Date.now() - t0 };
  journal.evt('app', 'contenu-copie', r);
  return r;
}

const pret = () => !!(livre && copie && copie.id === livre.id);

/** Pour le rapport d'erreur et le journal. */
function etat() {
  return { source, livre: livre && livre.id, copie: copie && copie.id, pret: pret(), enCours: !!enCours };
}

module.exports = { preparer, copier, pret, etat };
