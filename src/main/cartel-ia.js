'use strict';
/**
 * Lecture amelioree d'un cartel par Claude (vision), commune PC et mobile.
 * Option payante a l'usage, avec la cle API de l'utilisateur (ia-cle.js) :
 * jamais par defaut, toujours sur un geste (« Relire avec Claude »).
 *
 * Envoye : la photo (reduite a 1 568 px de cote, ce que Claude lit au mieux)
 * et la liste des categories existantes de l'utilisateur. Rendu : la meme
 * forme que la lecture locale (lignes + roles + proposition), donc la meme
 * boite de correction, rien d'ecrit avant « Valider » — avec en plus des
 * categories prises dans le vocabulaire de l'utilisateur.
 *
 * Modele : gamme choisie dans Options (« sonnet » par defaut, « haiku » moins
 * cher) -> identifiant connu (MODELES). Modele retire (404) : l'API ne
 * remplace rien d'elle-meme ; on prend le plus recent de la meme gamme
 * disponible sur le compte, sinon la gamme au-dessus (jamais Opus d'office),
 * et on le dit (`remplace`).
 */

const journal = require('./journal');

const GAMMES = {
  sonnet: { id: 'claude-sonnet-5-5', prix: [2, 10], effort: 'low', fallbacks: true },
  haiku: { id: 'claude-haiku-4-5', prix: [1, 5], effort: null, fallbacks: false }
};
// Prix ($ par million) des modeles connus ; un remplacant inconnu prend ceux de sa gamme.
const PRIX = { 'claude-sonnet-5-5': [2, 10], 'claude-haiku-4-5': [1, 5] };
const SUIVANTE = { haiku: 'sonnet', sonnet: null };
const ROLES = ['artiste', 'vie', 'titre', 'date', 'technique', 'texte', 'provenance', 'numero', 'traduction', 'doublon', 'autre'];

const SCHEMA = {
  type: 'object',
  properties: {
    lignes: {
      type: 'array',
      items: {
        type: 'object',
        properties: { texte: { type: 'string' }, role: { type: 'string', enum: ROLES } },
        required: ['texte', 'role'],
        additionalProperties: false
      }
    },
    champs: {
      type: 'object',
      properties: {
        titre: { type: 'string' }, artiste: { type: 'string' }, date: { type: 'string' },
        description: { type: 'string' }, tags: { type: 'string' }
      },
      required: ['titre', 'artiste', 'date', 'description', 'tags'],
      additionalProperties: false
    }
  },
  required: ['lignes', 'champs'],
  additionalProperties: false
};

const CONSIGNE = [
  'Tu lis la photo d\'un cartel de musée (ou d\'un panneau de salle) pour remplir la fiche d\'une œuvre',
  'dans une application d\'entraînement à l\'histoire de l\'art. Réponds uniquement par le JSON demandé.',
  '',
  'lignes : chaque ligne imprimée, dans l\'ordre de lecture, recopiée telle quelle (accents et',
  'ponctuation corrigés seulement si la photo est floue), avec son rôle :',
  '  artiste (nom de l\'auteur, de l\'atelier ou de la manufacture), vie (dates et lieux de naissance /',
  '  mort de l\'artiste), titre, date (de l\'œuvre), technique (matériaux, support), texte (paragraphe',
  '  explicatif), provenance (don, legs, achat, numéro d\'inventaire, mécénat), numero (numéro de vitrine ou',
  '  d\'audioguide), traduction (version anglaise ou autre langue), doublon (ligne répétée), autre.',
  '  Ignore les pictogrammes et ce qui n\'appartient pas au cartel (cartel voisin coupé : autre).',
  '',
  'champs :',
  '  titre : le titre en français, sur une seule ligne, sans la traduction.',
  '  artiste : le nom seul, sans ses dates ni lieux de vie ; garde « Attribué à », « Atelier de »…',
  '  date : telle qu\'imprimée pour l\'œuvre (« Vers 1890 », « 1620-1625 », « milieu du XVIe siècle »).',
  '  description : le texte explicatif en français, mot pour mot, paragraphes séparés par un saut de',
  '  ligne ; vide s\'il n\'y en a pas.',
  '  tags : les catégories de l\'œuvre, séparées par « , ». Prends-les dans la liste des catégories',
  '  existantes ci-dessous quand l\'une convient (même orthographe) : type d\'œuvre (Peinture, Sculpture…),',
  '  technique (huile, marbre…), genre (Portrait, Paysage…), mouvement si le cartel ou l\'œuvre le rendent',
  '  évident. N\'ajoute une catégorie nouvelle que si aucune existante ne convient. 2 à 6 catégories.',
  '  N\'invente rien : un champ absent du cartel ou illisible reste vide (sauf tags, déduits du cartel).'
].join('\n');

function erreurLisible(e) {
  const st = e && e.status;
  const m = String((e && e.message) || e);
  if (st === 401) return 'Clé API refusée par Anthropic (révoquée ou mal copiée).';
  if (st === 403) return 'Cette clé API n’a pas accès à ce modèle.';
  if (st === 429) return 'Trop de demandes à Claude pour l’instant : réessaie dans une minute.';
  if (st === 400 && /credit|balance|billing/i.test(m)) return 'Crédit Anthropic épuisé : recharge-le sur console.anthropic.com.';
  if (st >= 500) return 'Claude ne répond pas pour l’instant (panne passagère).';
  if (/connection|fetch|network|ENOTFOUND|ETIMEDOUT|timeout/i.test(m) && !st) return 'Pas de connexion : la lecture par Claude demande internet.';
  return 'Lecture par Claude impossible (' + m.slice(0, 160) + ').';
}

/** Plus recent modele de la gamme disponible sur le compte (Models API), sinon gamme au-dessus. */
async function remplacant(client, gamme) {
  const tous = [];
  for await (const m of client.models.list()) tous.push(m);
  for (let g = gamme; g; g = SUIVANTE[g]) {
    const ok = tous.filter((m) => new RegExp('^claude-' + g + '-').test(m.id))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    if (ok.length) return { id: ok[0].id, gamme: g };
  }
  return null;
}

function coutDollars(id, gamme, usage) {
  const [pin, pout] = PRIX[id] || (GAMMES[gamme] || GAMMES.sonnet).prix;
  const u = usage || {};
  const entree = (u.input_tokens || 0) + 1.25 * (u.cache_creation_input_tokens || 0) + 0.1 * (u.cache_read_input_tokens || 0);
  return (entree * pin + (u.output_tokens || 0) * pout) / 1e6;
}

/**
 * @param {{ image: { data: string, media_type: string }, categories: string[], cle: string,
 *           gamme?: 'sonnet'|'haiku', modeleId?: string, Anthropic?: Function }} o
 *   modeleId : identifiant retenu par un remplacement precedent (sinon celui de la gamme)
 * @returns {Promise<{ lignes, proposition, modele, cout, usage, ms, remplace? } | { erreur }>}
 */
async function lire(o) {
  const t0 = Date.now();
  if (!o.cle) return { erreur: 'Aucune clé API Claude : Options → Lecture améliorée.' };
  const gamme = GAMMES[o.gamme] ? o.gamme : 'sonnet';
  const A = o.Anthropic || require('@anthropic-ai/sdk').default;
  // WebView Android : appel direct depuis la page, avec la cle de l'utilisateur (la sienne, sur son appareil).
  const client = new A({ apiKey: o.cle, dangerouslyAllowBrowser: true, maxRetries: 2, timeout: 90000 });
  let id = o.modeleId || GAMMES[gamme].id;
  let remplace = null;
  const categories = (o.categories || []).slice(0, 250).join(', ');

  const requete = (modele) => {
    const g = GAMMES[gamme];
    const corps = {
      model: modele,
      max_tokens: 4000,
      system: [{ type: 'text', text: CONSIGNE, cache_control: { type: 'ephemeral' } }],
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: o.image.media_type, data: o.image.data } },
          { type: 'text', text: 'Catégories existantes : ' + (categories || '(aucune)') }
        ]
      }],
      output_config: { format: { type: 'json_schema', schema: SCHEMA }, ...(g.effort ? { effort: g.effort } : {}) }
    };
    // Refus de securite (tres improbable sur un cartel) : reprise automatique par l'API.
    if (g.fallbacks && /sonnet-5-5/.test(modele)) {
      return client.beta.messages.create({ ...corps, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    }
    return client.messages.create(corps);
  };

  let r;
  try {
    try { r = await requete(id); } catch (e) {
      if (e && e.status === 404) {
        const rem = await remplacant(client, gamme);
        if (!rem) throw e;
        journal.avertir('cartel', 'ia-modele-remplace', { avant: id, apres: rem.id });
        remplace = { avant: id, apres: rem.id };
        id = rem.id;
        r = await requete(id);
      } else throw e;
    }
  } catch (e) {
    journal.erreur('cartel', 'ia-echec', e, { modele: id, statut: e && e.status, ms: Date.now() - t0 });
    return { erreur: erreurLisible(e), modele: id };
  }

  const ms = Date.now() - t0;
  const cout = coutDollars(r.model || id, gamme, r.usage);
  if (r.stop_reason === 'refusal') {
    journal.avertir('cartel', 'ia-refus', { modele: r.model, details: r.stop_details || null });
    return { erreur: 'Claude a refusé de lire cette photo.', cout, modele: r.model || id };
  }
  const texte = (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let json;
  try { json = JSON.parse(texte); } catch (e) {
    journal.erreur('cartel', 'ia-json', e, { modele: r.model, stop: r.stop_reason, debut: texte.slice(0, 200) });
    return { erreur: 'Réponse de Claude illisible (' + (r.stop_reason || 'inconnue') + ').', cout, modele: r.model || id };
  }
  const lignes = (json.lignes || []).map((l, i) => ({ texte: String(l.texte || ''), role: ROLES.includes(l.role) ? l.role : 'autre', bloc: i }));
  const c = json.champs || {};
  const proposition = {
    titre: c.titre || '', artiste: c.artiste || '', date: c.date || '',
    description: c.description || '', tags: c.tags || ''
  };
  journal.evt('cartel', 'ia-lu', {
    modele: r.model || id, gamme, ms, cout: Math.round(cout * 1e5) / 1e5, usage: r.usage,
    lignes: lignes.map((l) => ({ t: l.texte, r: l.role })), propose: proposition, remplace
  });
  return { lignes, proposition, modele: r.model || id, cout, usage: r.usage, ms, ia: true, ...(remplace ? { remplace } : {}) };
}

module.exports = { lire, GAMMES, SCHEMA, CONSIGNE, coutDollars, remplacant, erreurLisible };
