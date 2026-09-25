# Tuiles & Toiles — état du projet

Application de bureau d'entraînement mémoriel en histoire de l'art.
Electron + React + SQLite. Windows, mono-utilisateur.

## Où on en est

**Fait** — l'app tourne et se distribue :

- menu, jeu (modes aléatoire / catégorie), Bibliothèque, Livre / Étoile / À revoir, Options
- vue tuile agrandie (aperçu depuis les galeries ; pointillés dorés sur les
  champs qu'un tirage cacherait)
- tri (ordre d'ajout / numéro + sens) et recherche permissive sur toutes les pages
- 10 thèmes (dont 7 clairs), barres de défilement thématisées
- exe portable unique, données dans `%APPDATA%`, raccourcis bureau / menu /
  barre des tâches + détection des raccourcis périmés au lancement
- **S1 du modèle pack** : socle 2 bases (voir « Architecture données »)

**En cours — Édition (ajouts locaux).** Découpage :

- S1 ✅ socle : `pack.db` / `utilisateur.db`, migration v1 → v2, identité stable
- S2 union `pack ∪ oeuvres_locales` + filtre `user_archive` + overrides + hook recalcul masques
- S3 page Édition + éditeur de tuile + flux « créer »
- S4 pipeline image (dossier local, resize ≤ 500 Ko, sélecteur + drag-drop fichier)
- S5 drag-drop web, modifier / supprimer, `user_archive` pour les œuvres du pack
- S6 undo/redo, menu contextuel (l'export / import zip est passé au chantier synchro, É0)

**En cours — Sauvegarde / synchro Google Drive.** Ce qui voyage : `utilisateur.db`
+ `images-locales/`. Jamais `pack.db`. Découpage :

- É0 ✅ export / import zip (`src/main/sauvegarde.js`, `adm-zip`). Zip = `utilisateur.db`
  (via `VACUUM INTO`, base `pack` exclue) + `images-locales/` + `manifest.json`.
  Import = **remplacement complet**, copie de secours `utilisateur.db.avant-import-<horodatage>`,
  `reconstruireVue({force})` + `window.location.reload()`. Options → « Sauvegarde des données ».
- É1 ✅ snapshot Drive via API (`src/main/drive.js`). OAuth installed-app + PKCE, redirection
  loopback `http://localhost:<port>`, navigateur système. Scope `drive.file`, dossier `Tuiles et
  Toiles/` (sans `&` — nom de dossier Drive). Fichier `utilisateur.zip` mis à jour en place ;
  avant tout écrasement la version distante est copiée dans `historique/`. Conflit détecté via
  `headRevisionId` distant retenu dans la table `sync` (`drive_rev`, `drive_synchro_le`).
  Jeton (refresh_token) chiffré `safeStorage` → `%APPDATA%\Tuiles et Toiles\drive-jeton.bin`.
  Client OAuth : `src/main/oauth-client.json` (gitignoré, embarqué dans l'asar). Projet Google
  Cloud `tuiles-et-toiles`, écran de consentement en **Testing** → chaque testeur à ajouter en
  *test user*, ou publier l'app. Options → « Google Drive » : Connecter / Sauvegarder / Restaurer
  / Déconnecter. Pas d'auto push/pull pour l'instant (boutons manuels).
- É2 (payant) fusion ligne à ligne via journal de changements keyé par `id` stable.
  Cible : PC ↔ mobile (portage Capacitor prévu), plusieurs appareils. Découpage :
  - É2a ✅ journal local (`src/main/synchro/`). `appareil.json` (id 8 hex aléatoire,
    `prefixe_ref`) **hors** `utilisateur.db` — sinon un import zip clonerait l'identité.
    HLC `ms(16)-cpt(4)-appareil`, triable en chaîne. Registre `etat` (source de vérité) +
    journal `changements` + `conflits`. **Toute écriture synchronisable passe par
    `etat.ecrire()`**, qui projette dans `user_tags` / `user_archive` / `user_overrides` /
    `oeuvres_locales` (le code de lecture ne change pas). Suppression locale = pierre tombale
    `_existe = {vu}` (É2b), champs gardés au registre. `user_stats` = un compteur **par appareil**
    (total = SUM), hors journal. Genèse à la première ouverture d'une base : une op par ligne
    existante, HLC = **date réelle** de la ligne. `npm test`.
  - É2b ✅ moteur de fusion (`synchro/moteur.js`, instanciable : `ctx = {d, appareil,
    horloge}` ; `etat.js` = l'appareil courant). `echange.js` pousse / tire via un transport
    (`listerAppareils`, `listerSegments`, `lireSegment`, `ecrireSegment` sans écrasement).
    Deux règles, fonctions de l'**ensemble** des ops (pas de leur ordre) : valeur = op de
    plus grande HLC ; conflit = plusieurs **têtes** de valeurs différentes (tête = op que
    personne ne cite dans `base` ni `vus`). Toute écriture locale cite toutes les têtes
    (`changements.vus`) → éditer ou trancher ferme le conflit partout. Pierre tombale
    `_existe = {vu}` : op de champ > `vu` = « supprimée ici, modifiée là-bas ». Conflits de
    champ d'une tuile supprimée masqués (réapparaissent à la restauration). Ops jamais
    regroupées à l'envoi. Test de propriété : 3 appareils, horloges décalées,
    `tests/synchro-e2b.test.js [n] [graine]`.
  - É2c ✅ synchro par dossier partagé (clé USB, OneDrive, Syncthing) :
    `synchro/transport-dossier.js` (écritures atomiques tmp → rename, noms hors motif ignorés
    — copies de conflit des services de synchro), `synchro/rejoindre.js` (fiche
    `appareils/<id>.json`, préfixe libre + renumérotation à la première entrée, course :
    l'id le plus grand cède), `synchro/service.js` (images → ops → ops reçues → images
    manquantes → `reconstruireVue`). Dossier choisi rangé dans `appareil.json`
    (`dossier_synchro`), tout sous `<dossier>/Tuiles et Toiles/` — **même nom et même
    arborescence que le dossier Drive** (`utilisateur.zip`, `historique/`, `journaux/`,
    `appareils/`, `images/`) : É2d écrira dans le dossier Drive existant. Piège : un dossier
    tenu par Google Drive pour ordinateur (« Mon Drive ») marche entre PC, mais ses fichiers
    sont invisibles de l'API (`drive.file` = fichiers créés par l'app) → avertissement
    dans Options ; sur Drive, tous les appareils passeront par l'API (É2d). Options →
    « Synchro entre appareils » : manuel (bouton), rechargement si des données arrivent.
    `service.resoudre()` tranche **et** reconstruit la vue (à utiliser par l'écran Conflits).
    `TT_TRANSPORT=dossier` rejoue toute la suite É2b sur disque.
  - É2d ✅ synchro par Google Drive : `synchro/transport-drive.js` sur une interface
    minimale (`lister`, `creerDossier`, `creerFichier`, `majFichier`, `lire`) —
    `drive.api(oauth)` en REST, `tests/faux-drive.js` en mémoire. Même arborescence
    (`synchro/format.js`), dans le dossier Drive **existant** « Tuiles et Toiles »
    (`utilisateur.zip` et `historique/` d'É1 intacts). Drive tolère les homonymes : on
    **lit l'union** des dossiers de même nom et on **écrit dans le plus ancien**
    (`orderBy=createdTime`, aussi pour É1). Cœur commun dossier/Drive dans `service.js`
    (`synchroniserDrive`, reconnexion OAuth auto via `drive.avecReconnexion`). Stats de vues
    synchronisées : entité `stat`, champ = appareil, un seul écrivain par champ, émises
    avant chaque envoi (`moteur.emettreStats`). Options → Google Drive : « Synchroniser »
    (fusion) à côté de Sauvegarder / Restaurer (bloc). ~14 appels API pour une synchro à
    vide. `TT_TRANSPORT=drive` rejoue toute la suite É2b sur le faux Drive.
    **Pas encore testé contre le vrai Drive** (pas de compte dans les tests) : premier
    essai réel à faire depuis l'app.
    Push = toutes les ops `pousse = 0` (quel que soit l'appareil d'origine).
  - É2e snapshots (1 000 ops ou 7 jours), segments purgés par **accusé de lecture** de
    tous les appareils actifs (inactif après 90 j), rebase, UI conflits.
  - **À faire, PC et mobile :**
    - **Corbeille** (entrée de menu + compteur) : tuiles locales supprimées (pierre tombale,
      encore au registre) **et** œuvres du pack archivées — aujourd'hui aucune UI ne
      désarchive. Restaurer = `_existe = 1` / archive → NULL, propagé par la synchro. Afficher
      « supprimée le X, définitivement effacée le Y » (purge des pierres tombales à la
      compaction, É2e ; les archives du pack ne sont jamais purgées). Ne plus retirer les
      marques à la suppression d'une tuile locale : elles sont déjà invisibles (jointure sur
      `oeuvres_effectives`) et reviendraient ainsi avec la tuile.
    - **Conflits : jamais de modale au lancement** (règle 1 — la synchro tourne en fond, et au
      musée on ne veut pas être bloqué). La valeur gagnante s'affiche, rien n'attend de
      réponse. Signalement discret : toast à la fin d'une synchro qui en trouve (« 2 conflits
      à trancher — Voir »), pastille sur une entrée de menu « Conflits », marque sur les
      tuiles concernées (galeries, éditeur). Écran « Conflits » : les deux valeurs côte à
      côte, appareil + date de chacune, boutons « garder celle-ci ».
  Décisions actées : préfixe de ref par appareil (`L`, puis `M`, `N`, `P`…) attribué en
  rejoignant ; les tuiles d'un appareil **jamais partagées** sont renumérotées une fois en
  rejoignant (« ref figée » vaut à partir du partage).

Contrainte : la synchro est **toujours optionnelle et non bloquante** — l'app tourne
identique sans compte Drive (règle 1). Les `id` (`local:<uuid>`) restent uniques ; le
doublon de `#L1` entre postes est réglé par le préfixe de ref par appareil (É2a/É2d).

**Après** — MAJ de pack + catalogue de packs en ligne (gratuits / payants).
Direction retenue (dev repoussé) : héberger `manifest.json` + `pack-*.db` sur un
host statique (GitHub Releases pour commencer — URLs stables, ETag, CDN, gratuit),
**pas** Google Drive (scope `drive.file` ne lit pas un fichier tiers ; le lien
public `uc?export=download` marche mais est fragile et ne gère aucun paiement).
App : fetch du manifeste → choix → download du `.db` → swap atomique. Packs
payants → endpoint de licence plus tard ; packs gratuits livrables dès le host
statique. Téléchargement = action explicite, jamais bloquant, échec silencieux
hors-ligne (règle 1).

## Dépôt, releases et mise à jour de l'app

- Dépôt **public** github.com/EryoGreg/tuiles-et-toiles. Bristol (github.com/EryoGreg/bristol)
  en est un fork à historique partagé (base commune : tag `v0.1.0`) ; y porter les correctifs par
  `git cherry-pick` (remote `tuiles-et-toiles`). `oauth-client.json` n'est jamais versionné.
- Publier une version : `npm version x.y.z --no-git-tag-version` (le numéro nomme l'exe et le
  dossier d'extraction portable), `npm run dist`, commit + tag `vx.y.z`, push, puis
  `gh release create vx.y.z release/Tuiles-et-Toiles-x.y.z.exe`. L'exe ne va jamais dans git
  (> 100 Mo).
- **Mise à jour intégrée** (`src/main/maj.js`) : `electron-updater` ne gère pas la cible portable,
  donc c'est fait à la main. `releases/latest` via l'API GitHub (anonyme, dépôt public), exe
  téléchargé à côté de l'exe courant (`PORTABLE_EXECUTABLE_FILE`), taille + SHA-256 vérifiés contre
  le `digest` publié par GitHub, lancement du nouvel exe, marqueur `maj-en-cours.json` ; au
  démarrage suivant, le nouvel exe supprime l'ancien. Vérification discrète 4 s après le lancement
  (réglage `maj_auto`, désactivable dans Options), rien n'est téléchargé sans clic. Hors ligne →
  silencieux (règle 1). Les raccourcis qui visaient l'ancien exe sont signalés par la détection de
  raccourcis périmés existante.
- Nom d'asset attendu par l'updater : `Tuiles-et-Toiles-x.y.z.exe` (`MOTIF_EXE`). Le changer casse
  la mise à jour des installations existantes.

## Règles non négociables

1. **Le pack est du contenu, remplaçable en bloc.** `data/pack.db` est généré
   hors ligne depuis `data/manifest.csv` + `data/registre.json`. L'app au
   runtime n'y écrit jamais et ne dépend d'aucune source externe — le Google Doc
   d'origine (propriété d'un tiers) n'est plus qu'un intrant de build.
   Une MAJ de pack = remplacer le fichier ; `utilisateur.db` n'est jamais touché.
2. **La date n'est jamais visible au tirage.** C'est ce que l'entraînement fait
   mémoriser. Elle ne fait partie d'aucun masque — mais l'utilisateur peut la
   révéler au clic, comme n'importe quel autre champ.
3. **Mono-utilisateur, mais la création locale de tuiles rouvre le périmètre.**
   Pas de comptes ni de partage réseau. Les tuiles créées vivent dans
   `oeuvres_locales` (utilisateur.db), jamais dans le pack ; elles s'exportent
   en zip.
4. **Rien de mutable dans pack.db.** Tags, archivage, corrections de champ,
   tuiles locales → `utilisateur.db`. Ces tables pointent vers les œuvres par
   leur `id` (stable à vie), **jamais** par leur `ref` (numéro d'affichage).
5. **Un `LISEZMOI.txt` dans tout dossier que l'app crée**, local ou cloud (Drive
   compris), et à la racine de tout zip exporté : à quoi sert le dossier, ce qu'il
   contient, ce qu'il ne faut pas toucher. Textes centralisés dans
   `src/main/lisezmoi.js` (`deposer(dossier, cle)` : écrit si absent ou différent). Tout
   code qui balaie un dossier (ménage d'images, listes de fichiers) doit ignorer
   `LISEZMOI.txt`.

## Identité des œuvres

- `id` — `p:` + 10 hex, opaque, **gelé dans `data/registre.json`**, jamais
  réutilisé. Clé de toutes les relations `user_*`.
- `ref` — numéro d'affichage `"002".."432"` (locales : `"L1"…`), **figé** :
  jamais renuméroté. Une œuvre retirée par une MAJ de pack laisse un trou, on ne
  décale pas. Le registre gèle `slug → {id, ref}` ; l'import le complète pour
  les nouvelles œuvres sans toucher l'existant.
- `slug` — dérivé titre + date, sert au build à apparier une ligne du CSV au
  registre, et nomme les fichiers image. **Instable** (une correction de titre
  le change) → jamais utilisé comme clé.

## Architecture données (S1)

| `pack.db` — attaché sous `pack`, lecture seule | `utilisateur.db` — connexion principale, inscriptible |
|---|---|
| `oeuvres` (id, ref, champs, hash_texte, recherche, masques) | `user_tags`, `user_stats`, `user_corrections`, `reglages`, `sync` |
| `pack_meta` (version, hash, cree_le, n_oeuvres) | `user_archive` (oeuvre_id) — œuvres du pack masquées |
| | `user_overrides` (oeuvre_id, champ, valeur, valeur_source) |
| | `oeuvres_locales` (mêmes champs + cree_le, modifie_le) |

`db.ouvrir(USER, PACK)` ouvre utilisateur.db puis `ATTACH DATABASE pack.db AS
pack`. Toutes les requêtes de contenu visent `pack.oeuvres`. S1 : lecture =
pack seul ; l'union `pack ∪ oeuvres_locales`, le filtre `user_archive` et les
overrides arrivent en S2.

Migration depuis une install v1 (`tuiles.db` monolithique) : `db.migrer()`
recopie les tables `user_*`, **re-clé les tags** des anciens slugs vers les `id`
stables via le registre (slug disparu → tag ignoré), renomme l'ancien fichier
`tuiles.db.avant-v2`.

Emplacements (empaqueté) : `%APPDATA%\Tuiles et Toiles\` — `pack.db` (copié du
bundle si sa version est **strictement supérieure**, donc un pack téléchargé
plus récent n'est jamais écrasé), `utilisateur.db` (jamais écrasé). Images :
`resources/data/images/`, lecture seule, jamais recopiées. En dev : tout dans
`data/`.

## Le moteur de masques

`src/main/masques.js`. Un masque = l'ensemble des champs visibles ; retenu s'il
est **discriminant** (ne désigne qu'une œuvre), **évocateur** (image, titre,
description ≥ 60 car., ou artiste unique au corpus), **sans fuite** (21
descriptions citent l'artiste ou le titre) et **incomplet**. La date n'en fait
jamais partie.

Précalculé à la fabrication du pack. Sur les 431 œuvres : min 35, médiane 55,
max 59 masques valides, aucune œuvre bloquée. Créer / modifier / supprimer une
tuile locale change la discriminance de tout le corpus → recalcul complet à
chaque écriture (S2+, ~100 ms).

Corollaire de méthode, appris à mes dépens : **apparier en souple** (valeurs
normalisées) mais **comparer en strict** (valeurs brutes). Sert à détecter un
conflit quand une MAJ de pack corrige un champ que l'utilisateur avait déjà
surchargé (`user_overrides.valeur_source` = la valeur du pack au moment de la
correction).

## Journal et rapport d'erreur

- **Journal** (`src/main/journal.js`) : `%APPDATA%\Tuiles et Toiles\logs\journal.log`
  (`data/logs/` en dev), 5 fichiers × 5 Mo. Une ligne par événement :
  `horodatage NIVEAU domaine évènement s=<session> {json}` — filtrer par niveau
  (`DEBUG`/`INFO`/`WARN`/`ERREUR`), domaine (`app ipc ui db edition image jeu synchro drive
  sauvegarde maj rapport`) ou session. API : `evt(domaine, quoi, données, niveau)`,
  `avertir`, `erreur(domaine, quoi, e, contexte)` (message + code + pile), `chrono`,
  `decrireTexte(s)` (longueur, alphabets — cyrillique, emoji… —, contrôles, invisibles,
  caractères interdits dans un nom de fichier). Clés de type jeton → `***`. **Règle :
  toute nouvelle action utilisateur ou étape système journalise ce qui permettrait de
  comprendre un échec** (entrées décrites, durée, résultat, erreur avec contexte).
- **Couverture automatique** : chaque canal IPC passe par `gerer()` (index.js) — args
  résumés, durée, résultat, erreur ; lectures en boucle en DEBUG. Rendu (`main.jsx`) :
  chaque clic (élément, libellé, zone), erreurs JS, promesses rejetées ;
  `window.api.evt(domaine, quoi, données, niveau)` pour le reste. Drive : chaque requête
  HTTP (méthode, chemin, `q`, statut, ms, octets), chaque étape OAuth. Synchro : une ligne
  par étape + bilan par appareil + images une à une + conflits ouverts ; une image en
  échec ne bloque plus la synchro. Démarrage : `depuisLancementMs` à l'ouverture de la base
  et à l'affichage de la fenêtre (mesure du problème de lenteur).
- **Rapport d'erreur** (`src/main/rapport.js`, Options → « Signaler un problème ») :
  formulaire (sujet, depuis quand, reproductible, description et email de contact
  facultatifs), aperçu dépliable, **un clic « Envoyer »**. L'app POSTe le rapport
  (journaux **masqués** — utilisateur Windows, nom du poste, emails ; les textes des
  tuiles restent — compressés gzip + base64, `rapport.json`) au script Google Apps Script
  de l'utilisateur (`tools/rapport-reception.gs`, déployé en application Web « Tout le
  monde », propriété `CLE`), qui envoie le mail à `wn7pocu65@mozmail.com` (relais Firefox
  Relay) avec les journaux en pièces jointes `.txt`, mail plafonné à **9 Mo encodés** (limite du
  relais ; base64 +33 %) : du plus récent au plus ancien, `.txt` si ça tient, sinon `.gz`,
  sinon écarté et listé dans le mail,
  `replyTo` = email du testeur. Seule autorisation Google : envoyer des mails. Config :
  `src/main/rapport-config.json` `{ url, cle }` (**gitignoré**, embarqué dans l'asar,
  comme `oauth-client.json`). Hors ligne → `Documents\Tuiles et Toiles - rapports\en-attente\`,
  renvoyé 8 s après le lancement suivant. `url` vide (script pas encore
  déployé) → repli messagerie `mailto:` avec le texte seul (≤ 1 900 car.). Objet :
  `[T&T rapport] <sujet> — v<version> — <date heure> — R<ref>` (préfixe fixe pour le
  filtre de messagerie). Le script est testé dans Node avec les services Google simulés
  (`tests/journal-rapport.test.js`).

## Pièges de l'environnement

- **Séquences `\u` dans les outils d'écriture.** Les outils d'édition de Claude décodent
  `\uXXXX` en caractère réel : une regex écrite ainsi devient illisible (voire cassée par
  un U+2028). Générer ces lignes par script (`chr(92) + 'u200B'`).

- **Ports réservés.** Vite tourne sur **5500** : cette machine réserve des
  plages (Hyper-V) dont 4173 et 5173. Un `listen EACCES` vient de là.
  `netsh interface ipv4 show excludedportrange protocol=tcp`
- **better-sqlite3** est compilé pour l'ABI d'Electron. Le Node du système
  (`node -e`, `node script.js`) plante : `NODE_MODULE_VERSION 137` contre 130.
  Passer par `node scripts/lancer-node.js <fichier>` (Electron en mode node).
  Le binaire est téléchargé prêt à l'emploi (`scripts/binaire-sqlite.js`), pas
  compilé.
- **Exe portable.** `portable.unpackDirName` doit être **versionné**
  (`TuilesEtToiles-${version}`), sinon les builds successifs se disputent le
  même dossier d'extraction `%LOCALAPPDATA%\Temp\` et le corrompent (symptôme :
  `ffmpeg.dll was not found`). Defender met aussi parfois `ffmpeg.dll` en
  quarantaine (faux positif Electron non signé) — si l'erreur persiste après un
  dossier propre, c'est ça : exclusion Defender ou signature de l'exe.
- **`&` dans les chemins.** `productName` = `Tuiles et Toiles` (sans `&`),
  sinon cmd et electron-builder cassent les chemins générés. L'UI garde
  « Tuiles & Toiles » (via le `<title>` HTML).

## Données

- `data/manifest.csv` (431 lignes) — export du Google Doc, intrant de build.
- `data/registre.json` (431 entrées, **versionné, gelé**) — `slug → {id, ref}`.
  Amorcé une seule fois par `node scripts/registre-init.js`.
- `data/pack.db` — régénéré par `npm run import` (`= node scripts/lancer-node.js
  src/main/import.js`).
- `data/images/` (431 JPEG, 53,5 Mo, côté max 1400 px), bundlé lecture seule.
- `data/utilisateur.db` — créé au runtime, jamais versionné.

33 images font moins de 500 px de côté — limitation de la source, pas de la
conversion. Extraction des images d'origine : `tools/extraire_images.gs` (le
connecteur Drive tronque `read_file_content` à ~101 000 caractères et plafonne
l'export complet à 10 Mo).
