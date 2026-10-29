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
                                                            └─► agent-runtime
                                                                 ├─► providers (Venice, OpenAI, Gemini)
                                                                 └─► outils (lecture, http_fetch)
```

## État

| Slice | Contenu | État |
|---|---|---|
| 0 | Spike : Claude Code → MCP → daemon, attente longue, approbation humaine | ✅ **Terminée**, validée en sessions réelles |
| 1 | Squelette observable : persistance SQLite, dashboard temps réel, CLI `harness` | ✅ **Terminée**, 91 vérifications + essai en session réelle |
| 2 | Agents réels (Researcher), providers, coûts, coffre système | ✅ **Terminée**, 167 vérifications + essai en session réelle ; coût **exact au microdollar** contre le solde Venice, trois fois |
| 3 | Agent Developer, worktrees Git, approbations bloquantes, diffs | À faire |
| 4 | Durcissement sécurité, distribution npm | À faire |

Le détail des slices est dans [docs/PLAN.md](docs/PLAN.md). Ce que chaque slice a
prouvé et appris : [docs/SLICE0.md](docs/SLICE0.md), [docs/SLICE1.md](docs/SLICE1.md),
[docs/SLICE2.md](docs/SLICE2.md).

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

## Déclarer un fournisseur de modèles

Sans fournisseur, seul le profil `simulated` tourne — des étapes minutées qui
n'appellent aucun modèle. Le Researcher reste visible mais **désactivé**, et il
le dit. Pour l'activer :

```bash
npm run harness -- providers add venice --model deepseek-v4-flash-0731
```

La clé est demandée **sans écho** et déposée dans le coffre système (trousseau
macOS, DPAPI sur Windows, libsecret sur Linux). Elle n'apparaît ni dans la ligne
de commande, ni dans l'historique du shell, ni en base : la base ne garde qu'une
référence. La commande teste la connexion dans la foulée.

```bash
npm run harness -- agents              # qui peut exécuter, et pourquoi pas
npm run harness -- pricing refresh venice   # relève les tarifs chez le fournisseur
```

`--preset openai` ou `--preset gemini` visent les autres fournisseurs ;
`--preset custom --base-url …` vise tout endpoint compatible OpenAI.

## Essais réels

**Avec le profil simulé**, qui ne coûte rien :

1. Ouvre une **nouvelle** session Claude Code sur le dossier `Midgaard` et accepte
   le serveur `midgaard` quand il est proposé — les déclarations MCP ne sont
   relues qu'à l'ouverture d'une session.
2. Demande par exemple : « Utilise le harness midgaard. Délègue « test
   approbation » à l'agent `simulated` avec `duration_s` 20 et `needs_approval`
   true, et attends-la jusqu'au bout en suivant `next_action`. »
3. Quand la tâche se met en pause, Claude te transmet la consigne d'approbation.
   Ouvre le dashboard sur **http://127.0.0.1:7777** et approuve — ou lance
   `npm run harness -- approve` dans un terminal.

**Avec un vrai agent**, une fois un fournisseur déclaré : « Utilise le harness
midgaard. Liste les agents, puis délègue au `researcher` : « quelles versions de
Node fournissent `node:sqlite` sans drapeau expérimental ? ». Passe-lui en
`context` ce que tu sais déjà du dépôt, limite le budget à 0,05 $, et attends le
résultat. » Le coût, les appels d'outils et les sources s'affichent en direct sur
le dashboard.

Abaisse le **budget** et le **délai** sans crainte : les dépasser arrête une
tâche proprement. Retiens surtout qu'**une tâche qui échoue a déjà dépensé** —
l'essai en session réelle a perdu 0,0063 $ sur une tâche sans résultat, trois
fois le prix d'une qui aboutit. La cause la plus fréquente n'est pas une limite
trop basse mais un **objectif qui appelle une réponse trop longue** : le plafond
de sortie coupe la réponse avant que l'agent n'ait pu conclure. Demande une
réponse courte et bornée ([docs/SLICE2.md](docs/SLICE2.md)).

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
| `npm run harness -- <cmd>` | La CLI : `start`, `stop`, `status`, `approve`, `reject` |
| `npm run harness -- agents` | Profils d'exécution, et pourquoi certains sont désactivés |
| `npm run harness -- providers` | Fournisseurs déclarés, modèle et dernier test |
| `npm run harness -- providers add <id> --model <m>` | Déclare un fournisseur ; la clé est saisie sans écho |
| `npm run harness -- pricing refresh <id>` | Relève les tarifs chez le fournisseur |
| `npm run dashboard:dev` | Dashboard avec rechargement à chaud (lance `harness start` avant) |
| `npm test` | Les quatre suites gratuites, environ 4 minutes |
| `npm run test:ui` | Le dashboard dans un vrai navigateur (voir le prérequis plus bas) |
| `npm run test:live` | Essai réel contre un vrai fournisseur — **dépense de l'argent** |

| Suite | Durée | Contenu |
|---|---|---|
| `npm run test:unit` | ~1 s | 164 tests : machine à états, persistance, adaptateurs, coûts, sécurité des outils, boucle d'agent, formatage des montants, coffres |
| `npm run test:vault` | ~1 s | Les coffres seuls, sur le coffre **réel de la machine** — lancé par la CI sur macOS, Windows et Linux |
| `npm run test:lock` | ~30 s | Instance unique du daemon sous concurrence |
| `npm run test:restart` | ~45 s | Redémarrage, reprise WebSocket, sécurité, expiration, inactivité |
| `npm run test:ui` | ~1 min | 7 scénarios dans un vrai navigateur : direct, approbation au clic, reconnexion |
| `npm run test:wait` | ~3 min | 12 scénarios de bout en bout avec le client MCP officiel |
| `npm run test:live` | ~3 min | 5 scénarios **contre la vraie API** — opt-in, dépense ~0,003 $, s'abstient sans clé |

`npm test` enchaîne `unit`, `lock`, `restart` et `wait`. `test:ui` se lance à
part : il lui faut le dashboard compilé et le navigateur de Playwright, que
`npm ci` ne télécharge pas.

```
npx playwright install chromium
```

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
│   ├── secrets/                  coffre système multi-plateforme, sans dépendance native
│   ├── providers/                adaptateurs de modèles : compatible OpenAI (Venice) et Gemini
│   ├── tools/                    outils des agents : lecture projet, http_fetch contrôlé
│   ├── agent-runtime/            la boucle : budgets, limites, approbations, résultat structuré
│   ├── daemon/                   HTTP, WebSocket, bus d'événements, moteurs de tâches
│   ├── mcp-server/               adaptateur stdio pour Claude Code
│   └── cli/                      `harness init|start|status|agents|providers|pricing|approve`
├── apps/
│   └── dashboard/                React + Vite + Tailwind, servi par le daemon
└── tests/                        unitaires, instance unique, intégration, bout en bout MCP
```

Chaque paquet a son `README.md`, qui explique son rôle et les invariants qu'il tient.

**Non versionné**, et recréé localement :

| Fichier | Recréé par |
|---|---|
| `.mcp.json` | `npm run init` (chemins absolus propres à chaque machine) |
| Clés d'API | le coffre système — jamais le dépôt, jamais la base |
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
| Appels aux modèles | API HTTP directe, **aucun SDK de fournisseur** (révision du plan, Slice 2) |
| Recherche web | native au fournisseur, facturée avec le modèle (point tranché en Slice 2) |
| Secrets | coffre système, sans dépendance native ; repli fichier **annoncé comme tel** |

## Sécurité, en une phrase honnête

Isolation **logique** : le daemon n'écoute que sur `127.0.0.1`, exige un jeton,
refuse tout `Host` ou toute `Origin` étrangère. Ce n'est **pas** une sandbox OS :
un agent compromis pourra lire les fichiers accessibles à votre compte
utilisateur. Le modèle de menace détaillé est dans
[packages/daemon/README.md](packages/daemon/README.md).

Et un invariant qui ne bougera pas : **Claude ne peut pas s'auto-approuver.**
Aucun outil d'approbation ne lui est exposé ; la décision passe par un humain,
dans le dashboard ou dans la CLI.

Deux autres, ajoutés en Slice 2 :

- **Un agent ne lit que le dépôt d'où la tâche a été déléguée.** Chemins
  canonicalisés et revérifiés à l'ouverture du descripteur, liens symboliques
  sortants refusés. Ce n'est pas une sandbox : c'est une frontière d'intention.
- **`http_fetch` ne joint jamais une adresse privée**, ni le service de
  métadonnées des nuages, redirections comprises — chaque saut est revérifié.
  Et ce qui revient du web est encadré en `<untrusted_data>` avant de remonter à
  Claude : c'est de la donnée, jamais une instruction.

**Aucun montant n'est affiché sans sa provenance.** Un coût est « facturé par le
fournisseur », « estimé depuis les tarifs locaux » ou « inconnu » — jamais un
nombre nu, et jamais `0 $` faute de tarif.
