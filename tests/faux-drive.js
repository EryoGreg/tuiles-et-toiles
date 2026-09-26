'use strict';
/**
 * Faux Google Drive en memoire, meme interface `api` que drive.js
 * (voir transport-drive.js). Sert a faire tourner les suites de synchro sur
 * le transport Drive sans reseau ni compte.
 *
 * Comme le vrai : plusieurs fichiers ou dossiers peuvent porter le meme nom
 * dans un meme parent ; createdTime croissant.
 */

let horloge = Date.parse('2026-01-01T00:00:00Z');

function creerFauxDrive() {
  const elements = new Map();   // id -> { id, name, parent, dossier, createdTime, octets }
  let n = 0;
  const appels = { lister: 0, creer: 0, maj: 0, lire: 0, supprimer: 0 };

  const nouveau = (name, parent, dossier, octets) => {
    const id = 'f' + (++n);
    elements.set(id, { id, name, parent, dossier, createdTime: new Date(++horloge).toISOString(), octets });
    return id;
  };

  return {
    appels,
    elements,
    async lister(parent, { nom, dossier } = {}) {
      appels.lister++;
      return [...elements.values()]
        .filter((e) => e.parent === parent && (nom == null || e.name === nom)
          && (dossier == null || e.dossier === dossier))
        .map((e) => ({ id: e.id, name: e.name, dossier: e.dossier, createdTime: e.createdTime }));
    },
    async creerDossier(nom, parent) { appels.creer++; return nouveau(nom, parent, true, null); },
    async creerFichier(nom, parent, octets) { appels.creer++; return nouveau(nom, parent, false, Buffer.from(octets)); },
    async majFichier(id, octets) { appels.maj++; elements.get(id).octets = Buffer.from(octets); },
    async lire(id) {
      appels.lire++;
      const e = elements.get(id);
      if (!e || e.dossier) throw new Error('Drive 404 ' + id);
      return Buffer.from(e.octets);
    },
    async supprimer(id) { appels.supprimer++; elements.delete(id); },
    /** Chemin -> element (tests). */
    trouver(...noms) {
      let parent = 'root';
      let e = null;
      for (const nom of noms) {
        e = [...elements.values()].find((x) => x.parent === parent && x.name === nom);
        if (!e) return null;
        parent = e.id;
      }
      return e;
    }
  };
}

/**
 * Le faux Drive vu a travers HTTP : un fetch qui repond comme l'API REST v3
 * (les requetes que fait src/main/drive-api.js). Sert a faire passer la suite
 * de synchro par le vrai code HTTP (TT_TRANSPORT=drive-http).
 * @param {object} faux  creerFauxDrive()
 * @param {{ jetonValide?: () => boolean }} o
 */
function fetchFauxDrive(faux, { jetonValide = () => true } = {}) {
  const MIME = 'application/vnd.google-apps.folder';
  const reponse = (status, corps, brut) => ({
    ok: status >= 200 && status < 300, status,
    text: async () => (brut ? '' : JSON.stringify(corps || {})),
    json: async () => corps || {},
    arrayBuffer: async () => { const b = Buffer.from(brut || []); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); }
  });
  return async (url, opts = {}) => {
    const u = new URL(url);
    const m = (opts.method || 'GET').toUpperCase();
    const auth = (opts.headers && opts.headers.Authorization) || '';
    if (!/^Bearer .+/.test(auth) || !jetonValide()) return reponse(401, { error: { code: 401, message: 'Invalid Credentials' } });
    const chemin = u.pathname;
    const idDans = (pref) => decodeURIComponent(chemin.slice(pref.length));
    if (m === 'GET' && chemin === '/drive/v3/files') {
      const q = u.searchParams.get('q');
      const parent = /'([^']+)' in parents/.exec(q)[1];
      const nom = /name='((?:[^'\\]|\\.)*)'/.exec(q);
      const dossier = /mimeType!=/.test(q) ? false : /mimeType=/.test(q) ? true : undefined;
      const l = await faux.lister(parent, { nom: nom ? nom[1].replace(/\\(.)/g, '$1') : undefined, dossier });
      return reponse(200, { files: l.map((f) => ({ id: f.id, name: f.name, createdTime: f.createdTime, mimeType: f.dossier ? MIME : 'application/octet-stream' })) });
    }
    if (m === 'POST' && chemin === '/drive/v3/files') {
      const b = JSON.parse(opts.body);
      return reponse(200, { id: await faux.creerDossier(b.name, b.parents[0]) });
    }
    if (m === 'POST' && chemin === '/upload/drive/v3/files') {
      const limite = /boundary=(.+)$/.exec(opts.headers['Content-Type'])[1];
      const corps = Buffer.from(opts.body);
      const parties = [];
      let i = corps.indexOf('--' + limite);
      while (i >= 0) {
        const j = corps.indexOf('--' + limite, i + limite.length + 2);
        if (j < 0) break;
        const partie = corps.subarray(i + limite.length + 4, j - 2);   // sans CRLF de fin
        const k = partie.indexOf('\r\n\r\n');
        parties.push(partie.subarray(k + 4));
        i = j;
      }
      const meta = JSON.parse(parties[0].toString('utf8'));
      return reponse(200, { id: await faux.creerFichier(meta.name, meta.parents[0], parties[1]) });
    }
    if (m === 'PATCH' && chemin.startsWith('/upload/drive/v3/files/')) {
      await faux.majFichier(idDans('/upload/drive/v3/files/'), Buffer.from(opts.body));
      return reponse(200, {});
    }
    if (m === 'DELETE' && chemin.startsWith('/drive/v3/files/')) {
      await faux.supprimer(idDans('/drive/v3/files/'));
      return reponse(204, null, []);
    }
    if (m === 'GET' && chemin.startsWith('/drive/v3/files/') && u.searchParams.get('alt') === 'media') {
      try { return reponse(200, null, await faux.lire(idDans('/drive/v3/files/'))); }
      catch { return reponse(404, { error: { code: 404 } }); }
    }
    return reponse(400, { error: 'requete inattendue ' + m + ' ' + chemin });
  };
}

module.exports = { creerFauxDrive, fetchFauxDrive };
