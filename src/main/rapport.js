'use strict';
/**
 * Rapport d'erreur : formulaire -> envoi direct, en un clic, au script Google
 * de reception (tools/rapport-reception.gs), qui transmet par mail avec les
 * journaux en pieces jointes. Rien a joindre a la main.
 *
 *   config (src/main/rapport-config.json, hors depot) : { url, cle }
 *   url vide (script pas encore deploye) -> repli : messagerie pre-remplie
 *   avec le texte seul (mailto ne peut pas joindre de fichier).
 *
 * Hors ligne / service injoignable : le rapport est range dans
 * Documents\Tuiles et Toiles - rapports\en-attente\ et renvoye tout seul au
 * lancement suivant (regle 1 : jamais bloquant).
 *
 * Masquage (dans ce qui part seulement ; journal.log local intact) : nom
 * d'utilisateur Windows et nom du poste, adresses email (sauf celle de
 * contact saisie volontairement). Les textes des tuiles restent : ils servent
 * a reproduire un cas (cyrillique, caractere interdit…).
 *
 * Objet : « [T&T rapport] <sujet> — v<version> — <date heure> — <ref> »,
 * prefixe fixe pour un filtre de messagerie.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const journal = require('./journal');
const lisezmoi = require('./lisezmoi');

const DESTINATAIRE = 'wn7pocu65@mozmail.com';
const PREFIXE_OBJET = '[T&T rapport]';
const DELAI_ENVOI = 90000;       // par tentative
// Google renvoie parfois, par intermittence, une page 404 au lieu de la
// reponse du script (constate derriere un VPN dont la sortie est localisee
// dans un pays ou Apps Script est bloque). On reessaie avant d'abandonner.
const ESSAIS = 3;
const PAUSES = [3000, 8000];
let pause = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_MAILTO = 1900;   // au-dela, Windows / certains clients tronquent le lien

const SUJETS = [
  { cle: 'synchro', libelle: 'Synchro entre appareils' },
  { cle: 'drive', libelle: 'Google Drive (connexion, sauvegarde, restauration)' },
  { cle: 'creation', libelle: 'Création ou modification d’une tuile' },
  { cle: 'image', libelle: 'Image non importée ou mal affichée' },
  { cle: 'jeu', libelle: 'Jeu : tirage, révélation, catégories' },
  { cle: 'bibliotheque', libelle: 'Bibliothèque, recherche, marques' },
  { cle: 'sauvegarde', libelle: 'Sauvegarde ou import (.zip)' },
  { cle: 'maj', libelle: 'Mise à jour de l’application' },
  { cle: 'lenteur', libelle: 'Lenteur, démarrage long, blocage' },
  { cle: 'plantage', libelle: 'Plantage, fermeture inattendue, écran blanc' },
  { cle: 'affichage', libelle: 'Affichage, thème, mise en page' },
  { cle: 'autre', libelle: 'Autre' }
];
const DEPUIS = [
  { cle: 'maintenant', libelle: 'À l’instant / aujourd’hui' },
  { cle: 'semaine', libelle: 'Depuis quelques jours' },
  { cle: 'mois', libelle: 'Depuis quelques semaines' },
  { cle: 'ancien', libelle: 'Depuis longtemps' },
  { cle: 'toujours', libelle: 'Depuis toujours (dès la première utilisation)' },
  { cle: 'inconnu', libelle: 'Je ne sais pas' }
];
const REPRODUCTIBLE = [
  { cle: 'toujours', libelle: 'Oui, à chaque fois' },
  { cle: 'parfois', libelle: 'Parfois' },
  { cle: 'une-fois', libelle: 'Une seule fois' },
  { cle: 'pas-essaye', libelle: 'Je n’ai pas réessayé' }
];

let cfg = null;

/**
 * @param {{ dossier, version, infos: () => object, config?: {url, cle},
 *   fetch?: Function }} c  fetch : net.fetch d'Electron (injectable en test)
 */
function configurer(c) {
  cfg = { ...c };
  if (!cfg.config) {
    try { cfg.config = require('./rapport-config.json'); } catch { cfg.config = {}; }
  }
}

const configure = () => !!(cfg && cfg.config && cfg.config.url && cfg.config.cle);
const dossierAttente = () => path.join(cfg.dossier, 'en-attente');

function choix() {
  return {
    sujets: SUJETS, depuis: DEPUIS, reproductible: REPRODUCTIBLE, destinataire: DESTINATAIRE,
    envoiDirect: configure(), enAttente: listerAttente().length
  };
}

// --- masquage ---------------------------------------------------------------

const echapperRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Remplace utilisateur Windows, nom du poste et emails dans un texte. */
function masquer(texte, { garder = [] } = {}) {
  let t = String(texte);
  const moi = (() => { try { return os.userInfo().username; } catch { return null; } })();
  const poste = os.hostname();
  // Chemins : C:\Users\<nom>, C:\\Users\\<nom> (JSON), /home/<nom>…
  if (moi) {
    t = t.replace(new RegExp('((?:Users|Utilisateurs|home)(?:\\\\{1,2}|/))' + echapperRe(moi) + '(?=\\\\|/|"|\\s|$)', 'gi'), '$1<utilisateur>');
  }
  const emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const ok = new Set([DESTINATAIRE, ...garder].map((x) => String(x).toLowerCase()));
  t = t.replace(emailRe, (m) => (ok.has(m.toLowerCase()) ? m : '<email>'));
  // Nom du poste et nom d'utilisateur seuls (appareil nomme d'apres le poste).
  for (const [mot, rempl] of [[poste, '<poste>'], [moi, '<utilisateur>']]) {
    if (mot && mot.length >= 3) t = t.replace(new RegExp('(^|[^A-Za-z0-9])' + echapperRe(mot) + '(?=[^A-Za-z0-9]|$)', 'gi'), '$1' + rempl);
  }
  return t;
}

function masquerObjet(o, garder) {
  try { return JSON.parse(masquer(JSON.stringify(o), { garder })); } catch { return o; }
}

// --- construction -------------------------------------------------------------

function horodatage(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const decal = -d.getTimezoneOffset();
  const signe = decal >= 0 ? '+' : '-';
  return {
    lisible: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`,
    fichier: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`,
    local: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
      + `${signe}${p(Math.floor(Math.abs(decal) / 60))}:${p(Math.abs(decal) % 60)}`,
    utc: d.toISOString()
  };
}

const libelle = (liste, cle) => (liste.find((x) => x.cle === cle) || { libelle: cle || '—' }).libelle;

/** Comptes par niveau et dernieres anomalies, sur un journal. */
function resumeJournal(texte) {
  const lignes = texte.split('\n').filter(Boolean);
  const niveaux = {};
  const anomalies = [];
  for (const l of lignes) {
    const m = /^\S+\s+(DEBUG|INFO|WARN|ERREUR)\s/.exec(l);
    if (!m) continue;
    niveaux[m[1]] = (niveaux[m[1]] || 0) + 1;
    if (m[1] === 'ERREUR' || m[1] === 'WARN') anomalies.push(l);
  }
  return { lignes: lignes.length, niveaux, dernieresAnomalies: anomalies.slice(-15) };
}

/** Rapport complet, masque, pret a partir. Ne contacte rien. */
function construire(f = {}) {
  const h = horodatage();
  const id = 'R' + h.fichier.replace(/[-_]/g, '').slice(2) + '-' + crypto.randomBytes(2).toString('hex');
  const infos = (() => { try { return cfg.infos(); } catch (e) { return { erreurInfos: e.message }; } })();
  const sujet = SUJETS.some((s) => s.cle === f.sujet) ? f.sujet : 'autre';
  const email = String(f.email || '').trim() || null;
  const garder = email ? [email] : [];
  const formulaire = {
    sujet: libelle(SUJETS, sujet), depuis: libelle(DEPUIS, f.depuis),
    reproductible: libelle(REPRODUCTIBLE, f.reproductible),
    description: String(f.description || '').slice(0, 20000), email
  };

  const journaux = journal.fichiers().map((chemin) => {
    let brut = '';
    try { brut = fs.readFileSync(chemin, 'utf8'); } catch (e) { brut = '(illisible : ' + e.message + ')'; }
    return { nom: path.basename(chemin), texte: masquer(brut, { garder }) };
  });
  const resume = resumeJournal(journaux.length ? journaux[0].texte : '');
  const application = masquerObjet(infos, garder);

  const objet = `${PREFIXE_OBJET} ${formulaire.sujet} — v${cfg.version} — ${h.lisible} — ${id}`;
  const corps = [
    'Rapport ' + id + ' du ' + h.local + ' (UTC ' + h.utc + ')',
    '',
    'Sujet          : ' + formulaire.sujet,
    'Depuis quand   : ' + formulaire.depuis,
    'Reproductible  : ' + formulaire.reproductible,
    'Contact        : ' + (formulaire.email || '(non renseigné)'),
    'Version        : ' + cfg.version + ' — ' + (application.os || ''),
    'Appareil       : ' + ((application.appareil && application.appareil.id) || '?') + ' · session ' + journal.SESSION,
    '',
    'Ce qui s’est passé :',
    formulaire.description || '(non décrit)',
    '',
    'Journal : ' + resume.lignes + ' lignes, ' + JSON.stringify(resume.niveaux),
    'Dernières anomalies :',
    ...(resume.dernieresAnomalies.length ? resume.dernieresAnomalies : ['(aucune)']),
    '',
    'État de l’application :',
    JSON.stringify(application, null, 2)
  ].join('\n');

  return {
    id, horodatage: h, objet, corps, contact: email,
    rapport: { id, horodatage: h, formulaire, application, session: journal.SESSION, journal: { fichiers: journaux.map((j) => j.nom), ...resume } },
    journaux, resume
  };
}

/** Ce qui partira, pour l'apercu du formulaire (textes des journaux exclus). */
function apercu(f) {
  const r = construire(f);
  return {
    id: r.id, objet: r.objet, corps: r.corps, destinataire: DESTINATAIRE, envoiDirect: configure(),
    journaux: r.journaux.map((j) => ({ nom: j.nom, octets: Buffer.byteLength(j.texte) })),
    niveaux: r.resume.niveaux, lignes: r.resume.lignes
  };
}

function charge(r) {
  return {
    v: 1, cle: cfg.config.cle, id: r.id, objet: r.objet, corps: r.corps, contact: r.contact, rapport: r.rapport,
    journaux: r.journaux.map((j) => {
      const brut = Buffer.from(j.texte, 'utf8');
      return { nom: j.nom, octets: brut.length, gz64: zlib.gzipSync(brut).toString('base64') };
    })
  };
}

/** Une tentative. err.reessayable : la meme requete peut passer au coup suivant. */
async function tenter(corpsJson) {
  const ctl = new AbortController();
  const minuteur = setTimeout(() => ctl.abort(), DELAI_ENVOI);
  let res;
  let txt;
  try {
    res = await cfg.fetch(cfg.config.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: corpsJson, signal: ctl.signal
    });
    txt = await res.text();
  } catch (e) {
    const err = new Error(e.name === 'AbortError' ? 'délai dépassé' : e.message);
    err.reessayable = true;
    throw err;
  } finally { clearTimeout(minuteur); }
  let rep = null;
  try { rep = JSON.parse(txt); } catch { /* page HTML de Google, pas la reponse du script */ }
  if (rep && rep.ok) return rep;
  if (rep) {
    const err = new Error('Refus du service : ' + rep.erreur);
    err.reessayable = /trop de rapports/.test(String(rep.erreur));
    throw err;
  }
  const langue = (/<html[^>]*\blang="([^"]+)"/i.exec(txt || '') || [])[1];
  const err = new Error('Google a répondu ' + res.status + ' au lieu du script de réception'
    + (langue && !/^fr|^en/i.test(langue) ? ' (page en langue « ' + langue + ' » : réseau ou VPN localisé à l’étranger ?)' : '')
    + '. Le rapport repartira tout seul.');
  err.reessayable = true;
  err.detail = { status: res.status, type: res.headers && res.headers.get ? res.headers.get('content-type') : null, langue, debut: String(txt || '').slice(0, 120) };
  throw err;
}

/** Envoi avec reessais (pannes intermittentes de Google, reseau instable). */
async function poster(corpsJson) {
  let derniere;
  for (let i = 0; i < ESSAIS; i++) {
    try {
      const rep = await tenter(corpsJson);
      if (i) journal.evt('rapport', 'envoi-reussi-apres-essais', { essais: i + 1 });
      return rep;
    } catch (e) {
      derniere = e;
      journal.avertir('rapport', 'essai-echoue', { essai: i + 1, sur: ESSAIS, erreur: e.message, detail: e.detail, reessayable: !!e.reessayable });
      if (!e.reessayable || i === ESSAIS - 1) break;
      await pause(PAUSES[i] || PAUSES[PAUSES.length - 1]);
    }
  }
  throw derniere;
}

// --- rapports en attente (hors ligne) ------------------------------------------

function listerAttente() {
  if (!cfg) return [];
  try { return fs.readdirSync(dossierAttente()).filter((n) => /^rapport-.*\.json$/.test(n)).sort(); }
  catch { return []; }
}

function mettreEnAttente(corpsJson, id) {
  fs.mkdirSync(dossierAttente(), { recursive: true });
  lisezmoi.deposer(cfg.dossier, 'rapports');
  lisezmoi.deposer(dossierAttente(), 'rapports_attente');
  const chemin = path.join(dossierAttente(), 'rapport-' + id + '.json');
  fs.writeFileSync(chemin, corpsJson, 'utf8');
  return chemin;
}

/**
 * Envoie le rapport. En echec (hors ligne, service absent), il est garde en
 * attente et renvoye au prochain lancement.
 * @returns {Promise<{ok, id} | {enAttente, id, erreur} | {secours, mailto, id}>}
 */
async function envoyer(f) {
  const r = construire(f);
  const t0 = Date.now();
  journal.evt('rapport', 'envoi:debut', {
    id: r.id, sujet: r.rapport.formulaire.sujet, depuis: f.depuis, reproductible: f.reproductible,
    description: journal.decrireTexte(r.rapport.formulaire.description), emailFourni: !!r.contact,
    journaux: r.journaux.map((j) => j.nom), direct: configure()
  });

  if (!configure()) {
    journal.avertir('rapport', 'envoi-direct-non-configure', { id: r.id });
    return { secours: true, id: r.id, mailto: mailto(r) };
  }
  const corpsJson = JSON.stringify(charge(r));
  try {
    const rep = await poster(corpsJson);
    journal.evt('rapport', 'envoi:fin', { id: r.id, octets: corpsJson.length, pieces: rep.pieces, ms: Date.now() - t0 });
    return { ok: true, id: r.id };
  } catch (e) {
    const chemin = mettreEnAttente(corpsJson, r.id);
    journal.erreur('rapport', 'envoi-echec', e, { id: r.id, enAttente: chemin, octets: corpsJson.length, ms: Date.now() - t0 });
    return { enAttente: true, id: r.id, erreur: e.message };
  }
}

/** Renvoie les rapports restes en attente. Silencieux si hors ligne. */
async function renvoyerEnAttente() {
  if (!configure()) return { envoyes: 0, restants: listerAttente().length };
  let envoyes = 0;
  for (const nom of listerAttente()) {
    const chemin = path.join(dossierAttente(), nom);
    try {
      const corps = fs.readFileSync(chemin, 'utf8');
      // La cle a pu changer depuis la mise en attente : on remet la courante.
      const obj = JSON.parse(corps);
      obj.cle = cfg.config.cle;
      await poster(JSON.stringify(obj));
      fs.rmSync(chemin, { force: true });
      envoyes++;
      journal.evt('rapport', 'renvoi', { fichier: nom });
    } catch (e) {
      journal.evt('rapport', 'renvoi-reporte', { fichier: nom, erreur: e.message }, 'WARN');
      break;   // hors ligne : inutile d'insister sur les suivants
    }
  }
  return { envoyes, restants: listerAttente().length };
}

/** Repli sans service : messagerie avec le texte (tronque), sans piece jointe. */
function mailto(r) {
  const base = 'mailto:' + DESTINATAIRE + '?subject=' + encodeURIComponent(r.objet) + '&body=';
  let corps = r.corps;
  while (corps.length > 200 && (base + encodeURIComponent(corps)).length > MAX_MAILTO) {
    corps = corps.slice(0, Math.floor(corps.length * 0.85));
  }
  if (corps !== r.corps) corps += '\n[…tronqué]';
  return base + encodeURIComponent(corps);
}

/** Texte complet a coller dans un mail (dernier recours). */
function texteACopier(f) {
  const r = construire(f);
  return 'À : ' + DESTINATAIRE + '\nObjet : ' + r.objet + '\n\n' + r.corps;
}

/** Tests : pauses instantanees entre les essais. */
function _pauses(fn) { pause = fn; }

module.exports = {
  _pauses, listerAttente,
  configurer, choix, apercu, envoyer, renvoyerEnAttente, texteACopier, masquer, resumeJournal, horodatage,
  construire, DESTINATAIRE, PREFIXE_OBJET, SUJETS, DEPUIS, REPRODUCTIBLE
};
