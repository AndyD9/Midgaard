# Midgaard

Harness local qui permet à **Claude Code** de déléguer des tâches à des agents exécutants (OpenAI, Gemini), de **voir ce qu'ils font**, et de leur imposer un **budget** et une **approbation humaine** pour les actions sensibles.

Claude Code reste l'orchestrateur : il planifie, délègue et intègre les résultats. Le harness gère les tâches, l'exécution, les permissions, les traces et les coûts.

```text
Claude Code ──stdio──► serveur MCP ──HTTP 127.0.0.1 + jeton──► daemon ──► agents (Slice 2)
                       (un par session)                         (un seul, partagé)
                                                                    └──► dashboard (Slice 1)
```

## État

| Slice | Contenu | État |
|---|---|---|
| 0 | Spike : Claude Code → MCP → daemon, attente longue, approbation humaine | ✅ **Terminée**, validée dans de vraies sessions Claude Code |
| 1 | Squelette observable : persistance SQLite, dashboard temps réel, CLI `harness` | À faire |
| 2 | Agents réels (Researcher), providers OpenAI et Gemini, coûts | À faire |
| 3 | Agent Developer, worktrees Git, approbations bloquantes, diffs | À faire |
| 4 | Durcissement sécurité, distribution npm | À faire |

Le détail des slices est dans [docs/PLAN.md](docs/PLAN.md) ; ce que la Slice 0 a prouvé et appris est dans [spike/RESULTS.md](spike/RESULTS.md).

## Relancer le projet depuis un clone

**Prérequis :** Node **22.18 ou plus** (testé en 24.18), Git, et Claude Code (app desktop ou CLI).

```bash
git clone https://github.com/AndyD9/Midgaard.git
cd Midgaard/spike
npm ci               # dépendances exactes du package-lock
npm run setup        # génère ../.mcp.json pour cette machine
npm run typecheck
npm run test:lock    # ~30 s : instance unique du daemon
npm run test:wait    # ~105 s : 10 scénarios de bout en bout
```

Puis, pour l'essai réel :

1. Ouvre une **nouvelle** session Claude Code sur le dossier `Midgaard` et accepte le serveur `midgaard` quand il est proposé.
2. Demande par exemple : « Utilise le harness midgaard. Délègue « test approbation » avec duration_s 10 et needs_approval true, et attends-la jusqu'au bout en suivant next_action. »
3. Claude te donne la commande d'approbation à lancer dans un terminal (`npm run approve` dans `spike/` fonctionne aussi sans argument).

Utilisation détaillée et dépannage : [spike/README.md](spike/README.md).

## Organisation du dépôt

```text
Midgaard/
├── CLAUDE.md                     consignes pour les sessions Claude Code sur ce dépôt
├── README.md                     ce fichier
├── docs/
│   ├── MVP_AGENT_HARNESS_PLAN.md spécification d'origine du MVP
│   └── PLAN.md                   plan révisé : décisions, architecture, slices
└── spike/                        Slice 0, prototype jetable
    ├── README.md                 installation, utilisation, dépannage
    ├── RESULTS.md                résultats, bugs trouvés, découvertes
    ├── src/                      daemon, serveur MCP, CLI d'approbation
    ├── scripts/setup-mcp.ts      génération de .mcp.json
    └── test/                     suites de bout en bout
```

**Non versionné**, et recréé localement :

| Fichier | Recréé par |
|---|---|
| `.mcp.json` | `npm run setup` (chemins absolus propres à chaque machine) |
| `spike/node_modules/` | `npm ci` |
| `spike/.runtime*/` | le daemon et les tests (contient le jeton du daemon) |

## Décisions structurantes

Prises avant la Slice 0, détaillées dans [docs/PLAN.md](docs/PLAN.md) :

| Sujet | Décision |
|---|---|
| Enveloppe | Paquet npm (serveur MCP + daemon + dashboard local) ; l'app desktop Tauri est reportée |
| Runtime agent | Boucle maison multi-provider, OpenAI et Gemini dès le MVP |
| Isolation | Pas de sandbox OS : worktree, liste blanche, approbation et chemins canoniques, **annoncés comme tels** |
| Suivi des tâches | `wait_for_task` bloquant plutôt qu'interrogation en boucle |
