# Slice 5 — Un orchestrateur intégré, sur n'importe quel modèle

**Date :** 2026-10-31 · **Objectif :** qu'une tâche puisse être planifiée et
déléguée par un modèle **autre que Claude**, depuis le dashboard, sans Claude
Code : un profil `orchestrator` qui tourne dans le daemon, sur le fournisseur et
le modèle choisis (Venice, OpenAI, Gemini, compatible OpenAI), et qui délègue
lui-même aux autres profils.

**État : en cours** (démarrée le 2026-11-01 ; étapes 1 et 2 faites). Avant elle :
décisions prises, découpage arrêté, aucune ligne de code. Elle attendait l'étape 8 de la Slice 4 — ce qui existe
devait avoir fait ses preuves avant qu'on y ajoute un orchestrateur : c'est
fait le 2026-11-01, depuis un clone frais ([SLICE4.md](SLICE4.md)). Les
quatre constats de cet essai sont réglés (leçons n° 30 à 33), dont deux qui la
touchent : la consigne d'approbation d'une sous-tâche se lance d'où qu'on la
lise et vise le bon dossier runtime, et le dashboard dit quelle installation
il sert.

---

## Ce que la Slice 5 renverse

Le document d'origine excluait « l'orchestration autonome depuis le dashboard
sans Claude Code » et voulait un produit « Claude-driven uniquement pour le
MVP » ([MVP_AGENT_HARNESS_PLAN.md](MVP_AGENT_HARNESS_PLAN.md)). Le MVP est
livré ; l'auteur lève cette limite. Claude Code reste un orchestrateur — par
MCP, inchangé — mais n'est plus le seul.

## Les décisions prises avec l'auteur

| Question | Réponse retenue |
|---|---|
| Que veut dire « un autre modèle » ? | **Un orchestrateur intégré au daemon**, et non seulement d'autres clients MCP (Codex, Gemini CLI…) |
| D'où le lance-t-on ? | **Du dashboard seulement** : un formulaire « Nouvelle tâche ». Pas de commande CLI |
| Comment compte-t-il son budget ? | **Budgets séparés** : chaque tâche compte ses propres appels ; pas de plafond d'arbre |
| Quand ? | **Après la Slice 4** |

**Budgets séparés : ce que cela coûte.** Le coût total d'un arbre n'a pas de
plafond déclaré. Il en a un de fait : l'orchestrateur ne peut lancer plus de
`max_steps × max_tool_calls_per_step` sous-tâches, chacune bornée par son
profil. Le dashboard affiche ce **plafond théorique** et le **total de
l'arbre** ; le total porte la plus faible des provenances de ses tâches
(`unknown` dès qu'une l'est) — aucun montant sans sa provenance.

## Ce que le code offre déjà

- `TaskManager.create()` et `wait()` sont des méthodes asynchrones en
  mémoire : une tâche peut en créer et en attendre une autre sans bloquer le
  daemon.
- Approbations, annulation coopérative, encadrement `<untrusted_data>`,
  `tightenLimits` : réutilisés tels quels.
- Manquent : le lien parent → enfant, le choix du fournisseur et du modèle par
  profil (`/api/agents` n'accepte que `GET`), la création d'une tâche hors MCP,
  et un `ToolContext` qui atteigne le `TaskManager`.
- Le serveur MCP ne vérifie nulle part le nom de son client. Trois consignes
  **lues par les modèles** nomment en revanche « Claude Code » (`daemon/src/agents.ts`,
  `agent-runtime/src/context.ts`), plus un message d'erreur du moteur d'agent.

## Décisions de conception

1. **Profondeur 1.** Un orchestrateur délègue à tout profil actif, **sauf**
   `orchestrator`. Pas d'arbre récursif, pas de coût qui s'emballe.
2. **L'orchestrateur n'approuve rien.** Aucun outil d'approbation ne lui est
   donné — le même invariant que pour Claude. Une sous-tâche en
   `waiting_approval` attend l'humain ; l'orchestrateur attend avec elle.
3. **Attendre ne coûte pas d'étapes.** `wait_for_task` bloque en mémoire
   jusqu'à la fin de la sous-tâche, l'annulation ou l'échéance du parent. Pas
   de tranches de 15 s : la coupure à 60 s est propre aux clients MCP, et chaque
   retour au modèle serait une étape payée. Un événement `subtask.waiting` dit
   au dashboard qui le parent attend.
4. **Le résultat d'un enfant est de la donnée.** Encadré en `<untrusted_data>`
   avec nonce avant d'être réinjecté : un Researcher remonte du web.
5. **Aucun orphelin.** Annuler le parent annule ses enfants actifs ; un parent
   qui se termine, pour quelque raison que ce soit, annule ceux qui restent. Au
   démarrage, la règle `interrupted` couvre déjà tout l'arbre.
6. **Les limites restent celles des profils.** L'orchestrateur peut abaisser
   celles d'un enfant (`tightenLimits`), jamais les relever.
7. **Le harness ne merge toujours jamais.** Le résultat de l'orchestrateur
   liste les branches `midgaard/…` de ses Developer ; le merge reste humain.
8. **`parent_task_id` est posé par le daemon seul.** Absent de la requête de
   création : ni MCP ni le dashboard ne peuvent rattacher une tâche à une autre.
9. **`project_dir` saisi au dashboard est une source nouvelle.** Jusqu'ici il
   venait des `roots` du client MCP. Il est canonicalisé, doit exister, être un
   dossier, et n'être ni la racine du système ni le dossier personnel lui-même.
   Les enfants l'héritent du parent, jamais du modèle.

## Découpage

| # | Étape | État |
|---|---|---|
| 1 | Neutraliser « Claude Code » dans ce que lisent les modèles : consignes du Researcher et du Developer, contexte assemblé, message d'erreur | **fait** |
| 2 | Contrats et persistance : `kind` `orchestrator`, `parent_task_id` (migration 8), `PATCH /api/agents/:id` pour choisir fournisseur et modèle, `PROTOCOL_VERSION` 10 | **fait** |
| 3 | Les outils de délégation : `list_agents`, `delegate_task`, `wait_for_task`, `cancel_task` derrière un `DelegationPort` du `ToolContext` — sans lui, ils refusent ; cascade d'annulation | à faire |
| 4 | Le profil `orchestrator` : consigne, outils en lecture plus délégation, ni écriture, ni `exec`, ni web ; désactivé sans fournisseur, avec son motif | à faire |
| 5 | Le dashboard : formulaire « Nouvelle tâche », tâches en arbre, carte « Sous-tâches » (total et plafond théorique), choix du modèle par profil | à faire |
| 6 | Preuves : `test:orchestrator` (vrai daemon, faux fournisseur : délégation parallèle, approbation d'un enfant, annulation en cascade, `SIGKILL`), ajouts à `test:security` et `test:ui`, CI sur trois plateformes | à faire |
| 7 | L'essai réel : un orchestrateur non-Claude lancé du dashboard, un Developer enfant sous approbation, chaque coût comparé à la facture | à faire |

### Ce que chaque étape doit surveiller

- **Étape 3.** Compter les tâches actives en base après l'annulation du parent,
  pas l'effet visible depuis un client : c'est ainsi qu'un bug de verrou était
  passé inaperçu.
- **Étape 5.** Le formulaire ne doit proposer que des profils actifs, et dire
  pourquoi les autres ne le sont pas — un profil sans fournisseur est montré
  désactivé avec son motif.
- **Étape 7.** Le scénario n'est pas prouvé tant qu'il n'a pas tourné contre un
  vrai fournisseur ; ne rien écrire avant de l'avoir constaté.

## Récit

### Étape 1 — ce que lisent les modèles ne nomme plus Claude (2026-11-01)

Trois textes remis aux modèles disaient « Claude Code » : les consignes du
Researcher et du Developer (« An orchestrator (Claude Code) delegated… ») et
l'en-tête du contexte (« This was assembled by Claude Code… »). Ils disent
désormais « an orchestrator », et le contexte « the orchestrator that delegated
this task, from what it already explored » — vrai pour Claude comme pour
l'orchestrateur intégré, qui aura des outils de lecture.

Le message d'erreur du moteur sur un `project_dir` manquant ne s'adresse pas au
modèle mais à l'humain ; il ne nomme plus de client non plus, puisqu'une tâche
naîtra aussi du dashboard. Le cas reste celui d'un serveur MCP trop ancien.

**La preuve porte sur le texte entier, pas sur les phrases retouchées.** Le test
« neutralité envers l'orchestrateur » (`tests/unit/agent-runtime.test.ts`)
assemble, pour chaque profil livré, tout ce que reçoit le modèle — consigne,
limites, worktree, contexte — et refuse `claude` et `anthropic` sans égard à la
casse. Il a été vu échouer en réintroduisant l'ancienne phrase du Developer :
une ligne ajoutée plus tard qui citerait Claude ne passera pas.

Ni la base ni le protocole ne changent : les consignes des profils livrés sont
réécrites à chaque démarrage du daemon (`ensureBuiltinAgents`), et
`PROTOCOL_VERSION` reste 9.

### Étape 2 — contrats et persistance (2026-11-01)

**Ce qui existe.** Le type de profil `orchestrator` ; `tasks.parent_task_id`
(migration 8, clé étrangère `ON DELETE CASCADE` et index) ; `parent_task_id`
sur chaque tâche et dans le `task.created` d'un enfant ; `PATCH
/api/agents/:id` ; `PROTOCOL_VERSION` 10.

**`parent_task_id` n'entre que par le daemon.** Le champ est absent de
`POST /api/tasks` ; zod écarte les clés inconnues, et un test envoie le champ
puis lit la tâche **en base** pour constater qu'elle n'a pas de parent. Le
dépôt l'accepte (`createTask({ parentTaskId })`) et le bus le transmet ; le
`TaskManager` ne le pose pas encore — ce sera l'outil `delegate_task` de
l'étape 3, seul appelant prévu. Un parent inexistant fait lever la clé
étrangère, sans tâche ni événement écrit : c'est un bug du daemon, pas une
saisie.

**`PATCH /api/agents/:id` ne règle que le fournisseur et le modèle.** Les
limites restent hors de l'API, même glissées dans le corps (testé) : le
dashboard est servi à tout onglet qui passe l'enveloppe, et un budget qu'un
client pourrait relever ne protégerait personne. Les règles
(`updateAgentModel`, `daemon/src/agents.ts`) :

- le profil simulé refuse (`409 agent_has_no_model`) ;
- un fournisseur non déclaré est refusé (`404 provider_not_found`, avec la
  liste de ceux qui existent) ; l'accepter, c'était voir le profil désactivé
  au démarrage suivant par `reconcileAgents`, sans erreur visible ;
- changer de fournisseur sans dire de modèle remet le modèle à `null` (celui
  par défaut du nouveau) : un nom de modèle n'a de sens que chez son
  fournisseur ;
- un corps vide est un `400` : il ne demande rien, et l'accepter laisserait
  croire qu'un réglage a été pris ;
- le changement vaut pour les tâches créées ensuite ; une tâche en cours
  garde l'adaptateur reçu à son départ.

**Le type avant le profil.** `orchestrator` est connu des contrats et de la
base dès maintenant, mais aucun moteur ne le sert : un profil de ce type,
même actif, est refusé par `TaskManager.create` (`503 engine_unavailable`)
sans qu'aucune tâche soit créée. Le commentaire de `AGENT_KINDS` l'affirmait ;
un test le prouve (`tests/unit/http-agents.test.ts`).

**Preuves.** `tests/unit/http-agents.test.ts`, nouveau, démarre un vrai daemon
dans le processus de test (coffre fichier, fournisseurs écrits sans clé) et
couvre le `PATCH`, le `parent_task_id` glissé par un client et le refus du
type sans moteur ; `tests/unit/store.test.ts` couvre la migration 8 sur une
base arrêtée au schéma 7, le parent et son récit, et le refus d'un parent
inexistant sans rien écrire.
