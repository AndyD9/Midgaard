# Consignes pour Claude Code — dépôt Midgaard

Harness local qui laisse Claude Code déléguer des tâches à des agents exécutants,
les observer et les soumettre à approbation humaine. **Lire d'abord** :
[README.md](README.md) (état, commandes), [docs/PLAN.md](docs/PLAN.md) (décisions
et slices), [docs/SLICE4.md](docs/SLICE4.md) (durcissement et distribution :
décisions, étapes — la slice en cours), [docs/SLICE3.md](docs/SLICE3.md) (Developer, worktrees,
approbations : décisions, étapes, essai réel, CI), [docs/SLICE2.md](docs/SLICE2.md),
[docs/SLICE1.md](docs/SLICE1.md) et [docs/SLICE0.md](docs/SLICE0.md) (d'où
viennent les invariants).

Chaque paquet a son `README.md` : le lire avant d'y toucher.

## Conventions

- **Langue** : français pour les échanges, les commentaires et la documentation.
  Exception : les descriptions d'outils MCP, les `instructions` du serveur et les
  messages renvoyés au modèle sont en anglais, car c'est le modèle qui les lit.
- **Toujours documenter et commenter le code**, sans attendre qu'on le demande,
  y compris les tests :
  - un en-tête par fichier (rôle du module, place dans l'architecture) ;
  - une JSDoc sur chaque élément exporté (rôle, paramètres, retour, erreurs) ;
  - des commentaires sur le *pourquoi* des choix non évidents (sécurité, délais,
    pièges de plateforme), jamais la paraphrase du code ;
  - un README par module, et la documentation tenue à jour quand le comportement change.
- **Commandes à donner à l'utilisateur** : complètes et prêtes à copier, sans
  `<placeholder>` (zsh lit `<` et `>` comme des redirections).

## Commandes (à la racine)

| Commande | Rôle |
|---|---|
| `npm ci` | Dépendances |
| `npm run init` | Déclare le serveur MCP dans `./.mcp.json` |
| `npm run doctor` | Diagnostic de l'installation |
| `npm run typecheck` | Vérification des types, dashboard compris |
| `npm run build` | Compile les paquets et le dashboard |
| `npm run pack:npm` | Assemble le paquet npm `midgaard` dans `.pack/` (build propre) |
| `node scripts/release.ts check` | Ce que la publication vérifiera : tag, version absente du registre, commit sur `main` |
| `npm run harness -- <cmd>` | CLI : `start`, `stop`, `status`, `approve`, `reject` |
| `npm run harness -- providers add <id> --model <m>` | Déclare un fournisseur ; clé saisie sans écho |
| `npm run harness -- agents` | Profils d'exécution, et pourquoi certains sont désactivés |
| `npm run harness -- workspaces` | Worktrees : `remove`, `clean` — la branche reste toujours |
| `npm run harness -- exec` | Liste blanche `exec` du dépôt : `allow` (avertit, confirme), `revoke` |
| `npm run test:unit` | ~5 s — machine à états, persistance, adaptateurs, coûts, outils, boucle, coffres, worktrees (vrais dépôts Git) |
| `npm run test:vault` | ~1 s — les coffres seuls, sur le coffre réel de la machine |
| `npm run test:worktrees` | ~5 s — worktrees, écriture et `exec` seuls (rejoués en CI sur trois plateformes) |
| `npm run test:lock` | ~30 s — instance unique du daemon sous concurrence |
| `npm run test:restart` | ~45 s — redémarrage, reprise WS, sécurité, inactivité |
| `npm run test:ui` | ~1 min — le dashboard dans un vrai navigateur, diff d'une tâche Developer compris (`npx playwright install chromium` au préalable) |
| `npm run test:developer` | ~35 s — le Developer dans un vrai daemon, face à un faux fournisseur ; crash et concurrence compris |
| `npm run test:security` | ~3 s — PLAN §8.4 de bout en bout : base et journal lus octet pour octet, refus tracés, API sur la seule boucle locale |
| `npm run test:wait` | ~3 min — 12 scénarios de bout en bout MCP |
| `npm run test:package` | ~1 min — le paquet installé dans un préfixe et un `HOME` vierges ; réseau requis |

## Invariants à ne pas casser

Chacun a été appris à la dure ; le détail est dans `docs/SLICE0.md`,
`docs/SLICE1.md`, `docs/SLICE2.md` et `docs/SLICE3.md`.

- **Notifications de progression pendant toute attente longue.** Un client MCP
  coupe un appel d'outil à 60 s sans elles — mesuré, deux fois.
  `harness_wait_for_task` attend par tranches de 15 s et notifie entre chaque.
- **Aucun outil d'approbation exposé à Claude.** L'approbation est un acte
  humain : dashboard ou CLI. Chaque pause porte une consigne exacte
  (`approval_instructions`) que Claude transmet telle quelle.
- **Une pause d'approbation n'est annoncée qu'une fois par client**
  (`approval_seq`) ; ensuite l'attente bloque jusqu'à la décision humaine.
- **Un changement d'état et l'événement qui le raconte s'écrivent ensemble**,
  dans la même transaction, et tout ce qui est écrit est diffusé. C'est pour cela
  que le dépôt expose `record()` et que le daemon n'écrit que par `EventBus`.
- **`task_events.seq` est global, `AUTOINCREMENT`, jamais réutilisé.** C'est la
  clé de la reprise WebSocket : sans elle, une reconnexion laisse un trou
  invisible dans la timeline.
- **Toute tâche trouvée active au démarrage devient `interrupted`.** Jamais
  reprise, jamais considérée réussie.
- **Incrémenter `PROTOCOL_VERSION`** (`packages/contracts/src/protocol.ts`) à tout
  changement incompatible entre serveur MCP et daemon : le daemon survit aux
  mises à jour du code, et c'est ce numéro qui le fait remplacer.
- **Ne jamais écrire sur stdout dans le serveur MCP** : c'est le canal JSON-RPC.
- **Un daemon d'une autre installation n'est remplacé que s'il est oisif**, et
  c'est lui qui le décide (`POST /api/shutdown` avec `if_idle`), sans `await`
  entre la lecture de son compteur et son arrêt. Une installation = dossier du
  paquet `@midgaard/daemon` + version (décision de la Slice 4, étape 6).
- **Une commande conseillée à l'utilisateur passe par `cmd()`** (CLI) : `harness
  …` depuis le paquet, `npm run harness -- …` depuis les sources ; le daemon et
  le serveur MCP, qui ne peuvent pas dépendre de la CLI, se repèrent de même
  sur l'extension de leur propre fichier (`keyCommand`, `approvalCommand`). Le
  paquet ne contient que `dist/` : rien n'y doit renvoyer vers le dépôt — son
  README est `docs/INSTALLER.md`, que l'assemblage refuse avec un lien relatif
  ou un `npm run`.
- **La configuration est injectée**, jamais lue au chargement d'un module. Seuls
  les `main.ts` lisent `process.env`.
- **Une migration publiée ne se modifie plus** : toute évolution ajoute une entrée
  à la fin de `MIGRATIONS`.
- **Tester les invariants directement** (compter les processus vivants), pas leurs
  effets visibles depuis un client : c'est ainsi qu'un bug de verrou est passé inaperçu.
- **Ne rien décrire à Claude ni à l'utilisateur qui n'existe pas encore.** Le
  premier test réel l'a renvoyé vers un dashboard inexistant ; le daemon annonce
  donc `dashboard_available`, et le scénario S8 charge l'URL annoncée pour vérifier
  qu'elle sert vraiment quelque chose. Même règle en Slice 2 : un profil sans
  fournisseur est montré **désactivé avec son motif**, et un « Test connection »
  doit prouver la **clé**, pas seulement que l'endpoint répond — `GET /models` de
  Venice est public, et le test l'annonçait « joignable » avec une clé bidon.
- **Un test qui saute doit le dire, jamais ressembler à un test qui réussit.**
  La conformité du coffre ne peut éprouver que le coffre de la machine qui
  l'exécute ; `MIDGAARD_REQUIRE_VAULT` fait donc nommer à chaque poste de CI le
  coffre qu'il prétend prouver, et la suite échoue si ce n'est pas celui-là.
  Sans cela, le poste Linux sans trousseau serait passé au vert sans rien
  exercer. C'est le même principe que `dashboard_available` : ne rien annoncer
  qu'on n'a pas constaté.
- **Aucun montant sans sa provenance.** `cost_source` accompagne toujours
  `cost_usd` : `provider` (la facture), `pricing_table` (une estimation) ou
  `unknown`. Un modèle sans tarif connu n'affiche **pas** `0 $` : zéro est un
  coût, pas une ignorance. Quand le fournisseur annonce son propre coût, on garde
  l'estimation à côté — l'écart est la seule façon de voir dériver `pricing.json`.
- **Les limites appartiennent au profil, pas à l'appel.** `tightenLimits` ne sait
  qu'abaisser. Si une délégation pouvait relever le budget, le budget ne
  protégerait plus personne.
- **Vérifier les limites AVANT l'appel modèle**, jamais après : une limite
  constatée après coup a déjà été payée. Et `budget_exceeded` n'est pas `failed` —
  rien n'a échoué, un plafond a été atteint.
- **La fin d'une tâche est un acte, pas une interprétation.** Seul `submit_result`
  termine une tâche d'agent. Un modèle qui écrit « j'ai fini » n'a pas fini.
- **Les chemins se revérifient à l'ouverture du descripteur**, pas seulement
  avant : on compare `dev`/`ino` du `fstat` à ceux du `stat` d'avant. Sans cela,
  la cible peut changer entre la vérification et l'ouverture.
- **Tout ce qui vient du web est encadré en `<untrusted_data>`** avec un nonce
  aléatoire, avant d'être réinjecté dans la conversation de l'agent **et** avant
  de remonter à Claude. Sans nonce, il suffit qu'une page contienne la balise de
  fin pour sortir du cadre. L'étiquette se désamorce comme le contenu : pour
  `exec`, c'est la commande écrite par le modèle.
- **Aucune clé d'API en base.** La base ne garde qu'une référence vers le coffre.
  Et tout ce qui est journalisé ou persisté passe par `createRedactor` —
  **y compris le message d'un refus**, qui cite ce que le modèle a demandé.
  `tests/security.ts` lit la base et le journal octet pour octet : c'est là
  que deux oublis ont été trouvés, pas dans les tests de l'expurgation.

- **Aucun programme désigné par l'arbre d'un worktree ne s'exécute.** Cet arbre
  est écrit par l'agent. Tout `git` du paquet `workspace` passe par `git()`, qui
  impose `core.hooksPath` vers le périphérique nul ; les diffs portent
  `--no-ext-diff --no-textconv`. **`--no-verify` ne suffit pas** : constaté,
  `prepare-commit-msg` et `post-commit` tournent malgré lui.
- **Le harness ne merge jamais, et ne supprime rien hors de `worktreesDir`.** Le
  merge est un acte humain (décision de la Slice 3). Le retrait d'un worktree
  vérifie que le chemin est strictement sous le dossier des worktrees, même
  forcé : le chemin vient de la base, et une ligne fausse ne doit rien effacer.
- **On n'écrit que dans un worktree, jamais sous `.git`, jamais dans un
  sous-module.** Sans `ToolContext.writable`, les outils d'écriture
  **refusent** — pas d'approbation à la place. Dans un worktree, `.git` est un
  fichier qui désigne le dépôt : le réécrire redirigerait le commit de fin
  ailleurs. Un sous-module y est un dossier vide, et `git add -A` ignore **sans
  un mot** ce qu'on y écrit : l'agent croirait avoir livré.
- **`exec` : l'approbation est la frontière, et aucun processus ne survit.**
  Approbation par défaut ; le binaire est résolu **avant** la demande
  (`Tool.prepare`, entrées relatives du `PATH` ignorées) et **revérifié avant
  de lancer**, pour que l'humain approuve ce qui tourne ; le
  groupe de processus est tué à la sortie, au délai et à l'annulation — vérifié
  en interrogeant les pid au système. **Et si le daemon meurt net** (`SIGKILL`),
  la garde (`packages/tools/src/guard.ts`) tue les groupes qu'il n'a pas pu
  tuer : sans elle, une commande continuait d'écrire dans le worktree.
- **Une approbation porte sur l'opération préparée, et son empreinte sur le
  détail structuré** (`operation_detail`, JSON canonique), jamais sur le texte
  affiché. Le détail est expurgé avant d'être persisté.
- **Une phrase de documentation est une affirmation à prouver.** À l'étape 3,
  « binaire résolu avant la demande » a été écrit sans être vrai, et le test du
  même sujet vérifiait le défaut (docs/SLICE3.md, leçon n° 10).
- **La branche ne bouge qu'à `submit_result`.** Le harness commite le travail
  d'une tâche **aboutie**, et seulement elle : une tâche qui échoue laisse sa
  branche au commit de départ, son travail lisible dans le worktree, jamais une
  branche qui a l'air d'un résultat. Le worktree est conservé dans tous les cas.
- **Une liste blanche `exec` se range sous la racine canonique du dépôt**, d'où
  que la CLI soit lancée : rangée ailleurs, elle aurait l'air de marcher et ne
  servirait jamais. Le moteur la lit au départ de la tâche, jamais en route.
- **Les commits d'agent ne portent ni l'identité ni la signature de
  l'utilisateur** : `Midgaard <agent> <agent@midgaard.invalid>`, `--no-gpg-sign`.
- **Le diff se calcule contre `base_commit`, jamais contre une branche**, et
  inclut les fichiers nouveaux (index temporaire, celui de l'agent intact).

## Pièges d'environnement

- **`security find-generic-password -w` rend l'hexadécimal** dès que le secret
  contient un octet non-ASCII, sans le signaler, et deviner à la relecture est
  impossible (`abcdef` est les deux à la fois). On ne dépose donc que de l'ASCII
  imprimable (`mg1:` + base64).
- **`String.replace` passe le texte entier après les groupes de capture.** Le
  confondre avec un groupe fait chercher tout le document dans le seul motif
  trouvé — l'expurgation ne remplaçait alors rien.
- **`run()` (paquet `secrets`) reconstruit l'environnement du fils à partir
  d'une liste blanche.** Poser une variable dans `process.env` ne la fait donc
  **pas** arriver au processus lancé : il faut la passer en argument (`extraEnv`).
  C'est ce qui faisait ranger toutes les clés DPAPI dans un seul fichier, en
  silence. Même cause pour `secret-tool`, qui a besoin de
  `DBUS_SESSION_BUS_ADDRESS` et `XDG_RUNTIME_DIR` pour joindre le trousseau.
- **Sous Windows, un même dossier a deux noms** : `os.tmpdir()` rend
  `C:\Users\RUNNER~1\…` (nom court 8.3), le harness canonicalise en
  `C:\Users\runneradmin\…`. Seul `realpathSync.native` (ou `fs.promises.realpath`)
  développe le nom court ; `realpathSync` tout court non. Un test qui compare
  à un chemin rendu par le harness emploie donc `.native` — trois scénarios
  ont échoué en CI pour cela, le harness ayant raison.
- **Canonicaliser la racine d'un projet avant toute vérification de chemin** :
  sous un lien symbolique (`/tmp` sur macOS, bien des dossiers personnels), un
  projet voit sinon ses propres fichiers refusés « hors du projet ».
- Node exécute le TypeScript directement, **y compris pour les paquets du
  workspace** : il résout le lien symbolique avant d'appliquer la règle
  `node_modules`. Le développement se passe donc de build ; la distribution non.
- **`erasableSyntaxOnly` est activé** : pas de propriétés de paramètres de
  constructeur (`constructor(readonly x: string)`), pas d'`enum`.
- **Les conditions d'export** (`midgaard-dev`) décident si un paquet se résout vers
  `src/` ou `dist/`. Elles **ne s'héritent pas** par un processus fils : les
  repasser explicitement (voir `nodeArgsFor` dans `tests/helpers.ts`).
- **Le dashboard n'importe de `@midgaard/contracts` que des *types*** : son point
  d'entrée charge `node:os` et `node:fs`.
- `typescript` 7 est le compilateur natif : `tsc` fonctionne, mais l'API JavaScript
  du compilateur n'existe plus (épingler `typescript@5` si un outil en a besoin).
- Claude Code ne relit `.mcp.json` qu'à l'ouverture d'une session : après une
  modification du serveur MCP, ouvrir une **nouvelle** session pour tester.
- L'état runtime vit dans `~/.midgaard`, pas dans le dépôt. `MIDGAARD_HOME` le
  déplace — c'est ce que font toutes les suites de tests.

## Git

- Dépôt : https://github.com/AndyD9/Midgaard (public).
- Ne jamais versionner `.mcp.json`, `dist/` ni `~/.midgaard` (jeton du daemon).

## Slice 4 en cours — durcissement et distribution

Démarrée le 2026-10-30. Décisions (un seul paquet `midgaard` ; publication par
la CI sur tag, avec provenance ; `edit_file` tolérant aux fins de ligne ;
Windows éprouvé en CI seulement) et découpage en huit étapes :
[docs/SLICE4.md](docs/SLICE4.md). Règle d'ordre : rien n'est distribué avant
d'être durci. Depuis l'étape 2 : migration 7 (`workspaces.submodules_json`),
`PROTOCOL_VERSION` 8, puis 9 à l'étape 6. Depuis l'étape 5, **toutes** les suites tournent en CI sur
macOS, Linux et Windows (`.github/workflows/e2e.yml`, passage `41182184282`).
Depuis l'étape 7 : `.github/workflows/publish.yml` publie sur tag `v…` (procédure :
[docs/PUBLIER.md](docs/PUBLIER.md)) ; le README du paquet est
[docs/INSTALLER.md](docs/INSTALLER.md), pas celui du dépôt ; le guide de
dépannage est [docs/DEPANNAGE.md](docs/DEPANNAGE.md) — à tenir à jour quand un
message d'erreur change, il les cite mot pour mot. **Ne jamais pousser un tag
`v…` sans demande explicite** : c'est une publication, irréversible.

## Slice 3 terminée

Le 2026-10-30, en vraie session, un Developer sur Venice a implémenté `/health`
dans un worktree, sous approbation humaine, coût **exact au microdollar** ; les
suites `workspace`, écriture et `exec` sont vertes sur macOS, Linux et Windows
(`.github/workflows/worktrees.yml`, passage `41050506668`). Récit, décisions,
mesures et leçons (21) : [docs/SLICE3.md](docs/SLICE3.md).

Ce qui existe : le paquet `workspace` ; `write_file`, `edit_file`,
`delete_file`, `git_diff`, `exec` ; des approbations portant sur l'opération
préparée ; le profil `developer` ; la carte « Fichiers et diff » ;
`harness workspaces` et `harness exec` (liste blanche par dépôt). Migrations 4
à 6, `PROTOCOL_VERSION` 7.

**Slice 4** (PLAN §7) : durcissement et distribution npm. Ce que la Slice 3
lui laisse, au § « Ce qui reste ouvert » de `docs/SLICE3.md` :

- ~~`doctor` migre la base qu'il diagnostique~~ — réglé (Slice 4, étape 1) ;
- ~~`edit_file` dans un dépôt CRLF~~ — réglé (Slice 4, étape 2) ;
- le daemon de bout en bout, le dashboard et la CLI n'ont tourné que sous macOS ;
- ~~les sous-modules sont absents des worktrees, sans que rien le dise~~ — réglé
  (Slice 4, étape 2) : nommés, et l'écriture y est refusée.

Des cinq dettes nées de la Slice 2, **trois sont soldées** le 2026-10-29 ; le
récit complet est au § « Les dettes, soldées » de [docs/SLICE2.md](docs/SLICE2.md).
Ce qu'elles ont coûté vaut d'être su avant d'en ouvrir d'autres : les trois ont
révélé **sept pannes réelles** dans du code qui avait l'air juste, plus deux
messages qui n'en étaient pas. Cinq des sept ne se voyaient que sur une
plateforme ou dans un navigateur.

- **Coffre (dette n° 3)** — `tests/unit/secrets.test.ts` passe la même batterie
  au coffre réel de la machine ; `.github/workflows/vault.yml` la lance sur
  macOS, Windows et Linux (avec **et** sans trousseau), chaque poste nommant par
  `MIDGAARD_REQUIRE_VAULT` le coffre qu'il prétend prouver. **Constatée** au
  passage `40937579307` : quatre postes au vert. Il en a fallu **cinq** pour y
  arriver, et les cinq pannes trouvées en chemin sont détaillées dans
  `docs/SLICE2.md` — DPAPI rangeait toutes les références dans un seul fichier,
  reconstruisait le cache de modules de PowerShell à chaque appel, et levait en
  supprimant un absent ; libsecret se déclarait disponible sans bus de session,
  puis sur un trousseau sans collection.
- **Dashboard (dette n° 4)** — `npm run test:ui` : 7 scénarios dans un vrai
  navigateur. Deux pannes trouvées : la carte « Exécutants » ne s'affichait
  **jamais** au premier chargement (ses requêtes partaient avant le bootstrap et
  prenaient un 401 qu'un `catch` vide avalait), et le dashboard ne se
  reconnectait **jamais** après un redémarrage du daemon (jeton périmé conservé).
- **Conseil de `doctor` (dette n° 5)** — `vaultAdvice` dépend de la plateforme,
  et distingue le repli *subi* du repli *demandé* par `MIDGAARD_VAULT=file`.

**Deux dettes restent ouvertes**, toutes deux faute de clé Google — rien n'a été
constaté contre l'API réelle, et rien ne doit être écrit comme si ça l'avait été :

1. **Éprouver l'adaptateur Gemini contre l'API réelle.** Il est écrit d'après la
   documentation REST et vérifié sur réponses enregistrées, jamais exécuté. À
   trancher en même temps : `generateContent` (que Google qualifie désormais de
   *legacy* tout en le maintenant) contre l'« Interactions API » recommandée.
2. **Rouvrir le grounding `google_search`.** Il partage le tableau `tools` avec
   les `functionDeclarations`. Une recherche web rapporte, **sur la foi de pages
   citées et non d'un appel**, que Google interdit la cohabitation : la question
   deviendrait alors un choix d'architecture (deux appels, ou l'Interactions API)
   plutôt qu'un essai. Une clé en main, elle se répond en un appel.

Les « Tasks » MCP natives restent tranchées : `claude-code` 2.1.309 ne déclare
pas la capacité `tasks`, donc elles sont inutilisables et `harness_wait_for_task`
reste nécessaire. Le serveur MCP écrit les capacités du client dans
`~/.midgaard/mcp-trace.jsonl` (`client.initialized`, `supports_native_tasks`) à
**chaque** connexion : relire cette ligne après une montée de version du client,
c'est tout ce qu'il faut pour rouvrir la question.

Le même relevé montrait deux capacités à regarder : `elicitation`, toujours à
l'étude pour les approbations (détail dans [docs/SLICE1.md](docs/SLICE1.md)), et
**`roots`, désormais employée** — c'est le client qui dit au serveur MCP quel
dépôt est ouvert, et donc ce qu'un agent a le droit de lire.
