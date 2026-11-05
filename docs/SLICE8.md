# Slice 8 — Des serveurs MCP pour les agents, et des agents créés à la volée

**Date :** 2026-11-05 · **Objectif :** que l'humain **branche un serveur MCP**
sur Midgaard — le premier visé est [REA](https://github.com/morluto/rea),
« Reverse Engineer Anything » — et que les agents délégués par
l'orchestrateur s'en servent ; et que **l'orchestrateur crée et choisisse ses
agents à la volée** au lieu de piocher dans cinq profils figés.

**État : en cours.** Décisions acceptées par l'auteur le 2026-11-05 ; étape 1
faite le même jour, verte en CI sur macOS, Linux et Windows (passage
`42002800496`) ; étape 2 faite le même jour, verte en CI sur les trois plateformes (passage
`42007433791`).

---

## Ce que la Slice 8 renverse

Jusqu'ici, chaque outil d'un agent est écrit dans ce dépôt : sa politique, sa
frontière (racine, worktree, garde réseau) et ce qu'il écrit au journal sont
connus d'avance. Un serveur MCP externe apporte des outils **écrits par
d'autres**, dont Midgaard ne connaît que le nom, la description et le schéma
— annoncés par le serveur lui-même. REA en est l'exemple franc : il lit un
binaire **où qu'il soit**, lance Ghidra, Hopper ou IDA, écrit des dossiers
temporaires, et ses annotations (`readOnlyHint`, `destructiveHint`) sont, de
son propre aveu, « des indications, pas des contrôles d'autorisation ».

Et jusqu'ici, l'orchestrateur choisit parmi des profils que l'humain a réglés.
Le laisser **en créer** revient à lui laisser choisir un modèle, une consigne
et des outils : il faut que rien de ce qu'il crée ne dépasse ce que l'humain a
ouvert.

## Les décisions prises avec l'auteur (2026-11-05)

| Question | Réponse retenue |
|---|---|
| Quel serveur d'abord ? | **REA** (`rea-agents`), un serveur **stdio** : `node …/scripts/rea.mjs mcp` |
| Que veut dire « attribuer plusieurs agents » ? | **L'orchestrateur crée et choisit ses agents à la volée** |
| Comment approuver un outil MCP ? | **Liste blanche par outil** : l'humain coche à la déclaration ceux qui sont libres ; les autres sont approuvés à chaque appel, arguments exacts sous les yeux ; tout résultat est non fiable |
| Qui se sert d'un serveur MCP ? | **Les profils qui le déclarent.** L'orchestrateur ne les appelle pas lui-même ; il délègue à un agent qui les a |

## Ce que le code offre déjà

- **Le SDK MCP** (`@modelcontextprotocol/sdk`) est déjà une dépendance, côté
  serveur (`packages/mcp-server`) ; son client stdio existe dans le même paquet.
- **La garde des processus** (`tools/src/guard.ts`) tue les groupes qu'un
  daemon mort net n'a pas pu tuer ; **`run()`** (paquet `secrets`) reconstruit
  l'environnement d'un fils à partir d'une liste blanche.
- **Les approbations** portent sur une opération préparée et son empreinte
  (`operation_detail`, JSON canonique), revérifiée au moment d'agir.
- **L'encadrement `<untrusted_data>`** à nonce, l'expurgation (`createRedactor`)
  et la règle « une tâche qui a reçu un contenu encadré rend un résultat non
  fiable » (Slice 5).
- **La délégation parallèle** existe déjà (`delegate_task` sans attente, puis
  `wait_for_task` sur chacune, O1 dans `test:orchestrator`), et
  **`tightenLimits`** ne sait qu'abaisser.
- Manquent : un **client MCP dans le daemon**, une **déclaration** de serveur
  par l'humain, des outils dont le nom n'est connu qu'à l'exécution, et des
  profils qui ne soient pas livrés d'office.

## Décisions de conception

### Les serveurs MCP

1. **Un serveur MCP se déclare par l'humain, jamais par un agent.** CLI
   (`harness mcp add rea -- …`) ou dashboard : commande et arguments **absolus**,
   variables d'environnement déclarées. Le binaire est résolu à la déclaration
   et revérifié au lancement, comme `exec`. Un secret passé en variable va au
   coffre, la base n'en garde que la référence.
2. **stdio d'abord.** C'est le transport de REA et celui que Claude Code gère
   le mieux. Le HTTP local (Streamable HTTP) viendra quand un serveur le
   demandera ; il pose d'autres questions (authentification, adresse jugée).
3. **Un processus serveur par tâche**, sous la garde : lancé au premier appel,
   tué — groupe compris — à la fin, à l'annulation, au délai, et après un
   `SIGKILL` du daemon. Aucun partage entre tâches : l'état d'un serveur (un
   binaire ouvert dans REA) ne fuit pas d'une tâche à l'autre. *À vérifier à
   l'essai : Ghidra démarre en jusqu'à 330 s, et des agents parallèles sur le
   même binaire le paieraient chacun. Un partage par arbre de tâches est la
   piste si c'est intenable.*
4. **Le catalogue est constaté, pas supposé.** « Tester la connexion » lance
   le serveur, fait `initialize` puis `tools/list`, et montre à l'humain les
   outils réellement annoncés. Rien n'est décrit à un agent qu'on n'a pas lu
   chez le serveur.
5. **Liste blanche par outil, et sur ce que l'humain a lu.** Cocher un outil
   enregistre l'**empreinte** de son nom, de sa description et de son schéma.
   Un outil ajouté plus tard, ou dont la description ou le schéma a changé, n'est
   **plus** libre : il redemande une approbation à chaque appel jusqu'à ce que
   l'humain le recoche. Sans cela, un serveur mis à jour changerait ce que
   l'humain a autorisé sans qu'il le sache. Les annotations du serveur sont
   montrées pour aider à cocher, jamais appliquées seules.
6. **Un appel non coché s'approuve sur ses arguments exacts**, expurgés, comme
   l'opération préparée d'`exec`. Refusé, il n'atteint jamais le serveur.
7. **Tout ce qui revient d'un serveur MCP est encadré** en `<untrusted_data>`
   avec un nonce, et la tâche qui le reçoit rend un résultat **non fiable**.
   Le résultat est plafonné en taille avant d'entrer dans la conversation, et
   passe par l'expurgation avant d'être journalisé.
8. **La racine du projet ne vaut pas pour un outil MCP**, et c'est dit. REA lit
   un binaire n'importe où sur la machine ; Midgaard ne peut pas vérifier un
   chemin dans des arguments dont il ignore le sens. Cette limite est écrite à
   l'humain au moment de déclarer le serveur et de cocher ses outils, pas
   découverte après.
9. **Des noms préfixés et sûrs.** Un outil MCP devient `<serveur>__<outil>`
   (`rea__open_binary`) : aucun point, aucun conflit avec un outil intégré, et
   le journal dit de quel serveur vient chaque appel.
10. **Un appel long tient, un appel annulé s'arrête.** Borné par l'échéance de
    la tâche (`ToolContext.deadline`), annulé par `notifications/cancelled`
    puis par la mort du processus. Le délai d'un premier appel Ghidra est
    documenté pour qu'un profil de reverse ait un `timeout_s` qui le permette.
11. **Rattaché à des profils.** Un profil porte `mcp_servers` ; seuls ses agents
    voient ces outils. `list_agents` dit à l'orchestrateur quels serveurs a
    chaque profil, pour qu'il choisisse ; lui n'en appelle aucun.

### Les agents créés à la volée

12. **L'orchestrateur crée un agent par un outil, `create_agent`** : un nom,
    une consigne de rôle, un **type de base** (`researcher`, `developer`,
    `navigator`), un modèle, des serveurs MCP, des limites. Il rend un
    identifiant qu'il passe ensuite à `delegate_task`, autant de fois qu'il
    veut, en parallèle s'il veut.
13. **Rien de créé ne dépasse ce que l'humain a ouvert** :
    - les **outils** sont ceux du type de base, jamais plus ;
    - les **limites** sont abaissées depuis celles du profil de base
      (`tightenLimits`), jamais relevées ;
    - les **serveurs MCP** sont pris parmi ceux que l'humain a ouverts aux
      agents créés (une case par serveur, fermée par défaut) ;
    - le **modèle** est pris parmi ceux d'un fournisseur configuré ; la vision
      d'un Navigator reste **constatée** au catalogue, sinon l'agent est refusé
      avec son motif ;
    - un orchestrateur ne crée jamais d'orchestrateur (profondeur 1, Slice 5).
14. **La consigne de rôle s'ajoute à celle du type, ne la remplace jamais.** Les
    règles qui protègent (`submit_result`, le traitement des contenus non
    fiables, le worktree) restent écrites avant elle. L'humain la lit au
    dashboard, dans l'arbre de la tâche.
15. **Un agent créé appartient à son arbre.** Visible du seul orchestrateur qui
    l'a créé, il refuse toute délégation une fois l'arbre fini ; sa ligne reste
    en base pour l'historique. Claude, par MCP, ne le voit pas.
16. **`agent_id` d'un agent créé n'est posé que par le daemon**, comme
    `parent_task_id` et `mode` : aucune route ne permet de rattacher une tâche
    à l'agent d'un autre arbre.
17. **Un plafond de sous-tâches actives par arbre**, réglable par l'humain
    (défaut proposé : 4). Créer des agents à la volée et les lancer en
    parallèle multiplie la dépense ; le plafond se vérifie **avant** la
    création de la sous-tâche, comme toute limite.

## À trancher avec l'auteur

- **Un budget d'arbre ?** Aujourd'hui, chaque sous-tâche a son propre plafond
  de coût, et l'orchestrateur le sien, sans somme. Avec des agents créés à la
  volée, un plafond sur la **somme de l'arbre** serait la seule protection
  contre un orchestrateur qui crée dix agents. Proposition : oui, porté par le
  profil de l'orchestrateur, vérifié avant chaque appel de modèle de l'arbre.
- **Le processus REA partagé par arbre** (décision 3) si le démarrage de
  Ghidra par tâche se révèle trop lent à l'essai.

## Découpage

| # | Étape | État |
|---|---|---|
| 1 | Le paquet `mcp-client` : lancer un serveur stdio sous la garde, `initialize`, `tools/list`, `tools/call`, annulation, délai ; aucun processus survivant, `SIGKILL` du daemon compris ; éprouvé contre un faux serveur MCP de test | **fait** — 15 tests, vus échouer sans la garde et sans le groupe ; verts en CI sur trois plateformes |
| 2 | La déclaration : migration (serveurs, outils cochés et leurs empreintes), `harness mcp add/list/test/allow/remove`, routes `/api/mcp`, « Tester la connexion » qui lit vraiment le catalogue | **fait** — migration 11, `PROTOCOL_VERSION` 14 ; deux défauts trouvés par la vraie CLI, réglés ; verte en CI sur trois plateformes |
| 3 | Les outils MCP derrière `ToolContext.mcp` : noms préfixés, liste blanche à empreinte, approbation sur arguments exacts, encadrement, plafond, expurgation ; `mcp_servers` sur un profil ; `PROTOCOL_VERSION` | à faire |
| 4 | Les agents créés à la volée : `create_agent`, plafonds (outils, limites, serveurs, modèle, vision), consigne ajoutée, rattachement à l'arbre, plafond de sous-tâches actives | à faire |
| 5 | Le dashboard : page « Serveurs MCP » (déclarer, tester, cocher), serveurs d'un profil, appels MCP dans le fil, agents créés et leur consigne dans l'arbre | à faire |
| 6 | Preuves : `test:orchestrator` (création, délégation parallèle, outil MCP), `test:security` (outil non coché refusé sans atteindre le serveur, empreinte changée → plus libre, agent créé qui tente de dépasser son type, rien de non expurgé en base, aucun serveur vivant après `SIGKILL`), CI sur trois plateformes | à faire |
| 7 | L'essai réel : un orchestrateur sur Venice crée deux agents de reverse sur REA et un Developer, analyse un binaire, rend une synthèse ; coût relevé | à faire |

### Ce que chaque étape doit surveiller

- **Étape 1.** Compter les processus vivants, ceux qu'un serveur MCP lance
  lui-même compris (REA lance Ghidra) : un fils qui quitte son groupe de
  processus échapperait à la garde. Et ne jamais écrire sur la sortie standard
  du daemon ce qui vient du serveur.
- **Étape 2.** « Tester la connexion » doit prouver que le serveur **répond au
  protocole**, pas seulement que le binaire existe (même leçon que la clé
  Venice, Slice 2).
- **Étape 3.** L'empreinte d'un outil coché se compare au catalogue lu **au
  lancement** du serveur de la tâche, pas à celui de la déclaration.
- **Étape 4.** Un agent créé qui demande un outil hors de son type, une limite
  plus haute ou un serveur fermé est **refusé avec son motif**, jamais
  silencieusement réduit : l'orchestrateur doit savoir ce qu'il a obtenu.
- **Étape 7.** Le solde Venice est partagé avec un autre usage (Slice 6) : le
  coût se relève par tâche, et la comparaison au solde se dit faite ou non.

## Récit

### Étape 1 — le client MCP du daemon (2026-11-05)

Le paquet `@midgaard/mcp-client` ([README](../packages/mcp-client/README.md)) :
`McpConnection` (poignée de main, catalogue, appel, arrêt) sur
`GuardedStdioTransport`, et `serverEnv`.

**Le transport du SDK n'est pas employé.** `StdioClientTransport` lance le
serveur dans le groupe du daemon et ne tue que le processus principal : REA
lance Ghidra, qui lui survivrait. Le transport de Midgaard reprend la recette
d'`exec` — groupe à lui, garde armée avant le lancement, groupe inscrit dès
qu'il a un pid, `SIGKILL` au groupe à la fin même si le serveur a quitté
proprement. Le protocole reste celui du SDK (`Client`, `ReadBuffer`).

Ce qui a été tranché en écrivant :

- **Aucune capacité cliente.** `sampling` laisserait un serveur faire appeler
  le modèle de l'agent, donc dépenser en son nom ; `roots` et `elicitation`
  n'ont pas d'usage ici. Un serveur qui les demande reçoit « méthode inconnue ».
- **Une progression ne prolonge pas un appel.** Le délai est le reste de
  l'échéance de la tâche (`resetTimeoutOnProgress: false`) : sans cela, un
  serveur qui annonce sa progression tiendrait la tâche au-delà de son terme.
- **Un délai dépassé n'est pas une panne.** Le SDK prévient le serveur
  (`notifications/cancelled`), la connexion reste utilisable ; seule la sortie
  du serveur la rend inutilisable. Les raisons d'échec sont distinctes
  (`start`, `exited`, `timeout`, `cancelled`, `protocol`) parce que l'outil de
  l'étape 3 ne dira pas la même chose au modèle.
- **La sortie d'erreur du serveur n'est recopiée nulle part.** On en garde la
  fin (8 Kio), non expurgée, pour que le daemon l'expurge avant de la montrer.
- **L'environnement est construit, pas hérité.** Une clé d'API posée dans
  l'environnement du daemon n'atteint pas le serveur : vérifié par le serveur
  lui-même, qui rend la liste de ce qu'il a reçu.

**Les preuves.** `tests/unit/mcp-client.test.ts` (dans `test:unit`), contre
`tests/fake-mcp-server.ts`, un vrai serveur du SDK sur un vrai tube. Le cas du
daemon tué net applique la leçon de la Slice 7 : un serveur stdio quitte
souvent seul quand son entrée se ferme, et un test qui ne regarderait que lui
passerait sans la garde. Il **fige** donc le serveur (`SIGSTOP`) et regarde
aussi un petit-enfant qui ne lit rien. Les 15 tests ont été **vus échouer**
sur deux défauts introduits exprès : sans inscription à la garde, le
petit-enfant survit au daemon tué net ; sans groupe de processus, le serveur
survit à la fermeture.

**Constaté en CI** sur macOS, Linux et Windows (passage `42002800496`) : les
15 tests passent partout, les trois cas de processus compris. Sous Windows,
le serveur n'est pas figé (`SIGSTOP` n'existe pas) : le petit-enfant y
prouve la garde seul.

**Ce qui reste à constater** : le comportement de Ghidra lancé par REA —
reste-t-il dans le groupe ? — à l'essai réel.

### Étape 2 — déclarer un serveur, cocher ce qu'on a lu (2026-11-05)

Contrats (`contracts/src/mcp.ts`), migration 11 (`mcp_servers`,
`mcp_tool_allow`), service du daemon (`daemon/src/mcp-servers.ts`), routes
`/api/mcp`, commande `harness mcp` (`cli/src/mcp.ts`), `PROTOCOL_VERSION` 14
— sans quoi une CLI à jour face à un daemon resté au protocole 13 aurait pris
un 404.

Ce qui a été tranché en écrivant :

- **L'empreinte couvre ce que l'humain a lu** : nom, titre, description,
  schéma d'entrée **et annotations** — un outil qui cesse de se dire
  « lecture seule » a changé. Le schéma de sortie n'en fait pas partie : il ne
  change ni ce que le modèle lit pour décider, ni ce que l'appel peut faire.
  JSON canonique, pour qu'un ordre de clés différent ne la change pas.
- **Redéclarer un serveur efface son catalogue**, mais pas ses outils cochés :
  le test suivant dit lesquels le serveur annonce autrement (`changed`), et ils
  redemandent une approbation à chaque appel jusqu'à ce qu'on les recoche.
- **Un identifiant de serveur n'a pas de souligné** : `rea__open_binary` doit
  se découper sans ambiguïté (décision 9).
- **Les variables secrètes vont au coffre**, sous
  `mcp.<empreinte du dossier runtime>.<serveur>.<nom>` ; le coffre normalise en
  minuscules, d'où le refus de deux noms qui ne diffèrent que par la casse. Les
  variables ordinaires sont en clair, et la CLI le dit.
- **Le programme est résolu par la CLI**, au `PATH` du terminal, et déclaré
  absolu ; le daemon le revérifie à chaque lancement sans le canonicaliser
  (`node` de Homebrew est un lien vers un dossier versionné).
- **`mcp allow --read-only`** propose les outils annoncés en lecture seule et
  non destructifs, que l'humain lit et confirme : les annotations restent des
  indications.

**Ce que le vrai essai de la CLI a trouvé**, que les tests ne voyaient pas —
les tests passaient au programme des arguments absolus :

1. **Un argument relatif ne mène nulle part.** `mcp add fake -- node
   tests/fake-mcp-server.ts` déclarait le script tel quel ; le serveur, lancé
   dans le dossier runtime, ne le trouvait pas. La CLI rend désormais absolu
   tout argument qui a l'air d'un chemin et désigne un fichier existant, et
   l'affiche. Un humain qui tape `-- node ./rea.mjs mcp` serait tombé dessus.
2. **L'extrait de la sortie d'erreur avait perdu la cause.** N'en garder que
   la fin montrait la pile d'appels et coupait « Cannot find module ». Il
   garde désormais le début et la fin (`stderrExcerpt`).

Et deux défauts trouvés par les tests eux-mêmes : un serveur qui échoue à la
poignée de main **perdait sa sortie d'erreur** (la connexion n'existe plus
quand on veut la lire : `McpClientError` la porte désormais, et l'arrêt attend
la fermeture des tubes, pas seulement la sortie du processus) ; et
`checkMcpCommand` jugeait un chemin Windows avec les règles de l'hôte.

**Les preuves.** `tests/unit/mcp-servers.test.ts` (22 tests, dans
`test:unit`), sur un vrai daemon et le faux serveur, qui sait désormais
changer la description d'`echo` et répéter un jeton en échouant. La valeur
secrète est cherchée octet pour octet dans la base, son WAL et le journal :
**vu échouer** en retirant l'expurgation du message d'échec. `test:security`
et `test:restart` restent verts au protocole 14. En CI (passage `42007433791`),
les 22 tests passent sous macOS, Linux et Windows — le refus d'un `.cmd` et
l'expurgation compris. Et la CLI, rejouée de bout en
bout dans un dossier runtime jetable : déclaration, test, `--read-only`, refus
sans terminal, outil devenu `changed` après redéclaration, retrait.

