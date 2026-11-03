# Slice 6 — Un atelier façon VS Code : discuter avec l'orchestrateur, voir les agents se répondre

**Date :** 2026-11-03 · **Objectif :** que l'utilisateur **converse** avec
l'orchestrateur intégré, que l'orchestrateur et ses Developer **se répondent**
jusqu'à un résultat qui tienne, et que tout cela se **voie**, dans un atelier
façon VS Code. Cet atelier comprend un chat, le fil des échanges entre agents, les
fichiers écrits en direct et la sortie des commandes. Il tourne dans une app
desktop Tauri.

**État : en cours.** Étapes 1 à 7 faites (2026-11-03).

---

## Ce que la Slice 6 renverse

Jusqu'ici, une tâche se déroulait **en un seul coup** : un objectif, des appels
d'outils, un `submit_result`, la fin. Une réponse sans outil recevait une
relance, puis la tâche échouait (`agent-runtime/src/loop.ts`). Rien ne
permettait d'écrire à une tâche active : le seul blocage sur un humain était
l'approbation.

Le PLAN reportait aussi le shell Tauri « en P1 ». Le terminal intégré du
document d'origine, lui, devait faire tourner Claude Code dans un PTY. L'auteur
rouvre la coque, mais **pas** le PTY : le terminal de la Slice 6 montre ce que
lancent les agents, et n'expose aucun shell.

## Les décisions prises avec l'auteur (2026-11-03)

| Question | Réponse retenue |
|---|---|
| Quelle enveloppe ? | **App desktop Tauri**, autour du dashboard servi par le daemon |
| Que fait le terminal ? | **Sortie des agents, en lecture seule** : les commandes `exec` et leur sortie, en direct. Aucun shell |
| Quelle boucle entre orchestrateur et Developer ? | **Les deux sens** : revue et reprise du travail, **et** questions du Developer en cours de tâche |
| L'éditeur écrit-il ? | **Lecture seule** : l'agent reste le seul à écrire |

## Décisions de conception

1. **Un statut actif de plus : `waiting_input`.** La tâche attend un message.
   `running ⇄ waiting_input`, et l'attente ne sort que vers `running`,
   `cancel_requested`, `timed_out` ou `interrupted`. Le message reçu relance la
   boucle, et c'est elle, pas l'attente, qui conclut. Au redémarrage, la règle
   `interrupted` s'applique comme à tout statut actif : **une conversation ne
   survit pas au daemon**, et l'écran le dira.
2. **Ce qu'attend la tâche est un seul champ, `awaiting_input`** : `chat`
   (l'utilisateur), `question` ou `proposal` (le parent). C'est une propriété du
   statut, posée et effacée par le dépôt.
3. **Le mode d'une tâche est posé par le daemon seul** (`tasks.mode`), comme
   `parent_task_id` :
   - `oneshot` : tout ce qui vient de Claude par MCP, et tout ce qui existait avant ;
   - `chat` : un orchestrateur lancé du dashboard en conversation ;
   - `review` : un Developer délégué par un orchestrateur.
4. **Chat.** En mode `chat`, une réponse sans outil met la tâche en attente au
   lieu de la faire échouer. La fin reste un acte : seul `submit_result` termine.
5. **Revue et reprise.** En mode `review`, le `submit_result` du Developer est
   une **proposition**. Rien n'est commité : l'orchestrateur reçoit résumé et
   diff, encadrés, puis répond par `send_message` (reprise dans le même worktree)
   ou par `accept_result` (le harness commite). **La branche ne bouge qu'à
   l'acceptation.** Pour un Developer `oneshot`, accepter et `submit_result` ne
   font qu'un.
6. **Question.** `ask_parent(question)`, donné aux seules tâches qui ont un
   parent ; l'orchestrateur répond par `send_message`.
7. **`wait_for_task` revient aussi sur une attente de message**, jamais sur une
   approbation. Ce que dit l'enfant est encadré en `<untrusted_data>` ; ce que dit
   le parent est expurgé, sans être encadré, comme l'objectif d'une délégation.
8. **Le `submit_result` de l'orchestrateur est refusé** tant qu'un enfant attend
   sa réponse ou son verdict. Un parent qui s'arrête annule ses enfants, comme
   avant : un enfant qui attendait est annulé, **sans commit**.
9. **Attendre ne consomme pas `timeout_s`** : le délai porte sur le temps actif.
   Une attente de l'utilisateur sans réponse pendant 2 h finit en `timed_out`.
   Étapes et budget se comptent sur toute la conversation, avec les limites du
   profil.
10. **Un message humain est de confiance**, puisque le jeton l'authentifie : il
    n'est pas encadré, mais il est expurgé avant d'être écrit.
11. **Terminal.** La sortie d'`exec` est découpée **par ligne avant
    l'expurgation**, sans quoi un secret coupé entre deux morceaux échapperait
    au motif. Elle est regroupée et plafonnée, puis persistée dans `exec.output`,
    donc rejouée à la reconnexion.
12. **Fichiers en lecture seule**, par la résolution de chemins des outils.
    `.git` est exclu, et aucune route n'écrit.
13. **Tauri, coque mince, sans distribution.** La fenêtre charge
    `http://127.0.0.1:<port>/` : l'origine est celle du dashboard, et
    `security.ts` ne change pas. Aucune capacité Tauri n'est accordée à cette
    page. Midgaard ne se distribue pas (décision du 2026-11-01) : la coque se
    construit depuis le clone.

## Découpage

| # | Étape | État |
|---|---|---|
| 1 | Contrats et persistance : `waiting_input`, `awaiting_input`, `tasks.mode` (migration 9), événements `input.requested`, `message.user`, `message.agent`, `exec.output`, `PROTOCOL_VERSION` 11 | **fait** |
| 2 | Chat : attente d'un message dans la boucle, délai sur temps actif, `POST /api/tasks/:id/messages`, consigne de l'orchestrateur en conversation | **fait** |
| 3 | Boucle orchestrateur ⇄ Developer : proposition, `accept_result`, `send_message`, `ask_parent`, `wait_for_task` sur attente, cascade | **fait** |
| 4 | Sortie `exec` en direct, découpée par ligne puis expurgée | **fait** |
| 5 | Routes de fichiers en lecture seule (arbre, contenu de travail et de départ) | **fait** |
| 6 | Dashboard façon VS Code : explorateur, éditeur et diff, chat et fil des agents, terminal | **fait** |
| 7 | Coque Tauri | **fait** |
| 8 | Preuves : unitaires, `test:orchestrator`, `test:security`, `test:ui`, CI sur trois plateformes | à faire |
| 9 | Essai réel, dans l'app, contre un vrai fournisseur | à faire |

## Récit

### Étape 1 — contrats et persistance (2026-11-03)

**Le statut.** `waiting_input` rejoint `ACTIVE_STATUSES`, entre
`waiting_approval` et `cancel_requested`. Il entre donc d'office dans tout ce
qui compte les tâches actives : `countTasks`, l'arrêt sur inactivité (une
conversation qui attend garde le daemon en vie) et `markInterrupted`.

Ses sorties sont **plus étroites que celles d'une approbation** :
`waiting_approval → cancelled` existe, parce qu'un refus humain arrête la tâche
sur-le-champ. Une attente de message ne connaît que `cancel_requested`. Le
moteur est alors suspendu sur une promesse, et c'est en la résolvant qu'il
constate l'annulation. Le test « ne fait sortir une attente de message que pour
continuer, annuler, expirer ou interrompre » fige la liste.

**Ce qu'on attend, un seul champ.** Un « de qui » et un « pourquoi » se seraient
contredits un jour. `inputFrom()` déduit le premier du second. Le dépôt refuse
deux bugs avant toute écriture : entrer en `waiting_input` sans dire ce qu'on
attend, et poser `awaiting_input` hors de `waiting_input`. Le champ est effacé à
la sortie, quelle qu'elle soit, interruption comprise.

**Le mode.** `tasks.mode` vaut `'oneshot'` pour toute tâche d'avant, écrit en
toutes lettres dans la migration, comme toute valeur d'une migration publiée. Le
`task.created` ne mentionne le mode que s'il diffère de `oneshot` : un récit
d'avant la Slice 6 et un d'après se lisent pareil. Aucun client ne peut encore le
choisir : seul `HarnessStore.createTask` le reçoit, et rien ne le lui passe
encore.

**Les événements.** Quatre types, chacun avec sa charge documentée dans
`events.ts`. Le dashboard leur donne une icône et un libellé (`Timeline.tsx`) :
`Record<EventType, …>` l'impose, et le typecheck l'a rappelé. Le badge et la CLI
colorent `waiting_input` comme une attente, et le dashboard permet d'annuler une
tâche qui attend.

**`nextActionFor` ne change pas.** `waiting_input` y tombe dans « attendre
encore ». Claude ne délègue que des tâches `oneshot`, qui n'y entrent jamais ;
l'attente d'un orchestrateur sur ses enfants aura son propre critère (étape 3).

**`PROTOCOL_VERSION` passe à 11.** Une tâche porte deux champs de plus, que le
serveur MCP et le dashboard valident, et peut prendre un statut inconnu d'un
daemon de protocole 10.

**Vérifié :**
- `npm run typecheck`, dashboard compris ;
- `npm run test:unit` : 416 tests, 0 échec. La matrice complète des transitions,
  la migration 9 sur une base arrêtée au schéma 8, et les deux refus du dépôt
  sont vérifiés sans écrire d'événement. `markInterrupted` emporte une tâche en
  `waiting_input` ;
- `test:orchestrator`, `test:security`, `test:developer`, `test:restart`, `test:ui`
  et `test:wait` : au vert, sans modification.

### Étape 2 — le chat (2026-11-03)

**La boucle.** `LoopHooks.awaitInput` est calqué sur `requestApproval` : une
promesse que le moteur garde (`Running.reply`) et que résolvent `deliver` (le
message), `cancel` ou `stop`. En mode `chat`, la branche « aucun outil
appelé » l'appelle au lieu de relancer puis d'échouer. Le message reçu est
ajouté **au même tableau** de messages : le modèle relit toute la
conversation à chaque tour, et le faux fournisseur, qui choisit sa réplique au
nombre de répliques déjà présentes, le prouve.

**Le délai porte sur le temps actif.** L'échéance est repoussée de la durée
de chaque attente, et celle des outils suit, puisque `exec` borne ses commandes
sur elle. Deux tests à horloge injectée fixent les deux sens : une heure
d'attente ne fait pas expirer la tâche, une heure de travail si.

**Étapes et budget, en revanche, couvrent toute la conversation.** Le
plafond de l'orchestrateur reste celui de son profil (16 étapes par défaut),
réplique comprise. La consigne le dit au modèle (« keep replies short »). Les
valeurs par défaut ne sont pas relevées à cette étape : `ensureBuiltinAgents`
préserve les limites d'un profil existant, et seuls de nouveaux profils
profiteraient d'un relèvement. La question sera tranchée sur les chiffres de
l'essai réel (étape 9), et non avant.

**Ce que lit le modèle.** La consigne du profil, écrite pour une tâche en un
coup, n'est pas réécrite. `buildMessages` lui ajoute un bloc « CONVERSATION »,
présente l'objectif comme le premier message de l'utilisateur et remplace le
pied « When you have the answer, call submit_result ». Le test de neutralité
couvre aussi ce bloc.

**Le message de l'utilisateur.**
- **Accepté seulement dans une attente.** Un message glissé pendant que
  l'agent travaille arriverait au milieu de son raisonnement, sans que l'agent
  sache à quoi il répond. La route le refuse (`task_not_awaiting_user`) plutôt
  que de le mettre de côté. Le dashboard n'ouvrira la saisie qu'en attente
  (étape 6).
- **Expurgé par le moteur**, qui connaît la clé de la tâche, et non par le
  gérant, qui ne la connaît pas. L'agent reçoit **la version expurgée** : ce que
  le journal garde est exactement ce qu'il a lu. Ce choix rend la conversation
  reconstituable depuis le journal, ce dont le fil du dashboard aura besoin.
- **Écrit avec la reprise**, en une seule écriture : `message.user` porte le
  statut `running`.
- **« Conclure »** (`conclude: true`) ajoute la consigne du harness après le
  texte de l'utilisateur. Le journal garde le texte entier, tel que l'agent le lit.

**Le mode reste au daemon.** `conversation: true` est une demande. Le gérant
ne pose `chat` que pour un orchestrateur sans parent. Un exécutant qui
attendrait l'utilisateur au lieu de conclure retiendrait son parent
indéfiniment. Un `mode` envoyé par un client est écarté par le schéma, et un
test le vérifie en HTTP.

**L'oubli.** Le balayage des approbations arrête aussi en `timed_out` une
conversation sans réponse depuis `MIDGAARD_INPUT_TTL_S` (2 h). Il écrit d'abord,
puis réveille le moteur, dont le verdict tombe sur une tâche finie et est
ignoré. Le test vérifie qu'un seul événement de fin est écrit.

**Le faux fournisseur garde la dernière conversation reçue** (`received`).
Le test d'expurgation l'exigeait : son titre affirmait ce que lit l'agent, et
ne vérifiait d'abord que le journal.

**Vérifié :**
- `npm run typecheck` ;
- 8 tests de la boucle (`agent-runtime.test.ts`, « conversation ») ;
- 9 scénarios sur le vrai moteur (`tests/unit/conversation.test.ts`) : deux
  tours puis « Conclure », expurgation côté journal **et** côté agent, refus
  sans écriture, annulation pendant l'attente (0 tâche active en base),
  expiration, HTTP de bout en bout ;
- les suites de bout en bout.

**Pas encore là :** aucune interface. On converse par HTTP seulement ; le
formulaire et le fil arrivent à l'étape 6.

### Étape 3 — la boucle entre agents (2026-11-03)

**Une seule attente pour tout.** La question d'un enfant et sa proposition
reprennent le mécanisme du chat : `waiting_input`, avec `question` ou `proposal`
dans `awaiting_input`. Le crochet `awaitInput` reçoit en plus le corps d'une
proposition, écrit dans son `input.requested`. Le délai de l'enfant s'arrête
pendant qu'il attend, comme en conversation.

**La proposition.** Seul un **Developer** délégué par un orchestrateur passe en
`review` : son résultat est du code, que l'orchestrateur peut relire au diff.
Un Researcher rend toujours son résultat d'un coup ; s'il ne convient pas,
l'orchestrateur en délègue un autre. En `review`, `submit_result` met la tâche
en attente de verdict. Deux suites :
- **renvoyée** (`send_message`) : le modèle lit le retour **en réponse à son
  `submit_result`**, puis recommence dans le même worktree. Le protocole des
  fournisseurs exige de toute façon une réponse à chaque appel d'outil ;
- **acceptée** (`accept_result`) : la boucle rend le résultat tel qu'il a été
  soumis, et `commitWork` commite. L'acceptation s'écrit comme un message du
  parent (`message.agent`, `verdict: accepted`), avec la reprise en `running` le
  temps du commit — c'est ce que fait la tâche.

`accept_result` rend la main une fois l'enfant **fini** : l'orchestrateur a
besoin de la branche et du commit pour les nommer à l'humain, et un
`wait_for_task` de plus lui coûterait une étape.

**L'invariant de branche change de mot, pas de sens** : « la branche ne bouge
qu'à l'acceptation ». Pour un Developer délégué par Claude, accepter et
`submit_result` ne font qu'un. `accept_result` n'est **pas** une approbation :
il ne fait que ce que `submit_result` faisait seul jusqu'ici, rien n'est mergé,
et le merge reste humain. Le test relit la branche **à l'instant** où le
Developer attend son verdict, par `Daemon.subscribe` (ajouté pour cela, en
lecture seule) : deux propositions, la branche au commit de départ les deux
fois, puis un seul commit qui contient les deux passes.

**La question.** `ask_parent` est intercepté par la boucle, comme
`submit_result`, et journalisé comme un appel d'outil, question expurgée. Le
moteur ne l'ajoute qu'aux tâches qui ont un parent, et pas au profil : un
Developer délégué par Claude ne le voit pas. Le faux fournisseur note désormais
les outils proposés, ce qui permet de le vérifier. Une question mal formée est
rendue au modèle sans suspendre la tâche.

**L'orchestrateur relit.**
- `wait_for_task` rend la main quand un enfant attend son parent (`awaiting_you`),
  avec un `next_action` : `answer_question`, `review_proposal`, `result_ready`,
  `task_ended_without_result` ou `wait_again`.
- Une proposition arrive avec son diff contre `base_commit`, non commité, le
  patch borné à 30 Ko et **expurgé par le parent** avant d'entrer dans sa
  conversation. Tout reste `untrusted` et encadré.
- Le `subtask.waiting` n'est plus écrit pour un enfant qui attend déjà son
  parent : ce serait dire l'inverse de ce qui se passe.

**Il ne conclut pas en laissant quelqu'un attendre.** Le crochet `finishBlocked`
du moteur refuse le `submit_result` d'un orchestrateur dont un enfant est en
`waiting_input`, en nommant les enfants et les trois issues (`send_message`,
`accept_result`, `cancel_task`). Sans lui, la cascade emporterait l'enfant et
son travail non commité. S'il s'arrête autrement (annulation, budget, échec), la
cascade annule l'enfant, qui conclut sans commit. Le test le vérifie :
- en comptant les tâches actives en base ;
- en relisant la branche ;
- avec un parent **en conversation**, qui attend l'utilisateur pendant que son
  enfant attend son verdict. Les deux sont à l'arrêt, et l'annulation tombe à
  coup sûr.

**La consigne.** L'orchestrateur reçoit un paragraphe « Review loop » et les
deux outils. Une sous-tâche reçoit, dans le contexte assemblé, ce qu'elle peut
demander et, en `review`, que son `submit_result` est une proposition. La ligne
du worktree dit que le commit vient à l'acceptation.

**Ce que la suite de bout en bout a montré.** O1 (`test:orchestrator`)
déléguait un Developer, l'attendait, puis concluait. Avec la revue, son
`submit_result` est refusé, et le script s'arrêtait là. Le scénario accepte
désormais la proposition : cinq tours, cinq appels de modèle. C'est l'effet
voulu de la décision 7, et le seul scénario existant qu'elle a touché.

**Vérifié :**
- `npm run typecheck` ;
- 5 cas de la boucle (« revue et question au parent ») ;
- 4 cas des outils (`delegation-tools.test.ts`), et les deux nouveaux outils
  refusés sans port ;
- 5 scénarios sur le vrai moteur et un vrai dépôt
  (`tests/unit/review-loop.test.ts`) ;
- les suites de bout en bout, O1 compris après sa mise à jour.

**Pas encore là :** le fil de ces échanges au dashboard (étape 6), et les
scénarios `SIGKILL` d'un enfant qui attend, prévus à l'étape 8.

### Étape 4 — la sortie des commandes en direct (2026-11-03)

**Où est la découpe.** Le plan la mettait dans le moteur. Elle est dans
`agent-runtime` (`OutputBatcher`, `output.ts`), et le moteur ne fait plus
qu'écrire. Deux raisons :
- c'est la boucle qui sait quel appel d'outil tourne et qui tient
  l'expurgation de la tâche ;
- un module pur s'éprouve avec une minuterie manuelle, sans daemon ni attente
  réelle.

Le chemin est donc le suivant :
1. `runCommand` passe chaque morceau lu à `onOutput` ;
2. `exec` le branche sur `ToolContext.output`, que la boucle pose pour **un**
   appel ;
3. la boucle livre les lots à `onToolOutput` ;
4. le moteur les écrit en `exec.output`, avec le `tool_call_id` de l'appel, sans
   changer de statut.

**Découper avant d'expurger.** C'était le défaut annoncé (décision 11), et le
test l'a montré pour de bon. En expurgeant chaque morceau seul, une clé écrite
en deux fois par une vraie commande, à 300 ms d'écart, laisse sa première
moitié dans le journal : le test de bout en bout échoue, comme celui du
préparateur seul. Avec la découpe par ligne, la base est lue en entier, et ni la
clé ni sa moitié n'y sont. Le décodage se fait aussi par flux : un « é » coupé
entre deux morceaux devenait deux caractères de remplacement.

**Ce qui n'est pas couvert, et qui est dit.** Une ligne sans fin est livrée
par tranches de 4096 caractères, sans quoi une barre de progression ne
s'afficherait jamais. Une clé à cheval sur une de ces coupures passerait. C'est
la limite écrite en tête de `output.ts`, pas une promesse.

**Regrouper, plafonner.**
- Un lot par flux et par quart de seconde : cinquante lignes font un
  événement, pas cinquante, et la reprise WebSocket (2000 événements au plus)
  le supporte.
- Au-delà de 128 Ko par commande, plus rien n'est écrit, et le dernier lot le
  dit, avec le nombre d'octets manquants (`omitted_bytes`).
- Le modèle, lui, lit toujours la capture tête et queue d'`exec`, inchangée.

**Un observateur ne casse rien.** Si `onOutput` lève, l'erreur est journalisée,
et la commande et sa capture continuent.

**Vérifié :**
- `npm run typecheck` ;
- 6 cas du préparateur, à minuterie manuelle ;
- une vraie commande lancée par un Developer dans un vrai daemon, en liste
  blanche, donc sans approbation. La première ligne est en base **plus de
  800 ms** avant la fin de la commande, chaque lot est rattaché à son appel, et
  la base ne contient ni la clé ni sa moitié ;
- le test de la clé coupée et celui de la vraie commande **vus échouer** sans la
  découpe, puis repasser ;
- `test:worktrees` comprend désormais ce fichier : la CI le rejouera sur les
  trois plateformes, là où les tubes de Windows découpent autrement ;
- les suites de bout en bout.

**Pas encore là :** le terminal du dashboard (étape 6). D'ici là, la sortie
apparaît dans la timeline, ligne par lot.

### Étape 5 — les fichiers d'une tâche, en lecture seule (2026-11-03)

**Deux routes, aucune écriture.**
- `GET /api/tasks/:id/files` rend l'arbre d'une tâche : son worktree si elle en
  a un, son dossier de projet sinon.
- `GET /api/tasks/:id/files/content?path=&rev=work|base` rend un fichier sur le
  disque ou au commit de départ.

Toute autre méthode répond 405. Le dashboard y trouvera les deux côtés d'un
diff : un fichier créé ou supprimé par l'agent rend `exists: false` de l'autre
côté, sans erreur.

**Un chemin venu de HTTP est traité comme celui d'un modèle.** Il est vérifié
avant tout accès au disque : relatif, sans `..`, `\` lu comme `/` (séparateur
sous Windows, caractère sous POSIX), sans `.git`. Il est ensuite résolu et
ouvert par `resolveUnderRoot` et `openUnderRoot`, les outils des agents. Un
refus ne dit pas où mène un lien.

**`.git`, jusque sur le chemin réel.** C'est ce que le test a trouvé. Un lien
posé dans le worktree (`lien-git → .git`) mène sous la racine : `openUnderRoot`
l'accepte, puisque la cible est sous la racine. Sans relire le chemin **réel**
après l'ouverture, la route rendait le fichier `.git` du worktree, qui désigne
le dépôt de l'utilisateur. L'agent ne peut pas poser ce lien avec ses outils,
mais une commande approuvée le pourrait. La relecture est faite, et le test vu
échouer sans elle. La règle vaut en toute casse : un système de fichiers
insensible à la casse ouvre `.GIT/config`.

**La version de départ, sans rien lancer.** Elle est lue par
`git cat-file blob`, qui n'applique ni filtre ni `textconv`, à travers `git()`,
qui neutralise les hooks. Sa taille est lue d'abord (`cat-file -s`) : un fichier
trop gros n'est pas transféré.

**Ce que le contenu ne rend pas.** Un binaire (un octet nul) et un fichier de
plus de 1 Mo rendent leur taille, sans leur contenu (`binary`, `too_large`).
L'arbre ne suit aucun lien, replie `node_modules` et ses pareils, et se coupe à
5000 entrées en le disant (`truncated`).

**Vérifié :**
- `npm run typecheck` ;
- 20 tests en HTTP sur un vrai daemon et un vrai dépôt
  (`tests/unit/task-files.test.ts`) : un Developer modifie, crée et supprime ;
  binaire et fichier trop gros ; dix chemins hostiles refusés dans les deux
  versions ; un lien vers l'extérieur et un lien vers `.git` ; aucune méthode
  d'écriture ;
- le fichier est ajouté à `test:worktrees`. Sous Windows, les deux tests de
  liens sautent en le disant : y créer un lien demande des droits
  d'administrateur ;
- les suites de bout en bout.

**Pas encore là :** l'explorateur et l'éditeur qui s'en servent (étape 6).

### Entre les étapes 5 et 6 — la CI, et un test qui comptait sur le temps (2026-11-03)

Les étapes 1 à 5, poussées ensemble, ont passé « Worktrees » sur les trois
plateformes (passage `41647596672`), et « Bout en bout » sur macOS et Windows.
Sous Linux, un test **ancien** a échoué (`41647596699`) : `static-files.test.ts`
attendait 30 ms, en dur, que le fichier servi s'écoule dans une fausse réponse.
Sur un runner chargé, le corps est arrivé vide. La fausse réponse résout
désormais une promesse à son `end`, et le test l'attend, avec une borne de 5 s
désarmée ensuite. Il dure 0,3 s. Rien de la Slice 6 n'était en cause.

### Étape 6 — l'atelier façon VS Code (2026-11-03)

**La disposition.**
- Une barre d'activité : Tâches, Fichiers, Terminal, Conversation.
- Un panneau latéral, qui montre la liste des tâches ou l'explorateur.
- Une zone d'onglets : « Détails », l'inspecteur d'avant, puis un onglet par
  fichier ouvert.
- Le terminal en bas, la conversation à droite.

Tout suit la tâche sélectionnée **et son arbre**. Les séparateurs se déplacent,
et les tailles sont retenues. Les panneaux sont bornés à la largeur de la
fenêtre : dans un panneau de 800 px, le premier jet écrasait l'éditeur.

**Ce que l'atelier réutilise.** Il n'ajoute aucune route. Le fil, le terminal
et l'explorateur sont composés du journal par trois modules purs
(`lib/thread.ts`, `lib/terminal.ts`, `lib/files.ts`), et des deux routes de
fichiers de l'étape 5. Le fil n'invente rien : chaque élément est un événement,
à son `seq`.

**Trois choix qui protègent.**
- **La saisie ne s'ouvre que lorsque la conversation attend l'utilisateur.**
  Un champ ouvert qui refuse ensuite ferait croire à une panne ; le motif
  s'affiche à la place.
- **L'éditeur est en lecture seule à deux niveaux**, et le daemon n'a de toute
  façon aucune route pour écrire.
- **Le terminal ne laisse passer que les couleurs.** La sortie vient de
  commandes lancées dans un worktree que l'agent a écrit, et l'humain la lit
  pour décider d'une approbation. Une séquence qui efface l'écran ou réécrit une
  ligne lui ferait voir autre chose que ce qui s'est passé. Le test unitaire a
  trouvé au premier jet que `ESC c` (réinitialisation complète) et `ESC 7`
  (sauvegarde du curseur) passaient : le motif n'en retirait qu'une partie.

**« Suivre l'agent ».** Le dernier fichier écrit est retrouvé dans les
arguments journalisés de `write_file`, `edit_file` et `delete_file`. Ces
arguments sont tronqués à 4000 caractères, donc pas toujours du JSON entier :
le chemin est lu par motif. Un point marque ce fichier dans l'arbre, et il
s'ouvre seul, en diff contre le commit de départ, tant que la case est cochée.

**Le formulaire** propose « Conversation » pour un orchestrateur, cochée par
défaut, et son champ devient « Premier message ».

**Ce qui a été vu à l'écran.** Sur la base réelle de l'auteur, la tâche de
l'essai de la Slice 5 se relit dans l'atelier :
- le fil : l'orchestrateur délègue au Developer, puis leurs deux résultats ;
- le terminal : `npm test` sous approbation, puis « code 0 en 0.4 s » ;
- l'explorateur : le worktree conservé, `test/app.test.js` ouvert seul en diff,
  la route ajoutée en vert.

**Le poids.** CodeMirror et xterm portent le paquet à 1,2 Mo (387 Ko
compressés). Pour une application servie en local, il n'est pas découpé.

**Vérifié :**
- `npm run typecheck` ;
- 10 tests des modules purs (`tests/unit/dashboard-workbench.test.ts`) ;
- `test:ui` : 13 scénarios, dont D12 (une conversation, saisie ouverte puis
  refermée) et D13. D13 prouve que le fichier écrit s'ouvre seul, que son diff
  passe de v1 à v2 **sans rechargement**, et que la première ligne d'une
  commande est à l'écran pendant que la tâche tourne encore, la seconde pas
  encore. D11 passe avec la case « Conversation » cochée ;
- les suites de bout en bout.

**Pas encore là :** la coque Tauri (étape 7).

### Après l'étape 6 — la CI, verte sur les trois plateformes (2026-11-03)

Passages `41651166106` (Worktrees), `41651165982` (Bout en bout) et
`41651165977` (Coffre), sur `f81e5db` : tout vert sous macOS, Linux et
Windows. Le test des fichiers statiques passe sous Linux, et D12 et D13 passent
sur les trois systèmes.

### Étape 7 — la coque Tauri (2026-11-03)

**Une coque mince.** `apps/desktop` (Tauri 2.12.5) ne contient aucune logique
du harness. Au lancement, elle :
1. démarre le daemon, ou s'y rattache, par la CLI du clone (`harness start`) ;
2. lit `dashboard_url` dans `daemon.json` ;
3. ouvre une fenêtre dessus.

Elle n'arrête pas le daemon en se fermant : il s'arrête de lui-même après son
délai d'inactivité, comme pour un onglet fermé.

**Pourquoi charger l'URL du daemon plutôt qu'embarquer le dashboard.** Une
page embarquée aurait l'origine `tauri://localhost`, que `security.ts` refuse.
L'accepter aurait ouvert la liste blanche des origines à quiconque peut servir
une page sous ce schéma. En chargeant `http://127.0.0.1:<port>/`, la fenêtre a
l'origine que le daemon accepte déjà : ses contrôles ne changent pas, et le
dashboard est le même dans la fenêtre et dans un navigateur.

**Ce que la page ne reçoit pas.**
- Aucune capacité Tauri (`capabilities: []`) et aucun plugin : elle n'a pas
  d'IPC.
- Aucune navigation hors de l'origine du dashboard (`on_navigation`), ni par
  un lien ni par une redirection. Un fichier déposé sur la fenêtre est
  intercepté par le gestionnaire de Tauri, sans effet faute d'IPC. Le premier
  jet appelait `disable_drag_drop_handler`, en croyant désactiver le dépôt de
  fichiers ; cette option fait l'inverse : elle rend le dépôt au webview, qui
  tente d'ouvrir le fichier. Elle est retirée.
- Aucune adresse hors de la boucle locale : un `daemon.json` modifié qui
  annoncerait une page distante est refusé. Trois tests Rust le fixent
  (`npm run test:desktop`).
- Le jeton du fichier de découverte n'est ni retenu ni passé à la fenêtre :
  seule `dashboard_url` en est gardée.

**Le piège du `PATH`.** Une application ouverte d'un double-clic n'hérite pas
du `PATH` du terminal. `build.rs` grave donc le chemin du `node` de npm
(`npm_node_execpath`) et la racine du clone. `npm run desktop` passe en plus le
`node` courant et `--home`. Constaté : le chemin gravé est le chemin **réel**,
`/opt/homebrew/Cellar/node@24/24.18.0/bin/node`. Une mise à jour de Node par
Homebrew le rend donc caduc, et `DEPANNAGE.md` le dit.

**Lancée par la CLI.** `npm run desktop` est une commande de la CLI
(`harness desktop`), et non un script à part : elle est vérifiée par le
typecheck, et dit quoi faire si la coque n'est pas construite. `doctor` signale
l'état de la coque, sans jamais échouer pour elle : elle est facultative.

**Rien n'est distribué** (décision du 2026-11-01) : ni signature, ni
notarisation, ni installeur (`bundle.active: false`). Le binaire, de 5,3 Mo,
reste dans `src-tauri/target/release/`.

**Vérifié, sur la machine de l'auteur (macOS) :**
- `npm run desktop:build` : 1 min 51 s la première fois, 1 min ensuite, sans
  avertissement ;
- `npm run desktop` ouvre une fenêtre « Midgaard » de 1440 × 900, rattachée au
  daemon déjà lancé (même pid). Le processus réseau WebKit de la fenêtre tient
  une connexion établie au port 7777 : la WebSocket du dashboard ;
- `npm run test:desktop` : 3 tests ;
- `npm run doctor` : « Coque desktop construite ».

**Pas encore là :** `cargo check` de la coque en CI sur les trois plateformes
(étape 8).

