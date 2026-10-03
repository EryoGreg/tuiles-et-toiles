'use strict';
/**
 * Bilan de synchro, test de propriete : scenarios tires au hasard (2 a 4
 * appareils, arrivees en cours de route, de 0 a quelques dizaines de tuiles,
 * toutes les actions de l'utilisateur, synchros manuelles et automatiques).
 * Apres CHAQUE synchro, le bilan est confronte a ce qui a reellement change
 * sur l'appareil (tables lues par l'interface) :
 *
 *   Recu  — toute difference visible est comptee dans sa categorie :
 *     nouvelles + restaurees >= tuiles apparues      supprimees >= disparues
 *     modifiees (+ nouvelles) >= tuiles changees      marques >= marques changees
 *     notes >= notes changees      corrigees >= oeuvres du pack corrigees
 *     archives >= archivages changes      revisions >= notes de revision ajoutees
 *   Envoye — un appareil qui avait des changements a envoyer en annonce
 *   Fin    — tous les appareils convergent vers le meme etat
 *
 * C'est le garde-fou de la classe de bug corrigee le 03/10/2026 (donnees
 * arrivees par un rattrapage, non comptees : « Tout etait deja a jour »).
 *
 *     node scripts/lancer-node.js tests/synchro-bilan-proprietes.test.js [nbScenarios] [graine]
 */

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RACINE = path.resolve(__dirname, '..');
const src = (p) => require(path.join(RACINE, 'src/main', p));
const db = src('db');
const etat = src('synchro/etat');
const edition = src('edition');
const jeu = src('jeu');
const appareil = src('synchro/appareil');
const service = src('synchro/service');
const revision = src('revision');
const { viderCaches } = src('synchro/transport-drive');
const { creerFauxDrive } = require('./faux-drive');

const NB = parseInt(process.argv[2] || '20', 10);
const TRACE = !!process.env.TT_TRACE;
let derniereAction = null;
const GRAINE = parseInt(process.argv[3] || '20261004', 10);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-bilanprop-'));
const PACK = path.join(TMP, 'pack.db');
fs.copyFileSync(path.join(RACINE, 'data/pack.db'), PACK);

function alea(graine) {
  let a = graine >>> 0;
  const r = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  r.ent = (n) => Math.floor(r() * n);
  r.choix = (t) => t[Math.floor(r() * t.length)];
  return r;
}

let courant = null;
function ouvrir(dir) {
  if (courant === dir) return;
  db.fermer();
  const a = appareil.charger(dir, { nom: path.basename(dir) });
  etat.configurer({ appareil: a });
  const images = path.join(dir, 'images-locales');
  fs.mkdirSync(images, { recursive: true });
  edition.configurer(images);
  service.configurer({ dossierUser: dir, imagesLocales: images });
  db.ouvrir(path.join(dir, 'utilisateur.db'), PACK);
  jeu.reinitialiserSac();
  courant = dir;
}

/** Tuiles locales en lot : un seul recalcul de la vue (des milliers sans attendre). */
function creerEnLot(n, prefixeTexte) {
  if (!n) return [];
  const ids = [];
  const pre = etat.appareil().prefixe_ref || 'L';
  let k = db.instance().prepare("SELECT COUNT(*) n FROM etat WHERE entite='locale' AND champ='_existe'").get().n;
  etat.lot(() => {
    for (let i = 0; i < n; i++) {
      const id = 'local:' + require('crypto').randomUUID();
      k++;
      etat.ecrire('locale', id, '_existe', 1);
      etat.ecrire('locale', id, 'ref_local', pre + k + 'x' + i);   // provisoire unique, renumerote a l'inscription
      etat.ecrire('locale', id, 'titre', prefixeTexte + ' ' + k);
      etat.ecrire('locale', id, 'artiste', 'Artiste ' + (k % 97));
      etat.ecrire('locale', id, 'description', 'Description numero ' + k + ' assez longue pour etre evocatrice au tirage.');
      ids.push(id);
    }
  });
  edition.rafraichir();
  return ids;
}

/** Etat visible d'un appareil (ce que l'interface lit). */
function observer() {
  const d = db.instance();
  const locales = new Map(d.prepare('SELECT * FROM oeuvres_locales').all()
    .map((r) => [r.id, JSON.stringify([r.ref_local, r.titre, r.artiste, r.date, r.lieu, r.description, r.tags, r.image])]));
  const set = (sql) => new Set(d.prepare(sql).all().map((r) => r.k));
  return {
    locales,
    marques: set("SELECT oeuvre_id || '|' || tag k FROM user_tags"),
    notes: new Map(d.prepare('SELECT oeuvre_id, texte FROM user_notes').all().map((r) => [r.oeuvre_id, r.texte])),
    corrections: new Map(d.prepare("SELECT oeuvre_id, group_concat(champ || '=' || valeur, '|') v FROM (SELECT * FROM user_overrides ORDER BY champ) GROUP BY oeuvre_id").all().map((r) => [r.oeuvre_id, r.v])),
    archives: set('SELECT oeuvre_id k FROM user_archive'),
    revisions: set("SELECT oeuvre_id || '|' || rid k FROM user_revisions")
  };
}
const diffSet = (a, b) => [...a].filter((x) => !b.has(x)).length + [...b].filter((x) => !a.has(x)).length;
const diffMap = (a, b) => { let n = 0; for (const k of new Set([...a.keys(), ...b.keys()])) if (a.get(k) !== b.get(k)) n++; return n; };

/** Confronte le bilan d'une synchro a ce qui a change. Rend la liste des ecarts. */
function verifierRecu(avant, apres, r) {
  const ecarts = [];
  const recu = r.recu || {};
  const renum = new Set((r.renumerotees || []).map((x) => x.cle));
  let apparues = 0, disparues = 0, changees = 0;
  for (const [id, v] of apres.locales) {
    if (!avant.locales.has(id)) apparues++;
    else if (avant.locales.get(id) !== v && !renum.has(id)) changees++;
  }
  for (const id of avant.locales.keys()) if (!apres.locales.has(id)) disparues++;
  const n = (k) => recu[k] || 0;
  const exiger = (nom, compte, vu) => { if (compte < vu) ecarts.push(nom + ' : bilan ' + compte + ' < change ' + vu); };
  exiger('tuiles apparues', n('tuilesNouvelles') + n('tuilesRestaurees'), apparues);
  exiger('tuiles disparues', n('tuilesSupprimees'), disparues);
  exiger('tuiles modifiees', n('tuilesModifiees') + n('tuilesNouvelles') + n('tuilesRestaurees'), changees);
  exiger('marques', n('marques'), diffSet(avant.marques, apres.marques));
  exiger('notes', n('notes'), diffMap(avant.notes, apres.notes));
  exiger('corrections', n('oeuvresCorrigees'), diffMap(avant.corrections, apres.corrections));
  exiger('archives', n('archives'), diffSet(avant.archives, apres.archives));
  exiger('revisions', n('revisions'), [...apres.revisions].filter((x) => !avant.revisions.has(x)).length);
  return ecarts;
}

const sommeEnvoye = (r) => Object.entries(r.envoye || {}).filter(([k]) => k !== 'vues').reduce((s, [, v]) => s + (v || 0), 0);

/** Une action utilisateur au hasard sur l'appareil ouvert. @returns {boolean} a ecrit quelque chose de visible */
function agir(rnd) {
  const d = db.instance();
  const locales = d.prepare('SELECT id FROM oeuvres_locales').all().map((r) => r.id);
  const packIds = () => d.prepare('SELECT id FROM oeuvres_effectives WHERE est_locale = 0 LIMIT 60').all().map((r) => r.id);
  const a = rnd.ent(11);
  derniereAction = ['creer', 'creer', 'modifier', 'supprimer', 'restaurer', 'marque', 'note', 'corriger pack', 'archiver pack', 'reviser', 'vue'][a];
  switch (a) {
    case 0: case 1: return creerEnLot(1 + rnd.ent(4), 'Tuile').length > 0;
    case 2: { if (!locales.length) return false; const id = rnd.choix(locales); edition.modifier(id, { ...edition.tuile(id), titre: 'Modifiee ' + rnd.ent(1e6) }); return true; }
    case 3: if (!locales.length) return false; edition.supprimer(rnd.choix(locales)); return true;
    case 4: { const c = edition.corbeille().filter((x) => x.id.startsWith('local:')); if (!c.length) return false; return !edition.restaurer(rnd.choix(c).id).erreur; }
    case 5: { const ids = [...packIds(), ...locales]; db.basculerTag(rnd.choix(ids), rnd.choix(['livre', 'etoile', 'bad_smiley'])); return true; }
    case 6: { const ids = [...packIds(), ...locales]; return !!edition.ecrireNote(rnd.choix(ids), rnd() < 0.2 ? '' : 'note ' + rnd.ent(1e6)).ok; }
    case 7: { const id = rnd.choix(packIds()); const o = edition.tuile(id); edition.modifier(id, { ...o, lieu: 'Lieu ' + rnd.ent(1e6) }); return true; }
    case 8: { const id = rnd.choix(packIds()); edition.supprimer(id); return true; }
    case 9: { const t = revision.tirer([]); if (t.fini) return false; revision.noter(t.id, 1 + rnd.ent(4)); return true; }
    default: jeu.tirer(null); return false;   // vues seules
  }
}

async function synchroniser(faux, rnd, journalEcarts, etiquette) {
  const avant = observer();
  const auto = rnd() < 0.35;
  let r = await service.synchroniserDrive(null, faux, { auto });
  if (r.decisionRequise) { service.choisirRemplacement(null); r = await service.synchroniserDrive(null, faux); }
  assert.ok(!r.erreur, etiquette + ' : ' + r.erreur);
  const apres = observer();
  for (const e of verifierRecu(avant, apres, r)) journalEcarts.push(etiquette + (r.rapide ? ' (rapide)' : '') + (r.rattrapage ? ' (rattrapage ' + r.rattrapage + ')' : '') + ' — ' + e);
  return r;
}

let nOk = 0, nKo = 0;
async function test(nom, fn) {
  try { await fn(); nOk++; console.log('  ok  ' + nom); }
  catch (e) { nKo++; console.log('  KO  ' + nom + '\n      ' + String(e.stack || e).split('\n').slice(0, 10).join('\n      ')); }
}

(async () => {
  console.log(`${NB} scenarios, graine ${GRAINE}`);
  for (let s = 0; s < NB; s++) {
    const graine = GRAINE + s;
    await test('scenario ' + s + ' (graine ' + graine + ')', async () => {
      const rnd = alea(graine);
      viderCaches();
      const faux = creerFauxDrive();
      const appareils = [];
      const nouveau = () => { const d = fs.mkdtempSync(path.join(TMP, 's' + s + '-')); appareils.push({ dir: d, aEnvoyer: false }); return appareils[appareils.length - 1]; };
      const ecarts = [];
      // Depart : 0 tuile le plus souvent, parfois quelques-unes, parfois quelques dizaines.
      const premier = nouveau();
      ouvrir(premier.dir);
      creerEnLot(rnd.choix([0, 0, 0, 3, 12, 45]), 'Depart');
      const nbFinal = 2 + rnd.ent(3);
      for (let pas = 0; pas < 14; pas++) {
        if (appareils.length < nbFinal && rnd() < 0.3) {
          const n = nouveau();
          ouvrir(n.dir);
          // Tuiles creees avant de rejoindre : a envoyer (et renumerotees) a l'inscription.
          if (rnd() < 0.4) n.aEnvoyer = creerEnLot(rnd.choix([1, 5, 20]), 'Hors ligne').length > 0;
        }
        const a = rnd.choix(appareils);
        ouvrir(a.dir);
        for (let k = rnd.ent(4); k > 0; k--) {
          const aPousserAvant = db.instance().prepare('SELECT COUNT(*) n FROM changements WHERE pousse=0').get().n;
          const ecrit = agir(rnd);
          const aPousser = db.instance().prepare('SELECT COUNT(*) n FROM changements WHERE pousse=0').get().n;
          if (TRACE) console.log('      pas', pas, 'appareil', appareils.indexOf(a), 'action', derniereAction, 'ecrit', ecrit, 'ops a envoyer', aPousserAvant, '->', aPousser);
          if (ecrit) a.aEnvoyer = true;
        }
        if (rnd() < 0.7) {
          const r = await synchroniser(faux, rnd, ecarts, 'pas ' + pas + ' appareil ' + appareils.indexOf(a));
          if (TRACE) console.log('      sync appareil', appareils.indexOf(a), JSON.stringify({ rapide: r.rapide, auto: r.auto, poussees: r.poussees, appliquees: r.appliquees, envoye: r.envoye, recu: r.recu, rattrapage: r.rattrapage }));
          if (a.aEnvoyer && !r.rapide && !r.decisionRequise && sommeEnvoye(r) === 0 && r.poussees === 0 && !(r.renumerotees || []).length) {
            ecarts.push('pas ' + pas + ' : changements locaux non annonces dans « Envoye » ' + JSON.stringify(r.envoye));
          }
          if (!r.rapide) a.aEnvoyer = false;
        }
      }
      // Convergence : deux tours de synchro manuelle, tout le monde pareil.
      for (let tour = 0; tour < 2; tour++) {
        for (const a of appareils) { ouvrir(a.dir); await synchroniser(faux, () => 1, ecarts, 'final ' + tour + ' appareil ' + appareils.indexOf(a)); }
      }
      const etats = appareils.map((a) => { ouvrir(a.dir); const o = observer(); return JSON.stringify([[...o.locales].sort(), [...o.marques].sort(), [...o.notes].sort(), [...o.corrections].sort(), [...o.archives].sort(), [...o.revisions].sort()]); });
      assert.ok(etats.every((e) => e === etats[0]), 'les appareils divergent');
      assert.deepEqual(ecarts, [], ecarts.slice(0, 8).join('\n'));
    });
  }
  db.fermer();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* verrou */ }
  console.log(`\n${nOk} ok, ${nKo} KO`);
  process.exit(nKo ? 1 : 0);
})();
