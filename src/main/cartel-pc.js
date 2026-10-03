'use strict';
/**
 * Lecture d'un cartel sur PC (photo choisie ou deposee -> texte), par la
 * reconnaissance de texte integree a Windows 10/11 (Windows.Media.Ocr, hors
 * ligne, rien a installer ni a telecharger). Equivalent PC de
 * src/mobile/cartel.js (ML Kit) : meme forme de resultat, meme analyse
 * (cartel-analyse.js), meme boite dans l'editeur.
 *
 *   lire(chemin)  -> { lignes, proposition, largeur, hauteur, ms, langue }
 *
 * L'image est reduite (Jimp, cote <= 2400 px, orientation EXIF appliquee) dans
 * un fichier temporaire, lue par un script PowerShell (WinRT), puis effacee.
 * Windows ne donne pas de blocs : on les reconstitue par les ecarts verticaux
 * entre lignes (blocs()). La photo n'est ni gardee ni envoyee.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const journal = require('./journal');
const { analyser } = require('./cartel-analyse');

const COTE_MAX = 2400;

// Script PowerShell 5.1 (WinRT). Passe en -EncodedCommand : ni fichier a
// extraire de l'asar, ni guillemets a echapper. Chemin de l'image : TT_OCR_IMAGE.
const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  'try {',
  '  Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  "  $asTaskG = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
  '  function Attendre($op, [Type]$type) { $t = $asTaskG.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }',
  '  $null = [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]',
  '  $null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]',
  '  $null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics,ContentType=WindowsRuntime]',
  '  $null = [Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]',
  '  $fr = New-Object Windows.Globalization.Language("fr-FR")',
  '  if ([Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($fr)) { $moteur = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($fr) }',
  '  else { $moteur = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }',
  "  if ($moteur -eq $null) { throw 'aucune langue de reconnaissance de texte installee dans Windows' }",
  '  $f = Attendre ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:TT_OCR_IMAGE)) ([Windows.Storage.StorageFile])',
  '  $flux = Attendre ($f.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])',
  '  $dec = Attendre ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($flux)) ([Windows.Graphics.Imaging.BitmapDecoder])',
  '  $bmp = Attendre ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])',
  '  $r = Attendre ($moteur.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])',
  '  $lignes = @()',
  '  foreach ($l in $r.Lines) {',
  '    $mots = @()',
  '    foreach ($m in $l.Words) { $b = $m.BoundingRect; $mots += ,@([math]::Round($b.X), [math]::Round($b.Y), [math]::Round($b.Width), [math]::Round($b.Height)) }',
  '    $lignes += ,@{ t = $l.Text; m = $mots }',
  '  }',
  '  $flux.Dispose()',
  '  @{ ok = $true; langue = $moteur.RecognizerLanguage.LanguageTag; angle = $r.TextAngle; largeur = $bmp.PixelWidth; hauteur = $bmp.PixelHeight; lignes = $lignes } | ConvertTo-Json -Depth 6 -Compress',
  '} catch {',
  '  @{ ok = $false; erreur = $_.Exception.Message } | ConvertTo-Json -Compress',
  '}'
].join('\n');

/**
 * Lignes Windows -> lignes au format de cartel.js : cadre = union des mots,
 * hauteur = hauteur moyenne des mots, blocs reconstitues.
 * @param {{ lignes: Array<{ t: string, m: number[][] }> }} brut
 */
function lignesDepuisOcr(brut) {
  const lignes = [];
  for (const l of (brut && brut.lignes) || []) {
    const mots = (l.m || []).filter((m) => Array.isArray(m) && m.length === 4);
    const t = String(l.t || '').trim();
    // Taches, pictogrammes et reflets lus comme 1 a 3 lettres (« i », « Fi »,
    // « iii », « o)) » d'un logo audio) : du bruit — un numero a un chiffre.
    // Garde les mots courts reels (« Ève », « Job ») : 3 lettres seulement si traits fins.
    if (!mots.length || !t || bruit(t)) continue;
    const x = Math.min(...mots.map((m) => m[0]));
    const y = Math.min(...mots.map((m) => m[1]));
    const x2 = Math.max(...mots.map((m) => m[0] + m[2]));
    const y2 = Math.max(...mots.map((m) => m[1] + m[3]));
    const hauteur = Math.round(mots.reduce((s, m) => s + m[3], 0) / mots.length);
    lignes.push({ texte: String(l.t).trim(), cadre: { x, y, l: x2 - x, h: y2 - y }, hauteur });
  }
  lignes.sort((a, b) => a.cadre.y - b.cadre.y || a.cadre.x - b.cadre.x);
  fusionnerMemeLigne(lignes);
  const nums = blocs(lignes);
  lignes.forEach((l, i) => { l.bloc = nums[i]; });
  return lignes;
}

/**
 * Windows coupe parfois une ligne imprimee en deux au-dela d'un grand blanc
 * (« Francois Froment Meurice » | « (1804-1874) ») : deux lignes sur la meme
 * rangee (recouvrement vertical >= 60 %), de taille voisine, la seconde a
 * droite, sont rejointes. Les colonnes « 1855 … Huile sur toile » (blanc de plus
 * de 6 hauteurs) restent separees : ce sont deux informations.
 */
function fusionnerMemeLigne(lignes) {
  for (let k = lignes.length - 1; k > 0; k--) {
    const a = lignes[k - 1], b = lignes[k];
    const haut = Math.max(a.cadre.y, b.cadre.y), bas = Math.min(a.cadre.y + a.cadre.h, b.cadre.y + b.cadre.h);
    const recouvre = (bas - haut) / Math.max(1, Math.min(a.cadre.h, b.cadre.h));
    const h = Math.max(a.hauteur, b.hauteur, 1);
    const blanc = b.cadre.x - (a.cadre.x + a.cadre.l);
    if (recouvre >= 0.6 && Math.abs(a.hauteur - b.hauteur) <= 0.35 * h && blanc >= 0 && blanc <= 6 * h) {
      a.texte = a.texte + ' ' + b.texte;
      const x2 = Math.max(a.cadre.x + a.cadre.l, b.cadre.x + b.cadre.l), y2 = Math.max(a.cadre.y + a.cadre.h, b.cadre.y + b.cadre.h);
      a.cadre = { x: a.cadre.x, y: Math.min(a.cadre.y, b.cadre.y), l: x2 - a.cadre.x, h: y2 - Math.min(a.cadre.y, b.cadre.y) };
      lignes.splice(k, 1);
    }
  }
}

function bruit(t) {
  if (/\d/.test(t)) return false;
  const lettres = t.replace(/[^A-Za-zÀ-ÿ]/g, '');
  return lettres.length <= 2 || (lettres.length <= 3 && /^[il|!()oO\s.,:;'"-]+$/.test(t));
}

/**
 * Numero de bloc par ligne (lignes triees de haut en bas) : nouveau bloc si
 * l'ecart vertical depasse 0,9 x la plus grande des deux hauteurs (interligne
 * d'un paragraphe ~0,3-0,6), ou si la taille de lettre change de plus de 35 %.
 */
function blocs(lignes) {
  const out = [];
  let n = 0;
  lignes.forEach((l, i) => {
    if (i > 0) {
      const p = lignes[i - 1];
      const ecart = l.cadre.y - (p.cadre.y + p.cadre.h);
      const h = Math.max(p.hauteur, l.hauteur, 1);
      const taille = Math.abs(p.hauteur - l.hauteur) / h;
      if (ecart > 0.9 * h || taille > 0.35) n++;
    }
    out.push(n);
  });
  return out;
}

/**
 * Reduit l'image (orientation appliquee) dans un PNG temporaire, en niveaux de
 * gris. Cartel clair sur fond sombre (Cezanne, Orsay) : inverse — la
 * reconnaissance de Windows lit tres mal le texte blanc (« Huilo sur toilo »).
 * Fond sombre = luminance mediane de la zone centrale < 45 %.
 */
async function preparerImage(chemin) {
  const Jimp = require('jimp');
  const img = await Jimp.read(chemin);
  const { width: w, height: h } = img.bitmap;
  if (Math.max(w, h) > COTE_MAX) img.scaleToFit(COTE_MAX, COTE_MAX);
  img.greyscale();
  const inverse = fondSombre(img);
  if (inverse) img.invert();
  // Pas de normalize() : sur les photos reelles il fait ressortir les taches du
  // mur en fausses lettres (« i », « Fi ») sans mieux lire le texte.
  const tmp = path.join(os.tmpdir(), 'tt-cartel-' + process.pid + '-' + Date.now() + '.png');
  await img.writeAsync(tmp);
  return { tmp, largeurOrigine: w, hauteurOrigine: h, inverse };
}

/** Luminance mediane (0..255) du centre de l'image (deja en gris), < 115 = fond sombre. */
function fondSombre(img) {
  const { width: W, height: H, data } = img.bitmap;
  const hist = new Array(256).fill(0);
  let n = 0;
  const pas = Math.max(1, Math.floor(Math.min(W, H) / 200));
  for (let y = Math.floor(H * 0.2); y < H * 0.8; y += pas) {
    for (let x = Math.floor(W * 0.2); x < W * 0.8; x += pas) { hist[data[(y * W + x) * 4]]++; n++; }
  }
  let cumul = 0;
  for (let v = 0; v < 256; v++) { cumul += hist[v]; if (cumul >= n / 2) return v < 115; }
  return false;
}

function lancerOcr(image, { timeout = 30000 } = {}) {
  return new Promise((ok, ko) => {
    const enc = Buffer.from(SCRIPT, 'utf16le').toString('base64');
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], {
      windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8',
      env: { ...process.env, TT_OCR_IMAGE: image }
    }, (e, out, err) => {
      const txt = String(out || '').trim();
      const json = txt.slice(txt.indexOf('{'));
      try {
        const r = JSON.parse(json);
        if (!r.ok) return ko(new Error(r.erreur || 'lecture impossible'));
        return ok(r);
      } catch {
        return ko(new Error((e && e.message) || String(err || txt).slice(0, 300) || 'réponse illisible'));
      }
    });
  });
}

let derniere = null;   // derniere photo lue : « Relire avec Claude » la reprend sans la redemander

/**
 * Image a envoyer a Claude : JPEG, cote <= 1 568 px (au-dela Claude reduit
 * lui-meme, on paierait l'envoi pour rien), orientation appliquee.
 * @returns {Promise<{ data: string, media_type: string } | null>}
 */
async function imageIA(chemin = derniere) {
  if (!chemin) return null;
  const Jimp = require('jimp');
  const img = await Jimp.read(chemin);
  if (Math.max(img.bitmap.width, img.bitmap.height) > 1568) img.scaleToFit(1568, 1568);
  const buf = await img.quality(85).getBufferAsync(Jimp.MIME_JPEG);
  return { data: buf.toString('base64'), media_type: 'image/jpeg' };
}

async function lire(chemin) {
  derniere = chemin;
  const t0 = Date.now();
  if (process.platform !== 'win32') return { erreur: 'La lecture de cartel sur ordinateur demande Windows 10 ou 11.' };
  let prep;
  try { prep = await preparerImage(chemin); }
  catch (e) {
    journal.erreur('cartel', 'image', e, { pc: true });
    return { erreur: 'Image illisible (' + ((e && e.message) || e) + ').' };
  }
  try {
    const brut = await lancerOcr(prep.tmp);
    const lignes = lignesDepuisOcr(brut);
    const { champs, roles } = analyser(lignes);
    lignes.forEach((l, i) => { l.role = roles[i]; });
    const ms = Date.now() - t0;
    journal.evt('cartel', 'lu', {
      pc: true, ms, langue: brut.langue, angle: brut.angle, largeur: brut.largeur, hauteur: brut.hauteur, inverse: prep.inverse,
      origine: [prep.largeurOrigine, prep.hauteurOrigine],
      lignes: lignes.map((l) => ({ t: l.texte, r: l.role, b: l.bloc, h: l.hauteur, y: l.cadre.y, x: l.cadre.x })),
      propose: champs
    });
    if (!lignes.length) return { erreur: 'Aucun texte trouvé sur cette image.' };
    return { lignes, proposition: champs, largeur: brut.largeur, hauteur: brut.hauteur, ms, langue: brut.langue };
  } catch (e) {
    journal.erreur('cartel', 'lecture', e, { pc: true, ms: Date.now() - t0 });
    return { erreur: 'La photo n’a pas pu être lue (' + ((e && e.message) || e) + ').' };
  } finally {
    fs.rm(prep.tmp, { force: true }, () => {});
  }
}

module.exports = { lire, imageIA, lignesDepuisOcr, blocs, fondSombre, SCRIPT, derniere: () => derniere };
