# Dépannage

**Commence toujours par `npm run doctor`**, à la racine du clone.
Il examine Node, le dossier runtime, la base — sans jamais l'écrire —, le
daemon, la déclaration MCP du dossier courant, le dashboard, le coffre, les
tarifs, les fournisseurs, Git, les worktrees et la liste blanche `exec`, et
donne pour chaque problème la commande qui le corrige. Ses avertissements (`!`)
ne sont pas des échecs ; seuls les `✘` font rendre `1`.

Ensuite, deux fichiers disent presque tout, dans `~/.midgaard` (ou
`MIDGAARD_HOME`) :

| Fichier | Contenu |
|---|---|
| `daemon.log` | Le journal du daemon : démarrage, coffre retenu, port, refus, arrêt |
| `mcp-trace.jsonl` | Ce que le serveur MCP a vu du client : capacités, attentes, coupures |

Les messages cités ci-dessous sont ceux du code, tels qu'ils s'affichent. Les
commandes se lancent à la racine du clone : Midgaard ne s'installe que depuis
le dépôt, et aucun binaire `harness` n'est dans le `PATH`.

---

## Claude Code et le serveur MCP

### Les outils `harness_*` n'apparaissent pas dans Claude Code

Claude Code ne relit `.mcp.json` **qu'à l'ouverture d'une session**. Après
`npm run init`, ouvre une **nouvelle** session sur ce dossier et accepte le
serveur `midgaard` quand il est proposé. La déclaration est propre au dossier :
une session ouverte ailleurs ne la voit pas.

### `doctor` : « pointe vers des chemins qui n'existent plus »

`init` écrit des **chemins absolus** — celui de `node` et celui du serveur MCP —
parce que l'app desktop de Claude Code ne lance pas les serveurs avec le `PATH`
d'un terminal. Un changement de version de Node (nvm, Homebrew) ou un clone
déplacé les rendent faux, et Claude Code échoue alors sans rien dire d'utile.
Relance :

```bash
npm run init
```

« pointe vers une autre installation » dit la même chose en moins grave : la
déclaration désigne un autre Midgaard (un autre clone, une autre version) que
celui où tu lances la commande.

### `npm run init` : « … existe mais n'est pas du JSON valide »

`init` ne réécrit pas un `.mcp.json` qu'il ne sait pas lire, pour ne pas perdre
les autres serveurs qui y sont déclarés. Corrige le fichier ou supprime-le, puis
relance `npm run init`.

### « le daemon n'a pas démarré en 8000 ms (voir …/daemon.log) »

Le serveur MCP (ou la CLI) a lancé le daemon, qui est mort avant de répondre. La
cause est **dans `daemon.log`**, presque toujours l'une de celles-ci :

- **un port imposé déjà pris** — voir « Port 7777 occupé » plus bas ;
- **`MIDGAARD_VAULT` inconnu ou indisponible** — voir « Le coffre » ;
- **une base plus récente que ce code** — voir « La base ».

### L'agent lit le mauvais dossier

Le dossier qu'un agent a le droit de lire est celui que **Claude Code** annonce
au serveur MCP (capacité `roots`). Si le client ne l'annonce pas, le serveur se
rabat sur son dossier de travail, et l'écrit sur sa sortie d'erreur :
« roots/list indisponible, repli sur le dossier de travail ». Ouvre la session
Claude Code **sur le dossier du projet** lui-même.

### « Delegation refused (invalid_project_dir) » ou refus du formulaire « Nouvelle tâche »

Le daemon vérifie le dossier qu'un agent aura le droit de lire, d'où que vienne
la tâche (Slice 5). Les motifs, mot pour mot :

- « le dossier de projet doit être un chemin absolu : « … » » ;
- « le dossier de projet n'existe pas : « … » » ;
- « le dossier de projet n'est pas un dossier : « … » » ;
- « la racine du système ne peut pas être un dossier de projet : choisis le
  dossier du dépôt » ;
- « le dossier personnel ne peut pas être un dossier de projet : un agent y
  lirait tout. Choisis le dossier du dépôt ».

Les deux derniers frappent aussi une session Claude Code ouverte sur `~` ou
sur `/` : ouvre-la **sur le dossier du dépôt**. Au dashboard, saisis le chemin
absolu du dépôt. Le profil `simulated`, qui ne lit rien, n'est pas concerné.

### Une attente est coupée, ou rend la main sans résultat

Un client MCP coupe un appel d'outil resté 60 s sans signe de vie. Midgaard
attend donc par tranches de 15 s, avec une notification de progression entre
chacune, et `harness_wait_for_task` ne dépasse pas 600 s par appel : c'est
normal que Claude l'appelle plusieurs fois. « Wait interrupted by the client.
The task keeps running. » veut dire ce qu'il dit : la tâche continue, il suffit
d'attendre de nouveau.

Une pause d'approbation n'est annoncée **qu'une fois** à chaque client ; les
attentes suivantes bloquent jusqu'à ta décision.

---

## Le daemon

### Port 7777 occupé

Sans réglage, le daemon se rabat sur un port libre et l'écrit dans
`daemon.log` (« port 7777 occupé, repli sur un port libre ») : le dashboard
change alors d'adresse. `npm run harness -- start` et `npm run harness -- status` disent laquelle.

Si `MIDGAARD_PORT` est fixé, il n'y a **pas** de repli : un port occupé
empêche le démarrage. Libère le port, ou retire la variable.

### Le dashboard répond `403` ou `401`

Le daemon refuse tout `Host` autre que `127.0.0.1:port` ou `localhost:port`,
toute `Origin` étrangère, et toute requête intersite — c'est ce qui empêche une
page web quelconque de piloter ton harness. Les réponses `forbidden_host`,
`forbidden_origin` et `forbidden_fetch_site` viennent de là. Ouvre exactement
l'adresse que donne `npm run harness -- start`, sans proxy ni autre nom d'hôte.

`401 unauthorized` : le jeton du daemon a changé (redémarrage). Recharge la page.

### `doctor` : « d'une autre installation » ou « d'une autre version »

Un clone et une installation npm partagent `~/.midgaard`, donc un seul daemon.
Un daemon **d'un autre protocole** est remplacé au prochain appel. Un daemon
**d'une autre installation** (autre dossier ou autre version) est remplacé
**s'il est oisif** ; s'il a une tâche en cours, il la termine et reste servi tel
quel jusque-là. Pour le remplacer tout de suite :

```bash
npm run harness -- stop
```

### Le daemon s'arrête tout seul

Après 30 minutes sans tâche active, sans dashboard ouvert et sans requête
(« arrêt (inactif depuis N min) » au journal). Le prochain appel MCP ou la
prochaine commande le relance. `MIDGAARD_IDLE_SHUTDOWN_S=0` désactive l'arrêt.

### « un autre daemon détient le verrou, sortie »

Normal : un seul daemon par dossier runtime, et le second lancé s'efface. Après
un arrêt brutal, le suivant récupère le verrou (« verrou périmé (pid N),
récupération »). Si `doctor` signale un pid **vivant mais injoignable**, il
donne la commande `kill` exacte.

### Des tâches sont `interrupted`

Toute tâche trouvée en cours au démarrage du daemon devient `interrupted`
(« tâche interrompue par un redémarrage du daemon ») : elle n'est **jamais**
reprise ni considérée réussie, et ses approbations expirent. Son worktree est
conservé. Délègue-la de nouveau.

### La base

- `doctor` : « à migrer (rien n'a été écrit) » — la base vient d'une version
  plus ancienne. Le daemon de cette version la migrera à son démarrage :
  `npm run harness -- start`.
- « base en version de schéma X, ce code en connaît Y » — la base vient d'une
  version **plus récente** de Midgaard. Mets Midgaard à jour, ou désigne une
  autre base avec `MIDGAARD_HOME`.

---

## Le coffre et les fournisseurs

### `doctor` : coffre « fichier », pas de protection système

Aucun coffre système n'a répondu, et les clés iront **en clair** sous
`~/.midgaard/secrets`. Le conseil de `doctor` dépend de la plateforme :

- **Linux** : installe libsecret (`secret-tool`) et ouvre une session de
  bureau. Sans bus de session (`DBUS_SESSION_BUS_ADDRESS` absent : session SSH,
  conteneur), libsecret est écarté. Sur un serveur sans trousseau, il n'y a
  rien à installer : le repli fichier est la bonne réponse.
- **macOS** : le trousseau est livré avec le système ; vérifie que
  `security default-keychain` nomme un trousseau. Un `HOME` qui n'est pas
  celui de ta session (`HOME=… npm run …`) n'en a pas : macOS le cherche sous
  `~/Library/Keychains`, et Midgaard se rabat alors sur le fichier plutôt que
  de rester bloqué derrière une fenêtre « aucun trousseau trouvé ».
- **Windows** : DPAPI passe par `powershell.exe` — Windows PowerShell 5.1,
  livré avec le système —, qui doit être dans le `PATH` ; `pwsh` seul ne
  suffit pas.

Si tu poses toi-même `MIDGAARD_VAULT=file`, `doctor` le dit comme un choix, pas
comme une panne.

### « MIDGAARD_VAULT=… inconnu » ou « … indisponible sur cette machine »

Un coffre imposé n'est jamais remplacé en silence : le daemon refuse de
démarrer. Valeurs possibles : `macos-keychain`, `windows-dpapi`, `libsecret`,
`file`. Retire la variable pour laisser Midgaard choisir.

### « … n'a pas rendu la main en N s et a été tué »

L'outil du coffre (`security`, `secret-tool`, PowerShell) est resté bloqué — le
plus souvent un trousseau verrouillé qui attend un mot de passe. Déverrouille-le
et recommence.

### « Delegation refused (agent_disabled) »

Le profil demandé n'a pas de fournisseur (« aucun fournisseur de modèle n'est
configuré pour ce profil »), ou son fournisseur a été retiré. `npm run harness -- agents`
dit pourquoi chaque profil est désactivé. Déclare un fournisseur :

```bash
npm run harness -- providers add venice --model deepseek-v4-flash-0731
```

### « Delegation refused (agent_disabled) » pour le `navigator`

Le Navigator voit le navigateur par des captures : son modèle doit lire les
images (Slice 7). Le motif dit d'où vient le constat :

- « le modèle « … » ne lit pas les images, d'après le catalogue de son
  fournisseur » : choisir un modèle qui les lit dans « Profils » (chez Venice,
  `mistral-small-3-2-24b-instruct` par exemple) ;
- « rien ne dit que le modèle « … » lit les images : son fournisseur ne le
  publie pas » : si le modèle les lit, le déclarer sur le profil,
  `PATCH /api/agents/navigator` avec le corps `{"vision": true}` ;
- « le modèle « … » est déclaré ne pas lire les images » : la déclaration le
  dit ; changer de modèle, ou corriger la déclaration.

Le daemon constate la capacité au démarrage et à chaque réglage d'un profil ;
une tâche lancée avant le constat s'arrête en `failed` avec le même motif,
avant tout appel de modèle, sans rien coûter.

### « aucune clé d'API pour « … » »

Le fournisseur est déclaré, mais sa clé n'est plus dans le coffre (trousseau
réinitialisé, autre machine). Le message donne la commande complète qui la
redépose. En dépannage seulement, le daemon lit aussi la clé dans une variable
d'environnement (`VENICE_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
`MIDGAARD_PROVIDER_API_KEY` pour `custom`), à condition qu'elle soit dans
l'environnement **du daemon** : arrête-le, puis relance-le depuis ce terminal.

### Le test de connexion échoue

- « clé refusée par le fournisseur (401) » : la clé est fausse ou révoquée.
- Joignable, mais « … n'en fait pas partie » : l'endpoint ne propose pas le
  modèle choisi ; vérifie l'identifiant passé à `--model`.
- En pleine tâche, « appel modèle refusé : HTTP 401 » : même cause. Les erreurs
  400, 401 et 403 ne sont pas retentées ; 408, 409, 429 et 5xx le sont.

---

## Les tâches et les coûts

### `budget_exceeded`

« budget de X $ atteint » : un plafond a été atteint, **rien n'a échoué**. Le
budget d'un profil est un plafond : une délégation peut l'abaisser, jamais le
relever.

### `failed` : « limite de N étapes atteinte sans résultat soumis »

L'agent n'a pas conclu à temps. Une tâche ne se termine que par
`submit_result` : un modèle qui écrit « j'ai fini » n'a pas fini. Relève
`max_steps` jusqu'au plafond du profil, ou — le plus souvent — **simplifie
l'objectif** : un objectif qui appelle une réponse longue fait couper la sortie
du modèle avant qu'il ait pu conclure. Une tâche qui échoue a déjà dépensé.

### `budget_exceeded` : « budget de l'arbre de tâches, … $, atteint »

Le budget de l'orchestrateur couvre **tout son arbre** : ses appels et ceux de
chaque sous-tâche (Slice 8). Une sous-tâche s'arrête dès que sa dépense plus
celle des autres l'atteint, et l'orchestrateur ne peut plus déléguer. Pour un
arbre plus large, relève le `max_cost_usd` du profil `orchestrator`.

### « … subtask(s) are already running, the maximum at the same time »

L'orchestrateur a déjà autant de sous-tâches actives que le plafond le
permet ; il doit en attendre ou en annuler une. Le plafond se règle par
`MIDGAARD_MAX_ACTIVE_SUBTASKS` (4 par défaut), dans l'environnement du daemon,
puis `npm run harness -- stop`.

### « tarif inconnu pour « … » : le budget en dollars ne peut pas être appliqué »

Sans tarif, seul le nombre d'étapes borne la tâche, et le coût s'affiche
« inconnu » — jamais `0 $`. Les tarifs livrés ne couvrent que Venice ; pour
Venice, relève-les :

```bash
npm run harness -- pricing refresh venice
```

### Le dashboard ne montre pas la demande d'approbation

Deux installations ont chacune leur daemon, et le premier lancé tient le port
7777. L'en-tête du dashboard affiche le dossier runtime du daemon qu'il sert :
s'il n'est pas celui de la tâche, ouvre l'URL donnée par la consigne
d'approbation. `npm run harness -- status` le dit aussi : « port 7777 occupé —
sans doute le daemon d'une autre installation, dont le dashboard n'est pas
celui-ci : ce daemon écoute sur … ».

### `timed_out` : « aucune décision humaine en 10 minutes »

Une demande d'approbation expire au bout de 10 minutes
(`MIDGAARD_APPROVAL_TTL_S`), et la tâche s'arrête plutôt que d'attendre
indéfiniment. Une approbation arrivée après : `approval_already_resolved`.

### `timed_out` : « aucune réponse de l'utilisateur en 120 minutes »

Une conversation avec l'orchestrateur attend votre réponse au plus deux heures
(`MIDGAARD_INPUT_TTL_S`), puis s'arrête : oubliée, elle garderait le daemon en
vie, et l'orchestrateur ses sous-tâches. Ce qu'elle avait produit reste dans
sa timeline ; ouvrez une nouvelle conversation pour reprendre.

### `task_not_awaiting_user` en écrivant à une conversation

Le message n'est accepté que lorsque la conversation **attend** votre
réponse (`waiting_input`). Pendant que l'orchestrateur travaille, ou une fois
la tâche finie, il est refusé sans rien écrire. Attendez sa réplique, puis
écrivez.

### `npm run harness -- approve` ne fait rien

- « Aucune demande d'approbation en attente. » — elle a été décidée, ou a expiré.
  Ou bien la commande vise un autre dossier runtime : celle de la consigne
  porte `--home "…"` quand le daemon n'est pas sur `~/.midgaard`, et se lance
  telle quelle, d'où qu'on soit.
- « Plusieurs demandes attendent, précise laquelle : » — chaque ligne qui suit
  est une commande complète, prête à copier. L'identifiant attendu est celui
  de la **demande**, pas celui de la tâche.

---

### « read_image retiré : … » dans la timeline

Le modèle du profil ne lit pas les images, ou rien ne dit qu'il les lit. Le
motif cité dit lequel :

- « cannot read images (catalogue of provider … » : le fournisseur publie que
  ce modèle ne lit pas les images. Choisir un modèle qui les lit dans
  « Profils » (chez Venice, `mistral-small-3-2-24b-instruct` par exemple) ;
- « does not say whether model … reads images, and this profile does not
  declare it » : le fournisseur ne publie pas la capacité (OpenAI, endpoint
  `custom`). Si le modèle lit les images, le déclarer sur le profil, par
  l'API du daemon — pour le Researcher, `PATCH /api/agents/researcher` avec le
  corps `{"vision": true}`. Le dashboard n'a pas encore de case pour cela
  (Slice 7, étape 6). La déclaration tombe quand le modèle change.

## Le `developer` et les worktrees

### `failed` : « worktree impossible : … »

- « … n'est pas dans un dépôt Git » : le `developer` ne travaille que dans un
  dépôt Git. `git init`, puis un premier commit.
- « le dépôt n'a encore aucun commit » : un premier commit suffit.
- « git est introuvable dans le PATH du daemon » : installe Git (2.17 ou plus),
  puis `npm run harness -- stop` pour que le daemon relancé le trouve.

### Mes modifications en cours ne sont pas dans le worktree

Le worktree part du **dernier commit**. Le résultat le signale (« … uncommitted
change(s) that were NOT in the agent's worktree ») : commite avant de déléguer
si l'agent doit les voir.

### Écriture refusée dans un sous-module

Un sous-module est un dossier **vide** dans le worktree, et ce qu'on y
écrirait serait ignoré au commit : l'écriture y est refusée, et le résultat le
dit. Une commande `exec` peut encore y écrire, et ce travail sera perdu.

### La branche `midgaard/…` ne contient rien

Le harness ne commite que le travail d'une tâche **aboutie**. Une tâche qui
échoue laisse sa branche au commit de départ — son travail reste lisible dans le
worktree, que `npm run harness -- workspaces` désigne. Et le harness **ne merge jamais** :
`git merge` est ta décision.

### `npm run harness -- exec allow` : « pas de terminal pour confirmer »

Une commande ajoutée à la liste blanche ne sera plus jamais montrée à un
humain dans ce dépôt ; la CLI demande donc une confirmation, et refuse sans
terminal. `--yes` passe outre, en connaissance de cause.

---

## Les serveurs MCP des agents

### `npm run harness -- mcp add` : « programme introuvable ou non exécutable »

Le programme est cherché dans le `PATH` **du terminal**, puis déclaré par son
chemin absolu. Les entrées relatives du `PATH` (`.`) sont ignorées. Donner le
chemin complet, par exemple `-- /opt/homebrew/bin/node /chemin/vers/rea/scripts/rea.mjs mcp`.

### « invalid_command » : « le programme doit être un chemin absolu »

Le daemon ne lance qu'un programme déclaré par son chemin absolu, et revérifie
à chaque lancement qu'il existe et s'exécute. Sous Windows, un `.cmd` ou un
`.bat` est refusé (« ne se lance pas sans shell ») : déclarer `node.exe` et le
script `.js` ou `.mjs`, comme REA le recommande pour une déclaration manuelle.

### Le test dit « ne répond pas » : « did not complete the MCP handshake »

Le programme s'est lancé mais n'a pas terminé `initialize` dans les 30 s. La
fin du message cite le début et la fin de sa sortie d'erreur, expurgés :
module introuvable (un chemin relatif dans les arguments, que `mcp add` rend
pourtant absolu s'il existe), Java absent pour Ghidra, ou un programme qui
n'est pas un serveur MCP. Le serveur tourne dans le dossier runtime au moment
du test, pas dans ton terminal.

### Un outil coché est « changé »

Le serveur l'annonce autrement qu'au moment où tu l'as coché : description,
schéma ou annotations — le plus souvent une mise à jour du serveur. Il est
**approuvé à chaque appel** jusqu'à ce que tu le relises
(`npm run harness -- mcp tools rea`) et le recoches (`npm run harness -- mcp allow rea nom_de_l_outil`).

### « no_catalog » en cochant un outil

Aucun catalogue n'a encore été lu, ou la déclaration a changé depuis : on ne
coche que ce que le serveur a annoncé. `npm run harness -- mcp test rea` le lit.

### `failed` : « le serveur MCP « … » n'a pas démarré »

Les serveurs MCP d'un profil se lancent au départ de chaque tâche, dans le
dossier du projet. Un seul qui ne démarre pas, et la tâche s'arrête **avant**
tout appel de modèle — rien n'a été dépensé. La suite du message est celle du
test de connexion : `npm run harness -- mcp test rea` la reproduit, hors tâche.

### « agent_cannot_use_mcp » en donnant un serveur à un profil

L'orchestrateur n'appelle aucun outil MCP : il délègue à un profil qui en a.
Donne le serveur au `researcher` ou au `developer`
(`npm run harness -- mcp attach rea researcher`) ; l'orchestrateur le voit dans
`list_agents`.

### Un outil MCP coché demande quand même une approbation

Le serveur l'annonce, **au départ de la tâche**, autrement qu'au moment où tu
l'as coché — une mise à jour sur place suffit, sans que rien d'autre change. La
timeline le dit (« coché(s) mais annoncé(s) autrement »). Relire le catalogue,
puis recocher : `npm run harness -- mcp test rea`, `npm run harness -- mcp tools rea`.

### `npm run harness -- mcp allow` : « pas de terminal pour confirmer »

Comme `exec allow` : un outil coché ne sera plus montré à un humain. La CLI
demande confirmation, et refuse sans terminal. `--yes` passe outre, en
connaissance de cause.

---

## La fenêtre desktop

### « La coque desktop n'est pas construite »

`npm run desktop` ouvre une fenêtre construite depuis le clone. Une fois, et
après chaque mise à jour du clone :

```bash
npm run desktop:build
```

Il faut Rust (`cargo`) ; `npm run doctor` dit s'il est là. Sans lui, le même
dashboard s'ouvre dans un navigateur, à l'adresse que donne
`npm run harness -- start`.

### « midgaard : impossible de lancer … » ou la fenêtre ne s'ouvre pas d'un double-clic

Le build a gravé dans la coque le chemin du `node` de npm. Une mise à jour de
Node (Homebrew en change le dossier) le rend caduc. Reconstruire :
`npm run desktop:build`. Lancée par `npm run desktop`, la coque reçoit le
`node` courant et n'est pas concernée.

### « adresse du dashboard refusée, hors de la boucle locale »

La coque n'ouvre que `http://127.0.0.1:<port>/` ou `http://localhost:<port>/`.
Le fichier `daemon.json` du dossier runtime en annonce une autre : il a été
modifié à la main, ou n'est pas celui d'un daemon Midgaard. Arrêter le daemon
(`npm run harness -- stop`), qui le réécrit au prochain démarrage.

## Les plateformes

- **Windows** : `write_file` écrit le fichier tel que le modèle le donne ; sur
  un fichier en fins de ligne CRLF, un modèle qui le réécrit en `\n` change
  toutes ses lignes dans le diff. `edit_file`, lui, respecte les fins de ligne
  du fichier.
- **Windows et Linux** : éprouvés en CI seulement, face à un faux fournisseur.
  Une panne qui ne se voit que là mérite un ticket sur
  [GitHub](https://github.com/AndyD9/Midgaard/issues), avec la sortie de
  `npm run doctor` et la fin de `daemon.log`.

---

## Les variables d'environnement

Elles sont lues **au démarrage** de chaque processus. Le daemon hérite de
l'environnement de celui qui le lance — le serveur MCP ou la CLI : une variable
changée sous un daemon déjà lancé n'a d'effet qu'après `npm run harness -- stop`.

| Variable | Effet | Défaut |
|---|---|---|
| `MIDGAARD_HOME` | Dossier runtime : base, journal, jeton, worktrees ; pour la CLI, `--home <dossier>` avant la commande fait de même | `~/.midgaard` |
| `MIDGAARD_PORT` | Port d'écoute sur `127.0.0.1` ; fixé, il interdit le repli | `7777`, repli sur un port libre |
| `MIDGAARD_IDLE_SHUTDOWN_S` | Arrêt après inactivité ; `0` le désactive | `1800` |
| `MIDGAARD_APPROVAL_TTL_S` | Validité d'une demande d'approbation | `600` |
| `MIDGAARD_INPUT_TTL_S` | Attente maximale de votre réponse dans une conversation | `7200` |
| `MIDGAARD_VAULT` | Impose un coffre : `macos-keychain`, `windows-dpapi`, `libsecret`, `file` | détection, puis repli fichier |
| `MIDGAARD_HTTP_POLICY` | `http_fetch` : `open`, `approval` ou `allowlist` — les adresses privées restent refusées dans tous les cas | `open` |
| `MIDGAARD_HTTP_ALLOW` | Hôtes toujours admis, séparés par des virgules (`exemple.org`, `*.exemple.org`) | aucun |
| `MIDGAARD_EXEC_ALLOW` | Commandes exactes lancées sans approbation, séparées par `;` | aucune |
| `MIDGAARD_MAX_ACTIVE_SUBTASKS` | Sous-tâches actives d'un orchestrateur en même temps | `4` |
| `MIDGAARD_DASHBOARD_DIR` | Dossier du dashboard compilé | celui du paquet |
