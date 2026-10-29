# Slice 3 — Developer, worktrees, approbations

**Date :** 2026-10-29 · **Objectif (PLAN §7) :** un Developer implémente un
changement dans un worktree isolé, une commande sensible suspend la tâche
jusqu'à décision humaine, le diff est consultable, Claude récupère le résultat.

**État : en cours — étapes 1 et 2 sur 8 livrées.** Les worktrees existent, sont
enregistrés, et leur diff se calcule ; les outils d'écriture existent et
refusent tout hors d'un worktree. **Aucun agent ne s'en sert encore** : aucun
profil n'a de worktree. Le profil `developer`, `exec` et l'onglet Diff sont à
faire, et ce document le dit à chaque endroit où la question se pose.

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
| 2 | Outils d'écriture bornés au worktree, refus d'écrire sous `.git`, `git_diff` en lecture | ✅ livrée |
| 3 | `exec` contrôlé : `execFile`, environnement reconstruit, délai et arrêt du groupe de processus, sortie bornée | à faire |
| 4 | Approbations liées à l'opération exacte (outil, argv, dossier, chemin), affichées telles quelles | à faire |
| 5 | Profil `developer` : worktree préparé en `preparing`, lecture et écriture reroutées sur le worktree, commit de fin à `submit_result`, branche et diff dans le résultat | à faire |
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

## Étape 2 — écrire, seulement dans le worktree

### Ce qui existe

- **`write_file`, `edit_file`, `delete_file`** (`packages/tools/src/write.ts`),
  et **`git_diff`** (`packages/tools/src/git.ts`), dans la boîte à outils.
- **`ToolContext.writable`** et **`ToolContext.workspace`**, facultatifs et
  **fermés par défaut**. Le moteur des agents les pose explicitement à `false`
  et `null` : aucun profil n'a encore de worktree, donc rien ne s'écrit nulle
  part. Le déplacement de la racine sur le worktree est l'affaire du profil
  `developer` (étape 5) — c'est pourquoi la ligne « lecture reroutée » a changé
  d'étape dans le découpage.

Détail des vérifications de chemin : [packages/tools/README.md](../packages/tools/README.md).

### Ce qui le prouve

`tests/unit/write-tools.test.ts` — 19 tests, chaque refus vérifié **par son
effet** : le fichier visé hors de la racine garde son contenu, rien n'apparaît
dehors, `.git` reste intact, le lien n'est pas remplacé. Plus un test de boucle
(`agent-runtime.test.ts`) : un profil qui aurait reçu `write_file` par erreur
voit l'appel refusé, **sans** demande d'approbation. 218 tests unitaires en
tout.

**Contre-épreuve faite**, protection par protection : politique toujours
ouverte, segment `.git` ignoré, dossier-lien non vérifié, lien non refusé,
`replace` au lieu de `split` — chacune fait échouer deux à quatre tests. Et
les deux serrures contre les liens (`lstat` avant, `O_NOFOLLOW` à l'ouverture)
tiennent **chacune seule** : c'est ce qui rend acceptable leur absence partielle
sous Windows, où `O_NOFOLLOW` n'existe pas.

### Une question tranchée : le `git` de l'agent

L'étape 1 laissait ouvert ce que l'agent recevrait de Git. Réponse : **`git_diff`,
sans argument, et rien d'autre.**

- **Le commit est un acte du harness**, à `submit_result` (étape 5). La branche
  ne bouge qu'à ce moment-là, comme la fin d'une tâche n'arrive que par lui.
- **`status` et `log` n'apprennent rien** que ce diff — commits, modifications
  et fichiers nouveaux — ne dise déjà.
- **Chaque argument de `git` est une surface** : `-c` réécrit la configuration,
  `--upload-pack` lance un programme, `--output` écrit où l'on veut, et les
  alias de l'utilisateur sont des commandes. Un outil `git` à arguments libres
  demanderait de tous les filtrer ; un outil qui n'en prend aucun n'a rien à
  filtrer.

### Ce que l'écriture a appris

**6. `.git` est un fichier dans un worktree, et c'est une cible.** Il contient
`gitdir: …`, l'adresse du dépôt. Un agent qui le réécrit redirige chaque
commande Git du harness — le commit de fin compris — vers le dépôt de son choix,
celui de l'utilisateur par exemple. Tout segment `.git`, casse ignorée (les
systèmes de fichiers par défaut de macOS et Windows ne la distinguent pas), est
refusé en écriture et en suppression.

**7. Un refus tardif ne doit rien avoir détruit.** Ouvrir avec `O_TRUNC` puis
constater que le parent a changé aurait vidé le fichier qu'on refusait d'écrire.
Le fichier est ouvert sans troncature et vidé une fois tout vérifié.

---

## Écarts au plan

1. **Pas de table `projects`, pas de table `artifacts`** (PLAN §6). Un projet est
   le dépôt d'où la tâche est déléguée, déjà porté par `tasks.project_dir` et
   `workspaces.repo_dir`. Le diff d'un worktree se calcule à la demande contre
   son commit de départ : le figer en artefact ferait une seconde vérité, juste
   au moment de l'écrire. L'événement `artifact.created` n'est donc pas créé.
2. **`exec` en approbation par défaut**, et non en liste blanche — voir les
   décisions plus haut.
3. **Pas d'outil `git` généraliste** (PLAN §4 : « `git` dans le worktree »),
   seulement `git_diff` — voir l'étape 2.

---

## Ce qui reste ouvert

- **Les sous-modules** ne sont pas initialisés dans un worktree. Un dépôt qui en
  dépend donnera à l'agent des dossiers vides ; à annoncer quand le profil
  existera.
- **Windows** : le paquet est écrit pour (`os.devNull`, aucun shell), mais
  n'y a jamais tourné. La leçon du coffre — cinq pannes sur trois plateformes,
  invisibles depuis un Mac — s'applique telle quelle, et la suite `workspace`
  devra rejoindre la CI multi-plateforme avant que la slice soit dite terminée.
