# `@midgaard/cli`

La ligne de commande `harness`. Elle sert à installer, surveiller, dépanner — et
à **décider** : approuver ou refuser une demande d'approbation.

```bash
harness init [dossier]        # déclare le serveur MCP dans le .mcp.json du dossier
harness start                 # démarre le daemon s'il dort
harness stop                  # l'arrête
harness status [--limit N]    # état du daemon et tâches récentes
harness doctor                # diagnostic de l'installation
harness approve [id]          # approuve une demande
harness reject [id] [motif]   # la refuse
harness workspaces            # worktrees des tâches Developer, état sur le disque, orphelins
harness workspaces remove <branche|id> [--force]
harness workspaces clean [--force]
harness exec                  # commandes lancées sans approbation dans ce dépôt
harness exec allow [--yes] [--] <commande…>
harness exec revoke [--] <commande…>
```

Depuis les sources du dépôt, le binaire n'est pas installé : `npm run harness -- status`.
**Chaque commande que la CLI conseille** passe par `cmd()` (`ui.ts`), qui l'écrit
sous la forme que l'utilisateur peut taper : `harness …` depuis le paquet
installé, `npm run harness -- …` depuis les sources. Elles disaient toutes la
seconde, à tout le monde, jusqu'à ce qu'on installe le paquet dans un préfixe
vierge (Slice 4, étape 6). `harness --version` lit la version dans le
`package.json` de la CLI, que l'assemblage du paquet écrit.

## Pourquoi l'approbation est ici et pas dans MCP

Parce que **Claude ne doit pas pouvoir s'auto-approuver**. Aucun outil
d'approbation n'est exposé au modèle ; la décision passe par cette CLI ou par le
dashboard, tous deux pilotés par un humain. C'est l'invariant que la Slice 0 a
posé et que la Slice 1 ne change pas.

Sans identifiant, `approve` et `reject` n'agissent que s'il n'y a **qu'une**
demande en attente. En cas d'ambiguïté, elles affichent une ligne complète par
demande, prête à copier — jamais de `<placeholder>`, que zsh lirait comme une
redirection.

## Worktrees : rien ne part sans qu'on le demande

`workspaces clean` retire les worktrees **propres** des tâches **finies**. Un
worktree avec du travail non commité est laissé, et la commande dit pourquoi —
ce travail, la branche ne le contient pas ; `--force` le perd. Un worktree dont
la tâche tourne n'est jamais retiré. Un dossier orphelin est montré, jamais
supprimé. Et la branche reste **toujours** : `git branch -D` est une décision à
part. La CLI filtre les worktrees sales par politesse ; la vraie garde est le
daemon, qui refuse un retrait non forcé d'un worktree sale.

## `exec allow` : une autorisation durable, donc un avertissement

Une commande en liste blanche ne sera plus jamais montrée à un humain dans ce
dépôt. `exec allow` le dit avant d'ajouter, puis demande confirmation ; **sans
terminal, il refuse** sauf `--yes`. La liste est rangée sous la racine du dépôt,
d'où que la commande soit lancée, et seul l'argv **exact** est concerné.

Ce que cette confirmation n'empêche pas, et qu'il faut savoir : un processus
qui a accès au shell de l'utilisateur — Claude Code avec son outil Bash, par
exemple — peut passer `--yes`, comme il pourrait lancer `harness approve`. La
frontière reste la même qu'à la Slice 0 : les permissions de Claude Code sur le
shell, que l'utilisateur accorde commande par commande.

## `status` fonctionne daemon arrêté

Il lit la base directement. C'est possible parce qu'elle est en WAL : la lecture
ne gêne pas le daemon s'il écrit au même moment. Une tâche d'hier reste donc
consultable sans rien relancer.

## `status` et `doctor` n'écrivent jamais dans la base

Ils l'ouvrent **en lecture seule** (`HarnessStore.openReadOnly`), et c'est SQLite
qui refuse toute écriture. Jusqu'à la Slice 4, `doctor` l'ouvrait comme le
daemon, migrations comprises : il a fait passer la base réelle du schéma 3 au
schéma 6 sous un daemon plus ancien encore en marche (docs/SLICE3.md, leçon
n° 17). Un diagnostic qui change ce qu'il examine ne diagnostique plus.

Sur une base **plus ancienne** que le code, `doctor` avertit « à migrer » et
omet les contrôles qui lisent la base (fournisseurs, worktrees, liste blanche) :
leurs requêtes viseraient des tables qui n'existent pas encore. `status` refuse
d'afficher l'historique et rend `1`. Dans les deux cas, c'est le daemon de cette
version qui migre, à son démarrage. Une base absente n'est jamais créée.

## Ce que `doctor` vérifie

Les six choses qui ont réellement cassé pendant la Slice 0 :

| Contrôle | Ce qu'il attrape |
|---|---|
| Version de Node | `node:sqlite` exige Node 24 sans drapeau expérimental |
| Dossier runtime | Mode `0700` : il contient le jeton du daemon |
| Base | Lue sans être écrite : à jour, à migrer (avertissement), ou plus récente que ce code (échec) |
| Daemon | En marche, injoignable, d'un autre protocole, ou **d'une autre installation** (dossier et version) — et ce que fera le prochain appel MCP |
| Déclaration MCP | Présente **et pointant encore là où il faut** — un dépôt déplacé ou recloné laisse des chemins absolus morts, et Claude Code échoue alors sans rien dire d'utile |
| Dashboard | Compilé ou non — pour ne jamais renvoyer vers une page vide |
| Git | Présent et au moins 2.17 (`git worktree remove`) ; un avertissement, le Researcher s'en passe |
| Worktrees | Combien en cours, conservés, retirés — et comment nettoyer |
| Exec | Avertit dès qu'une commande passe sans approbation : si elle exécute le code du projet, elle exécute ce que l'agent a écrit |

Les avertissements ne font pas échouer la commande ; seuls les échecs rendent `1`.
