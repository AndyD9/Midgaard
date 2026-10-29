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
