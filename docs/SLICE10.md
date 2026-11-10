# Slice 10 — Spécialisation sécurité : pipeline à portes, vue terminal, débogueur confiné

**Date :** 2026-11-10 · **Objectif :** pousser Midgaard vers un **harness de
recherche de vulnérabilités** spécialisé — un **pipeline à étapes et à portes**
(`recon → hunt → validate → trace → report`) porté par des playbooks, une
**vue terminal** en temps réel (moins d'UI complète, plus de lignes et
d'information sur ce qui se passe, une *dialogue box* vers l'orchestrateur
conservée), et — pour le reverse — des **outils d'analyse en lecture seule**,
l'exécution dynamique restant **confinée à la seule VM Windows**.

**État : décidée, non ouverte.** Posée le 2026-11-10 à la demande de l'auteur,
après lecture de deux références qu'il a proposées :
[baby-naptime](https://github.com/faizann24/baby-naptime) (implémentation
ouverte de *Project Naptime* de Google — boucle d'agent avec `CodeBrowser`,
`Debugger` GDB, `ScriptRunner`, `Summarizer`, `Reporter`) et
[harness-kit](https://github.com/ZephrFish/harness-kit) (template pédagogique :
cinq étapes, chacune un `SKILL.md` + un prompt, plus `model-routing.yaml` et
`context-budgets.yaml`). **Elle s'ouvre après la Slice 9**, dont restent 5.4
(survie des processus d'une connexion coupée) et 5.5 (CI Windows réelle) : le
pipeline s'appuie sur la VM Windows, qui doit d'abord être éprouvée sur un vrai
Windows.

---

## Les décisions prises avec l'auteur (2026-11-10)

| Question | Réponse retenue |
|---|---|
| Où autoriser l'exécution dynamique inspirée de baby-naptime (GDB, lancement de la cible) ? | **VM Windows seulement.** L'invariant « aucun échantillon ne s'exécute, jamais » (Slice 9) reste entier ailleurs ; tout dynamique passe par `windows_run`, sous approbation, dans le dossier jetable de la VM. Le reverse hors VM reste statique et en lecture seule. |
| Par quoi commencer ? | **Cette doc de décisions d'abord** (`docs/SLICE10.md`), avant tout code. |

### Pourquoi ces deux références, et ce qu'on en prend vraiment

- **harness-kit donne la *forme*, pas la machinerie.** Son pipeline à cinq
  étapes correspond presque terme à terme à des briques déjà livrées :

  | harness-kit | Midgaard existant |
  |---|---|
  | une étape = un `SKILL.md` + un prompt | un **playbook** attaché à un profil (Slice 9) |
  | `validate` *adversarial* | la **revue** orchestrateur ⇄ Developer (`review`, `accept_result`, Slice 6) |
  | `hunt` concurrent, un agent par tâche | la **délégation parallèle** + `create_agent` (Slices 5, 8) |
  | `model-routing.yaml` | fournisseur + modèle par profil (`PATCH /api/agents/:id`) |
  | `context-budgets.yaml` | les **limites par profil** (`agents limits`) + le **Summarizer** (Slice 1) |

  Autrement dit, l'orchestration, les approbations, l'expurgation, l'encadrement
  `<untrusted_data>` et le suivi des coûts, Midgaard les a **en plus dur** que le
  template. Ce qui manque, ce n'est pas la mécanique, c'est **le savoir métier
  des étapes** et **la discipline des portes**. On ne réimporte donc aucune
  architecture : on écrit des playbooks et on ajoute une porte.

- **baby-naptime donne des *outils bas niveau*, mais une philosophie
  incompatible** (voir « Le point dur » ci-dessous). On en prend la structure
  de boucle et deux outils en version lecture seule (un navigateur de code, un
  rapporteur structuré) ; on en rejette l'exécution-et-exploitation, sauf à la
  confiner à la VM Windows.

## Le point dur tranché avant toute conception

baby-naptime **compile la cible sans mitigations** (`-fno-stack-protector -z
execstack -no-pie`), puis l'**exécute** sous GDB et **lance des exploits**.
C'est frontalement contraire à l'invariant central de la Slice 9 :

> *« Un échantillon ne s'exécute jamais, même approuvé. »* `exec` refuse **dans
> `prepare`**, sans demander à personne, une commande qui lance un échantillon,
> en lance une copie de même contenu, ou le passe à un chargeur, émulateur,
> shell ou interpréteur ; `pe-static.md` étend ce refus à l'émulation (FLOSS,
> Speakeasy, Qiling, Unicorn).

**On ne reprend donc pas la boucle de baby-naptime telle quelle.** La décision
de l'auteur (VM Windows seulement) tranche : toute analyse **dynamique** — un
débogueur qui exécute, un script qui fait tourner la cible — n'existe que par
`windows_run`, dans le dossier jetable `~/midgaard/tasks/<tâche>/work` de la VM,
chaque commande lue et approuvée par l'humain, le dossier effacé en fin de
tâche. Partout ailleurs, l'invariant « aucun échantillon exécuté » ne bouge
pas : `exec` continue de refuser dans `prepare`, et aucun échantillon n'est
copié dans un worktree.

Conséquence : le `Debugger` de baby-naptime ne devient **jamais** un outil du
Researcher ni d'un worktree. S'il voit le jour, c'est comme un **script
PowerShell/`gdb` sur la VM**, passé à `windows_run`, soumis aux mêmes règles
que toute commande Windows — et pas avant que la Slice 9 (5.4, 5.5) ait prouvé
la VM.

## Ce qui a été constaté avant de décider (2026-11-10)

Chaque point est lu dans le code ou la doc du dépôt, pas supposé.

1. **Les playbooks sont le véhicule exact du « savoir d'étape ».** Un playbook
   est un fichier Markdown de `playbooks/`, en anglais, attaché à un profil par
   l'humain seul (`PUT /api/agents/:id/playbooks`), relu au départ de chaque
   tâche, SHA-256 cité à la timeline, borné (Slice 9, étape 1). Les six
   existants (`sigma`, `yara`, `pe-static`, `powershell`, `windows-hardening`,
   `python`) montrent le ton : sourcé, « the one rule », pas d'identifiant de
   mémoire inventé. Les cinq étapes du pipeline **sont** cinq playbooks de plus.
2. **La « porte adversariale » existe déjà à moitié.** L'orchestrateur délègue
   une revue (`review`), le Developer propose (`submit_result`), l'orchestrateur
   accepte (`accept_result`) ; la branche ne bouge qu'à l'acceptation (Slice 6).
   Ce qui manque, c'est une **porte de traçage** : un finding non relié d'une
   entrée attaquant à son sink ne devrait pas franchir l'étape.
3. **Le flux temps réel est déjà intégralement diffusé.** `EventBus` écrit et
   diffuse dans la même transaction, `task_events.seq` est global et reprenable,
   la sortie `exec` est découpée **par ligne puis expurgée** et diffusée en
   direct (Slice 6, `agent-runtime/src/output.ts`), le dashboard a déjà un
   terminal xterm **qui ne laisse passer que les couleurs**
   (`apps/dashboard/src/lib/terminal.ts`). Une vue terminal ne demande **aucun**
   changement du daemon : elle consomme le même WebSocket.
4. **Le Summarizer et les limites par profil font déjà le travail de
   `context-budgets.yaml`.** Rien à importer ; au plus, une doc de réglage.
5. **Le point d'entrée du dashboard n'importe de `@midgaard/contracts` que des
   types** et charge `node:os`/`node:fs` : une nouvelle vue reste un module du
   paquet `apps/dashboard`, sans toucher aux contrats.

## Décisions de conception

### A. Les cinq étapes deviennent cinq playbooks

1. **Un playbook par étape**, dans `playbooks/`, en anglais, adapté au terrain
   de Midgaard (reverse/PE, détection, durcissement, Windows) plutôt qu'au web
   générique de harness-kit :
   - `recon.md` — cartographier la cible (sous-systèmes, points d'entrée,
     frontières de confiance, historique Git), produire une file de tâches ;
   - `hunt.md` — investiguer **une** hypothèse de vulnérabilité par tâche, en
     parallèle, sur des fichiers nommés ;
   - `validate.md` — relecteur **adversarial** : chercher pourquoi le finding
     est **faux**, pas le confirmer ;
   - `trace.md` — prouver qu'une entrée attaquant atteint le sink, référence de
     code à chaque pas ;
   - `report.md` — assembler ce qui a **franchi** le traçage ; ce qui échoue à
     `validate` ou `trace` ne passe pas.
2. Ils **ne nomment ni modèle ni client** (neutralité, Slice 5) : le routage de
   modèle de harness-kit (`recon`/`validate`/`trace` sur un modèle capable,
   `hunt`/`report` sur un modèle rapide) se **réalise par l'attache à des
   profils** différents, pas écrit dans le playbook.
3. Ils restent **statiques et en lecture seule** par construction : aucun ne
   demande d'exécuter la cible. `recon`/`hunt`/`validate`/`trace` tiennent dans
   un Researcher ; un besoin dynamique passe par un Developer à VM et
   `windows_run`.

### B. Une porte de traçage, formulée d'abord en playbook

4. La discipline « un finding non tracé ne passe pas » s'écrit d'abord **dans
   `validate.md` et `trace.md`** (texte d'humain, zéro code). On ne crée un
   **statut** ou un champ de tâche (`trace_confirmed`) que si l'essai réel
   montre que le texte ne suffit pas — même prudence qu'ailleurs : une phrase de
   doc est une affirmation à prouver, on ne code la contrainte qu'une fois le
   besoin constaté.

### C. Les outils bas niveau de baby-naptime, version lecture seule

5. Un **`CodeBrowser`** (navigation ciblée dans un gros arbre, extraction de
   segments pertinents) manque pour le reverse sur de gros binaires désassemblés
   ou de gros dépôts. S'il est livré, c'est un outil **lecture seule** derrière
   `ToolContext`, sans écriture, soumis aux règles de chemin existantes
   (`.git` jamais touché, `dev`/`ino` revérifiés à l'ouverture).
6. Un **`Reporter`** structuré (un finding sourcé → markdown/SARIF/JSON) peut
   être un outil de l'étape `report`, ou rester un simple playbook de format.
   À trancher à l'étape correspondante, pas maintenant.
7. Le **`Debugger`** n'est **pas** un outil : il n'existe, s'il existe, que
   comme script sur la VM Windows via `windows_run`.

### D. La vue terminal

8. Une **nouvelle vue « terminal »** du dashboard (ou une TUI séparée) devient
   le mode par défaut de l'observation : flux d'événements en lignes, sortie
   `exec` en direct, coûts et étapes, **une *dialogue box* vers l'orchestrateur**
   (le chat `POST /api/tasks/:id/messages` existe déjà, Slice 6). Elle
   **consomme le flux existant** ; le daemon ne change pas.
9. Elle garde l'invariant du terminal : **seules les couleurs passent**, aucune
   séquence qui efface, déplace le curseur ou réinitialise — sinon l'humain
   approuve en voyant autre chose que ce qui s'est passé.
10. L'atelier VS-Code (Slice 6) **reste** pour l'inspection diff/fichiers ; la
    vue terminal ne le remplace pas, elle devient l'entrée par défaut. La coque
    desktop (`apps/desktop`) ne change pas : même origine, aucune capacité Tauri.

## Découpage proposé (sept étapes)

L'ordre va du gain le plus sûr (du texte) au plus engageant (du code, puis du
dynamique confiné). Rien n'est livré tant que la Slice 9 (5.4, 5.5) ne l'est pas
pour ce qui touche la VM.

1. **Les cinq playbooks d'étape** (`recon`, `hunt`, `validate`, `trace`,
   `report`), adaptés reverse/PE/Windows, attachables tout de suite. Verts =
   relus et SHA-256 cités au départ d'une tâche (mécanique déjà testée).
2. **La porte de traçage en texte** : durcir `validate.md`/`trace.md`, éprouver
   sur une cible JavaScript puis sur un binaire au volet PE (comme la Slice 9).
3. **La vue terminal** du dashboard : flux + sortie en direct + dialogue box, en
   lecture seule, séquences réduites aux couleurs. D-tests dans `test:ui`.
4. **`CodeBrowser` lecture seule** : outil de navigation/extraction, sans
   écriture, règles de chemin existantes. Tests dans `test:developer`/unitaires.
5. **Le routage par profils** : poser les profils du pipeline (un capable, un
   rapide) et documenter l'équivalent de `model-routing.yaml` sans YAML neuf.
6. **Le `report` structuré** (outil ou playbook de format) : à décider ici.
7. **L'essai réel de bout en bout** : un pipeline complet sur une vraie cible,
   coût relevé, résultat non fiable (contenu encadré), zéro échantillon exécuté.
   Le volet dynamique, s'il est tenté, passe par `windows_run` seulement.

## Reste à trancher (à l'ouverture)

1. **Vue terminal : dans le dashboard ou TUI à part ?** Une vue web de plus coûte
   moins (même bundle, même WebSocket, mêmes tests Playwright) qu'une TUI Node
   séparée à écrire et à tester. Penchant : une vue du dashboard, la TUI plus
   tard si le besoin « hors fenêtre » apparaît.
2. **La porte de traçage : texte seul, ou statut `trace_confirmed` ?** Rester en
   texte tant que l'essai ne prouve pas le contraire (prudence habituelle).
3. **`CodeBrowser` : nouvel outil, ou préfixes `exec` sur des outils existants**
   (`rg`, `objdump`, `nm`, `strings` via liste blanche bornée) ? Le second
   réutilise la liste blanche à préfixes de la Slice 9 et ne crée aucun outil ;
   à mesurer sur un vrai cas avant de décider.
4. **Quel modèle pour `hunt` en parallèle ?** Les `deepseek-*-uncensored` de
   Venice sont déjà tarifés (Slice 9) ; reste à mesurer leur coût à forte
   concurrence avant de fixer un plafond de sous-tâches par arbre.
5. **Le `Debugger` dynamique sur VM vaut-il la peine** avant que 5.4/5.5 soient
   closes ? Non : il dépend d'une VM encore non éprouvée sur un vrai Windows.
