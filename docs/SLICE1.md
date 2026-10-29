# Slice 1 — Squelette observable

**Date :** 2026-10-29 · **Objectif :** rendre le harness **durable et observable** —
persistance SQLite, dashboard temps réel, CLI `harness`, et un daemon qui
s'arrête tout seul.

**Verdict : livrable atteint.** Claude délègue une tâche factice, l'utilisateur
en voit le cycle de vie en direct, l'approuve ou l'annule depuis le dashboard,
redémarre le daemon et retrouve l'historique avec les tâches en vol marquées
`interrupted`. 91 vérifications automatiques, 0 échec. Le monorepo remplace
`spike/`, supprimé.

---

## Ce qui est prouvé

| Suite | Contenu | Résultat |
|---|---|---|
| `npm run test:unit` | 62 tests unitaires : machine à états complète, persistance, configuration, traversée de chemins | 62/62, ~0,7 s |
| `npm run test:lock` | 8 daemons lancés ensemble, 10 manches (6 à froid, 4 sur verrou périmé) | 10/10, ~30 s |
| `npm run test:restart` | 7 scénarios d'intégration sur de vrais processus et de vraies sockets | 7/7, ~45 s |
| `npm run test:wait` | 12 scénarios de bout en bout, client MCP officiel en stdio | 12/12, ~178 s |

### Intégration (`test:restart`)

| # | Scénario | Résultat |
|---|---|---|
| R1 | Daemon tué au `SIGKILL` avec une tâche en vol | Historique conservé, tâche terminée intacte, tâche en vol → `interrupted` |
| R2 | Coupure WebSocket puis reprise depuis la dernière séquence | 5 événements rejoués, **aucune séquence manquante** |
| R3 | Reprise impossible | Signalée (`truncated`), instantané complet quand même |
| R4 | Contrôles d'accès de l'API locale | 9 contrôles HTTP conformes ; WebSocket d'origine étrangère et sans jeton refusées |
| R5 | Approbation jamais tranchée | Expire, tâche → `timed_out`, aucune demande fantôme |
| R6 | Annulation | Passe par `cancel_requested`, et une seconde annulation est refusée (409) |
| R7 | Inactivité | Le daemon s'arrête seul, sans tâche active ni dashboard connecté |

### Bout en bout MCP (`test:wait`)

Les dix scénarios de la Slice 0 sont repris et passent toujours. Deux ajouts :

| # | Scénario | Résultat |
|---|---|---|
| S11 | `harness_get_task_result` | Résultat structuré sur une tâche finie ; sur une tâche en cours, n'attend pas et ne devine rien |
| S12 | Tâche interrompue par un redémarrage | Rapportée à Claude en `interrupted` / `task_ended_without_result`, avec le motif |

**S5 reste un constat, pas un échec** : sans notifications de progression, le
client coupe toujours l'appel à **60,0 s**. S6 confirme qu'avec elles, 75 s
tiennent sans coupure. C'est l'invariant qui rend `harness_wait_for_task` viable.

**S8 a été durci.** La Slice 0 vérifiait que la consigne d'approbation ne
mentionnait pas de dashboard inexistant. La Slice 1 va plus loin : quand une URL
de dashboard est annoncée, **le test la charge** et vérifie qu'elle sert bien le
dashboard, pas la page « non compilé ». La leçon du défaut n° 1 devient ainsi
une vérification, et non une consigne à respecter.

### Vérification manuelle

Le dashboard a été exercé dans un vrai navigateur : connexion WebSocket,
approbation d'une tâche en pause, mise à jour de la timeline en direct,
redémarrage du daemon, affichage de la tâche `interrupted`. Le plan prévoyait
Playwright ; il est reporté en Slice 3, quand l'interface portera des diffs et
que la régression visuelle deviendra coûteuse à surveiller à la main.

---

## Décisions qui révisent le plan

Quatre écarts assumés par rapport à [PLAN.md](PLAN.md), chacun avec sa raison.

### 1. `node:sqlite` au lieu de `better-sqlite3`

Le module SQLite **intégré à Node** rend le même service sans dépendance native :
aucun binaire précompilé à télécharger, aucune compilation locale si la
plateforme n'est pas couverte, et un `git clone` suffit partout. Le prix est un
minimum relevé à **Node 24** — en 22.18, le module existe mais exige
`--experimental-sqlite`. Le README annonçait déjà Node 24 comme version testée.

### 2. `node:http` au lieu de Fastify

Les contrôles de sécurité du daemon (`Host` exact, `Origin` en liste blanche,
jeton à temps constant) sont écrits, éprouvés et testés depuis la Slice 0. Les
réécrire en intergiciels Fastify aurait ajouté une dépendance et un risque, sans
rien apporter : l'API compte quinze routes et aucune n'a besoin de sérialisation
accélérée ni de greffons. À reconsidérer si l'API grossit beaucoup.

### 3. `node --test` au lieu de Vitest

Le lanceur de tests intégré à Node exécute directement le TypeScript et couvre ce
dont la Slice 1 a besoin. Une dépendance de moins, et aucune chaîne de
transformation entre le code testé et le code exécuté.

### 4. `interrupted` élargi à **tous** les statuts actifs

Le plan ne parlait que de `running` et `preparing`. En pratique, une tâche
`queued` ne démarrera jamais — son minuteur vivait dans le processus mort — et une
tâche `waiting_approval` a perdu le contexte de sa pause. Les laisser actives les
ferait attendre indéfiniment une suite qui ne viendra pas. Les trois statuts sont
donc interrompus, et les approbations encore en attente sont closes en même temps :
un bouton d'approbation qui ne peut plus rien débloquer serait pire que pas de bouton.

### Ce qui n'a pas été fait, et pourquoi

Les tables `projects`, `agents`, `tool_calls`, `artifacts`, `usage`,
`provider_configs` et `workspaces` du plan (§6) ne sont pas créées. Les migrations
sont versionnées : chaque slice ajoute les siennes quand elle a de quoi les
remplir. Créer des tables vides d'avance figerait un schéma qu'on n'a pas éprouvé.

De même, `harness_list_agents` et `harness_get_project_context` ne sont pas
exposés : il n'y a encore ni agent ni projet à décrire, et annoncer à Claude un
outil qui rend du vide est exactement l'erreur du défaut n° 1 de la Slice 0.

---

## Découvertes

1. **Node exécute le TypeScript d'un paquet de workspace, malgré `node_modules`.**
   La Slice 0 avait mesuré que Node refuse le TypeScript sous `node_modules`
   (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), ce qui condamnait a priori un
   monorepo npm, dont les paquets sont justement liés là. Vérifié : Node résout le
   lien symbolique **avant** d'appliquer la règle, et le chemin réel
   (`packages/contracts/src/…`) passe. Le développement se fait donc sans étape de
   build, et la compilation ne sert qu'à la distribution.

2. **Les conditions d'export résolvent proprement « sources ou compilé ».**
   Chaque paquet déclare `{ "midgaard-dev": "./src/index.ts", "default": "./dist/index.js" }`.
   Lancé avec `--conditions=midgaard-dev`, le harness tourne sur les sources ; sans
   elle, sur `dist/`. Le même mécanisme sert à `import.meta.resolve` quand un
   processus doit en lancer un autre (le serveur MCP qui démarre le daemon,
   `harness init` qui écrit `.mcp.json`) : le point d'entrée résolu désigne la
   bonne variante, et son extension `.ts` suffit à savoir s'il faut repasser la
   condition au processus fils — elle ne s'hérite pas.

3. **Les propriétés de paramètres de constructeur ne sont pas effaçables.**
   `constructor(readonly id: string)` produit du code à l'exécution ; Node ne peut
   pas se contenter d'effacer les types. `erasableSyntaxOnly` est activé partout
   pour que le compilateur le refuse au lieu de laisser la panne arriver à
   l'exécution.

4. **Le dashboard ne peut pas importer `@midgaard/contracts` à l'exécution.**
   Le point d'entrée du paquet charge `node:os` et `node:fs`. Seuls les **types**
   en sont importés — effacés à la compilation, donc jamais embarqués. Les deux
   seules valeurs nécessaires (les sous-protocoles WebSocket) sont recopiées, avec
   le commentaire qui le signale. Une condition d'export `"types"` pointant vers les
   sources évite au dashboard de dépendre d'une compilation préalable.

5. **Le relais de développement doit réécrire `Origin`.** Vite sert le dashboard
   sur son propre port ; sans réécriture, le daemon voit `http://localhost:5173` et
   refuse — à juste titre. Le relais repose donc l'origine du daemon.

---

## Les « Tasks » MCP natives : évaluation

Le SDK 1.32 implémente la primitive du protocole pour les requêtes longues :
`tasks/get`, `tasks/result`, `tasks/list`, `tasks/cancel`, et
`notifications/tasks/status`. Elle fait exactement ce que fait
`harness_wait_for_task` : rendre la main tout de suite et laisser le client
revenir chercher le résultat.

**Décision : ne pas l'adopter en Slice 1.** La raison est dans le protocole
lui-même : une requête ne devient une tâche que si **le client** le demande, et
il ne le demande que s'il déclare la capacité `tasks`. Un serveur ne peut pas
l'imposer sans casser tous les clients qui l'ignorent. La question n'est donc pas
« est-ce mieux ? » mais « Claude Code le déclare-t-il ? », et seule une vraie
session peut y répondre — le client du SDK utilisé par les tests ne prouve rien
du client réel.

L'instrumentation est en place : le serveur MCP écrit les capacités annoncées par
son client dans `~/.midgaard/mcp-trace.jsonl` à chaque connexion
(`client.initialized`, champ `supports_native_tasks`). Il suffira d'ouvrir une
session Claude Code et de lire cette ligne.

Même si la réponse est oui, le remplacement n'est pas automatique : notre attente
porte une sémantique que le protocole n'a pas — la pause d'approbation annoncée
une seule fois par client (`approval_seq`), et le `next_action` qui dit à Claude
quoi faire. Ce sont ces deux choses, pas le mécanisme d'attente, qui ont fait la
différence en Slice 0.

---

## Où est passé le spike

| Slice 0 | Slice 1 |
|---|---|
| `spike/src/shared.ts` | `packages/contracts/src/` (éclaté par sujet) |
| `spike/src/daemon.ts` | `packages/daemon/src/` (verrou, bus, moteur, HTTP, WS, sécurité) |
| `spike/src/mcp-server.ts` | `packages/mcp-server/src/` |
| `spike/src/approve.ts` | `harness approve` — et le dashboard |
| `spike/scripts/setup-mcp.ts` | `harness init` |
| `spike/test/*` | `tests/` |
| état en mémoire | `packages/persistence` (SQLite) |
| `npm run approve` | dashboard, ou `harness approve` |

Les chemins runtime ont changé : l'état vit maintenant dans `~/.midgaard`, et non
plus dans le dossier du projet. Le daemon est partagé par toutes les sessions
Claude Code, quel que soit le dépôt ouvert ; le lier à un projet n'avait pas de sens.

---

## Limites connues

- **Tâches simulées** : aucun agent réel ne tourne. C'est l'objet de la Slice 2.
- **Aucun coût, aucun budget** : rien à mesurer tant qu'aucun modèle n'est appelé.
  Le statut `budget_exceeded` existe dans la machine à états, mais rien ne l'émet.
- **Un seul profil d'exécution** : pas de registre d'agents, pas de projets.
- **Pas de test Playwright** du dashboard (vérification manuelle, voir plus haut).
- **La distribution npm n'est pas vérifiée.** L'étape de build existe et produit
  `dist/`, les `publishConfig` sont en place, mais rien n'a été publié ni installé
  depuis un paquet. C'est l'objet de la Slice 4.
