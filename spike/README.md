# Midgaard — spike Slice 0

Prototype jetable qui prouve la chaîne de communication du harness :

```text
Claude Code ──stdio──► serveur MCP ──HTTP 127.0.0.1 + jeton──► daemon
 (une session)         (un par session)                         (un seul, partagé)
```

Claude délègue une tâche, attend son résultat sans interroger en boucle, et un humain approuve les étapes sensibles. Les tâches sont **simulées** (étapes minutées) : aucun agent réel ne tourne encore.

Ce qui a été appris est consigné dans [RESULTS.md](RESULTS.md). Le monorepo définitif commence en Slice 1.

## Prérequis

- Node **22.18 ou plus** (testé en 24.18). Le TypeScript est exécuté directement par Node, sans étape de build.
- Claude Code (app desktop ou CLI) pour l'essai réel.

## Installation

```bash
cd spike
npm ci
npm run setup        # génère ../.mcp.json pour cette machine
npm run typecheck
```

## Utilisation avec Claude Code

Le serveur est déclaré dans `../.mcp.json`, généré par `npm run setup` (non versionné : il contient des chemins absolus propres à chaque machine). Ouvre une nouvelle session Claude Code sur le dossier `Midgaard` et accepte le serveur `midgaard` quand il est proposé. Le daemon démarre tout seul au premier appel d'outil.

Outils disponibles pour Claude :

| Outil | Rôle |
|---|---|
| `harness_ping` | Vérifie que le daemon répond (le démarre si besoin) |
| `harness_delegate_task` | Crée une tâche et rend son `task_id` immédiatement |
| `harness_wait_for_task` | Bloque jusqu'à la fin, une approbation requise, ou le délai |
| `harness_get_task_status` | État instantané, sans attendre |
| `harness_cancel_task` | Annule une tâche |

Chaque réponse contient un champ `next_action` qui dit à Claude quoi faire ensuite. Pour une approbation, deux valeurs : `human_approval_pending` à la première annonce d'une pause, puis `still_waiting_for_human` tant que l'humain n'a pas décidé ; entre les deux, `harness_wait_for_task` bloque jusqu'à la décision.

### Approuver une tâche

Claude ne peut pas approuver : c'est volontaire. Quand une pause survient, il reçoit la commande exacte à te transmettre (champ `approval_instructions`), avec l'identifiant de la tâche. Tu peux aussi, sans identifiant :

```bash
npm run approve
```

Sans argument, la commande approuve la tâche en attente si elle est seule. S'il y en a plusieurs, elle affiche une commande complète par tâche, prête à copier.

## Tests

```bash
npm run test:wait     # ~105 s : 10 scénarios de bout en bout
npm run test:lock     # ~30 s : instance unique du daemon sous concurrence
```

Les deux suites lancent de vrais processus. Le détail des scénarios est en tête de [`test/long-wait.ts`](test/long-wait.ts) et de [`test/single-instance.ts`](test/single-instance.ts).

## Organisation du code

| Fichier | Rôle |
|---|---|
| [`src/shared.ts`](src/shared.ts) | Contrat commun : chemins runtime, modèle de tâche, `next_action`, client HTTP |
| [`src/daemon.ts`](src/daemon.ts) | Source de vérité des tâches, API HTTP locale, long-poll, instance unique |
| [`src/mcp-server.ts`](src/mcp-server.ts) | Adaptateur stdio pour Claude Code, démarrage du daemon, attente par tranches |
| [`src/approve.ts`](src/approve.ts) | Approbation humaine en ligne de commande |
| [`test/long-wait.ts`](test/long-wait.ts) | Suite de bout en bout |
| [`test/single-instance.ts`](test/single-instance.ts) | 8 daemons lancés en même temps : un seul doit survivre |
| [`scripts/setup-mcp.ts`](scripts/setup-mcp.ts) | Génère `../.mcp.json` pour la machine courante |

Chaque fichier commence par un en-tête qui détaille son fonctionnement ; l'API HTTP complète du daemon est documentée dans celui de `daemon.ts`.

## Configuration

| Variable | Défaut | Effet |
|---|---|---|
| `MIDGAARD_HOME` | `spike/.runtime` | Dossier d'état runtime |
| `MIDGAARD_PORT` | choisi par le système | Port fixe du daemon |

## Fichiers runtime

Dans `.runtime/` (ignoré par Git, dossier en `0700`) :

| Fichier | Contenu |
|---|---|
| `daemon.json` | Port, jeton et pid du daemon. **Secret** (`0600`) : il donne le contrôle du daemon |
| `daemon.lock` | Verrou d'instance unique (pid du détenteur), vérifié chaque seconde |
| `daemon.log` | Journal du daemon |
| `mcp-trace.jsonl` | Trace des attentes : client, jeton de progression, durée, issue |

## Dépannage

| Symptôme | Cause probable | Solution |
|---|---|---|
| `zsh: parse error near '\n'` | Un `<…>` copié tel quel : zsh le lit comme une redirection | Utiliser `npm run approve` sans argument |
| « Aucun daemon actif » | Claude n'a encore appelé aucun outil du harness | Lancer d'abord le test dans Claude Code, approuver ensuite |
| Claude parle d'approuver « dans le dashboard » | Session ouverte avec l'ancienne version du serveur MCP | Ouvrir une **nouvelle** session : le serveur MCP n'est relu qu'au démarrage |
| Un vieux daemon tourne après une mise à jour du code | Le daemon ne s'arrête jamais seul | Rien à faire : le premier serveur MCP récent le remplace (version de protocole) |
| Plusieurs `daemon.ts` dans `ps` | Daemons orphelins d'une ancienne version (avant correctif du verrou) | Les arrêter avec `kill <pid>` ; la version actuelle ne peut plus en laisser deux |
| Le serveur `midgaard` n'apparaît pas dans Claude Code | Les `.mcp.json` ne sont lus qu'à l'ouverture d'une session | Ouvrir une **nouvelle** session sur `Midgaard` |
| Attente coupée à 60 s | Client sans notifications de progression | Voir [RESULTS.md](RESULTS.md), découverte n° 1 |
| Le serveur `midgaard` ne démarre pas (après une mise à jour de Node, un déplacement du dossier ou un clone) | Chemins obsolètes ou absents dans `.mcp.json` | Relancer `npm run setup` |

Pour arrêter le daemon à la main :

```bash
kill "$(node -p "require('./.runtime/daemon.json').pid")"
```

## Limites connues

- État en mémoire : les tâches sont perdues si le daemon redémarre.
- Le daemon ne s'arrête jamais seul.
- Pas de dashboard : l'approbation passe par la ligne de commande.
- Tâches simulées, aucun agent réel.

Toutes sont traitées dans les Slices 1 et 2.
