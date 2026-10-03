"""
Fabrique des cartels de musee de synthese pour le banc d'essai de la lecture
(tests/banc-cartels.js synthese). Contenu = vraies oeuvres du pack (verite
connue), mises en page inspirees de vrais cartels, polices Windows, et
degradations de photo (inclinaison, perspective, flou, compression, reflet,
bruit, fond sombre).

    python tools/fabriquer-cartels.py [n=60] [graine=1]

Sortie : tests/cartels-synthese/NNN.jpg + NNN.json { attendu, lignes, style,
degradation } (dossier hors depot). Necessite Pillow.
"""
import json, os, random, re, sqlite3, sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SORTIE = os.path.join(RACINE, 'tests', 'cartels-synthese')
POLICES = r'C:\Windows\Fonts'

FAMILLES = {
    'arial': ('arial.ttf', 'arialbd.ttf', 'ariali.ttf'),
    'calibri': ('calibri.ttf', 'calibrib.ttf', 'calibrii.ttf'),
    'candara': ('Candara.ttf', 'Candarab.ttf', 'Candarai.ttf'),
    'garamond': ('GARA.TTF', 'GARABD.TTF', 'GARAIT.TTF'),
    'corbel': ('corbel.ttf', 'corbelb.ttf', 'corbeli.ttf'),
    'constantia': ('constan.ttf', 'constanb.ttf', 'constani.ttf'),
    'bahnschrift': ('bahnschrift.ttf', 'bahnschrift.ttf', 'bahnschrift.ttf'),
    'arialnarrow': ('ARIALN.TTF', 'ARIALNB.TTF', 'ARIALNI.TTF'),
    'times': ('times.ttf', 'timesbd.ttf', 'timesi.ttf'),
    'georgia': ('georgia.ttf', 'georgiab.ttf', 'georgiai.ttf'),
}

VILLES = ['Paris', 'Lyon', 'Rouen', 'Anvers', 'Haarlem', 'Florence', 'Madrid', 'Londres', 'Bordeaux', 'Aix-en-Provence',
          'Toulouse', 'Bruxelles', 'Venise', 'Rome', 'Delft', 'Nantes', 'Dijon', 'Montpellier']
DONS = ['Achat de la Ville, {a}', 'Don de M. {n}, {a}', 'Legs {n}, {a}', 'Dépôt de l’État, {a}', 'Ancienne collection {n}']
NOMS = ['Lacaze', 'Dutuit', 'Pellerin', 'Caillebotte', 'Moreau-Nélaton', 'Personnaz', 'Chauchard']


def police(fam, style, taille):
    f = FAMILLES[fam][{'n': 0, 'g': 1, 'i': 2}[style]]
    try:
        return ImageFont.truetype(os.path.join(POLICES, f), taille)
    except OSError:
        return ImageFont.truetype(os.path.join(POLICES, 'arial.ttf'), taille)


def technique(tags):
    t = (tags or '').lower()
    if 'sculpt' in t or 'marbre' in t:
        return 'Marbre' if 'marbre' in t else random.choice(['Bronze', 'Plâtre patiné', 'Terre cuite'])
    if 'gravure' in t:
        return 'Eau-forte sur papier'
    if 'dessin' in t:
        return random.choice(['Pierre noire sur papier', 'Fusain et craie blanche'])
    if 'aquarelle' in t:
        return 'Aquarelle sur papier'
    if 'mobilier' in t:
        return random.choice(['Bois, ébène, ivoire', 'Acajou, bronze doré'])
    if 'photo' in t:
        return 'Tirage argentique'
    return random.choice(['Huile sur toile', 'Huile sur toile', 'Huile sur bois', 'Huile sur panneau'])


def annee(date):
    m = re.search(r'(\d{3,4})', date or '')
    return int(m.group(1)) if m else random.randint(1500, 1900)


def vie(date):
    a = annee(date)
    n = a - random.randint(25, 55)
    return '{}, {} – {}, {}'.format(random.choice(VILLES), n, random.choice(VILLES), n + random.randint(45, 85))


def phrases(desc, maxi):
    """Texte de cartel : la description du pack, coupee proprement."""
    d = re.sub(r'\s+', ' ', desc or '').strip()
    if not d:
        return ''
    if len(d) <= maxi:
        return d if d.endswith('.') else d + '.'
    coupe = d[:maxi]
    i = max(coupe.rfind('. '), coupe.rfind(', '))
    coupe = coupe[:i] if i > maxi // 2 else coupe.rsplit(' ', 1)[0]
    return coupe.rstrip(',;: ') + '.'


def enrouler(draw, texte, font, largeur):
    mots, lignes, cour = texte.split(' '), [], ''
    for m in mots:
        essai = (cour + ' ' + m).strip()
        if draw.textlength(essai, font=font) <= largeur:
            cour = essai
        else:
            if cour:
                lignes.append(cour)
            cour = m
    if cour:
        lignes.append(cour)
    return lignes


def mise_en_page(o, style, fam):
    """Liste de (texte, taille, graisse, espace_avant, alignement) + verite terrain."""
    dt = (o['date'] or '').strip(' ,.') or str(annee(o['date']))
    tech = technique(o['tags'])
    texte = phrases(o['description'], random.choice([160, 260, 380]))
    art, tit = o['artiste'].strip(), o['titre'].strip()
    tit = tit[0].upper() + tit[1:] if tit else tit
    prov = random.choice(DONS).format(a=random.randint(1820, 2020), n=random.choice(NOMS)) + ', Inv. ' + random.choice(['Bx E ', 'RF ', 'MNR ']) + str(random.randint(10, 999))
    L = []
    if style == 'bordeaux':
        L += [(art, 60, 'n', 0), (vie(o['date']), 30, 'n', 6), (tit, 52, 'n', 40), (dt, 30, 'n', 36), (tech, 30, 'i', 6)]
    elif style == 'orsay':
        L += [(art, 64, 'n', 0), (vie(o['date']), 30, 'n', 8), (tit, 58, 'g', 46), ('Vers ' + dt if dt[:1].isdigit() else dt, 32, 'g', 10), (tech, 32, 'g', 8)]
    elif style == 'simple':
        L += [(art + ' ({}-{})'.format(annee(o['date']) - 40, annee(o['date']) + 30), 56, 'g', 0), (tit, 46, 'i', 6), (dt, 40, 'n', 6), (tech, 40, 'n', 6)]
    elif style == 'vitrine':
        L += [(str(random.randint(1, 30)), 70, 'g', 0), (tit, 76, 'n', 14), (art.upper(), 50, 'n', 34), (random.choice(VILLES) + ', vers ' + dt, 52, 'n', 10), (tech.lower(), 56, 'n', 16)]
    else:  # serif
        L += [(str(random.randint(1, 9)) + '.  ' + art, 44, 'g', 0), (tit, 44, 'i', 4), (tech, 46, 'n', 6), (random.choice(VILLES) + ', ' + dt, 46, 'n', 6)]
    attendu = {'artiste': art, 'titre': tit, 'date': ('Vers ' + dt if style == 'orsay' and dt[:1].isdigit() else ('vers ' + dt if style == 'vitrine' else dt)), 'tags': tech if style != 'vitrine' else tech.lower()}
    if style == 'serif':
        attendu['artiste'] = art
    if texte and style != 'vitrine':
        L.append(('§' + texte, 30 if style != 'simple' else 32, 'n', 44))
        attendu['description'] = texte
    elif style != 'vitrine':
        attendu['description'] = ''
    L.append((prov, 20 if style != 'vitrine' else 40, 'n', 40))
    return L, attendu


def dessiner(o, style, fam, sombre):
    W = random.choice([1500, 1700, 2000])
    fond, encre = ((52, 52, 54), (236, 236, 236)) if sombre else (random.choice([(244, 242, 236), (250, 250, 250), (238, 232, 220)]), (28, 28, 28))
    elements, attendu = mise_en_page(o, style, fam)
    img = Image.new('RGB', (W, 3200), fond)
    d = ImageDraw.Draw(img)
    marge = int(W * 0.1)
    y = int(W * 0.08)
    lignes_imprimees = []
    for texte, taille, graisse, avant in elements:
        taille = int(taille * W / 1500)
        y += int(avant * W / 1500)
        f = police(fam, graisse, taille)
        para = texte.startswith('§')
        brut = texte[1:] if para else texte
        for ligne in (enrouler(d, brut, f, W - 2 * marge) if para or d.textlength(brut, font=f) > W - 2 * marge else [brut]):
            d.text((marge, y), ligne, font=f, fill=encre)
            lignes_imprimees.append(ligne)
            y += int(taille * 1.28)
    img = img.crop((0, 0, W, min(3200, y + int(W * 0.08))))
    return img, attendu, lignes_imprimees


def degrader(img, niveau):
    """niveau 0 (propre) .. 3 (mauvaise photo)."""
    deg = {'niveau': niveau}
    W, H = img.size
    # cadre (mur) autour du cartel
    mur = Image.new('RGB', (int(W * 1.25), int(H * 1.2)), random.choice([(120, 112, 100), (150, 150, 145), (90, 90, 92)]))
    mur.paste(img, ((mur.width - W) // 2, (mur.height - H) // 2))
    img = mur
    if niveau >= 1:
        a = random.uniform(-2.5, 2.5) * niveau / 1.5
        img = img.rotate(a, resample=Image.BICUBIC, expand=False, fillcolor=(110, 105, 95)); deg['rotation'] = round(a, 1)
    if niveau >= 2:
        w, h = img.size
        k = random.uniform(0.02, 0.06) * (niveau - 1)
        coeffs = perspective_coeffs([(0, 0), (w, 0), (w, h), (0, h)], [(w * k, 0), (w * (1 - k / 2), h * k / 2), (w, h), (0, h * (1 - k / 3))])
        img = img.transform((w, h), Image.PERSPECTIVE, coeffs, Image.BICUBIC, fillcolor=(110, 105, 95)); deg['perspective'] = round(k, 3)
    if niveau >= 1:
        # reflet : degrade clair en diagonale
        w, h = img.size
        reflet = Image.linear_gradient('L').rotate(random.choice([30, 120, 210]), expand=False).resize((w, h))
        reflet = reflet.point(lambda p: int(p * 0.18 * niveau))
        img = Image.composite(Image.new('RGB', (w, h), (255, 255, 255)), img, reflet); deg['reflet'] = True
    if niveau >= 2:
        r = random.uniform(0.6, 1.4) * (niveau - 1)
        img = img.filter(ImageFilter.GaussianBlur(r)); deg['flou'] = round(r, 2)
    # photo de telephone transmise : 1500-2000 px, JPEG
    cote = random.choice([1500, 2000]) if niveau < 3 else random.choice([1200, 1500])
    img.thumbnail((cote, cote))
    if niveau >= 2:
        import numpy as np  # noqa
        arr = np.asarray(img).astype('int16')
        arr = arr + np.random.normal(0, 4 * niveau, arr.shape).astype('int16')
        img = Image.fromarray(arr.clip(0, 255).astype('uint8')); deg['bruit'] = 4 * niveau
    deg['jpeg'] = [92, 80, 60, 40][niveau]
    return img, deg


def perspective_coeffs(dst, src):
    import numpy as np
    m = []
    for (x, y), (u, v) in zip(dst, src):
        m.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        m.append([0, 0, 0, x, y, 1, -v * x, -v * y])
    A = np.array(m, dtype=float)
    B = np.array([c for p in src for c in p], dtype=float)
    return np.linalg.solve(A, B).tolist()


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 60
    random.seed(int(sys.argv[2]) if len(sys.argv) > 2 else 1)
    os.makedirs(SORTIE, exist_ok=True)
    for f in os.listdir(SORTIE):
        os.remove(os.path.join(SORTIE, f))
    con = sqlite3.connect(os.path.join(RACINE, 'data', 'pack.db'))
    con.row_factory = sqlite3.Row
    oeuvres = [dict(r) for r in con.execute("SELECT artiste, titre, date, tags, description FROM oeuvres WHERE artiste != '' AND titre != ''")]
    styles = ['bordeaux', 'orsay', 'simple', 'vitrine', 'serif']
    for k in range(n):
        o = random.choice(oeuvres)
        style = styles[k % len(styles)]
        fam = random.choice(list(FAMILLES))
        if style == 'serif':
            fam = random.choice(['garamond', 'constantia', 'georgia', 'times'])
        sombre = style == 'orsay' and random.random() < 0.7
        niveau = [0, 1, 2, 3][(k // len(styles)) % 4]
        img, attendu, lignes = dessiner(o, style, fam, sombre)
        img, deg = degrader(img, niveau)
        nom = '{:03d}-{}-n{}'.format(k + 1, style, niveau)
        img.save(os.path.join(SORTIE, nom + '.jpg'), quality=deg['jpeg'])
        with open(os.path.join(SORTIE, nom + '.json'), 'w', encoding='utf-8') as fh:
            json.dump({'attendu': attendu, 'lignes': lignes, 'style': style, 'police': fam, 'sombre': sombre, 'degradation': deg}, fh, ensure_ascii=False, indent=1)
    print('{} cartels dans {}'.format(n, SORTIE))


if __name__ == '__main__':
    main()
