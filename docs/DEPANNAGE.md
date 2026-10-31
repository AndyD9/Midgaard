# Dépannage

**Commence toujours par `harness doctor`** (depuis un clone : `npm run doctor`).
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
commandes sont écrites pour le paquet installé (`harness …`) ; depuis un clone,
c'est `npm run harness -- …`, et `doctor` donne d'office la bonne forme.

---

## Claude Code et le serveur MCP

### Les outils `harness_*` n'apparaissent pas dans Claude Code

Claude Code ne relit `.mcp.json` **qu'à l'ouverture d'une session**. Après
`harness init`, ouvre une **nouvelle** session sur ce dossier et accepte le
serveur `midgaard` quand il est proposé. La déclaration est propre au dossier :
une session ouverte ailleurs ne la voit pas.

### `doctor` : « pointe vers des chemins qui n'existent plus »

`init` écrit des **chemins absolus** — celui de `node` et celui du serveur MCP —
parce que l'app desktop de Claude Code ne lance pas les serveurs avec le `PATH`
d'un terminal. Un changement de version de Node (nvm, Homebrew), une
réinstallation du paquet ailleurs ou un dépôt déplacé les rendent faux, et
Claude Code échoue alors sans rien dire d'utile. Relance :

```bash
harness init
```

« pointe vers une autre installation » dit la même chose en moins grave : la
déclaration désigne un autre Midgaard (un clone, une autre version) que celui
qui répond à `harness`.

### `harness init` : « … existe mais n'est pas du JSON valide »

`init` ne réécrit pas un `.mcp.json` qu'il ne sait pas lire, pour ne pas perdre
les autres serveurs qui y sont déclarés. Corrige le fichier ou supprime-le, puis
relance `harness init`.

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
change alors d'adresse. `harness start` et `harness status` disent laquelle.

Si `MIDGAARD_PORT` est fixé, il n'y a **pas** de repli : un port occupé
empêche le démarrage. Libère le port, ou retire la variable.

### Le dashboard répond `403` ou `401`

Le daemon refuse tout `Host` autre que `127.0.0.1:port` ou `localhost:port`,
toute `Origin` étrangère, et toute requête intersite — c'est ce qui empêche une
page web quelconque de piloter ton harness. Les réponses `forbidden_host`,
`forbidden_origin` et `forbidden_fetch_site` viennent de là. Ouvre exactement
l'adresse que donne `harness start`, sans proxy ni autre nom d'hôte.

`401 unauthorized` : le jeton du daemon a changé (redémarrage). Recharge la page.

### `doctor` : « d'une autre installation » ou « d'une autre version »

Un clone et une installation npm partagent `~/.midgaard`, donc un seul daemon.
Un daemon **d'un autre protocole** est remplacé au prochain appel. Un daemon
**d'une autre installation** (autre dossier ou autre version) est remplacé
**s'il est oisif** ; s'il a une tâche en cours, il la termine et reste servi tel
quel jusque-là. Pour le remplacer tout de suite :

```bash
harness stop
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
  `harness start`.
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
  `security help` répond, et que la session a un trousseau déverrouillé.
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
configuré pour ce profil »), ou son fournisseur a été retiré. `harness agents`
dit pourquoi chaque profil est désactivé. Déclare un fournisseur :

```bash
harness providers add venice --model deepseek-v4-flash-0731
```

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

### « tarif inconnu pour « … » : le budget en dollars ne peut pas être appliqué »

Sans tarif, seul le nombre d'étapes borne la tâche, et le coût s'affiche
« inconnu » — jamais `0 $`. Les tarifs livrés ne couvrent que Venice ; pour
Venice, relève-les :

```bash
harness pricing refresh venice
```

### `timed_out` : « aucune décision humaine en 10 minutes »

Une demande d'approbation expire au bout de 10 minutes
(`MIDGAARD_APPROVAL_TTL_S`), et la tâche s'arrête plutôt que d'attendre
indéfiniment. Une approbation arrivée après : `approval_already_resolved`.

### `harness approve` ne fait rien

- « Aucune demande d'approbation en attente. » — elle a été décidée, ou a expiré.
- « Plusieurs demandes attendent, précise laquelle : » — chaque ligne qui suit
  est une commande complète, prête à copier. L'identifiant attendu est celui
  de la **demande**, pas celui de la tâche.

---

## Le `developer` et les worktrees

### `failed` : « worktree impossible : … »

- « … n'est pas dans un dépôt Git » : le `developer` ne travaille que dans un
  dépôt Git. `git init`, puis un premier commit.
- « le dépôt n'a encore aucun commit » : un premier commit suffit.
- « git est introuvable dans le PATH du daemon » : installe Git (2.17 ou plus),
  puis `harness stop` pour que le daemon relancé le trouve.

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
worktree, que `harness workspaces` désigne. Et le harness **ne merge jamais** :
`git merge` est ta décision.

### `harness exec allow` : « pas de terminal pour confirmer »

Une commande ajoutée à la liste blanche ne sera plus jamais montrée à un
humain dans ce dépôt ; la CLI demande donc une confirmation, et refuse sans
terminal. `--yes` passe outre, en connaissance de cause.

---

## Les plateformes

- **Windows** : `write_file` écrit le fichier tel que le modèle le donne ; sur
  un fichier en fins de ligne CRLF, un modèle qui le réécrit en `\n` change
  toutes ses lignes dans le diff. `edit_file`, lui, respecte les fins de ligne
  du fichier.
- **Windows et Linux** : éprouvés en CI seulement, face à un faux fournisseur.
  Une panne qui ne se voit que là mérite un ticket sur
  [GitHub](https://github.com/AndyD9/Midgaard/issues), avec la sortie de
  `harness doctor` et la fin de `daemon.log`.

---

## Les variables d'environnement

Elles sont lues **au démarrage** de chaque processus. Le daemon hérite de
l'environnement de celui qui le lance — le serveur MCP ou la CLI : une variable
changée sous un daemon déjà lancé n'a d'effet qu'après `harness stop`.

| Variable | Effet | Défaut |
|---|---|---|
| `MIDGAARD_HOME` | Dossier runtime : base, journal, jeton, worktrees | `~/.midgaard` |
| `MIDGAARD_PORT` | Port d'écoute sur `127.0.0.1` ; fixé, il interdit le repli | `7777`, repli sur un port libre |
| `MIDGAARD_IDLE_SHUTDOWN_S` | Arrêt après inactivité ; `0` le désactive | `1800` |
| `MIDGAARD_APPROVAL_TTL_S` | Validité d'une demande d'approbation | `600` |
| `MIDGAARD_VAULT` | Impose un coffre : `macos-keychain`, `windows-dpapi`, `libsecret`, `file` | détection, puis repli fichier |
| `MIDGAARD_HTTP_POLICY` | `http_fetch` : `open`, `approval` ou `allowlist` — les adresses privées restent refusées dans tous les cas | `open` |
| `MIDGAARD_HTTP_ALLOW` | Hôtes toujours admis, séparés par des virgules (`exemple.org`, `*.exemple.org`) | aucun |
| `MIDGAARD_EXEC_ALLOW` | Commandes exactes lancées sans approbation, séparées par `;` | aucune |
| `MIDGAARD_DASHBOARD_DIR` | Dossier du dashboard compilé | celui du paquet |
