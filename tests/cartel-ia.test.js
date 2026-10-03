'use strict';
/**
 * Lecture amelioree des cartels par Claude (src/main/cartel-ia.js), avec un
 * faux client Anthropic : forme de la requete, lecture de la reponse, cout,
 * remplacement d'un modele retire, erreurs dites a l'utilisateur, cle jamais
 * journalisee. Aucun appel reseau, aucune depense.
 *
 *     node scripts/lancer-node.js tests/cartel-ia.test.js
 */

const assert = require('assert/strict');
const path = require('path');

const RACINE = path.resolve(__dirname, '..');
const ia = require(path.join(RACINE, 'src/main/cartel-ia'));
const journal = require(path.join(RACINE, 'src/main/journal'));

let nOk = 0, nKo = 0;
async function test(nom, fn) {
  try { await fn(); nOk++; console.log('  ok  ' + nom); }
  catch (e) { nKo++; console.log('  KO  ' + nom + '\n      ' + String(e.stack || e).split('\n').slice(0, 7).join('\n      ')); }
}

const IMAGE = { data: 'QUJD', media_type: 'image/jpeg' };
const CLE = 'sk-ant-api03-' + 'x'.repeat(40);
const REPONSE = {
  lignes: [
    { texte: 'Paul Cézanne', role: 'artiste' },
    { texte: 'Aix-en-Provence 1839 – Aix-en-Provence 1906', role: 'vie' },
    { texte: 'Montagne Sainte-Victoire', role: 'titre' },
    { texte: 'Vers 1890', role: 'date' },
    { texte: 'Huile sur toile', role: 'technique' },
    { texte: 'Dès les années 1880…', role: 'texte' },
    { texte: 'pas un rôle', role: 'nimporte' }
  ],
  champs: { titre: 'Montagne Sainte-Victoire', artiste: 'Paul Cézanne', date: 'Vers 1890', description: 'Dès les années 1880…', tags: 'Peinture, huile, Paysage' }
};

/** Faux client : enregistre les requetes, repond selon `comportement`. */
function faux(comportement) {
  const appels = [];
  class Faux {
    constructor(o) { this.o = o; Faux.options = o; }
    get messages() { return { create: (corps) => { appels.push({ corps, beta: false }); return comportement(corps, appels.length); } }; }
    get beta() { return { messages: { create: (corps) => { appels.push({ corps, beta: true }); return comportement(corps, appels.length); } } }; }
    get models() {
      return {
        list: () => (async function* () {
          for (const m of Faux.modeles || []) yield m;
        })()
      };
    }
  }
  return { Faux, appels };
}
const ok = (json, extra = {}) => async (corps) => ({
  model: corps.model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(json) }],
  usage: { input_tokens: 3000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, ...extra
});
const erreur = (status, message) => { const e = new Error(message); e.status = status; return e; };

(async () => {
  await test('reponse lue : lignes (role inconnu -> autre), proposition, cout, modele', async () => {
    const { Faux } = faux(ok(REPONSE));
    const r = await ia.lire({ image: IMAGE, categories: ['Peinture', 'huile'], cle: CLE, Anthropic: Faux });
    assert.ok(!r.erreur, r.erreur);
    assert.equal(r.ia, true);
    assert.equal(r.lignes.length, 7);
    assert.equal(r.lignes[6].role, 'autre');
    assert.deepEqual(r.proposition, REPONSE.champs);
    assert.equal(r.modele, 'claude-sonnet-5-5');
    assert.ok(Math.abs(r.cout - (3000 * 2 + 500 * 10) / 1e6) < 1e-9, String(r.cout));
  });

  await test('requete Sonnet : image, categories, schema JSON, effort low, reprise en cas de refus', async () => {
    const { Faux, appels } = faux(ok(REPONSE));
    await ia.lire({ image: IMAGE, categories: ['Peinture', 'huile', 'Portrait'], cle: CLE, Anthropic: Faux });
    const { corps, beta } = appels[0];
    assert.equal(beta, true);
    assert.deepEqual(corps.betas, ['server-side-fallback-2026-07-01']);
    assert.equal(corps.fallbacks, 'default');
    assert.equal(corps.model, 'claude-sonnet-5-5');
    assert.equal(corps.output_config.effort, 'low');
    assert.equal(corps.output_config.format.type, 'json_schema');
    assert.equal(corps.output_config.format.schema.additionalProperties, false);
    assert.equal(corps.thinking, undefined, 'pas de reglage de reflexion (adaptatif par defaut)');
    const contenu = corps.messages[0].content;
    assert.deepEqual(contenu[0], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } });
    assert.match(contenu[1].text, /Peinture, huile, Portrait/);
    assert.equal(corps.system[0].cache_control.type, 'ephemeral');
    assert.equal(Faux.options.apiKey, CLE);
  });

  await test('requete Haiku : ni effort (refuse par Haiku 4.5) ni reprise beta', async () => {
    const { Faux, appels } = faux(ok(REPONSE));
    const r = await ia.lire({ image: IMAGE, categories: [], cle: CLE, gamme: 'haiku', Anthropic: Faux });
    assert.ok(!r.erreur);
    assert.equal(appels[0].beta, false);
    assert.equal(appels[0].corps.model, 'claude-haiku-4-5');
    assert.equal(appels[0].corps.output_config.effort, undefined);
    assert.ok(Math.abs(r.cout - (3000 * 1 + 500 * 5) / 1e6) < 1e-9);
  });

  await test('modele retire (404) : plus recent de la meme gamme sur le compte, et dit', async () => {
    const { Faux, appels } = faux(async (corps, n) => {
      if (n === 1) throw erreur(404, 'model: claude-sonnet-5-5 not found');
      return ok(REPONSE)(corps);
    });
    Faux.modeles = [
      { id: 'claude-opus-6', created_at: '2027-05-01' },
      { id: 'claude-sonnet-6', created_at: '2027-03-01' },
      { id: 'claude-sonnet-6-5', created_at: '2027-09-01' },
      { id: 'claude-haiku-5', created_at: '2027-02-01' }
    ];
    const r = await ia.lire({ image: IMAGE, categories: [], cle: CLE, Anthropic: Faux });
    assert.ok(!r.erreur, r.erreur);
    assert.deepEqual(r.remplace, { avant: 'claude-sonnet-5-5', apres: 'claude-sonnet-6-5' });
    assert.equal(appels[1].corps.model, 'claude-sonnet-6-5');
    assert.equal(appels[1].beta, false, 'reprise beta reservee a Sonnet 5.5 (connue)');
  });

  await test('plus de Haiku : gamme au-dessus (Sonnet), jamais Opus d\'office', async () => {
    const { Faux } = faux(async (corps, n) => { if (n === 1) throw erreur(404, 'not found'); return ok(REPONSE)(corps); });
    Faux.modeles = [{ id: 'claude-opus-6', created_at: '2027-05-01' }, { id: 'claude-sonnet-6', created_at: '2027-03-01' }];
    const r = await ia.lire({ image: IMAGE, categories: [], cle: CLE, gamme: 'haiku', Anthropic: Faux });
    assert.equal(r.remplace.apres, 'claude-sonnet-6');
  });

  await test('aucun remplacant : erreur dite', async () => {
    const { Faux } = faux(async () => { throw erreur(404, 'not found'); });
    Faux.modeles = [{ id: 'claude-opus-6', created_at: '2027-05-01' }];
    const r = await ia.lire({ image: IMAGE, categories: [], cle: CLE, gamme: 'sonnet', Anthropic: Faux });
    assert.ok(r.erreur);
  });

  await test('modele deja remplace (modeleId garde) : utilise directement', async () => {
    const { Faux, appels } = faux(ok(REPONSE));
    await ia.lire({ image: IMAGE, categories: [], cle: CLE, modeleId: 'claude-sonnet-6-5', Anthropic: Faux });
    assert.equal(appels[0].corps.model, 'claude-sonnet-6-5');
  });

  await test('erreurs dites en clair : cle, credit, limite, panne, hors ligne', async () => {
    const cas = [
      [erreur(401, 'invalid x-api-key'), /Clé API refusée/],
      [erreur(400, 'Your credit balance is too low'), /Crédit Anthropic épuisé/],
      [erreur(429, 'rate_limit_error'), /Trop de demandes/],
      [erreur(529, 'overloaded'), /ne répond pas/],
      [new Error('Connection error. fetch failed'), /Pas de connexion/]
    ];
    for (const [e, re] of cas) {
      const { Faux } = faux(async () => { throw e; });
      const r = await ia.lire({ image: IMAGE, categories: [], cle: CLE, Anthropic: Faux });
      assert.match(r.erreur, re, e.message);
    }
  });

  await test('refus de securite : erreur, cout compte quand meme', async () => {
    const { Faux } = faux(ok(REPONSE, { stop_reason: 'refusal', stop_details: { category: null } }));
    const r = await ia.lire({ image: IMAGE, categories: [], cle: CLE, Anthropic: Faux });
    assert.match(r.erreur, /refusé/);
    assert.ok(r.cout > 0);
  });

  await test('reponse non JSON : erreur douce', async () => {
    const { Faux } = faux(async (corps) => ({ model: corps.model, stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"lig' }], usage: {} }));
    const r = await ia.lire({ image: IMAGE, categories: [], cle: CLE, Anthropic: Faux });
    assert.match(r.erreur, /illisible/);
  });

  await test('sans cle : rien n\'est envoye', async () => {
    const { Faux, appels } = faux(ok(REPONSE));
    const r = await ia.lire({ image: IMAGE, categories: [], cle: null, Anthropic: Faux });
    assert.match(r.erreur, /Aucune clé/);
    assert.equal(appels.length, 0);
  });

  await test('journal : une cle API n\'apparait jamais, ni en valeur ni sous son nom', () => {
    const r = JSON.stringify(journal.resumerValeur({ cle: CLE, apiKey: CLE, message: 'erreur avec ' + CLE + ' dedans', liste: [CLE] }));
    assert.ok(!r.includes('x'.repeat(40)), r);
    assert.match(r, /"cle":"\*\*\*"/);
    assert.match(r, /"apiKey":"\*\*\*"/);
    assert.match(r, /erreur avec sk-ant-\*\*\* dedans/);
    assert.match(r, /\["sk-ant-\*\*\*"\]/);
  });

  console.log(`\n${nOk} ok, ${nKo} KO`);
  process.exit(nKo ? 1 : 0);
})();
