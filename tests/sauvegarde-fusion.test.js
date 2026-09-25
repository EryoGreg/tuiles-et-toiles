'use strict';
/**
 * Import d'une sauvegarde (.zip) = fusion, jamais remplacement : les ops du
 * journal du zip passent par le moteur de synchro (echange.fusionner), puis
 * repartent vers les autres appareils a la synchro suivante.
 *
 *     node scripts/lancer-node.js tests/sauvegarde-fusion.test.js
 */

const assert = require('assert/strict');
const path = require('path');
const Database = require('better-sqlite3');

const RACINE = path.resolve(__dirname, '..');
const { SCHEMA_USER } = require(path.join(RACINE, 'src/main/db'));
const moteur = require(path.join(RACINE, 'src/main/synchro/moteur'));
const echange = require(path.join(RACINE, 'src/main/synchro/echange'));
const cycle = require(path.join(RACINE, 'src/main/synchro/cycle'));
const sauvegarde = require(path.join(RACINE, 'src/main/sauvegarde'));
const { creerHorloge } = require(path.join(RACINE, 'src/main/synchro/hlc'));
const { creerTransportMemoire } = require(path.join(RACINE, 'src/main/synchro/transport-memoire'));

let nOk = 0, nKo = 0;
async function test(nom, fn) {
  try { await fn(); nOk++; console.log('  ok  ' + nom); }
  catch (e) { nKo++; console.log('  KO  ' + nom + '\n      ' + String(e.stack || e).split('\n').slice(0, 8).join('\n      ')); }
}

function creerMonde() {
  const monde = { t: Date.parse('2026-09-25T10:00:00Z'), transport: creerTransportMemoire(), appareils: [] };
  monde.avancer = (ms) => { monde.t += ms; };
  monde.appareil = (id) => {
    const d = new Database(':memory:');
    d.exec(SCHEMA_USER);
    const ctx = { d, appareil: { id, prefixe_ref: 'L' }, horloge: creerHorloge(id, { maintenant: () => monde.t }) };
    ctx.ecrire = (...a) => moteur.ecrire(ctx, ...a);
    ctx.val = (e, c, ch) => moteur.valeur(ctx, e, c, ch);
    ctx.synchro = () => cycle.executer(ctx, monde.transport, { nom: id, enregistrerPrefixe: () => {}, maintenant: () => monde.t });
    monde.appareils.push(ctx);
    return ctx;
  };
  monde.converger = async (qui = monde.appareils) => {
    for (let tour = 0; tour < 3; tour++) for (const a of qui) await a.synchro();
  };
  return monde;
}

function tuile(a, cle, titre) {
  a.ecrire('locale', cle, '_existe', 1);
  a.ecrire('locale', cle, 'titre', titre);
}

// Le « zip » : les ops de la base d'un appareil, lues comme a l'import.
const zipDe = (a) => sauvegarde._lireOps(a.d, Buffer.from('x'));
const importer = (a, zip) => echange.fusionner(a, zip.ops, { pousse: 0 });
const etatDe = (a) => a.d.prepare('SELECT entite, cle, champ, valeur, hlc FROM etat ORDER BY 1, 2, 3').all();

(async () => {
  console.log('import = fusion');

  await test('reimporter une sauvegarde plus ancienne ne defait rien', async () => {
    const m = creerMonde();
    const A = m.appareil('aaaa0001'), B = m.appareil('bbbb0002');
    tuile(A, 'local:1', 'Avant');
    await m.converger();
    const zip = zipDe(A);
    m.avancer(60e3);
    A.ecrire('locale', 'local:1', 'titre', 'Apres');
    await m.converger();
    const f = importer(B, zip);
    assert.equal(f.appliquees.length, 0);
    assert.equal(B.val('locale', 'local:1', 'titre'), 'Apres');
    assert.equal(moteur.conflits(B).length, 0);
  });

  await test('les tuiles d\'un appareil perdu reviennent et partent vers les autres', async () => {
    const m = creerMonde();
    const D = m.appareil('dddd0004');   // jamais synchronise, puis perdu
    tuile(D, 'local:perdue', 'Sauvée par le zip');
    const zip = zipDe(D);
    m.appareils.pop();
    m.avancer(3 * 86400e3);
    const A = m.appareil('aaaa0001'), B = m.appareil('bbbb0002');
    tuile(A, 'local:a', 'De A');
    await m.converger();
    // Les ops du zip sont plus anciennes que le dernier envoi de A : le
    // segment qui les porte doit quand meme etre lu par B.
    const f = importer(A, zip);
    assert.equal(f.resume.tuilesNouvelles, 1);
    await m.converger();
    assert.equal(B.val('locale', 'local:perdue', 'titre'), 'Sauvée par le zip');
    assert.deepEqual(etatDe(A), etatDe(B));
  });

  await test('meme donnee changee des deux cotes sans se voir : conflit, la plus recente affichee', async () => {
    const m = creerMonde();
    const A = m.appareil('aaaa0001'), B = m.appareil('bbbb0002');
    tuile(A, 'local:1', 'Commun');
    await m.converger();
    B.ecrire('locale', 'local:1', 'titre', 'Version B');
    const zip = zipDe(B);
    m.avancer(1000);
    A.ecrire('locale', 'local:1', 'titre', 'Version A');
    importer(A, zip);
    assert.equal(A.val('locale', 'local:1', 'titre'), 'Version A');
    const c = moteur.conflits(A);
    assert.equal(c.length, 1);
    assert.equal(c[0].valeur_perdante, 'Version B');
  });

  await test('importer deux fois le meme zip : rien de plus la seconde fois', async () => {
    const m = creerMonde();
    const A = m.appareil('aaaa0001'), Z = m.appareil('ffff0006');
    tuile(Z, 'local:z', 'Z');
    Z.ecrire('tag', 'p:1', 'etoile', 1);
    const zip = zipDe(Z);
    const f1 = importer(A, zip);
    const f2 = importer(A, zip);
    assert.equal(f1.resume.tuilesNouvelles, 1);
    assert.equal(f1.resume.marques, 1);
    assert.equal(f2.appliquees.length, 0);
    assert.equal(f2.bilan.connue, zip.ops.length);
  });

  await test('sauvegarde d\'avant le journal : ops de genese, identifiant stable', async () => {
    const vieux = new Database(':memory:');
    vieux.exec(SCHEMA_USER);
    vieux.exec('DROP TABLE changements');
    vieux.prepare(`INSERT INTO oeuvres_locales (id, ref_local, titre, artiste, cree_le, modifie_le)
      VALUES ('local:v', 'L1', 'Vieille tuile', 'Anonyme', '2025-03-01T10:00:00Z', '2025-04-01T10:00:00Z')`).run();
    vieux.prepare("INSERT INTO user_tags (oeuvre_id, tag, cree_le) VALUES ('p:9', 'livre', '2025-05-01T10:00:00Z')").run();
    const octets = Buffer.from('contenu du zip');
    const z1 = sauvegarde._lireOps(vieux, octets), z2 = sauvegarde._lireOps(vieux, octets);
    assert.equal(z1.source, 'ancienne-sauvegarde');
    assert.deepEqual(z1.ops, z2.ops, 'memes HLC a chaque lecture');
    const m = creerMonde();
    const A = m.appareil('aaaa0001');
    const f = importer(A, z1);
    assert.equal(f.resume.tuilesNouvelles, 1);
    assert.equal(A.val('locale', 'local:v', 'titre'), 'Vieille tuile');
    assert.equal(A.val('tag', 'p:9', 'livre'), 1);
    assert.ok(A.d.prepare("SELECT cree_le FROM oeuvres_locales WHERE id='local:v'").get().cree_le.startsWith('2025-03-01'));
  });

  console.log('copie de securite automatique');
  const fs = require('fs'), os = require('os');
  const copie = require(path.join(RACINE, 'src/main/copie-securite'));
  const JOUR = 86400e3;

  await test('une copie par semaine, 4 gardees, LISEZMOI, jamais sans donnees', async () => {
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-copie-'));
    let t = Date.parse('2026-09-01T09:00:00Z'), donnees = false;
    copie.configurer({
      dossier, maintenant: () => t, aDesDonnees: () => donnees,
      exporter: (chemin) => fs.writeFileSync(chemin, 'zip ' + t)
    });
    assert.equal(copie.siBesoin().raison, 'aucune-donnee');
    donnees = true;
    assert.equal(copie.siBesoin().faite, true);
    // mtime = date de la copie : l'horloge simulee n'agit pas sur le disque.
    const dater = () => {
      for (const f of copie.lister()) {
        const d = new Date(Date.parse(f.nom.slice(11, 21) + 'T09:00:00Z'));
        fs.utimesSync(path.join(dossier, f.nom), d, d);
      }
    };
    dater();
    t += 3 * JOUR;
    assert.equal(copie.siBesoin().raison, 'recente');
    for (let i = 0; i < 6; i++) { t += 7 * JOUR; assert.equal(copie.siBesoin().faite, true); dater(); }
    const l = copie.lister();
    assert.equal(l.length, 4);
    assert.equal(l[0].nom, 'sauvegarde-' + new Date(t).toISOString().slice(0, 10) + '.zip');
    assert.ok(fs.existsSync(path.join(dossier, 'LISEZMOI.txt')));
    assert.ok(!fs.readdirSync(dossier).some((f) => f.endsWith('.tmp')));
    fs.rmSync(dossier, { recursive: true, force: true });
  });

  await test('echec de l\'export : pas de copie a moitie ecrite', async () => {
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-copie-'));
    copie.configurer({
      dossier, aDesDonnees: () => true,
      exporter: (chemin) => { fs.writeFileSync(chemin, 'debut'); throw new Error('disque plein'); }
    });
    const r = copie.siBesoin();
    assert.equal(r.faite, false);
    assert.equal(r.raison, 'echec');
    assert.deepEqual(fs.readdirSync(dossier).filter((f) => f !== 'LISEZMOI.txt'), []);
    fs.rmSync(dossier, { recursive: true, force: true });
  });

  console.log(`\n${nOk} ok, ${nKo} KO`);
  process.exit(nKo ? 1 : 0);
})();
