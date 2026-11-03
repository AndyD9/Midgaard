# `@midgaard/daemon`

Source de vérité du harness. Un seul daemon tourne par dossier runtime, quel que
soit le nombre de sessions Claude Code ouvertes.

```text
  session A ─ serveur MCP ─┐
  session B ─ serveur MCP ─┼─ HTTP 127.0.0.1 + jeton ─► daemon ─► SQLite
  CLI harness ─────────────┤                             │
  dashboard ───────────────┘                             └─ WebSocket ─► dashboard
```

| Module | Rôle |
|---|---|
| `daemon.ts` | Assemblage : verrou, base, bus, moteur, HTTP, WebSocket, bail, inactivité |
| `lock.ts` | Instance unique : création atomique du verrou, puis bail vérifié chaque seconde |
| `bus.ts` | **Seul chemin d'écriture** : ce qui est écrit est diffusé |
| `task-manager.ts` | Machine à états en marche ; port de délégation d'un orchestrateur et annulation en cascade (Slice 5) |
| `agents.ts` | Profils livrés, rattachement à un fournisseur, choix du fournisseur et du modèle (`PATCH /api/agents/:id`) |
| `http.ts` | Routeur de l'API locale |
| `ws.ts` | Diffusion temps réel et **reprise sans trou** après coupure |
| `security.ts` | `Host` exact, `Origin` en liste blanche, `Sec-Fetch-Site`, jeton porteur |
| `static-files.ts` | Sert le dashboard compilé, ou explique comment le compiler |
| `main.ts` | Point d'entrée : **seul endroit** qui lit l'environnement |

## Ce qui change depuis la Slice 0

- **L'état est persisté.** Une tâche survit au redémarrage ; celles qui étaient
  actives deviennent `interrupted`, jamais reprises ni considérées réussies.
- **Le daemon s'arrête tout seul** après 30 minutes sans tâche active, sans
  dashboard connecté et sans requête. Celui de la Slice 0 survivait à toutes les
  sessions et finissait par tourner avec du code périmé.
- **La configuration est injectée** : seul `main.ts` lit `process.env`.
- **L'API est préfixée `/api`**, et le dashboard est servi sur la même origine.

## Modèle de menace de l'API locale

Écouter sur `127.0.0.1` ne suffit pas : **le navigateur de l'utilisateur est
local**, et une page malveillante peut lui faire émettre des requêtes. C'est la
menace réelle. Un autre processus du même utilisateur peut de toute façon lire le
fichier de découverte ; on ne prétend pas s'en protéger.

| Défense | Ce qu'elle arrête |
|---|---|
| `Host` exact (`127.0.0.1:<port>`) | DNS rebinding : la page fait pointer son domaine vers la boucle locale |
| `Origin` absente ou celle du dashboard | Requêtes inter-sites, y compris celles sans préflight |
| `Sec-Fetch-Site` ∈ {`same-origin`, `none`} | Confirmation directe par le navigateur |
| Jeton porteur, comparé à temps constant | Tout client qui n'a pas lu `daemon.json` (`0600`) |

Les fichiers d'état sont lisibles du seul utilisateur : `daemon.json`, le
journal et **la base**, en `0600` depuis la Slice 4 — elle était créée selon
l'umask, donc en `0644`, et gardait objectifs, contexte, sorties d'outils et
diffs à la portée des autres comptes du poste. Une base plus ancienne est
resserrée à l'ouverture. Prouvé par `tests/security.ts` (X4), qui vérifie aussi
qu'aucune autre interface que la boucle locale ne répond.

`/ui/bootstrap` et les fichiers du dashboard sont servis **sans jeton** — le
navigateur n'en a aucun avant d'avoir chargé la page — mais restent soumis aux
contrôles d'enveloppe, qui sont précisément ce qui arrête une page hostile.

## Délégation entre tâches (Slice 5)

Une tâche `orchestrator` délègue par le port que lui remet
`TaskManager.delegationFor`. Ce que le daemon garantit :

- **`parent_task_id` n'est posé que par lui.** Aucune route HTTP ne l'accepte ;
  `create` applique les règles d'une sous-tâche : parent actif et
  orchestrateur, enfant qui n'en est pas un (profondeur 1), dossier du parent
  imposé.
- **Aucun orphelin.** Le gérant écoute le bus : dès qu'une tâche passe en
  `cancel_requested` ou dans un statut final, ses sous-tâches actives sont
  annulées. Écouter le bus plutôt que chaque chemin de fin, parce qu'il y en a
  une dizaine et que le bus les voit tous. L'annulation est **différée d'une
  micro-tâche** : le bus diffuse de façon synchrone, et annuler pendant la
  diffusion du parent enverrait à la WebSocket des `seq` dans le désordre.
- **Ce que le modèle écrit dans une délégation est expurgé** — objectif,
  contexte, motif d'annulation — avec le `redact` de la tâche parente, avant
  d'être persisté.
- **Attendre ne coûte rien.** `wait` bloque en mémoire jusqu'à la fin de
  l'enfant, l'arrêt du parent ou son échéance ; une pause d'approbation ne
  l'interrompt pas, et un `subtask.waiting` écrit sur le parent dit au
  dashboard qui il attend.

Prouvé par `tests/unit/delegation.test.ts`, qui compte les tâches actives
**en base** après l'arrêt du parent.

## Conversations (Slice 6)

Une tâche peut attendre un **message** : `waiting_input`, avec ce qu'elle
attend dans `awaiting_input`. Le moteur l'ouvre par
`EngineContext.requestInput`, le gérant écrit la transition et son
`input.requested`. Ce que le daemon garantit :

- **Le mode est posé par lui.** `POST /api/tasks` accepte `conversation: true`
  comme une demande. Le gérant ne pose `chat` que pour un orchestrateur sans
  parent, et refuse (`conversation_unsupported`) autrement. Le champ `mode`
  envoyé par un client est ignoré.
- **Un message n'entre que dans une attente.** `POST /api/tasks/:id/messages`
  refuse `task_not_conversational`, `task_not_awaiting_user` et `empty_message`
  sans rien écrire. Un message glissé pendant que l'agent travaille
  arriverait au milieu de son raisonnement.
- **Le message est expurgé par le moteur**, qui connaît la clé de la tâche,
  puis écrit **avec** la reprise (`waiting_input → running`) en une seule
  écriture. L'agent lit la version expurgée : ce que le journal garde est ce
  qu'il a lu.
- **Une attente oubliée expire.** Le balayage des approbations arrête en
  `timed_out` une conversation sans réponse depuis `MIDGAARD_INPUT_TTL_S`. Une
  annulation passe par `cancel_requested`, et le moteur réveillé conclut.

Prouvé par `tests/unit/conversation.test.ts`, sur le vrai moteur et un faux
fournisseur, en HTTP compris.

La même attente porte **l'échange entre un orchestrateur et ses sous-tâches** :

- **Un Developer délégué par un orchestrateur est en `review`** (`create`). Son
  `submit_result` le met en attente (`proposal`) ; rien n'est commité.
  `accept` (port) l'écrit comme un message du parent (`verdict: accepted`), la
  boucle conclut, et `commitWork` commite. `send` le relance avec un retour.
- **Une question** (`ask_parent`, toute sous-tâche) le met en attente
  (`question`) ; `send` y répond.
- **`waitForEnd` rend la main sur une attente du parent** (`awaiting_you`), et
  `stateFor` y joint la question, ou la proposition et son diff, expurgé par le
  parent.
- **Le parent ne conclut pas** tant qu'un enfant attend : le crochet
  `finishBlocked` du moteur refuse son `submit_result`, que le modèle reçoit.
  S'il s'arrête autrement, la cascade annule l'enfant, sans commit.

Prouvé par `tests/unit/review-loop.test.ts`, sur un vrai dépôt Git : la
branche d'un Developer est relue à **l'instant** où il attend son verdict.
`Daemon.subscribe` existe pour cela : s'abonner au bus du même processus, sans
pouvoir y écrire.

## Installation

`/api/health` annonce `install` : le dossier canonique du paquet
`@midgaard/daemon` et sa version (`installation.ts`, exporté seul par
`@midgaard/daemon/installation` pour que le serveur MCP ne charge pas tout le
daemon). `POST /api/shutdown` accepte `{ "if_idle": true }`, qui rend `409`
tant qu'une tâche est active : c'est ainsi qu'un serveur MCP d'une autre
installation remplace ce daemon sans jamais interrompre de travail.

Le dashboard est servi depuis `apps/dashboard/dist` du dépôt (`npm run build`).

## Instance unique

Verrou créé **avec son contenu** (`link` sur un fichier temporaire portant déjà le
pid), puis bail vérifié chaque seconde : un daemon qui ne lit plus son pid dans le
verrou s'arrête. Deux daemons peuvent coexister au plus une seconde, au démarrage,
sans tâche en cours. Le détail de la course et de sa correction est dans
[`docs/SLICE0.md`](../../docs/SLICE0.md).

## Variables d'environnement

Lues **uniquement** par `main.ts`, via `loadConfig`.

| Variable | Défaut | Effet |
|---|---|---|
| `MIDGAARD_HOME` | `~/.midgaard` | Dossier d'état runtime (base, verrou, journal) |
| `MIDGAARD_PORT` | `7777`, repli sur un port libre | Port d'écoute. Fixé explicitement, un port occupé devient une erreur |
| `MIDGAARD_IDLE_SHUTDOWN_S` | `1800` | Inactivité avant arrêt ; `0` désactive |
| `MIDGAARD_APPROVAL_TTL_S` | `600` | Délai de décision humaine ; au-delà la tâche passe en `timed_out` |
| `MIDGAARD_INPUT_TTL_S` | `7200` | Attente maximale d'une réponse de l'utilisateur dans une conversation ; au-delà, `timed_out` |
| `MIDGAARD_DASHBOARD_DIR` | `apps/dashboard/dist` | Fichiers compilés du dashboard |
