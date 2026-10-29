# `@midgaard/dashboard`

L'interface d'observation et de décision : la liste des tâches, l'inspecteur avec
sa timeline temps réel, et les boutons d'approbation. React + Vite + Tailwind,
composants dans l'idiome shadcn/ui, recopiés dans `src/components/ui/`.

```bash
npm run build            # compile dans apps/dashboard/dist, servi par le daemon
npm run dashboard:dev    # serveur Vite avec rechargement à chaud
```

## Servi par le daemon, sur la même origine

En production, le daemon sert ces fichiers lui-même. C'est ce qui permet à ses
contrôles `Host` et `Origin` de rester stricts, sans CORS à ouvrir.

En développement, Vite sert la page sur son propre port et **relaie** `/api`,
`/ui` et `/events` vers le daemon, en réécrivant l'en-tête `Origin` : sans cela
le daemon verrait l'origine de Vite et refuserait, à juste titre. Le port du
daemon est lu dans son fichier de découverte au lancement de Vite — démarre le
daemon (`harness start`) avant.

## Authentification

Le dashboard n'a aucun jeton au chargement. Il appelle `/ui/bootstrap`, route
sans jeton mais soumise aux contrôles d'enveloppe du daemon, et garde le jeton
**en mémoire** : ni `localStorage`, ni cookie, ni URL. Pour la WebSocket, le
jeton passe par le sous-protocole — l'API du navigateur ne permet pas de poser
un en-tête `Authorization`.

**Qui demande le jeton, et quand.** `api()` l'obtient lui-même s'il n'en a pas,
plutôt que de compter sur `useHarness`. Ce n'est pas une précaution de style :
React exécute les effets des **enfants avant ceux du parent**, donc `AgentsCard`
demandait ses données avant que `useHarness` n'ait seulement lancé le bootstrap.
Elle recevait deux `401`, son `catch` vide les avalait, et la carte — celle qui
existe pour dire à un nouveau venu qu'aucun fournisseur n'est configuré —
n'apparaissait **jamais** sur son écran d'accueil.

**Le jeton s'oublie à la fermeture de la WebSocket.** Il est régénéré à chaque
démarrage du daemon : le garder faisait réessayer sans fin avec une valeur
périmée, et la page restait « déconnecté » jusqu'à un rechargement manuel. Une
requête de plus à chaque reconnexion, contre une reconnexion qui n'aboutissait
jamais.

Les deux pannes ont été trouvées par `npm run test:ui`, pas par relecture.

## Reprise sans trou

C'est le point délicat du temps réel. Une WebSocket qui se rouvre naïvement
laisse un trou **invisible** : l'affichage paraît cohérent alors qu'il manque des
événements. Le dashboard mémorise donc la dernière séquence globale reçue et la
renvoie dans `?since=` ; le daemon répond par un instantané complet **et** les
événements manqués. Si l'écart est trop grand, il le dit (`truncated`) et le
bandeau l'affiche, au lieu de faire semblant.

Même logique pour la timeline d'une tâche : elle est chargée **entière** à
l'ouverture (`/api/tasks/:id/events`) puis tenue à jour en direct. On n'accumule
jamais les événements d'une tâche jamais ouverte : ce serait un historique
partiel silencieux, commençant au moment de la connexion.

## Les types viennent de `@midgaard/contracts`

Uniquement les **types** : le point d'entrée du paquet charge des modules Node
(`node:os`, `node:fs`) qui n'ont pas leur place dans un paquet navigateur. Les
deux seules valeurs nécessaires — les sous-protocoles WebSocket — sont recopiées
dans `src/lib/useHarness.ts`, avec le commentaire qui le signale.

## Comment c'est vérifié

Deux niveaux, et le second a longtemps manqué :

- `tests/unit/dashboard-format.test.ts` couvre les **fonctions pures** de
  `src/lib/utils.ts` — montants, durées, dates. Aucun rendu.
- `npm run test:ui` (`tests/dashboard.ts`) ouvre un **vrai Chromium** sur un
  **vrai daemon** : l'application démarre, une tâche apparaît sans rechargement,
  la progression avance seule, une approbation donnée au clic débloque la tâche,
  un lien profond survit à un `F5`, et la perte **comme le retour** de la
  connexion se voient. Il lui faut le dashboard compilé et
  `npx playwright install chromium`, que `npm ci` ne fait pas.

Ce que cette suite ne fait **pas** : comparer des pixels. Elle vérifie des
comportements, pas une apparence — une régression visuelle coûte moins cher
qu'une suite qui rougit à chaque retouche de style.

## Organisation

| Fichier | Rôle |
|---|---|
| `lib/api.ts` | Jeton, appels à l'API, erreurs typées |
| `lib/useHarness.ts` | WebSocket, reprise, état du dashboard |
| `components/StatusBar.tsx` | Connexion et santé — un dashboard déconnecté doit le dire |
| `components/TaskList.tsx` | Colonne de gauche |
| `components/TaskInspector.tsx` | État, résultat, erreur, timeline |
| `components/ApprovalPanel.tsx` | Le seul endroit qui débloque une tâche |
| `components/Timeline.tsx` | Le journal, rendu lisible |
