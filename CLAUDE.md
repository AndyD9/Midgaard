# Consignes pour Claude Code — dépôt Midgaard

Harness local qui laisse Claude Code déléguer des tâches à des agents exécutants, les observer et les soumettre à approbation humaine. **Lire d'abord** : [README.md](README.md) (état), [docs/PLAN.md](docs/PLAN.md) (décisions et slices), [spike/RESULTS.md](spike/RESULTS.md) (ce que la Slice 0 a appris).

## Conventions

- **Langue** : français pour les échanges, les commentaires et la documentation. Exception : les descriptions d'outils MCP, les `instructions` du serveur et les messages renvoyés au modèle sont en anglais, car c'est le modèle qui les lit.
- **Toujours documenter et commenter le code**, sans attendre qu'on le demande, y compris les spikes et les tests :
  - un en-tête par fichier (rôle du module, place dans l'architecture) ;
  - une JSDoc sur chaque élément exporté (rôle, paramètres, retour, erreurs) ;
  - des commentaires sur le *pourquoi* des choix non évidents (sécurité, délais, pièges de plateforme), jamais la paraphrase du code ;
  - un README par module, et la documentation tenue à jour quand le comportement change.
- **Commandes à donner à l'utilisateur** : complètes et prêtes à copier, sans `<placeholder>` (zsh lit `<` et `>` comme des redirections).

## Commandes (dans `spike/`)

| Commande | Rôle |
|---|---|
| `npm ci` | Dépendances |
| `npm run setup` | Génère `../.mcp.json` pour cette machine |
| `npm run typecheck` | Vérification des types (TypeScript 7) |
| `npm run test:lock` | Instance unique du daemon sous concurrence (~30 s) |
| `npm run test:wait` | 10 scénarios de bout en bout (~105 s) |
| `npm run approve` | Approbation humaine d'une tâche en attente |

## Invariants à ne pas casser

Chacun a été appris à la dure pendant la Slice 0 ; le détail est dans `spike/RESULTS.md`.

- **Notifications de progression pendant toute attente longue.** Un client MCP coupe un appel d'outil à 60 s sans elles. `harness_wait_for_task` attend par tranches de 15 s et notifie entre chaque.
- **Aucun outil d'approbation exposé à Claude.** L'approbation est un acte humain ; chaque pause porte une consigne exacte (`approval_instructions`) que Claude transmet.
- **Une pause d'approbation n'est annoncée qu'une fois par client** (`approval_seq`, `still_waiting_for_human`) ; ensuite l'attente bloque jusqu'à la décision humaine.
- **Incrémenter `PROTOCOL_VERSION`** (`spike/src/shared.ts`) à tout changement incompatible entre serveur MCP et daemon : le daemon survit aux mises à jour du code et c'est ce numéro qui le fait remplacer.
- **Ne jamais écrire sur stdout dans le serveur MCP** : c'est le canal JSON-RPC.
- **Tester les invariants directement** (compter les processus vivants), pas leurs effets visibles depuis un client : c'est ainsi qu'un bug de verrou est passé inaperçu.
- **Ne rien décrire à Claude qui n'existe pas encore** (le premier test réel l'a renvoyé vers un dashboard inexistant).

## Pièges d'environnement

- Node exécute le TypeScript directement (≥ 22.18), **sauf sous `node_modules`** : la distribution npm exigera une étape de build.
- `typescript` 7 est le compilateur natif : `tsc` fonctionne, mais l'API JavaScript du compilateur n'existe plus (épingler `typescript@5` si un outil en a besoin).
- Claude Code ne relit `.mcp.json` qu'à l'ouverture d'une session : après une modification du serveur MCP, ouvrir une **nouvelle** session pour tester.
- Le daemon ne s'arrête jamais seul (à traiter en Slice 1).

## Git

- Dépôt : https://github.com/AndyD9/Midgaard (public).
- Ne jamais versionner `.mcp.json` ni les dossiers `.runtime*` (jeton du daemon).

## Prochaine étape : Slice 1

Persistance SQLite avec statut `interrupted` au redémarrage, dashboard temps réel (remplace la commande d'approbation par un lien), CLI `harness init|start|status|doctor`, arrêt du daemon après inactivité, étape de build, configuration injectée plutôt que lue au chargement des modules, évaluation des « Tasks » MCP natives. Le monorepo prévu dans `docs/PLAN.md` remplace alors `spike/`.
