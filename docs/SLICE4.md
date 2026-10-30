# Slice 4 — Durcissement et distribution

**Date :** 2026-10-30 · **Objectif (PLAN §7) :** installable par un tiers en une
commande, scénario de démo du document d'origine (§12) rejoué sans terminal
intégré. En chemin : tests de sécurité ciblés, scénarios de crash et de reprise,
deux tâches concurrentes sur des worktrees distincts, README et guide de
dépannage.

**État : en cours.** Décisions prises, découpage arrêté ; étape 1 livrée.

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
| 2 | Ce que le worktree ne montre pas : `edit_file` tolérant aux fins de ligne ; sous-modules absents, signalés à l'agent et au dashboard | à faire |
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

- **Étape 2.** La tolérance ne doit rien relâcher d'autre : toujours une seule
  occurrence exigée, et l'empreinte d'approbation porte sur ce que le modèle a
  demandé, pas sur la forme normalisée. Le cas se rejoue de lui-même sous
  Windows dans `worktrees.yml`, où le checkout est en CRLF.
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

## Ce qui restera ouvert, déjà su

- **Les sous-processus lancés hors de libuv, sous Windows** (SLICE3, leçon
  n° 21) : leur nettoyage après la sortie du parent n'est pas constaté. La CI de
  l'étape 5 ne le tranchera pas, faute d'un tel programme dans les tests.
- **Les deux dettes Gemini** (SLICE2) restent ouvertes tant qu'aucune clé
  Google n'est disponible.
