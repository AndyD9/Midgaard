# Consignes pour Claude Code — dépôt Midgaard

Harness local qui laisse Claude Code déléguer des tâches à des agents exécutants,
les observer et les soumettre à approbation humaine. **Lire d'abord** :
[README.md](README.md) (état, commandes), [docs/PLAN.md](docs/PLAN.md) (décisions
et slices), [docs/SLICE3.md](docs/SLICE3.md) (la slice en cours : décisions,
découpage, étape atteinte), [docs/SLICE2.md](docs/SLICE2.md),
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
| `npm run harness -- <cmd>` | CLI : `start`, `stop`, `status`, `approve`, `reject` |
| `npm run harness -- providers add <id> --model <m>` | Déclare un fournisseur ; clé saisie sans écho |
| `npm run harness -- agents` | Profils d'exécution, et pourquoi certains sont désactivés |
| `npm run test:unit` | ~5 s — machine à états, persistance, adaptateurs, coûts, outils, boucle, coffres, worktrees (vrais dépôts Git) |
| `npm run test:vault` | ~1 s — les coffres seuls, sur le coffre réel de la machine |
| `npm run test:lock` | ~30 s — instance unique du daemon sous concurrence |
| `npm run test:restart` | ~45 s — redémarrage, reprise WS, sécurité, inactivité |
| `npm run test:ui` | ~1 min — le dashboard dans un vrai navigateur (`npx playwright install chromium` au préalable) |
| `npm run test:wait` | ~3 min — 12 scénarios de bout en bout MCP |

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
  fin pour sortir du cadre.
- **Aucune clé d'API en base.** La base ne garde qu'une référence vers le coffre.
  Et tout ce qui est journalisé ou persisté passe par `createRedactor`.

- **Aucun programme désigné par l'arbre d'un worktree ne s'exécute.** Cet arbre
  est écrit par l'agent. Tout `git` du paquet `workspace` passe par `git()`, qui
  impose `core.hooksPath` vers le périphérique nul ; les diffs portent
  `--no-ext-diff --no-textconv`. **`--no-verify` ne suffit pas** : constaté,
  `prepare-commit-msg` et `post-commit` tournent malgré lui.
- **Le harness ne merge jamais, et ne supprime rien hors de `worktreesDir`.** Le
  merge est un acte humain (décision de la Slice 3). Le retrait d'un worktree
  vérifie que le chemin est strictement sous le dossier des worktrees, même
  forcé : le chemin vient de la base, et une ligne fausse ne doit rien effacer.
- **On n'écrit que dans un worktree, et jamais sous `.git`.** Sans
  `ToolContext.writable`, les outils d'écriture **refusent** — pas
  d'approbation à la place. Dans un worktree, `.git` est un fichier qui désigne
  le dépôt : le réécrire redirigerait le commit de fin ailleurs.
- **`exec` : l'approbation est la frontière, et aucun processus ne survit.**
  Approbation par défaut ; le binaire est résolu **avant** la demande (entrées
  relatives du `PATH` ignorées) pour que l'humain approuve ce qui tourne ; le
  groupe de processus est tué à la sortie, au délai et à l'annulation — vérifié
  en interrogeant les pid au système.
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

## Slice 3 en cours

`workspace` (création, nettoyage et diff des worktrees Git), outils d'écriture,
`git` et `exec` contrôlé, ApprovalBroker et UI d'approbation bloquante, onglet
Files/Diff. Le profil `developer` rejoindra `simulated` et `researcher` dans
`packages/daemon/src/agents.ts`, et son moteur sera l'`AgentEngine` existant avec
une autre boîte à outils : la boucle n'a pas à changer.

**Étapes 1 à 3 sur 8 livrées** — le paquet `workspace` et la table
`workspaces` (migration 4, `PROTOCOL_VERSION` 5) ; `write_file`, `edit_file`,
`delete_file`, `git_diff` et `exec`. Aucun agent ne s'en sert encore : aucun profil n'a
de worktree, et `ToolContext.writable` est fermé par défaut. Les quatre
décisions prises avec l'auteur (merge manuel, worktrees conservés jusqu'au
nettoyage, sous `~/.midgaard/worktrees`, `exec` en approbation par défaut) et le
découpage des sept étapes restantes sont dans [docs/SLICE3.md](docs/SLICE3.md) :
le lire avant de poursuivre.

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
