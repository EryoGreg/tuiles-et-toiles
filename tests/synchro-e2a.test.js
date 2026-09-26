'use strict';
/**
 * E2a — journal local : HLC, ecrire() + projections, genese, migration stats.
 *
 *     node scripts/lancer-node.js tests/synchro-e2a.test.js
 *
 * Travaille sur des copies dans un dossier temporaire : data/ n'est jamais touche.
 */

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const RACINE = path.resolve(__dirname, '..');
const db = require(path.join(RACINE, 'src/main/db'));
const etat = require(path.join(RACINE, 'src/main/synchro/etat'));
const edition = require(path.join(RACINE, 'src/main/edition'));
const jeu = require(path.join(RACINE, 'src/main/jeu'));
const hlc = require(path.join(RACINE, 'src/main/synchro/hlc'));
const appareil = require(path.join(RACINE, 'src/main/synchro/appareil'));
const annuler = require(path.join(RACINE, 'src/main/annuler'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-e2a-'));
const PACK = path.join(TMP, 'pack.db');
fs.copyFileSync(path.join(RACINE, 'data/pack.db'), PACK);
const IMAGES = path.join(TMP, 'images-locales');
fs.mkdirSync(IMAGES);
edition.configurer(IMAGES);

let nOk = 0, nKo = 0;
function test(nom, fn) {
  try { fn(); nOk++; console.log('  ok  ' + nom); }
  catch (e) { nKo++; console.log('  KO  ' + nom + '\n      ' + (e.stack || e).split('\n').slice(0, 4).join('\n      ')); }
}

/** Ouvre une base neuve (ou existante) sous l'identite donnee. */
function ouvrir(nomFichier, app) {
  db.fermer();
  etat.configurer({ appareil: app });
  const chemin = path.join(TMP, nomFichier);
  db.ouvrir(chemin, PACK);
  jeu.reinitialiserSac();
  return db.instance();
}

const A = { id: 'aaaa0001', nom: 'Test A', prefixe_ref: 'L' };
const unePack = () => db.instance().prepare('SELECT id, titre FROM pack.oeuvres ORDER BY ref LIMIT 2').all();
const nChg = () => db.instance().prepare('SELECT COUNT(*) n FROM changements').get().n;
const tables = (d) => ({
  locales: d.prepare('SELECT id, ref_local, artiste, titre, date, lieu, description, tags, image, cree_le FROM oeuvres_locales ORDER BY id').all(),
  overrides: d.prepare('SELECT oeuvre_id, champ, valeur, valeur_source FROM user_overrides ORDER BY 1, 2').all(),
  archive: d.prepare('SELECT oeuvre_id FROM user_archive ORDER BY 1').all(),
  tags: d.prepare('SELECT oeuvre_id, tag, cree_le FROM user_tags ORDER BY 1, 2').all()
});

// --- HLC --------------------------------------------------------------------

console.log('HLC');

test('tic strictement croissant a heure figee', () => {
  const h = hlc.creerHorloge('aaaa0001', { maintenant: () => 1000 });
  const a = h.tic(), b = h.tic(), c = h.tic();
  assert.ok(a < b && b < c);
  assert.equal(hlc.lire(c).cpt, 2);
});

test('horloge qui recule : on reste au-dessus', () => {
  let t = 5000;
  const h = hlc.creerHorloge('aaaa0001', { maintenant: () => t });
  const a = h.tic();
  t = 1000;
  assert.ok(h.tic() > a);
});

test('recevoir une HLC plus avancee fait avancer l\'horloge', () => {
  const h = hlc.creerHorloge('aaaa0001', { maintenant: () => 1000 });
  const distante = hlc.formater(60000, 7, 'bbbb0002');
  h.recevoir(distante);
  assert.ok(h.tic() > distante);
});

test('HLC distante a plus d\'un jour dans le futur : refusee', () => {
  const h = hlc.creerHorloge('aaaa0001', { maintenant: () => 1000 });
  assert.throws(() => h.recevoir(hlc.formater(1000 + hlc.MAX_AVANCE + 1, 0, 'bbbb0002')));
});

test('caler reprend la plus grande HLC connue', () => {
  const h = hlc.creerHorloge('aaaa0001', { maintenant: () => 10 });
  h.caler(hlc.formater(99999, 3, 'aaaa0001'));
  const n = hlc.lire(h.tic());
  assert.deepEqual([n.ms, n.cpt], [99999, 4]);
});

test('versIso', () => {
  assert.equal(hlc.versIso(hlc.formater(Date.parse('2026-09-12T10:00:00.000Z'), 0, 'a')), '2026-09-12T10:00:00.000Z');
});

// --- appareil.json ----------------------------------------------------------

console.log('appareil');

test('cree au premier lancement, relu ensuite', () => {
  const dir = path.join(TMP, 'app');
  const a = appareil.charger(dir, { nom: 'PC' });
  assert.match(a.id, /^[0-9a-f]{8}$/);
  assert.equal(a.prefixe_ref, 'L');
  assert.deepEqual(appareil.charger(dir), a);
});

test('fichier illisible : nouvelle identite', () => {
  const dir = path.join(TMP, 'app2');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'appareil.json'), '{pas du json');
  assert.match(appareil.charger(dir).id, /^[0-9a-f]{8}$/);
});

// --- ecritures sur base neuve -----------------------------------------------

console.log('ecrire + projections (base neuve)');

ouvrir('neuve.db', A);

test('base neuve : genese vide marquee', () => {
  const g = JSON.parse(db.etatSync('genese_faite'));
  assert.equal(g.ops, 0);
  assert.equal(g.appareil, A.id);
  assert.equal(nChg(), 0);
});

let idLocale;
test('creer une tuile : ops _existe + ref_local + champs non vides', () => {
  const r = edition.creer({ titre: 'Nympheas, salle 3', artiste: 'Monet', date: '' });
  idLocale = r.id;
  assert.equal(r.ref, 'L1');
  assert.equal(nChg(), 4);
  const row = db.instance().prepare('SELECT * FROM oeuvres_locales WHERE id=?').get(idLocale);
  assert.equal(row.titre, 'Nympheas, salle 3');
  assert.equal(row.date, '');
  assert.equal(row.ref_local, 'L1');
  assert.ok(db.oeuvre(idLocale), 'presente dans oeuvres_effectives');
});

test('modifier sans changement : aucune op', () => {
  const avant = nChg();
  edition.modifier(idLocale, { titre: 'Nympheas, salle 3', artiste: 'Monet' });
  assert.equal(nChg(), avant);
});

test('modifier un champ : une op, base = version precedente', () => {
  const avant = etat.lignes('locale', idLocale).titre.hlc;
  edition.modifier(idLocale, { titre: 'Nympheas', artiste: 'Monet' });
  const l = db.instance().prepare("SELECT * FROM changements WHERE cle=? AND champ='titre' ORDER BY hlc DESC").get(idLocale);
  assert.equal(JSON.parse(l.valeur), 'Nympheas');
  assert.equal(l.base, avant);
  assert.equal(db.oeuvre(idLocale).titre, 'Nympheas');
});

test('tag : bascule on/off, deux ops, projection user_tags', () => {
  const [p] = unePack();
  assert.equal(db.basculerTag(p.id, 'etoile'), true);
  assert.deepEqual(db.tagsDe(p.id), ['etoile']);
  assert.equal(db.basculerTag(p.id, 'etoile'), false);
  assert.deepEqual(db.tagsDe(p.id), []);
  assert.equal(db.instance().prepare("SELECT COUNT(*) n FROM changements WHERE entite='tag'").get().n, 2);
});

test('versions : tuile locale, plus recente d’abord, doublons successifs fusionnes', () => {
  const v = edition.versions(idLocale);
  const titre = v.find((x) => x.champ === 'titre');
  assert.deepEqual(titre.versions.map((x) => x.valeur), ['Nympheas', 'Nympheas, salle 3']);
  assert.ok(titre.versions[0].appareil.includes('cet appareil'));
  assert.equal(v.some((x) => x.champ === 'artiste'), false, 'une seule version : absent');
});

test('override : valeur_source figee a la premiere correction, retour au pack = suppression', () => {
  const [p] = unePack();
  const base = edition.tuile(p.id);
  edition.modifier(p.id, { ...base, titre: 'Titre corrige' });
  let ov = db.instance().prepare("SELECT * FROM user_overrides WHERE oeuvre_id=? AND champ='titre'").get(p.id);
  assert.equal(ov.valeur, 'Titre corrige');
  assert.equal(ov.valeur_source, p.titre);
  edition.modifier(p.id, { ...base, titre: 'Titre corrige 2' });
  ov = db.instance().prepare("SELECT * FROM user_overrides WHERE oeuvre_id=? AND champ='titre'").get(p.id);
  assert.equal(ov.valeur_source, p.titre);
  assert.equal(db.oeuvre(p.id).titre, 'Titre corrige 2');
  const vt = edition.versions(p.id).find((x) => x.champ === 'titre').versions;
  assert.deepEqual(vt.map((x) => x.valeur), ['Titre corrige 2', 'Titre corrige', p.titre]);
  assert.equal(vt[2].duPack, true);
  edition.modifier(p.id, base);
  assert.equal(edition.versions(p.id).find((x) => x.champ === 'titre').versions[0].duPack, true);
  assert.equal(db.instance().prepare('SELECT COUNT(*) n FROM user_overrides WHERE oeuvre_id=?').get(p.id).n, 0);
  assert.equal(etat.valeur('override', p.id, 'titre'), null);
  assert.equal(db.oeuvre(p.id).titre, p.titre);
});

test('supprimer une tuile locale : pierre tombale, champs et marques gardes, marques invisibles', () => {
  db.basculerTag(idLocale, 'livre');
  const livres = db.comptesTags().livre;
  edition.supprimer(idLocale);
  assert.equal(db.instance().prepare('SELECT COUNT(*) n FROM oeuvres_locales WHERE id=?').get(idLocale).n, 0);
  assert.equal(db.oeuvre(idLocale), undefined);
  assert.equal(etat.existe(idLocale), false);
  assert.ok(etat.valeur('locale', idLocale, '_existe').vu, 'pierre tombale { vu }');
  assert.equal(etat.valeur('locale', idLocale, 'titre'), 'Nympheas');
  assert.deepEqual(db.tagsDe(idLocale), ['livre'], 'marque gardee pour la restauration');
  assert.equal(db.comptesTags().livre, livres - 1, 'plus comptee');
  assert.equal(db.parTagUtilisateur('livre').some((o) => o.id === idLocale), false);
});

test('la ref d\'une tuile supprimee n\'est jamais reutilisee', () => {
  const r = edition.creer({ titre: 'Olympia', artiste: 'Manet' });
  assert.equal(r.ref, 'L2');
});

test('archiver une oeuvre du pack', () => {
  const [, p2] = unePack();
  edition.supprimer(p2.id);
  assert.ok(db.instance().prepare('SELECT 1 FROM user_archive WHERE oeuvre_id=?').get(p2.id));
  assert.equal(db.oeuvre(p2.id), undefined);
  assert.equal(etat.valeur('archive', p2.id, '_'), 1);
});

test('corbeille : tuile locale (avec date d’effacement) et oeuvre du pack archivee', () => {
  const [, p2] = unePack();
  const c = edition.corbeille();
  const loc = c.find((o) => o.id === idLocale), pk = c.find((o) => o.id === p2.id);
  assert.ok(loc && pk, 'les deux dans la corbeille');
  assert.equal(loc.titre, 'Nympheas');
  assert.equal(loc.ref, 'L1');
  const jours = (Date.parse(loc.effaceeLe) - Date.parse(loc.supprimeeLe)) / 86400e3;
  assert.equal(Math.round(jours), 90);
  assert.equal(pk.estLocale, false);
  assert.equal(pk.effaceeLe, null);
  assert.equal(pk.titre, p2.titre);
});

test('restaurer depuis la corbeille : tuile et marques reviennent, une op', () => {
  const [, p2] = unePack();
  const avant = nChg();
  const r = edition.restaurer(idLocale);
  assert.equal(r.ok, true);
  assert.equal(nChg(), avant + 1);
  assert.equal(db.oeuvre(idLocale).titre, 'Nympheas');
  assert.equal(db.parTagUtilisateur('livre').some((o) => o.id === idLocale), true);
  assert.equal(edition.restaurer(p2.id).ok, true);
  assert.ok(db.oeuvre(p2.id), 'oeuvre du pack desarchivee');
  assert.equal(edition.corbeille().length, 0);
  assert.ok(edition.restaurer(idLocale).erreur, 'deja restauree');
  edition.supprimer(idLocale);
  edition.supprimer(p2.id);
});

test('effacer tous les tags : une op par marque visible', () => {
  const [p] = unePack();
  db.basculerTag(p.id, 'livre');
  db.basculerTag(p.id, 'bad_smiley');
  const avant = nChg();
  assert.equal(db.effacerTousLesTags(), 2);
  assert.equal(nChg(), avant + 2);
  assert.deepEqual(db.comptesTags(), { livre: 0, etoile: 0, bad_smiley: 0 });
  assert.deepEqual(db.tagsDe(idLocale), ['livre'], 'celle de la tuile en corbeille reste');
});

test('pastille conflit : listes, editeur, disparait une fois tranche', () => {
  const [p] = unePack();
  const d = db.instance();
  d.prepare(`INSERT INTO conflits (entite, cle, champ, hlc_gagnant, valeur_gagnante, hlc_perdant, valeur_perdante, detecte_le)
    VALUES ('override', ?, 'titre', 'a', 'null', 'b', 'null', '2026-01-01')`).run(p.id);
  assert.equal(jeu.listerToutes({}).find((o) => o.id === p.id).conflit, true);
  assert.equal(jeu.listerToutes({}).filter((o) => o.conflit).length, 1);
  assert.equal(edition.tuile(p.id).conflit, true);
  d.prepare('UPDATE conflits SET resolu = 1 WHERE cle = ?').run(p.id);
  assert.equal(edition.tuile(p.id).conflit, false);
});

test('annuler / retablir : creation, modification, suppression, marque', () => {
  annuler.vider();
  const r = annuler.action((x) => 'Création de #' + x.ref, () => edition.creer({ titre: 'Avant', artiste: 'X' }));
  annuler.action('Modification', () => edition.modifier(r.id, { titre: 'Apres', artiste: 'X' }));
  annuler.action('Marque', () => db.basculerTag(r.id, 'etoile'));
  assert.deepEqual(annuler.etatPiles(), { annuler: 'Marque', retablir: null });

  let a = annuler.annuler();
  assert.equal(a.libelle, 'Marque'); assert.equal(a.faites, 1);
  assert.deepEqual(db.tagsDe(r.id), []);
  a = annuler.annuler(); edition.rafraichir();
  assert.equal(db.oeuvre(r.id).titre, 'Avant', 'modification annulee');
  a = annuler.retablir(); edition.rafraichir();
  assert.equal(db.oeuvre(r.id).titre, 'Apres', 'modification retablie');
  assert.deepEqual(annuler.etatPiles(), { annuler: 'Modification', retablir: 'Marque' });

  // Nouvelle action : on ne peut plus retablir.
  annuler.action('Suppression', () => edition.supprimer(r.id));
  assert.equal(annuler.etatPiles().retablir, null);
  annuler.annuler(); edition.rafraichir();
  assert.ok(db.oeuvre(r.id), 'suppression annulee : tuile revenue');

  // Annuler jusqu'a la creation : la tuile disparait (ni liste, ni corbeille).
  annuler.annuler(); annuler.annuler(); edition.rafraichir();
  assert.equal(db.oeuvre(r.id), undefined);
  assert.equal(edition.corbeille().some((o) => o.id === r.id), false);
  assert.equal(annuler.annuler().rien, true);
  annuler.retablir(); edition.rafraichir();
  assert.equal(db.oeuvre(r.id).titre, 'Avant', 'creation retablie');
});

test('annuler ne touche pas un champ modifie depuis (synchro, autre action)', () => {
  annuler.vider();
  const [p] = unePack();
  const base = edition.tuile(p.id);
  annuler.action('Modif', () => edition.modifier(p.id, { ...base, titre: 'Mien', lieu: 'Ici' }));
  etat.ecrire('override', p.id, 'titre', { valeur: 'Arrive par la synchro', valeur_source: p.titre });
  const a = annuler.annuler(); edition.rafraichir();
  assert.equal(a.faites, 1);
  assert.equal(a.ignorees.length, 1);
  assert.equal(db.oeuvre(p.id).titre, 'Arrive par la synchro');
  assert.equal(db.oeuvre(p.id).lieu, base.lieu);
  edition.modifier(p.id, base);
});

test('tirage : stats comptees pour cet appareil, hors journal', () => {
  const avant = nChg();
  const t = jeu.tirer(null);
  const s = db.instance().prepare('SELECT * FROM user_stats WHERE oeuvre_id=?').get(t.id);
  assert.equal(s.appareil, A.id);
  assert.equal(s.vues, 1);
  assert.equal(nChg(), avant);
});

test('journal : HLC strictement croissantes dans l\'ordre d\'emission, toutes pousse=0', () => {
  const l = db.instance().prepare('SELECT hlc, pousse FROM changements ORDER BY rowid').all();
  for (let i = 1; i < l.length; i++) assert.ok(l[i].hlc > l[i - 1].hlc, l[i].hlc);
  assert.ok(l.every((x) => x.pousse === 0));
});

test('registre = derniere op de chaque cle', () => {
  const d = db.instance();
  const ecarts = d.prepare(`SELECT e.entite, e.cle, e.champ FROM etat e
    WHERE e.hlc <> (SELECT MAX(hlc) FROM changements c
                    WHERE c.entite=e.entite AND c.cle=e.cle AND c.champ=e.champ)`).all();
  assert.deepEqual(ecarts, []);
});

test('reouverture : pas de seconde genese, horloge recalee au-dessus du journal', () => {
  const max = db.instance().prepare('SELECT MAX(hlc) h FROM changements').get().h;
  const n = nChg();
  ouvrir('neuve.db', A);
  assert.equal(nChg(), n);
  const [p] = unePack();
  db.basculerTag(p.id, 'etoile');
  assert.ok(db.instance().prepare('SELECT MAX(hlc) h FROM changements').get().h > max);
});

// --- prefixe ------------------------------------------------------------------

console.log('prefixe de ref');

test('appareil M : refs M1, M2 ; ne repart pas sous un M deja present', () => {
  ouvrir('prefixe.db', { id: 'bbbb0002', nom: 'Tel', prefixe_ref: 'M' });
  assert.equal(edition.creer({ titre: 'A', artiste: 'X' }).ref, 'M1');
  etat.ecrire('locale', 'local:importee', '_existe', 1);
  etat.ecrire('locale', 'local:importee', 'ref_local', 'M7');
  assert.equal(edition.creer({ titre: 'B', artiste: 'X' }).ref, 'M8');
});

// --- genese sur base v2 existante (avant E2a) ----------------------------------

console.log('genese sur base existante');

function baseAncienne(chemin, pack) {
  // Schema d'avant E2a : user_stats cle = oeuvre_id seul, pas de journal.
  const d = new Database(chemin);
  d.exec(`
    CREATE TABLE user_tags (oeuvre_id TEXT NOT NULL, tag TEXT NOT NULL CHECK (tag IN ('livre','etoile','bad_smiley')), cree_le TEXT NOT NULL, PRIMARY KEY (oeuvre_id, tag));
    CREATE TABLE user_stats (oeuvre_id TEXT PRIMARY KEY, vues INTEGER DEFAULT 0, dernier_vu TEXT);
    CREATE TABLE user_archive (oeuvre_id TEXT PRIMARY KEY, cree_le TEXT NOT NULL);
    CREATE TABLE user_overrides (oeuvre_id TEXT NOT NULL, champ TEXT NOT NULL, valeur TEXT, valeur_source TEXT, cree_le TEXT NOT NULL, modifie_le TEXT, PRIMARY KEY (oeuvre_id, champ));
    CREATE TABLE oeuvres_locales (id TEXT PRIMARY KEY, ref_local TEXT, artiste TEXT DEFAULT '', titre TEXT DEFAULT '', date TEXT DEFAULT '', lieu TEXT DEFAULT '', description TEXT DEFAULT '', tags TEXT DEFAULT '', image TEXT DEFAULT '', largeur INTEGER, hauteur INTEGER, octets INTEGER, hash_texte TEXT, recherche TEXT, masques TEXT, cree_le TEXT NOT NULL, modifie_le TEXT);
    CREATE TABLE reglages (cle TEXT PRIMARY KEY, valeur TEXT);
    CREATE TABLE sync (cle TEXT PRIMARY KEY, valeur TEXT);`);
  d.prepare(`INSERT INTO oeuvres_locales (id, ref_local, artiste, titre, cree_le, modifie_le)
    VALUES ('local:9b2e', 'L1', 'Monet', 'Nympheas, salle 3', '2026-09-15T09:00:00.000Z', '2026-09-16T18:30:00.000Z')`).run();
  d.prepare(`INSERT INTO user_overrides VALUES (?, 'titre', 'Portrait de Lisa Gherardini', ?, '2026-09-10T08:00:00.000Z', '2026-09-12T14:00:00.000Z')`)
    .run(pack[0].id, pack[0].titre);
  d.prepare("INSERT INTO user_archive VALUES (?, '2026-09-11T10:00:00.000Z')").run(pack[1].id);
  d.prepare("INSERT INTO user_tags VALUES (?, 'etoile', '2026-09-13T10:00:00.000Z')").run(pack[0].id);
  d.prepare("INSERT INTO user_tags VALUES ('local:9b2e', 'livre', '2026-09-15T09:00:00.000Z')").run();
  d.prepare("INSERT INTO user_stats VALUES (?, 14, '2026-09-20T10:00:00.000Z')").run(pack[0].id);
  d.prepare("INSERT INTO reglages VALUES ('ref_local_seq', '1')").run();
  d.close();
}

test('genese : une op par ligne, HLC = dates reelles, tables inchangees, stats migrees', () => {
  const pack = new Database(PACK, { readonly: true }).prepare('SELECT id, titre FROM oeuvres ORDER BY ref LIMIT 2').all();
  const chemin = path.join(TMP, 'ancienne.db');
  baseAncienne(chemin, pack);
  const brut = new Database(chemin, { readonly: true });
  const avant = tables(brut);
  brut.close();

  const d = ouvrir('ancienne.db', A);

  // 3 ops tuile (_existe, ref_local, artiste, titre = 4) + 1 override + 1 archive + 2 tags
  assert.equal(nChg(), 4 + 1 + 1 + 2);
  assert.equal(JSON.parse(db.etatSync('genese_faite')).ops, 8);
  assert.deepEqual(tables(d), avant);

  const h = (entite, cle, champ) => etat.lignes(entite, cle)[champ].hlc;
  assert.equal(hlc.versIso(h('override', pack[0].id, 'titre')), '2026-09-12T14:00:00.000Z');
  assert.equal(hlc.versIso(h('locale', 'local:9b2e', '_existe')), '2026-09-15T09:00:00.000Z');
  assert.equal(hlc.versIso(h('locale', 'local:9b2e', 'titre')), '2026-09-16T18:30:00.000Z');
  assert.deepEqual(etat.valeur('override', pack[0].id, 'titre'),
    { valeur: 'Portrait de Lisa Gherardini', valeur_source: pack[0].titre });

  const s = d.prepare('SELECT * FROM user_stats').all();
  assert.deepEqual(s.map((r) => [r.oeuvre_id, r.appareil, r.vues]), [[pack[0].id, A.id, 14]]);

  // Deux champs d'une meme tuile a la meme ms : HLC distinctes.
  const hl = d.prepare('SELECT hlc FROM changements').all().map((r) => r.hlc);
  assert.equal(new Set(hl).size, hl.length);

  // La premiere ecriture apres genese passe au-dessus de tout.
  edition.creer({ titre: 'Olympia', artiste: 'Manet' });
  assert.equal(db.instance().prepare("SELECT ref_local FROM oeuvres_locales WHERE titre='Olympia'").get().ref_local, 'L2');
});

test('genese sur la vraie base de dev (copie) : projections identiques', () => {
  const src = path.join(RACINE, 'data/utilisateur.db');
  if (!fs.existsSync(src)) return;
  const chemin = path.join(TMP, 'dev.db');
  const s = new Database(src, { readonly: true });
  s.prepare('VACUUM INTO ?').run(chemin);
  s.close();
  const brut = new Database(chemin);
  brut.exec('CREATE TABLE IF NOT EXISTS etat (x); DROP TABLE etat;');   // base d'avant E2a
  const deja = brut.prepare("SELECT 1 FROM sync WHERE cle='genese_faite'").get();
  const avant = tables(brut);
  brut.close();
  const d = ouvrir('dev.db', A);
  assert.deepEqual(tables(d), avant);
  if (!deja) {
    const n = avant.locales.length + avant.overrides.length + avant.archive.length + avant.tags.length;
    assert.ok(nChg() >= n, `${nChg()} ops pour ${n} lignes`);
  }
  console.log('      (' + nChg() + ' ops de genese, ' + avant.tags.length + ' tags, '
    + avant.overrides.length + ' overrides, ' + avant.locales.length + ' tuiles locales)');
});

db.fermer();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* verrou Windows */ }
console.log(`\n${nOk} ok, ${nKo} KO`);
process.exit(nKo ? 1 : 0);
