'use strict';
/**
 * API Drive minimale (REST v3), commune au PC et au mobile : requetes
 * journalisees, jeton d'acces, erreurs de jeton (jetonMort), et l'interface
 * attendue par synchro/transport-drive.js.
 *
 * Independante de la facon d'obtenir le jeton : `oauth` est tout objet qui
 * repond a getAccessToken() -> { token } (OAuth2Client de
 * google-auth-library sur PC, connexion Google native sur mobile).
 *
 *     const { api } = require('./drive-api')({ fetch, journal });
 */

const crypto = require('crypto');

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

module.exports = function creerApiDrive(deps) {
  const journal = deps.journal;

  // --- appels Drive ----------------------------------------------------------

  /** net.fetch journalise (requete HTTP vers Google). Jamais l'en-tete Authorization. */
  async function requete(url, opts = {}) {
    const t0 = Date.now();
    const u = new URL(url);
    const corps = opts.body;
    const info = {
      m: opts.method || 'GET',
      chemin: u.pathname.replace(/^\/(upload\/)?drive\/v3/, (x, up) => (up ? 'upload:' : '')),
      q: u.searchParams.get('q') || undefined,
      upload: u.searchParams.get('uploadType') || undefined,
      envoye: corps ? (corps.byteLength != null ? corps.byteLength : String(corps).length) : undefined
    };
    try {
      const res = await deps.fetch(url, opts);
      journal.evt('drive', 'http', { ...info, status: res.status, ms: Date.now() - t0 }, res.ok ? 'DEBUG' : 'WARN');
      return res;
    } catch (e) {
      journal.erreur('drive', 'http', e, { ...info, ms: Date.now() - t0, horsLigne: /ENOTFOUND|ECONN|ETIMEDOUT|ERR_INTERNET|ERR_NAME/.test(String(e && e.message)) });
      throw e;
    }
  }

  // Jeton refuse par Google : refresh token expire (7 jours tant que l'ecran de
  // consentement est en « Test »), revoque par l'utilisateur, ou scope Drive non
  // coche au consentement. Seule issue : refaire le flux OAuth.
  function erreurJetonMort(detail) {
    const e = new Error('Session Google expirée (' + detail + ').');
    e.jetonMort = true;
    return e;
  }

  async function jetonAcces(oauth) {
    let r;
    const t0 = Date.now();
    try { r = await oauth.getAccessToken(); }
    catch (e) {
      const code = e && e.response && e.response.data && e.response.data.error;
      const detail = { code, description: e && e.response && e.response.data && e.response.data.error_description, ms: Date.now() - t0 };
      if (code === 'invalid_grant' || /invalid_grant/.test(String(e && e.message))) {
        journal.avertir('drive', 'jeton-refuse', { ...detail, raison: 'refresh token expire ou revoque (7 j en mode Test)' });
        throw erreurJetonMort('invalid_grant');
      }
      journal.erreur('drive', 'jeton-echec', e, detail);
      throw e;
    }
    if (!r || !r.token) { journal.avertir('drive', 'jeton-vide'); throw erreurJetonMort('jeton vide'); }
    const ms = Date.now() - t0;
    if (ms > 50) journal.debug('drive', 'jeton-rafraichi', { ms });   // sinon : jeton en cache
    return r.token;
  }

  // 401 : jeton refuse. 403 insufficientPermissions : scope Drive non accorde.
  function verifierAcces(status, txt) {
    if (status === 401) throw erreurJetonMort('401');
    if (status === 403 && /insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT/.test(txt)) {
      throw erreurJetonMort('autorisation Drive manquante');
    }
  }

  async function appelJson(oauth, methode, url, corps) {
    const token = await jetonAcces(oauth);
    const opts = { method: methode, headers: { Authorization: 'Bearer ' + token } };
    if (corps !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(corps);
    }
    const res = await requete(url, opts);
    const txt = await res.text();
    if (!res.ok) {
      verifierAcces(res.status, txt);
      throw new Error('Drive ' + res.status + ' : ' + txt.slice(0, 300));
    }
    return txt ? JSON.parse(txt) : {};
  }

  async function echecEnvoi(res) {
    const txt = await res.text();
    verifierAcces(res.status, txt);
    throw new Error('Envoi ' + res.status + ' : ' + txt.slice(0, 300));
  }

  // --- api minimale pour la synchro ligne a ligne (synchro/transport-drive) ---

  const MIME_DOSSIER = 'application/vnd.google-apps.folder';
  const echapper = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  async function envoiMultipart(oauth, meta, octets, mime) {
    const token = await jetonAcces(oauth);
    const limite = '----tt' + crypto.randomBytes(8).toString('hex');
    const corps = Buffer.concat([
      Buffer.from('--' + limite + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n'),
      Buffer.from('--' + limite + '\r\nContent-Type: ' + mime + '\r\n\r\n'),
      octets,
      Buffer.from('\r\n--' + limite + '--\r\n')
    ]);
    const res = await requete(UPLOAD + '/files?uploadType=multipart&fields=id',
      { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'multipart/related; boundary=' + limite }, body: corps });
    if (!res.ok) await echecEnvoi(res);
    return (await res.json()).id;
  }

  /**
   * Interface attendue par synchro/transport-drive.js, sur le client OAuth
   * donne. Une erreur de jeton remonte (jetonMort) jusqu'a avecReconnexion.
   */
  function api(oauth) {
    return {
      memoCle: 'drive',   // ids Drive uniques : memo valable d'une synchro a l'autre
      async lister(parent, { nom, dossier } = {}) {
        let q = `'${echapper(parent)}' in parents and trashed=false`;
        if (nom != null) q += ` and name='${echapper(nom)}'`;
        if (dossier === true) q += ` and mimeType='${MIME_DOSSIER}'`;
        if (dossier === false) q += ` and mimeType!='${MIME_DOSSIER}'`;
        const out = [];
        let pageToken;
        do {
          const params = {
            q, spaces: 'drive', pageSize: '1000', orderBy: 'createdTime',
            fields: 'nextPageToken,files(id,name,mimeType,createdTime)'
          };
          if (pageToken) params.pageToken = pageToken;
          const r = await appelJson(oauth, 'GET', API + '/files?' + new URLSearchParams(params));
          for (const f of r.files || []) {
            out.push({ id: f.id, name: f.name, dossier: f.mimeType === MIME_DOSSIER, createdTime: f.createdTime });
          }
          pageToken = r.nextPageToken;
        } while (pageToken);
        return out;
      },
      async creerDossier(nom, parent) {
        return (await appelJson(oauth, 'POST', API + '/files?fields=id',
          { name: nom, mimeType: MIME_DOSSIER, parents: [parent] })).id;
      },
      creerFichier(nom, parent, octets, mime) {
        return envoiMultipart(oauth, { name: nom, parents: [parent] }, octets, mime);
      },
      async majFichier(id, octets, mime) {
        const token = await jetonAcces(oauth);
        const res = await requete(UPLOAD + '/files/' + encodeURIComponent(id) + '?uploadType=media&fields=id',
          { method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': mime }, body: octets });
        if (!res.ok) await echecEnvoi(res);
      },
      // Suppression definitive d'un fichier cree par l'app (segment purge, vieux
      // snapshot). Uniquement nos propres fichiers : drive.file n'en voit pas d'autres.
      async supprimer(id) {
        const token = await jetonAcces(oauth);
        const res = await requete(API + '/files/' + encodeURIComponent(id),
          { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
        if (!res.ok && res.status !== 404) {
          const txt = await res.text();
          verifierAcces(res.status, txt);
          throw new Error('Suppression Drive ' + res.status + ' : ' + txt.slice(0, 200));
        }
      },
      async lire(id) {
        const token = await jetonAcces(oauth);
        const res = await requete(API + '/files/' + encodeURIComponent(id) + '?alt=media',
          { headers: { Authorization: 'Bearer ' + token } });
        if (!res.ok) {
          const txt = await res.text();
          verifierAcces(res.status, txt);
          throw new Error('Lecture Drive ' + res.status + ' : ' + txt.slice(0, 200));
        }
        return Buffer.from(await res.arrayBuffer());
      }
    };
  }

  return { api, appelJson, erreurJetonMort, verifierAcces, jetonAcces };
};
