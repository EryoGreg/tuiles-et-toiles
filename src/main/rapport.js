'use strict';
/**
 * Rapport d'erreur : formulaire -> zip (journal masque + infos systeme) ->
 * messagerie par defaut pre-remplie (destinataire, objet, corps). Le zip est
 * a glisser en piece jointe : un lien mailto: ne peut pas joindre de fichier,
 * le dossier du zip est donc ouvert a cote.
 *
 * Rien ne part sans l'utilisateur : il voit un apercu, puis envoie lui-meme
 * depuis sa messagerie.
 *
 * Masquage (dans le zip seulement ; journal.log local intact) : nom
 * d'utilisateur Windows et nom du poste dans les chemins, adresses email
 * (sauf celle de contact que l'utilisateur saisit volontairement). Les textes
 * des tuiles restent : ils servent a reproduire un cas (cyrillique, caractere
 * interdit…).
 *
 * Objet des mails : « [T&T rapport] <sujet> — v<version> — <date heure> »,
 * prefixe fixe pour un filtre de messagerie.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');
const journal = require('./journal');
const lisezmoi = require('./lisezmoi');

const DESTINATAIRE = 'wn7pocu65@mozmail.com';
const PREFIXE_OBJET = '[T&T rapport]';

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
let dernier = null;   // dernier rapport prepare (pour messagerie / dossier)

/**
 * @param {{ dossier: string, version: string, infos: () => object }} c
 *   dossier : ou ranger les zips ; infos : etat de l'app au moment du rapport
 */
function configurer(c) { cfg = c; }

function choix() { return { sujets: SUJETS, depuis: DEPUIS, reproductible: REPRODUCTIBLE, destinataire: DESTINATAIRE }; }

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

/** Comptes par niveau et dernieres erreurs, sur le journal courant. */
function resumeJournal(texte) {
  const lignes = texte.split('\n').filter(Boolean);
  const niveaux = {};
  const erreurs = [];
  for (const l of lignes) {
    const m = /^\S+\s+(DEBUG|INFO|WARN|ERREUR)\s/.exec(l);
    if (!m) continue;
    niveaux[m[1]] = (niveaux[m[1]] || 0) + 1;
    if (m[1] === 'ERREUR' || m[1] === 'WARN') erreurs.push(l);
  }
  return { lignes: lignes.length, niveaux, dernieresAnomalies: erreurs.slice(-15) };
}

/**
 * Prepare le zip et le mail. Ne contacte rien.
 * @param {{ sujet, depuis, reproductible, description, email }} f
 */
function preparer(f = {}) {
  const h = horodatage();
  const infos = (() => { try { return cfg.infos(); } catch (e) { return { erreurInfos: e.message }; } })();
  const sujet = SUJETS.some((s) => s.cle === f.sujet) ? f.sujet : 'autre';
  const garder = f.email ? [f.email] : [];
  const formulaire = {
    sujet: libelle(SUJETS, sujet), depuis: libelle(DEPUIS, f.depuis),
    reproductible: libelle(REPRODUCTIBLE, f.reproductible),
    description: String(f.description || '').slice(0, 20000), email: String(f.email || '').trim() || null
  };
  journal.evt('rapport', 'preparer', { sujet, depuis: f.depuis, reproductible: f.reproductible,
    description: journal.decrireTexte(formulaire.description), emailFourni: !!formulaire.email });

  // Journaux masques (le plus recent d'abord).
  const fichiers = journal.fichiers();
  const journaux = fichiers.map((chemin) => {
    let brut = '';
    try { brut = fs.readFileSync(chemin, 'utf8'); } catch (e) { brut = '(illisible : ' + e.message + ')'; }
    return { nom: path.basename(chemin), texte: masquer(brut, { garder }) };
  });
  const resume = resumeJournal(journaux.length ? journaux[0].texte : '');

  const rapport = {
    horodatage: h, formulaire, application: masquerObjet(infos, garder),
    session: journal.SESSION, journal: { fichiers: journaux.map((j) => j.nom), ...resume }
  };
  const texte = [
    PREFIXE_OBJET + ' ' + formulaire.sujet,
    '',
    'Rapport du ' + h.local + ' (UTC ' + h.utc + ')',
    'Sujet            : ' + formulaire.sujet,
    'Depuis quand     : ' + formulaire.depuis,
    'Reproductible    : ' + formulaire.reproductible,
    'Contact          : ' + (formulaire.email || '(non renseigné)'),
    '',
    'Description :',
    formulaire.description || '(aucune)',
    '',
    'Application :',
    JSON.stringify(rapport.application, null, 2),
    '',
    'Journal : ' + resume.lignes + ' lignes, ' + JSON.stringify(resume.niveaux),
    'Dernières anomalies :',
    ...resume.dernieresAnomalies
  ].join('\n');

  const nom = `rapport-${h.fichier}-${sujet}.zip`;
  fs.mkdirSync(cfg.dossier, { recursive: true });
  lisezmoi.deposer(cfg.dossier, 'rapports');
  const chemin = path.join(cfg.dossier, nom);
  const zip = new AdmZip();
  zip.addFile(lisezmoi.NOM, Buffer.from(lisezmoi.texte('rapport'), 'utf8'));
  zip.addFile('rapport.txt', Buffer.from(texte, 'utf8'));
  zip.addFile('rapport.json', Buffer.from(JSON.stringify(rapport, null, 2), 'utf8'));
  for (const j of journaux) zip.addFile('journaux/' + j.nom, Buffer.from(j.texte, 'utf8'));
  zip.writeZip(chemin);

  const objet = `${PREFIXE_OBJET} ${formulaire.sujet} — v${cfg.version} — ${h.lisible}`;
  const corps = [
    'Bonjour,',
    '',
    'Sujet : ' + formulaire.sujet,
    'Depuis quand : ' + formulaire.depuis,
    'Reproductible : ' + formulaire.reproductible,
    'Horodatage : ' + h.local,
    'Version : ' + cfg.version + ' — ' + (infos.os || ''),
    'Appareil : ' + ((infos.appareil && infos.appareil.id) || '?') + ' · session ' + journal.SESSION,
    formulaire.email ? 'Contact : ' + formulaire.email : null,
    '',
    'Ce qui s’est passé :',
    formulaire.description ? formulaire.description.slice(0, 700) + (formulaire.description.length > 700 ? ' […suite dans le zip]' : '') : '(non décrit)',
    '',
    '— Pièce jointe à ajouter : ' + nom,
    '  (le dossier qui la contient vient de s’ouvrir : glisse le fichier dans ce mail)'
  ].filter((l) => l !== null).join('\n');
  const mailto = 'mailto:' + DESTINATAIRE + '?subject=' + encodeURIComponent(objet) + '&body=' + encodeURIComponent(corps);

  dernier = { chemin, nom, objet, corps, mailto };
  journal.evt('rapport', 'zip-pret', { nom, octets: fs.statSync(chemin).size, journaux: journaux.map((j) => j.nom), niveaux: resume.niveaux });
  return {
    chemin, nom, objet, corps, destinataire: DESTINATAIRE, octets: fs.statSync(chemin).size,
    apercu: { niveaux: resume.niveaux, lignes: resume.lignes, anomalies: resume.dernieresAnomalies, application: rapport.application }
  };
}

function masquerObjet(o, garder) {
  try { return JSON.parse(masquer(JSON.stringify(o), { garder })); } catch { return o; }
}

function dernierRapport() { return dernier; }

module.exports = {
  configurer, choix, preparer, dernierRapport, masquer, resumeJournal, horodatage,
  DESTINATAIRE, PREFIXE_OBJET, SUJETS, DEPUIS, REPRODUCTIBLE
};
