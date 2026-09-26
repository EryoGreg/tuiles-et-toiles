'use strict';
/**
 * Icones Android (mipmap-*) a partir de l'icone du PC (build/icon.png).
 *
 * Icone adaptative (Android 8+) : fond = l'icone, reduite au centre d'une
 * toile sombre, pour que la decoupe du fabricant (cercle, carre arrondi…) ne
 * montre que la partie utile ; premier plan transparent. Icones classiques
 * (ic_launcher, ic_launcher_round) pour les anciens Android.
 *
 *     node scripts/icones-android.js
 */

const path = require('path');
const Jimp = require('jimp');

const RACINE = path.resolve(__dirname, '..');
const RES = path.join(RACINE, 'android', 'app', 'src', 'main', 'res');
const FOND = 0x15110fff;   // --fond du theme sombre
const DENSITES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

(async () => {
  const source = await Jimp.read(path.join(RACINE, 'build', 'icon.png'));
  for (const [nom, k] of Object.entries(DENSITES)) {
    const dossier = path.join(RES, 'mipmap-' + nom);
    // Adaptative : toile 108 dp, zone visible ~72 dp au centre ; icone a 80 dp.
    const toile = Math.round(108 * k);
    const taille = Math.round(80 * k);
    const fond = new Jimp(toile, toile, FOND);
    fond.composite(source.clone().resize(taille, taille), (toile - taille) / 2, (toile - taille) / 2);
    await fond.writeAsync(path.join(dossier, 'ic_launcher_background.png'));
    await new Jimp(toile, toile, 0x00000000).writeAsync(path.join(dossier, 'ic_launcher_foreground.png'));
    // Classiques : 48 dp, carre arrondi et rond.
    const c = Math.round(48 * k);
    const carre = source.clone().resize(c, c);
    const r = c * 0.18;
    carre.scan(0, 0, c, c, function (x, y, idx) {
      const dx = Math.max(0, r - x, x - (c - 1 - r)), dy = Math.max(0, r - y, y - (c - 1 - r));
      if (dx * dx + dy * dy > r * r) this.bitmap.data[idx + 3] = 0;
    });
    await carre.writeAsync(path.join(dossier, 'ic_launcher.png'));
    const rond = source.clone().resize(c, c);
    rond.scan(0, 0, c, c, function (x, y, idx) {
      const dx = x - (c - 1) / 2, dy = y - (c - 1) / 2;
      if (dx * dx + dy * dy > (c / 2) * (c / 2)) this.bitmap.data[idx + 3] = 0;
    });
    await rond.writeAsync(path.join(dossier, 'ic_launcher_round.png'));
  }
  console.log('icones Android : ' + Object.keys(DENSITES).length + ' densites');
})().catch((e) => { console.error(e); process.exit(1); });
