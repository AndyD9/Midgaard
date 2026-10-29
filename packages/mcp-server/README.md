# `@midgaard/mcp-server`

L'adaptateur entre Claude Code et le daemon. Lancé par Claude Code en **stdio**,
une instance par session. Il ne détient **aucune logique métier** : il traduit des
appels d'outils en requêtes HTTP, et retient une seule chose — ce qu'il a déjà dit
à *son* client.

| Outil exposé | Rôle |
|---|---|
| `harness_ping` | Vérifie le daemon, le démarre si besoin |
| `harness_delegate_task` | Crée une tâche, rend son identifiant sans attendre |
| `harness_wait_for_task` | **Bloque** jusqu'à la fin, une nouvelle pause, ou le délai |
| `harness_get_task_status` | État instantané |
| `harness_get_task_result` | Résultat structuré d'une tâche finie |
| `harness_cancel_task` | Annulation explicite |

`harness_list_agents` et `harness_get_project_context`, prévus au plan, arriveront
avec les agents (Slice 2). Annoncer à Claude un outil qui rend du vide serait
exactement l'erreur que ce paquet existe pour ne plus commettre.

## Trois invariants

**Aucun outil d'approbation.** Si Claude pouvait approuver, le contrôle humain
n'aurait plus de sens. Chaque réponse qui signale une pause porte
`approval_instructions` : une consigne complète, destinée à l'humain, que Claude
n'a qu'à transmettre.

**Une pause n'est annoncée qu'une fois par client.** La première annonce rend
`human_approval_pending` ; ensuite l'attente **bloque** jusqu'à la décision. Sans
cela, Claude rappelait l'attente comme la consigne le lui demandait, recevait la
même réponse en deux millisecondes, et renonçait — ou bouclait en consommant des
tokens. C'est le défaut n° 2 de la Slice 0.

**Rien sur stdout.** C'est le canal JSON-RPC. Toute journalisation va sur stderr,
et les mesures d'attente dans `~/.midgaard/mcp-trace.jsonl`.

## L'attente par tranches

Un client MCP coupe un appel d'outil à **60 s** sans notification de progression —
mesuré deux fois. `harness_wait_for_task` enchaîne donc des long-polls de 15 s
vers le daemon et notifie entre chaque. La valeur de `progress` mesure le **temps
écoulé** et non le numéro d'étape : la spécification exige une valeur strictement
croissante, ce qu'un numéro d'étape ne garantit pas.

Interrompre l'attente n'arrête **que l'attente** : la tâche continue. L'arrêter
demande un `harness_cancel_task` explicite.

## Daemon : trouvé, démarré, ou remplacé

Le daemon survit aux sessions. À chaque appel, le serveur l'interroge :

| Réponse | Action |
|---|---|
| Notre version de protocole | On l'utilise |
| Une autre version | On l'arrête et on en démarre un neuf |
| Rien | On en démarre un, **détaché** |

Le cas du milieu n'est pas théorique : en Slice 0, un daemon resté actif après une
mise à jour du code a fait qu'une pause d'approbation n'a jamais été signalée.

## Trace

`~/.midgaard/mcp-trace.jsonl` enregistre chaque attente (client, jeton de
progression, durée réelle, issue) et les capacités annoncées par le client à la
connexion. Elle existe parce que **la suite de tests ne peut pas simuler le vrai
client Claude Code** : c'est en la relisant qu'on a mesuré la coupure à 60 s, et
c'est elle qui dira si le client supporte les « Tasks » MCP natives.
