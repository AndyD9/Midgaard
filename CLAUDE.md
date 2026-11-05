# Consignes pour Claude Code — dépôt Midgaard

Harness local qui laisse Claude Code déléguer des tâches à des agents exécutants,
les observer et les soumettre à approbation humaine. **Lire d'abord** :
[README.md](README.md) (état, commandes), [docs/PLAN.md](docs/PLAN.md) (décisions
et slices), [docs/SLICE8.md](docs/SLICE8.md) (serveurs MCP et agents créés à la
volée, en cours), [docs/SLICE7.md](docs/SLICE7.md) (images et navigateur isolé, décidée),
[docs/SLICE6.md](docs/SLICE6.md) (atelier façon VS Code, essais réels),
[docs/SLICE5.md](docs/SLICE5.md) (orchestrateur intégré, essai réel), [docs/SLICE4.md](docs/SLICE4.md) (durcissement,
distribution abandonnée, essai depuis un clone), [docs/SLICE3.md](docs/SLICE3.md) (Developer, worktrees,
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
| `npm run desktop:build` | Construit la coque Tauri (`apps/desktop`, Rust requis) ; facultatif |
| `npm run desktop` | Ouvre la fenêtre desktop du dashboard, démarre le daemon au besoin |
| `npm run test:desktop` | ~2 min la première fois — les tests Rust de la coque (adresse du dashboard) |
| `npm run harness -- <cmd>` | CLI : `start`, `stop`, `status`, `approve`, `reject` ; `--home <dossier>` avant la commande vise un autre runtime |
| `npm run harness -- providers add <id> --model <m>` | Déclare un fournisseur ; clé saisie sans écho |
| `npm run harness -- agents` | Profils d'exécution, et pourquoi certains sont désactivés |
| `npm run harness -- workspaces` | Worktrees : `remove`, `clean` — la branche reste toujours |
| `npm run harness -- exec` | Liste blanche `exec` du dépôt : `allow` (avertit, confirme), `revoke` |
| `npm run harness -- mcp` | Serveurs MCP : `add` (programme résolu, testé dans la foulée), `test`, `tools`, `allow` (avertit, confirme), `revoke`, `remove`, `attach`/`detach` (à un profil) |
| `npm run test:unit` | ~15 s — machine à états, persistance, adaptateurs, coûts, outils, boucle, coffres, worktrees (vrais dépôts Git), navigateur (vrai Chromium), client MCP (vrai serveur stdio, processus comptés) |
| `npm run test:vault` | ~1 s — les coffres seuls, sur le coffre réel de la machine |
| `npm run test:worktrees` | ~8 s — worktrees, écriture et `exec` seuls, sortie en direct et lecture des fichiers d'une tâche comprises (rejoués en CI sur trois plateformes) |
| `npm run test:lock` | ~30 s — instance unique du daemon sous concurrence |
| `npm run test:restart` | ~45 s — redémarrage, reprise WS, sécurité, inactivité |
| `npm run test:ui` | ~1 min — le dashboard dans un vrai navigateur, diff d'une tâche Developer, arbre d'un orchestrateur, atelier (conversation, éditeur, terminal), onglet « Navigateur » et rechargement d'une page plus vieille que son daemon compris (`npx playwright install chromium` au préalable) |
| `npm run test:developer` | ~35 s — le Developer dans un vrai daemon, face à un faux fournisseur ; crash et concurrence compris |
| `npm run test:orchestrator` | ~10 s — l'orchestrateur dans un vrai daemon : délégation parallèle, approbation d'un enfant, cascade, `SIGKILL`, conversation qui pilote une revue, `SIGKILL` pendant une attente |
| `npm run test:security` | ~10 s — PLAN §8.4 de bout en bout : base et journal lus octet pour octet (conversation, questions, propositions et sortie en direct comprises), refus tracés, API sur la seule boucle locale ; le navigateur : saisie sans approbation, adresses privées, aucun Chromium après `SIGKILL`, aucune capture en base (`npx playwright install chromium` au préalable) |
| `npm run test:live-vision` | Payant, opt-in — une image envoyée à un modèle Venice qui la lit, coût relevé |
| `npm run test:wait` | ~3 min — 13 scénarios de bout en bout MCP |

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
  paquet `@midgaard/daemon` + version (décision de la Slice 4, étape 6) : deux
  clones sur un même `~/.midgaard` sont deux installations.
- **Une commande conseillée à l'utilisateur passe par `harnessCommand`**
  (`contracts`), que la CLI emploie par `cmd()`, le daemon par `keyCommand` et
  le serveur MCP par `approvalCommand` : Midgaard ne s'installe que depuis un
  clone, aucun binaire `harness` n'est dans le `PATH`. Lue **hors du clone**
  (consigne relayée, erreur au dashboard), elle porte `npm --prefix "<clone>"`,
  jamais `cd … &&` — un client qui reformule perd le `cd`. Elle redit
  `--home "<runtime>"`, **avant** la commande, dès que le dossier runtime est
  désigné (`homeIsExplicit`) : sans lui, elle visait `~/.midgaard`, donc une
  autre installation (Slice 4, étape 8). Un `harness …` écrit en dur est un
  conseil que personne ne peut lancer — `status` en affichait un.
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
  `exec`, c'est la commande écrite par le modèle. Le résultat d'une sous-tâche
  l'est aussi. Et **le résultat d'une tâche qui a reçu un contenu encadré est
  `untrusted`**, cité ou non (Slice 5).
- **La sortie en direct se découpe par ligne avant l'expurgation** (Slice 6,
  `agent-runtime/src/output.ts`). Les morceaux d'un tube se coupent n'importe
  où : expurgée morceau par morceau, une clé coupée en deux passerait en clair
  — le test l'a vu échouer ainsi. Le décodage UTF-8 se fait par flux, pour la
  même raison.
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
- **La coque desktop n'accorde aucune capacité Tauri à la page** et charge
  l'origine que le daemon accepte déjà (`http://127.0.0.1:<port>/`) :
  `security.ts` ne change pas. Elle ne navigue que sur cette origine, et
  refuse une adresse de `daemon.json` hors de la boucle locale (Slice 6).
- **Le navigateur des agents passe tout par le proxy gardé**
  (`packages/browser`, Slice 7), qui se connecte à l'adresse qu'il a jugée,
  jamais au nom. Le drapeau `--proxy-bypass-list=<-loopback>` reste : sans
  lui, la variable `PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK`
  héritée par le daemon rouvrait `127.0.0.1` à une page — vu. Chromium est
  confié à la garde d'`exec` et tué par groupe à la fermeture.
- **Le terminal du dashboard ne laisse passer que les couleurs**
  (`apps/dashboard/src/lib/terminal.ts`, Slice 6). La sortie vient de
  commandes lancées dans un arbre écrit par l'agent ; une séquence qui efface,
  déplace le curseur ou réinitialise (`ESC c`) ferait voir à l'humain autre
  chose que ce qui s'est passé, au moment où il approuve.
- **Les fichiers d'une tâche se lisent sans jamais toucher `.git`**
  (`daemon/src/files.ts`, Slice 6) : la règle vaut pour le chemin demandé
  **et** pour le chemin réel — un lien posé dans le worktree vers `.git`
  reste sous la racine, et passait sans cette relecture. Ces routes n'ont
  aucune méthode d'écriture.
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
  affiché. Le détail est expurgé avant d'être persisté. Ce qui a été approuvé se
  revérifie au moment d'agir : un binaire `exec`, la page et le champ d'une
  saisie au navigateur (Slice 7).
- **Une phrase de documentation est une affirmation à prouver.** À l'étape 3,
  « binaire résolu avant la demande » a été écrit sans être vrai, et le test du
  même sujet vérifiait le défaut (docs/SLICE3.md, leçon n° 10).
- **La branche ne bouge qu'à l'acceptation.** Le harness commite le travail
  d'une tâche **aboutie**, et seulement elle : une tâche qui échoue laisse sa
  branche au commit de départ, son travail lisible dans le worktree, jamais une
  branche qui a l'air d'un résultat. Le worktree est conservé dans tous les cas.
  Pour un Developer délégué par Claude, accepter et `submit_result` ne font
  qu'un ; délégué par un orchestrateur (`review`), son `submit_result` est une
  **proposition**, commitée seulement quand l'orchestrateur l'accepte
  (`accept_result`, Slice 6). Ce n'est pas une approbation : rien n'est mergé,
  et le merge reste humain.
- **Une liste blanche `exec` se range sous la racine canonique du dépôt**, d'où
  que la CLI soit lancée : rangée ailleurs, elle aurait l'air de marcher et ne
  servirait jamais. Le moteur la lit au départ de la tâche, jamais en route.
- **Les commits d'agent ne portent ni l'identité ni la signature de
  l'utilisateur** : `Midgaard <agent> <agent@midgaard.invalid>`, `--no-gpg-sign`.
- **Le diff se calcule contre `base_commit`, jamais contre une branche**, et
  inclut les fichiers nouveaux (index temporaire, celui de l'agent intact).
- **`parent_task_id` n'est posé que par le daemon** (`TaskManager.create`,
  appelé par le port de délégation) : aucune route ne l'accepte, sans quoi un
  client rattacherait une tâche à un arbre qui n'est pas le sien (Slice 5).
- **`mode` n'est posé que par le daemon**, comme `parent_task_id` : `oneshot`
  pour tout ce que délègue Claude, `chat` et `review` pour les seules tâches
  du dashboard et de l'orchestrateur (Slice 6). **`awaiting_input` est une
  propriété du statut** `waiting_input` : exigé à l'entrée, refusé ailleurs,
  effacé à la sortie par le dépôt.
- **Un agent créé par un orchestrateur ne dépasse jamais son profil de base
  et n'existe que dans son arbre** (Slice 8) : outils et consigne du profil,
  le rôle ajouté après ; limites, serveurs MCP et modèle refusés avec motif
  au-delà. Ailleurs, il répond comme un profil inconnu. **Le budget de
  l'orchestrateur couvre tout son arbre**, contrôlé avant chaque appel de
  modèle de chaque tâche, premier compris.
- **Aucune sous-tâche ne survit à son parent.** Un parent en
  `cancel_requested` ou dans un statut final emporte ses sous-tâches actives ;
  le vérifier en **comptant les tâches actives en base**. Profondeur 1 : un
  orchestrateur ne délègue jamais à un orchestrateur. Et il **ne conclut pas**
  tant qu'une sous-tâche attend sa réponse ou son verdict (`finishBlocked`) :
  la cascade emporterait son travail non commité.

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
  `node_modules`. Le développement se passe donc de build ; le dashboard servi par le daemon, non
  (`npm run build`).
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

## Slice 8 en cours — des serveurs MCP pour les agents, des agents créés à la volée

Décidée le 2026-11-05 avec l'auteur : l'humain branche un serveur MCP (REA,
`rea-agents`, stdio, d'abord) ; ses outils vont aux **profils qui le
déclarent**, libres s'ils sont **cochés** (empreinte du nom, de la
description et du schéma : un outil changé n'est plus libre), approuvés sur
leurs arguments exacts sinon, leurs résultats toujours encadrés et non
fiables ; et l'orchestrateur **crée ses agents à la volée** (`create_agent`),
sans jamais dépasser le type de base, les limites, les serveurs ni les
modèles que l'humain a ouverts. Décisions et découpage en sept étapes :
[docs/SLICE8.md](docs/SLICE8.md). Étape 1 faite, verte en CI sur trois plateformes
(passage `42002800496`) : le paquet `mcp-client`
(`McpConnection`, `GuardedStdioTransport`, `serverEnv`). **Le transport stdio
du SDK n'est pas employé** : il lance le serveur dans le groupe du daemon et
ne tue que le processus principal, et REA lance Ghidra. Le serveur est chef
de son groupe, confié à la garde avant la poignée de main, tué par groupe à
la fermeture ; le client ne déclare **aucune capacité** (pas de `sampling`,
qui ferait dépenser le modèle de l'agent) ; une progression ne prolonge pas
un appel. Le test du daemon tué net **fige** le serveur et regarde un
petit-enfant, sinon il passerait sans la garde. Étape 2 faite, verte en CI sur trois plateformes (passage `42007433791`) : migration 11
(`mcp_servers`, `mcp_tool_allow`), `PROTOCOL_VERSION` 14, routes `/api/mcp`,
`harness mcp`. **On ne coche que le catalogue constaté**, avec l'empreinte de
ce que l'humain a lu (nom, titre, description, schéma d'entrée, annotations) ;
redéclarer efface le catalogue, et un outil annoncé autrement devient
`changed`, approuvé à chaque appel. Les variables secrètes vont au coffre
(`mcp.<empreinte>.<serveur>.<nom>`). La CLI résout le programme **et rend
absolus les arguments-fichiers** : la vraie CLI a montré que `node
tests/fake-mcp-server.ts`, déclaré tel quel, ne trouvait pas son script.
Étape 3 faite, verte en CI sur trois plateformes (passage `42011901280`) :
un profil porte `mcp_servers` (migration 12,
`PUT /api/agents/:id/mcp`, `PROTOCOL_VERSION` 15 ; jamais l'orchestrateur).
Les outils `<serveur>__<outil>` sont **construits pour chaque tâche**
(`tools/src/mcp.ts`, `LoopInput.extraTools`) ; ses serveurs démarrent **au
départ** (`daemon/src/mcp-sessions.ts`), tout ou rien, et un échec arrête la
tâche avant tout appel de modèle. **L'empreinte se compare au catalogue
annoncé au lancement**, pas à celui enregistré : un test qui redéclare le
serveur ne le prouve pas (le catalogue enregistré est effacé), il faut un
serveur mis à jour sur place. Étape 4 faite, verte en CI sur trois plateformes (passage `42016819429`) :
`create_agent` (orchestrateur
seulement, sans approbation, décision de l'auteur) crée un exécutant **pour
son arbre** (`created_agents`, migration 13), résolu à partir de son profil de
base par `TaskManager.agentFor` — mêmes outils, consigne du profil **puis** le
rôle. **Tout dépassement est refusé avec son motif, jamais réduit en
silence** ; un modèle doit être offert **et tarifé** ; serveurs MCP pris parmi
ceux du profil de base. **Le `max_cost_usd` de l'orchestrateur couvre tout son
arbre** (`treeBudget`), contrôlé dès le premier appel de chaque tâche — le
premier jet l'oubliait. Sous-tâches actives plafonnées
(`MIDGAARD_MAX_ACTIVE_SUBTASKS`, 4).

## Slice 7 terminée — les agents voient

Décidée le 2026-11-03, terminée le 2026-11-05 : lire des images d'abord, puis piloter
un **navigateur isolé** (Chromium jetable lancé par le daemon, jamais le
bureau de l'utilisateur) sous des **sessions approuvées et surveillées**, la
saisie de texte approuvée à chaque fois. Décisions, découpage en huit étapes et
points de vigilance : [docs/SLICE7.md](docs/SLICE7.md). À retenir avant d'y
toucher : **aucune image n'est écrite en base**, la capacité « vision » d'un
modèle est **constatée** au catalogue du fournisseur (sinon déclarée, et dite
comme telle), et une capture d'une page rend la tâche non fiable. Le modèle des
essais de la Slice 6 ne lit pas les images. Étape 1 faite : un message
utilisateur porte des images, les deux adaptateurs les traduisent, la capacité
se lit au catalogue Venice ; constaté contre l'API réelle (`test:live-vision`).
Étape 2 faite : `read_image` (type lu dans les octets, 4 Mo, chemin vérifié),
l'image jointe après tous les résultats de l'étape, la vision décidée par le
catalogue puis la déclaration du profil (migration 10, `PROTOCOL_VERSION` 12).
Étape 3 faite : le paquet `browser`, un Chromium jetable derrière un proxy
gardé (qui se connecte à l'adresse jugée), aucun processus survivant.
Étape 4 faite : huit outils `browser_*` derrière `ToolContext.browser`
(`BrowserPort`, posé par `packages/daemon/src/browsers.ts`). La session et
chaque saisie ou Entrée sont approuvées. **Une saisie approuvée n'est pas
tapée si la page ou le champ ont changé** pendant la décision. Une capture
chasse la précédente de la conversation (`transient`). L'humain coupe par
`POST /api/tasks/:id/browser/close`. Étape 5 faite : le profil `navigator`
(type à lui, `PROTOCOL_VERSION` 13), visible de Claude. **Aveugle, il est
refusé avec son motif** : le gérant retient la vision constatée par le moteur
(démarrage, réglage, départ de tâche), et `GET /api/agents` rend la **vue**
d'un profil (`enabled` utilisable maintenant, `disabled_reason`), pas sa ligne
en base. `tests/unit/navigator.test.ts` l'éprouve dans un vrai daemon,
coupure humaine et Chromium compté compris. Étape 6 faite : l'onglet
« Navigateur » de l'atelier (dernière capture lue dans la mémoire du daemon,
`GET /api/tasks/:id/browser/frame`, approbation au-dessus, « Couper la
session »), l'image lue dans le fil (relue sur le disque, montrée seulement si
son SHA-256 est celui journalisé), la case « lit les images » aux Profils
(D14 dans `test:ui`). Étape 7 faite : X7 à X9 dans `test:security`, verts en CI sur trois plateformes
(saisie et Entrée refusées n'atteignent pas la page, sept écritures d'adresses
privées refusées, aucun Chromium après `SIGKILL` du daemon, aucune capture en
base). Trouvé en chemin : un littéral IPv6 entre crochets était jugé comme un
nom (`assertPublicHost` ôte les crochets), et **Chromium quitte seul à la mort
de son parent** : un test de la garde ne la prouve qu'en figeant Chromium
(`SIGSTOP`) avant. **Un clic n'est jamais approuvé, même s'il envoie un
formulaire** (décision du 2026-11-05) : c'est dit dans la demande de session
que l'humain approuve, et au modèle. Seul le texte tapé par l'agent est
garanti lu par l'humain. Étape 8, l'essai réel : `deepseek-v4-1-flash`
(vision au catalogue Venice) a lu une maquette, puis l'a reproduite dans
TodoMVC sous session approuvée, six saisies et Entrées approuvées une à une,
résultat juste, 0,0086 $ « facturé par le fournisseur », aucune image en base,
aucun Chromium après. Trouvé en chemin : une approbation **expirée** était
inscrite « refusé par un humain » (`cancel(task, 'expired')` désormais). La
fenêtre desktop « figée » de l'essai était **vide** : une page plus vieille que
son daemon, dont l'ancien code a levé une erreur sur des événements inconnus,
et React a tout démonté. **Une page se recharge désormais quand le daemon sert
un autre bundle** (`apps/dashboard/src/lib/bundle.ts`, D15), et une erreur
d'affichage se dit au lieu de laisser une page vide. Après l'essai,
**moins d'approbations, la même garantie** : `browser_type` porte son Entrée
(`press_enter`), et les textes annoncés à l'ouverture (`planned_inputs`) sont
approuvés avec la session, puis tapés **une fois** chacun sans demande s'ils
sont identiques à la lettre. Aucun texte n'entre dans un champ sans que
l'humain l'ait lu ; la saisie libre en session a été écartée. Éprouvé par un
vrai modèle sur le même objectif : il a annoncé ses trois textes de lui-même,
**une** approbation au lieu de sept.

## Slice 6 terminée — un atelier façon VS Code

Démarrée et terminée le 2026-11-03 : chat avec l'orchestrateur, boucle orchestrateur ⇄
Developer dans les deux sens (revue et reprise, questions), fichiers et
terminal en lecture seule et en direct, dans une coque Tauri mince qui charge
le dashboard du daemon. Décisions et découpage en neuf étapes :
[docs/SLICE6.md](docs/SLICE6.md). Étape 1 faite : statut `waiting_input`,
`awaiting_input`, `tasks.mode` (migration 9), quatre événements,
`PROTOCOL_VERSION` 11. Étape 2 faite : le chat, par HTTP
(`POST /api/tasks/:id/messages`) ; l'attente ne consomme pas le délai, un
message n'entre que dans une attente, et l'agent lit la version expurgée.
Étape 3 faite : la boucle entre agents — proposition, `send_message`,
`accept_result`, `ask_parent` ; `wait_for_task` rend la main quand un enfant
attend son parent, avec son diff. Étape 4 faite : la sortie d'`exec` en
direct (`exec.output`), découpée par ligne, expurgée, regroupée, plafonnée.
Étape 5 faite : les fichiers d'une tâche en lecture seule, arbre et contenu,
sur le disque et au commit de départ (`/api/tasks/:id/files`). Étape 6
faite : l'atelier façon VS Code au dashboard — conversation et fil des
agents, explorateur et éditeur (CodeMirror, lecture seule, diff), terminal
(xterm, lecture seule, séquences d'échappement réduites aux couleurs). Étape 7
faite : la coque Tauri (`apps/desktop`), qui ouvre la fenêtre sur
`http://127.0.0.1:<port>/` sans aucune capacité Tauri, et ne navigue que là.
Étape 8 faite : O5 et O6 (`test:orchestrator`), X6 (`test:security`), la coque
compilée et testée en CI sur trois plateformes (`.github/workflows/desktop.yml`).
Étape 9 faite : deux essais réels sur Venice dans la fenêtre — conversation,
question montée jusqu'à l'utilisateur, revue, « Conclure ». Le renvoi d'une
proposition n'a pas tourné contre un vrai modèle (prouvé par O5 seulement) ;
la liste de ce qui reste ouvert est à la fin de `docs/SLICE6.md`. Prochaine :
la Slice 7 — images, puis navigateur isolé (décisions dans `docs/SLICE6.md`).

## Slice 5 terminée — un orchestrateur intégré

Un orchestrateur intégré au daemon, sur n'importe quel modèle, lancé du
dashboard : décisions et découpage en sept étapes dans
[docs/SLICE5.md](docs/SLICE5.md). Démarrée et terminée le 2026-11-01. Étape 1 faite : rien
de ce que lit un modèle ne nomme plus Claude (test « neutralité envers
l'orchestrateur ») — à garder ainsi dans toute nouvelle consigne. Étape 2
faite : migration 8 (`tasks.parent_task_id`, posé par le daemon seul),
`PATCH /api/agents/:id` (fournisseur et modèle, jamais les limites), type
`orchestrator` sans moteur encore, `PROTOCOL_VERSION` 10. Étape 3 faite : les
outils `list_agents`, `delegate_task`, `wait_for_task`, `cancel_task` derrière
`ToolContext.delegation`, la cascade d'annulation et `subtask.waiting`. Étape 4
faite : le profil `orchestrator` (lecture et délégation seulement), invisible
de Claude par MCP ; un résultat est non fiable dès que la tâche a reçu un
contenu encadré, cité ou non. Étape 5 faite : le dashboard lance une tâche
(`#/new`), règle fournisseur et modèle (`#/agents`), montre l'arbre et la
carte « Sous-tâches » ; le daemon vérifie tout `project_dir` (`checkProjectDir`).
Étape 6 faite : `test:orchestrator` (4 scénarios), X5 dans `test:security`,
vertes en CI sur les trois plateformes (passage `41307159340`). Elle a
trouvé un défaut ancien : une annulation pendant la préparation finissait
`failed` (leçon n° 35).

Étape 7, l'essai réel : `deepseek-v4-flash-0731` sur Venice, lancé du
dashboard, a lu `midgaard-demo`, délégué `/version` à un Developer, attendu
l'approbation humaine de `npm test` et rendu une synthèse juste ; la somme des
coûts de l'arbre égale l'écart du solde Venice au microdollar. En chemin, la
clé « saisie sans écho » s'est affichée en clair : une `readline` réaffichait
la frappe (leçon n° 36, `packages/cli/src/secret-input.ts`). Relevé en
lisant la base et réglé : `tasks.started_at` n'était jamais écrit ; le dépôt
le pose désormais à la sortie de la file, comme `ended_at` à l'entrée dans un
statut final.

## Slice 4 terminée — durcissement

Démarrée le 2026-10-30, terminée le 2026-11-01. Décisions (`edit_file`
tolérant aux fins de ligne ; Windows éprouvé en CI seulement) et découpage :
[docs/SLICE4.md](docs/SLICE4.md). Migration 7 (`workspaces.submodules_json`),
`PROTOCOL_VERSION` 9. **Toutes** les suites tournent en CI sur macOS, Linux
et Windows (`.github/workflows/e2e.yml`, passage `41182184282`).

L'essai d'acceptation (étape 8) : depuis un clone GitHub frais, avec les
seules commandes du README et un runtime vierge, un Developer a implémenté
`/health` en vraie session sous approbation, coût **exact** contre le solde
Venice. Il a trouvé un défaut réel : le trousseau macOS se déclarait
disponible sans trousseau par défaut (leçon n° 29). Ses quatre autres
constats sont réglés : référence de clé par installation
(`provider.<empreinte>.<id>`), commandes conseillées sans `cd` et avec
`--home`, tarif caché relevé chez Venice, port de repli signalé et dossier
runtime affiché au dashboard (leçons n° 30 à 33, `docs/SLICE4.md`).

**Pas de distribution** (décision du 2026-11-01, définitive) : le paquet npm et
sa publication (étapes 6 et 7) ont été livrés puis retirés ; Midgaard
s'installe depuis un clone. Ne pas les réintroduire sans demande. Le
guide de dépannage est [docs/DEPANNAGE.md](docs/DEPANNAGE.md) — à tenir à jour
quand un message d'erreur change, il les cite mot pour mot.

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

**Slice 4** (PLAN §7) : durcissement (la distribution npm, prévue, a été
abandonnée). Ce que la Slice 3
lui laisse, au § « Ce qui reste ouvert » de `docs/SLICE3.md` :

- ~~`doctor` migre la base qu'il diagnostique~~ — réglé (Slice 4, étape 1) ;
- ~~`edit_file` dans un dépôt CRLF~~ — réglé (Slice 4, étape 2) ;
- ~~le daemon de bout en bout, le dashboard et la CLI n'ont tourné que sous
  macOS~~ — réglé (Slice 4, étape 5) : en CI sur les trois plateformes ;
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
