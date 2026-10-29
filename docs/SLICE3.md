# Slice 3 — Developer, worktrees, approbations

**Date :** 2026-10-29 · **Objectif (PLAN §7) :** un Developer implémente un
changement dans un worktree isolé, une commande sensible suspend la tâche
jusqu'à décision humaine, le diff est consultable, Claude récupère le résultat.

**État : en cours — étape 1 sur 8 livrée.** Les worktrees existent, sont
enregistrés, et leur diff se calcule ; **aucun agent ne s'en sert encore**. Le
profil `developer`, les outils d'écriture, `exec` et l'onglet Diff sont à faire,
et ce document le dit à chaque endroit où la question se pose.

---

## Les décisions prises avec l'auteur

Quatre questions posées avant d'écrire une ligne. Les deux premières étaient
renvoyées à cette slice par le plan lui-même (§9.4 et §9.5).

| Question | Réponse retenue |
|---|---|
| Comment se termine une tâche Developer ? | **Merge manuel uniquement.** Le harness laisse une branche `midgaard/<tâche>` commitée et son diff ; il ne merge jamais |
| Que deviennent les worktrees ? | **Conservés jusqu'au nettoyage.** Rien n'est supprimé automatiquement ; la branche survit au worktree |
| Où les créer ? | **`~/.midgaard/worktrees/`**, hors de tout dépôt |
| Quelle politique pour `exec` ? | **Approbation par défaut**, liée à l'argv exact. Liste blanche vide d'office |

La quatrième mérite son raisonnement, parce qu'elle s'écarte du plan. Le plan
(§4) prévoyait « `exec` sur allowlist, tout le reste : approbation ». Mais un
agent Developer **écrit** dans son worktree : il peut réécrire `package.json`.
Mettre `npm test` en liste blanche, c'est donc autoriser sans approbation
l'exécution de ce que l'agent a écrit dans `scripts.test`. Une liste blanche par
nom de binaire n'est pas une frontière dès que la commande exécute le code du
projet. D'où le défaut : tout demande une approbation, et l'on n'ajoute à la
liste qu'en connaissance de cause — ce que l'interface devra dire en ajoutant.

---

## Découpage

| # | Étape | État |
|---|---|---|
| 1 | Paquet `workspace` (worktrees, commit, diff, retrait) et table `workspaces` | ✅ livrée |
| 2 | Outils d'écriture bornés au worktree, lecture reroutée sur le worktree, refus d'écrire sous `.git` | à faire |
| 3 | `exec` contrôlé : `execFile`, environnement reconstruit, délai et arrêt du groupe de processus, sortie bornée | à faire |
| 4 | Approbations liées à l'opération exacte (outil, argv, dossier, chemin), affichées telles quelles | à faire |
| 5 | Profil `developer` : worktree préparé en `preparing`, commit de fin à `submit_result`, branche et diff dans le résultat | à faire |
| 6 | Onglet Files/Diff du dashboard, route de diff | à faire |
| 7 | `harness workspaces` (liste, nettoyage), `doctor` vérifie Git | à faire |
| 8 | Bout en bout MCP, puis l'essai d'acceptation du plan : « fais implémenter une route `/health` » | à faire |

L'ordre suit une règle : **rien de ce qu'un agent peut faire n'arrive avant ce
qui le borne.** Les worktrees d'abord (sans eux, écrire n'est pas réversible),
les outils ensuite, le profil qui les assemble en dernier.

---

## Étape 1 — les worktrees

### Ce qui existe

- **`@midgaard/workspace`** : `inspectRepository`, `createWorktree`, `commitAll`,
  `diffWorktree`, `worktreeState`, `removeWorktree`. Détail et garanties :
  [packages/workspace/README.md](../packages/workspace/README.md).
- **Migration 4**, table `workspaces` : une ligne par tâche, jamais supprimée.
  Cycle `active → kept → removed`.
- **Trois événements**, `workspace.created`, `workspace.kept`,
  `workspace.removed`, écrits **dans la même transaction** que la ligne qu'ils
  racontent — le dépôt a gagné un `recordUnlocked` pour cela. Le bus les
  diffuse ; la timeline du dashboard sait les afficher.
- **`keepActiveWorkspaces()`** : au redémarrage, un worktree dont la tâche
  devient `interrupted` passe en `kept`, jamais retiré (PLAN §3 : « son
  worktree est conservé pour inspection »). Le daemon ne l'appelle pas encore :
  il n'existe aucun worktree tant qu'aucun profil n'en crée.
- **`PROTOCOL_VERSION` 5** : le vocabulaire du journal a changé.

### Ce qui le prouve

`tests/unit/workspace.test.ts` — 19 tests sur de **vrais** dépôts Git jetables,
jamais sur des sorties de `git` recopiées. Chaque garantie est vérifiée par son
effet sur le disque. Et cinq tests de dépôt dans `tests/unit/store.test.ts`.

Rien d'antérieur n'a bougé : 198 tests unitaires, 10 d'instance unique, 7
d'intégration, 12 de bout en bout MCP et 7 dans un vrai navigateur, 0 échec,
avec le dashboard recompilé pour les nouveaux libellés de la timeline. Ces
suites prouvent que le changement de protocole et la migration 4 ne cassent
rien ; elles **n'exercent pas** les worktrees, qu'aucun chemin du daemon
n'emprunte encore.

**Contre-épreuve faite** : on a retiré `core.hooksPath`, `--no-verify`,
`--no-gpg-sign` et l'environnement reconstruit, relancé la suite, et constaté
que les quatre tests de sécurité échouaient — puis tout restauré. Un test de sécurité qui passe
aussi sans la protection ne prouve rien ; ceux-ci ne passent pas.

### Ce que l'écriture a appris

**1. `--no-verify` ne ferme pas la porte des hooks.** C'est le réflexe, et il
est faux : il saute `pre-commit` et `commit-msg`, mais `prepare-commit-msg` et
`post-commit` tournent toujours — **constaté** avec Git 2.54, quatre hooks posés,
deux exécutés malgré `--no-verify` — et `git worktree add` lance `post-checkout`. Le
danger est concret : Husky range ses hooks **dans l'arbre de travail**
(`core.hooksPath=.husky`), et dans un worktree cet arbre est écrit par l'agent.
Sans protection, l'agent réécrit `.husky/post-commit`, et le commit de fin de
tâche du harness l'exécute — sans approbation. Seul `-c core.hooksPath=<nul>`,
sur **chaque** commande, ferme tout.

**2. La signature de l'utilisateur est une attestation.** Un utilisateur qui
signe tous ses commits (`commit.gpgsign=true`) aurait vu sa clé apposée sur le
code de l'agent — ou une invite de phrase secrète que personne ne verrait,
bloquant la tâche. Les commits d'agent sont non signés et à l'identité
`Midgaard <agent> <agent@midgaard.invalid>`.

**3. Un diff ordinaire oublie l'essentiel.** `git diff <base>` ignore les
fichiers non suivis — c'est-à-dire, pour un agent qui crée `src/health.ts`, le
fichier même qu'on lui a demandé. `git add -N` réglerait la question en
modifiant l'index de l'agent. Le diff travaille donc sur une copie de l'index.

**4. Le travail en cours de l'utilisateur est hors du worktree, et doit le
rester — mais pas en silence.** Le worktree part du dernier commit. Un agent à
qui Claude décrit une fonction non commitée ne la trouvera pas, et sans le
chiffre `base_dirty` personne ne comprendrait pourquoi. C'est la règle « ne
rien décrire qui n'existe pas », appliquée dans l'autre sens : ne rien taire de
ce qui manque.

**5. Un monorepo ouvert sur un sous-dossier.** Claude Code peut être ouvert sur
`packages/api`. Le worktree, lui, est celui du dépôt entier ; l'agent doit
travailler dans `packages/api` **du worktree**. D'où la colonne `subdir`.

---

## Écarts au plan

1. **Pas de table `projects`, pas de table `artifacts`** (PLAN §6). Un projet est
   le dépôt d'où la tâche est déléguée, déjà porté par `tasks.project_dir` et
   `workspaces.repo_dir`. Le diff d'un worktree se calcule à la demande contre
   son commit de départ : le figer en artefact ferait une seconde vérité, juste
   au moment de l'écrire. L'événement `artifact.created` n'est donc pas créé.
2. **`exec` en approbation par défaut**, et non en liste blanche — voir les
   décisions plus haut.

---

## Ce qui reste ouvert

- **Le `git` de l'agent.** Le plan donne au Developer « `git` dans le
  worktree ». Le commit de fin étant fait par le harness (étape 5), il reste à
  trancher si l'agent a besoin de plus que `status`, `diff` et `log` en lecture.
  À décider à l'étape 2, sur pièce.
- **Les sous-modules** ne sont pas initialisés dans un worktree. Un dépôt qui en
  dépend donnera à l'agent des dossiers vides ; à annoncer quand le profil
  existera.
- **Windows** : le paquet est écrit pour (`os.devNull`, aucun shell), mais
  n'y a jamais tourné. La leçon du coffre — cinq pannes sur trois plateformes,
  invisibles depuis un Mac — s'applique telle quelle, et la suite `workspace`
  devra rejoindre la CI multi-plateforme avant que la slice soit dite terminée.
