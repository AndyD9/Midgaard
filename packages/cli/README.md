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

Les avertissements ne font pas échouer la commande ; seuls les échecs rendent `1`.
