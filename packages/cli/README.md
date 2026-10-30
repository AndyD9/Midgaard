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

## Ce que `doctor` vérifie

Les six choses qui ont réellement cassé pendant la Slice 0 :

| Contrôle | Ce qu'il attrape |
|---|---|
| Version de Node | `node:sqlite` exige Node 24 sans drapeau expérimental |
| Dossier runtime | Mode `0700` : il contient le jeton du daemon |
| Base | Schéma lisible, et base pas plus récente que ce code |
| Daemon | En marche, injoignable, ou version de protocole différente |
| Déclaration MCP | Présente **et pointant encore là où il faut** — un dépôt déplacé ou recloné laisse des chemins absolus morts, et Claude Code échoue alors sans rien dire d'utile |
| Dashboard | Compilé ou non — pour ne jamais renvoyer vers une page vide |
| Git | Présent et au moins 2.17 (`git worktree remove`) ; un avertissement, le Researcher s'en passe |
| Worktrees | Combien en cours, conservés, retirés — et comment nettoyer |
| Exec | Avertit dès qu'une commande passe sans approbation : si elle exécute le code du projet, elle exécute ce que l'agent a écrit |

Les avertissements ne font pas échouer la commande ; seuls les échecs rendent `1`.
