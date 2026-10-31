# Slice 4 — Durcissement et distribution

**Date :** 2026-10-30 · **Objectif (PLAN §7) :** installable par un tiers en une
commande, scénario de démo du document d'origine (§12) rejoué sans terminal
intégré. En chemin : tests de sécurité ciblés, scénarios de crash et de reprise,
deux tâches concurrentes sur des worktrees distincts, README et guide de
dépannage.

**État : en cours.** Décisions prises, découpage arrêté ; étapes 1 à 6 livrées. Rien n'est publié.

---

## Les décisions prises avec l'auteur

Quatre questions posées avant d'écrire une ligne.

| Question | Réponse retenue |
|---|---|
| Sous quelle forme publier ? | **Un seul paquet, `midgaard`**, binaire `harness`, qui embarque le `dist/` de tous les paquets internes. Ceux-ci restent privés |
| Qui publie ? | **La CI, sur tag `v…`**, par la publication de confiance npm (OIDC) avec attestation de provenance |
| `edit_file` dans un dépôt CRLF ? | **Tolérer les fins de ligne** à la recherche ; le remplacement reprend celles du fichier |
| L'essai d'acceptation sous Windows ? | **CI seulement.** Aucun poste Windows : l'essai réel n'y sera pas joué, et la documentation le dira |

**Un paquet plutôt que dix.** Le PLAN annonçait `npm i -g @midgaard/harness`,
mais les dix paquets du workspace n'ont rien à faire séparément chez un tiers :
les publier tous, c'est dix versions à garder en phase, et une installation
mixte possible — un `daemon` d'une version avec un `contracts` d'une autre.
Un seul tarball ne peut pas se désaccorder avec lui-même. Le nom `midgaard`
était libre le 2026-10-30, comme le scope `@midgaard` ; le nom nu évite de
créer l'organisation npm.

**La CI publie, pas un poste.** La publication est un acte public et
irréversible (une version publiée ne se republie pas sous le même numéro).
Sur tag, depuis la CI, le tarball est construit depuis le commit taggé et
rien d'autre, et l'attestation de provenance le prouve à qui l'installe.
*À vérifier à l'étape 7, pas encore constaté* : la publication de confiance se
configurerait sur la page d'un paquet **existant**, ce qui imposerait de
publier la toute première version à la main.

**Windows en CI seulement.** Le PLAN (§8) demande l'essai d'acceptation sur
macOS puis Windows. Faute de poste, le daemon de bout en bout, le dashboard et
la CLI tourneront en CI sur les trois plateformes, face au faux fournisseur ;
c'est une preuve de fonctionnement, pas d'ergonomie. Le README dira « éprouvé
en vraie session sous macOS ; sous Windows et Linux, en CI seulement » — c'est
la règle de `dashboard_available` : ne rien annoncer qu'on n'a pas constaté.

---

## Découpage

| # | Étape | État |
|---|---|---|
| 1 | `doctor` en lecture seule : il diagnostique la base sans la migrer, et dit « base à migrer » | ✅ livrée |
| 2 | Ce que le worktree ne montre pas : `edit_file` tolérant aux fins de ligne ; sous-modules absents, signalés à l'agent et au dashboard | ✅ livrée |
| 3 | La suite de sécurité du PLAN §8.4, point par point : chaque refus prouvé par un test qui l'observe directement, les trous comblés | ✅ livrée — quatre défauts réels trouvés |
| 4 | Crash et concurrence : daemon tué en plein Developer (tâche `interrupted`, worktree conservé, branche au commit de départ) ; deux Developer concurrents sur deux worktrees | ✅ livrée — une commande survivait au daemon, et le diff perdait des modifications |
| 5 | Le daemon de bout en bout, le dashboard et la CLI en CI sur macOS, Linux et Windows | ✅ livrée — trois postes au vert au deuxième passage |
| 6 | Le paquet `midgaard` : tarball unique, `npm pack` installé dans un préfixe vierge puis `harness init`, `doctor` et un aller-retour MCP — sur les trois plateformes | ✅ livrée — 6/6 sur les trois plateformes du premier coup |
| 7 | La publication : workflow sur tag, provenance ; README d'installation et guide de dépannage | à faire |
| 8 | L'essai d'acceptation : installé depuis npm sur un `HOME` vierge, le scénario §12 rejoué depuis Claude Code sous macOS | à faire |

L'ordre suit une règle : **rien n'est distribué avant d'être durci.** Les
dettes que la Slice 3 a laissées d'abord (étapes 1 et 2), la preuve que les
frontières tiennent ensuite (3 et 4), puis les plateformes que seul un tiers
aurait rencontrées (5), et le paquet en dernier — un paquet publié est le seul
livrable qu'on ne peut pas reprendre.

### Ce que chaque étape doit trancher ou surveiller

- **Étape 8.** Un `HOME` vierge, pas seulement un `MIDGAARD_HOME` : c'est la
  seule façon de voir ce que voit un tiers (aucun fournisseur, aucun coffre
  rempli, aucun `.mcp.json`).

---

## Étape 1 — `doctor` en lecture seule

### Ce qui existe

- **`HarnessStore.openReadOnly`** : ouvre une base existante avec
  `readOnly: true`, sans migration ni `PRAGMA` qui écrive ; `schemaVersion` dit
  où elle en est. C'est SQLite qui refuse l'écriture, pas une convention : une
  méthode d'écriture appelée par erreur lève. Une base absente n'est jamais créée.
- **`doctor`** ouvre la base une fois, en lecture seule. Selon son schéma :
  à jour, il la lit comme avant ; **plus ancien**, il avertit « à migrer (rien
  n'a été écrit) », renvoie vers `harness start` — le daemon migre à son
  démarrage — et omet les contrôles qui la lisent ; **plus récent**, il échoue.
  Le verdict est `schemaCheck`, une fonction pure.
- **`status`** aussi, qui avait le même défaut sans que personne l'ait noté :
  sur une base d'un autre schéma, il le dit et rend `1` au lieu de migrer.

### Ce qui le prouve

`tests/unit/read-only.test.ts`, 7 tests. Les trois derniers lancent la **vraie
CLI** sur un dossier jetable et comparent la base **octet pour octet** avant et
après, plutôt que de se fier à ce que la commande affiche : `doctor` sur une
base au schéma 3 (avertissement, code `0`, schéma toujours 3) ; `doctor` sur une
base absente (non créée) puis à jour ; `status` sur une base au schéma 3 (code
`1`, base intacte).

Le test a été éprouvé contre le défaut : `HarnessStore.open` remis dans
`doctor`, il échoue. Puis `doctor` et `status` ont tourné sur l'installation
réelle, daemon en marche : schéma 6, dix tâches, aucune écriture.

### Ce que l'écriture a appris

**1. Lire une base WAL en lecture seule crée des fichiers.** Mesuré avant
d'écrire : sur une base fermée, l'ouverture `readOnly` fait créer à SQLite
`harness.db-wal` et `harness.db-shm`, qui restent après la fermeture. Le
fichier de la base, lui, est identique octet pour octet. C'est ce que la
documentation dit désormais, et c'est sur ce fichier que portent les tests —
« n'écrit rien sur le disque » aurait été faux.

**2. Un défaut noté en cache souvent un second.** La leçon n° 17 nommait
`doctor` ; chercher tous les appels à `HarnessStore.open` hors du daemon a
trouvé `status`, qui migrait de la même façon depuis la Slice 1.

**3. Un diagnostic fiable trouve autre chose que ce qu'on cherchait.** Lancé
sur l'installation réelle pour vérifier qu'il n'écrivait rien, `doctor` a
signalé `~/.midgaard` en `755` — l'avertissement existait depuis la Slice 1, et
personne ne l'avait lu. La base y est en `644`. Renvoyé à l'étape 3.

---

## Étape 2 — ce que le worktree ne montre pas

### Ce qui existe

**Les fins de ligne.** `edit_file` cherche `old_string` avec un motif où chaque
`\n` ou `\r\n` devient `\r?\n`, le reste échappé et lu littéralement ;
`new_string` est écrit avec la fin de ligne du passage remplacé (CRLF dès qu'il
en contient, sinon celle qui domine le fichier). Un fichier aux fins de ligne
mêlées garde chacune à sa place. L'unicité se compte sur la recherche
tolérante : un passage présent une fois en LF et une fois en CRLF est **ambigu**,
refusé comme tel. Le résultat dit au modèle quand des fins de ligne ont été
adaptées.

**Les sous-modules.** `listSubmodules` lit les chemins de `.gitmodules` du
commit de départ (`git config --blob`), puis ne garde que ceux qui sont des
liens `160000` dans l'arbre (`ls-tree` borné à ces chemins). La liste suit le
même trajet que `base_dirty` : colonne `submodules_json` (migration 7),
`workspace.created`, résultat de la tâche, consigne de l'agent, note de merge
lue par Claude, carte « Fichiers et diff » et timeline du dashboard.
`PROTOCOL_VERSION` passe à 8. Et **les outils d'écriture refusent d'écrire dans
un sous-module**, vérifié sur le chemin réel — un lien qui y mène n'y échappe
pas.

### Ce qui le prouve

- `write-tools` : 7 cas de fins de ligne, dont un **vrai dépôt** dont
  `.gitattributes` force le checkout en CRLF — ce que `core.autocrlf` fait sous
  Windows : `edit_file` y trouve un passage écrit en LF, et `git_diff` ne
  compte qu'**une** ligne changée, pas tout le fichier. 3 cas de sous-modules :
  refus à toute profondeur et quelle que soit la casse, refus à travers un lien,
  écriture permise à côté (`vendor/library.ts`, `vendor/lib2/`).
- `workspace` : 4 cas sur de vrais dépôts, dont un `.gitmodules` qui ment (un
  chemin qui n'est pas un sous-module n'est pas annoncé) et le **constat** qui
  motive le refus : `git add -A` ignore ce qui est écrit dans un sous-module
  vide. Si une version de Git change cela, ce test le dira.
- `store` : la migration 7 donne `[]` aux worktrees d'une base au schéma 6 ;
  le journal porte la liste comme la ligne.
- `test:developer`, **V11** : un vrai daemon, un dépôt avec un sous-module, un
  agent qui tente d'y écrire puis écrit ailleurs. La consigne reçue par le
  fournisseur, `workspace.created`, le résultat et la note de merge lue par un
  vrai client MCP nomment `vendor/lib` ; l'écriture est refusée ; le reste est
  commité.

Au total : 281 tests unitaires, puis `test:lock`, `test:restart`,
`test:developer` (11), `test:wait` (12) et `test:ui` (8), **0 échec**, sous
macOS. Les suites `workspace` et `write-tools` tournent dans `worktrees.yml` :
les cas CRLF et sous-modules seront rejoués sous Windows et Linux au prochain
passage de la CI — pas encore constaté.

### Ce que l'écriture a appris

**4. Annoncer ne suffisait pas : le travail se perdait.** L'étape devait
« signaler » les sous-modules. L'expérience faite avant d'écrire a montré pire :
un fichier écrit dans le dossier vide d'un sous-module est ignoré par
`git add -A`, avec un code de sortie `0` et rien dans `git status`. Un agent qui
y aurait travaillé aurait rendu un résultat « abouti », sur une branche qui ne
contient pas son travail — exactement ce que l'invariant « la branche ne bouge
qu'à `submit_result` » est censé empêcher de faire croire. D'où le refus, qui
n'était pas dans le découpage.

**5. La tolérance devait laisser l'ambiguïté visible.** La première idée —
chercher d'abord à l'identique, puis de façon tolérante — aurait édité en
silence le passage LF d'un fichier qui contient aussi le même passage en CRLF.
Compter les occurrences sur la seule recherche tolérante garde la règle « une
seule occurrence » entière.

**6. Le découpage avait une phrase fausse.** Il prévoyait que l'empreinte
d'approbation porte sur ce que le modèle a demandé. Mais `edit_file`, borné au
worktree, ne demande **aucune** approbation : il n'y a pas d'empreinte. La
phrase a été retirée plutôt que rendue vraie.

---

## Étape 3 — la suite de sécurité

### La méthode

D'abord un **inventaire** : chaque promesse du PLAN §5 et chaque attaque du
§8.4, face au test qui la prouve. Ensuite, pour chaque trou, un test qui
**observe l'effet** — la base lue octet pour octet, le journal, le disque —
écrit **avant** le correctif, pour le voir échouer. Ce n'est qu'ainsi que les
défauts ci-dessous sont apparus : l'expurgation avait l'air couverte, parce que
les suites qui l'employaient passaient.

### Ce qui existe

- **`tests/security.ts`** (`npm run test:security`, ~3 s, dans `npm test`) :
  un vrai daemon, de vrais dépôts, le faux fournisseur qui fait tenter à
  l'agent ce qu'un modèle détourné tenterait.
  - **X1** — un agent lit une clé tierce (`ghp_…`) dans le projet et la recopie
    partout : argument, chemin que l'outil refusera, commande, résultat, et la
    clé du fournisseur avec. La base, son WAL et `daemon.log` — sortie du daemon
    redirigée comme le fait le serveur MCP — sont lus **octet pour octet**, et
    chaque colonne de chaque table est interrogée, pour dire **par où** un
    secret fuit quand il fuit.
  - **X2** — dix refus (lecture par `..`, par chemin absolu et par lien ; IMDS,
    `127.0.0.1` et `localhost` vers le daemon lui-même ; écriture par `..`, par
    chemin absolu, sur `.git` et par lien) : chacun est au journal, la tâche se
    termine, rien n'existe hors du worktree.
  - **X3** — `; rm -rf <dossier> && echo pwned` en argument : l'humain approuve
    cet argv exact, la commande tourne sans shell, le dossier est intact.
  - **X4** — l'API ne répond sur **aucune** interface autre que la boucle locale
    (éprouvé sur chaque adresse IPv4 de la machine) ; jeton, base, `-wal` et
    `-shm` en `0600`. Ce qui ne peut pas s'éprouver ici le dit : sans interface
    externe, ou sous Windows pour les modes.
- **`tests/unit/redact.test.ts`**, 15 tests : `createRedactor` (secrets connus,
  six motifs, dans un chemin et dans du JSON, valeur seule expurgée, texte
  ordinaire intact), `redactDeep`, `wrapUntrusted` (nonce, balise de fin
  hostile dans le contenu et dans l'étiquette).
- Dans `agent-runtime.test.ts` : l'encadrement **dans la boucle**, sur une
  sortie d'`exec` hostile ; l'expurgation d'un refus et de `submit_result`.
  Dans `tools.test.ts` : `localhost` refusé sur ce qu'il résout. Dans
  `store.test.ts` : la base créée en `0600`, une base en `0644` resserrée.

Au total : 301 tests unitaires, puis `test:lock`, `test:restart`,
`test:developer` (11), `test:security` (4), `test:wait` (12) et `test:ui` (8),
**0 échec**, sous macOS. `test:security` n'est pas encore en CI : c'est
l'étape 5.

### Les quatre défauts trouvés

**7. Le message d'un refus était persisté sans expurgation.** La boucle
n'expurgeait pas les `ToolError`, jugés sûrs parce que le harness les écrit.
Mais ils **citent** ce que le modèle a demandé : `writing under .git is not
allowed: .git/ghp_…`. X1 a trouvé la clé tierce dans `tool_calls.error` et dans
le journal. Contre-épreuve faite : le correctif retiré, X1 échoue.

**8. L'appel `submit_result` était journalisé en clair.** Son résumé était
expurgé pour le **résultat**, quelques lignes plus bas, mais pas pour la ligne
`tool_calls.arguments_json` écrite avant. Trouvé par X1 une fois le n° 7
corrigé — la colonne fautive nommée par la requête sur chaque table. Au passage,
les URL citées par la recherche web native, journalisées sans expurgation,
le sont désormais : une URL peut porter un jeton.

**9. L'étiquette de l'encadrement n'était pas désamorcée.** `wrapUntrusted`
neutralisait les balises de fin dans le contenu, pas dans `source="…"`. Pour
`exec`, l'étiquette est la commande — écrite par le modèle : une
`</untrusted_data>` y passait telle quelle, dans le bloc même qui prétend
l'encadrer. Trouvé par le test d'encadrement dans la boucle, qui n'existait pas :
celui qui s'intitulait « encadre une page web » ne vérifiait que le cas
contraire — qu'un fichier du projet n'est **pas** encadré. Titre corrigé.

**10. La base était lisible par les autres comptes.** `node:sqlite` crée le
fichier selon l'umask : `0644`, constaté sur l'installation de l'auteur. Elle
garde objectifs, contexte transmis par Claude, sorties d'outils. `open()` la
crée désormais en `0600` — SQLite donne ce mode à `-wal` et `-shm`, constaté —
et resserre une base existante. Le dossier `~/.midgaard` reste tel que
l'utilisateur l'a : un `MIDGAARD_HOME` peut désigner un dossier qui n'est pas à
nous, et `doctor` avertit déjà.

### Promesse par promesse

| Promesse (PLAN §5, §8.4) | Ce qui la prouve |
|---|---|
| Chemins canoniques, sous la racine ; `..` et absolus refusés | `tools`, `write-tools`, X2 |
| Liens sortants refusés, sans dire où ils mènent | `tools`, `write-tools`, X2 |
| Revérification à l'ouverture (`dev`/`ino`) | **écrite, jamais provoquée** : aucune suite ne gagne la course entre vérification et ouverture |
| Écriture dans le seul worktree ; ni `.git` ni sous-module | `write-tools`, `agent-runtime`, X2, V11 |
| `exec` : argv exact en liste blanche, sinon approbation | `exec`, V2, V9 |
| `exec` : pas de shell | `exec`, X3 |
| `exec` : environnement reconstruit | `exec` (« n'expose ni les clés du daemon ni `GIT_DIR` ») |
| `exec` : délai, groupe de processus tué | `exec` ; sous Windows, nuance de SLICE3 n° 21 |
| Réseau : privées, IMDS, chaque saut de redirection, noms résolus | `tools`, X2 |
| Réseau : liste de domaines | `tools` |
| Secrets au coffre, référence seule en base | `secrets`, X1 (clé du fournisseur absente de la base) |
| Expurgation avant persistance | `redact`, `agent-runtime`, **X1** |
| API sur `127.0.0.1` seulement | **X4** |
| Jeton `0600` ; base `0600` | **X4**, `store` |
| `Host` et `Origin` vérifiés, WebSocket comprise | `restart` R4 |
| Approbation liée à l'opération exacte | `approvals`, `exec`, V2, X3 |
| Approbation à usage unique, expirant | `store`, `restart` R5 |
| Contenu non fiable encadré, nonce, balise de fin désamorcée | `redact`, `agent-runtime`, `test:live` |
| Budget vérifié avant l'appel ; `budget_exceeded` ≠ `failed` | `agent-runtime` |

En gras, ce qui n'était prouvé par rien avant cette étape.

---

## Étape 4 — crash et concurrence

### Ce qui existait

V6 (`test:developer`) tuait déjà le daemon par `SIGKILL` pendant une pause
d'approbation : tâche `interrupted`, worktree conservé, fichier en vol présent.
R1 (`test:restart`) faisait de même pour une tâche simulée.

### Ce qui existe

- **V6 renforcé** : la branche est restée au commit de départ ; l'approbation en
  cours au moment du crash est close **en base** (`expired`), pas seulement
  absente de la vue ; l'approuver ensuite rend `409` et ne lance rien.
- **V12** — le daemon tué par `SIGKILL` **pendant** une commande approuvée : la
  commande doit mourir avec lui, et ne rien écrire après.
- **V13** — deux Developer délégués au même instant sur le même dépôt : deux
  `git worktree add` et deux commits de fin simultanés. Chaque branche ne
  contient que son propre travail, le dépôt de l'utilisateur est intact. Au
  passage, 40 worktrees créés et commités par huit en parallèle sur un même
  dépôt, directement avec le paquet `workspace` : 0 échec.
- **La garde des commandes** (`packages/tools/src/guard.ts`) : un processus par
  daemon, dans son propre groupe, à qui le daemon inscrit chaque commande sur
  un tube. Quand le daemon meurt, le système ferme le tube ; la garde tue les
  groupes encore inscrits.
- Dans `exec.test.ts` : un lanceur tué par `SIGKILL`, sa commande doit mourir.
  Ce test tourne dans `worktrees.yml`, donc sur les trois plateformes.
- **Le diff garde la date de l'index** (`packages/workspace/src/diff.ts`), et
  `workspace.test.ts` reproduit le cas : une réécriture de même taille dans la
  seconde du checkout, puis une seconde d'attente.

Au total : 303 tests unitaires, puis `test:lock`, `test:restart`,
`test:developer` (13), `test:security` (4), `test:wait` (12) et `test:ui` (8),
**0 échec**, sous macOS, et aucune garde restée vivante après les suites.

### Ce que l'écriture a appris

**11. Une commande survivait au daemon, et continuait d'écrire.** V12, écrit
avant tout correctif, l'a montré : trois secondes après le `SIGKILL`, la
commande a écrit dans le worktree. `exec` tuait le groupe à la fin, au délai et
à l'annulation — trois moments qui supposent un daemon vivant. Le groupe est
détaché du daemon justement pour être tué entier ; détaché, il ne meurt pas
avec lui. Le redémarrage marquait la tâche `interrupted`, et rien ne disait
qu'une commande tournait encore. Contre-épreuve faite : la garde neutralisée,
le test unitaire échoue (« la commande a survécu à son lanceur »).

**12. Le soupçon sur les approbations était faux.** `markInterrupted` ne touche
pas aux approbations, et l'on pouvait craindre une pause restée `pending` après
le redémarrage, que `harness status` aurait proposé d'approuver. Lue en base,
elle est `expired` : l'expiration des approbations la clôt. Le test le vérifie
désormais en base, et non dans la vue — la première version lisait la vue, où
une pause close et une pause oubliée se ressemblent (toutes deux absentes).

**13. Le diff perdait des modifications, et c'est la charge qui l'a montré.**
La première exécution complète de l'étape a échoué sur un test que l'étape ne
touchait pas, `dashboard-patch` : un fichier modifié manquait au diff. Seul, le
test passait cinq fois sur cinq. Le symptôme — le fichier absent à la fois de la
liste et du patch — désignait Git plutôt que le découpage du dashboard. La
cause : `diffWorktree` travaille sur une **copie** de l'index, et la copie
prenait la date du moment. Git relit le contenu de toute entrée pas plus
ancienne que l'index (*racy git*) ; face à un index « neuf », il se fiait à la
taille et à la date — à la seconde près — d'un fichier réécrit à taille égale
dans la seconde du checkout. Reproduit cinq fois sur cinq en attendant une
seconde avant le diff ; corrigé en rendant à la copie la date de l'original.
Le défaut datait de la Slice 3 : le `git_diff` de l'agent et le diff du
dashboard pouvaient dire « rien de changé » ; le commit de fin, qui emploie le
vrai index, n'était pas touché.

**14. Une concurrence qui passe une fois ne prouve pas grand-chose.** V13 est
un passage ; une course se gagne souvent. D'où l'essai de charge à part
(huit à la fois, cinq fois) avant de le dire tenu. Il n'est pas dans les
suites : trop long pour ce qu'il ajoute une fois le résultat connu, et il ne
dirait rien de plus sous une autre plateforme que V13 en CI.

---

## Étape 5 — trois plateformes, de bout en bout

### Ce qui existe

**`.github/workflows/e2e.yml`**, « Bout en bout » : sur macOS, Linux et
Windows, sans `fail-fast`, le build, puis `test:unit`, `test:lock`,
`test:restart`, `test:developer`, `test:security`, `test:wait` et `test:ui`,
chacun en étape à part et tous exécutés même après un échec, et enfin la CLI
telle qu'un tiers la lance — `init`, `doctor` (qui vérifie la déclaration que
`init` vient d'écrire), `status`. Il ne part pas pour une retouche de
documentation.

### Ce qui le prouve

| Passage | Commit | macOS | Linux | Windows |
|---|---|---|---|---|
| `41181339563` | `75ba381` | ✅ | ✅ | ❌ `unit`, `lock`, `developer`, `ui` |
| `41182184282` | `370ac1b` | ✅ | ✅ | ✅ |

Au second passage, sous Windows : 298 tests unitaires sur 301, et trois sauts
**annoncés** (deux scripts `sh` lancés comme programmes, les modes de la base) ;
`test:security` éprouve les liens symboliques — le poste sait en créer — mais
dit qu'il ne vérifie **pas** les modes de fichiers, que Windows règle par ACL ;
V12, la garde des commandes, passe. Sous Linux, tout, modes `0600` compris.
Les trois postes rapportent le même `CONSTAT` S5 que macOS : un client MCP
coupe à 60 s un appel sans notifications de progression. Git 2.56 partout.
Le même jour, « Worktrees » et « Coffre » au vert sur leurs postes : les cas
CRLF, sous-modules et *racy git* des étapes 2 et 4 ont donc tourné sous Windows.

### Ce que le premier passage a appris

Deux postes au vert du premier coup, Windows en échec sur quatre suites. Une
seule cause était un défaut ; les autres étaient des hypothèses des tests.

**15. Les outils de lecture rendaient des chemins en `\`.** Sous Windows,
`search_files` rendait `src\a.ts:1: …`, comme `read_file` et `list_directory`,
quand les outils d'écriture rendent `src/a.ts`. Un même dépôt avait deux
écritures selon la machine, et selon l'outil. Tous rendent désormais `/`
(`toolPath`).

**16. Le dossier temporaire a deux noms sous Windows.** `os.tmpdir()` y rend
`C:\Users\RUNNER~1\…` — un nom court 8.3 — et le harness, qui canonicalise
par le `realpath` natif, rend `C:\Users\runneradmin\…`. Les tests comparaient
au `realpathSync` JavaScript, qui ne développe pas les noms courts : trois
scénarios (V1, V8, V9) croyaient voir un worktree hors de son dossier, un
orphelin manqué, une liste blanche rangée ailleurs. Le harness avait raison ;
les tests emploient désormais `realpathSync.native`.

**17. Le reste : des chemins écrits à la main.** `config.test` attendait
`/tmp/b/harness.db` ; un test de la boucle attendait le programme d'`exec` sans
guillemets, que `formatArgv` ajoute à un chemin contenant `\` ; `test:ui`
passait ses huit scénarios puis échouait à effacer son dossier, qu'un processus
tout juste arrêté tenait encore (`EPERM`) — réessais à l'effacement.

**18. Une manche de `test:lock` a échoué, une fois.** Un seul survivant, le bon,
mais pas encore de fichier de découverte à 2,5 s. Lenteur de huit Node démarrant
ensemble sur un poste à deux cœurs, ou panne ? Le test jetait la sortie des
candidats, et ne pouvait pas le dire. Il attend désormais la publication (15 s
au plus), dit combien de temps elle a pris, et affiche les journaux des
candidats si une manche échoue. Au second passage : dix manches sur dix, sans
publication tardive. **Non reproduit, donc non expliqué** ; le prochain échec,
s'il vient, dira sa cause.

---

## Étape 6 — le paquet `midgaard`

### Une décision prise en route

Le découpage le prévoyait : un clone de développement et une installation npm
partagent `~/.midgaard`, donc un daemon. Et une mise à jour (`npm install -g
midgaard@0.1.1`) sans changement de protocole laissait l'ancien code tourner
jusqu'à l'arrêt sur inactivité. Question posée à l'auteur, trois options :

| Option | Retenue |
|---|---|
| Remplacer un daemon d'une autre installation **s'il est oisif**, s'en servir sinon | ✅ |
| Le dire seulement (`doctor`, `status`) | |
| Un dossier runtime par installation | |

### Ce qui existe

- **`scripts/pack.ts`** (`npm run pack:npm`) : build propre, puis un dossier
  `.pack/midgaard/` construit **tel que npm l'installera** — les dix paquets
  internes dans son `node_modules/@midgaard/`, déclarés en `bundleDependencies`,
  leurs seuls `.js` ; le dashboard compilé à côté du daemon ; un binaire
  `bin/harness.js` ; les trois dépendances externes (`zod`, `ws`, le SDK MCP)
  au paquet de tête seul, **épinglées** aux versions du `package-lock.json`.
  Aucun outil de plus, aucun code réécrit : les imports `@midgaard/…` résolvent
  comme dans le dépôt. L'assemblage refuse un export qui désigne un fichier
  absent, une dépendance sans version verrouillée, et toute source, `.d.ts`,
  carte de sources ou `.mcp.json` dans le tarball. Résultat : 306 Kio, 104
  fichiers.
- **Le daemon annonce son installation** (`install` dans `/api/health` : dossier
  du paquet `@midgaard/daemon` et version) ; **`/api/shutdown` accepte
  `if_idle`**, qui rend `409` tant qu'une tâche est active ; **`ensureDaemon`**
  remplace un daemon d'une autre installation s'il accepte de s'arrêter, s'en
  sert sinon ; **`doctor`** le dit. `PROTOCOL_VERSION` passe à 9.
- **Ce qu'un tiers lit** : `cmd()` écrit chaque commande conseillée sous la forme
  qu'il peut taper ; `harness --version` lit la version dans le manifeste ; le
  daemon trouve le dashboard dans le paquet ; un fichier `LICENSE` (MIT,
  annoncé par `package.json` sans que le texte existe).

### Ce qui le prouve

**`tests/package.ts`** (`npm run test:package`, ~1 min, réseau requis) installe
le tarball dans un préfixe vierge, avec un `HOME` vierge, et ne se sert que de
ce qui a été installé : K1 l'installation et la version ; K2 `init` désigne le
serveur **installé** ; K3 `doctor` sain, dashboard et tarifs trouvés dans le
paquet, aucun conseil en `npm run harness` ; K4 un vrai client MCP sur le
serveur déclaré : daemon du paquet, dashboard servi, tâche aboutie ; K5
`status`, `stop` ; K6 un daemon des sources sur le même dossier runtime,
remplacé quand il est oisif, servi tel quel quand il travaille — sa tâche
intacte. Contre-épreuve : la comparaison d'installation retirée, K6 échoue
(« oisif non remplacé »). `tests/unit/installation.test.ts` : l'identité, et le
verdict de `doctor`.

`test:package` est ajouté à `e2e.yml`. Passage `41184642657` (commit
`7abb02b`) : **6/6 sous macOS, Linux et Windows, du premier coup**, comme le
reste de « Bout en bout », « Worktrees » et « Coffre ». Sous Windows, le binaire
installé est `harness.cmd` et le paquet sous `<préfixe>\node_modules` ; le
tarball y fait 104 fichiers, comme ailleurs. Ce premier coup doit beaucoup à
l'étape 5 : les noms courts et les chemins en `\` y avaient déjà été payés.

### Ce que l'écriture a appris

**19. Les `publishConfig` mentaient.** Chaque paquet en portait un, n'exportant
que `"."`. Or la CLI résout `@midgaard/mcp-server/main` et le serveur MCP
`@midgaard/daemon/main` : publiés selon ces champs, les paquets n'auraient pas
démarré. Jamais employés, jamais vérifiés ; retirés. L'assemblage dérive les
exports des vrais, et vérifie que chaque cible existe.

**20. npm tient les dépendances d'un paquet embarqué pour embarquées.** Premier
essai : installation sans erreur, puis `Cannot find package …/zod/index.js` —
`node_modules/zod` était **vide**. Les paquets internes déclaraient `zod` ; npm
l'a cru dans le tarball et ne l'a pas téléchargé. Les dépendances externes ne
sont plus déclarées que par le paquet de tête.

**21. Le paquet conseillait des commandes du dépôt.** `doctor`, `providers`,
`pricing` et `start` disaient `npm run harness -- …` à tout le monde. Seule une
installation dans un préfixe vierge pouvait le montrer : depuis le dépôt, ces
commandes marchent.

**22. Une version recopiée à la main.** `harness --version` affichait une
constante `'0.1.0'`, qui aurait menti dès la version suivante.

**23. Une contre-épreuve qui bloque n'est pas une contre-épreuve.** K6 attendait
sans borne la fin du daemon « étranger ». Le remplacement désactivé, le daemon
ne s'arrêtait jamais, et la suite a bloqué au lieu d'échouer. Les attentes sont
désormais bornées, et la contre-épreuve échoue comme elle le doit.

---

## Ce qui restera ouvert, déjà su

- **Les sous-processus lancés hors de libuv, sous Windows** (SLICE3, leçon
  n° 21) : leur nettoyage après la sortie du parent n'est pas constaté. La CI de
  l'étape 5 ne l'a pas tranché, faute d'un tel programme dans les tests.
- **L'échec unique de `test:lock` sous Windows** (leçon n° 18), non reproduit.
- **`write_file` sur un fichier CRLF** écrit ce qu'on lui donne : un modèle qui
  réécrit un fichier entier en `\n` change toutes ses lignes dans le worktree.
  Sous `core.autocrlf`, Git normalise au commit ; sans lui, le diff montrera
  tout le fichier. Non traité à l'étape 2, dont la décision portait sur
  `edit_file`.
- **Un `exec` peut écrire dans un sous-module** : le refus ne vaut que pour les
  outils d'écriture. Ce qu'une commande y écrirait serait perdu de la même
  façon ; la consigne de l'agent dit que les sous-modules sont vides.
- **La revérification à l'ouverture** n'a jamais été provoquée : la course
  entre `stat` et `open` ne se gagne pas sur commande. Il faudrait un point
  d'injection entre les deux, que le code n'a pas.
- **Le *DNS rebinding*** contre `http_fetch` reste la limite annoncée dans
  `net.ts` : le nom est vérifié, puis `fetch` résout à nouveau.
- **La garde sous Windows** : elle y tue par `taskkill /T`, qui ne retrouve plus
  les enfants d'un parent déjà mort. Le test unitaire et V12 passent en CI,
  mais ils ne disent pas **qui** a tué la commande : la garde, ou le *Job
  Object* de libuv (SLICE3, leçon n° 21). Pour une commande directe, les deux
  suffisent ; pour un petit-enfant lancé hors de libuv, rien n'est constaté.
- **Le nom `midgaard` sur npm** était libre le 2026-10-30 ; rien ne le réserve
  avant la première publication.
- **Les deux dettes Gemini** (SLICE2) restent ouvertes tant qu'aucune clé
  Google n'est disponible.
