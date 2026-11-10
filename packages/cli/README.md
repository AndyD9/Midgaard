# `@midgaard/cli`

La ligne de commande `harness`. Elle sert à installer, surveiller, dépanner — et
à **décider** : approuver ou refuser une demande d'approbation.

```bash
harness init [dossier]        # déclare le serveur MCP dans le .mcp.json du dossier
harness start                 # démarre le daemon s'il dort
harness stop                  # l'arrête
harness status [--limit N]    # état du daemon et tâches récentes
harness doctor                # diagnostic de l'installation
harness approve [id]          # approuve une demande
harness reject [id] [motif]   # la refuse
harness agents limits <profil> --timeout 900   # règle les limites d'un profil ; un relèvement se confirme
harness workspaces            # worktrees des tâches Developer, état sur le disque, orphelins
harness workspaces remove <branche|id> [--force]
harness workspaces clean [--force]
harness exec                  # commandes lancées sans approbation dans ce dépôt
harness exec allow [--yes] [--prefix] [--] <commande…>
harness exec revoke [--] <commande…>
harness mcp                   # serveurs MCP déclarés, et leur dernier test
harness mcp add <id> [--env NOM=v]… [--secret-env NOM]… -- <programme> [arguments…]
harness mcp test <id>         # lance le serveur et relit son catalogue
harness mcp tools <id>        # outils libres, changés, ou approuvés à chaque appel
harness windows               # VM Windows de test, et leur dernier test
harness windows add <id> --host H --user U --fingerprint "SHA256:…" [--port 22] [--new-key]
harness windows test <id>     # joint l'hôte épinglé, fait répondre PowerShell
harness windows key <id>      # redonne la clé publique et la commande qui la pose
harness windows remove <id>   # efface la clé du coffre, détache la VM des profils
harness windows attach <vm> <profil>   # un profil Developer, une VM au plus
harness windows detach <profil>
harness mcp allow <id> [--yes] (--read-only | <outil>…)
harness mcp revoke <id> <outil>…
harness mcp remove <id>
harness mcp attach <id> <profil>   # les agents du profil reçoivent ses outils
harness mcp detach <id> <profil>
harness playbooks             # playbooks du clone, leur taille, les profils qui les ont
harness playbooks attach <playbook> <profil>   # ajouté à la consigne, tâche suivante
harness playbooks detach <playbook> <profil>
```

Midgaard ne s'installe que depuis un clone (la distribution npm a été
abandonnée, docs/SLICE4.md) : aucun binaire `harness` n'est dans le `PATH`, et
chaque ligne ci-dessus se lance à la racine du dépôt sous la forme
`npm run harness -- status`. **Chaque commande que la CLI conseille** passe par
`cmd()` (`ui.ts`), qui l'écrit sous cette forme : avant d'y passer, des
conseils citaient un `harness` que personne ne pouvait lancer — le dernier,
l'indice d'approbation de `status`, a été trouvé en retirant le paquet.

**`--home <dossier>`**, avant la commande, vaut `MIDGAARD_HOME` et s'écrit pareil
sous zsh, PowerShell et cmd (`args.ts`). Un chemin relatif se lit depuis le
dossier d'où l'on a lancé npm (`INIT_CWD`), et rien n'est lu après `--`. Quand
la CLI vise un dossier runtime désigné, `cmd()` le redit dans chaque conseil :
sans lui, `providers add` aurait déclaré la clé dans une autre installation
(Slice 4, étape 8). `start` et `status` disent aussi quand le daemon s'est
rabattu sur un autre port que 7777 — le plus souvent parce qu'une autre
installation le tient.

## Pourquoi l'approbation est ici et pas dans MCP

Parce que **Claude ne doit pas pouvoir s'auto-approuver**. Aucun outil
d'approbation n'est exposé au modèle ; la décision passe par cette CLI ou par le
dashboard, tous deux pilotés par un humain. C'est l'invariant que la Slice 0 a
posé et que la Slice 1 ne change pas.

Sans identifiant, `approve` et `reject` n'agissent que s'il n'y a **qu'une**
demande en attente. En cas d'ambiguïté, elles affichent une ligne complète par
demande, prête à copier — jamais de `<placeholder>`, que zsh lirait comme une
redirection.

## Worktrees : rien ne part sans qu'on le demande

`workspaces clean` retire les worktrees **propres** des tâches **finies**. Un
worktree avec du travail non commité est laissé, et la commande dit pourquoi —
ce travail, la branche ne le contient pas ; `--force` le perd. Un worktree dont
la tâche tourne n'est jamais retiré. Un dossier orphelin est montré, jamais
supprimé. Et la branche reste **toujours** : `git branch -D` est une décision à
part. La CLI filtre les worktrees sales par politesse ; la vraie garde est le
daemon, qui refuse un retrait non forcé d'un worktree sale.

## `exec allow` : une autorisation durable, donc un avertissement

Une commande en liste blanche ne sera plus jamais montrée à un humain dans ce
dépôt. `exec allow` le dit avant d'ajouter, puis demande confirmation ; **sans
terminal, il refuse** sauf `--yes`. La liste est rangée sous la racine du dépôt,
d'où que la commande soit lancée, et seul l'argv **exact** est concerné.

**`--prefix`** (Slice 9) couvre tout ce qui suit : `exec allow --prefix --
python -m pytest` libère `python -m pytest -k foo`. Le préfixe est jugé
**avant** l'avertissement (`execPrefixRefusal`) : un seul mot, une option
juste après le programme (`git -c`, `node -e`), un chemin relatif (un fichier
du worktree), un shell, un interpréteur, un lanceur (`env`, `xargs`, `find`)
sont refusés, Python hors de `python -m <module>` aussi, et un exécuteur
(`uv run`, `npx`) doit nommer un programme acceptable à son tour. L'avertissement
dit ce que la règle ne sait pas : un argument ajouté peut faire tourner un autre
programme (`tar --to-command`, `rsync -e`). `exec list` montre un préfixe
suivi de `…`, et dit celui que le moteur écarterait. Le daemon rejuge tout.

Ce que cette confirmation n'empêche pas, et qu'il faut savoir : un processus
qui a accès au shell de l'utilisateur — Claude Code avec son outil Bash, par
exemple — peut passer `--yes`, comme il pourrait lancer `harness approve`. La
frontière reste la même qu'à la Slice 0 : les permissions de Claude Code sur le
shell, que l'utilisateur accorde commande par commande.

## `windows` : la VM Windows de test (Slice 9, étape 5.2)

`windows add` déclare une VM ; c'est le **daemon** qui génère sa clé ed25519,
dédiée, et la range au coffre. La CLI n'en voit que la moitié publique, et
affiche les deux lignes PowerShell qui la posent pour un compte
administrateur (`administrators_authorized_keys`, droits réservés aux
administrateurs et à SYSTEM, désignés par leur SID : leur nom change avec la
langue de Windows).

**L'empreinte d'hôte est exigée à la première déclaration** : Midgaard ne
fait pas confiance au premier contact. Sans `--fingerprint`, la CLI refuse et
donne la commande qui la lit sur la console de la VM (`ssh-keygen.exe -lf
…ssh_host_ed25519_key.pub`), et celles qui installent le serveur OpenSSH s'il
manque. La ligne entière de `ssh-keygen -lf` est acceptée telle quelle.

`windows test` joint l'hôte **épinglé** avec la clé du coffre et fait
répondre PowerShell (version de PowerShell et de Windows) ; une autre
empreinte est refusée sans rien envoyer, et la CLI dit laquelle a été vue.
`--new-key` remplace la clé : l'ancienne ne sert plus, la nouvelle est à
poser. `windows remove` efface la clé du coffre et détache la VM des profils
qui la portaient ; sa moitié publique reste sur la VM, à retirer à la main.

`windows attach vm1 developer` attache la VM à un profil (étape 5.3a),
à partir de la tâche suivante : un profil **Developer** seul, parce que c'est
son worktree qui partira sur la VM, et **une VM au plus** — en attacher une
autre la remplace, et la CLI le dit. Un agent créé sur la base de ce profil en
hérite. `windows list` montre les profils qui portent chaque VM. **Aucun
outil ne s'en sert encore** : les commandes sur la VM arrivent avec
`windows_run` (sous-étapes suivantes de la 5.3), et la CLI le dit à l'attache.

## `mcp` : déclarer un serveur, cocher ce qu'on a lu (Slice 8)

`mcp add` **résout le programme ici**, par le `PATH` du terminal, et l'envoie
absolu : le daemon ne résout rien par son propre `PATH`. Un argument qui
désigne un fichier relatif au dossier courant (`./rea.mjs`,
`scripts/rea.mjs`) est rendu absolu, et c'est affiché : le serveur tourne
ailleurs — constaté au premier essai, `node tests/fake-mcp-server.ts` ne
trouvait pas son script. Un mot sans séparateur (`mcp`) reste un mot. La
déclaration est **testée dans la foulée** : le serveur est lancé, son
catalogue lu.

Une valeur secrète (`--secret-env NOM`) est saisie sans écho et part au
coffre ; une variable `--env` est gardée **en clair**, et la CLI le dit.

`mcp allow` s'annonce et se confirme comme `exec allow`, **et refuse sans
terminal** sauf `--yes`. `--read-only` propose les outils que le serveur dit
en lecture seule et non destructifs : une proposition, que l'humain lit avant
de confirmer — les annotations sont celles du serveur, pas une garantie. Un
outil MCP n'est pas borné au projet, et l'avertissement le dit.

## La clé d'API ne s'affiche pas

`providers add` lit la clé sur l'entrée standard, jamais en argument (visible
dans `ps` et l'historique du shell). Au terminal, la saisie se fait **en mode
brut, sans `readline`** (`src/secret-input.ts`) : seuls l'invite et le retour
à la ligne s'écrivent. Une `readline` en mode terminal réaffiche ce qu'elle
reçoit, même mode brut posé — c'est ainsi que la clé s'est affichée en clair
jusqu'à la Slice 5 (docs/SLICE5.md, leçon n° 36). `tests/unit/secret-input.test.ts`
relit tout ce qui a été écrit pendant la saisie.

## `status` fonctionne daemon arrêté

Il lit la base directement. C'est possible parce qu'elle est en WAL : la lecture
ne gêne pas le daemon s'il écrit au même moment. Une tâche d'hier reste donc
consultable sans rien relancer.

## `status` et `doctor` n'écrivent jamais dans la base

Ils l'ouvrent **en lecture seule** (`HarnessStore.openReadOnly`), et c'est SQLite
qui refuse toute écriture. Jusqu'à la Slice 4, `doctor` l'ouvrait comme le
daemon, migrations comprises : il a fait passer la base réelle du schéma 3 au
schéma 6 sous un daemon plus ancien encore en marche (docs/SLICE3.md, leçon
n° 17). Un diagnostic qui change ce qu'il examine ne diagnostique plus.

Sur une base **plus ancienne** que le code, `doctor` avertit « à migrer » et
omet les contrôles qui lisent la base (fournisseurs, worktrees, liste blanche) :
leurs requêtes viseraient des tables qui n'existent pas encore. `status` refuse
d'afficher l'historique et rend `1`. Dans les deux cas, c'est le daemon de cette
version qui migre, à son démarrage. Une base absente n'est jamais créée.

## Ce que `doctor` vérifie

Les six choses qui ont réellement cassé pendant la Slice 0 :

| Contrôle | Ce qu'il attrape |
|---|---|
| Version de Node | `node:sqlite` exige Node 24 sans drapeau expérimental |
| Dossier runtime | Mode `0700` : il contient le jeton du daemon |
| Base | Lue sans être écrite : à jour, à migrer (avertissement), ou plus récente que ce code (échec) |
| Daemon | En marche, injoignable, d'un autre protocole, ou **d'une autre installation** (dossier et version) — et ce que fera le prochain appel MCP |
| Déclaration MCP | Présente **et pointant encore là où il faut** — un dépôt déplacé ou recloné laisse des chemins absolus morts, et Claude Code échoue alors sans rien dire d'utile |
| Dashboard | Compilé ou non — pour ne jamais renvoyer vers une page vide |
| Git | Présent et au moins 2.17 (`git worktree remove`) ; un avertissement, le Researcher s'en passe |
| Worktrees | Combien en cours, conservés, retirés — et comment nettoyer |
| Exec | Avertit dès qu'une commande passe sans approbation : si elle exécute le code du projet, elle exécute ce que l'agent a écrit |

Les avertissements ne font pas échouer la commande ; seuls les échecs rendent `1`.

## `agents limits` : relever un budget est un geste (Slice 8)

Les limites d'un profil se règlent par `PUT /api/agents/:id/limits`, décision
de l'auteur qui revient sur la Slice 5 (un premier appel Ghidra dépasse le
délai du Researcher, et personne ne pouvait plus le relever). La CLI lit le
profil, montre ce qui **monte** (`timeout_s : 300 → 900`), et demande
confirmation ; **sans terminal, elle refuse** sauf `--yes`. Un abaissement
passe tel quel. Le daemon borne chaque valeur, journalise le changement avant
→ après, et ne l'applique qu'aux tâches à venir.

