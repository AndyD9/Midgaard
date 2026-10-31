# Slice 5 — Un orchestrateur intégré, sur n'importe quel modèle

**Date :** 2026-10-31 · **Objectif :** qu'une tâche puisse être planifiée et
déléguée par un modèle **autre que Claude**, depuis le dashboard, sans Claude
Code : un profil `orchestrator` qui tourne dans le daemon, sur le fournisseur et
le modèle choisis (Venice, OpenAI, Gemini, compatible OpenAI), et qui délègue
lui-même aux autres profils.

**État : planifiée.** Décisions prises, découpage arrêté, aucune ligne de code.
Elle démarre **après l'étape 8 de la Slice 4** (première publication) : rien
n'est distribué avant d'être durci, et la première version publiée ne doit pas
embarquer un orchestrateur qui n'a pas fait ses preuves.

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
| 1 | Neutraliser « Claude Code » dans ce que lisent les modèles : consignes du Researcher et du Developer, contexte assemblé, message d'erreur | à faire |
| 2 | Contrats et persistance : `kind` `orchestrator`, `parent_task_id` (migration 8), `PATCH /api/agents/:id` pour choisir fournisseur et modèle, `PROTOCOL_VERSION` 10 | à faire |
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
