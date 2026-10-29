# `@midgaard/persistence`

Mémoire longue du harness : SQLite via **`node:sqlite`**, le module intégré à
Node. Aucune dépendance native à compiler, aucun binaire précompilé à
télécharger — un `git clone` suffit sur n'importe quelle plateforme.

> Le plan prévoyait `better-sqlite3`. `node:sqlite` rend le même service sans
> dépendance native ; c'est ce qui fixe le minimum à **Node 24** (en 22.18 le
> module existe mais exige `--experimental-sqlite`).

## L'invariant du module

**Aucune méthode publique ne modifie une tâche sans écrire la ligne de journal
qui la raconte, et les deux écritures sont dans la même transaction.**

Sans cela, un crash entre les deux laisserait soit une tâche dont l'historique
ment, soit un historique décrivant un état que la tâche n'a jamais eu. Le
dashboard se reconstruit à partir du journal : il afficherait n'importe quoi.

C'est pourquoi l'API est `record(id, statut, événement, patch)` et non un
`updateTask` suivi d'un `appendEvent`.

## Schéma

`PRAGMA user_version` suit la version du schéma — pas de table de suivi, et la
migration est atomique. **Une migration publiée ne se modifie plus** : toute
évolution ajoute une entrée à la fin de `MIGRATIONS`. Une base plus récente que
le code en cours fait échouer l'ouverture, au lieu d'être interprétée de travers.

| Table | Rôle |
|---|---|
| `tasks` | État courant de chaque tâche |
| `task_events` | Journal append-only. `seq` global (`AUTOINCREMENT`, jamais réutilisé) pour la reprise WebSocket ; `task_seq` local pour la timeline d'une tâche |
| `approvals` | Demandes d'approbation : opération précise, usage unique, expiration |
| `provider_configs` | Fournisseurs de modèles ; la clé n'y est jamais, seulement sa référence au coffre |
| `agents` | Profils d'exécution |
| `tool_calls` | Appels d'outils, arguments et résultats expurgés |
| `workspaces` | Worktree de chaque tâche d'agent écrivant : branche, commit de départ, cycle `active → kept → removed` |

Trois tables du plan n'existeront pas : `usage` (la consommation vit dans
`tasks.usage_json` et le journal), `projects` et `artifacts` — raisons dans
`migrations.ts` et dans `docs/SLICE3.md`.

Une ligne `workspaces` s'écrit **avec** l'événement `workspace.*` qui la raconte,
dans la même transaction que la ligne de journal de sa tâche : c'est
`recordUnlocked`, le corps de `record()` sans transaction propre, qui le permet.

## Choix d'exploitation

- **WAL** : la CLI (`harness status`) lit pendant que le daemon écrit.
- **`BEGIN IMMEDIATE`** : le verrou d'écriture est pris dès le début de la
  transaction ; en WAL, une transaction qui commence en lecture puis veut écrire
  peut échouer, et ferait perdre un événement déjà calculé.
- **`AUTOINCREMENT` sur `task_events.seq`** : SQLite réutilise les `rowid`
  libérés, ce qui casserait la reprise WebSocket.
- **`markInterrupted()`** au démarrage : toute tâche restée active devient
  `interrupted`. Jamais reprise, jamais considérée réussie.
