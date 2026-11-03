# `@midgaard/dashboard`

L'interface d'observation et de décision : la liste des tâches, l'inspecteur avec
sa timeline temps réel, et les boutons d'approbation. Depuis la Slice 5, aussi
l'endroit d'où l'on **lance** une tâche sans Claude Code — un orchestrateur en
particulier, qui ne se lance que d'ici. Depuis la Slice 6, un **atelier façon
VS Code** : conversation avec l'orchestrateur, fil des échanges entre agents,
explorateur et éditeur en lecture seule, terminal de sortie des commandes.
React + Vite + Tailwind, composants dans l'idiome shadcn/ui, recopiés dans
`src/components/ui/` ; CodeMirror 6 pour l'éditeur, xterm.js pour le terminal.

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

## Lancer une tâche, régler un profil (Slice 5)

Trois routes, par le fragment d'URL : `#/tasks/<id>`, `#/new` (formulaire
« Nouvelle tâche ») et `#/agents` (profils).

- **Le formulaire ne propose que des profils actifs**, et nomme les autres avec
  leur motif (`lib/agents.ts`, la même règle que le daemon). Il montre les
  limites du profil sans manette pour les relever, et pour un orchestrateur son
  **plafond théorique** de sous-tâches.
- **Le dossier de projet est vérifié par le daemon** (`checkProjectDir`) : il
  existe, c'est un dossier, ni `/` ni le dossier personnel. Le formulaire
  affiche le motif d'un refus tel quel. Le dernier dossier saisi est retenu
  dans le `localStorage` de ce navigateur — commodité de ce seul poste, qui ne
  porte rien de ce qui doit durer, et dont la page se passe.
- **La vue « Profils » règle le fournisseur et le modèle** de chaque profil,
  par `PATCH /api/agents/:id`. Jamais les limites : l'API ne le permet pas.
- **Les tâches sont un arbre** (`lib/tree.ts`) : chaque sous-tâche suit son
  orchestrateur, en retrait, dans l'ordre où il l'a déléguée. La carte
  « Sous-tâches » montre ce qu'il a délégué, celle qu'il attend (d'après le
  dernier `subtask.waiting`), le **total de l'arbre avec la plus faible
  provenance de ses termes**, et le plafond théorique. Une sous-tâche nomme
  son parent.

## Comment c'est vérifié

Deux niveaux, et le second a longtemps manqué :

- `tests/unit/dashboard-format.test.ts` couvre les **fonctions pures** de
  `src/lib/utils.ts` — montants, durées, dates — et
  `tests/unit/dashboard-tree.test.ts` celles de l'arbre : rangement, total et
  provenance, plafond, motif d'un profil désactivé. Aucun rendu.
- `npm run test:ui` (`tests/dashboard.ts`) ouvre un **vrai Chromium** sur un
  **vrai daemon** : l'application démarre, une tâche apparaît sans rechargement,
  la progression avance seule, une approbation donnée au clic débloque la tâche,
  un lien profond survit à un `F5`, et la perte **comme le retour** de la
  connexion se voient. Depuis la Slice 5 : le formulaire (D9), le choix du
  modèle (D10), et un orchestrateur lancé du formulaire jusqu'à son arbre
  (D11), sur un faux fournisseur. Il lui faut le dashboard compilé et
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
| `components/NewTaskForm.tsx` | « Nouvelle tâche » : profils actifs seulement, dossier vérifié par le daemon |
| `components/AgentsCard.tsx` | Exécutants ; en vue « Profils », fournisseur et modèle de chacun |
| `components/SubtasksCard.tsx` | Sous-tâches d'un orchestrateur, total de l'arbre, plafond théorique |
| `lib/tree.ts` | Arbre des tâches, total et provenance, plafond — fonctions pures |
| `lib/agents.ts` | Motif d'un profil désactivé — fonction pure |

## L'atelier (Slice 6)

```text
 barre d'activité │ tâches ou fichiers │ onglets : Détails │ fichiers │ conversation
                  │                    │ éditeur ou détails           │ (fil + saisie)
                  │                    │ terminal                     │
```

Tout suit **la tâche sélectionnée et son arbre** : la conversation et le
terminal sont ceux de sa racine et de ses sous-tâches, l'explorateur montre le
worktree d'un Developer ou le dossier du projet. Les séparateurs se déplacent à
la souris ; les tailles sont retenues dans `localStorage` (une commodité :
sans stockage, la page fonctionne). Les panneaux sont bornés pour laisser à
l'éditeur au moins 40 % de la fenêtre.

- **Conversation** (`ChatPanel`, `lib/thread.ts`). Le fil est reconstitué du
  journal, événement par événement : messages de l'utilisateur, répliques de
  l'orchestrateur, délégations, questions et propositions des sous-tâches,
  réponses et verdicts. Les notes du harness restent dans la timeline. **La
  saisie ne s'ouvre que lorsque la conversation attend l'utilisateur** : le
  daemon refuse un message à une tâche qui travaille, et le motif s'affiche à la
  place. Le panneau dit qu'une conversation ne survit pas au daemon. Tout le
  texte est rendu comme du texte.
- **Explorateur et éditeur** (`FileExplorer`, `FileView`, `CodeView`,
  `lib/files.ts`). En lecture seule à deux niveaux (`EditorState.readOnly`,
  `EditorView.editable`), et le daemon n'a aucune route d'écriture. Un fichier
  d'un worktree s'ouvre en **diff** contre le commit de départ (deux éditeurs
  côte à côte, parties inchangées repliées). L'arbre et le fichier ouvert se
  rechargent à chaque fin d'outil (`filesVersion`). **« Suivre l'agent »** ouvre
  le dernier fichier écrit, retrouvé dans les arguments journalisés.
- **Terminal** (`TerminalPanel`, `lib/terminal.ts`). xterm.js sans clavier
  (`disableStdin`) : la commande, sa sortie au fil de l'eau (`exec.output`), sa
  fin. **La sortie est nettoyée** : seules les couleurs passent. Une séquence qui
  efface l'écran, déplace le curseur ou réinitialise le terminal (`ESC c`) ferait
  voir à l'humain autre chose que ce qui s'est passé, au moment où il décide
  d'une approbation ; le test unitaire a trouvé `ESC c` et `ESC 7` qui passaient
  au premier jet. Les couleurs du thème (`oklch`) sont converties en `rgb` en
  peignant un pixel, xterm ne lisant pas `oklch`.

Le formulaire « Nouvelle tâche » propose « Conversation », cochée par défaut,
pour un orchestrateur seulement.

Prouvé par `test:ui` (D12 : une conversation ; D13 : fichier ouvert seul, diff
mis à jour sans rechargement, sortie au terminal **pendant** la commande) et
par `tests/unit/dashboard-workbench.test.ts`. Le paquet compilé pèse 1,2 Mo
(387 Ko compressés), CodeMirror et xterm compris : servi en local, il n'est pas
découpé.

