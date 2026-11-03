# Slice 6 — Un atelier façon VS Code : discuter avec l'orchestrateur, voir les agents se répondre

**Date :** 2026-11-03 · **Objectif :** que l'utilisateur **converse** avec
l'orchestrateur intégré, que l'orchestrateur et ses Developer **se répondent**
jusqu'à un résultat qui tienne, et que tout cela se **voie**, dans un atelier
façon VS Code. Cet atelier comprend un chat, le fil des échanges entre agents, les
fichiers écrits en direct et la sortie des commandes. Il tourne dans une app
desktop Tauri.

**État : en cours.** Étapes 1 et 2 faites (2026-11-03).

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
| 3 | Boucle orchestrateur ⇄ Developer : proposition, `accept_result`, `send_message`, `ask_parent`, `wait_for_task` sur attente, cascade | à faire |
| 4 | Sortie `exec` en direct, découpée par ligne puis expurgée | à faire |
| 5 | Routes de fichiers en lecture seule (arbre, contenu de travail et de départ) | à faire |
| 6 | Dashboard façon VS Code : explorateur, éditeur et diff, chat et fil des agents, terminal | à faire |
| 7 | Coque Tauri | à faire |
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

