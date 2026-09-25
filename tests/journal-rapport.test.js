'use strict';
/**
 * Journal de fonctionnement et rapport d'erreur.
 *
 *     node scripts/lancer-node.js tests/journal-rapport.test.js
 */

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RACINE = path.resolve(__dirname, '..');
const journal = require(path.join(RACINE, 'src/main/journal'));
const rapport = require(path.join(RACINE, 'src/main/rapport'));
const lisezmoi = require(path.join(RACINE, 'src/main/lisezmoi'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-journal-'));
const LOGS = path.join(TMP, 'logs');

let nOk = 0, nKo = 0;
function test(nom, fn) {
  try { fn(); nOk++; console.log('  ok  ' + nom); }
  catch (e) { nKo++; console.log('  KO  ' + nom + '\n      ' + String(e.stack || e).split('\n').slice(0, 5).join('\n      ')); }
}
const lignes = () => fs.readFileSync(path.join(LOGS, 'journal.log'), 'utf8').split('\n').filter(Boolean);
const derniere = () => lignes().slice(-1)[0];

// Caracteres fabriques par code (pas d'echappement dans le source).
const ZWSP = String.fromCharCode(0x200B);
const CTRL = String.fromCharCode(0x07);
const EMOJI = String.fromCodePoint(0x1F3A8);

console.log('journal');

journal.configurer(LOGS, { version: 'test' }, { console: false });

test('en-tete de session', () => {
  assert.match(lignes()[0], /INFO\s+app\s+=== SESSION ===\s+s=[0-9a-f]{6}\s+\{"pid":\d+,"version":"test"\}/);
});

test('format : horodatage, niveau, domaine, evenement, session, JSON', () => {
  journal.evt('image', 'import:debut', { octets: 12 }, 'WARN');
  const m = /^(\S+)\s+(WARN)\s+(image)\s+(import:debut)\s+s=([0-9a-f]{6})\s+(\{.*\})$/.exec(derniere());
  assert.ok(m, derniere());
  assert.ok(!Number.isNaN(Date.parse(m[1])));
  assert.equal(m[5], journal.SESSION);
  assert.deepEqual(JSON.parse(m[6]), { octets: 12 });
});

test('jamais de secret : cles de type jeton masquees', () => {
  journal.evt('drive', 'x', { refresh_token: 'SECRET1', access_token: 'SECRET2', Authorization: 'Bearer SECRET3', code_verifier: 'SECRET4', ok: 1 });
  const l = derniere();
  assert.ok(!/SECRET/.test(l), l);
  assert.match(l, /"ok":1/);
});

test('erreur : message, code et pile', () => {
  const e = new Error('boum'); e.code = 'EBOUM';
  journal.erreur('synchro', 'echec', e, { etape: 'tirer' });
  const d = JSON.parse(derniere().replace(/^.*?\s(\{.*\})$/, '$1'));
  assert.equal(d.erreur, 'boum');
  assert.equal(d.code, 'EBOUM');
  assert.equal(d.etape, 'tirer');
  assert.match(d.stack, /journal-rapport\.test\.js/);
  assert.match(derniere(), /\sERREUR\s/);
});

test('valeurs enormes et binaires resumees', () => {
  journal.evt('ipc', 'x', { gros: 'a'.repeat(5000), octets: Buffer.alloc(3000), liste: Array.from({ length: 80 }, (_, i) => i) });
  const d = JSON.parse(derniere().replace(/^.*?\s(\{.*\})$/, '$1'));
  assert.ok(d.gros.length < 2100 && /\+3000 car/.test(d.gros));
  assert.deepEqual(d.octets, { octets: 3000 });
  assert.equal(d.liste.length, 51);
});

test('decrireTexte : cyrillique, emoji, invisibles, controles, interdits', () => {
  const d = journal.decrireTexte(' Москва' + ZWSP + EMOJI + CTRL + '?.jpg');
  assert.deepEqual(d.scripts, ['latin', 'cyrillique', 'emoji']);
  assert.equal(d.invisibles, 1);
  assert.equal(d.controles, 1);
  assert.equal(d.horsBMP, true);
  assert.equal(d.interditsFichier, true);
  assert.equal(d.espacesBords, true);
  assert.equal(journal.decrireTexte('Monet').scripts.join(), 'latin');
  assert.equal(journal.decrireTexte('Monet').controles, undefined);
});

test('ancienne API ligne() : [ui] -> domaine ui, ERREUR -> niveau ERREUR', () => {
  journal.ligne('[ui] page -> jeu');
  assert.match(derniere(), /\sINFO\s+ui\s+page -> jeu/);
  journal.ligne('ERREUR quelque chose', { a: 1 });
  assert.match(derniere(), /\sERREUR\s+app\s+quelque chose/);
});

test('rotation : 5 Mo par fichier, 5 fichiers au plus', () => {
  const bloc = 'x'.repeat(1900);
  for (let i = 0; i < 16000; i++) journal.evt('test', 'remplissage', { i, bloc });
  const f = journal.fichiers().map((x) => path.basename(x));
  assert.deepEqual(f, ['journal.log', 'journal.log.1', 'journal.log.2', 'journal.log.3', 'journal.log.4']);
  for (const x of journal.fichiers()) assert.ok(fs.statSync(x).size <= 5.1 * 1024 * 1024, x);
});

// --- rapport ------------------------------------------------------------------

console.log('rapport');

const zlib = require('zlib');
const vm = require('vm');
const moi = os.userInfo().username;
const poste = os.hostname();
const DOSSIER = path.join(TMP, 'rapports');
const CLE = 'cle-de-test';
const INFOS = () => ({ os: 'win32 test', appareil: { id: 'aaaa0001', nom: poste }, donnees: { dossier: 'C:\\Users\\' + moi } });
const FORM = {
  sujet: 'image', depuis: 'semaine', reproductible: 'toujours',
  description: 'La photo Москва.jpg ne s’importe pas', email: 'testeur@exemple.fr'
};

/**
 * Script Google de reception (tools/rapport-reception.gs) execute dans Node,
 * services Google simules : on teste la chaine complete app -> script -> mail.
 */
function scriptGoogle() {
  const proprietes = new Map([['CLE', CLE]]);
  const mails = [];
  const blob = (octets, type, nom) => ({
    octets: Buffer.from(octets), type, nom,
    getBytes() { return this.octets; }, getDataAsString() { return this.octets.toString('utf8'); }
  });
  const bac = {
    Utilities: {
      newBlob: (d, type, nom) => blob(typeof d === 'string' ? Buffer.from(d, 'utf8') : d, type, nom),
      base64Decode: (s) => Buffer.from(s, 'base64'),
      base64Encode: (b) => Buffer.from(b).toString('base64'),
      gzip: (b) => blob(zlib.gzipSync(b.octets), 'application/x-gzip', b.nom + '.gz'),
      ungzip: (b) => blob(zlib.gunzipSync(b.octets), 'text/plain', b.nom),
      formatDate: (d) => d.toISOString().slice(0, 13).replace(/\D/g, '')
    },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (proprietes.has(k) ? proprietes.get(k) : null),
      setProperty: (k, v) => proprietes.set(k, v),
      deleteProperty: (k) => proprietes.delete(k),
      getKeys: () => [...proprietes.keys()]
    }) },
    MailApp: { sendEmail: (to, objet, corps, options) => mails.push({ to, objet, corps, options }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (t) => ({ contenu: t, setMimeType() { return this; }, getContent() { return this.contenu; } })
    },
    Logger: { log: () => {} }
  };
  vm.createContext(bac);
  vm.runInContext(fs.readFileSync(path.join(RACINE, 'tools/rapport-reception.gs'), 'utf8'), bac);
  // fetch vers le script : doPost avec le corps recu.
  const fetch = async (url, opts) => {
    const out = bac.doPost({ postData: { contents: opts.body } });
    return { ok: true, status: 200, text: async () => out.getContent() };
  };
  return { fetch, mails, proprietes };
}

const horsLigne = async () => { throw new Error('net::ERR_INTERNET_DISCONNECTED'); };

function configurer(fetch, url = 'https://script.google.com/macros/s/x/exec') {
  rapport.configurer({ dossier: DOSSIER, version: '9.9.9', infos: INFOS, config: { url, cle: CLE }, fetch });
}

async function testA(nom, fn) {
  try { await fn(); nOk++; console.log('  ok  ' + nom); }
  catch (e) { nKo++; console.log('  KO  ' + nom + '\n      ' + String(e.stack || e).split('\n').slice(0, 5).join('\n      ')); }
}

(async () => {
  test('masquage : utilisateur dans les chemins (simple et double antislash), poste, emails', () => {
    const t = [
      'C:\\Users\\' + moi + '\\AppData\\Roaming',
      JSON.stringify({ p: 'C:\\Users\\' + moi + '\\Documents' }),
      '/home/' + moi + '/x',
      'appareil ' + poste + ' pret',
      'contact : jean.dupont@exemple.fr, dest : ' + rapport.DESTINATAIRE
    ].join('\n');
    const m = rapport.masquer(t);
    assert.ok(!new RegExp('Users\\\\{1,2}' + moi, 'i').test(m), m);
    assert.ok(!m.includes('/home/' + moi));
    assert.ok(m.includes('<utilisateur>'));
    if (poste.length >= 3) assert.ok(!new RegExp('(^|[^A-Za-z0-9])' + poste + '([^A-Za-z0-9]|$)', 'i').test(m), m);
    assert.ok(m.includes('<email>'));
    assert.ok(m.includes(rapport.DESTINATAIRE), 'le destinataire reste lisible');
    assert.ok(rapport.masquer('moi@ici.fr', { garder: ['moi@ici.fr'] }).includes('moi@ici.fr'));
  });

  test('horodatage local avec decalage + UTC', () => {
    const h = rapport.horodatage(new Date('2026-09-24T11:45:07Z'));
    assert.match(h.local, /^2026-09-24T\d{2}:45:07[+-]\d{2}:\d{2}$/);
    assert.equal(h.utc, '2026-09-24T11:45:07.000Z');
  });

  journal.evt('image', 'chemin', { chemin: 'C:\\Users\\' + moi + '\\Pictures\\Москва.jpg' }, 'ERREUR');

  await testA('un clic : le rapport arrive par mail, journaux en .txt masques, sans zip', async () => {
    const g = scriptGoogle();
    configurer(g.fetch);
    const r = await rapport.envoyer(FORM);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(g.mails.length, 1);
    const m = g.mails[0];
    assert.equal(m.to, rapport.DESTINATAIRE);
    assert.match(m.objet, /^\[T&T rapport\] Image non importée ou mal affichée — v9\.9\.9 — \d{4}-\d{2}-\d{2} \d{2}:\d{2} — R\d{12}-[0-9a-f]{4}$/);
    assert.equal(m.options.replyTo, 'testeur@exemple.fr', 'repondre = email du testeur');
    assert.match(m.corps, /Depuis quand   : Depuis quelques jours/);
    assert.match(m.corps, /Reproductible  : Oui, à chaque fois/);
    assert.match(m.corps, /La photo Москва\.jpg/);
    const noms = m.options.attachments.map((a) => a.nom);
    assert.ok(noms.includes('journal.log.txt') && noms.includes('rapport.json'), noms.join());
    assert.ok(!noms.some((n) => /\.zip$/.test(n)), 'aucun zip');
    const log = m.options.attachments.find((a) => a.nom === 'journal.log.txt').getDataAsString();
    assert.ok(log.includes('Москва.jpg'), 'les textes restent');
    assert.ok(!new RegExp('Users\\\\{1,2}' + moi, 'i').test(log), 'utilisateur masque');
    const json = JSON.parse(m.options.attachments.find((a) => a.nom === 'rapport.json').getDataAsString());
    assert.equal(json.application.donnees.dossier, 'C:\\Users\\<utilisateur>');
    assert.equal(json.formulaire.email, 'testeur@exemple.fr');
    assert.ok(!fs.existsSync(DOSSIER), 'rien ecrit sur disque quand tout va bien');
  });

  // Taille du mail encode (base64 des pieces jointes) : <= 9 Mo (relais Firefox).
  const tailleMail = (m) => m.corps.length * 2 + m.options.attachments.reduce((s, a) => s + Math.ceil(a.octets.length * 4 / 3), 0);

  await testA('gros journaux (25 Mo) : mail <= 9 Mo, recents en .txt, anciens compresses (.gz)', async () => {
    const g = scriptGoogle();
    configurer(g.fetch);
    await rapport.envoyer(FORM);
    const m = g.mails[0];
    assert.ok(tailleMail(m) <= 9 * 1024 * 1024, 'mail ' + tailleMail(m));
    assert.equal(m.options.attachments[1].nom, 'journal.log.txt', 'le plus recent en clair');
    assert.ok(m.options.attachments.some((a) => /\.gz$/.test(a.nom)), m.options.attachments.map((a) => a.nom).join());
    assert.match(m.corps, /joints compressés \(\.gz\)/);
  });

  await testA('journaux incompressibles : ceux qui ne tiennent pas sont ecartes et listes dans le mail', async () => {
    const g = scriptGoogle();
    const bruit = (n) => require('crypto').randomBytes(n).toString('base64');
    const journaux = ['journal.log', 'journal.log.1', 'journal.log.2'].map((nom) => {
      const brut = Buffer.from(bruit(3 * 1024 * 1024), 'utf8');
      return { nom, octets: brut.length, gz64: zlib.gzipSync(brut).toString('base64') };
    });
    const rep = JSON.parse(await (await g.fetch('x', { body: JSON.stringify({
      cle: CLE, id: 'R1', objet: '[T&T rapport] test', corps: 'corps', journaux, rapport: { a: 1 }
    }) })).text());
    assert.equal(rep.ok, true);
    const m = g.mails[0];
    assert.ok(tailleMail(m) <= 9 * 1024 * 1024, 'mail ' + tailleMail(m));
    assert.ok(rep.ecartes.length >= 1, JSON.stringify(rep));
    assert.match(m.corps, /non joints, restés sur le poste du testeur : journal\.log\.\d/);
    assert.ok(m.options.attachments.some((a) => a.nom === 'journal.log.txt'), 'le plus recent toujours joint');
  });

  await testA('page 404 intermittente de Google : reessaie et passe au 3e essai', async () => {
    const g = scriptGoogle();
    rapport._pauses(async () => {});
    let appels = 0;
    const page404 = { ok: false, status: 404, headers: { get: () => 'text/html' },
      text: async () => '<!DOCTYPE html><html lang="fa" dir="rtl"><head></head></html>' };
    configurer(async (url, opts) => (++appels < 3 ? page404 : g.fetch(url, opts)));
    const r = await rapport.envoyer(FORM);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(appels, 3);
    assert.equal(g.mails.length, 1);
  });

  await testA('404 persistante : en attente, message clair (VPN ?)', async () => {
    rapport._pauses(async () => {});
    const page404 = { ok: false, status: 404, headers: { get: () => 'text/html' },
      text: async () => '<!DOCTYPE html><html lang="fa" dir="rtl"><head></head></html>' };
    configurer(async () => page404);
    const r = await rapport.envoyer(FORM);
    assert.equal(r.enAttente, true);
    assert.match(r.erreur, /Google a répondu 404/);
    assert.match(r.erreur, /VPN/);
    fs.rmSync(path.join(DOSSIER, 'en-attente'), { recursive: true, force: true });
  });

  await testA('reponse perdue apres envoi : le reessai n\'envoie pas de doublon', async () => {
    const g = scriptGoogle();
    rapport._pauses(async () => {});
    let appels = 0;
    const page404 = { ok: false, status: 404, headers: { get: () => 'text/html' },
      text: async () => '<!DOCTYPE html><html lang="fa"></html>' };
    // 1er appel : le script tourne (mail parti) mais la reponse se perd.
    configurer(async (url, opts) => {
      appels++;
      const rep = await g.fetch(url, opts);
      return appels === 1 ? page404 : rep;
    });
    const r = await rapport.envoyer(FORM);
    assert.equal(r.ok, true);
    assert.equal(appels, 2);
    assert.equal(g.mails.length, 1, 'un seul mail malgre le reessai');
  });

  await testA('cle refusee par le script -> rapport mis en attente', async () => {
    const g = scriptGoogle();
    g.proprietes.set('CLE', 'autre');
    configurer(g.fetch);
    const r = await rapport.envoyer(FORM);
    assert.equal(r.enAttente, true);
    assert.match(r.erreur, /cle refusee/);
    assert.equal(g.mails.length, 0);
  });

  await testA('hors ligne : en attente (LISEZMOI), puis renvoye au lancement suivant', async () => {
    fs.rmSync(DOSSIER, { recursive: true, force: true });
    configurer(horsLigne);
    const r = await rapport.envoyer(FORM);
    assert.equal(r.enAttente, true);
    const attente = path.join(DOSSIER, 'en-attente');
    assert.equal(fs.readdirSync(attente).filter((n) => n.endsWith('.json')).length, 1);
    assert.ok(fs.existsSync(path.join(attente, lisezmoi.NOM)));
    assert.ok(fs.existsSync(path.join(DOSSIER, lisezmoi.NOM)));
    assert.equal(rapport.choix().enAttente, 1);
    // Toujours hors ligne : reporte, rien de perdu.
    assert.deepEqual(await rapport.renvoyerEnAttente(), { envoyes: 0, restants: 1 });
    // Retour du reseau.
    const g = scriptGoogle();
    configurer(g.fetch);
    assert.deepEqual(await rapport.renvoyerEnAttente(), { envoyes: 1, restants: 0 });
    assert.equal(g.mails.length, 1);
    assert.match(g.mails[0].objet, new RegExp(r.id + '$'));
  });

  await testA('script pas encore deploye (url vide) : repli messagerie, texte seul, lien court', async () => {
    configurer(null, '');
    assert.equal(rapport.choix().envoiDirect, false);
    const r = await rapport.envoyer({ ...FORM, description: 'x'.repeat(5000) });
    assert.equal(r.secours, true);
    assert.ok(r.mailto.startsWith('mailto:' + rapport.DESTINATAIRE + '?subject='));
    assert.ok(r.mailto.length <= 1900, 'longueur ' + r.mailto.length);
    assert.ok(decodeURIComponent(r.mailto).includes('[…tronqué]'));
  });

  await testA('apercu : objet, corps, liste des journaux, rien d\'envoye', async () => {
    const g = scriptGoogle();
    configurer(g.fetch);
    const a = rapport.apercu(FORM);
    assert.match(a.objet, /^\[T&T rapport\]/);
    assert.ok(a.journaux.length >= 1 && a.journaux[0].nom === 'journal.log');
    assert.equal(g.mails.length, 0);
  });

  await testA('sujet inconnu -> « Autre »', async () => {
    configurer(null, '');
    assert.match(rapport.apercu({ sujet: 'nimporte' }).objet, /\] Autre — /);
  });

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* verrou */ }
  console.log(`\n${nOk} ok, ${nKo} KO`);
  process.exit(nKo ? 1 : 0);
})();
