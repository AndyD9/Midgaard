# Slice 4 — Durcissement et distribution

**Date :** 2026-10-30 · **Objectif (PLAN §7) :** installable par un tiers en une
commande, scénario de démo du document d'origine (§12) rejoué sans terminal
intégré. En chemin : tests de sécurité ciblés, scénarios de crash et de reprise,
deux tâches concurrentes sur des worktrees distincts, README et guide de
dépannage.

**État : en cours.** Décisions prises, découpage arrêté ; étapes 1 à 3 livrées.

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
| 4 | Crash et concurrence : daemon tué en plein Developer (tâche `interrupted`, worktree conservé, branche au commit de départ) ; deux Developer concurrents sur deux worktrees | à faire |
| 5 | Le daemon de bout en bout, le dashboard et la CLI en CI sur macOS, Linux et Windows | à faire |
| 6 | Le paquet `midgaard` : tarball unique, `npm pack` installé dans un préfixe vierge puis `harness init`, `doctor` et un aller-retour MCP — sur les trois plateformes | à faire |
| 7 | La publication : workflow sur tag, provenance ; README d'installation et guide de dépannage | à faire |
| 8 | L'essai d'acceptation : installé depuis npm sur un `HOME` vierge, le scénario §12 rejoué depuis Claude Code sous macOS | à faire |

L'ordre suit une règle : **rien n'est distribué avant d'être durci.** Les
dettes que la Slice 3 a laissées d'abord (étapes 1 et 2), la preuve que les
frontières tiennent ensuite (3 et 4), puis les plateformes que seul un tiers
aurait rencontrées (5), et le paquet en dernier — un paquet publié est le seul
livrable qu'on ne peut pas reprendre.

### Ce que chaque étape doit trancher ou surveiller

- **Étape 5.** Les suites de bout en bout envoient des signaux et tuent des
  processus : c'est là que Windows a le plus de chances de différer. La leçon
  du coffre (cinq passages pour quatre postes verts) vaut d'être retenue :
  relire avant de pousser.
- **Étape 6.** Deux pièges prévisibles. D'abord, les conditions d'export
  (`midgaard-dev`) ne doivent jamais servir chez un tiers : le paquet ne contient
  que `dist/`. Ensuite, un clone de développement et une installation globale
  partagent `~/.midgaard`, donc **le même daemon** : à `PROTOCOL_VERSION` égal,
  le serveur MCP de l'un parlera au daemon de l'autre, avec le code de l'autre.
  À trancher : la version du paquet dans la poignée de main, ou un `HOME`
  distinct par installation.
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

## Ce qui restera ouvert, déjà su

- **Les sous-processus lancés hors de libuv, sous Windows** (SLICE3, leçon
  n° 21) : leur nettoyage après la sortie du parent n'est pas constaté. La CI de
  l'étape 5 ne le tranchera pas, faute d'un tel programme dans les tests.
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
- **Les deux dettes Gemini** (SLICE2) restent ouvertes tant qu'aucune clé
  Google n'est disponible.
