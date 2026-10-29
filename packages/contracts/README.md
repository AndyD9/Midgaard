# `@midgaard/contracts`

Source de vérité unique du harness : schémas Zod, types, machine à états et
protocole. Ne dépend d'aucun autre paquet et n'a **aucun effet de bord au
chargement** — c'est ce qui permet de le charger depuis le daemon, le serveur
MCP, la CLI, les tests et (pour les types) le dashboard.

| Module | Contenu |
|---|---|
| `config.ts` | `HarnessConfig` et `loadConfig(env, overrides)` — configuration **injectée**, jamais lue au niveau module |
| `task.ts` | Modèle de tâche, statuts, table des transitions légales, `nextActionFor`, `isActionable` |
| `events.ts` | Journal append-only : `seq` global (reprise WebSocket) et `task_seq` local (timeline) |
| `approvals.ts` | Demande d'approbation : opération précise, usage unique, expiration |
| `protocol.ts` | `PROTOCOL_VERSION`, formes des réponses HTTP, messages WebSocket |
| `runtime.ts` | Fichier de découverte du daemon (lecture, écriture atomique, `pidAlive`) |
| `client.ts` | `daemonFetch` / `daemonJson` — client HTTP authentifié |

## Deux règles à ne pas casser

**La configuration est injectée.** Rien ici ne lit `process.env` au chargement.
Chaque point d'entrée appelle `loadConfig(process.env)` une fois et passe le
résultat. Le spike faisait l'inverse, et les imports ESM étant hissés, les tests
devaient recourir à des imports dynamiques pour changer `MIDGAARD_HOME`.

**`PROTOCOL_VERSION` s'incrémente à tout changement incompatible** entre serveur
MCP et daemon. Le daemon survit aux mises à jour du code ; c'est ce numéro qui le
fait remplacer au lieu de laisser un serveur récent dialoguer avec un daemon
périmé.
