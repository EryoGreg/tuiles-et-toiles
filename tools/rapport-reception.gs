/**
 * Reception des rapports d'erreur de Tuiles et Toiles (Google Apps Script).
 *
 * L'application envoie le rapport (formulaire + journaux compresses) a ce
 * script, qui le transmet par mail avec les journaux en pieces jointes .txt.
 * Aucun service tiers : le script tourne sur TON compte Google et n'a besoin
 * que d'une autorisation, « envoyer des emails en ton nom ».
 *
 * MISE EN PLACE (une seule fois, ~5 min)
 *  1. https://script.google.com -> Nouveau projet. Nomme-le
 *     « Tuiles et Toiles - rapports ». Remplace le contenu de Code.gs par ce
 *     fichier, puis Enregistrer.
 *  2. Parametres du projet (roue dentee) -> Proprietes du script -> Ajouter :
 *       CLE          = la cle de src/main/rapport-config.json (champ « cle »)
 *       DESTINATAIRE = wn7pocu65@mozmail.com   (facultatif, c'est la valeur par defaut)
 *  3. Deployer -> Nouveau deploiement -> type « Application Web » :
 *       Executer en tant que : Moi
 *       Qui peut acceder     : Tout le monde
 *     Deployer, puis autoriser l'acces (Google affiche « application non
 *     validee » : Parametres avances -> Acceder au projet ; c'est ton script).
 *  4. Copier l'URL de l'application Web (se termine par /exec) dans
 *     src/main/rapport-config.json (champ « url »).
 *  Test : lance testerEnvoi() depuis l'editeur -> un mail de test arrive.
 *
 * Mettre a jour le code plus tard : Deployer -> Gerer les deploiements ->
 * crayon -> Version : « Nouvelle version » (l'URL ne change pas).
 *
 * Garde-fous : cle partagee (arrete les envois au hasard ; elle est dans
 * l'exe, donc pas un vrai secret), 30 rapports par heure au plus, 45 Mo par
 * requete au plus. Quota Google : 100 mails par jour (compte gratuit).
 */

var DESTINATAIRE_DEFAUT = 'wn7pocu65@mozmail.com';
var PREFIXE_OBJET = '[T&T rapport]';
var MAX_PAR_HEURE = 30;
var MAX_REQUETE = 45 * 1024 * 1024;
var MAX_PIECES_TEXTE = 20 * 1024 * 1024;   // au-dela : pieces jointes compressees (.gz)

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) return repondre({ ok: false, erreur: 'requete vide' });
    if (e.postData.contents.length > MAX_REQUETE) return repondre({ ok: false, erreur: 'rapport trop gros' });
    var r = JSON.parse(e.postData.contents);
    var props = PropertiesService.getScriptProperties();
    var cle = props.getProperty('CLE');
    if (!cle || r.cle !== cle) return repondre({ ok: false, erreur: 'cle refusee' });
    if (!quotaOk(props)) return repondre({ ok: false, erreur: 'trop de rapports, reessaie plus tard' });

    var objet = String(r.objet || '');
    if (objet.indexOf(PREFIXE_OBJET) !== 0) objet = PREFIXE_OBJET + ' ' + objet;
    objet = objet.slice(0, 250);

    var pieces = [];
    var total = 0;
    (r.journaux || []).forEach(function (j) {
      var gz = Utilities.newBlob(Utilities.base64Decode(j.gz64), 'application/x-gzip', j.nom + '.gz');
      if (total + (j.octets || 0) <= MAX_PIECES_TEXTE) {
        var txt = Utilities.ungzip(gz);
        pieces.push(Utilities.newBlob(txt.getBytes(), 'text/plain', j.nom + '.txt'));
        total += j.octets || 0;
      } else {
        pieces.push(gz);   // gros journaux anciens : compresses
      }
    });
    if (r.rapport) {
      pieces.push(Utilities.newBlob(JSON.stringify(r.rapport, null, 2), 'application/json', 'rapport.json'));
    }

    var options = { attachments: pieces, name: 'Tuiles et Toiles' };
    var contact = String(r.contact || '');
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact)) options.replyTo = contact;
    var dest = props.getProperty('DESTINATAIRE') || DESTINATAIRE_DEFAUT;
    MailApp.sendEmail(dest, objet, String(r.corps || '(sans texte)'), options);

    return repondre({ ok: true, id: r.id || null, pieces: pieces.length });
  } catch (err) {
    return repondre({ ok: false, erreur: String(err && err.message || err) });
  }
}

// GET : verifier que le deploiement repond (ouvrir l'URL dans un navigateur).
function doGet() {
  return repondre({ ok: true, service: 'Tuiles et Toiles - reception des rapports' });
}

function quotaOk(props) {
  var heure = Utilities.formatDate(new Date(), 'UTC', 'yyyyMMddHH');
  var cleQuota = 'quota_' + heure;
  var n = Number(props.getProperty(cleQuota) || 0);
  if (n >= MAX_PAR_HEURE) return false;
  props.setProperty(cleQuota, String(n + 1));
  // Menage des compteurs des heures passees.
  var toutes = props.getKeys();
  for (var i = 0; i < toutes.length; i++) {
    if (toutes[i].indexOf('quota_') === 0 && toutes[i] !== cleQuota) props.deleteProperty(toutes[i]);
  }
  return true;
}

function repondre(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** A lancer depuis l'editeur pour verifier l'envoi (et accorder l'autorisation). */
function testerEnvoi() {
  var cle = PropertiesService.getScriptProperties().getProperty('CLE');
  var journal = '2026-01-01T00:00:00.000Z  INFO   app  test  s=000000  {"ok":true}\n';
  var gz = Utilities.gzip(Utilities.newBlob(journal, 'text/plain', 'journal.log'));
  var res = doPost({ postData: { contents: JSON.stringify({
    cle: cle, id: 'TEST', objet: PREFIXE_OBJET + ' Test de reception',
    corps: 'Mail de test du script de reception des rapports.',
    journaux: [{ nom: 'journal.log', octets: journal.length, gz64: Utilities.base64Encode(gz.getBytes()) }],
    rapport: { test: true }
  }) } });
  Logger.log(res.getContent());
}
