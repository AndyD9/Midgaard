# Slice 4 — Durcissement et distribution

**Date :** 2026-10-30 · **Objectif (PLAN §7) :** installable par un tiers en une
commande, scénario de démo du document d'origine (§12) rejoué sans terminal
intégré. En chemin : tests de sécurité ciblés, scénarios de crash et de reprise,
deux tâches concurrentes sur des worktrees distincts, README et guide de
dépannage.

**État : en cours.** Décisions prises, découpage arrêté ; étapes 1 et 2 livrées.

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
| 3 | La suite de sécurité du PLAN §8.4, point par point : chaque refus prouvé par un test qui l'observe directement, les trous comblés | à faire |
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

- **Étape 3.** Beaucoup existe déjà, éparpillé : traversée et liens
  (`tools`, `write-tools`), `;` dans un argument (`exec`), IMDS et IP privées,
  redirections comprises (`tools`), `Origin` étrangère sur HTTP et WebSocket
  (`restart.ts`, R4). Le travail est d'abord un **inventaire** — une table
  « promesse du §5 → test qui la prouve » — puis de combler ce qui manque.
  Un trou déjà visible : « un secret dans une sortie d'outil est expurgé en
  base » n'est prouvé que sur un faux expurgeur, jamais en lisant la base
  d'un vrai daemon. Un autre, vu sur l'installation réelle à l'étape 1 :
  `~/.midgaard` en `755` et `harness.db` en `644`, donc lisibles par les autres
  comptes du poste (le jeton, lui, est bien en `600`).
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
- **Les deux dettes Gemini** (SLICE2) restent ouvertes tant qu'aucune clé
  Google n'est disponible.
