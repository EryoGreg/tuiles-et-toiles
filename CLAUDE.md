# Tuiles & Toiles — état du projet

Application de bureau d'entraînement mémoriel en histoire de l'art.
Electron + React + SQLite. Windows, mono-utilisateur.

## Reprise de session — état au 04/10/2026

**Versions** :
- **Publiée** : 0.3.16 (Latest, GitHub, 04/10/2026) — **moteur de masques revu** (paliers de difficulté
  Normal/Difficile, image facultative, fuite élargie, artiste ≤6 œuvres évocateur, jamais de champ vide
  révélé, jamais lieu/tags/date seuls, recalcul auto au 1er lancement via `masques.VERSION`), **choix de
  difficulté** sur Nouvelle partie (`prefs_affichage`), **avertissement éditeur** injouable/incomplète
  (`edition.manquesDe`). Voir « Le moteur de masques ».
- **0.3.15** (04/10/2026) — découpe d'`App.jsx` (étape 1 de Bristol), **Mes notes**, **bilan de synchro qui compte les rattrapages**, **contenus anormaux** (recherche
  multi-écritures, textes bien formés, limites de taille, démarrage mobile sans `innerHTML`), et
  **durcissement sécurité** (session de tests avancés 04/10) : bombe de décompression bornée dans
  `synchro/format.decoderSnapshot` (ISIZE vérifié avant allocation, cap compressé/décompressé,
  `maxOutputLength` Node, repli fflate mobile) ; segments `.ndjson` plafonnés (octets + nb d'ops) ; import
  zip filtré (`RE_IMAGE` sur les images, tailles plafonnées, `utilisateur.db` refusé > 512 Mo) ; Electron
  `will-navigate` + `setWindowOpenHandler` (origine du rendu figée — une page étrangère n'hérite plus de
  `window.api`), vérification de l'expéditeur IPC dans `gerer()`, CSP `object-src`/`base-uri`. Test :
  `tests/securite.test.js`. Build dans `release-test/` (exe+Setup, lock de `release/`) + `release/` (apk).
- L'utilisateur teste et dit quand publier.

**Publier** (sur feu vert seulement) : procédure de la section « Dépôt, releases… ». Si l'exe de `release/`
est verrouillé par l'appli lancée, construire dans `release-test/`
(`electron-builder --win portable nsis --config.directories.output=release-test`), puis publier ces
fichiers-là (mêmes noms). Commit « Version x.y.z », tag, push `synchro-e2` **et** `HEAD:main`, `gh release
create` avec les 3 fichiers, vérifier les empreintes (`gh release view --json assets`).

**Branche** : on travaille sur `synchro-e2`, `main` = même commit (push des deux).

**Suite prévue — Bristol refait depuis T&T** (décision du 03/10) :
1. ✅ découper `App.jsx` ;
2. ✅ Mes notes ;
3. **gabarits par pack** (champs facultatifs, place prévue pour des « types de fiche ») : colonne
   `donnees` JSON, moteur de masques `calculer(fiches, champs)` (régression : pack art 35 / 55 / 59,
   0 bloquée), migration synchro des entités `locale` / `override`, rendu piloté par gabarit ;
4. plusieurs decks ; import CSV, galerie multi-image, occlusion (repris de l'ancien Bristol) ;
5. manques de Bristol : import Anki, texte à trous, LaTeX, tags hiérarchiques.
Décisions à demander avant l'étape 3 : appli unique « Bristol » avec un deck T&T, ou deux applis ; dépôt
T&T = dépôt commun (ancien Bristol archivé) ; version 0.4.0.

**Autres pistes ouvertes** : catalogue de packs (et ses 4 points images, section « Après ») ; signature de
l'exe ; sauvegarde de `debug.keystore` (à rappeler) ; projet GCP vide `tuiles-et-toiles` à supprimer.

**Tests** : `npm test` (27 fichiers, ~5 min). Propriété : `tests/synchro-e2b|e2e|remplacement|bilan-proprietes
.test.js [n] [graine]`. Banc des cartels : `tests/banc-cartels.js` (photos et clé hors dépôt). Vérifier
l'interface dans le navigateur avec `node scripts/build-mobile.js` + la configuration « mobile-web »
(`.claude/launch.json`), `window.api` réel en mémoire.

**Écrire du code depuis un script** : outil Write pour les scripts Python (les heredocs Bash mangent `\`
et transforment `\r\n` en vrais sauts de ligne — arrivé plusieurs fois).

## Où on en est

**Fait** — l'app tourne et se distribue :

- menu, jeu (modes aléatoire / catégorie), Bibliothèque, Livre / Étoile / À revoir, Options
- vue tuile agrandie (aperçu depuis les galeries ; pointillés dorés sur les
  champs qu'un tirage cacherait)
- tri (ordre d'ajout / numéro + sens) et recherche permissive sur toutes les pages
- 10 thèmes (dont 7 clairs), barres de défilement thématisées
- deux formes, mêmes données dans `%APPDATA%` : exe **portable** et **installateur NSIS**
  (depuis 0.3.2, démarrage rapide : le portable se décompresse à chaque lancement), raccourcis
  bureau / menu / barre des tâches + détection des raccourcis périmés au lancement
- **S1 du modèle pack** : socle 2 bases (voir « Architecture données »)
- **Interface découpée** (étape 1 de Bristol, 03/10/2026) : `src/renderer/App.jsx` = coquille (barre,
  navigation, bandeaux, raccourcis) ; le reste par domaine : `commun/` (contextes, préférences, utilitaires,
  boîtes), `tuile/` (Tuile, cartes, aperçu, menu contextuel, Ma note), `jeu/` (partie, révision),
  `galeries/` (Bibliothèque, Livre / Étoile / À revoir, filtres), `edition/` (page Édition, éditeur, cartel,
  journal), `options/` (Options, sections, mise à jour, rapport), `pages/` (Conflits, Corbeille). Découpe faite
  par `scripts/decouper-app.js` (code inchangé ; `--verifier` liste tout nom non défini).
- **Mes notes** (0.3.15) : note libre et personnelle par tuile (pack ou locale), entité synchronisée
  **`note`** (cle = id, champ `_`, valeur = texte, ≤ 20 000 car. ; vide = effacée ; conflit « Ma note » si
  deux appareils la changent sans se voir), projetée dans `user_notes` (avec `recherche` normalisée).
  **Jamais au tirage ni dans les masques** (elle contient souvent la réponse) : la tuile n'a que `aNote`.
  Bouton « Ma note » à côté des marques (`tuile/Note.jsx`, `BoiteNote`) : note masquée tant que la tuile
  n'est pas révélée (« Afficher quand même »), Ctrl+Entrée ; champ « Ma note » dans l'éditeur ; pastille sur
  les cartes ; la recherche de la Bibliothèque cherche aussi dans les notes, filtre « Avec note ». Annulable
  (Ctrl+Z). `edition.lireNote` / `ecrireNote`, canaux `notes:*`. Test : `tests/notes.test.js`.

**Fait — Édition (ajouts locaux).** Découpage :

- S1 ✅ socle : `pack.db` / `utilisateur.db`, migration v1 → v2, identité stable
- S2 ✅ union `pack ∪ oeuvres_locales` + filtre `user_archive` + overrides + hook recalcul masques
- S3 ✅ page Édition + éditeur de tuile + flux « créer »
- S4 ✅ pipeline image (dossier local, resize ≤ 500 Ko, sélecteur + drag-drop fichier)
- S5 ✅ drag-drop web, modifier / supprimer, `user_archive` pour les œuvres du pack
- S6 ✅ **annuler / rétablir** (`src/main/annuler.js`, Ctrl+Z / Ctrl+Y ou Ctrl+Maj+Z, hors champs
  de saisie et hors éditeur) : chaque action utilisateur (canaux IPC enveloppés dans
  `annuler.action`) relève ses écritures via `etat.capturer` (crochet `ctx.surEcriture` de
  `moteur.ecrire`) ; annuler / rétablir = écritures ordinaires (synchronisées), un champ modifié
  depuis n'est pas touché ; 50 actions, en mémoire ; les images citées par les piles échappent
  au ménage. Annuler une création → `_existe = null` (ni liste ni Corbeille).
  ✅ **Journal des modifications** (Édition → 3e carte, `edition.journalModifs`) : `changements`
  hors stats, regroupés par action (même appareil, même tuile, ≤ 3 s), avant → après, paginé
  par HLC, « Ouvrir » la tuile.
  ✅ **Menu contextuel des cartes** (Bibliothèque, Livre / Étoile / À revoir, liste d'Édition) : clic
  droit, ou appui long au doigt (`useAppuiLong`, 500 ms, le toucher suivant n'ouvre pas l'aperçu) →
  Agrandir, Modifier (`NavContext.modifierTuile(id)` → page Édition, éditeur ouvert), Livre / Étoile /
  À revoir (cochés), Mettre à la corbeille (confirmation). Mêmes canaux que les boutons (annulable,
  synchronisé). `useMenuTuile` (`tuile/Cartes.jsx`).

**En cours — Sauvegarde / synchro Google Drive.** Ce qui voyage : `utilisateur.db`
+ `images-locales/`. Jamais `pack.db`. Découpage :

- É0 ✅ export / import zip (`src/main/sauvegarde.js`, `adm-zip`). Zip = `utilisateur.db`
  (via `VACUUM INTO`, base `pack` exclue) + `images-locales/` + `manifest.json`.
  Import = **fusion** (depuis 0.3) : les ops du journal du zip passent par
  `echange.fusionner` (comme une synchro), rien n'est effacé, conflit si deux versions
  s'ignoraient ; ops importées marquées `pousse = 0` → repartent vers les autres appareils.
  Zip d'avant le journal : ops de genèse sous un id d'appareil dérivé du zip (`etat.opsGenese`
  + `horodaterGenese`). Images manquantes seulement. Copie de secours
  `utilisateur.db.avant-import-<horodatage>`. (L'ancien remplacement complet faisait diverger
  les appareils synchronisés en silence.) Options → « Sauvegarde des données ».
  **Copie de sécurité auto** (`src/main/copie-securite.js`) : zip hebdomadaire silencieux dans
  `Documents\Tuiles et Toiles - sauvegardes\` (`data/sauvegardes/` en dev), 4 gardés, écrit en
  `.tmp` puis renommé, vérifié 1 min après le lancement puis toutes les 6 h.
- É1 ✅ snapshot Drive via API (`src/main/drive.js`). OAuth installed-app + PKCE, redirection
  loopback `http://localhost:<port>`, navigateur système. Scope `drive.file`, dossier `Tuiles et
  Toiles/` (sans `&` — nom de dossier Drive). Fichier `utilisateur.zip` mis à jour en place ;
  avant tout écrasement la version distante est copiée dans `historique/`. Conflit détecté via
  `headRevisionId` distant retenu dans la table `sync` (`drive_rev`, `drive_synchro_le`).
  Jeton (refresh_token) chiffré `safeStorage` → `%APPDATA%\Tuiles et Toiles\drive-jeton.bin`.
  Client OAuth : `src/main/oauth-client.json` (gitignoré, embarqué dans l'asar). Projet Google
  Cloud **`dislike-334115`** (ID figé ; renommé « Tuiles et Toiles » le 26/09/2026 — l'ancien
  projet d'ID `tuiles-et-toiles` était vide et est à supprimer). Bristol utilise le même client :
  son écran de consentement affiche donc « Tuiles et Toiles ». Écran de consentement **en production** depuis le 26/09/2026 (Google Auth
  Platform → Audience) : nom « Tuiles et Toiles », accueil et confidentialité sur GitHub Pages
  (`docs/`, `https://eryogreg.github.io/tuiles-et-toiles/`), domaine autorisé
  `eryogreg.github.io`, pas de logo (un logo imposerait une vérification). Seul scope
  `drive.file` (non sensible) → pas de vérification. Jetons obtenus en mode test : expiraient à
  7 jours (`invalid_grant`) ; reconnecter une fois après la publication.
  **Sauvegarder / Restaurer (zip complet sur Drive) retirés en 0.3** : la synchro fait mieux, et
  Restaurer remplaçait la base. `utilisateur.zip` et `historique/` restent sur les Drive
  existants, importables (fusion). Options → « Google Drive » : Synchroniser / Déconnecter.
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
  - É2e ✅ compaction (`synchro/compaction.js`) + cycle complet (`synchro/cycle.js`, utilisé
    par `service.js` et les tests). Fiche d'appareil : `lu` (accusé de lecture = curseurs),
    `purge` (dernier de SES segments supprimé), `snapshot` ({nom, vecteur}), `vu_le`.
    **Snapshot** (`snapshots/<id>/<hlc>.json.gz`, après 1 000 ops ou 7 jours, 2 gardés par
    appareil) = les **têtes** de tous les champs + vecteur des segments résumés — garder les
    têtes (pas seulement les gagnants) préserve la détection des conflits. **Purge** : chaque
    appareil ne supprime que ses segments lus par tous les appareils actifs (muet > 90 j =
    inactif) et couverts par un snapshot. **Rattrapage** : appareil nouveau, ou dont des
    segments non lus ont été purgés → repart du snapshot ; ses ops locales couvertes par le
    vecteur mais absentes des têtes sont marquées `changements.remplace = 1` (sinon un
    ancêtre dont le maillon manque passerait pour une tête → faux conflit). **Le rattrapage compte dans le
    bilan « Reçu »** (`rattraper` → `appliquees`, `resume` ; `service.additionnerResumes`, journal
    `recu-detail`) : avant le 03/10/2026, la première synchro d'un appareil qui en découvrait un autre (cas
    courant : il le lit d'abord par son snapshot) annonçait « Tout était déjà à jour » alors que des données
    arrivaient. Les compteurs de vues sont comptés à part (`vues`, absent de la phrase) ; garde-fou
    `bilan-incoherent` (WARN) si des données changent sans rien de compté. Tests : `tests/synchro-bilan.test.js`
    (cas isolés) ; **`tests/synchro-bilan-proprietes.test.js [n] [graine]`** (propriété : 2 à 4 appareils, arrivées,
    0 à 45 tuiles, toutes les actions, synchros manuelles / auto ; après **chaque** synchro, chaque différence
    visible doit être comptée dans sa catégorie du « Reçu », un appareil qui avait à envoyer l'annonce, et
    convergence finale ; `TT_TRACE=1` déroule actions et bilans) ; **`tests/synchro-bilan-volume.test.js`**
    (comptes exacts : aucune tuile, puis `TT_VOLUME` tuiles, 2 000 par défaut — rejoindre sans tuile, rejoindre
    avec la moitié créée hors ligne et renumérotée, modifications / suppressions en masse, arrivée après le ménage
    du Drive ; 5 000 tuiles : 36 s). Le test de propriété a été validé en remettant le bug : il échoue aussitôt. **Tuile supprimée
    depuis 90 j** : contenu remis à vide **par des ops ordinaires** (un effacement local ne
    convergerait pas face à une restauration concurrente) ; la pierre tombale reste à vie ;
    pas d'oubli tant qu'un conflit de suppression est ouvert. Le conflit « supprimée ici,
    modifiée là-bas » se calcule sur les **têtes** (valeurs non vides > `vu`). Pas de
    compaction du journal local (risque de fausses têtes, gain faible). **Écran Conflits** :
    entrée de barre latérale avec compteur, visible seulement s'il y en a ; deux versions
    côte à côte (appareil, date), « Garder celle-ci » / « Garder supprimée » / « Restaurer » ;
    lien « Voir les conflits » dans le bilan de synchro. Noms d'appareils retenus dans
    `sync.appareils_connus`. Test de propriété : `tests/synchro-e2e.test.js [n] [graine]`
    (2 à 4 appareils, arrivées, absences de plusieurs semaines, horloge contrôlée).
  - É2f ✅ (0.3) filets de sécurité et synchro automatique :
    - **Nom de segment toujours croissant** (`echange.pousser`) : si la première op à envoyer
      est plus ancienne que `sync.dernier_segment` (ops importées), le nom part d'un `tic()`.
      Sinon les autres appareils (curseur = nom de segment) ne le liraient jamais.
    - **Corbeille** (`edition.corbeille` / `restaurer`, entrée de barre latérale visible s'il y
      a quelque chose) : tuiles locales supprimées dont le contenu est encore au registre
      (« effacée définitivement le … » = `compaction.purgeeLe`) et œuvres du pack archivées.
      Restaurer = écriture ordinaire. Les marques d'une tuile supprimée **restent** (invisibles :
      `comptesTags`, `parTagUtilisateur` et `effacerTousLesTags` joignent `oeuvres_effectives`).
    - **Versions précédentes** (`edition.versions`, bouton de l'éditeur) : toutes les valeurs de
      chaque champ, tirées de `changements`, tous appareils ; « Reprendre » remplit l'éditeur,
      rien n'est écrit avant validation. Pas l'image (une image remplacée est effacée du disque).
    - **Conflits** : trancher déclenche une synchro (`synchroAuto.differer`, 3 s après le dernier
      choix, tout de suite s'il n'en reste plus, même synchro auto désactivée) ; ouvrir l'écran
      Conflits synchronise d'abord (`conflits:actualiser`) ; réception toutes les 2 min tant que
      des conflits sont ouverts.
    - **Synchro automatique** (`synchro/auto.js`, réglage `synchro_auto`, actif par défaut) :
      lancement + 6 s, 20 s de calme après une modification (surveillance toutes les 15 s),
      toutes les 15 min, réveil, fermeture (≤ 10 s, `app:quitter` attend). Échec → nouvel essai
      5 min plus tard. Mode auto : **jamais de navigateur** — jeton mort → `sync.drive_pause_auto`
      (bandeau rouge dans Options) jusqu'à une synchro manuelle réussie. Une synchro auto ne
      recharge pas la page (`resultat.auto`) : bandeau « Du nouveau… Actualiser » sur les
      pages de liste (pas l'éditeur), et « N conflit(s) à trancher — Voir ».
    - **Pastille « conflit »** sur les cartes (Bibliothèque, galeries, Corbeille) et dans
      l'éditeur (`db.oeuvresEnConflit`, champ `conflit` de `jeu.completer`).
    - **Appareils** (Options, `service.listeAppareils` / `retirerAppareil`) : retirer un appareil
      perdu = `{ id, le }` dans `sync.appareils_retires`, publié dans `retires` de SA fiche (une
      fiche garde un seul écrivain) ; la purge l'ignore (`compaction.retires`). Le retrait
      **s'éteint tout seul** si l'appareil se resynchronise après `le` (il repart d'un snapshot).
      La fiche reste : sa lettre de ref reste réservée. Ne coupe pas l'accès Drive (compte
      Google → Applications tierces). Un appareil sur un autre compte Google est invisible (autre
      espace Drive) : on affiche le compte de cet appareil, pas de détection possible.
  - **Réconciliation à l'ouverture** (`etat.reconcilier`, après la genèse) : tables projetées
    (`oeuvres_locales`, `user_overrides`, `user_archive`, `user_tags`) comparées au registre ;
    chaque écart devient une écriture ordinaire (HLC du jour) → part à la synchro suivante ;
    tuile présente au registre mais effacée de la table → pierre tombale (Corbeille). Journalisé
    `synchro reconciliation` (WARN) avec les refs. Cas réel 30/09/2026 : une **0.1.0** (portable,
    restée dans Documents, lancée par un vieux raccourci) a écrit 2 jours dans la base partagée
    `%APPDATA%` sans journal → 27 tuiles jamais envoyées (`aPousser: 0`). Les tables sont lues en
    entier avant d'écrire (`projeterLocale` réécrit toute la ligne). Test :
    `tests/synchro-reconciliation.test.js`.
  - **Qui est qui (0.3.10)** — `synchro/noms.js`, `appareil.js`, `rejoindre.js` :
    - **Nom mémorable** (« Ananas dansant », `nomPour(id)` déterministe, accord du genre), tiré à la
      création, gardé dans `appareil.json`, publié dans la fiche ; renommable (Options → Appareils →
      Renommer, `service.renommer`, `nom_perso`). Anciens noms automatiques (nom du poste,
      « Téléphone ») migrés une fois (`nom_memorable`). **Type** recalculé à chaque lancement
      (« Windows · POSTE », « Android · Samsung SM-G998B ») et publié.
    - **Empreinte matérielle** (`materiel`, jamais en clair) : PC = MachineGuid + utilisateur
      Windows (`materielPoste`, index.js) ; Android = `ANDROID_ID` (`IdentitePlugin.java`). Identité
      **recopiée** sur une autre machine (empreinte différente) → nouvelle identité (`copie_de`).
      Android : copie de secours de `appareil.json` dans les préférences (restaurée seulement si même
      empreinte), `navigator.storage.persist()` (`src/mobile/identite.js`).
    - **Remplacement** : un appareil neuf qui arrive là où d'autres existent ne s'inscrit pas sans
      décision (`exigerDecision`, `DecisionRequise`, rien n'est écrit sur le Drive) → `sync.decision_requise`,
      bandeau + boîte « Cet appareil en remplace-t-il un autre ? » (`BoiteRemplacement`), synchro
      auto suspendue (`decisionEnAttente`) ; choix rangé dans `appareil.remplace` (id | 'aucun').
      Même empreinte qu'une fiche → **reprise automatique**. Remplacer = reprendre **nom** (sauf
      `nom_perso`) et **lettre**, retirer l'ancien (`appareils_retires`), fiche `remplace: id`. L'id
      reste neuf. Tuiles créées avant l'inscription : cycle inversé (tirer → `renumeroterSuite` →
      pousser), numérotées à la suite du plus grand numéro de la lettre (P8 après P7).
    - **Supplanté** : un ancien appareil qui revient alors qu'une fiche déclare le remplacer et que
      sa lettre est portée ailleurs (y compris en chaîne A ← B ← C) prend une lettre libre pour ses
      prochaines tuiles et renumérote celles **pas encore envoyées** (`nonPartageesSeulement`).
    - Appareil déjà inscrit : la **fiche fait foi pour la lettre** (copie de secours périmée).
    - Tests : `tests/appareil-identite.test.js`, `tests/synchro-remplacement.test.js [n] [graine]`
      (scénarios + propriété : refs uniques, états identiques, une lettre par appareil vivant ;
      `TT_TRACE=<k>` déroule un scénario ; aussi sur sql.js : `TT_SUITE=./synchro-remplacement.test.js
      node scripts/lancer-node.js tests/mobile-sqlite.test.js`), service dans `synchro-e2c.test.js`.
  - **Vitesse (0.3.11)** — mesuré sur 438 synchros réelles : 98 % « à vide », 10 s médiane, 20
    allers-retours Drive successifs (~290 ms chacun). Désormais (faux Drive à 290 ms, 4 appareils) :
    auto à vide **0,3 s / 1 appel**, complète à vide 1,8 s / 8, tuile reçue 2,7 s / 11, première
    après lancement 3,8 s.
    - **Synchro rapide** (`service.essaiRapide`, synchro **auto** seulement ; le bouton fait toujours
      une complète) : fil des changements Drive (`drive-api` `jetonChangements` / `changements`) depuis
      le jeton noté (`sync.drive_fil` `{ jeton, complet_le, relire, cle }`). Rien → fin. Complète
      forcée si : pas inscrit, décision en attente, autre compte, `relire`, > 6 h depuis la dernière
      complète, `synchro_complete` (renommer, retirer, remplacement), `images_a_reprendre` (échec ; image
      annoncée absente : 24 h max, `images_manquantes_depuis`), ops à envoyer (compteurs de vues émis
      d'abord), fil en panne. Complète : jeton pris **avant**, fil relu **après** sans nos écritures
      (`transport.ecrits`) ; reste quelque chose → `relire` (écrit pendant notre synchro).
    - **Fiche réécrite seulement si elle change** (`memeFiche`, hors `vu_le`), si elle a plus de 6 h
      (`pouls`), ou si un autre appareil m'a retiré depuis. Sinon deux appareils se réveilleraient en
      boucle par le fil des changements.
    - **Caches par compte** (`transport-drive`, `cleCache` = `drive:<email>`, 24 h) : ids de dossiers,
      contenu des fiches (relues si `modifiedTime` change), ids des fiches, LISEZMOI vérifiés ;
      `oublierDossiers()` après une erreur ou un dossier changé ailleurs. Lectures en parallèle
      (`parLots` dans `echange.tirer`, fiches, LISEZMOI de `preparer`).
    - **Erreurs dites à l'utilisateur** (`synchro/erreurs.js`, `classer`) : type (session, compte,
      reseau, limite, drive, refus, dossier, encours, interne) + phrase courte (« Synchro impossible :
      pas de connexion. »), détail au journal (`r.detail`). Dernier échec dans `sync.synchro_echec`
      (Options → section Google Drive), effacé au succès suivant ; synchro auto en échec → bandeau
      global (sauf `reseau` : règle 1, silencieux).
    - Tests : `tests/synchro-rapide.test.js` (faux Drive aux appels comptés, aussi par HTTP).
  - **Session expirée, un seul état (0.3.12)** — `service.noterSession` (appelé par
    `synchroniserDrive`, auto **et** manuelle) : échec typé `session` → `sync.drive_pause_auto` = date
    (gardée si déjà posée) ; synchro Drive réussie, `drive:connecter` ou `drive:deconnecter` →
    `sessionRetablie()`. Exposé `synchro.etat().sessionExpiree` (et `auto.pauseDrive`). Avant, seule la
    synchro auto le notait et Options affichait « Connecté » à côté d'un encadré « Session expirée ».
    **Options → Synchronisation** (ex-sections Google Drive + Synchro automatique fusionnées) : bloc
    d'état unique (`.synchro-etat` : connecté + dernière synchro / **session expirée** + bouton
    « Reconnecter et synchroniser » / non connecté), puis « Automatique » (`.sous-etiquette`),
    Appareils, et sur PC le dossier partagé replié (`details.options-replie`, ouvert s'il est utilisé).
    Tests dans `synchro-rapide.test.js`.
  - **Révision espacée** ✅ (`src/main/revision.js`, `fsrs.js` repris de Bristol) : Jouer → « Révision
    espacée ». Note 1-4 après « Tout révéler » = entité synchronisée **`revision`** (cle = oeuvre, champ =
    `<appareil>.<t36>`, valeur `{ n, le }`, un seul écrivain → jamais de conflit), projetée dans
    `user_revisions`. **L'état FSRS n'est stocké nulle part** : rejoué depuis les notes dans l'ordre
    chronologique (`etatCarte`), identique sur tous les appareils. File du jour : dues (plus en retard
    d'abord ; « Encore » = due 10 min après, proposée en avance si plus rien d'autre) puis nouvelles
    (ordre mélangé stable dans la journée, quota `revision_nouvelles` par jour tous appareils confondus).
    Réglages propres à l'appareil (Options → Révision espacée) : `revision_nouvelles` (10),
    `revision_retention` (0,9). Ctrl+Z efface la note. Test : `tests/revision.test.js`.
  - **Ops d'une entité inconnue** (appareil plus récent) : gardées dans `ops_attente` (bilan `attente`),
    appliquées à l'ouverture par une version qui connaît l'entité (`etat.reprendreAttente`). Les
    versions ≤ 0.3.12 rejettent encore les ops `revision` : mettre tous les appareils à jour avant de
    réviser, sinon leurs notes n'arrivent pas sur un appareil resté ancien.
  - **Conflit « MAJ de pack contre correction locale »** ✅ (`edition.conflitsPack` / `trancherPack`) :
    champ corrigé dont la valeur du pack a changé depuis la correction (`valeur_source`, comparaison
    stricte ; rien si le nouveau pack dit la même chose que la correction). En tête de l'écran Conflits
    (`type: 'pack'`, id `pack:<id>:<champ>`, `service.resoudre` aiguille), compté dans la barre
    (`service.nombreConflits`). « Garder ma correction » = override avec `valeur_source` = nouveau pack ;
    « Prendre celle du pack » = override retiré. Écritures ordinaires (synchronisées). Test :
    `tests/conflit-pack.test.js`.
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
**Images à l'échelle d'un catalogue** (décidé le 03/10/2026, à faire avec le catalogue) : la qualité
reste fixe **par image** (grande ≤ 1 400 px ~130 Ko, réduite 480 px ~33 Ko) — aucune enveloppe globale,
le « plafond » du cache n'est que la somme des images existantes (1 000 tuiles ≈ 130 Mo). Le problème
à venir est le **volume**, pas la qualité :
1. **Versions réduites livrées avec chaque pack**, plus avec l'appli (aujourd'hui `data/vignettes/`,
   14 Mo embarqués ; sinon exe et APK grossissent à chaque pack).
2. **« Tout garder hors ligne » choisi pack par pack**, pas pour tout l'appareil (10 packs ≈ 1 Go).
3. **Plafond facultatif du cache en « Grande à l'affichage »** (ex. 200 Mo sur téléphone) : au-delà,
   les images vues le moins récemment sont effacées (re-téléchargées si besoin).
4. **Taille affichée avant de télécharger un pack** dans le catalogue.

## Appli mobile (Android, Capacitor)

**Même code que le PC**, pas de réécriture. `src/mobile/` fait tourner les modules du processus
principal (base, jeu, édition, journal, synchro) **dans la page**, avant l'interface React :
- `principal.js` : démarrage (sql.js, fichiers, pack, appareil, `db.ouvrir`), sauvegarde différée ;
  `window.api` est construit par le **vrai `src/main/preload.js`** sur un faux module `electron`
  (`shims/electron.js`) → même surface que le PC, aucune dérive possible. `canaux.js` = les
  `gerer(...)` de `index.js` version mobile (sans fenêtres, raccourcis, mises à jour d'exe,
  dialogues de fichiers). `window.__tt` : poignée de diagnostic (console).
- Remplaçants des modules Node (`shims/`, alias esbuild) : `better-sqlite3` → **sql.js**
  (`sqlite.js`, même API synchrone ; la base jointe `pack` est recopiée en `:memory:` ;
  `persister()` = `export()`, qui ferme/rouvre : requêtes, pragmas et `ATTACH` refaits) ; `fs` →
  fichiers en mémoire sauvegardés dans IndexedDB (`vfs.js`, sauf `/data/logs`) ; `crypto` →
  `@noble/hashes` (v2 : `sha2.js`, `legacy.js`) ; `zlib` → `fflate` ; `os`.
- Remplacements de modules (plugin esbuild) : `images.js` → `images-import.js` (canvas, pas
  Jimp) ; `drive.js` → `mobile/drive.js` (connexion Google **native**, Credential Manager via
  `@capgo/capacitor-social-login`, jeton redemandé sans interface ; appels Drive dans
  **`src/main/drive-api.js`, commun au PC**).
- Images : pas de protocole `tuile://` en WebView → `images-url.js` traduit les résultats
  (vignettes livrées, grandes images depuis GitHub puis cache IndexedDB, photos locales en URL
  blob) ; seules les tuiles affichées en grand (`jeu:*`) déclenchent la mise en cache.
- Interface : `@media (max-width: 700px)` dans `styles.css` (barre d'onglets en bas, marges
  `safe-area`), sans effet sur le PC. `SUR_MOBILE` (App.jsx) pour les textes. **Jeu sans
  défilement** : marques dans l'en-tête de la tuile (`.marques-tete`, le rail est masqué), champs
  à la hauteur de leur texte, description à hauteur fixe, l'**image prend le reste** (flex,
  plancher 110 px) ; une ligne de boutons. Police selon la longueur (`long` / `tres-long`) pour
  titre, artiste, lieu ; tags affichés « a, b, c » (des tags collés sans espace élargissaient la
  tuile). Galeries : 2 / 3 / 4 par ligne (PC 5 / 7 / 9, `DENSITES`), `data-grille` sur `<html>`.
  Rapport : puces (`Puces`) au lieu de `<select>` (liste native Android datée).
- Construire : `node scripts/build-mobile.js` (→ `dist-mobile/`, servi par `.claude/launch.json`
  « mobile-web » pour tester dans un navigateur), puis `npx cap sync android` et
  `cd android && gradlew assembleDebug`. Émulateur : AVD `Medium_Phone_API_36.0`
  (`emulator -avd … -no-window`), `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`.
- Tests : `tests/mobile-sqlite.test.js` rejoue la suite E2b sur sql.js (`TT_SUITE=./synchro-e2e.test.js`
  pour la compaction) ; `tests/synchro-drive-http.test.js` fait passer E2b par `drive-api.js`.
- **Connexion Google sur Android** : client OAuth « Web » (son id → `src/mobile/google-config.json`
  `{ "webClientId" }`, gitignoré, injecté au build) **et** client « Android » (paquet
  `fr.tuilesettoiles.app` + SHA-1 de la clé de signature ; debug :
  `33:08:3A:4F:C3:3A:6B:3D:0B:AA:92:14:4F:0D:C0:E9:59:AB:4C:D5`), dans le projet `dislike-334115`.
  Une version publiée demandera sa propre clé (et son SHA-1). **Créés le 26/09/2026** : client Web
  « Tuiles et Toiles - mobile (Web) » (`874776918280-ce2unjgochu6…`, son secret n'est pas utilisé) et
  client Android « Tuiles et Toiles - Android (debug) ». `MainActivity.java` implémente
  `ModifiedMainActivityForSocialLoginPlugin` et relaie `onActivityResult` au module : sans ça, le
  module refuse l'autorisation Drive (« You CANNOT use scopes without modifying the main activity »).
  **Jeton Drive sans interface = module natif `JetonDrivePlugin.java`** (`Identity.getAuthorizationClient
  ().authorize(drive.file)`, compte de `drive.json`) : jeton neuf tant que l'accès reste accordé ;
  `hasResolution` → rejet `INTERACTION` (session expirée, jamais d'écran depuis le module) ; ApiException 7
  → erreur réseau (pas de pause). **Pas `SocialLogin.getAuthorizationCode`** (gardé en secours) : il
  exige un jeton d'identité valide, qui expire 1 h après la connexion (« User is not logged in ») — jusqu'en
  0.3.11 la synchro auto mobile se croyait déconnectée une heure après chaque connexion. Test :
  `tests/mobile-drive.test.js` (modules simulés).
- **Stockage (vfs)** : chaque fichier en **morceaux de < 60 Ko** dans IndexedDB (clé = `{ mtime,
  taille, n }`, morceaux `clé␀#i`, une transaction par sauvegarde). Au-delà, Chromium range la
  valeur dans un fichier annexe qui peut manquer si l'appli est tuée en pleine écriture →
  « Failed to read large IndexedDB value », plus rien ne démarrait (vu sur l'émulateur). Un
  fichier illisible est ignoré (`fs.illisibles()`, journalisé) au lieu de bloquer ; ancien
  format relu puis réécrit. `fs.promises` existe (le transport Drive range les images reçues
  par `transport-dossier.ecrireAtomique`, asynchrone).
- **Rechargement de page = `recharger()`** (App.jsx), jamais `location.reload()` nu : il attend
  `window.api.persister()` (mobile : `sauverTout()`, base écrite dans IndexedDB ; PC : rien). Sans
  ça, la page repart de la dernière sauvegarde (différée de 1,5 s) — 02/10/2026 : chaque synchro
  manuelle qui apportait des données les perdait au rechargement (curseurs compris, donc en boucle),
  et une tuile créée juste avant aussi. **Journal mobile persistant** (1 Mo × 2, `journal.configurer`
  `{ max, nb }`), enregistré par lots (15 s, `LENTS` dans `vfs.js`) et à la mise en veille.
- **Données mobiles** : réglage `synchro_wifi` (« Seulement en Wi-Fi », actif par défaut,
  `@capacitor/network` via `src/mobile/reseau.js`) → `auto.reseauPermis` : rien d'automatique
  hors Wi-Fi, un geste explicite passe. Pas de synchro au retour au premier plan (la
  surveillance la lance si la dernière a plus de 15 min). Hors Wi-Fi, une grande image affichée
  n'est pas re-téléchargée pour le cache.
- **Photo** : `edition:prendrePhoto` (mobile) → `@capacitor/camera` `takePhoto`, puis même import ;
  boutons « Prendre une photo » / « Galerie » dans l'éditeur. Retour Android (`@capacitor/app`
  `backButton`) : Échap si une boîte est ouverte, sinon `app:nav` « reculer » ; à la racine,
  `app:quitter` = `minimizeApp`. Icônes : `node scripts/icones-android.js`.
- **Mise à jour Android** (`src/mobile/maj.js` + module natif `MiseAJourPlugin.java`, déclaré
  dans `MainActivity.onCreate`) : mêmes canaux `maj:*` et même section Options que le PC ; lecture
  de la release commune au PC (`src/main/maj-github.js`). Asset `Tuiles-et-Toiles-x.y.z.apk`
  (`MOTIF_APK`, ne pas changer), téléchargé nativement dans le cache (`maj/`, vidé au lancement),
  taille + SHA-256 vérifiés, puis installateur d'Android (FileProvider). Première fois : réglage
  « Installer des applis inconnues » (`REQUEST_INSTALL_PACKAGES`), puis re-cliquer « Installer ».
  `versionName` / `versionCode` (x·10000+y·100+z) lus dans `package.json` par `build.gradle`.
  **Signature** : l'APK publié est le build *debug*, signé par `%USERPROFILE%\.android\debug.keystore`
  de ce PC — même clé que les APK installés et que le SHA-1 du client OAuth Android. **Sauvegarder
  ce fichier** : perdu = plus aucune mise à jour possible (désinstaller / réinstaller), et nouveau
  SHA-1 à déclarer. Une vraie clé de release viendra avec le Play Store.
- **Lecture du cartel** (éditeur, mobile) : « Lire le cartel » / « Cartel depuis la galerie » →
  photo (non gardée) → module natif `LectureTextePlugin.java` (Google ML Kit Text Recognition v2,
  variante **Play Services** : modèle fourni par les services Google, téléchargé une fois puis hors
  ligne ; la variante embarquée ajoutait 46 Mo à l'APK) → `src/mobile/cartel.js` (préparation du
  modèle 8 s après le lancement en Wi-Fi ; blocs triés de haut en bas) → **`src/main/cartel-analyse.js`**
  (JS pur, rôle par ligne : artiste, vie, titre, date, technique→tags, texte→description,
  provenance, numéro, traduction, doublon, autre) → boîte `BoiteCartel` : proposition cochée
  (un champ déjà rempli n'est pas écrasé d'office), correction en touchant des lignes puis un
  champ (ordre de sélection respecté, « Retirer du champ » ; une ligne = un champ), rien d'écrit
  avant « Valider ». Conservation : cible manuelle seulement, jamais proposée par l'analyse.
  Chaque lecture est journalisée (lignes, rôles, tailles) : un rapport d'erreur suffit pour régler
  les règles sur un cartel raté. Tests : `tests/cartel-analyse.test.js` sur 9 cartels réels
  retranscrits (`tests/cartels-exemples.js`, hauteurs estimées ; photos hors dépôt).
  **PC** (`src/main/cartel-pc.js`) : « Lire un cartel (photo)… » dans l'éditeur → fichier choisi (ou
  `{ chemin }`) → réduit par Jimp (≤ 2400 px, temporaire effacé) → reconnaissance de texte **intégrée à
  Windows** (`Windows.Media.Ocr`, WinRT par PowerShell en `-EncodedCommand`, fr-FR si installé, hors
  ligne, ~0,7 s) → blocs reconstitués par écarts verticaux / tailles (`blocs()`, Windows n'en donne
  pas) → même `cartel-analyse.js` et même `BoiteCartel`. Test : `tests/cartel-pc.test.js` (vraie
  lecture sur une image fabriquée).
  **Banc d'essai** (`tests/banc-cartels.js`, pas dans `npm test`) : note par champ (exact / proche / faux) et
  taux d'erreur de lecture, sur les vraies photos (`tests/photos-cartels/`, hors dépôt) ou sur des cartels
  fabriqués (`python tools/fabriquer-cartels.py [n] [graine]` → `tests/cartels-synthese/` : œuvres du pack,
  5 mises en page, polices Windows, 4 niveaux de dégradation). Mesures du 03/10/2026 en local : photos
  réelles 86 % de champs exacts, synthèse 60 % (lecture brute 8 % d'erreur : c'est le **rangement** par
  règles qui pèche, et les photos floues / fond sombre).
  **Lecture améliorée par Claude** (`src/main/cartel-ia.js`, commun PC / mobile, SDK `@anthropic-ai/sdk`) :
  bouton « Relire avec Claude » dans la boîte du cartel, sur la **même photo** (`cartel-pc.imageIA` /
  `mobile/cartel.imageIA` : JPEG ≤ 1 568 px). Envoie la photo + les catégories existantes (les plus
  fréquentes d'abord) ; sortie JSON imposée (`output_config.format`, schéma `SCHEMA`) : lignes + rôles +
  champs, **tags = catégories prises dans le vocabulaire de l'utilisateur**. Gamme (`ia_gamme`) : `sonnet`
  (`claude-sonnet-5-5`, effort `low`, reprise serveur en cas de refus `fallbacks: "default"`) par défaut,
  `haiku` (`claude-haiku-4-5`, sans effort) en option. **Modèle retiré (404)** : plus récent de la même gamme
  sur le compte (Models API), sinon gamme au-dessus, jamais Opus d'office ; retenu dans `ia_modele_id` et dit
  dans la boîte. Clé API **de l'utilisateur** (`ia-cle.js` : safeStorage sur PC → `ia-cle.bin` ;
  `mobile/ia-cle.js` : `/data/ia-cle.json`), jamais synchronisée ; le journal masque toute chaîne `sk-ant-…`
  et les champs `cle` / `apiKey`. Dépense cumulée (`ia_depense`, `ia_lectures`) dans Options → Lecture
  améliorée. Erreurs en clair (clé refusée, crédit épuisé, limite, panne, hors ligne). Test :
  `tests/cartel-ia.test.js` (faux client, aucun appel). **Mesure** (15 cartels les plus mal lus en local,
  Sonnet 5.5) : 96 % de champs exacts (100 % exacts ou proches) contre 15 % en local, ~0,8 centime de
  dollar par cartel (1,7 pour un long texte), 3 à 8 s. Banc : `--ia [--haiku]`, clé dans `ia-cle-dev.txt` à
  la racine (ignoré par git).
- `astral-regex` a dû être posé à la main dans `node_modules` (npm le croyait installé) : si
  `npx cap` échoue sur ce module, `npm pack astral-regex@2.0.0` et l'extraire.

## Dépôt, releases et mise à jour de l'app

- Dépôt **public** github.com/EryoGreg/tuiles-et-toiles. Bristol (github.com/EryoGreg/bristol)
  en est un fork à historique partagé (base commune : tag `v0.1.0`) ; y porter les correctifs par
  `git cherry-pick` (remote `tuiles-et-toiles`). `oauth-client.json` n'est jamais versionné.
- Publier une version : `npm version x.y.z --no-git-tag-version` (le numéro nomme les exe et le
  dossier d'extraction portable), `npm run dist` (portable **et** NSIS), commit + tag `vx.y.z`,
  push, `npm run dist:android` (→ `release/Tuiles-et-Toiles-x.y.z.apk`), puis `gh release create
  vx.y.z release/Tuiles-et-Toiles-x.y.z.exe release/Tuiles-et-Toiles-Setup-x.y.z.exe
  release/Tuiles-et-Toiles-x.y.z.apk` — **les trois fichiers**, chaque forme se met à jour avec le
  sien. Les exe et l'APK ne vont jamais dans git.
- **Installateur NSIS** : `oneClick`, par utilisateur (`%LOCALAPPDATA%\Programs\Tuiles et
  Toiles\`, sans droits admin, LISEZMOI `installation` déposé par l'app), relance l'app à la
  fin, ne crée **aucun raccourci** (ceux de l'app, `raccourcis.js`, nom « Tuiles & Toiles »,
  suffisent ; les créer aussi ferait des doublons), garde les données à la désinstallation.
- **Mise à jour intégrée** (`src/main/maj.js`), à la main (`electron-updater` ne gère pas le
  portable). `maj.mode()` = `dev` | `portable` | `installee`. `releases/latest` via l'API GitHub
  (anonyme, dépôt public), taille + SHA-256 vérifiés contre le `digest` publié par GitHub.
  Portable : nouvel exe téléchargé à côté de l'ancien puis lancé. Installée : installateur
  téléchargé dans `%TEMP%`, lancé en `/S --updated --force-run` (silencieux, relance l'app).
  **Portable → installée** : Options → « Passer à la version installée » (installateur visible).
  Marqueur `maj-en-cours.json` `{ version, vers, ancien, nouveau, setup }` : au lancement de la
  nouvelle version, l'ancien exe portable et l'installateur téléchargé sont supprimés. La synchro
  auto envoie ce qui reste avant de céder la place. Vérification discrète 4 s après le lancement
  (réglage `maj_auto`), rien n'est téléchargé sans clic, hors ligne → silencieux (règle 1).
  Raccourcis visant l'ancien exe : détection de raccourcis périmés.
- **Icône des raccourcis** : jamais lue dans l'exe (la MAJ silencieuse le retire quelques
  secondes → Windows cache une icône vide, persistante). `resources/icone.ico` copiée dans
  `%APPDATA%\Tuiles et Toiles\icone.ico` ; au démarrage, `raccourcis.reparerIcones` repointe
  tout .lnk visant l'exe (bureau, menu, barre — y compris les épinglages faits par Windows,
  nommés d'après la description de l'exe) puis `ie4uinit.exe -show`.
- Noms d'assets attendus par l'updater : `Tuiles-et-Toiles-x.y.z.exe` (`MOTIF_EXE`) et
  `Tuiles-et-Toiles-Setup-x.y.z.exe` (`MOTIF_SETUP`). Les changer casse la mise à jour des
  installations existantes.

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

## Contenus anormaux (04/10/2026)

Testés par `tests/anomalies.test.js` (et injectés au hasard dans `synchro-bilan-proprietes`) : écritures
non latines, emoji, combinants, invisibles, contrôles, NUL, HTML / `<script>`, SQL, jokers `%` `_`, JSON,
`__proto__`, chemins piégés, dates absurdes, textes énormes, ops hostiles venues d'un « autre appareil ».
- **Recherche multi-écritures** : `masques.normaliserRecherche` (Bibliothèque, notes) = `normaliser` pour le
  latin (pack et masques inchangés — vérifié sur les 431 œuvres) + lettres grecques, cyrilliques, hébraïques,
  arabes, thaïes, kana, CJK, hangul (avant : « Илья Репин » introuvable). Les masques gardent `normaliser`.
- **Textes bien formés** : moitié de caractère isolée → « � » à l'écriture (`moteur.bienForme`) **et** à la
  réception (dans le JSON reçu elle s'écrit `\udXXX`) ; sinon SQLite la changeait seul, registre ≠ table, et
  la réconciliation réécrivait la valeur à chaque ouverture.
- **Limites** : champ de tuile 2 000 caractères, description 20 000 (`edition.LIMITES`, refus avec message
  « Le champ « Titre » est trop long (2 500 caractères, 2 000 au plus) », rien d'écrit ; `maxLength` dans
  l'éditeur) ; op reçue > 100 000 caractères rejetée (`moteur.VALEUR_MAX`) ; note 20 000.
- **Jamais de HTML interprété** : React échappe tout (aucun `dangerouslySetInnerHTML`) ; le message d'échec
  du démarrage mobile passe par `textContent` (avant : `innerHTML` avec le message d'erreur).
- Clés / champs `__proto__`, `constructor` reçus : sans pollution de prototype ; valeurs non JSON rejetées.

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
est **discriminant** (ne désigne qu'une œuvre), **évocateur** (image présente,
titre, description ≥ 60 car., ou artiste ≤ 6 œuvres au corpus), **sans fuite** et
**incomplet** ; puis on ne garde que les masques **minimaux** (voir ci-dessous).
La date n'en fait jamais partie.

**Paliers de difficulté (04/10/2026, `tests/masques.test.js`).** On ne garde, par
œuvre, que les masques à **minC** et **minC+1** champs visibles (minC = minimum
possible). Les masques plus fournis sont jetés (montrer titre + artiste +
description à la fois n'a aucun intérêt — bug observé sur une tuile locale qui
révélait tout). Les deux paliers servent la **difficulté** choisie au tirage
(écran Nouvelle partie, réglage `difficulte` par appareil dans `prefs_affichage`,
défaut `difficile`) : **Difficile** = minC (1 indice), **Normal** = minC+1 (2).
`jeu.tuile` filtre selon la difficulté ; pour Normal en aléatoire il préfère un 2e
champ **hors tag** (le tag y est toujours censuré). Une tuile sans image ne
propose jamais sa case image (même en Normal). S'applique aussi à la révision
(même `jeu.tuile`). Sur les 431 : **0 bloquée**, difficile 1 champ / normal 2
champs pour toutes. Créer / modifier / supprimer une tuile change la discriminance
de tout le corpus → recalcul complet à chaque écriture (S2+, ~100 ms).

Quatre règles ajustées le 04/10 pour le **contenu utilisateur** (les constantes
étaient calibrées sur les 431 du pack ; Bristol poussera du contenu arbitraire
dans ce même moteur) :
- **Image facultative** : `valeur('image')` renvoie `''` (pas l'id fantôme) quand
  la tuile n'a pas d'image → l'image ne discrimine ni n'évoque alors ; la tuile
  reste jouable par titre/description. Une tuile sans image est acceptée.
- **Fuite généralisée** : aucun champ visible ne trahit la réponse d'un champ
  caché (`CIBLES_FUITE` = artiste/titre/lieu ; sources = tous les champs texte
  visibles). Avant : seule `description → artiste/titre`. Couvre p. ex. `lieu`
  « Musée Picasso » visible pendant que l'artiste « Picasso » est caché. Un titre
  ou un lieu cible exige ≥ 2 mots significatifs (> 3 lettres) ; l'artiste suffit
  à 1 (nom propre = réponse franche).
- **Artiste évocateur jusqu'à 6 œuvres** (`ARTISTE_EVOCATEUR_MAX`, avant : 1) : un
  artiste prolifique sur des sujets variés reste un indice ; la discriminance est
  vérifiée à part.
- **Tuile pauvre / incomplète** : autorisée (fiche volontaire), mais l'éditeur
  prévient par un popup non bloquant (« Garder quand même »), à **deux niveaux** :
  « Tuile injouable en l'état » (0 masque → n'apparaît pas en jeu) ou « Tuile
  incomplète » (jouable mais apparaîtra peu), avec la **liste des champs
  manquants** (`edition.manquesDe` : image/titre/artiste/date/lieu/description <
  60 car./tags, renvoyé par `creer`/`modifier` à côté du compte de masques). Pas
  de masque de repli : une tuile à 0 masque n'apparaît simplement pas en jeu.
  Garde-fou éditeur : après une création, les validations suivantes **modifient**
  la même tuile (pas de doublon). Vérifié en conditions réelles (build mobile-web,
  origine vierge pour contourner le cache de `principal.js`, nom sans hash).

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

- **Barres obliques inverses dans les heredocs de l'outil Bash** : `\\` y devient `\` (un
  `\'` Python y perd sa barre, un `\\n` devient un vrai saut de ligne). Écrire les scripts
  Python avec l'outil Write, pas en heredoc.
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
- `data/images/` (431 JPEG, 53,5 Mo, côté max 1400 px) : **plus embarquées** depuis 0.3.5.
  `data/vignettes/` (côté 480 px, 13 Mo) et `data/images-manifest.json` (`{ ref, images: { nom:
  { octets, sha256 } } }`) le sont, générés par `node scripts/vignettes.js`. Les grandes images
  sont téléchargées à la demande (`src/main/images-distantes.js`) depuis
  `raw.githubusercontent.com/EryoGreg/tuiles-et-toiles/<ref>/data/images/`, vérifiées, mises en
  cache dans `images-cache/` ; sans connexion, la vignette les remplace.
  **Qualité des images** (0.3.13, `src/main/images-qualite.js`, réglage `images_qualite`, Options →
  Images des œuvres) : `reduite` (aucun téléchargement ni adresse GitHub, vignette sauf grande image déjà
  en cache), `affichage` (grande image téléchargée à l'affichage puis gardée ; mobile : en Wi-Fi et pour
  les tuiles vues en grand), `tout` (tout d'avance, **dès le choix**, puis lancement + 90 s / 12 s mobile,
  toutes les 30 min, retour du Wi-Fi ; mobile en Wi-Fi seulement ; s'arrête si le réglage change ou si le
  Wi-Fi tombe). Défaut : `tout` sur PC, `affichage` sur mobile ; l'ancienne case `images_hors_ligne`
  (qui ne faisait **rien** sur mobile) est migrée (1 → tout, 0 → affichage). **Cache conforme** : une copie
  dont la taille ne correspond plus au manifeste (image du pack changée depuis) est effacée puis
  re-téléchargée (avant : l'ancienne restait servie pour toujours) ; mobile : vérifié au démarrage, copies
  hors manifeste effacées aussi. **« Libérer l'espace (X Mo) »** (`images:vider`, confirmation) : grandes
  images du cache effacées (LISEZMOI gardé), téléchargement complet interrompu ; passer en `reduite`
  avec un cache non vide le propose. Plafond du cache = une copie par image du pack (~54 Mo). Coût :
  vignette 33 Ko en moyenne (14 Mo, embarquées), grande 130 Ko (56 Mo). Tests dans
  `tests/images-distantes.test.js`. `tuile://<nom>` = grande image, `tuile://mini/<nom>`
  = vignette (grilles, Corbeille, journal). **Changer une image du pack** = relancer le script
  en montant `REF`, puis `git tag <REF> && git push origin <REF>` (jamais servir depuis `main` :
  l'empreinte ne correspondrait plus). En dev, `data/images/` sert de source locale
  (`TT_SANS_IMAGES=1` pour tester le téléchargement).
- `data/utilisateur.db` — créé au runtime, jamais versionné.

33 images font moins de 500 px de côté — limitation de la source, pas de la
conversion. Extraction des images d'origine : `tools/extraire_images.gs` (le
connecteur Drive tronque `read_file_content` à ~101 000 caractères et plafonne
l'export complet à 10 Mo).
