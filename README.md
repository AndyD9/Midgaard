# Midgaard

Harness local qui permet à **Claude Code** de déléguer des tâches à des agents
exécutants, de **voir ce qu'ils font**, et de leur imposer un **budget** et une
**approbation humaine** pour les actions sensibles.

Claude Code reste l'orchestrateur : il planifie, délègue et intègre les
résultats. Le harness gère les tâches, l'exécution, les permissions, les traces
et les coûts.

```text
  session A ─ serveur MCP ─┐
  session B ─ serveur MCP ─┼─ HTTP 127.0.0.1 + jeton ─► daemon ─► SQLite
  CLI harness ─────────────┤                             │
  dashboard ───────────────┘                             └─ WebSocket ─► dashboard
                                                            └──► agents (Slice 2)
```

## État

| Slice | Contenu | État |
|---|---|---|
| 0 | Spike : Claude Code → MCP → daemon, attente longue, approbation humaine | ✅ **Terminée**, validée en sessions réelles |
| 1 | Squelette observable : persistance SQLite, dashboard temps réel, CLI `harness` | ✅ **Terminée**, 91 vérifications + essai en session réelle |
| 2 | Agents réels (Researcher), providers OpenAI et Gemini, coûts | À faire |
| 3 | Agent Developer, worktrees Git, approbations bloquantes, diffs | À faire |
| 4 | Durcissement sécurité, distribution npm | À faire |

Le détail des slices est dans [docs/PLAN.md](docs/PLAN.md). Ce que chaque slice a
prouvé et appris : [docs/SLICE0.md](docs/SLICE0.md), [docs/SLICE1.md](docs/SLICE1.md).

## Démarrer depuis un clone

**Prérequis :** Node **24 ou plus**, Git, et Claude Code (app desktop ou CLI).

```bash
git clone https://github.com/AndyD9/Midgaard.git
cd Midgaard
npm ci                 # dépendances exactes du package-lock
npm run build          # compile les paquets et le dashboard
npm run init           # déclare le serveur MCP dans ./.mcp.json
npm run doctor         # diagnostic de l'installation
```

Puis, pour l'essai réel :

1. Ouvre une **nouvelle** session Claude Code sur le dossier `Midgaard` et accepte
   le serveur `midgaard` quand il est proposé — les déclarations MCP ne sont
   relues qu'à l'ouverture d'une session.
2. Demande par exemple : « Utilise le harness midgaard. Délègue « test
   approbation » avec `duration_s` 20 et `needs_approval` true, et attends-la
   jusqu'au bout en suivant `next_action`. »
3. Quand la tâche se met en pause, Claude te transmet la consigne d'approbation.
   Ouvre le dashboard sur **http://127.0.0.1:7777** et approuve — ou lance
   `npm run harness -- approve` dans un terminal.

Le daemon démarre tout seul au premier appel d'outil, et s'arrête après
30 minutes sans tâche active, sans dashboard connecté et sans requête.

## Commandes

Depuis la racine du dépôt :

| Commande | Rôle |
|---|---|
| `npm run build` | Compile les paquets (`dist/`) et le dashboard |
| `npm run typecheck` | Vérification des types, dashboard compris |
| `npm run init` | Déclare le serveur MCP dans `.mcp.json` |
| `npm run doctor` | Diagnostic : Node, dossier runtime, base, daemon, déclaration MCP |
| `npm run harness -- <cmd>` | La CLI complète : `start`, `stop`, `status`, `approve`, `reject` |
| `npm run dashboard:dev` | Dashboard avec rechargement à chaud (lance `harness start` avant) |
| `npm test` | Les quatre suites, environ 4 minutes |

| Suite | Durée | Contenu |
|---|---|---|
| `npm run test:unit` | ~1 s | 62 tests : machine à états, persistance, configuration, traversée de chemins |
| `npm run test:lock` | ~30 s | Instance unique du daemon sous concurrence |
| `npm run test:restart` | ~45 s | Redémarrage, reprise WebSocket, sécurité, expiration, inactivité |
| `npm run test:wait` | ~3 min | 12 scénarios de bout en bout avec le client MCP officiel |

Le développement se fait **sans étape de build** : Node exécute le TypeScript
directement. `npm run build` ne sert qu'à produire ce qui sera distribué, et le
dashboard, que le daemon sert depuis `apps/dashboard/dist`.

## Organisation du dépôt

```text
Midgaard/
├── CLAUDE.md                     consignes pour les sessions Claude Code sur ce dépôt
├── docs/
│   ├── MVP_AGENT_HARNESS_PLAN.md spécification d'origine du MVP
│   ├── PLAN.md                   plan révisé : décisions, architecture, slices
│   ├── SLICE0.md                 ce que le spike a prouvé et appris
│   └── SLICE1.md                 résultats de la Slice 1, écarts au plan, découvertes
├── packages/
│   ├── contracts/                schémas Zod, machine à états, protocole — aucune dépendance
│   ├── persistence/              SQLite (node:sqlite), migrations, dépôt
│   ├── daemon/                   HTTP, WebSocket, bus d'événements, moteur de tâches
│   ├── mcp-server/               adaptateur stdio pour Claude Code
│   └── cli/                      `harness init|start|stop|status|doctor|approve|reject`
├── apps/
│   └── dashboard/                React + Vite + Tailwind, servi par le daemon
└── tests/                        unitaires, instance unique, intégration, bout en bout MCP
```

Chaque paquet a son `README.md`, qui explique son rôle et les invariants qu'il tient.

**Non versionné**, et recréé localement :

| Fichier | Recréé par |
|---|---|
| `.mcp.json` | `npm run init` (chemins absolus propres à chaque machine) |
| `node_modules/` | `npm ci` |
| `dist/` | `npm run build` |
| `~/.midgaard/` | le daemon (base, journal, verrou, **jeton d'accès**) |

## Décisions structurantes

| Sujet | Décision |
|---|---|
| Enveloppe | Paquet npm : serveur MCP + daemon + dashboard local. L'app desktop Tauri est reportée |
| Runtime agent | Boucle maison multi-provider, OpenAI et Gemini dès le MVP |
| Isolation | Pas de sandbox OS : worktree, liste blanche, approbation et chemins canoniques, **annoncés comme tels** |
| Suivi des tâches | `wait_for_task` bloquant plutôt qu'interrogation en boucle |
| Base | `node:sqlite`, intégré à Node — aucune dépendance native (révision du plan, Slice 1) |

## Sécurité, en une phrase honnête

Isolation **logique** : le daemon n'écoute que sur `127.0.0.1`, exige un jeton,
refuse tout `Host` ou toute `Origin` étrangère. Ce n'est **pas** une sandbox OS :
un agent compromis pourra lire les fichiers accessibles à votre compte
utilisateur. Le modèle de menace détaillé est dans
[packages/daemon/README.md](packages/daemon/README.md).

Et un invariant qui ne bougera pas : **Claude ne peut pas s'auto-approuver.**
Aucun outil d'approbation ne lui est exposé ; la décision passe par un humain,
dans le dashboard ou dans la CLI.
