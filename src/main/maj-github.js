'use strict';
/**
 * Derniere release GitHub (depot public, API anonyme) : commun au PC
 * (src/main/maj.js) et au mobile (src/mobile/maj.js). Rien ici ne depend
 * d'Electron ; `fetch` est fourni par l'appelant (net.fetch sur PC, fetch de
 * la WebView sur mobile).
 */

const journal = require('./journal');

const DEPOT = 'EryoGreg/tuiles-et-toiles';
const PREFIXE_URL = 'https://github.com/' + DEPOT + '/releases/download/';
const DELAI_API = 10000;

// a strictement superieure a b ? (semver "x.y.z")
function versionSuperieure(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

// Asset servi par les Releases du depot (jamais une URL venue d'ailleurs).
function decrireAsset(a) {
  if (!a || !String(a.browser_download_url).startsWith(PREFIXE_URL)) return null;
  const digest = String(a.digest || '');
  return {
    nom: a.name, url: a.browser_download_url, taille: a.size,
    sha256: digest.startsWith('sha256:') ? digest.slice(7).toLowerCase() : null
  };
}

/**
 * GET releases/latest. -> { release } ou { erreur } (message pour l'utilisateur).
 * Regle 1 : hors ligne ou GitHub en panne -> { erreur }, jamais d'exception.
 */
async function derniereRelease(fetchFn, actuelle, entetes = {}) {
  try {
    const ctl = new AbortController();
    const minuteur = setTimeout(() => ctl.abort(), DELAI_API);
    const res = await fetchFn('https://api.github.com/repos/' + DEPOT + '/releases/latest', {
      headers: { Accept: 'application/vnd.github+json', ...entetes },
      signal: ctl.signal
    });
    clearTimeout(minuteur);
    if (!res.ok) {
      const reste = res.headers.get('x-ratelimit-remaining');
      const reprise = res.headers.get('x-ratelimit-reset');
      journal.avertir('maj', 'github-refus', { status: res.status, limite: reste, reprise });
      if ((res.status === 403 || res.status === 429) && reste === '0') {
        const quand = reprise ? new Date(Number(reprise) * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : null;
        return {
          erreur: 'GitHub limite les vérifications depuis ton réseau (trop de requêtes, fréquent derrière un VPN). '
            + (quand ? 'Réessaie après ' + quand + '.' : 'Réessaie dans une heure.')
        };
      }
      return { erreur: 'GitHub a répondu ' + res.status + '.' };
    }
    const release = await res.json();
    journal.evt('maj', 'derniere-release', {
      actuelle, tag: release.tag_name, publiee: release.published_at,
      assets: (release.assets || []).map((a) => ({ nom: a.name, octets: a.size, digest: !!a.digest }))
    });
    return { release, version: String(release.tag_name || '').replace(/^v/, '') };
  } catch (e) {
    journal.evt('maj', 'github-injoignable', { erreur: e.message, nom: e.name }, 'WARN');
    return { erreur: 'Impossible de joindre GitHub (hors ligne ?).' };
  }
}

module.exports = { DEPOT, PREFIXE_URL, versionSuperieure, decrireAsset, derniereRelease };
