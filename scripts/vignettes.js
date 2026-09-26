'use strict';
/**
 * Vignettes et manifeste des images du pack.
 *
 *   data/vignettes/<nom>.jpg     cote max 480 px : grilles, et repli hors ligne.
 *                                Embarquees dans l'appli (PC et mobile).
 *   data/images-manifest.json    { nom: { octets, sha256 } } des grandes images
 *                                (data/images/), qui ne sont plus embarquees :
 *                                l'appli les telecharge a la demande et verifie
 *                                chaque fichier contre ce manifeste.
 *
 *     node scripts/vignettes.js [--force]
 *
 * A relancer apres un `npm run import` qui ajoute ou change des images, en
 * montant REF : l'appli telecharge les grandes images depuis le depot a l'etat
 * du tag REF (git tag REF && git push origin REF), jamais depuis main (une
 * image changee ne correspondrait plus a son empreinte).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Jimp = require('jimp');

const RACINE = path.resolve(__dirname, '..');
const SOURCE = path.join(RACINE, 'data', 'images');
const CIBLE = path.join(RACINE, 'data', 'vignettes');
const MANIFESTE = path.join(RACINE, 'data', 'images-manifest.json');
const COTE = 480;
const QUALITE = 74;
const REF = 'images-1';

(async () => {
  const force = process.argv.includes('--force');
  fs.mkdirSync(CIBLE, { recursive: true });
  const noms = fs.readdirSync(SOURCE).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
  const manifeste = {};
  let faites = 0, octetsVignettes = 0;
  const t0 = Date.now();
  for (const nom of noms) {
    const src = path.join(SOURCE, nom);
    const brut = fs.readFileSync(src);
    manifeste[nom] = { octets: brut.length, sha256: crypto.createHash('sha256').update(brut).digest('hex') };
    const dest = path.join(CIBLE, nom.replace(/\.(png|jpe?g)$/i, '.jpg'));
    if (force || !fs.existsSync(dest)) {
      const img = await Jimp.read(brut);
      if (Math.max(img.bitmap.width, img.bitmap.height) > COTE) img.scaleToFit(COTE, COTE);
      await img.quality(QUALITE).writeAsync(dest);
      faites++;
      if (faites % 25 === 0) process.stdout.write('  ' + faites + '/' + noms.length + '\n');
    }
    octetsVignettes += fs.statSync(dest).size;
  }
  fs.writeFileSync(MANIFESTE, JSON.stringify({ ref: REF, images: manifeste }, null, 1) + '\n');
  const mo = (n) => (n / 1048576).toFixed(1) + ' Mo';
  const grandes = Object.values(manifeste).reduce((s, x) => s + x.octets, 0);
  console.log(`${noms.length} images : ${faites} vignettes faites (${Math.round((Date.now() - t0) / 1000)} s). `
    + `Vignettes ${mo(octetsVignettes)}, grandes ${mo(grandes)}.`);
})().catch((e) => { console.error(e); process.exit(1); });
