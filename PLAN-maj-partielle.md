# Plan — mise à jour partielle (Android d'abord)

État : **plan, en attente du feu vert**. Rédigé le 15/10/2026 après la 0.3.17 ; décisions prises le
15/10/2026 (voir « Décisions »).

## Idée

L'APK fait 26 Mo, mais une version ne change presque jamais que le code web
(`dist-mobile/`) : `principal.js` (~720 Ko), l'interface (`assets/index-*.js` ~280 Ko,
CSS ~60 Ko). Le reste ne bouge pas : partie native (Java, modules Capacitor, ML Kit),
`sql-wasm` (650 Ko), `pack.db` (580 Ko), **vignettes (15 Mo)**.

On publie à chaque version, **en plus de l'APK complet**, un petit « paquet web ».
L'appli le télécharge, le vérifie, le range dans ses données, et Capacitor sert
l'interface depuis ce dossier au lancement suivant (`WebView.setServerBasePath` /
`persistServerBasePath`, fonction prévue par Capacitor).

- Téléchargement : **~1 Mo** (zip du web sans vignettes ni pack) au lieu de 26 Mo.
- Ni installateur Android, ni réglage « applis inconnues », ni clic « Installer ».
- Une version qui touche au natif passe toujours par l'APK complet, comme aujourd'hui.

Vérifié dans `Bridge.java` (Capacitor 8) : au démarrage, le chemin persisté n'est
utilisé que si l'APK n'a pas changé (`isNewBinary`). **Un APK neuf reprend toujours la
main** sur un paquet web plus ancien : pas de mélange possible après une MAJ complète.

## Ce qui est publié par version

| Fichier (asset de la release) | Contenu |
|---|---|
| `Tuiles-et-Toiles-x.y.z.apk` | inchangé (installation neuve, MAJ native) |
| `web-x.y.z.zip` | `dist-mobile/` **sans** `vignettes/` ni `pack.db` (~1 Mo compressé) |
| `web-x.y.z.json` | manifeste : `{ version, natifMin, zip: { octets, sha256 }, fichiers: { chemin: { octets, sha256 } } }` |
| `web-x.y.z.json.sig` | signature Ed25519 du manifeste (voir Sécurité) |

`natifMin` = `versionCode` minimal de l'APK capable de faire tourner ce web. Calculé
**automatiquement** par le script de build : empreinte de la partie native (dossier
`android/app/src`, versions des modules `@capacitor/*` et `@capgo/*` dans
`package.json`, `capacitor.config`) comparée à celle de la release précédente. Si elle
change → `natifMin` = cette version (APK obligatoire). On ne compte pas sur la mémoire
de celui qui publie.

## Vignettes et pack hors du paquet web

Avec un `serverBasePath`, **tout** `https://localhost/…` est servi depuis le dossier du
paquet : il faudrait y recopier les 15 Mo de vignettes à chaque mise à jour.
→ Les vignettes sont recopiées **une seule fois** dans `Data/vignettes/` (lues depuis
l'APK par `fetch`, écrites par `@capacitor/filesystem`), et `images-url.js` les sert
par `Capacitor.convertFileSrc` quand ce dossier existe. Même chose pour `pack.db`
(déjà copié dans le vfs au démarrage : à lire depuis l'APK tant qu'il n'est pas dans
`Data/`). Ça prépare aussi « vignettes livrées avec chaque pack » (catalogue).

## Côté appli (`src/mobile/maj-web.js`, nouveau)

1. **Vérifier** (même moment que `maj.js` : 4 s après le lancement, réglage `maj_auto`) :
   release `latest` → manifeste `web-*.json` + signature. Retenu si
   `version > version web en cours` et `natifMin ≤ versionCode installé`. Sinon, la
   section Options propose l'APK complet comme aujourd'hui.
2. **Proposer, puis télécharger** : une version trouvée est **proposée** (boîte « Nouvelle
   version 0.3.N — environ 1 Mo — Mettre à jour / Plus tard »), jamais téléchargée sans
   accord. Hors Wi-Fi, la boîte le dit (« Tu n'es pas en Wi-Fi : le téléchargement
   utilisera tes données mobiles, environ 1 Mo ») ; l'accord vaut quel que soit le
   réseau. Zip vérifié (taille + SHA-256), puis chaque fichier contre le manifeste,
   extrait avec `fflate` dans `Data/web/<version>/` (fichiers temporaires puis renommage
   du dossier : jamais de paquet à moitié écrit).
3. **Appliquer au lancement suivant** : marqueur `web_en_attente = <version>`. Au
   démarrage, tout au début de `principal.js` (avant sql.js) : si un paquet attend →
   `setServerBasePath` (rechargement immédiat sur le nouveau code).
4. **Valider ou revenir en arrière** : le nouveau paquet n'est marqué bon
   (`persistServerBasePath`, `web_ok = <version>`) qu'après un démarrage complet
   (`demarrage-mobile` + interface affichée + 10 s sans erreur fatale). Avant ça, il
   n'est pas persisté : si l'appli plante ou est tuée, le lancement suivant repart sur
   l'ancien code, voit `web_en_attente` sans `web_ok`, note la version comme
   **refusée** (jamais réessayée) et le journalise. Un paquet cassé ne peut pas
   bloquer l'appli.
5. **Ménage** : on garde le paquet en cours + le précédent, le reste est effacé ;
   tout est effacé quand un APK plus récent tourne (`isNewBinary`).
6. **« Redémarrer maintenant »** : une fois le paquet prêt, la boîte (et Options) propose
   « Redémarrer maintenant » ou « Au prochain lancement ». Redémarrer = même étape 3 tout
   de suite. Les données sont écrites avant (`persister()`, comme `recharger()`).

Versions affichées : « 0.3.19 (appli 0.3.17) » dans Options, le rapport d'erreur et
l'en-tête de session du journal.

## Sécurité — à ne pas sauter

Aujourd'hui, un APK piégé publié sur GitHub serait **refusé par Android** (signature
différente de celle de l'appli installée). Un paquet web n'a pas ce garde-fou : sans
mesure, quiconque prend la main sur le compte GitHub ferait tourner son code dans
l'appli (qui a le jeton Drive et les données).
→ **Signature Ed25519 du manifeste** : clé privée hors dépôt (comme `debug.keystore`,
**à sauvegarder**, sinon plus de MAJ web — l'APK reste possible), clé publique dans
l'appli. Signature vérifiée avant tout téléchargement du zip ; empreintes vérifiées
avant d'écrire le moindre fichier. Script `scripts/signer-web.js` lancé par la
procédure de publication.

## Côté publication

- `scripts/paquet-web.js` : après `build-mobile`, produit `release/web-x.y.z.zip`,
  `.json` (avec `natifMin` calculé), `.json.sig`.
- `npm run dist:android` le lance ; `gh release create` reçoit **6 fichiers** (3 + 3).
- `natifMin` et l'empreinte native retenus dans `data/natif.json` (versionné), pour la
  comparaison suivante.
- CLAUDE.md : section « Dépôt, releases » mise à jour (noms d'assets à ne pas changer).

## Tests

- `tests/maj-web.test.js` (faux GitHub, faux Filesystem, faux WebView) : choix
  web/APK selon `natifMin`, signature refusée, empreinte fausse, zip tronqué, appli
  tuée avant validation → retour arrière et version refusée, ménage, APK neuf.
- `scripts/paquet-web.js` : `natifMin` monte quand un fichier Java ou un module natif
  change, pas quand seul le JS change.
- Émulateur : APK 0.3.N installé → paquet web 0.3.N+1 servi par un faux serveur
  local (`TT_MAJ_URL`) → appliqué au lancement suivant, données intactes ; paquet
  volontairement cassé → retour arrière ; APK 0.3.N+2 par-dessus → le code de l'APK
  reprend la main ; mesure du volume réellement téléchargé.

## Découpage

1. ✅ (15/10/2026) Vignettes et pack servis hors du dossier web (`Data/contenu/`,
   `src/mobile/contenu.js`), sans encore rien télécharger. Publiable seul.
2. Script de paquet + signature + `natifMin` automatique ; assets publiés (l'appli ne
   s'en sert pas encore).
3. `maj-web.js` : vérifier / télécharger / appliquer / valider / revenir en arrière,
   tests.
4. Boîte de proposition (Wi-Fi signalé), « Redémarrer maintenant », Options + rapport +
   journal ; essai réel sur émulateur puis chez toi, puis chez ton ami.
5. PC : lanceur minimal + paquet de code signé (voir « PC »), même signature et même
   `natifMin` ; essai installée puis portable.

## Décisions (15/10/2026)

- **Clé de signature** : Ed25519 hors dépôt, sauvegardée avec `debug.keystore`.
- **Application** : au prochain lancement **et** bouton « Redémarrer maintenant ».
- **Réseau** : nouvelle version **proposée** par une boîte ; si l'utilisateur accepte, le
  téléchargement part même hors Wi-Fi, mais la boîte signale qu'il n'est pas en Wi-Fi.

## PC (après Android)

Mesuré sur la 0.3.18 : l'exe fait 95 Mo, dont **Electron ~280 Mo décompressés qui ne
changent presque jamais** ; `app.asar` = 25 Mo, dont l'essentiel en `node_modules`
(Jimp, adm-zip, SDK…) ; **notre code** (`src/` + `dist/`) ≈ 2 à 3 Mo.

Retenu : **même mécanisme que le mobile**, pour la version installée (et, sans travail
en plus, pour la portable) :
- l'`app.asar` livré devient un **lanceur minimal** : au démarrage, il cherche dans
  `%APPDATA%\Tuiles et Toiles\code\` le paquet de code le plus récent **signé et
  validé**, le charge (`require` dans un `.asar` téléchargé : Electron sait faire), et
  les `node_modules` restent ceux de l'exe (`Module.globalPaths`) ;
- même manifeste signé Ed25519, même `natifMin` (ici : version d'Electron, modules
  natifs comme better-sqlite3, dépendances de `package.json` ; s'ils changent →
  installateur complet, comme aujourd'hui) ;
- même retour arrière : paquet validé seulement après un démarrage complet ; à la
  moindre erreur du lanceur, il démarre le code livré dans l'exe ;
- téléchargement ≈ **2 à 3 Mo** au lieu de 95 Mo.

Écarté : le différentiel par blocs (`.blockmap` de NSIS). Il ne demande pas de clé et
reconstitue l'installateur exact, mais le code est compressé dans l'installateur : une
petite modification en touche une grande partie (souvent 10 à 30 Mo téléchargés), et
l'installateur se relance quand même. Moins bon gain, pas de « au prochain lancement ».

Pas de raison de ne pas le faire, seulement un point de vigilance : le **lanceur** est la
seule pièce qui ne se met jamais à jour à chaud ; il doit rester minuscule, testé, et
toujours retomber sur le code livré en cas de doute.
