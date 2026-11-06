# Slice 9 — Des agents experts : Python, reverse, règles Windows

**Date :** 2026-11-06 · **Objectif :** que les agents de Midgaard travaillent
en experts sur quatre terrains — **détection** (Sigma, YARA, EVTX, Sysmon),
**durcissement** (GPO, AppLocker, WDAC, pare-feu, ASR), **scripts
PowerShell**, **analyse de binaires PE** — le plus souvent en **Python**, et
vérifient sous Windows ce qui ne se vérifie que là.

**État : en cours.** Ouverte le 2026-11-06 à la demande de l'auteur, avant
que l'essai réel REA (étape 7 de la Slice 8) soit rejoué : seul le volet PE
en dépend, il vient donc en dernier. Les releases desktop passent après.

---

## Les décisions prises avec l'auteur (2026-11-06)

| Question | Réponse retenue |
|---|---|
| Quelles « règles Windows » ? | **Les quatre** : détection (Sigma, YARA), durcissement / GPO, scripts PowerShell, analyse de binaires PE |
| Où vérifier ce qui est propre à Windows ? | **Une VM Windows jointe par SSH**, où `exec` peut lancer des commandes, approuvées |
| Dans quel ordre ? | **Conclure l'essai REA, puis cette slice**, puis les releases desktop |
| Quel modèle ? | **Les modèles *uncensored* de Venice**, à commencer par `deepseek-v4-1-flash-uncensored` |

### Le second tour (2026-11-06, à l'ouverture)

| Question | Réponse retenue |
|---|---|
| Où vivent les playbooks ? | **Dans le dépôt Midgaard** (`playbooks/`), versionnés, relus à chaque commit ; l'humain les **attache à un profil** (CLI, dashboard). Aucun agent ne peut les modifier |
| La liste blanche `exec` ? | **Des préfixes bornés** : un préfixe couvre tout argv qui commence par lui ; refusé s'il se réduit à un interpréteur nu (`python`, `node`, `sh`, `pwsh`…) ; avertissement et confirmation à l'ajout, comme aujourd'hui |
| Quelle VM Windows ? | **Locale** (Parallels, UTM ou VMware sur le Mac), OpenSSH Server activé, si possible avec un instantané propre |
| Exécuter un échantillon ? | **Jamais.** Analyse statique seulement, même sur la VM, même avec approbation |

## Ce qui a été constaté avant de décider (2026-11-06)

Chaque point a été lu dans le code ou au catalogue, pas supposé.

1. **Les profils ne savent aucun métier.** Les consignes du Researcher, du
   Developer et du Navigator (`packages/daemon/src/agents.ts`) ne disent que
   les règles du harness. Le rôle d'un agent créé (`create_agent`) est écrit
   par l'orchestrateur à chaque tâche, et perdu avec elle : rien ne
   s'accumule.
2. **Seul le Developer exécute.** Le Researcher est en lecture seule ; faire
   tourner un script d'analyse Python demande un Developer dans un worktree,
   chaque commande approuvée.
3. **La liste blanche `exec` compare l'argv à la lettre** (`execAllowed`,
   `packages/tools/src/exec.ts`) : une entrée `python -m pytest` ne couvre
   pas `python -m pytest -k foo`. En Python, c'est une approbation par
   itération.
4. **Un worktree n'a pas de `.venv`** (non versionné) : une tâche Developer
   doit recréer l'environnement avant de pouvoir tester.
5. **Le modèle existe et se règle déjà.** Au catalogue public de Venice
   (relu le 2026-11-06) : `deepseek-v4-1-flash-uncensored` et
   `deepseek-v4-1-flash-1017-uncensored` — appel d'outils, vision, contexte
   d'un million de jetons, effort de raisonnement réglable (`high` par
   défaut chez Venice) ; 0,33 $ / 1,32 $ par million de jetons, cache à
   0,00825 $. Les deux sont **déjà tarifés** dans
   `packages/providers/pricing.json` : on peut les poser sur un profil
   aujourd'hui (`PATCH /api/agents/:id`, ou les Profils du dashboard), et
   `create_agent` les accepte. L'adaptateur n'envoie aucun
   `reasoning_effort` : c'est le défaut de Venice qui joue.
6. **Rien ne touche Windows depuis le poste de l'auteur** (un Mac), hors de
   la CI.

## Décisions de conception

### Les playbooks

1. **Un playbook est un fichier Markdown de `playbooks/`**, à la racine du
   dépôt Midgaard ; son identifiant est son nom (`sigma.md` → `sigma`). En
   anglais : c'est le modèle qui le lit. Il ne nomme aucun modèle ni aucun
   client (règle de neutralité de la Slice 5).
2. **L'humain l'attache à un profil**, jamais un agent : `harness playbooks
   attach`, une case par playbook aux Profils, `PUT
   /api/agents/:id/playbooks`. Un identifiant inconnu est refusé avec la
   liste des disponibles.
3. **Il est ajouté à la consigne après les règles du profil**, sous un
   titre qui dit qu'il s'y ajoute et ne les remplace pas — comme le rôle
   d'un agent créé (Slice 8, décision 14), qui vient après lui. Un agent
   créé hérite des playbooks de son profil de base.
4. **Il est lu au départ de la tâche**, et ce qui a été lu est journalisé :
   identifiant et SHA-256 de chacun. Une tâche dit ainsi quel savoir elle a
   reçu, même si le fichier change ensuite. Un playbook attaché mais absent
   au départ arrête la tâche avant tout appel de modèle, avec son motif —
   comme un serveur MCP qui ne démarre pas.
5. **Taille bornée** (32 Kio par playbook, 96 Kio par profil) : il est relu à
   chaque appel de modèle, donc payé à chaque appel.

### La liste blanche à préfixes

6. Une entrée est **exacte** (comme aujourd'hui) ou **préfixe**. Un préfixe
   d'un seul mot est refusé, et un interpréteur (`python`, `python3`, `node`,
   `sh`, `bash`, `zsh`, `pwsh`, `powershell`, `cmd`, `ruby`, `perl`, `deno`,
   `bun`, `uv run`, `npx`) n'est accepté que suivi d'un module ou d'une
   sous-commande nommée (`python -m pytest`). Un préfixe `python -c` ou
   `python script.py` ferait tourner sans regard du code écrit par l'agent.
7. **Un préfixe `pytest` n'élargit pas ce qui tourne** : `pytest` exécute
   déjà `conftest.py`, que l'agent écrit. C'est la raison de l'avertissement
   à l'ajout, qui le redit.

### L'environnement Python d'un worktree

8. **Le harness le prépare, pas l'agent** : quand le worktree porte un
   `uv.lock` (ou un `pyproject.toml`), `uv sync` est proposé à l'humain
   avant le premier appel de modèle, approuvé une fois, lancé sous la garde
   d'`exec`. À ce moment, l'arbre est celui du commit de départ : du code de
   l'utilisateur, pas de l'agent. Le `.venv` de l'utilisateur n'est jamais
   partagé : un agent y installerait ce qu'il veut.

### Les échantillons

9. **Un échantillon ne s'exécute jamais.** Les fichiers désignés comme
   échantillons à la création de la tâche sont copiés **en lecture seule**
   sous un dossier à part ; `exec` refuse tout programme qui s'y trouve, et
   **un échantillon ne part jamais sur la VM**. On le lit, on le désassemble,
   on lui passe YARA ou un script Python ; c'est tout.

### La VM Windows

10. **Déclarée par l'humain** (`harness windows add`) : hôte, utilisateur,
    clé au coffre, **empreinte d'hôte épinglée** à la déclaration et
    revérifiée à chaque connexion.
11. **Chaque commande sur la VM est approuvée**, commande exacte et hôte
    sous les yeux ; la liste blanche ne s'y applique pas au début.
12. **Les fichiers du worktree** (jamais les échantillons, jamais `.git`)
    sont copiés dans un dossier jetable de la VM, propre à la tâche, effacé
    à la fin ; rien ne revient de la VM que la sortie des commandes,
    encadrée et non fiable.
13. **Aucun processus ne survit sur la VM** : chaque commande tourne dans un
    Job Object tué à sa fermeture, et la coupure de la connexion — daemon
    tué net compris — doit tout emporter. À prouver en comptant les
    processus de la VM, pas en le supposant.
14. **Éprouvée en CI** sur un poste Windows GitHub qui active OpenSSH Server
    et se joint lui-même ; l'essai réel se fait sur la VM de l'auteur.

## Découpage

| # | Étape | État |
|---|---|---|
| 1 | Les playbooks : dossier `playbooks/`, lecture et bornes, `agents.playbooks` (migration 14), `GET /api/playbooks`, `PUT /api/agents/:id/playbooks`, consigne composée et journalisée au départ, héritage par les agents créés, `harness playbooks` (`attach`, `detach`) ; un premier playbook (`python`) | faite, à pousser en CI |
| 2 | Le savoir : `sigma`, `yara`, `pe-static`, `powershell`, `windows-hardening`, relus par l'auteur | à faire |
| 3 | La liste blanche à préfixes : migration, règle des interpréteurs, CLI et dashboard, avertissement | à faire |
| 4 | L'environnement Python du worktree (`uv sync` proposé au départ) et les échantillons en lecture seule, jamais exécutés | à faire |
| 5 | La VM Windows : déclaration, empreinte d'hôte, copie jetable, commande approuvée, Job Object ; CI Windows avec sshd | à faire |
| 6 | Le dashboard : playbooks aux Profils, VM, échantillons d'une tâche | à faire |
| 7 | Preuves (`test:security`, CI trois plateformes) et essai réel : une règle Sigma, une règle YARA et un script PowerShell vérifiés sur la VM par un modèle *uncensored* ; le PE via REA après l'essai de la Slice 8 | à faire |

## Reste à trancher

- **Ce que fait Win32-OpenSSH d'une session coupée** : tue-t-il les
  processus de la session, ou faut-il un Job Object posé par un lanceur ?
  À constater à l'étape 5, sur un poste Windows, en comptant.
- **Un modèle *uncensored* obéit plus volontiers.** Les chaînes d'un binaire,
  un journal EVTX ou un commentaire de script sont des données qu'un
  attaquant a pu écrire. Les protections de Midgaard sont dans le code
  (encadrement à nonce, approbations, liste blanche), pas dans le refus du
  modèle : la slice ne doit en relâcher aucune, et l'approbation reste la
  frontière.
- **Régler l'effort de raisonnement** par profil, ou laisser le défaut du
  fournisseur.

## Récit

### Étape 1 — les playbooks (2026-11-06)

Ce qui existe désormais :

- **`playbooks/`** à la racine du clone, avec un `README.md` pour les humains
  et un premier playbook, `python.md` (écrire, tester, scripts d'analyse
  statique ; « jamais exécuter un échantillon » y est redit) ;
- **`agents.playbooks_json`** (migration 14) et le champ `playbooks` d'un
  profil, `PROTOCOL_VERSION` 17 ; `MIDGAARD_PLAYBOOKS_DIR` déplace le
  dossier (`config.playbooksDir`, injecté) ;
- **`GET /api/playbooks`** (le dossier lu, chaque playbook avec titre,
  taille, SHA-256, et le motif d'un refus) et **`PUT
  /api/agents/:id/playbooks`** (liste complète et ordonnée ; inconnu → 404
  avec les disponibles, inutilisable ou trop gros → 409, simulé → 409, un
  chemin refusé au schéma) ;
- **le moteur** les relit en `preparing`, tout ou rien, les place après les
  règles et avant le rôle d'un agent créé, et note à la timeline
  « playbooks lus : id (octets, sha256 …) » avec l'empreinte entière ;
- **`list_agents`** montre les playbooks d'un profil à l'orchestrateur, et
  sa consigne dit qu'un agent créé en hérite ;
- **`harness playbooks`**, `playbooks attach`, `playbooks detach`, et les
  playbooks d'un profil dans `harness agents`.

**Une attache sans confirmation**, contrairement à `exec allow` et `mcp
allow` : un playbook n'ouvre aucune porte, il ajoute du texte d'humain sous
des règles qu'il ne peut pas remplacer. La CLI dit en revanche ce qu'il
coûte : il est relu à chaque appel de modèle.

**Le rôle d'un agent créé se repère par son titre**, que seul le daemon
écrit ; la première occurrence est la sienne, et un rôle qui recopierait ce
titre reste après le playbook — un test le fait exprès.

Preuves (`tests/unit/playbooks.test.ts`, 15 tests) : la lecture du dossier
(`README.md`, majuscules, lien symbolique et `../` écartés ; trop gros et
non-UTF-8 listés avec leur motif ; somme rebornée au départ) ; la place dans
la consigne ; les playbooks livrés valides et neutres ; et dans un vrai
daemon face au faux fournisseur, ce que le modèle reçoit, le SHA-256 à la
timeline, l'arrêt sans aucun appel de modèle quand un playbook a disparu, et
l'héritage par un agent créé par l'orchestrateur. **Trois défauts introduits
exprès ont été vus échouer** : moteur qui ne compose plus la consigne (deux
tests tombent), playbook absent sauté en silence (deux), playbooks ajoutés
après le rôle (deux).

**La vraie CLI a trouvé deux défauts**, sur un dossier runtime jetable,
réglés : `harness playbooks` conseillait `playbooks attach sigma
researcher`, un playbook qui n'existe pas encore (l'exemple nomme désormais
un playbook présent et un profil qui ne l'a pas) ; et `harness agents` ne
montrait pas les playbooks d'un profil **désactivé**, alors que l'attache
venait de réussir. Toutes les suites locales sont vertes : `test:unit`
(643), `test:orchestrator`, `test:security`, `test:wait` (protocole 17
constaté par S1 et S10), `test:ui`, `test:developer`. La CI reste à faire,
au prochain envoi.
